/**
 * Live objects, straight from the API server's watch — the thing that makes a
 * cluster view feel alive instead of sampled.
 *
 * `kubectl get <kind> --watch --output-watch-events -o json` does a list, then
 * streams `{"type":"ADDED"|"MODIFIED"|"DELETED","object":{…}}` for every change.
 * This is the FALLBACK route. `src/api-watch.ts` watches the API directly
 * through the proxy socket and should be preferred — see `watch-source.ts` —
 * but it needs a proxy and a kind discovery knows about, and this needs
 * neither. (The reason there was no proxy for so long: a TCP `kubectl proxy` on
 * localhost is an unauthenticated cluster-admin port, the exact thing digg's
 * per-run token exists to prevent. A unix socket has no port to reach, which is
 * what made it answerable.)
 *
 * Two things the API server does NOT give us, and how this file answers them:
 *
 *   RESUMING. kubectl won't accept a resourceVersion, so a dropped stream is
 *   restarted from scratch and re-lists. That is a full snapshot, not a diff,
 *   so consumers are handed a SNAPSHOT rather than a burst of fake ADDEDs —
 *   which also repairs anything deleted while we were away.
 *
 *   AN END-OF-LIST MARKER. Without bookmarks there is no event that says "the
 *   initial list is done", so the opening burst is buffered until the stream
 *   goes quiet (or a deadline passes) and emitted as one snapshot. Everything
 *   after that streams event by event.
 */

import type { K8sObject } from "./kubectl.ts";

export type WatchEventType = "ADDED" | "MODIFIED" | "DELETED";

export interface WatchEvent {
    type: WatchEventType;
    object: K8sObject;
}

/**
 * Split a stream of concatenated JSON documents.
 *
 * kubectl 1.35 emits one compact document per line, but older versions
 * pretty-print, so counting braces (while respecting strings and escapes) is
 * the only framing that survives both. Feed it chunks; it returns whole
 * documents and keeps the remainder.
 */
export function createJsonSplitter(): (chunk: string) => string[] {
    let buffer = "";
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    // How far into `buffer` we have already scanned. Rescanning from zero with
    // the depth/string state carried over would count the same braces twice,
    // and a document split across two chunks would never close.
    let pos = 0;

    return (chunk: string): string[] => {
        buffer += chunk;
        const out: string[] = [];
        for (let i = pos; i < buffer.length; i++) {
            const ch = buffer[i]!;
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === "{") {
                if (depth === 0) start = i;
                depth++;
            } else if (ch === "}") {
                depth--;
                if (depth === 0 && start >= 0) {
                    out.push(buffer.slice(start, i + 1));
                    start = -1;
                }
                // A stray closing brace would mean the stream is not JSON at
                // all; clamp rather than go negative and mis-frame forever.
                if (depth < 0) depth = 0;
            }
        }
        // Keep only the unfinished document; anything before it is consumed.
        pos = buffer.length;
        if (depth === 0) {
            buffer = "";
            start = -1;
            pos = 0;
        } else if (start > 0) {
            buffer = buffer.slice(start);
            pos -= start;
            start = 0;
        }
        return out;
    };
}

/** Key an object the way the tables do: namespace + name. */
export const objectKey = (obj: K8sObject): string => `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;

/**
 * Does this stderr mean "watching this kind will never work"?
 *
 * Aggregated APIs like metrics.k8s.io only implement get and list, and RBAC can
 * forbid watch while allowing list. Both are permanent for this kind, so the
 * caller stops retrying and falls back to polling instead of respawning kubectl
 * forever.
 */
export function isPermanentWatchFailure(stderr: string): boolean {
    const s = stderr.toLowerCase();
    return (
        s.includes("watch is not supported") ||
        s.includes("methodnotallowed") ||
        s.includes("forbidden") ||
        s.includes("cannot watch") ||
        s.includes("the server could not find the requested resource") ||
        s.includes("unable to recognize") ||
        s.includes("doesn't have a resource type")
    );
}

export interface WatchHandlers {
    /** The initial list, and every re-list after a reconnect. */
    onSnapshot: (objects: K8sObject[]) => void;
    onEvent: (event: WatchEvent) => void;
    /** `permanent` means: stop hoping, use polling. */
    onError: (message: string, permanent: boolean) => void;
}

export interface WatchOptions {
    context: string;
    /** kubectl resource name, plural. */
    kind: string;
    /** undefined → every namespace (-A). Ignored for cluster-scoped kinds. */
    namespace?: string;
    clusterScoped?: boolean;
    /** Test seam: spawn something other than kubectl. */
    spawn?: (args: string[]) => WatchProcess;
    /** Test seam: schedule a retry. */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export interface WatchProcess {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill: () => void;
}

/** Quiet period that marks the end of the initial list burst. */
const SETTLE_MS = 250;
/** Ceiling on that wait, so a chatty cluster still gets its snapshot. */
const SETTLE_MAX_MS = 2500;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
/** A stream that ends sooner than this never really started. */
const QUICK_EXIT_MS = 2000;
/** How many instant closes before we say so out loud. */
const QUICK_EXIT_LIMIT = 3;

/**
 * One watched (context, kind, namespace), restarted for as long as anyone is
 * listening. Not a class you subscribe to — `src/web/live.ts` owns fan-out; this
 * only knows how to keep one kubectl alive and turn bytes into events.
 */
export class ResourceWatch {
    private proc: WatchProcess | null = null;
    private stopped = false;
    private failures = 0;
    private quickExits = 0;
    private startedAt = 0;
    private retry: unknown = null;
    private settleTimer: unknown = null;
    private settleDeadline: unknown = null;
    private buffered: K8sObject[] | null = null;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;

    constructor(
        private readonly opts: WatchOptions,
        private readonly handlers: WatchHandlers,
    ) {
        this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    }

    get args(): string[] {
        const args = ["--context", this.opts.context, "get", this.opts.kind, "--watch", "--output-watch-events", "-o", "json"];
        if (!this.opts.clusterScoped) {
            if (this.opts.namespace) args.push("-n", this.opts.namespace);
            else args.push("-A");
        }
        return args;
    }

    start(): void {
        if (this.stopped || this.proc) return;
        const spawn = this.opts.spawn ?? defaultSpawn;
        let proc: WatchProcess;
        try {
            proc = spawn(this.args);
        } catch (err) {
            this.fail(err instanceof Error ? err.message : String(err), false);
            return;
        }
        this.proc = proc;
        this.startedAt = Date.now();
        // Every restart re-lists, so buffer from scratch and emit a snapshot.
        this.buffered = [];
        void this.pump(proc);
    }

    stop(): void {
        this.stopped = true;
        this.clearTimers();
        this.kill();
    }

    private kill(): void {
        const proc = this.proc;
        this.proc = null;
        try {
            proc?.kill();
        } catch {
            /* already gone */
        }
    }

    private clearTimers(): void {
        for (const handle of [this.retry, this.settleTimer, this.settleDeadline]) {
            if (handle !== null) this.clearTimer(handle);
        }
        this.retry = null;
        this.settleTimer = null;
        this.settleDeadline = null;
    }

    private async pump(proc: WatchProcess): Promise<void> {
        const split = createJsonSplitter();
        const decoder = new TextDecoder();
        let stderr = "";

        const readErr = (async () => {
            const reader = proc.stderr.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                stderr += decoder.decode(value, { stream: true });
                // kubectl can print a warning and keep streaming; only a
                // non-zero exit turns stderr into a failure.
                if (stderr.length > 8000) stderr = stderr.slice(-4000);
            }
        })();

        try {
            const reader = proc.stdout.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const doc of split(decoder.decode(value, { stream: true }))) {
                    this.handleDocument(doc);
                }
            }
        } catch (err) {
            if (!this.stopped) this.fail(err instanceof Error ? err.message : String(err), false);
        }

        await readErr.catch(() => undefined);
        const code = await proc.exited.catch(() => 1);
        if (this.stopped || this.proc !== proc) return;
        this.proc = null;

        // A clean exit still means the stream ended (the API server times
        // watches out); reconnect either way, but only count real failures
        // towards the backoff.
        if (code !== 0 && isPermanentWatchFailure(stderr)) {
            this.fail(firstLine(stderr) || `kubectl watch ${this.opts.kind} failed`, true);
            return;
        }
        if (code !== 0) {
            this.fail(firstLine(stderr) || `kubectl watch ${this.opts.kind} exited ${code}`, false);
            return;
        }
        // A clean exit is normal — the API server times watches out — but one
        // that happens instantly, over and over, is a spin: something upstream
        // is closing the stream as fast as we open it. Back off in that case
        // instead of respawning kubectl four times a second.
        const lived = Date.now() - this.startedAt;
        if (lived < QUICK_EXIT_MS) {
            this.quickExits++;
            const delay = BACKOFF_MS[Math.min(this.quickExits - 1, BACKOFF_MS.length - 1)]!;
            if (this.quickExits === QUICK_EXIT_LIMIT) {
                this.handlers.onError(
                    firstLine(stderr) || `watch on ${this.opts.kind} keeps closing immediately`,
                    false,
                );
            }
            this.scheduleRestart(delay);
            return;
        }
        this.quickExits = 0;
        this.failures = 0;
        this.scheduleRestart(250);
    }

    private handleDocument(doc: string): void {
        let parsed: { type?: string; object?: K8sObject };
        try {
            parsed = JSON.parse(doc) as { type?: string; object?: K8sObject };
        } catch {
            return; // a partial or non-JSON line is not worth killing a watch over
        }
        const object = parsed.object;
        if (!object || !parsed.type) return;

        // kubectl surfaces API errors as an ERROR event carrying a Status.
        if (parsed.type === "ERROR") {
            const message = String((object as { message?: string }).message ?? "watch error");
            this.fail(message, isPermanentWatchFailure(message));
            return;
        }

        if (this.buffered) {
            if (parsed.type === "DELETED") {
                const key = objectKey(object);
                this.buffered = this.buffered.filter((o) => objectKey(o) !== key);
            } else {
                this.buffered.push(object);
            }
            this.armSettle();
            return;
        }

        this.handlers.onEvent({ type: parsed.type as WatchEventType, object });
    }

    /** Flush the initial burst once the stream has been quiet for a beat. */
    private armSettle(): void {
        if (this.settleTimer !== null) this.clearTimer(this.settleTimer);
        this.settleTimer = this.setTimer(() => this.flushSnapshot(), SETTLE_MS);
        if (this.settleDeadline === null) {
            this.settleDeadline = this.setTimer(() => this.flushSnapshot(), SETTLE_MAX_MS);
        }
    }

    private flushSnapshot(): void {
        if (!this.buffered) return;
        const objects = this.buffered;
        this.buffered = null;
        if (this.settleTimer !== null) this.clearTimer(this.settleTimer);
        if (this.settleDeadline !== null) this.clearTimer(this.settleDeadline);
        this.settleTimer = null;
        this.settleDeadline = null;
        this.failures = 0;
        this.handlers.onSnapshot(objects);
    }

    /**
     * An empty collection never emits a first event, so the snapshot would
     * never fire. The manager calls this once the process is up to guarantee
     * subscribers always get an initial (possibly empty) snapshot.
     */
    settleSoon(): void {
        if (this.buffered) this.armSettle();
    }

    private fail(message: string, permanent: boolean): void {
        this.kill();
        // "list worked, watch did not" is the normal shape of an aggregated API
        // (metrics.k8s.io) and of componentstatuses: kubectl streams the whole
        // collection and only then reports MethodNotAllowed. Deliver what we
        // got before admitting defeat, so the screen has data to show while it
        // switches to polling.
        if (this.buffered && this.buffered.length > 0) this.flushSnapshot();
        this.buffered = null;
        this.handlers.onError(message, permanent);
        if (permanent || this.stopped) return;
        const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
        this.failures++;
        this.scheduleRestart(delay);
    }

    private scheduleRestart(delay: number): void {
        if (this.stopped || this.retry !== null) return;
        this.retry = this.setTimer(() => {
            this.retry = null;
            this.start();
        }, delay);
    }
}

/**
 * The line worth showing.
 *
 * kubectl prints deprecation warnings BEFORE it prints the failure, so the
 * first line is routinely "Warning: v1 ComponentStatus is deprecated" while the
 * actual reason is the last one. Prefer an explicit error line, ignore
 * warnings, and fall back to the last thing said.
 */
function firstLine(text: string): string {
    const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^warning:/i.test(l));
    return lines.find((l) => /^error|error from server|unable to|forbidden/i.test(l)) ?? lines[lines.length - 1] ?? "";
}

function defaultSpawn(args: string[]): WatchProcess {
    const proc = Bun.spawn(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" });
    return {
        stdout: proc.stdout,
        stderr: proc.stderr,
        exited: proc.exited,
        kill: () => proc.kill(),
    };
}

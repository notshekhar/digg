/**
 * The same watch, over the API instead of over a kubectl process.
 *
 * `src/watch.ts` shells out, and has to work around two things kubectl will not
 * give it: it accepts no resourceVersion, so a dropped stream re-lists the
 * whole kind; and it emits no bookmark, so there is no marker for "the initial
 * list is done" — the opening burst has to be buffered until the stream goes
 * quiet. Both are kubectl's limits, not the API's.
 *
 * Through the proxy socket we speak to the API server directly, so:
 *
 *   RESUMING IS FREE. The API server closes a watch every few minutes by
 *   design. This reconnects from the last resourceVersion and the server sends
 *   only what changed — where the kubectl watch re-listed every object in the
 *   kind, every time, on a timer.
 *
 *   THE LIST HAS AN END. `GET ?resourceVersion=0` is a list with a version
 *   attached, served from the API server's own cache, so the snapshot is exact
 *   and instant instead of "whatever arrived before it went quiet for 250ms".
 *
 *   410 IS A REAL ANSWER. When the requested version has aged out of the
 *   server's window, it says so, and only then do we re-list.
 *
 * The handler contract is `src/watch.ts`'s, exactly, so `src/web/live.ts` does
 * not care which one it got.
 */

import { type ResourceCoords, resourcePath, withQuery } from "./apipath.ts";
import { findResource } from "./discovery.ts";
import type { K8sObject } from "./kubectl.ts";
import { type KubeProxy, getProxy } from "./proxy.ts";
import { createJsonSplitter } from "./watch.ts";
import type { WatchEvent, WatchHandlers, WatchEventType } from "./watch.ts";

/**
 * How long the server holds a watch open before closing it politely. Under the
 * five minutes that load balancers and idle timeouts tend to use.
 */
const WATCH_TIMEOUT_S = 290;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
/** A watch that dies this fast never really opened. */
const QUICK_MS = 2000;
const QUICK_LIMIT = 3;

export interface ApiWatchOptions {
    context: string;
    /** Plural resource name, as kubectl spells it. */
    kind: string;
    namespace?: string;
    clusterScoped?: boolean;
    /** Test seam: supply the transport instead of starting a proxy. */
    proxy?: KubeProxy;
    /** Test seam: supply the coordinates instead of asking discovery. */
    coords?: ResourceCoords;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

interface StreamFrame {
    type?: string;
    /**
     * An event's object, or — for type ERROR — a Status. Watch objects carry a
     * resourceVersion that K8sObject's metadata does not bother to name, and a
     * BOOKMARK is nothing BUT that version.
     */
    object?: K8sObject & {
        code?: number;
        message?: string;
        reason?: string;
        metadata?: { resourceVersion?: string };
    };
}

/** RBAC and "this kind cannot be watched" are answers, not outages. */
function isPermanentStatus(status: number): boolean {
    return status === 401 || status === 403 || status === 404 || status === 405;
}

export class ApiResourceWatch {
    private stopped = false;
    private running = false;
    private abort: AbortController | null = null;
    private resourceVersion: string | null = null;
    private quickExits = 0;
    private retry: unknown = null;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;

    constructor(
        private readonly opts: ApiWatchOptions,
        private readonly handlers: WatchHandlers,
    ) {
        this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    }

    start(): void {
        if (this.stopped || this.running) return;
        this.running = true;
        void this.loop();
    }

    stop(): void {
        this.stopped = true;
        if (this.retry !== null) this.clearTimer(this.retry);
        this.retry = null;
        this.abort?.abort();
        this.abort = null;
    }

    /**
     * `src/watch.ts` needs a nudge to emit an empty snapshot; here the list
     * always completes on its own, so there is nothing to hurry.
     */
    settleSoon(): void {}

    private async resolve(): Promise<{ proxy: KubeProxy; coords: ResourceCoords } | null> {
        const proxy = this.opts.proxy ?? (await getProxy(this.opts.context));
        if (!proxy) return null;
        let coords = this.opts.coords;
        if (!coords) {
            const found = await findResource(this.opts.context, this.opts.kind);
            if (!found) return null;
            coords = { name: found.name, apiVersion: found.apiVersion, namespaced: found.namespaced };
        }
        return { proxy, coords };
    }

    private path(coords: ResourceCoords): string {
        return resourcePath(
            { ...coords, namespaced: coords.namespaced && !this.opts.clusterScoped },
            { namespace: this.opts.namespace },
        );
    }

    private async loop(): Promise<void> {
        const resolved = await this.resolve();
        if (!resolved) {
            // No proxy or no such kind: the caller falls back to kubectl.
            this.running = false;
            this.handlers.onError(`no API route for ${this.opts.kind}`, true);
            return;
        }
        const { proxy, coords } = resolved;
        const base = this.path(coords);

        while (!this.stopped) {
            const startedAt = Date.now();
            try {
                if (this.resourceVersion === null) await this.list(proxy, base);
                if (this.stopped) return;
                await this.watchOnce(proxy, base);
            } catch (err) {
                if (this.stopped) return;
                const permanent = err instanceof PermanentWatchError;
                this.handlers.onError(err instanceof Error ? err.message : String(err), permanent);
                if (permanent) {
                    this.running = false;
                    return;
                }
                await this.pause(BACKOFF_MS[Math.min(this.quickExits, BACKOFF_MS.length - 1)]!);
                continue;
            }
            // A watch the server closed immediately, over and over, is a spin:
            // back off rather than hammering it. A normal timeout is not.
            if (Date.now() - startedAt < QUICK_MS) {
                this.quickExits++;
                if (this.quickExits >= QUICK_LIMIT) {
                    await this.pause(BACKOFF_MS[Math.min(this.quickExits - QUICK_LIMIT, BACKOFF_MS.length - 1)]!);
                }
            } else {
                this.quickExits = 0;
            }
        }
        this.running = false;
    }

    private pause(ms: number): Promise<void> {
        return new Promise((resolve) => {
            this.retry = this.setTimer(() => {
                this.retry = null;
                resolve();
            }, ms);
        });
    }

    /** A list with a version attached, from the API server's cache. */
    private async list(proxy: KubeProxy, base: string): Promise<void> {
        const url = withQuery(base, { resourceVersion: "0" });
        const res = await proxy.fetch(url);
        const text = await res.text();
        if (!res.ok) throw statusError(res.status, text, this.opts.kind);
        const body = JSON.parse(text) as { items?: K8sObject[]; metadata?: { resourceVersion?: string } };
        this.resourceVersion = body.metadata?.resourceVersion ?? null;
        this.handlers.onSnapshot(body.items ?? []);
    }

    private async watchOnce(proxy: KubeProxy, base: string): Promise<void> {
        const url = withQuery(base, {
            watch: true,
            resourceVersion: this.resourceVersion ?? "0",
            allowWatchBookmarks: true,
            timeoutSeconds: WATCH_TIMEOUT_S,
        });
        const abort = new AbortController();
        this.abort = abort;
        const res = await proxy.fetch(url, { signal: abort.signal });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            if (res.status === 410) {
                // Our version aged out of the server's window; a fresh list is
                // the documented recovery, not an error.
                this.resourceVersion = null;
                return;
            }
            throw statusError(res.status, text, this.opts.kind);
        }
        if (!res.body) return;

        const split = createJsonSplitter();
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const doc of split(decoder.decode(value, { stream: true }))) {
                    if (this.handleFrame(doc)) return; // 410 mid-stream: re-list
                }
            }
        } catch (err) {
            if (this.stopped || abort.signal.aborted) return;
            throw err;
        } finally {
            if (this.abort === abort) this.abort = null;
            try {
                await reader.cancel();
            } catch {
                /* already closed */
            }
        }
    }

    /** Returns true when the stream must be abandoned and the kind re-listed. */
    private handleFrame(doc: string): boolean {
        let frame: StreamFrame;
        try {
            frame = JSON.parse(doc) as StreamFrame;
        } catch {
            return false; // a partial document is the splitter's problem, not ours
        }
        const object = frame.object;
        if (!object) return false;
        const version = object.metadata?.resourceVersion;
        if (version) this.resourceVersion = version;

        switch (frame.type) {
            case "ADDED":
            case "MODIFIED":
            case "DELETED":
                this.handlers.onEvent({ type: frame.type as WatchEventType, object } satisfies WatchEvent);
                return false;
            case "BOOKMARK":
                // Nothing to show — it exists purely to keep our version fresh,
                // which is what makes a reconnect cheap.
                return false;
            case "ERROR": {
                if (object.code === 410 || object.reason === "Expired") {
                    this.resourceVersion = null;
                    return true;
                }
                throw new PermanentWatchError(object.message ?? `watch on ${this.opts.kind} failed`);
            }
            default:
                return false;
        }
    }
}

class PermanentWatchError extends Error {}

function statusError(status: number, body: string, kind: string): Error {
    let message = "";
    try {
        message = (JSON.parse(body) as { message?: string }).message ?? "";
    } catch {
        message = body.slice(0, 200);
    }
    const text = message || `watch on ${kind} failed with ${status}`;
    return isPermanentStatus(status) ? new PermanentWatchError(text) : new Error(text);
}

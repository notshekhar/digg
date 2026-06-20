// Real-time resource updates via `kubectl get … --watch`. This is what makes the
// list feel live (Lens-style): pods flip to Terminating / ContainerCreating /
// Running the instant the API server reports it, instead of waiting for a poll.
//
// kubectl emits one JSON value per change when given `--output-watch-events -o
// json`: `{ "type": "ADDED|MODIFIED|DELETED|BOOKMARK", "object": { … } }`. The
// objects are pretty-printed and concatenated, so we split the stream into
// complete top-level JSON values with a brace counter (string/escape aware).

import type { K8sObject } from "./kubectl.ts";

/**
 * Incremental splitter for a stream of concatenated JSON values. Feed raw
 * chunks; get back every top-level value that has completed so far. Robust to
 * values split across chunks and to braces/quotes inside string literals.
 */
export class JsonStream {
    private buf = "";
    private scan = 0;
    private depth = 0;
    private start = -1;
    private inStr = false;
    private esc = false;

    feed(chunk: string): unknown[] {
        this.buf += chunk;
        const out: unknown[] = [];
        while (this.scan < this.buf.length) {
            const c = this.buf[this.scan];
            if (this.inStr) {
                if (this.esc) this.esc = false;
                else if (c === "\\") this.esc = true;
                else if (c === '"') this.inStr = false;
            } else if (c === '"') {
                this.inStr = true;
            } else if (c === "{") {
                if (this.depth === 0) this.start = this.scan;
                this.depth++;
            } else if (c === "}") {
                this.depth--;
                if (this.depth === 0 && this.start >= 0) {
                    const slice = this.buf.slice(this.start, this.scan + 1);
                    try {
                        out.push(JSON.parse(slice));
                    } catch {
                        // partial/garbled value — skip it
                    }
                    this.start = -1;
                }
            }
            this.scan++;
        }
        // Once everything parsed so far is balanced, drop the consumed prefix so
        // the buffer doesn't grow without bound on a long-lived watch.
        if (this.depth === 0) {
            this.buf = "";
            this.scan = 0;
        }
        return out;
    }
}

export interface WatchTarget {
    kind: string;
    namespace?: string; // undefined → all namespaces (when not cluster-scoped)
    clusterScoped?: boolean;
    labelSelector?: string;
    fieldSelector?: string;
}

export type WatchEventType = "ADDED" | "MODIFIED" | "DELETED";

interface WatchHooks {
    onEvent: (type: WatchEventType, obj: K8sObject) => void;
}

/**
 * Manages one `kubectl --watch-only` subprocess for the current list target.
 * `--watch-only` skips the initial dump (the app already did a full list for the
 * first paint); we just stream subsequent changes. Auto-restarts if the watch
 * drops (the server closes idle watches), unless stopped on purpose.
 */
export class WatchController {
    private proc?: ReturnType<typeof Bun.spawn>;
    private stream = new JsonStream();
    private stopped = false;
    private generation = 0;

    start(context: string, target: WatchTarget, hooks: WatchHooks): void {
        this.stop();
        this.stopped = false;
        this.stream = new JsonStream();
        const generation = ++this.generation;
        this.spawn(context, target, hooks, generation);
    }

    private spawn(context: string, target: WatchTarget, hooks: WatchHooks, generation: number): void {
        const args = ["--context", context, "get", target.kind, "-o", "json", "--watch-only", "--output-watch-events"];
        if (!target.clusterScoped) {
            if (target.namespace) {
                args.push("-n", target.namespace);
            } else {
                args.push("-A");
            }
        }
        if (target.labelSelector) {
            args.push("-l", target.labelSelector);
        }
        if (target.fieldSelector) {
            args.push("--field-selector", target.fieldSelector);
        }
        try {
            this.proc = Bun.spawn(["kubectl", ...args], { stdout: "pipe", stderr: "ignore" });
        } catch {
            return; // kubectl missing / spawn failed — poll is the safety net
        }
        void this.pump(this.proc, hooks, generation);
        // Re-establish a watch the server closed, unless we've moved on/stopped.
        void this.proc.exited.then(() => {
            if (!this.stopped && generation === this.generation) {
                setTimeout(() => {
                    if (!this.stopped && generation === this.generation) {
                        this.spawn(context, target, hooks, generation);
                    }
                }, 1000);
            }
        });
    }

    private async pump(proc: ReturnType<typeof Bun.spawn>, hooks: WatchHooks, generation: number): Promise<void> {
        const decoder = new TextDecoder();
        try {
            for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
                if (this.stopped || generation !== this.generation) return;
                for (const value of this.stream.feed(decoder.decode(chunk, { stream: true }))) {
                    const event = value as { type?: string; object?: K8sObject };
                    if (
                        (event.type === "ADDED" || event.type === "MODIFIED" || event.type === "DELETED") &&
                        event.object
                    ) {
                        hooks.onEvent(event.type, event.object);
                    }
                }
            }
        } catch {
            // stream torn down on stop/restart — nothing to do
        }
    }

    stop(): void {
        this.stopped = true;
        this.generation++;
        if (this.proc) {
            try {
                this.proc.kill();
            } catch {
                // already exited
            }
            this.proc = undefined;
        }
    }
}

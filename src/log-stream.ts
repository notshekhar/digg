import type { K8sObject } from "./kubectl.ts";
import { WORKLOAD_KINDS, workloadSelector } from "./format.ts";
import { LogView } from "./views/log-view.ts";

export interface LogSpec {
    context: string;
    namespace?: string;
    podName?: string;
    selector?: string;
    title: string;
}

/**
 * Build a log spec for a selected resource: a pod's own logs, or all pods of a
 * workload (via its label selector). Returns null when logs don't apply.
 */
export function logSpecFor(kindName: string, obj: K8sObject, context: string): LogSpec | null {
    const name = obj.metadata?.name;
    if (!name) {
        return null;
    }
    const namespace = obj.metadata?.namespace;
    if (kindName === "pods") {
        return { context, namespace, podName: name, title: `${name} · logs (live)` };
    }
    const selector = WORKLOAD_KINDS.has(kindName) ? workloadSelector(obj) : undefined;
    return selector ? { context, namespace, selector, title: `${name} · logs (all pods)` } : null;
}

interface LogHooks {
    requestRender: () => void;
    toggleMouse: () => boolean;
    /** Called when the user leaves the log view (esc/q). */
    onClose: () => void;
}

/**
 * Manages a single live `kubectl logs -f` stream and its LogView. Streaming,
 * the subprocess lifecycle, and teardown live here so the app just asks to
 * open/close logs.
 */
export class LogController {
    private hooks: LogHooks;
    private view?: LogView;
    private proc?: ReturnType<typeof Bun.spawn>;

    constructor(hooks: LogHooks) {
        this.hooks = hooks;
    }

    get active(): boolean {
        return this.view !== undefined;
    }

    open(spec: LogSpec): void {
        const view = new LogView(spec.title);
        view.onToggleMouse = this.hooks.toggleMouse;
        view.onBack = () => {
            this.stop();
            this.hooks.onClose();
        };
        this.view = view;

        const args = ["--context", spec.context, "logs", "-f", "--tail=500", "--all-containers=true"];
        if (spec.podName) {
            args.push(spec.podName);
        }
        if (spec.selector) {
            args.push("-l", spec.selector, "--prefix", "--max-log-requests=20");
        }
        if (spec.namespace) {
            args.push("-n", spec.namespace);
        }
        this.proc = Bun.spawn(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" });
        void this.pump(this.proc, view);
        this.hooks.requestRender();
    }

    handleInput(data: string): void {
        this.view?.handleInput(data);
    }

    render(width: number): string[] {
        return this.view?.render(width) ?? [];
    }

    stop(): void {
        this.view = undefined;
        if (this.proc) {
            try {
                this.proc.kill();
            } catch {
                // already exited
            }
            this.proc = undefined;
        }
    }

    private async pump(proc: ReturnType<typeof Bun.spawn>, view: LogView): Promise<void> {
        const decoder = new TextDecoder();
        const consume = async (stream: ReadableStream<Uint8Array> | undefined) => {
            if (!stream) {
                return;
            }
            for await (const chunk of stream) {
                // Ignore output once we've navigated away from this view.
                if (this.view !== view) {
                    return;
                }
                view.append(decoder.decode(chunk, { stream: true }));
                this.hooks.requestRender();
            }
        };
        try {
            await Promise.all([
                consume(proc.stdout as ReadableStream<Uint8Array>),
                consume(proc.stderr as ReadableStream<Uint8Array>),
            ]);
        } catch {
            // stream torn down on stop — nothing to do
        }
    }
}

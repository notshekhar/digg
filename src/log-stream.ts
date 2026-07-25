import type { K8sObject } from "./kubectl.ts";
import { WORKLOAD_KINDS, workloadSelector } from "./format.ts";

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

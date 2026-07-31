/**
 * Who asked for what, and who is using it.
 *
 * Every gauge in digg — the bars in the pod/deployment/node tables, the
 * allocation blocks on a container card — is the same three numbers: what the
 * container is using now, what it reserved (requests) and what it may take
 * (limits). This module produces those three numbers from plain Kubernetes
 * objects so the pages never do arithmetic on strings.
 *
 * `used` is deliberately nullable: no metrics-server means "unknown", and an
 * unknown that renders as 0 is a lie a capacity view must not tell.
 */

import type { K8sObject, PodMetrics } from "./kubectl.ts";
import { parseQuantity } from "./quantity.ts";

export interface Gauge {
    used: number | null;
    requests: number;
    limits: number;
}

export const emptyGauge = (): Gauge => ({ used: null, requests: 0, limits: 0 });

export interface ContainerSpec {
    name?: string;
    image?: string;
    command?: string[];
    args?: string[];
    ports?: { name?: string; containerPort?: number; protocol?: string }[];
    resources?: {
        requests?: Record<string, string>;
        limits?: Record<string, string>;
    };
    volumeMounts?: { name?: string; mountPath?: string; readOnly?: boolean }[];
    env?: {
        name?: string;
        valueFrom?: {
            configMapKeyRef?: { name?: string; key?: string };
            secretKeyRef?: { name?: string; key?: string };
        };
    }[];
    envFrom?: { prefix?: string; configMapRef?: { name?: string }; secretRef?: { name?: string } }[];
}

/** The pod spec of a pod, or of a workload's pod template. */
export function podSpecOf(obj: K8sObject): Record<string, unknown> {
    const spec = (obj.spec ?? {}) as Record<string, unknown>;
    const template = spec.template as { spec?: Record<string, unknown> } | undefined;
    return template?.spec ?? spec;
}

export function containersOf(obj: K8sObject): ContainerSpec[] {
    return ((podSpecOf(obj).containers as ContainerSpec[] | undefined) ?? []).filter(Boolean);
}

export function initContainersOf(obj: K8sObject): ContainerSpec[] {
    return ((podSpecOf(obj).initContainers as ContainerSpec[] | undefined) ?? []).filter(Boolean);
}

/** requests/limits of one container, in cores and bytes. */
export function containerAllocation(c: ContainerSpec): { cpu: Gauge; mem: Gauge } {
    const req = c.resources?.requests ?? {};
    const lim = c.resources?.limits ?? {};
    return {
        cpu: { used: null, requests: parseQuantity(req.cpu), limits: parseQuantity(lim.cpu) },
        mem: { used: null, requests: parseQuantity(req.memory), limits: parseQuantity(lim.memory) },
    };
}

/**
 * requests/limits of a whole pod (or pod template).
 *
 * Init containers are counted the way the scheduler counts them — the pod's
 * effective request is the larger of "all app containers at once" and "the
 * greediest init container" — because they never run at the same time.
 */
export function podAllocation(obj: K8sObject): { cpu: Gauge; mem: Gauge } {
    const cpu = emptyGauge();
    const mem = emptyGauge();
    for (const c of containersOf(obj)) {
        const a = containerAllocation(c);
        cpu.requests += a.cpu.requests;
        cpu.limits += a.cpu.limits;
        mem.requests += a.mem.requests;
        mem.limits += a.mem.limits;
    }
    for (const c of initContainersOf(obj)) {
        const a = containerAllocation(c);
        cpu.requests = Math.max(cpu.requests, a.cpu.requests);
        cpu.limits = Math.max(cpu.limits, a.cpu.limits);
        mem.requests = Math.max(mem.requests, a.mem.requests);
        mem.limits = Math.max(mem.limits, a.mem.limits);
    }
    return { cpu, mem };
}

/** Add b into a, treating a null `used` as "still unknown" rather than zero. */
export function addGauge(a: Gauge, b: Gauge): Gauge {
    return {
        used: a.used === null && b.used === null ? null : (a.used ?? 0) + (b.used ?? 0),
        requests: a.requests + b.requests,
        limits: a.limits + b.limits,
    };
}

/** Does this object's labels satisfy a workload's `spec.selector`? */
export function selectorMatches(obj: K8sObject, selector: unknown): boolean {
    const sel = selector as
        | {
              matchLabels?: Record<string, string>;
              matchExpressions?: { key?: string; operator?: string; values?: string[] }[];
          }
        | undefined;
    if (!sel) return false;
    const labels = obj.metadata?.labels ?? {};
    for (const [k, v] of Object.entries(sel.matchLabels ?? {})) {
        if (labels[k] !== v) return false;
    }
    for (const expr of sel.matchExpressions ?? []) {
        const have = expr.key ? labels[expr.key] : undefined;
        const values = expr.values ?? [];
        switch (expr.operator) {
            case "In":
                if (have === undefined || !values.includes(have)) return false;
                break;
            case "NotIn":
                if (have !== undefined && values.includes(have)) return false;
                break;
            case "Exists":
                if (have === undefined) return false;
                break;
            case "DoesNotExist":
                if (have !== undefined) return false;
                break;
            default:
                break;
        }
    }
    return Boolean(sel.matchLabels || sel.matchExpressions);
}

/** Is `pod` owned (directly or through a ReplicaSet) by this workload? */
export function ownedBy(pod: K8sObject, owner: K8sObject, viaKinds: string[] = []): boolean {
    const refs = pod.metadata?.ownerReferences ?? [];
    const name = owner.metadata?.name ?? "";
    const kind = owner.kind ?? "";
    return refs.some(
        (r) => (r.kind === kind && r.name === name) || (viaKinds.includes(r.kind ?? "") && (r.name ?? "").startsWith(`${name}-`)),
    );
}

/** Metric lookups a page needs, with "no metrics at all" as a first-class state. */
export interface Sample {
    cpu: number;
    mem: number;
}

export interface MetricsView {
    available: boolean;
    pod(name: string, ns?: string): Sample | null;
    container(pod: string, container: string, ns?: string): Sample | null;
}

const convert = (m: PodMetrics | undefined): Sample | null =>
    m ? { cpu: parseQuantity(m.cpu), mem: parseQuantity(m.memory) } : null;

/**
 * kubectl top output as a lookup. Keys are tried namespace-qualified first,
 * because two namespaces are allowed to hold pods with the same name and a
 * bare-name map would silently show one pod's CPU on the other's row.
 */
export function metricsView(pods: Map<string, PodMetrics>, containers?: Map<string, PodMetrics>): MetricsView {
    return {
        available: pods.size > 0 || Boolean(containers && containers.size > 0),
        pod: (name, ns) => convert((ns ? pods.get(`${ns}/${name}`) : undefined) ?? pods.get(name)),
        container: (pod, container, ns) =>
            convert(
                (ns ? containers?.get(`${ns}/${pod}/${container}`) : undefined) ?? containers?.get(`${pod}/${container}`),
            ),
    };
}

/**
 * One `kubectl top --containers` call answers both questions: a pod's usage is
 * the sum of its containers', so the pod-level call can be skipped entirely.
 */
export function metricsFromContainers(containers: Map<string, PodMetrics>): MetricsView {
    const pods = new Map<string, { cpu: number; mem: number }>();
    for (const [key, m] of containers) {
        // Keys arrive both qualified (ns/pod/container) and bare (pod/container);
        // sum each shape into the matching pod key.
        const parts = key.split("/");
        const podKey = parts.slice(0, -1).join("/");
        const prev = pods.get(podKey) ?? { cpu: 0, mem: 0 };
        pods.set(podKey, { cpu: prev.cpu + parseQuantity(m.cpu), mem: prev.mem + parseQuantity(m.memory) });
    }
    const lookup = (key: string): Sample | null => pods.get(key) ?? null;
    return {
        available: containers.size > 0,
        pod: (name, ns) => (ns ? lookup(`${ns}/${name}`) : null) ?? lookup(name),
        container: (pod, container, ns) =>
            convert(
                (ns ? containers.get(`${ns}/${pod}/${container}`) : undefined) ?? containers.get(`${pod}/${container}`),
            ),
    };
}

export const NO_METRICS: MetricsView = {
    available: false,
    pod: () => null,
    container: () => null,
};

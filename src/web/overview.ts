/**
 * The cluster overview: the screen you open first and glance at, not one you
 * read. It answers four questions and nothing else — are the nodes healthy, is
 * there room, is anything crash-looping, and what has the cluster complained
 * about lately.
 *
 * Metrics are optional everywhere. A cluster without metrics-server still gets
 * capacity, requests, counts and events; the usage numbers simply come back
 * null and the UI draws the gauge as "no metrics" rather than as 0%.
 */

import {
    type K8sObject,
    listEvents,
    listResources,
    topNodes,
    topPods,
    clusterVersion,
} from "../kubectl.ts";
import { nodeRoles } from "../format.ts";
import { formatBytes, formatCpu, parseQuantity, percent } from "../quantity.ts";

export interface NodeCard {
    name: string;
    ready: boolean;
    schedulable: boolean;
    roles: string;
    version: string;
    os: string;
    pods: number;
    podCapacity: number;
    cpu: { used: number | null; requested: number; capacity: number; usedPercent: number | null };
    memory: { used: number | null; requested: number; capacity: number; usedPercent: number | null };
    conditions: { type: string; status: string }[];
    age: string;
}

export interface Overview {
    context: string;
    version: { client: string; server: string; platform: string };
    metricsAvailable: boolean;
    nodes: NodeCard[];
    totals: {
        nodes: number;
        nodesReady: number;
        namespaces: number;
        pods: number;
        podPhases: Record<string, number>;
        containers: number;
        restarts: number;
        cpuCapacity: number;
        cpuRequested: number;
        cpuUsed: number | null;
        memCapacity: number;
        memRequested: number;
        memUsed: number | null;
    };
    workloads: { kind: string; total: number; ready: number }[];
    problems: { object: string; namespace: string; reason: string; message: string; kind: string }[];
    warnings: { object: string; namespace: string; reason: string; message: string; lastSeen: string; count: number }[];
}

function ready(node: K8sObject): boolean {
    const conds = (node.status as { conditions?: { type?: string; status?: string }[] })?.conditions ?? [];
    return conds.some((c) => c.type === "Ready" && c.status === "True");
}

function podRequests(pod: K8sObject): { cpu: number; mem: number } {
    const containers = ((pod.spec as { containers?: unknown[] })?.containers ?? []) as {
        resources?: { requests?: { cpu?: string; memory?: string } };
    }[];
    let cpu = 0;
    let mem = 0;
    for (const c of containers) {
        cpu += parseQuantity(c.resources?.requests?.cpu);
        mem += parseQuantity(c.resources?.requests?.memory);
    }
    return { cpu, mem };
}

function ageOf(obj: K8sObject): string {
    const ts = obj.metadata?.creationTimestamp;
    if (!ts) return "";
    const days = (Date.now() - new Date(ts).getTime()) / 86400000;
    if (days >= 1) return `${Math.floor(days)}d`;
    const hours = days * 24;
    if (hours >= 1) return `${Math.floor(hours)}h`;
    return `${Math.max(1, Math.floor(hours * 60))}m`;
}

/** Pods that are neither Running-and-ready nor Succeeded deserve the front page. */
function podProblem(pod: K8sObject): { reason: string; message: string } | null {
    const status = pod.status as
        | {
              phase?: string;
              conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
              containerStatuses?: {
                  ready?: boolean;
                  restartCount?: number;
                  state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string } };
              }[];
          }
        | undefined;
    const phase = status?.phase ?? "";
    if (phase === "Succeeded") return null;

    for (const cs of status?.containerStatuses ?? []) {
        const waiting = cs.state?.waiting;
        if (waiting?.reason && waiting.reason !== "ContainerCreating" && waiting.reason !== "PodInitializing") {
            return { reason: waiting.reason, message: (waiting.message ?? "").replace(/\s+/g, " ").slice(0, 300) };
        }
        const term = cs.state?.terminated;
        if (term?.reason && term.reason !== "Completed") {
            return { reason: term.reason, message: "" };
        }
    }
    if (phase === "Failed") return { reason: "Failed", message: "" };
    if (phase === "Pending") {
        const unsched = status?.conditions?.find((c) => c.type === "PodScheduled" && c.status === "False");
        return { reason: unsched?.reason ?? "Pending", message: (unsched?.message ?? "").slice(0, 300) };
    }
    return null;
}

export async function buildOverview(context: string): Promise<Overview> {
    // Everything the overview needs, fetched at once. `kubectl top` and events
    // are allowed to fail; a broken metrics-server must not blank the page.
    const [nodes, pods, namespaces, deployments, statefulsets, daemonsets, version, nodeMetrics, podMetrics, events] =
        await Promise.all([
            listResources("nodes", { context, clusterScoped: true }).catch(() => [] as K8sObject[]),
            listResources("pods", { context }).catch(() => [] as K8sObject[]),
            listResources("namespaces", { context, clusterScoped: true }).catch(() => [] as K8sObject[]),
            listResources("deployments", { context }).catch(() => [] as K8sObject[]),
            listResources("statefulsets", { context }).catch(() => [] as K8sObject[]),
            listResources("daemonsets", { context }).catch(() => [] as K8sObject[]),
            clusterVersion(context).catch(() => ({ client: "", server: "", platform: "" })),
            topNodes(context).catch(() => new Map()),
            topPods(context, undefined).catch(() => new Map()),
            listEvents(context, undefined, 200).catch(() => []),
        ]);

    const podsByNode = new Map<string, K8sObject[]>();
    for (const pod of pods) {
        const node = (pod.spec as { nodeName?: string })?.nodeName ?? "";
        const list = podsByNode.get(node) ?? [];
        list.push(pod);
        podsByNode.set(node, list);
    }

    const metricsAvailable = nodeMetrics.size > 0 || podMetrics.size > 0;

    const nodeCards: NodeCard[] = nodes.map((n) => {
        const name = n.metadata?.name ?? "";
        const status = n.status as {
            capacity?: Record<string, string>;
            allocatable?: Record<string, string>;
            nodeInfo?: { kubeletVersion?: string; osImage?: string };
            conditions?: { type?: string; status?: string }[];
        };
        const onNode = podsByNode.get(name) ?? [];
        const req = onNode.reduce<{ cpu: number; mem: number }>(
            (acc, p) => {
                const r = podRequests(p);
                return { cpu: acc.cpu + r.cpu, mem: acc.mem + r.mem };
            },
            { cpu: 0, mem: 0 },
        );
        const cpuCapacity = parseQuantity(status?.allocatable?.cpu ?? status?.capacity?.cpu);
        const memCapacity = parseQuantity(status?.allocatable?.memory ?? status?.capacity?.memory);
        const m = nodeMetrics.get(name);
        const cpuUsed = m ? parseQuantity(m.cpu) : null;
        const memUsed = m ? parseQuantity(m.memory) : null;
        return {
            name,
            ready: ready(n),
            schedulable: !(n.spec as { unschedulable?: boolean })?.unschedulable,
            roles: nodeRoles(n),
            version: status?.nodeInfo?.kubeletVersion ?? "",
            os: status?.nodeInfo?.osImage ?? "",
            pods: onNode.length,
            podCapacity: Number(parseQuantity(status?.allocatable?.pods ?? status?.capacity?.pods)) || 0,
            cpu: {
                used: cpuUsed,
                requested: req.cpu,
                capacity: cpuCapacity,
                usedPercent: cpuUsed === null ? (m?.cpuPercent ?? null) : percent(cpuUsed, cpuCapacity),
            },
            memory: {
                used: memUsed,
                requested: req.mem,
                capacity: memCapacity,
                usedPercent: memUsed === null ? (m?.memoryPercent ?? null) : percent(memUsed, memCapacity),
            },
            conditions: (status?.conditions ?? [])
                .filter((c) => c.type && c.status)
                .map((c) => ({ type: c.type!, status: c.status! })),
            age: ageOf(n),
        };
    });

    const podPhases: Record<string, number> = {};
    let containers = 0;
    let restarts = 0;
    for (const pod of pods) {
        const phase = (pod.status as { phase?: string })?.phase ?? "Unknown";
        podPhases[phase] = (podPhases[phase] ?? 0) + 1;
        const cs = ((pod.status as { containerStatuses?: { restartCount?: number }[] })?.containerStatuses ?? []) as {
            restartCount?: number;
        }[];
        containers += cs.length;
        for (const c of cs) restarts += c.restartCount ?? 0;
    }

    const totalReq = pods.reduce<{ cpu: number; mem: number }>(
        (acc, p) => {
            const r = podRequests(p);
            return { cpu: acc.cpu + r.cpu, mem: acc.mem + r.mem };
        },
        { cpu: 0, mem: 0 },
    );

    const cpuUsedTotal = nodeCards.reduce<number | null>(
        (acc, n) => (n.cpu.used === null || acc === null ? null : acc + n.cpu.used),
        0,
    );
    const memUsedTotal = nodeCards.reduce<number | null>(
        (acc, n) => (n.memory.used === null || acc === null ? null : acc + n.memory.used),
        0,
    );

    const readyCount = (items: K8sObject[], readyOf: (o: K8sObject) => boolean) => items.filter(readyOf).length;
    const deployReady = (o: K8sObject) => {
        const s = o.status as { readyReplicas?: number };
        const want = (o.spec as { replicas?: number })?.replicas ?? 0;
        return (s?.readyReplicas ?? 0) >= want;
    };
    const dsReady = (o: K8sObject) => {
        const s = o.status as { numberReady?: number; desiredNumberScheduled?: number };
        return (s?.numberReady ?? 0) >= (s?.desiredNumberScheduled ?? 0);
    };

    const problems = pods
        .map((p) => {
            const problem = podProblem(p);
            if (!problem) return null;
            return {
                object: p.metadata?.name ?? "",
                namespace: p.metadata?.namespace ?? "",
                kind: "pods",
                reason: problem.reason,
                message: problem.message,
            };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .slice(0, 50);

    return {
        context,
        version,
        metricsAvailable,
        nodes: nodeCards,
        totals: {
            nodes: nodes.length,
            nodesReady: nodeCards.filter((n) => n.ready).length,
            namespaces: namespaces.length,
            pods: pods.length,
            podPhases,
            containers,
            restarts,
            cpuCapacity: nodeCards.reduce((a, n) => a + n.cpu.capacity, 0),
            cpuRequested: totalReq.cpu,
            cpuUsed: cpuUsedTotal,
            memCapacity: nodeCards.reduce((a, n) => a + n.memory.capacity, 0),
            memRequested: totalReq.mem,
            memUsed: memUsedTotal,
        },
        workloads: [
            { kind: "deployments", total: deployments.length, ready: readyCount(deployments, deployReady) },
            { kind: "statefulsets", total: statefulsets.length, ready: readyCount(statefulsets, deployReady) },
            { kind: "daemonsets", total: daemonsets.length, ready: readyCount(daemonsets, dsReady) },
        ],
        problems,
        warnings: events
            .filter((e) => e.type === "Warning")
            .slice(0, 50)
            .map((e) => ({
                object: e.object,
                namespace: e.namespace,
                reason: e.reason,
                message: e.message.slice(0, 300),
                lastSeen: e.lastSeen,
                count: e.count,
            })),
    };
}

/** Display helpers shared with the pod/node tables. */
export const display = { formatCpu, formatBytes };

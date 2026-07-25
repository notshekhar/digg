/**
 * Usage columns for the resource tables.
 *
 * A pod list that shows READY and AGE but not what the thing is *doing* sends
 * you to `kubectl top` in another window, so pods, the workloads that own them
 * and nodes all get live CPU/memory columns with a bar.
 *
 * The bar's denominator is the honest part. A container with a limit is drawn
 * against its limit and marked at its request — the two numbers that decide
 * whether it gets throttled or OOM-killed. A container with no limit has no
 * true ceiling, so the column falls back to the largest value in this table:
 * the bar then means "relative to the busiest row here", which is a comparison,
 * not a promise. Both are honest; a bar with an invented ceiling would not be.
 */

import { type K8sObject, listResources, topNodes, topPods } from "../kubectl.ts";
import { workloadSelector } from "../format.ts";
import { formatBytes, formatCpu, parseQuantity, percent } from "../quantity.ts";
import { type Gauge, addGauge, emptyGauge, podAllocation, selectorMatches } from "../usage.ts";

export interface Meter {
    pct: number | null;
    mark: number | null;
}

export interface UsageColumns {
    /** Column labels to splice into the kind's own columns. */
    columns: string[];
    /** Column label to insert before; falls back to the end of the row. */
    insertBefore: string;
    /** Cells and bars per object, keyed "ns/name". */
    byKey: Map<string, { cells: string[]; meters: (Meter | null)[] }>;
}

const key = (obj: K8sObject) => `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;

/** Kinds whose rows carry usage bars. */
export const USAGE_KINDS = new Set([
    "pods",
    "deployments",
    "statefulsets",
    "daemonsets",
    "replicasets",
    "jobs",
    "nodes",
]);

function meterFor(gauge: Gauge, fallbackMax: number): Meter {
    const ceiling = gauge.limits > 0 ? gauge.limits : fallbackMax;
    return {
        pct: gauge.used === null ? null : percent(gauge.used, ceiling),
        mark: gauge.requests > 0 ? percent(gauge.requests, ceiling) : null,
    };
}

/** Largest value a column will have to draw, so bars share one scale. */
function ceilingOf(gauges: Gauge[], pick: (g: Gauge) => number): number {
    let max = 0;
    for (const g of gauges) {
        max = Math.max(max, pick(g), g.used ?? 0);
    }
    return max > 0 ? max * 1.15 : 1;
}

export async function usageColumns(
    kindName: string,
    items: K8sObject[],
    context: string,
    namespace: string | null,
): Promise<UsageColumns | null> {
    if (!USAGE_KINDS.has(kindName) || items.length === 0) return null;
    try {
        if (kindName === "nodes") return await nodeUsage(items, context);
        return await podsideUsage(kindName, items, context, namespace);
    } catch {
        // Metrics are a bonus column, never a reason a table fails to load.
        return null;
    }
}

/** Pods, and anything whose usage is the sum of the pods it owns. */
async function podsideUsage(
    kindName: string,
    items: K8sObject[],
    context: string,
    namespace: string | null,
): Promise<UsageColumns | null> {
    const ns = namespace ?? undefined;
    const [top, pods] = await Promise.all([
        topPods(context, ns).catch(() => new Map()),
        kindName === "pods"
            ? Promise.resolve(items)
            : listResources("pods", { context, namespace: ns }).catch(() => [] as K8sObject[]),
    ]);
    const sample = (pod: K8sObject): { cpu: number; mem: number } | null => {
        const m =
            top.get(`${pod.metadata?.namespace ?? ""}/${pod.metadata?.name ?? ""}`) ?? top.get(pod.metadata?.name ?? "");
        return m ? { cpu: parseQuantity(m.cpu), mem: parseQuantity(m.memory) } : null;
    };

    const gauges = new Map<string, { cpu: Gauge; mem: Gauge }>();
    for (const obj of items) {
        if (kindName === "pods") {
            const alloc = podAllocation(obj);
            const live = sample(obj);
            gauges.set(key(obj), {
                cpu: { ...alloc.cpu, used: live ? live.cpu : null },
                mem: { ...alloc.mem, used: live ? live.mem : null },
            });
            continue;
        }
        // A workload's pods are the ones its own selector matches, in its own
        // namespace. Walking ownerReferences would need the intermediate
        // ReplicaSets — one more list call for the same answer.
        const selector = (obj.spec as { selector?: unknown })?.selector;
        let cpu = emptyGauge();
        let mem = emptyGauge();
        for (const pod of pods) {
            if (pod.metadata?.namespace !== obj.metadata?.namespace) continue;
            if (!selectorMatches(pod, selector)) continue;
            const alloc = podAllocation(pod);
            const live = sample(pod);
            cpu = addGauge(cpu, { ...alloc.cpu, used: live ? live.cpu : null });
            mem = addGauge(mem, { ...alloc.mem, used: live ? live.mem : null });
        }
        gauges.set(key(obj), { cpu, mem });
    }

    const all = [...gauges.values()];
    const cpuCeiling = ceilingOf(all.map((g) => g.cpu), (g) => g.limits);
    const memCeiling = ceilingOf(all.map((g) => g.mem), (g) => g.limits);

    const byKey = new Map<string, { cells: string[]; meters: (Meter | null)[] }>();
    for (const [k, g] of gauges) {
        byKey.set(k, {
            cells: [
                g.cpu.used === null ? "—" : formatCpu(g.cpu.used),
                g.mem.used === null ? "—" : formatBytes(g.mem.used),
            ],
            meters: [meterFor(g.cpu, cpuCeiling), meterFor(g.mem, memCeiling)],
        });
    }
    return { columns: ["CPU USAGE", "MEMORY USAGE"], insertBefore: "AGE", byKey };
}

/** Nodes: usage against capacity, and how much of it is already promised. */
async function nodeUsage(items: K8sObject[], context: string): Promise<UsageColumns> {
    const [top, pods] = await Promise.all([
        topNodes(context).catch(() => new Map()),
        listResources("pods", { context }).catch(() => [] as K8sObject[]),
    ]);

    const requested = new Map<string, { cpu: number; mem: number; pods: number }>();
    for (const pod of pods) {
        const node = (pod.spec as { nodeName?: string })?.nodeName;
        const phase = (pod.status as { phase?: string })?.phase;
        if (!node || phase === "Succeeded" || phase === "Failed") continue;
        const alloc = podAllocation(pod);
        const prev = requested.get(node) ?? { cpu: 0, mem: 0, pods: 0 };
        requested.set(node, {
            cpu: prev.cpu + alloc.cpu.requests,
            mem: prev.mem + alloc.mem.requests,
            pods: prev.pods + 1,
        });
    }

    const byKey = new Map<string, { cells: string[]; meters: (Meter | null)[] }>();
    for (const node of items) {
        const name = node.metadata?.name ?? "";
        const status = node.status as { allocatable?: Record<string, string>; capacity?: Record<string, string> };
        const alloc = status?.allocatable ?? status?.capacity ?? {};
        const cpuCap = parseQuantity(alloc.cpu);
        const memCap = parseQuantity(alloc.memory);
        const podCap = parseQuantity(alloc.pods);
        const live = top.get(name);
        const req = requested.get(name) ?? { cpu: 0, mem: 0, pods: 0 };
        const cpuUsed = live ? parseQuantity(live.cpu) : null;
        const memUsed = live ? parseQuantity(live.memory) : null;
        const cpuAlloc = percent(req.cpu, cpuCap);
        const memAlloc = percent(req.mem, memCap);

        byKey.set(key(node), {
            cells: [
                podCap > 0 ? `${req.pods}/${podCap}` : String(req.pods),
                cpuUsed === null ? "—" : formatCpu(cpuUsed),
                cpuAlloc === null ? "—" : `${Math.round(cpuAlloc)}%`,
                memUsed === null ? "—" : formatBytes(memUsed),
                memAlloc === null ? "—" : `${Math.round(memAlloc)}%`,
            ],
            meters: [
                { pct: percent(req.pods, podCap), mark: null },
                { pct: cpuUsed === null ? null : percent(cpuUsed, cpuCap), mark: cpuAlloc },
                { pct: cpuAlloc, mark: null },
                { pct: memUsed === null ? null : percent(memUsed, memCap), mark: memAlloc },
                { pct: memAlloc, mark: null },
            ],
        });
    }

    return {
        columns: ["PODS", "CPU USAGE", "CPU ALLOC", "MEMORY USAGE", "MEM ALLOC"],
        insertBefore: "ROLES",
        byKey,
    };
}

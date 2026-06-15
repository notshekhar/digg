import chalk from "chalk";
import type { K8sObject } from "./kubectl.ts";

export interface KindDef {
    /** kubectl resource name (plural), used in `kubectl get <name>`. */
    name: string;
    /** Short label shown in the UI. */
    title: string;
    clusterScoped?: boolean;
    columns: string[];
    /** Extract cell values (excluding the leading NAMESPACE column). */
    row: (obj: K8sObject) => string[];
}

const NAME = (obj: K8sObject): string => obj.metadata?.name ?? "<none>";

export function age(obj: K8sObject): string {
    const ts = obj.metadata?.creationTimestamp;
    if (!ts) {
        return "";
    }
    const seconds = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    const minutes = seconds / 60;
    if (minutes < 60) return `${Math.floor(minutes)}m`;
    const hours = minutes / 60;
    if (hours < 24) return `${Math.floor(hours)}h`;
    const days = hours / 24;
    if (days < 365) return `${Math.floor(days)}d`;
    return `${Math.floor(days / 365)}y`;
}

function podReady(obj: K8sObject): string {
    const statuses = (obj.status as { containerStatuses?: { ready?: boolean }[] })?.containerStatuses ?? [];
    const ready = statuses.filter((s) => s.ready).length;
    return `${ready}/${statuses.length || (obj.spec as { containers?: unknown[] })?.containers?.length || 0}`;
}

function podRestarts(obj: K8sObject): string {
    const statuses = (obj.status as { containerStatuses?: { restartCount?: number }[] })?.containerStatuses ?? [];
    return String(statuses.reduce((sum, s) => sum + (s.restartCount ?? 0), 0));
}

function podStatus(obj: K8sObject): string {
    return ((obj.status as { phase?: string })?.phase) ?? "";
}

/** Colorize a status/phase string for terminals. */
export function colorizeStatus(value: string): string {
    const v = value.toLowerCase();
    if (v === "running" || v === "active" || v === "ready" || v === "bound" || v === "succeeded") {
        return chalk.green(value);
    }
    if (v === "pending" || v === "containercreating" || v === "terminating" || v === "notready") {
        return chalk.yellow(value);
    }
    if (v.includes("error") || v.includes("failed") || v === "crashloopbackoff" || v === "evicted" || v === "oomkilled") {
        return chalk.red(value);
    }
    return value;
}

const deployReady = (obj: K8sObject): string => {
    const s = obj.status as { readyReplicas?: number; replicas?: number };
    return `${s?.readyReplicas ?? 0}/${s?.replicas ?? 0}`;
};

export const KINDS: KindDef[] = [
    {
        name: "pods",
        title: "Pods",
        columns: ["NAME", "READY", "STATUS", "RESTARTS", "AGE"],
        row: (o) => [NAME(o), podReady(o), podStatus(o), podRestarts(o), age(o)],
    },
    {
        name: "deployments",
        title: "Deployments",
        columns: ["NAME", "READY", "AGE"],
        row: (o) => [NAME(o), deployReady(o), age(o)],
    },
    {
        name: "statefulsets",
        title: "StatefulSets",
        columns: ["NAME", "READY", "AGE"],
        row: (o) => [NAME(o), deployReady(o), age(o)],
    },
    {
        name: "daemonsets",
        title: "DaemonSets",
        columns: ["NAME", "READY", "AGE"],
        row: (o) => {
            const s = o.status as { numberReady?: number; desiredNumberScheduled?: number };
            return [NAME(o), `${s?.numberReady ?? 0}/${s?.desiredNumberScheduled ?? 0}`, age(o)];
        },
    },
    {
        name: "services",
        title: "Services",
        columns: ["NAME", "TYPE", "CLUSTER-IP", "AGE"],
        row: (o) => {
            const s = o.spec as { type?: string; clusterIP?: string };
            return [NAME(o), s?.type ?? "", s?.clusterIP ?? "", age(o)];
        },
    },
    {
        name: "ingresses",
        title: "Ingresses",
        columns: ["NAME", "AGE"],
        row: (o) => [NAME(o), age(o)],
    },
    {
        name: "configmaps",
        title: "ConfigMaps",
        columns: ["NAME", "DATA", "AGE"],
        row: (o) => [NAME(o), String(Object.keys((o.data as object) ?? {}).length), age(o)],
    },
    {
        name: "secrets",
        title: "Secrets",
        columns: ["NAME", "TYPE", "AGE"],
        row: (o) => [NAME(o), String(o.type ?? ""), age(o)],
    },
    {
        name: "jobs",
        title: "Jobs",
        columns: ["NAME", "AGE"],
        row: (o) => [NAME(o), age(o)],
    },
    {
        name: "cronjobs",
        title: "CronJobs",
        columns: ["NAME", "SCHEDULE", "AGE"],
        row: (o) => [NAME(o), String((o.spec as { schedule?: string })?.schedule ?? ""), age(o)],
    },
    {
        name: "nodes",
        title: "Nodes",
        clusterScoped: true,
        columns: ["NAME", "STATUS", "AGE"],
        row: (o) => {
            const conditions = (o.status as { conditions?: { type?: string; status?: string }[] })?.conditions ?? [];
            const ready = conditions.find((c) => c.type === "Ready");
            return [NAME(o), ready?.status === "True" ? "Ready" : "NotReady", age(o)];
        },
    },
    {
        name: "namespaces",
        title: "Namespaces",
        clusterScoped: true,
        columns: ["NAME", "STATUS", "AGE"],
        row: (o) => [NAME(o), podStatus(o) || ((o.status as { phase?: string })?.phase ?? ""), age(o)],
    },
    {
        name: "persistentvolumeclaims",
        title: "PVCs",
        columns: ["NAME", "STATUS", "AGE"],
        row: (o) => [NAME(o), String((o.status as { phase?: string })?.phase ?? ""), age(o)],
    },
];

export function findKind(name: string): KindDef | undefined {
    return KINDS.find((k) => k.name === name);
}

export function revisionOf(rs: K8sObject): number {
    return Number(
        (rs.metadata as { annotations?: Record<string, string> })?.annotations?.["deployment.kubernetes.io/revision"] ??
            0,
    );
}

/** Newest-first ReplicaSets for a deployment. */
export function sortRevisions(replicaSets: K8sObject[]): K8sObject[] {
    return [...replicaSets].sort((a, b) => revisionOf(b) - revisionOf(a));
}

/** One-line summary of a revision (ReplicaSet) for a selectable list. */
export function revisionLabel(rs: K8sObject): string {
    const status = rs.status as { replicas?: number; readyReplicas?: number };
    const replicas = `${status?.readyReplicas ?? 0}/${status?.replicas ?? 0}`;
    return `rev ${String(revisionOf(rs)).padEnd(4)} ${replicas.padEnd(6)} ${age(rs).padEnd(5)} ${images(rs)}`;
}

/** Kinds that own a set of pods we can drill into. */
export const WORKLOAD_KINDS = new Set(["deployments", "statefulsets", "daemonsets", "replicasets", "jobs"]);

/** Build a `k=v,k=v` label selector from a workload's spec.selector.matchLabels. */
export function workloadSelector(obj: K8sObject): string | undefined {
    const match = (obj.spec as { selector?: { matchLabels?: Record<string, string> } })?.selector?.matchLabels;
    if (!match || Object.keys(match).length === 0) {
        return undefined;
    }
    return Object.entries(match)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
}

function images(obj: K8sObject): string {
    const containers =
        ((obj.spec as { template?: { spec?: { containers?: { image?: string }[] } } })?.template?.spec?.containers) ??
        ((obj.spec as { containers?: { image?: string }[] })?.containers) ??
        [];
    return containers.map((c) => c.image ?? "").filter(Boolean).join(", ");
}

/** Key/value summary rows shown at the top of a workload detail dashboard. */
export function workloadSummary(obj: K8sObject): [string, string][] {
    const s = obj.status as {
        replicas?: number;
        readyReplicas?: number;
        updatedReplicas?: number;
        availableReplicas?: number;
        numberReady?: number;
        desiredNumberScheduled?: number;
    };
    const rows: [string, string][] = [];
    rows.push(["Namespace", obj.metadata?.namespace ?? "—"]);
    if (s?.desiredNumberScheduled !== undefined) {
        rows.push(["Ready", `${s.numberReady ?? 0}/${s.desiredNumberScheduled}`]);
    } else {
        rows.push(["Replicas", `${s?.readyReplicas ?? 0} ready / ${s?.replicas ?? 0} desired`]);
        rows.push(["Updated", String(s?.updatedReplicas ?? 0)]);
        rows.push(["Available", String(s?.availableReplicas ?? 0)]);
    }
    const strategy = (obj.spec as { strategy?: { type?: string } })?.strategy?.type;
    if (strategy) {
        rows.push(["Strategy", strategy]);
    }
    rows.push(["Images", images(obj) || "—"]);
    rows.push(["Age", age(obj)]);
    return rows;
}

/** Container rows for a pod detail (name, image, ready, restarts). */
export function podContainers(obj: K8sObject): { name: string; image: string; ready: string; restarts: string }[] {
    const specContainers = (obj.spec as { containers?: { name?: string; image?: string }[] })?.containers ?? [];
    const statuses = (obj.status as { containerStatuses?: { name?: string; ready?: boolean; restartCount?: number }[] })
        ?.containerStatuses ?? [];
    return specContainers.map((c) => {
        const st = statuses.find((s) => s.name === c.name);
        return {
            name: c.name ?? "",
            image: c.image ?? "",
            ready: st?.ready ? "true" : "false",
            restarts: String(st?.restartCount ?? 0),
        };
    });
}

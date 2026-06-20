import chalk from "chalk";
import type { K8sObject } from "./kubectl.ts";

export interface KindDef {
    /** kubectl resource name (plural), used in `kubectl get <name>`. */
    name: string;
    /** Short label shown in the UI. */
    title: string;
    /** PascalCase singular Kind (e.g. "Pod") — used for event field selectors. */
    kind: string;
    clusterScoped?: boolean;
    columns: string[];
    /** Extract cell values (excluding the leading NAMESPACE column). */
    row: (obj: K8sObject) => string[];
    /** True for kinds discovered at runtime (CRDs etc.) rather than curated. */
    generic?: boolean;
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

const none = (v: string | undefined | null): string => (v && v.length > 0 ? v : "<none>");

const podNode = (o: K8sObject): string => (o.spec as { nodeName?: string })?.nodeName ?? "";
const podIP = (o: K8sObject): string => (o.status as { podIP?: string })?.podIP ?? "";

/** kubectl-style pod phase: surfaces waiting/terminated reasons and Terminating. */
export function podPhase(obj: K8sObject): string {
    if ((obj.metadata as { deletionTimestamp?: string })?.deletionTimestamp) {
        return "Terminating";
    }
    const status = obj.status as {
        phase?: string;
        reason?: string;
        containerStatuses?: { state?: { waiting?: { reason?: string }; terminated?: { reason?: string } } }[];
    };
    for (const cs of status?.containerStatuses ?? []) {
        const reason = cs.state?.waiting?.reason ?? cs.state?.terminated?.reason;
        if (reason && reason !== "Completed") {
            return reason;
        }
    }
    return status?.reason ?? status?.phase ?? "";
}

function ageFrom(ts?: string): string {
    if (!ts) return "";
    return age({ metadata: { creationTimestamp: ts } } as K8sObject);
}

function servicePorts(o: K8sObject): string {
    const ports = (o.spec as { ports?: { port?: number; nodePort?: number; protocol?: string }[] })?.ports ?? [];
    return (
        ports
            .map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`)
            .join(",") || "<none>"
    );
}

function serviceExternalIP(o: K8sObject): string {
    const spec = o.spec as { type?: string; externalIPs?: string[] };
    const ingress = (o.status as { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } })?.loadBalancer
        ?.ingress;
    if (ingress?.length) {
        return ingress.map((i) => i.ip ?? i.hostname ?? "").filter(Boolean).join(",") || "<pending>";
    }
    if (spec?.externalIPs?.length) {
        return spec.externalIPs.join(",");
    }
    return spec?.type === "LoadBalancer" ? "<pending>" : "<none>";
}

interface IngressRule {
    host?: string;
    http?: { paths?: { path?: string; backend?: { service?: { name?: string; port?: { number?: number; name?: string } } } }[] };
}

function ingressHosts(o: K8sObject): string {
    const rules = (o.spec as { rules?: IngressRule[] })?.rules ?? [];
    const hosts = rules.map((r) => r.host).filter(Boolean) as string[];
    return hosts.length ? [...new Set(hosts)].join(",") : "*";
}

function ingressAddress(o: K8sObject): string {
    const ingress = (o.status as { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } })?.loadBalancer
        ?.ingress;
    return ingress?.map((i) => i.ip ?? i.hostname ?? "").filter(Boolean).join(",") ?? "";
}

function ingressPorts(o: K8sObject): string {
    return (o.spec as { tls?: unknown[] })?.tls?.length ? "80, 443" : "80";
}

function jobCompletions(o: K8sObject): string {
    const succeeded = (o.status as { succeeded?: number })?.succeeded ?? 0;
    const completions = (o.spec as { completions?: number })?.completions ?? 1;
    return `${succeeded}/${completions}`;
}

function jobDuration(o: K8sObject): string {
    const s = o.status as { startTime?: string; completionTime?: string };
    if (!s?.startTime) return "";
    const end = s.completionTime ? new Date(s.completionTime).getTime() : Date.now();
    const seconds = Math.max(0, (end - new Date(s.startTime).getTime()) / 1000);
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
}

export function jobStatus(o: K8sObject): string {
    const conditions = (o.status as { conditions?: { type?: string; status?: string }[] })?.conditions ?? [];
    if (conditions.some((c) => c.type === "Complete" && c.status === "True")) return "Complete";
    if (conditions.some((c) => c.type === "Failed" && c.status === "True")) return "Failed";
    const active = (o.status as { active?: number })?.active ?? 0;
    return active > 0 ? "Running" : "Pending";
}

function cronActive(o: K8sObject): string {
    return String((o.status as { active?: unknown[] })?.active?.length ?? 0);
}

export function nodeRoles(o: K8sObject): string {
    const labels = o.metadata?.labels ?? {};
    const roles = Object.keys(labels)
        .filter((k) => k.startsWith("node-role.kubernetes.io/"))
        .map((k) => k.slice("node-role.kubernetes.io/".length))
        .filter(Boolean);
    return roles.length ? roles.sort().join(",") : "<none>";
}

function nodeVersion(o: K8sObject): string {
    return (o.status as { nodeInfo?: { kubeletVersion?: string } })?.nodeInfo?.kubeletVersion ?? "";
}

function nodeInternalIP(o: K8sObject): string {
    const addrs = (o.status as { addresses?: { type?: string; address?: string }[] })?.addresses ?? [];
    return addrs.find((a) => a.type === "InternalIP")?.address ?? "";
}

function nodeReady(o: K8sObject): string {
    const conditions = (o.status as { conditions?: { type?: string; status?: string }[] })?.conditions ?? [];
    const ready = conditions.find((c) => c.type === "Ready");
    if (ready?.status !== "True") return "NotReady";
    const unschedulable = (o.spec as { unschedulable?: boolean })?.unschedulable;
    return unschedulable ? "Ready,SchedulingDisabled" : "Ready";
}

const ACCESS_MODE_ABBR: Record<string, string> = {
    ReadWriteOnce: "RWO",
    ReadOnlyMany: "ROX",
    ReadWriteMany: "RWX",
    ReadWriteOncePod: "RWOP",
};

export function pvcAccessModes(o: K8sObject): string {
    const modes = (o.status as { accessModes?: string[] })?.accessModes ?? (o.spec as { accessModes?: string[] })?.accessModes ?? [];
    return modes.map((m) => ACCESS_MODE_ABBR[m] ?? m).join(",");
}

const pvcCapacity = (o: K8sObject): string =>
    (o.status as { capacity?: { storage?: string } })?.capacity?.storage ?? "";
const pvcVolume = (o: K8sObject): string => (o.spec as { volumeName?: string })?.volumeName ?? "";
const pvcStorageClass = (o: K8sObject): string => (o.spec as { storageClassName?: string })?.storageClassName ?? "";

export const KINDS: KindDef[] = [
    {
        name: "pods",
        title: "Pods",
        kind: "Pod",
        columns: ["NAME", "READY", "STATUS", "RESTARTS", "IP", "NODE", "AGE"],
        row: (o) => [NAME(o), podReady(o), podPhase(o), podRestarts(o), none(podIP(o)), none(podNode(o)), age(o)],
    },
    {
        name: "deployments",
        title: "Deployments",
        kind: "Deployment",
        columns: ["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"],
        row: (o) => {
            const s = o.status as { updatedReplicas?: number; availableReplicas?: number };
            return [NAME(o), deployReady(o), String(s?.updatedReplicas ?? 0), String(s?.availableReplicas ?? 0), age(o)];
        },
    },
    {
        name: "statefulsets",
        title: "StatefulSets",
        kind: "StatefulSet",
        columns: ["NAME", "READY", "AGE"],
        row: (o) => [NAME(o), deployReady(o), age(o)],
    },
    {
        name: "daemonsets",
        title: "DaemonSets",
        kind: "DaemonSet",
        columns: ["NAME", "DESIRED", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"],
        row: (o) => {
            const s = o.status as {
                numberReady?: number;
                desiredNumberScheduled?: number;
                updatedNumberScheduled?: number;
                numberAvailable?: number;
            };
            return [
                NAME(o),
                String(s?.desiredNumberScheduled ?? 0),
                String(s?.numberReady ?? 0),
                String(s?.updatedNumberScheduled ?? 0),
                String(s?.numberAvailable ?? 0),
                age(o),
            ];
        },
    },
    {
        name: "services",
        title: "Services",
        kind: "Service",
        columns: ["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORTS", "AGE"],
        row: (o) => {
            const s = o.spec as { type?: string; clusterIP?: string };
            return [NAME(o), s?.type ?? "", s?.clusterIP ?? "", serviceExternalIP(o), servicePorts(o), age(o)];
        },
    },
    {
        name: "ingresses",
        title: "Ingresses",
        kind: "Ingress",
        columns: ["NAME", "CLASS", "HOSTS", "ADDRESS", "PORTS", "AGE"],
        row: (o) => [
            NAME(o),
            none((o.spec as { ingressClassName?: string })?.ingressClassName),
            ingressHosts(o),
            ingressAddress(o),
            ingressPorts(o),
            age(o),
        ],
    },
    {
        name: "configmaps",
        title: "ConfigMaps",
        kind: "ConfigMap",
        columns: ["NAME", "DATA", "AGE"],
        row: (o) => [NAME(o), String(Object.keys((o.data as object) ?? {}).length), age(o)],
    },
    {
        name: "secrets",
        title: "Secrets",
        kind: "Secret",
        columns: ["NAME", "TYPE", "DATA", "AGE"],
        row: (o) => [NAME(o), String(o.type ?? ""), String(Object.keys((o.data as object) ?? {}).length), age(o)],
    },
    {
        name: "jobs",
        title: "Jobs",
        kind: "Job",
        columns: ["NAME", "STATUS", "COMPLETIONS", "DURATION", "AGE"],
        row: (o) => [NAME(o), jobStatus(o), jobCompletions(o), jobDuration(o), age(o)],
    },
    {
        name: "cronjobs",
        title: "CronJobs",
        kind: "CronJob",
        columns: ["NAME", "SCHEDULE", "SUSPEND", "ACTIVE", "LAST SCHEDULE", "AGE"],
        row: (o) => [
            NAME(o),
            String((o.spec as { schedule?: string })?.schedule ?? ""),
            String((o.spec as { suspend?: boolean })?.suspend ?? false),
            cronActive(o),
            ageFrom((o.status as { lastScheduleTime?: string })?.lastScheduleTime) || "<none>",
            age(o),
        ],
    },
    {
        name: "nodes",
        title: "Nodes",
        kind: "Node",
        clusterScoped: true,
        columns: ["NAME", "STATUS", "ROLES", "VERSION", "INTERNAL-IP", "AGE"],
        row: (o) => [NAME(o), nodeReady(o), nodeRoles(o), nodeVersion(o), nodeInternalIP(o), age(o)],
    },
    {
        name: "namespaces",
        title: "Namespaces",
        kind: "Namespace",
        clusterScoped: true,
        columns: ["NAME", "STATUS", "AGE"],
        row: (o) => [NAME(o), podStatus(o) || ((o.status as { phase?: string })?.phase ?? ""), age(o)],
    },
    {
        name: "persistentvolumeclaims",
        title: "PVCs",
        kind: "PersistentVolumeClaim",
        columns: ["NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS", "STORAGECLASS", "AGE"],
        row: (o) => [
            NAME(o),
            String((o.status as { phase?: string })?.phase ?? ""),
            none(pvcVolume(o)),
            pvcCapacity(o),
            pvcAccessModes(o),
            none(pvcStorageClass(o)),
            age(o),
        ],
    },
];

export function findKind(name: string): KindDef | undefined {
    return KINDS.find((k) => k.name === name);
}

/**
 * Build a generic KindDef for a discovered resource (CRD, RBAC, etc.) that
 * isn't in the curated set. Columns are minimal — NAME, optional STATUS phase,
 * AGE — but yaml/describe/edit/delete/events still work, so it's never a dead
 * end.
 */
export function genericKind(d: { name: string; kind: string; namespaced: boolean }): KindDef {
    const title = d.kind || d.name;
    return {
        name: d.name,
        title,
        kind: d.kind || title,
        clusterScoped: !d.namespaced,
        generic: true,
        columns: ["NAME", "STATUS", "AGE"],
        row: (o) => [NAME(o), genericStatus(o), age(o)],
    };
}

/** Best-effort one-word status for an unknown kind from common fields. */
function genericStatus(o: K8sObject): string {
    const s = o.status as { phase?: string; conditions?: { type?: string; status?: string }[] } | undefined;
    if (s?.phase) return s.phase;
    const ready = s?.conditions?.find((c) => c.type === "Ready" || c.type === "Available");
    if (ready) return ready.status === "True" ? "Ready" : "NotReady";
    return "";
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

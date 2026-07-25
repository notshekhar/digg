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

const deployReady = (obj: K8sObject): string => {
    const s = obj.status as { readyReplicas?: number; replicas?: number };
    return `${s?.readyReplicas ?? 0}/${s?.replicas ?? 0}`;
};

const none = (v: string | undefined | null): string => (v && v.length > 0 ? v : "<none>");

const podNode = (o: K8sObject): string => (o.spec as { nodeName?: string })?.nodeName ?? "";
const podIP = (o: K8sObject): string => (o.status as { podIP?: string })?.podIP ?? "";

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

    // ── the rest of the built-in API surface ───────────────────────────────
    //
    // Everything below exists so a cluster browser is never a dead end: RBAC,
    // storage, policy and scheduling kinds all get real columns instead of the
    // NAME/STATUS/AGE fallback in genericKind(). Column choices follow
    // `kubectl get`'s own output, because that is the table every operator has
    // already memorised.

    {
        // Events are the one kind whose NAME column is noise (a hash), so the
        // first column is the object the event is about.
        name: "events",
        title: "Events",
        kind: "Event",
        columns: ["TYPE", "REASON", "OBJECT", "MESSAGE", "COUNT", "LAST SEEN"],
        row: (o) => {
            const inv = o.involvedObject as { kind?: string; name?: string } | undefined;
            const last = (o.lastTimestamp as string) ?? (o.eventTime as string) ?? (o.firstTimestamp as string) ?? "";
            return [
                String(o.type ?? "Normal"),
                String(o.reason ?? ""),
                inv ? `${inv.kind ?? ""}/${inv.name ?? ""}` : "",
                String(o.message ?? "").replace(/\s+/g, " ").trim(),
                String(o.count ?? 1),
                ageFrom(last) || "-",
            ];
        },
    },
    {
        name: "replicasets",
        title: "ReplicaSets",
        kind: "ReplicaSet",
        columns: ["NAME", "DESIRED", "CURRENT", "READY", "AGE"],
        row: (o) => {
            const s = o.status as { replicas?: number; availableReplicas?: number; readyReplicas?: number };
            return [
                NAME(o),
                String((o.spec as { replicas?: number })?.replicas ?? 0),
                String(s?.replicas ?? 0),
                String(s?.readyReplicas ?? 0),
                age(o),
            ];
        },
    },
    {
        name: "endpoints",
        title: "Endpoints",
        kind: "Endpoints",
        columns: ["NAME", "ENDPOINTS", "AGE"],
        row: (o) => [NAME(o), endpointAddresses(o), age(o)],
    },
    {
        name: "endpointslices",
        title: "EndpointSlices",
        kind: "EndpointSlice",
        columns: ["NAME", "ADDRESSTYPE", "PORTS", "ENDPOINTS", "AGE"],
        row: (o) => {
            const ports = (o.ports as { port?: number }[] | undefined) ?? [];
            const eps = (o.endpoints as { addresses?: string[] }[] | undefined) ?? [];
            return [
                NAME(o),
                String(o.addressType ?? ""),
                ports.map((p) => String(p.port ?? "")).join(",") || "<unset>",
                eps.flatMap((e) => e.addresses ?? []).join(",") || "<unset>",
                age(o),
            ];
        },
    },
    {
        name: "networkpolicies",
        title: "NetworkPolicies",
        kind: "NetworkPolicy",
        columns: ["NAME", "POD-SELECTOR", "AGE"],
        row: (o) => [NAME(o), selectorText((o.spec as { podSelector?: unknown })?.podSelector), age(o)],
    },
    {
        name: "ingressclasses",
        title: "IngressClasses",
        kind: "IngressClass",
        clusterScoped: true,
        columns: ["NAME", "CONTROLLER", "AGE"],
        row: (o) => [NAME(o), String((o.spec as { controller?: string })?.controller ?? ""), age(o)],
    },
    {
        name: "persistentvolumes",
        title: "PersistentVolumes",
        kind: "PersistentVolume",
        clusterScoped: true,
        columns: ["NAME", "CAPACITY", "ACCESS", "RECLAIM", "STATUS", "CLAIM", "STORAGECLASS", "AGE"],
        row: (o) => {
            const spec = o.spec as {
                capacity?: { storage?: string };
                persistentVolumeReclaimPolicy?: string;
                storageClassName?: string;
                claimRef?: { namespace?: string; name?: string };
            };
            const claim = spec?.claimRef?.name ? `${spec.claimRef.namespace ?? ""}/${spec.claimRef.name}` : "";
            return [
                NAME(o),
                spec?.capacity?.storage ?? "",
                pvcAccessModes(o),
                spec?.persistentVolumeReclaimPolicy ?? "",
                String((o.status as { phase?: string })?.phase ?? ""),
                none(claim),
                none(spec?.storageClassName),
                age(o),
            ];
        },
    },
    {
        name: "storageclasses",
        title: "StorageClasses",
        kind: "StorageClass",
        clusterScoped: true,
        columns: ["NAME", "PROVISIONER", "RECLAIM", "BINDING", "DEFAULT", "AGE"],
        row: (o) => {
            const ann = (o.metadata as { annotations?: Record<string, string> })?.annotations ?? {};
            const isDefault =
                ann["storageclass.kubernetes.io/is-default-class"] === "true" ||
                ann["storageclass.beta.kubernetes.io/is-default-class"] === "true";
            return [
                NAME(o),
                String(o.provisioner ?? ""),
                String(o.reclaimPolicy ?? ""),
                String(o.volumeBindingMode ?? ""),
                isDefault ? "true" : "false",
                age(o),
            ];
        },
    },
    {
        name: "serviceaccounts",
        title: "ServiceAccounts",
        kind: "ServiceAccount",
        columns: ["NAME", "SECRETS", "AGE"],
        row: (o) => [NAME(o), String(((o.secrets as unknown[]) ?? []).length), age(o)],
    },
    {
        name: "roles",
        title: "Roles",
        kind: "Role",
        columns: ["NAME", "RULES", "AGE"],
        row: (o) => [NAME(o), String(((o.rules as unknown[]) ?? []).length), age(o)],
    },
    {
        name: "rolebindings",
        title: "RoleBindings",
        kind: "RoleBinding",
        columns: ["NAME", "ROLE", "SUBJECTS", "AGE"],
        row: (o) => [NAME(o), roleRefText(o), subjectsText(o), age(o)],
    },
    {
        name: "clusterroles",
        title: "ClusterRoles",
        kind: "ClusterRole",
        clusterScoped: true,
        columns: ["NAME", "RULES", "AGE"],
        row: (o) => [NAME(o), String(((o.rules as unknown[]) ?? []).length), age(o)],
    },
    {
        name: "clusterrolebindings",
        title: "ClusterRoleBindings",
        kind: "ClusterRoleBinding",
        clusterScoped: true,
        columns: ["NAME", "ROLE", "SUBJECTS", "AGE"],
        row: (o) => [NAME(o), roleRefText(o), subjectsText(o), age(o)],
    },
    {
        name: "horizontalpodautoscalers",
        title: "HPAs",
        kind: "HorizontalPodAutoscaler",
        columns: ["NAME", "REFERENCE", "TARGETS", "MIN", "MAX", "REPLICAS", "AGE"],
        row: (o) => {
            const spec = o.spec as {
                scaleTargetRef?: { kind?: string; name?: string };
                minReplicas?: number;
                maxReplicas?: number;
            };
            const status = o.status as { currentReplicas?: number };
            const ref = spec?.scaleTargetRef;
            return [
                NAME(o),
                ref ? `${(ref.kind ?? "").toLowerCase()}/${ref.name ?? ""}` : "",
                hpaTargets(o),
                String(spec?.minReplicas ?? 1),
                String(spec?.maxReplicas ?? ""),
                String(status?.currentReplicas ?? 0),
                age(o),
            ];
        },
    },
    {
        name: "poddisruptionbudgets",
        title: "PodDisruptionBudgets",
        kind: "PodDisruptionBudget",
        columns: ["NAME", "MIN AVAILABLE", "MAX UNAVAILABLE", "ALLOWED", "AGE"],
        row: (o) => {
            const spec = o.spec as { minAvailable?: unknown; maxUnavailable?: unknown };
            const status = o.status as { disruptionsAllowed?: number };
            return [
                NAME(o),
                spec?.minAvailable === undefined ? "N/A" : String(spec.minAvailable),
                spec?.maxUnavailable === undefined ? "N/A" : String(spec.maxUnavailable),
                String(status?.disruptionsAllowed ?? 0),
                age(o),
            ];
        },
    },
    {
        name: "resourcequotas",
        title: "ResourceQuotas",
        kind: "ResourceQuota",
        columns: ["NAME", "USED", "HARD", "AGE"],
        row: (o) => {
            const status = o.status as { used?: Record<string, string>; hard?: Record<string, string> };
            const count = (r?: Record<string, string>) => String(Object.keys(r ?? {}).length);
            return [NAME(o), `${count(status?.used)} keys`, `${count(status?.hard)} keys`, age(o)];
        },
    },
    {
        name: "limitranges",
        title: "LimitRanges",
        kind: "LimitRange",
        columns: ["NAME", "LIMITS", "AGE"],
        row: (o) => [NAME(o), String((((o.spec as { limits?: unknown[] })?.limits) ?? []).length), age(o)],
    },
    {
        name: "priorityclasses",
        title: "PriorityClasses",
        kind: "PriorityClass",
        clusterScoped: true,
        columns: ["NAME", "VALUE", "GLOBAL-DEFAULT", "PREEMPTION", "AGE"],
        row: (o) => [
            NAME(o),
            String(o.value ?? ""),
            String(o.globalDefault ?? false),
            String(o.preemptionPolicy ?? "PreemptLowerPriority"),
            age(o),
        ],
    },
    {
        name: "runtimeclasses",
        title: "RuntimeClasses",
        kind: "RuntimeClass",
        clusterScoped: true,
        columns: ["NAME", "HANDLER", "AGE"],
        row: (o) => [NAME(o), String(o.handler ?? ""), age(o)],
    },
    {
        name: "leases",
        title: "Leases",
        kind: "Lease",
        columns: ["NAME", "HOLDER", "AGE"],
        row: (o) => [NAME(o), none((o.spec as { holderIdentity?: string })?.holderIdentity), age(o)],
    },
    {
        name: "mutatingwebhookconfigurations",
        title: "Mutating Webhooks",
        kind: "MutatingWebhookConfiguration",
        clusterScoped: true,
        columns: ["NAME", "WEBHOOKS", "AGE"],
        row: (o) => [NAME(o), String(((o.webhooks as unknown[]) ?? []).length), age(o)],
    },
    {
        name: "validatingwebhookconfigurations",
        title: "Validating Webhooks",
        kind: "ValidatingWebhookConfiguration",
        clusterScoped: true,
        columns: ["NAME", "WEBHOOKS", "AGE"],
        row: (o) => [NAME(o), String(((o.webhooks as unknown[]) ?? []).length), age(o)],
    },
    {
        name: "customresourcedefinitions",
        title: "CRDs",
        kind: "CustomResourceDefinition",
        clusterScoped: true,
        columns: ["NAME", "GROUP", "VERSION", "SCOPE", "AGE"],
        row: (o) => {
            const spec = o.spec as {
                group?: string;
                scope?: string;
                versions?: { name?: string; served?: boolean; storage?: boolean }[];
            };
            const stored = spec?.versions?.find((v) => v.storage) ?? spec?.versions?.[0];
            return [NAME(o), spec?.group ?? "", stored?.name ?? "", spec?.scope ?? "", age(o)];
        },
    },
];

// ── column helpers for the kinds above ──────────────────────────────────────

function endpointAddresses(o: K8sObject): string {
    const subsets = (o.subsets as { addresses?: { ip?: string }[]; ports?: { port?: number }[] }[] | undefined) ?? [];
    const out: string[] = [];
    for (const s of subsets) {
        for (const a of s.addresses ?? []) {
            for (const p of s.ports ?? []) {
                out.push(`${a.ip}:${p.port}`);
            }
            if (!(s.ports ?? []).length && a.ip) out.push(a.ip);
        }
    }
    if (!out.length) return "<none>";
    // kubectl truncates the same way; a full endpoint list can be hundreds long.
    return out.length > 3 ? `${out.slice(0, 3).join(",")} +${out.length - 3} more` : out.join(",");
}

function selectorText(sel: unknown): string {
    const s = sel as { matchLabels?: Record<string, string>; matchExpressions?: unknown[] } | undefined;
    const labels = Object.entries(s?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
    if (s?.matchExpressions?.length) labels.push(`+${s.matchExpressions.length} expr`);
    return labels.length ? labels.join(",") : "<none>";
}

function roleRefText(o: K8sObject): string {
    const ref = o.roleRef as { kind?: string; name?: string } | undefined;
    return ref ? `${ref.kind ?? ""}/${ref.name ?? ""}` : "";
}

function subjectsText(o: K8sObject): string {
    const subjects = (o.subjects as { kind?: string; name?: string }[] | undefined) ?? [];
    if (!subjects.length) return "<none>";
    const first = subjects.map((s) => `${s.kind ?? ""}:${s.name ?? ""}`);
    return first.length > 2 ? `${first.slice(0, 2).join(", ")} +${first.length - 2}` : first.join(", ");
}

function hpaTargets(o: K8sObject): string {
    const status = o.status as { currentMetrics?: unknown[] } | undefined;
    const spec = o.spec as { metrics?: unknown[] } | undefined;
    const specs = (spec?.metrics ?? []) as {
        type?: string;
        resource?: { name?: string; target?: { averageUtilization?: number; averageValue?: string } };
    }[];
    const current = (status?.currentMetrics ?? []) as {
        resource?: { name?: string; current?: { averageUtilization?: number; averageValue?: string } };
    }[];
    if (!specs.length) return "<none>";
    return specs
        .map((m, i) => {
            const name = m.resource?.name ?? m.type ?? "";
            const want =
                m.resource?.target?.averageUtilization !== undefined
                    ? `${m.resource.target.averageUtilization}%`
                    : (m.resource?.target?.averageValue ?? "?");
            const cur = current[i]?.resource?.current;
            const have =
                cur?.averageUtilization !== undefined ? `${cur.averageUtilization}%` : (cur?.averageValue ?? "<unknown>");
            return `${name}: ${have}/${want}`;
        })
        .join(", ");
}

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

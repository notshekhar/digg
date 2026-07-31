/**
 * The rich detail page model — Aptakube's shape, built server-side.
 *
 * src/details.ts gives every kind a key/value summary and one table, which is
 * the right floor for four hundred kinds. The handful of kinds people actually
 * stare at all day (pods and the workloads that own them) deserve more than a
 * floor: the scheduling constraints that explain why a pod is Pending, the
 * per-container usage against its own requests and limits, the restart reason
 * that survived the last crash.
 *
 * Everything here is a pure function of objects the caller already fetched, so
 * it is testable without a cluster; src/web/detail.ts does the fetching.
 */

import type { K8sObject } from "./kubectl.ts";
import { age, podPhase } from "./format.ts";
import {
    type ContainerSpec,
    type Gauge,
    type MetricsView,
    addGauge,
    containerAllocation,
    containersOf,
    emptyGauge,
    initContainersOf,
    podAllocation,
    podSpecOf,
} from "./usage.ts";

export type Tone = "ok" | "warn" | "bad" | "neutral";

export interface Ref {
    kind: string;
    name: string;
    ns?: string;
    /** How the spec reaches it — `volume config`, `env DB_PASS`, `envFrom in api`. */
    via?: string;
}

export interface Chip {
    k?: string;
    v: string;
    tone?: Tone;
}

/** One label/value pair on a detail page. Exactly one carrier is filled in. */
export interface Fact {
    label: string;
    text?: string;
    tone?: Tone;
    ref?: Ref;
    /** Several links under one label — the ConfigMaps a spec mounts, say. */
    refs?: Ref[];
    chips?: Chip[];
    items?: string[];
    /** Span the full width of the group (labels, annotations, tolerations). */
    wide?: boolean;
}

export interface FactGroup {
    title?: string;
    facts: Fact[];
}

export interface ContainerView {
    name: string;
    image: string;
    init: boolean;
    state?: string;
    stateTone?: Tone;
    started?: boolean;
    ready?: boolean;
    restarts?: number;
    lastRestart?: string;
    restartReason?: string;
    cpu: Gauge;
    mem: Gauge;
    ports?: string;
    mounts?: string[];
}

export interface PodLine {
    name: string;
    ns?: string;
    ready: string;
    status: string;
    tone: Tone;
    restarts: number;
    lastRestart: string;
    lastRestartReason: string;
    node: string;
    cpu: Gauge;
    mem: Gauge;
}

export interface PodsBlock {
    desired: number;
    updated: number;
    ready: number;
    available: number;
    rows: PodLine[];
}

export interface DetailView {
    /** The identity card at the top: age, namespace, owner, labels, annotations. */
    header: FactGroup;
    groups: FactGroup[];
    containers: ContainerView[];
    /** Non-empty when container gauges are summed over more than one pod. */
    containersNote?: string;
    pods?: PodsBlock;
}

const dash = (v: string | undefined | null): string => (v && v.length > 0 ? v : "");

function chipsFrom(map: Record<string, string> | undefined, limit = 40): Chip[] {
    return Object.entries(map ?? {})
        .slice(0, limit)
        .map(([k, v]) => ({ k, v }));
}

function ownerRef(obj: K8sObject): Ref | undefined {
    const owner = (obj.metadata?.ownerReferences ?? []).find((o) => o.controller) ?? obj.metadata?.ownerReferences?.[0];
    if (!owner?.kind || !owner.name) return undefined;
    return { kind: `${owner.kind.toLowerCase()}s`, name: owner.name, ns: obj.metadata?.namespace };
}

function ownerLabel(obj: K8sObject): string {
    const owner = (obj.metadata?.ownerReferences ?? []).find((o) => o.controller) ?? obj.metadata?.ownerReferences?.[0];
    return owner?.kind && owner.name ? `${owner.kind}: ${owner.name}` : "";
}

/** The card every object shares: when, where, who made it, how it is labelled. */
function headerGroup(obj: K8sObject): FactGroup {
    const facts: Fact[] = [
        { label: "Age", text: age(obj) },
        { label: "Namespace", text: dash(obj.metadata?.namespace), ref: obj.metadata?.namespace ? { kind: "namespaces", name: obj.metadata.namespace } : undefined },
    ];
    const owner = ownerRef(obj);
    if (owner) {
        facts.push({ label: "Owner", text: ownerLabel(obj), ref: owner });
    }
    facts.push({ label: "Labels", chips: chipsFrom(obj.metadata?.labels), wide: true });
    facts.push({ label: "Annotations", chips: chipsFrom(annotationsForDisplay(obj)), wide: true });
    return { facts };
}

/**
 * Annotations minus the ones that are a serialised copy of the object.
 * `last-applied-configuration` is a whole manifest on one line; showing it in
 * full turns the identity card into a wall, so it is kept but truncated.
 */
function annotationsForDisplay(obj: K8sObject): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.metadata?.annotations ?? {})) {
        out[k] = v.length > 220 ? `${v.slice(0, 220)}…` : v;
    }
    return out;
}

function conditionChips(obj: K8sObject): Chip[] {
    const conditions =
        ((obj.status as { conditions?: { type?: string; status?: string; reason?: string; message?: string }[] })
            ?.conditions) ?? [];
    return conditions.map((c) => ({
        v: c.status === "True" ? (c.type ?? "") : `${c.type ?? ""}: ${c.reason ?? c.status ?? ""}`,
        tone: c.status === "True" ? ("ok" as Tone) : c.status === "False" ? ("bad" as Tone) : ("warn" as Tone),
    }));
}

export function tolerationLines(spec: Record<string, unknown>): string[] {
    const tolerations = (spec.tolerations ?? []) as {
        key?: string;
        operator?: string;
        value?: string;
        effect?: string;
        tolerationSeconds?: number;
    }[];
    return tolerations.map((t) => {
        const key = t.key ?? "*";
        const value = t.value ? `=${t.value}` : t.operator === "Exists" ? "" : "";
        const effect = t.effect ?? "all effects";
        const secs = t.tolerationSeconds !== undefined ? ` for ${t.tolerationSeconds}s` : "";
        return `${key}${value}: ${effect}${secs}`;
    });
}

export function nodeAffinityLines(spec: Record<string, unknown>): string[] {
    const affinity = (spec.affinity ?? {}) as {
        nodeAffinity?: {
            requiredDuringSchedulingIgnoredDuringExecution?: {
                nodeSelectorTerms?: { matchExpressions?: { key?: string; operator?: string; values?: string[] }[] }[];
            };
            preferredDuringSchedulingIgnoredDuringExecution?: {
                weight?: number;
                preference?: { matchExpressions?: { key?: string; operator?: string; values?: string[] }[] };
            }[];
        };
    };
    const na = affinity.nodeAffinity;
    if (!na) return [];
    const expr = (e: { key?: string; operator?: string; values?: string[] }) =>
        `${e.key ?? ""} ${e.operator ?? ""} ${(e.values ?? []).join(", ")}`.trim();
    const lines: string[] = [];
    for (const term of na.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? []) {
        for (const e of term.matchExpressions ?? []) lines.push(`required: ${expr(e)}`);
    }
    for (const pref of na.preferredDuringSchedulingIgnoredDuringExecution ?? []) {
        for (const e of pref.preference?.matchExpressions ?? []) {
            lines.push(`preferred (${pref.weight ?? 1}): ${expr(e)}`);
        }
    }
    return lines;
}

export function topologySpreadLines(spec: Record<string, unknown>): string[] {
    const constraints = (spec.topologySpreadConstraints ?? []) as {
        topologyKey?: string;
        maxSkew?: number;
        whenUnsatisfiable?: string;
    }[];
    return constraints.map(
        (c) => `${c.topologyKey ?? "?"} · maxSkew ${c.maxSkew ?? 1} · ${c.whenUnsatisfiable ?? "DoNotSchedule"}`,
    );
}

/** Scheduling constraints — the group that explains a Pending pod. */
function schedulingGroup(spec: Record<string, unknown>): FactGroup {
    const selector = (spec.nodeSelector ?? {}) as Record<string, string>;
    return {
        title: "Scheduling",
        facts: [
            { label: "Node Selector", chips: chipsFrom(selector) },
            { label: "Node Affinity", items: nodeAffinityLines(spec) },
            { label: "Topology Spread Constraints", items: topologySpreadLines(spec), wide: true },
            { label: "Tolerations", items: tolerationLines(spec), wide: true },
        ],
    };
}

/* -- references ------------------------------------------------------------ */

/**
 * The objects a pod spec names, turned into links.
 *
 * A workload's YAML is full of names that are really pointers — the ConfigMap a
 * volume mounts, the Secret one env var reads a single key out of, the claim a
 * StatefulSet writes to — and following one by hand means reading the manifest,
 * holding a name in your head, and going to find it in another list. They are
 * collected here instead so the page you are already on is the way to the
 * objects it depends on.
 *
 * Every site the API server itself resolves is walked, not just the obvious
 * two: `projected` sources hide ConfigMaps behind another level, `envFrom`
 * names one without ever naming a key, and the CSI and in-tree drivers keep
 * their credentials in a `secretRef` of their own. Missing one of those is
 * worse than showing none, because a group that looks complete and is not
 * teaches you to trust it.
 *
 * A name reached more than once appears once, carrying *where* it was reached
 * from: "which of these six ConfigMaps is this container actually reading, and
 * as a file or as an env var" is the question the group exists to answer, and a
 * bare list of names cannot.
 */

interface Volume {
    name?: string;
    configMap?: { name?: string };
    secret?: { secretName?: string };
    persistentVolumeClaim?: { claimName?: string };
    projected?: { sources?: { configMap?: { name?: string }; secret?: { name?: string } }[] };
    csi?: { nodePublishSecretRef?: { name?: string } };
    azureFile?: { secretName?: string };
}

/** In-tree drivers that hang a plain `secretRef` off themselves. */
const SECRET_REF_DRIVERS = ["cephfs", "iscsi", "rbd", "scaleIO", "storageos", "flexVolume"];

const CONFIGMAPS = "configmaps";
const SECRETS = "secrets";
const PVCS = "persistentvolumeclaims";

/** Three reasons is a hint; ten is the wall of YAML the group replaces. */
function summarizeVia(vias: string[]): string {
    return vias.length <= 3 ? vias.join(", ") : `${vias.slice(0, 2).join(", ")} +${vias.length - 2} more`;
}

class RefSet {
    private found = new Map<string, { kind: string; name: string; vias: string[] }>();

    add(kind: string, name: string | undefined, via: string) {
        if (!name) return;
        const key = `${kind}/${name}`;
        const at = this.found.get(key);
        if (!at) this.found.set(key, { kind, name, vias: [via] });
        else if (!at.vias.includes(via)) at.vias.push(via);
    }

    of(kind: string, ns?: string): Ref[] {
        return [...this.found.values()]
            .filter((r) => r.kind === kind)
            .map((r) => ({ kind: r.kind, name: r.name, ns, via: summarizeVia(r.vias) }));
    }
}

/** Walk a pod spec and collect every object it names. Pure. */
export function specRefs(spec: Record<string, unknown>): RefSet {
    const refs = new RefSet();

    for (const v of (spec.volumes ?? []) as Volume[]) {
        if (!v) continue;
        const where = `volume ${v.name ?? "?"}`;
        refs.add(CONFIGMAPS, v.configMap?.name, where);
        refs.add(SECRETS, v.secret?.secretName, where);
        refs.add(SECRETS, v.azureFile?.secretName, where);
        refs.add(SECRETS, v.csi?.nodePublishSecretRef?.name, where);
        refs.add(PVCS, v.persistentVolumeClaim?.claimName, where);
        for (const s of v.projected?.sources ?? []) {
            refs.add(CONFIGMAPS, s?.configMap?.name, `projected ${v.name ?? "?"}`);
            refs.add(SECRETS, s?.secret?.name, `projected ${v.name ?? "?"}`);
        }
        const driver = v as unknown as Record<string, { secretRef?: { name?: string } } | undefined>;
        for (const d of SECRET_REF_DRIVERS) refs.add(SECRETS, driver[d]?.secretRef?.name, where);
    }

    for (const p of (spec.imagePullSecrets ?? []) as { name?: string }[]) {
        refs.add(SECRETS, p?.name, "image pull");
    }

    const containers = [
        ...((spec.initContainers ?? []) as ContainerSpec[]),
        ...((spec.containers ?? []) as ContainerSpec[]),
    ];
    for (const c of containers) {
        if (!c) continue;
        const who = c.name ?? "?";
        for (const e of c.envFrom ?? []) {
            refs.add(CONFIGMAPS, e?.configMapRef?.name, `envFrom in ${who}`);
            refs.add(SECRETS, e?.secretRef?.name, `envFrom in ${who}`);
        }
        for (const e of c.env ?? []) {
            if (!e?.valueFrom) continue;
            refs.add(CONFIGMAPS, e.valueFrom.configMapKeyRef?.name, `env ${e.name ?? "?"}`);
            refs.add(SECRETS, e.valueFrom.secretKeyRef?.name, `env ${e.name ?? "?"}`);
        }
    }

    return refs;
}

const REF_LABELS: [string, string][] = [
    [CONFIGMAPS, "ConfigMaps"],
    [SECRETS, "Secrets"],
    [PVCS, "Volume Claims"],
];

/**
 * The References group, or null when the spec names nothing — three empty
 * dashes under a heading is worse than no heading.
 *
 * `identity` adds the service account and priority class, which a pod already
 * shows in its own summary and a workload has nowhere else to put.
 */
export function referencesGroup(spec: Record<string, unknown>, ns?: string, identity = false): FactGroup | null {
    const refs = specRefs(spec);
    const facts: Fact[] = [];
    for (const [kind, label] of REF_LABELS) {
        const list = refs.of(kind, ns);
        if (list.length) facts.push({ label, refs: list, wide: true });
    }
    if (identity) {
        const sa = (spec.serviceAccountName ?? spec.serviceAccount) as string | undefined;
        if (sa) facts.push({ label: "Service Account", text: sa, ref: { kind: "serviceaccounts", name: sa, ns } });
        const pc = spec.priorityClassName as string | undefined;
        if (pc) facts.push({ label: "Priority Class", text: pc, ref: { kind: "priorityclasses", name: pc } });
    }
    return facts.length ? { title: "References", facts } : null;
}

function portsText(c: ContainerSpec): string {
    return (c.ports ?? [])
        .filter((p) => p.containerPort)
        .map((p) => `${p.name ? `${p.name}:` : ""}${p.containerPort}/${p.protocol ?? "TCP"}`)
        .join(", ");
}

interface ContainerStatus {
    name?: string;
    ready?: boolean;
    started?: boolean;
    restartCount?: number;
    image?: string;
    state?: { running?: { startedAt?: string }; waiting?: { reason?: string }; terminated?: { reason?: string; exitCode?: number; finishedAt?: string } };
    lastState?: { terminated?: { reason?: string; exitCode?: number; finishedAt?: string } };
}

function stateOf(st: ContainerStatus | undefined): { state?: string; stateTone?: Tone } {
    if (!st?.state) return {};
    if (st.state.running) return { state: "Running", stateTone: "ok" };
    if (st.state.waiting) return { state: st.state.waiting.reason ?? "Waiting", stateTone: "warn" };
    if (st.state.terminated) {
        const t = st.state.terminated;
        const ok = t.reason === "Completed" || t.exitCode === 0;
        return { state: t.reason ?? "Terminated", stateTone: ok ? "neutral" : "bad" };
    }
    return {};
}

/** Container cards for a pod: spec plus live status plus this pod's metrics. */
export function podContainerViews(pod: K8sObject, metrics: MetricsView): ContainerView[] {
    const podName = pod.metadata?.name ?? "";
    const statuses = ((pod.status as { containerStatuses?: ContainerStatus[] })?.containerStatuses ?? []).concat(
        ((pod.status as { initContainerStatuses?: ContainerStatus[] })?.initContainerStatuses ?? []),
    );
    const build = (c: ContainerSpec, init: boolean): ContainerView => {
        const st = statuses.find((s) => s.name === c.name);
        const alloc = containerAllocation(c);
        const live = metrics.container(podName, c.name ?? "", pod.metadata?.namespace);
        const last = st?.lastState?.terminated;
        return {
            name: c.name ?? "",
            image: c.image ?? "",
            init,
            ...stateOf(st),
            started: st?.started,
            ready: st?.ready,
            restarts: st?.restartCount ?? 0,
            lastRestart: last?.finishedAt ?? "",
            restartReason: last?.reason ?? "",
            cpu: { ...alloc.cpu, used: live ? live.cpu : null },
            mem: { ...alloc.mem, used: live ? live.mem : null },
            ports: portsText(c),
            mounts: (c.volumeMounts ?? []).map((m) => `${m.mountPath ?? ""}${m.readOnly ? " (ro)" : ""}`),
        };
    };
    return [...initContainersOf(pod).map((c) => build(c, true)), ...containersOf(pod).map((c) => build(c, false))];
}

/**
 * Container cards for a workload: the template's containers, with usage summed
 * across every pod that template produced. One replica is the common case and
 * reads exactly like the pod's own card; ten replicas read as the workload's
 * total, which is the number you compare against the limits you set.
 */
export function workloadContainerViews(obj: K8sObject, pods: K8sObject[], metrics: MetricsView): ContainerView[] {
    const build = (c: ContainerSpec, init: boolean): ContainerView => {
        const per = containerAllocation(c);
        let cpu: Gauge = { used: null, requests: 0, limits: 0 };
        let mem: Gauge = { used: null, requests: 0, limits: 0 };
        for (const pod of pods) {
            const live = metrics.container(pod.metadata?.name ?? "", c.name ?? "", pod.metadata?.namespace);
            cpu = addGauge(cpu, { ...per.cpu, used: live ? live.cpu : null });
            mem = addGauge(mem, { ...per.mem, used: live ? live.mem : null });
        }
        if (pods.length === 0) {
            cpu = { ...per.cpu };
            mem = { ...per.mem };
        }
        return {
            name: c.name ?? "",
            image: c.image ?? "",
            init,
            cpu,
            mem,
            ports: portsText(c),
            mounts: (c.volumeMounts ?? []).map((m) => `${m.mountPath ?? ""}${m.readOnly ? " (ro)" : ""}`),
        };
    };
    return [...initContainersOf(obj).map((c) => build(c, true)), ...containersOf(obj).map((c) => build(c, false))];
}

function lastRestartOf(pod: K8sObject): { at: string; reason: string } {
    const statuses = (pod.status as { containerStatuses?: ContainerStatus[] })?.containerStatuses ?? [];
    let at = "";
    let reason = "";
    for (const s of statuses) {
        const t = s.lastState?.terminated;
        if (!t?.finishedAt) continue;
        if (!at || new Date(t.finishedAt).getTime() > new Date(at).getTime()) {
            at = t.finishedAt;
            reason = t.reason ?? "";
        }
    }
    return { at, reason };
}

export function podLine(pod: K8sObject, metrics: MetricsView): PodLine {
    const statuses = (pod.status as { containerStatuses?: ContainerStatus[] })?.containerStatuses ?? [];
    const ready = statuses.filter((s) => s.ready).length;
    const total = statuses.length || containersOf(pod).length;
    const status = podPhase(pod);
    const alloc = podAllocation(pod);
    const live = metrics.pod(pod.metadata?.name ?? "", pod.metadata?.namespace);
    const last = lastRestartOf(pod);
    return {
        name: pod.metadata?.name ?? "",
        ns: pod.metadata?.namespace,
        ready: `${ready}/${total}`,
        status,
        tone: status === "Running" || status === "Succeeded" ? "ok" : status === "Pending" ? "warn" : "bad",
        restarts: statuses.reduce((n, s) => n + (s.restartCount ?? 0), 0),
        lastRestart: last.at,
        lastRestartReason: last.reason,
        node: (pod.spec as { nodeName?: string })?.nodeName ?? "",
        cpu: { ...alloc.cpu, used: live ? live.cpu : null },
        mem: { ...alloc.mem, used: live ? live.mem : null },
    };
}

/** Rolling-update knobs and the conditions that say how the rollout is going. */
function strategyGroup(obj: K8sObject, kindName: string): FactGroup {
    const spec = obj.spec as {
        strategy?: { type?: string; rollingUpdate?: { maxSurge?: unknown; maxUnavailable?: unknown } };
        updateStrategy?: { type?: string; rollingUpdate?: { maxUnavailable?: unknown; partition?: number } };
        replicas?: number;
        revisionHistoryLimit?: number;
        minReadySeconds?: number;
    };
    const strategy = spec?.strategy ?? spec?.updateStrategy;
    const rolling = strategy?.rollingUpdate ?? {};
    const facts: Fact[] = [
        { label: "Strategy", text: strategy?.type ?? (kindName === "daemonsets" ? "RollingUpdate" : "—") },
    ];
    if ("maxSurge" in rolling && rolling.maxSurge !== undefined) {
        facts.push({ label: "Max Surge", text: String(rolling.maxSurge) });
    }
    if ("maxUnavailable" in rolling && rolling.maxUnavailable !== undefined) {
        facts.push({ label: "Max Unavailable", text: String(rolling.maxUnavailable) });
    }
    if ("partition" in rolling && rolling.partition !== undefined) {
        facts.push({ label: "Partition", text: String(rolling.partition) });
    }
    if (spec?.minReadySeconds) facts.push({ label: "Min Ready", text: `${spec.minReadySeconds}s` });
    facts.push({ label: "Conditions", chips: conditionChips(obj), wide: true });
    return { title: "Rollout", facts };
}

function selectorChips(obj: K8sObject): Chip[] {
    const sel = (obj.spec as { selector?: { matchLabels?: Record<string, string> } })?.selector;
    return chipsFrom(sel?.matchLabels);
}

function workloadCounts(obj: K8sObject): PodsBlock {
    const s = (obj.status ?? {}) as {
        replicas?: number;
        readyReplicas?: number;
        updatedReplicas?: number;
        availableReplicas?: number;
        currentReplicas?: number;
        numberReady?: number;
        desiredNumberScheduled?: number;
        updatedNumberScheduled?: number;
        numberAvailable?: number;
        succeeded?: number;
        active?: number;
    };
    const specReplicas = (obj.spec as { replicas?: number })?.replicas;
    const desired = s.desiredNumberScheduled ?? specReplicas ?? s.replicas ?? 0;
    return {
        desired,
        updated: s.updatedNumberScheduled ?? s.updatedReplicas ?? 0,
        ready: s.numberReady ?? s.readyReplicas ?? 0,
        available: s.numberAvailable ?? s.availableReplicas ?? 0,
        rows: [],
    };
}

/** Full page model for a workload (Deployment, StatefulSet, DaemonSet, …). */
export function workloadView(
    obj: K8sObject,
    kindName: string,
    pods: K8sObject[],
    metrics: MetricsView,
): DetailView {
    const spec = podSpecOf(obj);
    const counts = workloadCounts(obj);
    counts.rows = pods.map((p) => podLine(p, metrics));
    const header = headerGroup(obj);
    header.facts.splice(2, 0, { label: "Selector", chips: selectorChips(obj) });
    // References sit above Scheduling: what a workload mounts is asked about far
    // more often than the affinity rules that placed it.
    const refs = referencesGroup(spec, obj.metadata?.namespace, true);
    return {
        header,
        groups: [strategyGroup(obj, kindName), ...(refs ? [refs] : []), schedulingGroup(spec)],
        containers: workloadContainerViews(obj, pods, metrics),
        containersNote: pods.length > 1 ? `summed over ${pods.length} pods` : undefined,
        pods: counts,
    };
}

/** Full page model for a Pod. */
export function podView(pod: K8sObject, metrics: MetricsView): DetailView {
    const spec = podSpecOf(pod);
    const status = pod.status as { phase?: string; podIP?: string; qosClass?: string; startTime?: string; hostIP?: string };
    const phase = podPhase(pod);
    const node = (spec.nodeName as string | undefined) ?? "";
    const sa = (spec.serviceAccountName as string | undefined) ?? (spec.serviceAccount as string | undefined) ?? "";
    const ns = pod.metadata?.namespace;
    const scheduling = schedulingGroup(spec);
    // identity=false: the summary above already links the service account.
    const refs = referencesGroup(spec, ns);
    return {
        header: headerGroup(pod),
        groups: [
            {
                facts: [
                    { label: "Phase", text: phase, tone: phase === "Running" || phase === "Succeeded" ? "ok" : phase === "Pending" ? "warn" : "bad" },
                    { label: "Conditions", chips: conditionChips(pod), wide: true },
                    { label: "Start Time", text: status?.startTime ? age({ metadata: { creationTimestamp: status.startTime } } as K8sObject) : "" },
                    { label: "Pod IP", text: dash(status?.podIP) },
                    { label: "Node", text: node, ref: node ? { kind: "nodes", name: node } : undefined },
                    { label: "Host IP", text: dash(status?.hostIP) },
                    { label: "Service Account", text: dash(sa), ref: sa ? { kind: "serviceaccounts", name: sa, ns } : undefined },
                    { label: "Quality of Service", text: dash(status?.qosClass) },
                    {
                        label: "Priority Class",
                        text: dash(spec.priorityClassName as string | undefined),
                        ref: spec.priorityClassName ? { kind: "priorityclasses", name: spec.priorityClassName as string } : undefined,
                    },
                    { label: "Restart Policy", text: dash(spec.restartPolicy as string | undefined) },
                ],
            },
            ...(refs ? [refs] : []),
            scheduling,
        ],
        containers: podContainerViews(pod, metrics),
    };
}

/** Full page model for a Node: capacity, allocation and its resident pods. */
export function nodeView(node: K8sObject, pods: K8sObject[], metrics: MetricsView): DetailView {
    const status = node.status as {
        nodeInfo?: {
            kubeletVersion?: string;
            osImage?: string;
            kernelVersion?: string;
            containerRuntimeVersion?: string;
            architecture?: string;
            operatingSystem?: string;
        };
        capacity?: Record<string, string>;
        allocatable?: Record<string, string>;
        addresses?: { type?: string; address?: string }[];
    };
    const info = status?.nodeInfo;
    const addr = (t: string) => (status?.addresses ?? []).find((a) => a.type === t)?.address ?? "";
    const unschedulable = Boolean((node.spec as { unschedulable?: boolean })?.unschedulable);
    const header = headerGroup(node);

    let cpu = emptyGauge();
    let mem = emptyGauge();
    for (const pod of pods) {
        const alloc = podAllocation(pod);
        const live = metrics.pod(pod.metadata?.name ?? "", pod.metadata?.namespace);
        cpu = addGauge(cpu, { ...alloc.cpu, used: live ? live.cpu : null });
        mem = addGauge(mem, { ...alloc.mem, used: live ? live.mem : null });
    }

    return {
        header,
        groups: [
            {
                facts: [
                    { label: "Schedulable", text: unschedulable ? "Cordoned" : "Yes", tone: unschedulable ? "warn" : "ok" },
                    { label: "Conditions", chips: conditionChips(node), wide: true },
                    { label: "kubelet", text: dash(info?.kubeletVersion) },
                    { label: "OS Image", text: dash(info?.osImage) },
                    { label: "Kernel", text: dash(info?.kernelVersion) },
                    { label: "Container Runtime", text: dash(info?.containerRuntimeVersion) },
                    { label: "Architecture", text: dash(info?.architecture) },
                    { label: "Internal IP", text: dash(addr("InternalIP")) },
                    { label: "External IP", text: dash(addr("ExternalIP")) },
                    { label: "Hostname", text: dash(addr("Hostname")) },
                ],
            },
            {
                title: "Capacity",
                facts: [
                    { label: "CPU", text: `${status?.allocatable?.cpu ?? "?"} allocatable of ${status?.capacity?.cpu ?? "?"}` },
                    { label: "Memory", text: `${status?.allocatable?.memory ?? "?"} allocatable of ${status?.capacity?.memory ?? "?"}` },
                    { label: "Pods", text: `${pods.length} of ${status?.allocatable?.pods ?? status?.capacity?.pods ?? "?"}` },
                    { label: "Requested", text: `${cpu.requests.toFixed(2)} cores · ${Math.round(mem.requests / 1024 / 1024)}Mi` },
                ],
            },
        ],
        containers: [],
        pods: { desired: pods.length, updated: 0, ready: pods.filter((p) => podPhase(p) === "Running").length, available: 0, rows: pods.map((p) => podLine(p, metrics)) },
    };
}

/** Kinds that get the rich page. Everything else keeps summary + section. */
export const RICH_KINDS = new Set([
    "pods",
    "deployments",
    "statefulsets",
    "daemonsets",
    "replicasets",
    "jobs",
    "nodes",
]);

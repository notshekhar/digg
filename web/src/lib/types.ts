/** Shapes returned by src/web/api.ts. Kept hand-written and small on purpose. */

export interface KindMeta {
    name: string;
    title: string;
    kind: string;
    clusterScoped: boolean;
    generic: boolean;
    columns: string[];
}

export interface CatalogKind extends KindMeta {
    apiVersion: string;
    shortNames: string[];
}

export interface CatalogGroup {
    id: string;
    title: string;
    kinds: CatalogKind[];
}

export interface Boot {
    contexts: string[];
    context: string;
    namespaces: string[];
    /** Legacy single selection; `selectedNamespaces` is the real answer. */
    namespace: string | null;
    /** What was selected here last time, minus anything since deleted. */
    selectedNamespaces: string[];
    kind: string;
    kinds: KindMeta[];
    catalog: CatalogGroup[];
    curated: string[];
    prefs: { theme: "light" | "dark" };
    version: string;
    cluster: { client: string; server: string; platform: string } | null;
    canExec: boolean;
    forwards: Forward[];
}

/** A usage bar for one cell: fill percentage, plus an optional request mark. */
export interface Meter {
    pct: number | null;
    mark: number | null;
}

export interface Route {
    url: string;
    host: string;
    path: string;
    service: string;
    port: string;
}

export interface Row {
    cells: string[];
    name: string;
    ns?: string;
    tones: Record<number, Tone>;
    ts: number;
    labels?: Record<string, string>;
    /** Bars keyed by column index (CPU/memory usage columns). */
    meters?: Record<number, Meter>;
    /** Ingress routes, rendered as links in the RULES column. */
    rules?: Route[];
    /** Row height in text lines; the grid lays out variable-height rows. */
    lines?: number;
}

export type Tone = "ok" | "warn" | "bad" | "neutral";

export interface ListResult {
    kind: KindMeta;
    columns: string[];
    rows: Row[];
    count: number;
}

export interface Section {
    title: string;
    columns: string[];
    rows: string[][];
    tones?: (number | null)[];
    drill?: { kind: string; name: string; ns?: string }[];
    dataKeys?: { keys: string[]; decode: boolean };
}

export interface K8sEvent {
    type: string;
    reason: string;
    message: string;
    count: number;
    source: string;
    lastSeen: string;
}

export interface ClusterEvent extends K8sEvent {
    object: string;
    namespace: string;
}

export interface Detail {
    kind: KindMeta;
    name: string;
    ns?: string;
    summary: [string, string][];
    section: Section | null;
    /** The rich page model — pods, workloads, services, nodes. Null otherwise. */
    view: DetailView | null;
    /**
     * What this object is connected to, resolved against the cluster: the
     * Deployment behind a Service, the workloads mounting a ConfigMap, the
     * Ingress routing to it. Present for every kind, absent when nothing links.
     */
    links?: FactGroup[];
    events: K8sEvent[];
    canLogs: boolean;
}

// ── rich detail view (src/detail-view.ts) ──────────────────────────────────

export interface Chip {
    k?: string;
    v: string;
    tone?: Tone;
}

export interface Fact {
    label: string;
    text?: string;
    tone?: Tone;
    ref?: ResourceRef;
    /** Several links under one label — the ConfigMaps a spec mounts, say. */
    refs?: ResourceRef[];
    chips?: Chip[];
    items?: string[];
    wide?: boolean;
}

export interface FactGroup {
    title?: string;
    facts: Fact[];
}

/** Live usage against what the container reserved and what it may take. */
export interface Gauge {
    used: number | null;
    requests: number;
    limits: number;
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

export interface DetailView {
    header: FactGroup;
    groups: FactGroup[];
    containers: ContainerView[];
    containersNote?: string;
    pods?: {
        desired: number;
        updated: number;
        ready: number;
        available: number;
        rows: PodLine[];
        /** Heading override — a Service's pods are not a workload's pods. */
        title?: string;
        /** Counts in the embedder's own words, replacing the rollout four. */
        counts?: Chip[];
    };
}

export interface RevisionRow {
    revision: number;
    name: string;
    kind: string;
    ns?: string;
    replicas: number;
    ready: number;
    images: string;
    age: string;
    ts: number;
    current: boolean;
}

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

export interface Forward {
    id: string;
    context: string;
    kind: string;
    name: string;
    namespace: string;
    remotePort: number;
    localPort: number | null;
    status: "starting" | "active" | "failed" | "stopped";
    error: string;
    url: string | null;
    startedAt: number;
}

export interface ActionResult {
    ok: boolean;
    message: string;
    results?: { target: string; ok: boolean; message: string }[];
}

export interface ResourceRef {
    kind: string;
    name: string;
    ns?: string;
    /** How the spec reaches it — `volume config`, `env DB_PASS`. Display only. */
    via?: string;
}

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
    namespace: string | null;
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

export interface Row {
    cells: string[];
    name: string;
    ns?: string;
    tones: Record<number, Tone>;
    ts: number;
    labels?: Record<string, string>;
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
    events: K8sEvent[];
    canLogs: boolean;
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
}

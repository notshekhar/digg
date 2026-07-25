/**
 * The live layer: watches on the server, deltas on the wire.
 *
 * Objects are pushed (a kubectl watch per kind), metrics are pulled on a timer.
 * That split is not a compromise, it is the shape of Kubernetes: metrics.k8s.io
 * implements only get and list — `watch is not supported on resources of kind
 * pods.metrics.k8s.io` — and metrics-server samples on its own schedule
 * (`--metric-resolution`, 60s by default), so polling faster than that returns
 * the same numbers with more processes. Lens takes the same split; its charts
 * are Prometheus `query_range` polls at a 60s step.
 *
 * Three properties this file is built around:
 *
 *   ONE WATCH PER (context, kind, namespace), refcounted across subscriptions
 *   and browser tabs, kept alive briefly after the last unsubscribe so flicking
 *   between kinds does not churn processes.
 *
 *   DELTAS THAT ARE ACTUALLY DELTAS. A row is only sent when its rendered form
 *   changed, and events are coalesced into frames, so a rollout that emits
 *   hundreds of events a second still renders at a readable rate.
 *
 *   NO SILENT DEGRADATION. If a kind cannot be watched (aggregated API, RBAC),
 *   the client is told so it can fall back to polling — rather than showing a
 *   table that quietly never updates.
 */

import type { K8sObject } from "../kubectl.ts";
import { type KindDef, findKind, genericKind } from "../format.ts";
import { apiResources } from "../discovery.ts";
import { ResourceWatch, objectKey } from "../watch.ts";
import { type UsageColumns, usageColumns } from "./gauges.ts";
import { type Row, buildRow, columnsFor, rowFingerprint } from "./rows.ts";
import { buildDetailPayload } from "./detail.ts";

/** How often usage bars are refreshed. metrics-server samples every 60s. */
const METRICS_MS = 15_000;
/** Event coalescing window. */
const FRAME_MS = 100;
/** Grace period before a watch with no subscribers is killed. */
const IDLE_MS = 10_000;
/** Floor between two detail rebuilds, so a rollout cannot stampede kubectl. */
const DETAIL_THROTTLE_MS = 700;

type StoreListener = (event: StoreEvent) => void;

type StoreEvent =
    | { type: "snapshot"; objects: K8sObject[] }
    | { type: "upsert"; object: K8sObject }
    | { type: "remove"; key: string; object: K8sObject }
    | { type: "error"; message: string; permanent: boolean };

class KindStore {
    readonly objects = new Map<string, K8sObject>();
    private readonly listeners = new Set<StoreListener>();
    private readonly watch: ResourceWatch;
    private idle: ReturnType<typeof setTimeout> | null = null;
    private started = false;
    /** Replayed to whoever subscribes next, so a late tab is not left blank. */
    private lastError: { message: string; permanent: boolean } | null = null;
    ready = false;

    constructor(
        readonly key: string,
        context: string,
        kind: KindDef,
        namespace: string | undefined,
        private readonly onIdleClose: () => void,
    ) {
        this.watch = new ResourceWatch(
            { context, kind: kind.name, namespace, clusterScoped: kind.clusterScoped },
            {
                onSnapshot: (objects) => {
                    this.objects.clear();
                    for (const obj of objects) this.objects.set(objectKey(obj), obj);
                    this.ready = true;
                    this.lastError = null;
                    this.emit({ type: "snapshot", objects });
                },
                onEvent: (event) => {
                    const key = objectKey(event.object);
                    if (event.type === "DELETED") {
                        this.objects.delete(key);
                        this.emit({ type: "remove", key, object: event.object });
                    } else {
                        this.objects.set(key, event.object);
                        this.emit({ type: "upsert", object: event.object });
                    }
                },
                onError: (message, permanent) => {
                    this.lastError = { message, permanent };
                    if (permanent) this.ready = false;
                    this.emit({ type: "error", message, permanent });
                },
            },
        );
    }

    subscribe(listener: StoreListener): () => void {
        this.listeners.add(listener);
        if (this.idle) {
            clearTimeout(this.idle);
            this.idle = null;
        }
        if (!this.started) {
            this.started = true;
            this.watch.start();
            // An empty collection never produces a first event, so nudge the
            // watcher to emit its (empty) snapshot instead of hanging on
            // "loading" forever.
            setTimeout(() => this.watch.settleSoon(), 400);
        } else if (this.ready) {
            // A newcomer gets the current state immediately rather than waiting
            // for the next change, which on a quiet cluster could be hours.
            listener({ type: "snapshot", objects: [...this.objects.values()] });
        } else if (this.lastError) {
            listener({ type: "error", ...this.lastError });
        }
        return () => this.unsubscribe(listener);
    }

    private unsubscribe(listener: StoreListener): void {
        this.listeners.delete(listener);
        if (this.listeners.size > 0 || this.idle) return;
        this.idle = setTimeout(() => {
            this.idle = null;
            if (this.listeners.size === 0) {
                this.watch.stop();
                this.onIdleClose();
            }
        }, IDLE_MS);
    }

    private emit(event: StoreEvent): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch {
                /* one bad subscriber must not stop the others */
            }
        }
    }

    destroy(): void {
        if (this.idle) clearTimeout(this.idle);
        this.watch.stop();
        this.listeners.clear();
    }
}

/** Process-wide registry: every session shares these watches. */
class LiveRegistry {
    private readonly stores = new Map<string, KindStore>();

    acquire(context: string, kind: KindDef, namespace: string | undefined, listener: StoreListener): () => void {
        const ns = kind.clusterScoped ? "" : (namespace ?? "*");
        const key = `${context}|${kind.name}|${ns}`;
        let store = this.stores.get(key);
        if (!store) {
            store = new KindStore(key, context, kind, kind.clusterScoped ? undefined : namespace, () =>
                this.stores.delete(key),
            );
            this.stores.set(key, store);
        }
        return store.subscribe(listener);
    }

    /**
     * The store is the single copy of the cluster in memory: sessions hold
     * rendered rows, never their own object maps, so ten tabs on the same kind
     * cost one map and one process.
     */
    objects(context: string, kind: KindDef, namespace: string | undefined): K8sObject[] {
        const ns = kind.clusterScoped ? "" : (namespace ?? "*");
        const store = this.stores.get(`${context}|${kind.name}|${ns}`);
        return store ? [...store.objects.values()] : [];
    }

    shutdown(): void {
        for (const store of this.stores.values()) store.destroy();
        this.stores.clear();
    }

    get size(): number {
        return this.stores.size;
    }
}

export const registry = new LiveRegistry();

/** Kill every kubectl watch when digg goes away, rather than orphaning them. */
export function installShutdownHook(): void {
    let done = false;
    const bye = () => {
        if (done) return;
        done = true;
        registry.shutdown();
    };
    process.on("exit", bye);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, () => {
            bye();
            process.exit(0);
        });
    }
}

// ── the wire ───────────────────────────────────────────────────────────────

export interface ClientMessage {
    t: "sub" | "unsub" | "ping";
    id?: string;
    sub?: {
        type: "list" | "detail";
        context?: string;
        kind?: string;
        ns?: string | null;
        name?: string;
    };
}

type Send = (message: string) => void;

interface ListSub {
    type: "list";
    id: string;
    kind: KindDef;
    context: string;
    namespace: string | undefined;
    usage: UsageColumns | null;
    columns: string[];
    insertAt: number;
    prints: Map<string, string>;
    dirty: Set<string>;
    removed: Set<string>;
    frame: ReturnType<typeof setTimeout> | null;
    metrics: ReturnType<typeof setInterval> | null;
    release: (() => void) | null;
    /** Guards against two metric passes overlapping on a slow cluster. */
    refreshing: boolean;
}

interface DetailSub {
    type: "detail";
    id: string;
    kind: KindDef;
    context: string;
    namespace: string | undefined;
    name: string;
    releases: (() => void)[];
    timer: ReturnType<typeof setTimeout> | null;
    metrics: ReturnType<typeof setInterval> | null;
    lastRun: number;
    running: boolean;
    /** Last payload sent, so an identical rebuild is not pushed twice. */
    lastPrint: string;
    /** A change that arrived while a rebuild was in flight. */
    again: boolean;
}

/**
 * One WebSocket's worth of subscriptions. The socket is the lifetime: closing
 * it releases every watch it held, so a closed tab cannot leak a kubectl.
 */
export class LiveSession {
    private readonly subs = new Map<string, ListSub | DetailSub>();
    private closed = false;

    constructor(private readonly send: Send) {}

    async handle(raw: string): Promise<void> {
        if (this.closed) return;
        let msg: ClientMessage;
        try {
            msg = JSON.parse(raw) as ClientMessage;
        } catch {
            return;
        }
        if (msg.t === "ping") {
            this.push({ t: "pong" });
            return;
        }
        if (msg.t === "unsub" && msg.id) {
            this.drop(msg.id);
            return;
        }
        if (msg.t !== "sub" || !msg.id || !msg.sub) return;

        // A re-subscribe on the same id replaces the old one; the client does
        // this when the namespace or kind changes.
        this.drop(msg.id);
        try {
            if (msg.sub.type === "detail") await this.subscribeDetail(msg.id, msg.sub);
            else await this.subscribeList(msg.id, msg.sub);
        } catch (err) {
            this.push({
                t: "error",
                id: msg.id,
                message: err instanceof Error ? err.message : String(err),
                fatal: true,
            });
        }
    }

    close(): void {
        this.closed = true;
        for (const id of [...this.subs.keys()]) this.drop(id);
    }

    private push(payload: Record<string, unknown>): void {
        if (this.closed) return;
        try {
            this.send(JSON.stringify(payload));
        } catch {
            /* the socket went away mid-write; close() will clean up */
        }
    }

    private drop(id: string): void {
        const sub = this.subs.get(id);
        if (!sub) return;
        this.subs.delete(id);
        if (sub.type === "list") {
            sub.release?.();
            if (sub.frame) clearTimeout(sub.frame);
            if (sub.metrics) clearInterval(sub.metrics);
        } else {
            for (const release of sub.releases) release();
            if (sub.timer) clearTimeout(sub.timer);
            if (sub.metrics) clearInterval(sub.metrics);
        }
    }

    private async resolve(context: string, kindName: string): Promise<KindDef> {
        const curated = findKind(kindName);
        if (curated) return curated;
        const discovered = await apiResources(context).catch(() => []);
        const found = discovered.find((r) => r.name === kindName || r.kind === kindName);
        if (!found) throw new Error(`unknown kind: ${kindName}`);
        return genericKind(found);
    }

    // ── list subscriptions ─────────────────────────────────────────────────

    private async subscribeList(id: string, req: NonNullable<ClientMessage["sub"]>): Promise<void> {
        const context = (req.context ?? "").trim();
        if (!context) throw new Error("context required");
        const kind = await this.resolve(context, (req.kind ?? "pods").trim());
        const nsRaw = req.ns ?? null;
        const namespace = nsRaw === null || nsRaw === "" || nsRaw === "*" ? undefined : nsRaw;

        const sub: ListSub = {
            type: "list",
            id,
            kind,
            context,
            namespace,
            usage: null,
            columns: columnsFor(kind, null).columns,
            insertAt: columnsFor(kind, null).insertAt,
            prints: new Map(),
            dirty: new Set(),
            removed: new Set(),
            frame: null,
            metrics: null,
            release: null,
            refreshing: false,
        };
        this.subs.set(id, sub);

        sub.release = registry.acquire(context, kind, namespace, (event) => {
            if (this.subs.get(id) !== sub) return;
            switch (event.type) {
                case "snapshot":
                    void this.sendSnapshot(sub, event.objects);
                    break;
                case "upsert":
                    sub.dirty.add(objectKey(event.object));
                    sub.removed.delete(objectKey(event.object));
                    this.scheduleFrame(sub);
                    break;
                case "remove":
                    sub.removed.add(event.key);
                    sub.dirty.delete(event.key);
                    this.scheduleFrame(sub);
                    break;
                case "error":
                    this.push({ t: "error", id, message: event.message, fatal: event.permanent });
                    break;
            }
        });

        sub.metrics = setInterval(() => void this.refreshUsage(sub), METRICS_MS);
    }

    /** Recompute rows from scratch (new objects, or new metrics). */
    private async sendSnapshot(sub: ListSub, objects: K8sObject[]): Promise<void> {
        await this.refreshUsage(sub, objects, true);
    }

    private async refreshUsage(sub: ListSub, objectsIn?: K8sObject[], full = false): Promise<void> {
        if (this.subs.get(sub.id) !== sub || sub.refreshing) return;
        sub.refreshing = true;
        try {
            const objects = objectsIn ?? this.objectsOf(sub);
            sub.usage = await usageColumns(sub.kind.name, objects, sub.context, sub.namespace ?? null);
            const { columns, insertAt } = columnsFor(sub.kind, sub.usage);
            const columnsChanged = columns.join(" ") !== sub.columns.join(" ");
            sub.columns = columns;
            sub.insertAt = insertAt;

            const rows = objects.map((obj) => buildRow(obj, sub.kind, sub.usage, insertAt));
            if (full || columnsChanged) {
                sub.prints = new Map(rows.map((r) => [`${r.ns ?? ""}/${r.name}`, rowFingerprint(r)]));
                sub.dirty.clear();
                sub.removed.clear();
                this.push({ t: "snapshot", id: sub.id, columns, rows, kind: kindMetaOf(sub.kind) });
                return;
            }

            // A metrics pass touches every row, but usually only a few actually
            // changed — send those, and let the rest stay put.
            const upsert: Row[] = [];
            const seen = new Set<string>();
            for (const row of rows) {
                const key = `${row.ns ?? ""}/${row.name}`;
                seen.add(key);
                const print = rowFingerprint(row);
                if (sub.prints.get(key) !== print) {
                    sub.prints.set(key, print);
                    upsert.push(row);
                }
            }
            const remove = [...sub.prints.keys()].filter((k) => !seen.has(k));
            for (const key of remove) sub.prints.delete(key);
            if (upsert.length || remove.length) {
                this.push({ t: "delta", id: sub.id, upsert, remove });
            }
        } catch {
            /* a failed metrics pass must not disturb a working table */
        } finally {
            sub.refreshing = false;
        }
    }

    private objectsOf(sub: ListSub): K8sObject[] {
        return registry.objects(sub.context, sub.kind, sub.namespace);
    }

    private scheduleFrame(sub: ListSub): void {
        if (sub.frame) return;
        sub.frame = setTimeout(() => {
            sub.frame = null;
            this.flush(sub);
        }, FRAME_MS);
    }

    private flush(sub: ListSub): void {
        if (this.subs.get(sub.id) !== sub) return;
        const objects = new Map<string, K8sObject>();
        for (const obj of registry.objects(sub.context, sub.kind, sub.namespace)) {
            objects.set(objectKey(obj), obj);
        }

        const upsert: Row[] = [];
        for (const key of sub.dirty) {
            const obj = objects.get(key);
            if (!obj) continue; // added and deleted inside one frame
            const row = buildRow(obj, sub.kind, sub.usage, sub.insertAt);
            const print = rowFingerprint(row);
            if (sub.prints.get(key) === print) continue;
            sub.prints.set(key, print);
            upsert.push(row);
        }
        const remove = [...sub.removed].filter((key) => {
            sub.prints.delete(key);
            return true;
        });
        sub.dirty.clear();
        sub.removed.clear();
        if (upsert.length || remove.length) {
            this.push({ t: "delta", id: sub.id, upsert, remove });
        }
    }

    // ── detail subscriptions ───────────────────────────────────────────────

    private async subscribeDetail(id: string, req: NonNullable<ClientMessage["sub"]>): Promise<void> {
        const context = (req.context ?? "").trim();
        const name = (req.name ?? "").trim();
        if (!context || !name) throw new Error("context and name required");
        const kind = await this.resolve(context, (req.kind ?? "").trim());
        const nsRaw = req.ns ?? null;
        const namespace = nsRaw === null || nsRaw === "" || nsRaw === "*" ? undefined : nsRaw;

        const sub: DetailSub = {
            type: "detail",
            id,
            kind,
            context,
            namespace,
            name,
            releases: [],
            timer: null,
            metrics: null,
            lastRun: 0,
            running: false,
            lastPrint: "",
            again: false,
        };
        this.subs.set(id, sub);

        const key = `${namespace ?? ""}/${name}`;
        sub.releases.push(
            registry.acquire(context, kind, namespace, (event) => {
                if (this.subs.get(id) !== sub) return;
                if (event.type === "error") {
                    this.push({ t: "error", id, message: event.message, fatal: event.permanent });
                    return;
                }
                if (event.type === "snapshot") {
                    this.scheduleDetail(sub);
                    return;
                }
                const changed = event.type === "remove" ? event.key : objectKey(event.object);
                if (changed === key) this.scheduleDetail(sub);
            }),
        );

        // A workload's page is mostly about its pods, so their events have to
        // wake it too — a pod going CrashLoopBackOff never touches the
        // Deployment object at all.
        const podsKind = findKind("pods")!;
        if (WATCH_PODS_FOR.has(kind.name)) {
            sub.releases.push(
                registry.acquire(context, podsKind, kind.name === "nodes" ? undefined : namespace, (event) => {
                    if (this.subs.get(id) !== sub) return;
                    if (event.type === "upsert" || event.type === "remove") this.scheduleDetail(sub);
                }),
            );
        }

        sub.metrics = setInterval(() => this.scheduleDetail(sub, true), METRICS_MS);
        this.scheduleDetail(sub, true);
    }

    /** Coalesce rebuilds and never run two at once. */
    private scheduleDetail(sub: DetailSub, immediate = false): void {
        if (this.subs.get(sub.id) !== sub) return;
        if (sub.running) {
            sub.again = true;
            return;
        }
        if (sub.timer) return;
        const wait = immediate ? 0 : Math.max(0, DETAIL_THROTTLE_MS - (Date.now() - sub.lastRun));
        sub.timer = setTimeout(() => {
            sub.timer = null;
            void this.rebuildDetail(sub);
        }, wait);
    }

    private async rebuildDetail(sub: DetailSub): Promise<void> {
        if (this.subs.get(sub.id) !== sub) return;
        sub.running = true;
        sub.lastRun = Date.now();
        try {
            const payload = await buildDetailPayload(sub.kind, {
                context: sub.context,
                kind: sub.kind.name,
                name: sub.name,
                namespace: sub.namespace,
            });
            if (this.subs.get(sub.id) !== sub) return;
            // Coalescing means a burst of events can produce two rebuilds that
            // land on the same answer (the second event only bumped a
            // resourceVersion). Sending it again would re-render the page for
            // nothing, so identical payloads are dropped.
            const print = JSON.stringify(payload);
            if (print === sub.lastPrint) return;
            sub.lastPrint = print;
            this.push({ t: "detail", id: sub.id, data: payload });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // A deleted object is the ordinary end of a detail page, not a
            // failure worth a red box — the client navigates away on `gone`.
            const gone = /not found|notfound/i.test(message);
            this.push({ t: "error", id: sub.id, message, fatal: false, gone });
        } finally {
            sub.running = false;
            if (sub.again) {
                sub.again = false;
                this.scheduleDetail(sub);
            }
        }
    }
}

/** Kinds whose detail page must also react to pod churn. */
const WATCH_PODS_FOR = new Set(["deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "nodes"]);

function kindMetaOf(k: KindDef) {
    return {
        name: k.name,
        title: k.title,
        kind: k.kind,
        clusterScoped: Boolean(k.clusterScoped),
        generic: Boolean(k.generic),
        columns: k.columns,
    };
}


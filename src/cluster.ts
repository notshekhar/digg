import {
    type K8sObject,
    type ResourceRef,
    getContexts,
    getCurrentContext,
    getNamespaces,
    listResources,
} from "./kubectl.ts";
import { type KindDef, KINDS, findKind, genericKind } from "./format.ts";
import { type DiscoveredResource, apiResources } from "./discovery.ts";
import type { WatchEventType, WatchTarget } from "./watch.ts";
import { getContextPrefs, setContextPrefs, setLastContext } from "./settings.ts";
import { Table } from "./views/table.ts";

/** Stable identity for an object across watch updates (uid, else ns/name). */
function objectKey(obj: K8sObject): string {
    const uid = (obj.metadata as { uid?: string } | undefined)?.uid;
    return uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;
}

/** Stable list order: by namespace, then name (mirrors `kubectl get`). */
function compareObjects(a: K8sObject, b: K8sObject): number {
    const ns = (a.metadata?.namespace ?? "").localeCompare(b.metadata?.namespace ?? "");
    return ns !== 0 ? ns : (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? "");
}

/**
 * Owns the current cluster session: context/namespace/kind selection, the
 * fetched objects, the name filter, and the table that presents them. The app
 * orchestrates; this holds the "what are we looking at" state and the data.
 */
export class ClusterStore {
    context = "";
    contexts: string[] = [];
    namespaces: string[] = [];
    namespace: string | null = null; // null → all namespaces
    kind: KindDef = KINDS[0];
    filter = "";
    /** Every resource the cluster exposes (built-ins + CRDs), via discovery. */
    discovered: DiscoveredResource[] = [];

    readonly table = new Table();
    /** Live objects keyed by identity; updated in place by watch events. */
    private objects = new Map<string, K8sObject>();
    private visible: K8sObject[] = [];

    /** Discover available contexts and the current one (best effort). */
    async loadContexts(): Promise<void> {
        this.context = await getCurrentContext().catch(() => "");
        this.contexts = await getContexts();
    }

    /** Switch to a cluster, restoring its last-used namespace + kind. */
    async enter(context: string): Promise<void> {
        this.context = context;
        setLastContext(context);
        const prefs = getContextPrefs(context);
        this.namespace = prefs.namespace !== undefined ? prefs.namespace : null;
        this.filter = "";
        this.discovered = await apiResources(context).catch(() => []);
        this.kind = (prefs.kind && this.resolveKind(prefs.kind)) || KINDS[0];
        await this.loadNamespaces();
    }

    async loadNamespaces(): Promise<void> {
        try {
            this.namespaces = await getNamespaces(this.context);
        } catch {
            this.namespaces = [];
        }
    }

    /** Resolve a resource name to a KindDef: curated first, else discovered (generic). */
    resolveKind(name: string): KindDef | undefined {
        const curated = findKind(name);
        if (curated) {
            return curated;
        }
        const d = this.discovered.find((r) => r.name === name || r.kind === name);
        return d ? genericKind(d) : undefined;
    }

    /** Curated kinds first, then every other discovered resource (deduped). */
    allKinds(): KindDef[] {
        const curatedNames = new Set(KINDS.map((k) => k.name));
        const generics = this.discovered
            .filter((d) => !curatedNames.has(d.name))
            .map((d) => genericKind(d));
        return [...KINDS, ...generics];
    }

    /** Re-fetch the current kind and rebuild the table. Throws on failure. */
    async refresh(): Promise<void> {
        const list = await listResources(this.kind.name, {
            context: this.context,
            namespace: this.kind.clusterScoped ? undefined : this.namespace ?? undefined,
            clusterScoped: this.kind.clusterScoped,
        });
        // Replace the live map wholesale (authoritative snapshot); watch events
        // then mutate it incrementally between full resyncs.
        this.objects = new Map(list.map((o) => [objectKey(o), o]));
        this.rebuild();
    }

    /** The current list target, for the watch stream. */
    watchTarget(): WatchTarget {
        return {
            kind: this.kind.name,
            namespace: this.kind.clusterScoped ? undefined : this.namespace ?? undefined,
            clusterScoped: this.kind.clusterScoped,
        };
    }

    /**
     * Apply one live watch event to the object map and rebuild the table.
     * Ignored when the event is for a different kind than we're showing (a stale
     * event from a watch we just switched away from).
     */
    applyWatchEvent(type: WatchEventType, obj: K8sObject): boolean {
        if (obj.kind && this.kind.kind && obj.kind !== this.kind.kind) {
            return false;
        }
        const key = objectKey(obj);
        if (type === "DELETED") {
            if (!this.objects.delete(key)) return false;
        } else {
            this.objects.set(key, obj);
        }
        // Note: caller rebuilds (debounced) so a burst of events — a rollout, a
        // node draining — costs one re-sort/re-layout instead of one per event.
        return true;
    }

    setKind(name: string): void {
        const kind = this.resolveKind(name);
        if (kind) {
            this.kind = kind;
            this.filter = "";
            setContextPrefs(this.context, { kind: kind.name });
        }
    }

    setNamespace(namespace: string | null): void {
        this.namespace = namespace;
        setContextPrefs(this.context, { namespace });
    }

    setFilter(filter: string): void {
        this.filter = filter;
        this.rebuild();
    }

    get count(): number {
        return this.visible.length;
    }

    get allNamespaces(): boolean {
        return this.namespace === null && !this.kind.clusterScoped;
    }

    selectedObject(): K8sObject | undefined {
        return this.visible[this.table.selected()];
    }

    selectedRef(): ResourceRef | undefined {
        const obj = this.selectedObject();
        if (!obj?.metadata?.name) {
            return undefined;
        }
        return {
            kind: this.kind.name,
            name: obj.metadata.name,
            namespace: this.kind.clusterScoped ? undefined : obj.metadata.namespace ?? this.namespace ?? undefined,
            context: this.context,
        };
    }

    /** Recompute the visible/sorted rows + table from the live object map. */
    rebuild(): void {
        // Keep the cursor on the same object across live updates (pods added or
        // removed above it would otherwise make the selection jump).
        const selectedKey = this.visible[this.table.selectedIndex]
            ? objectKey(this.visible[this.table.selectedIndex])
            : undefined;

        const filter = this.filter.toLowerCase();
        this.visible = [...this.objects.values()]
            .filter((o) => !filter || (o.metadata?.name ?? "").toLowerCase().includes(filter))
            .sort(compareObjects);

        const columns = this.allNamespaces ? ["NAMESPACE", ...this.kind.columns] : [...this.kind.columns];
        const rows = this.visible.map((o) => {
            const cells = this.kind.row(o);
            return this.allNamespaces ? [o.metadata?.namespace ?? "", ...cells] : cells;
        });
        this.table.setData(columns, rows, columns.indexOf("STATUS"));

        if (selectedKey) {
            const idx = this.visible.findIndex((o) => objectKey(o) === selectedKey);
            if (idx >= 0) {
                this.table.selectedIndex = idx;
            }
        }
    }
}

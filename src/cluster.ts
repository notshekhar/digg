import {
    type K8sObject,
    type ResourceRef,
    getContexts,
    getCurrentContext,
    getNamespaces,
    listResources,
} from "./kubectl.ts";
import { type KindDef, KINDS, findKind } from "./format.ts";
import { getContextPrefs, setContextPrefs, setLastContext } from "./settings.ts";
import { Table } from "./views/table.ts";

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

    readonly table = new Table();
    private objects: K8sObject[] = [];
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
        this.kind = (prefs.kind && findKind(prefs.kind)) || KINDS[0];
        this.filter = "";
        await this.loadNamespaces();
    }

    async loadNamespaces(): Promise<void> {
        try {
            this.namespaces = await getNamespaces(this.context);
        } catch {
            this.namespaces = [];
        }
    }

    /** Re-fetch the current kind and rebuild the table. Throws on failure. */
    async refresh(): Promise<void> {
        this.objects = await listResources(this.kind.name, {
            context: this.context,
            namespace: this.kind.clusterScoped ? undefined : this.namespace ?? undefined,
            clusterScoped: this.kind.clusterScoped,
        });
        this.rebuild();
    }

    setKind(name: string): void {
        const kind = findKind(name);
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

    private rebuild(): void {
        this.visible = this.objects.filter(
            (o) => !this.filter || (o.metadata?.name ?? "").toLowerCase().includes(this.filter.toLowerCase()),
        );
        const columns = this.allNamespaces ? ["NAMESPACE", ...this.kind.columns] : [...this.kind.columns];
        const rows = this.visible.map((o) => {
            const cells = this.kind.row(o);
            return this.allNamespaces ? [o.metadata?.namespace ?? "", ...cells] : cells;
        });
        this.table.setData(columns, rows, columns.indexOf("STATUS"));
    }
}

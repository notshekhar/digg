/**
 * The navigation catalog: every kind the cluster exposes, arranged into the
 * groups an operator already thinks in (Workloads, Config, Network, Storage,
 * Access Control, …) instead of the flat alphabetical list `kubectl
 * api-resources` returns.
 *
 * Two rules make this honest on any cluster:
 *
 *   1. NOTHING IS LISTED THAT ISN'T THERE. A curated kind only appears if
 *      discovery saw it. A 1.20 cluster has no EndpointSlices and a bare kind
 *      cluster has no HPAs; showing the row anyway just yields a 404 on click.
 *   2. NOTHING THAT IS THERE IS HIDDEN. Anything discovered but not curated
 *      lands under Custom Resources, bucketed by API group, so CRDs are
 *      first-class rather than a search-only afterthought.
 */

import type { DiscoveredResource } from "../discovery.ts";
import { KINDS, type KindDef, genericKind } from "../format.ts";

export interface CatalogKind {
    name: string;
    title: string;
    kind: string;
    clusterScoped: boolean;
    generic: boolean;
    columns: string[];
    /** apiVersion as discovery reported it, e.g. "apps/v1" — "" when unknown. */
    apiVersion: string;
    shortNames: string[];
}

export interface CatalogGroup {
    id: string;
    title: string;
    kinds: CatalogKind[];
}

/** Curated group layout. Order is deliberate: it is the rail, top to bottom. */
const GROUPS: { id: string; title: string; kinds: string[] }[] = [
    { id: "cluster", title: "Cluster", kinds: ["nodes", "namespaces", "events"] },
    {
        id: "workloads",
        title: "Workloads",
        kinds: ["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs"],
    },
    {
        id: "config",
        title: "Config",
        kinds: [
            "configmaps",
            "secrets",
            "resourcequotas",
            "limitranges",
            "horizontalpodautoscalers",
            "poddisruptionbudgets",
            "priorityclasses",
            "runtimeclasses",
            "leases",
            "mutatingwebhookconfigurations",
            "validatingwebhookconfigurations",
        ],
    },
    {
        id: "network",
        title: "Network",
        kinds: ["services", "endpoints", "endpointslices", "ingresses", "ingressclasses", "networkpolicies"],
    },
    { id: "storage", title: "Storage", kinds: ["persistentvolumeclaims", "persistentvolumes", "storageclasses"] },
    {
        id: "access",
        title: "Access Control",
        kinds: ["serviceaccounts", "roles", "rolebindings", "clusterroles", "clusterrolebindings"],
    },
    { id: "definitions", title: "Definitions", kinds: ["customresourcedefinitions"] },
];

/** API groups that ship with Kubernetes — everything else is somebody's CRD. */
const BUILTIN_GROUPS = new Set([
    "",
    "v1",
    "apps",
    "batch",
    "autoscaling",
    "policy",
    "networking.k8s.io",
    "storage.k8s.io",
    "rbac.authorization.k8s.io",
    "apiextensions.k8s.io",
    "admissionregistration.k8s.io",
    "coordination.k8s.io",
    "scheduling.k8s.io",
    "node.k8s.io",
    "authentication.k8s.io",
    "authorization.k8s.io",
    "certificates.k8s.io",
    "discovery.k8s.io",
    "events.k8s.io",
    "flowcontrol.apiserver.k8s.io",
    "apiregistration.k8s.io",
    "metrics.k8s.io",
    // Dynamic Resource Allocation, GA in 1.34 — a built-in group, not a CRD.
    "resource.k8s.io",
    "storagemigration.k8s.io",
    "internal.apiserver.k8s.io",
]);

function apiGroupOf(apiVersion: string): string {
    const slash = apiVersion.indexOf("/");
    return slash === -1 ? "" : apiVersion.slice(0, slash);
}

/** Human label for an API group: "cert-manager.io" → "cert-manager.io". */
function groupTitle(group: string): string {
    return group || "core";
}

function toCatalogKind(def: KindDef, found?: DiscoveredResource): CatalogKind {
    return {
        name: def.name,
        title: def.title,
        kind: def.kind,
        clusterScoped: Boolean(def.clusterScoped),
        generic: Boolean(def.generic),
        columns: def.columns,
        apiVersion: found?.apiVersion ?? "",
        shortNames: found?.shortNames ?? [],
    };
}

/**
 * Build the full navigation catalog.
 *
 * `discovered` may be empty (old cluster, RBAC-restricted user, api-resources
 * failed) — in that case we fall back to showing every curated kind, because an
 * empty sidebar is worse than a sidebar with a few rows that 403.
 */
export function buildCatalog(discovered: DiscoveredResource[]): CatalogGroup[] {
    const byName = new Map(discovered.map((d) => [d.name, d]));
    const trustDiscovery = discovered.length > 0;
    const claimed = new Set<string>();
    const groups: CatalogGroup[] = [];

    for (const g of GROUPS) {
        const kinds: CatalogKind[] = [];
        for (const name of g.kinds) {
            const def = KINDS.find((k) => k.name === name);
            if (!def) continue;
            const found = byName.get(name);
            if (trustDiscovery && !found) continue;
            claimed.add(name);
            kinds.push(toCatalogKind(def, found));
        }
        if (kinds.length) groups.push({ id: g.id, title: g.title, kinds });
    }

    // Built-in kinds that exist on the cluster but no curated group claims —
    // CSIDrivers, APIServices, FlowSchemas and friends. They get a generic list
    // rather than disappearing.
    const other: CatalogKind[] = [];
    const custom = new Map<string, CatalogKind[]>();

    for (const d of discovered) {
        if (claimed.has(d.name)) continue;
        const def = KINDS.find((k) => k.name === d.name) ?? genericKind(d);
        const entry = toCatalogKind(def, d);
        const group = apiGroupOf(d.apiVersion);
        if (BUILTIN_GROUPS.has(group)) {
            other.push(entry);
        } else {
            const list = custom.get(group) ?? [];
            list.push(entry);
            custom.set(group, list);
        }
    }

    for (const [group, kinds] of [...custom.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        kinds.sort((a, b) => a.title.localeCompare(b.title));
        groups.push({ id: `crd:${group}`, title: groupTitle(group), kinds });
    }

    if (other.length) {
        other.sort((a, b) => a.title.localeCompare(b.title));
        groups.push({ id: "other", title: "Other", kinds: other });
    }

    return groups;
}

/** Flat lookup over the catalog, for the command palette and deep links. */
export function catalogKinds(groups: CatalogGroup[]): CatalogKind[] {
    return groups.flatMap((g) => g.kinds);
}

/**
 * REST paths for Kubernetes resources.
 *
 * `kubectl get pods -n demo` is `/api/v1/namespaces/demo/pods`; the same call
 * for a CRD is `/apis/<group>/<version>/namespaces/<ns>/<plural>`. The only
 * inputs are what discovery already tells us — the plural name, the apiVersion
 * and whether the kind is namespaced — so this is a pure function with no
 * cluster knowledge of its own.
 */

export interface ResourceCoords {
    /** Plural resource name, e.g. "horizontalpodautoscalers". */
    name: string;
    /** "v1" for the core group, else "group/version". */
    apiVersion: string;
    namespaced: boolean;
}

export interface PathOptions {
    /** Undefined means every namespace — the API's collection path does that. */
    namespace?: string;
    /** A single object rather than the collection. */
    objectName?: string;
    /** e.g. "log", "status". */
    subresource?: string;
}

/** The group root: core resources live under /api, everything else under /apis. */
export function groupPath(apiVersion: string): string {
    return apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
}

export function resourcePath(res: ResourceCoords, opts: PathOptions = {}): string {
    let path = groupPath(res.apiVersion);
    // A cluster-scoped kind has no namespace segment even if one is passed;
    // asking for /namespaces/x/nodes is a 404, not a filtered list.
    if (res.namespaced && opts.namespace) path += `/namespaces/${encodeURIComponent(opts.namespace)}`;
    path += `/${res.name}`;
    if (opts.objectName) path += `/${encodeURIComponent(opts.objectName)}`;
    if (opts.subresource) path += `/${opts.subresource}`;
    return path;
}

export interface QueryOptions {
    labelSelector?: string;
    fieldSelector?: string;
    limit?: number;
    resourceVersion?: string;
    watch?: boolean;
    allowWatchBookmarks?: boolean;
    timeoutSeconds?: number;
}

export function withQuery(path: string, q: QueryOptions = {}): string {
    const sp = new URLSearchParams();
    if (q.labelSelector) sp.set("labelSelector", q.labelSelector);
    if (q.fieldSelector) sp.set("fieldSelector", q.fieldSelector);
    if (q.limit) sp.set("limit", String(q.limit));
    // resourceVersion="0" is meaningful — it asks for the API server's cache
    // rather than a quorum read — so test for undefined, not falsiness.
    if (q.resourceVersion !== undefined) sp.set("resourceVersion", q.resourceVersion);
    if (q.watch) sp.set("watch", "1");
    if (q.allowWatchBookmarks) sp.set("allowWatchBookmarks", "true");
    if (q.timeoutSeconds !== undefined) sp.set("timeoutSeconds", String(q.timeoutSeconds));
    const query = sp.toString();
    return query ? `${path}?${query}` : path;
}

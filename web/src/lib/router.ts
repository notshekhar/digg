/**
 * Path routing, hand-rolled.
 *
 * Real paths, not a hash: `digg serve` answers every non-/api GET with the app,
 * so `/k/pods/demo/api-7d9f` is a working deep link, and the query string is
 * left free for nuqs to own (see lib/query.ts). A hash router would have to
 * carry `?tab=yaml` *inside* the fragment, which no query-state library reads.
 *
 *   /                       overview
 *   /events                 cluster events
 *   /k/pods                 a kind's table
 *   /k/pods/demo/api-7d9f   one object, full page
 *   /k/nodes/-/minikube     "-" is the namespace slot for cluster-scoped kinds
 *
 * Navigation goes through pushState and then fires a popstate, because that is
 * the one event both this router and nuqs listen to — updating the URL without
 * it leaves one of them reading a URL that no longer exists.
 */

import { useSyncExternalStore } from "react";

export type Route =
    | { page: "overview" }
    | { page: "events" }
    | { page: "list"; kind: string }
    | { page: "detail"; kind: string; name: string; ns?: string };

/** Query keys that survive a page change; everything else is page-local. */
const STICKY = new Set(["ns"]);

export function parsePath(pathname: string): Route {
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "events") return { page: "events" };
    if (parts[0] === "k" && parts[1]) {
        const kind = parts[1];
        if (parts[2] && parts[3]) {
            return { page: "detail", kind, name: parts[3], ns: parts[2] === "-" ? undefined : parts[2] };
        }
        return { page: "list", kind };
    }
    return { page: "overview" };
}

export function routePath(route: Route): string {
    if (route.page === "overview") return "/";
    if (route.page === "events") return "/events";
    const kind = encodeURIComponent(route.kind);
    if (route.page === "detail") {
        return `/k/${kind}/${encodeURIComponent(route.ns ?? "-")}/${encodeURIComponent(route.name)}`;
    }
    return `/k/${kind}`;
}

function stickyQuery(): string {
    const current = new URLSearchParams(location.search);
    const next = new URLSearchParams();
    for (const [k, v] of current) {
        if (STICKY.has(k)) next.set(k, v);
    }
    const s = next.toString();
    return s ? `?${s}` : "";
}

export function navigate(route: Route, opts: { replace?: boolean; keepQuery?: boolean } = {}): void {
    const url = `${routePath(route)}${opts.keepQuery ? location.search : stickyQuery()}`;
    if (url === `${location.pathname}${location.search}`) return;
    // The marker lets goBack() know the previous entry is ours to return to.
    const state = { digg: true };
    if (opts.replace) history.replaceState(state, "", url);
    else history.pushState(state, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Step back if we are the ones who pushed the current entry, otherwise go to
 * `fallback`. Landing directly on a deep link and pressing esc should take you
 * to that kind's table, not out of the app into whatever page came before it.
 */
export function goBack(fallback: Route): void {
    if ((history.state as { digg?: boolean } | null)?.digg) history.back();
    else navigate(fallback, { replace: true });
}

function subscribe(onChange: () => void): () => void {
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
}

export function useRoute(): Route {
    const pathname = useSyncExternalStore(
        subscribe,
        () => location.pathname,
        () => "/",
    );
    return parsePath(pathname);
}

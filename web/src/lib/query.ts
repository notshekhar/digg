/**
 * URL-backed UI state, via nuqs.
 *
 * Anything a teammate would want in a pasted link lives here rather than in
 * component state: which namespaces are selected, what the table is filtered
 * to, which tab of an object you are reading, which container's logs. The
 * upshot is that reload, back/forward and a copied URL all restore the same
 * screen, and none of it needs a store.
 *
 * All of it uses `history: "replace"` — typing in a filter box should not push
 * forty history entries between you and the page you came from.
 */

import { parseAsArrayOf, parseAsString, useQueryState } from "nuqs";

const replace = { history: "replace" as const };

/** Selected namespaces. Empty means every namespace, as `kubectl -A` does. */
export function useNamespaces() {
    return useQueryState("ns", parseAsArrayOf(parseAsString).withDefault([]).withOptions(replace));
}

/** Free-text filter on the current table. */
export function useFilter() {
    return useQueryState("q", parseAsString.withDefault("").withOptions(replace));
}

/** Which tab of the detail page is open. */
export function useTab() {
    return useQueryState("tab", parseAsString.withDefault("overview").withOptions(replace));
}

/** Container selected for logs, "" meaning all containers. */
export function useContainer() {
    return useQueryState("container", parseAsString.withDefault("").withOptions(replace));
}

/** The namespace the API should be asked for: one name, or "*" for all. */
export function nsParam(selected: string[]): string {
    return selected.length === 1 ? selected[0]! : "*";
}

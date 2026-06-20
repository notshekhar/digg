import type { KindDef } from "../format.ts";
import { Selector } from "./selector.ts";

/**
 * Resource-kind picker over every available kind (curated + discovered CRDs).
 * The label carries the resource name so fuzzy search matches shortnames/plural
 * (e.g. typing "hpa"/"horizontal" finds HorizontalPodAutoscalers).
 */
export function kindSelector(kinds: KindDef[], onPick: (value: string) => void, onCancel: () => void): Selector {
    const selector = new Selector(
        "Switch resource",
        kinds.map((k) => ({
            value: k.name,
            label: k.generic ? `${k.title}  ${k.name}` : k.title,
        })),
    );
    selector.onPick = onPick;
    selector.onCancel = onCancel;
    return selector;
}

/** Namespace picker, with an "<all namespaces>" entry (value "*"). */
export function namespaceSelector(namespaces: string[], onPick: (value: string) => void, onCancel: () => void): Selector {
    const choices = [{ value: "*", label: "<all namespaces>" }, ...namespaces.map((n) => ({ value: n, label: n }))];
    const selector = new Selector("Switch namespace", choices);
    selector.onPick = onPick;
    selector.onCancel = onCancel;
    return selector;
}

/**
 * Cluster picker (the "home" screen). The last-used cluster floats to the top.
 * No onCancel: home has nowhere to go back to, so esc does nothing here.
 */
export function contextSelector(contexts: string[], last: string | undefined, onPick: (value: string) => void): Selector {
    const ordered = last && contexts.includes(last) ? [last, ...contexts.filter((c) => c !== last)] : contexts;
    const selector = new Selector(
        "Select a cluster",
        ordered.map((c) => ({ value: c, label: c })),
    );
    selector.onPick = onPick;
    return selector;
}

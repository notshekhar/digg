/**
 * Objects → table rows.
 *
 * Extracted so `/api/list` and the live watch stream cannot drift: a row built
 * from a watch event must be byte-identical to the same row built from a list,
 * or a table that switches between the two would flicker in ways nobody could
 * reproduce.
 */

import type { K8sObject } from "../kubectl.ts";
import type { KindDef } from "../format.ts";
import { ingressRoutes } from "../format.ts";
import { type Meter, type UsageColumns } from "./gauges.ts";

export interface Row {
    cells: string[];
    name: string;
    ns?: string;
    tones: Record<number, string>;
    ts: number;
    labels?: Record<string, string>;
    meters?: Record<number, Meter>;
    rules?: { url: string; host: string; path: string; service: string; port: string }[];
    lines?: number;
}

export function statusTone(value: string): "ok" | "warn" | "bad" | "neutral" {
    const v = value.toLowerCase();
    if (v === "running" || v === "active" || v === "ready" || v === "bound" || v === "succeeded" || v === "true") {
        return "ok";
    }
    if (v === "pending" || v === "containercreating" || v === "terminating" || v === "notready" || v === "false") {
        return "warn";
    }
    if (v.includes("error") || v.includes("failed") || v === "crashloopbackoff" || v === "evicted" || v === "oomkilled") {
        return "bad";
    }
    return "neutral";
}

/**
 * Where the usage columns get spliced in, and what the header ends up as.
 *
 * Usage sits inside the kind's own columns rather than after them, so CPU
 * reads next to the replica counts and before AGE, where an operator looks.
 */
export function columnsFor(kind: KindDef, usage: UsageColumns | null): { columns: string[]; insertAt: number } {
    const base = kind.clusterScoped ? [...kind.columns] : ["NAMESPACE", ...kind.columns];
    if (!usage) return { columns: base, insertAt: base.length };
    const found = base.indexOf(usage.insertBefore);
    const insertAt = found >= 0 ? found : base.length;
    return { columns: [...base.slice(0, insertAt), ...usage.columns, ...base.slice(insertAt)], insertAt };
}

export function buildRow(
    obj: K8sObject,
    kind: KindDef,
    usage: UsageColumns | null,
    insertAt: number,
): Row {
    const name = obj.metadata?.name ?? "";
    const ns = obj.metadata?.namespace;
    const base = kind.row(obj);
    const withNs = kind.clusterScoped ? base : [ns ?? "", ...base];
    const extra = usage?.byKey.get(`${ns ?? ""}/${name}`);
    const cells = extra
        ? [...withNs.slice(0, insertAt), ...extra.cells, ...withNs.slice(insertAt)]
        : usage
          ? // A row the metrics pass never saw (it appeared between the list and
            // the top call) keeps its place in the grid with em dashes rather
            // than shifting every column left.
            [...withNs.slice(0, insertAt), ...usage.columns.map(() => "—"), ...withNs.slice(insertAt)]
          : withNs;

    const meters: Record<number, Meter> = {};
    extra?.meters.forEach((m, i) => {
        if (m) meters[insertAt + i] = m;
    });

    const tones: Record<number, string> = {};
    cells.forEach((c, i) => {
        const t = statusTone(c);
        if (t !== "neutral") tones[i] = t;
    });

    // An Ingress row's whole meaning is its routes, so they travel as
    // structured links: the URL is openable and the backend clickable, instead
    // of a comma-joined string you have to retype.
    const rules = kind.name === "ingresses" ? ingressRoutes(obj).slice(0, 12) : undefined;

    return {
        cells,
        name,
        ns,
        tones,
        // The creation timestamp travels with the row so the grid can sort by
        // real age. Sorting the rendered "5d" string puts 9m after 5d, which is
        // the kind of wrong that looks right.
        ts: obj.metadata?.creationTimestamp ? new Date(obj.metadata.creationTimestamp).getTime() : 0,
        labels: obj.metadata?.labels,
        meters: Object.keys(meters).length ? meters : undefined,
        rules,
        // A multi-route Ingress needs a taller row; the grid lays rows out by
        // their own heights.
        lines: rules && rules.length > 1 ? Math.min(rules.length, 4) : undefined,
    };
}

export const rowKey = (row: { ns?: string; name: string }): string => `${row.ns ?? ""}/${row.name}`;

/** Cheap identity for "did this row actually change?" delta suppression. */
export const rowFingerprint = (row: Row): string => JSON.stringify(row);

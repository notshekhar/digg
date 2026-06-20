import type { ClusterStore } from "../cluster.ts";
import { ui } from "../theme.ts";
import { pad } from "./layout.ts";

export interface ListViewState {
    filtering: boolean;
    status: string;
    mouseEnabled: boolean;
    /** Active port-forward summary, shown in the header when non-empty. */
    forwards: string;
}

/** Render the resource list screen: header bar, table, and contextual footer. */
export function renderList(store: ClusterStore, state: ListViewState, width: number, bodyHeight: number): string[] {
    const lines = [pad(header(store, state), width), ui.rule("─".repeat(width)), ...store.table.render(width, bodyHeight)];
    const total = process.stdout.rows || 24;
    while (lines.length < total - 1) {
        lines.push("");
    }
    lines.push(pad(footer(store, state), width));
    return lines;
}

function header(store: ClusterStore, state: ListViewState): string {
    const ns = store.kind.clusterScoped ? "—" : store.namespace ?? "all";
    const segments = [
        `${ui.headerKey("context:")} ${ui.headerVal(store.context || "?")}`,
        `${ui.headerKey("ns:")} ${ui.headerVal(ns)}`,
        `${ui.headerKey("kind:")} ${ui.headerVal(store.kind.title)}`,
        `${ui.headerKey("count:")} ${ui.headerVal(String(store.count))}`,
    ];
    if (state.forwards) {
        segments.push(ui.accent(state.forwards));
    }
    return ui.headerBar(` digg `) + "  " + segments.join(ui.dim("  ·  "));
}

function footer(store: ClusterStore, state: ListViewState): string {
    if (state.filtering || store.filter) {
        return `  ${ui.dim("/")} ${ui.accent(store.filter)}${state.filtering ? ui.accent("▏") : ""}`;
    }
    if (state.status) {
        return `  ${ui.dim(state.status)}`;
    }
    const sel = state.mouseEnabled ? ui.dim("  · m select text") : ui.accent("  · select mode (m)");
    const keys = "enter open · : kind · n ns · c ctx · / filter · y yaml · d desc · l logs · s shell · f fwd · X del · R refresh · esc home";
    return `  ${ui.footer(keys)}${sel}`;
}

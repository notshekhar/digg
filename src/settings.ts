import { homedir } from "node:os";
import { join } from "node:path";
import Configstore from "configstore";

// Preferences persist under ~/.digg/settings.json. Per-context we remember the
// last namespace and kind so reopening a cluster lands where you left off; the
// theme is global. Anything the URL can carry (filters, tabs) lives there
// instead — see web/src/lib/query.ts.

interface ContextPrefs {
    /** Legacy single selection, still read so an old settings.json still works. */
    namespace?: string | null; // null → all namespaces
    /** Every selected namespace. Empty means all of them, as `kubectl -A` does. */
    namespaces?: string[];
    kind?: string;
}

interface SettingsData {
    lastContext?: string;
    contexts: Record<string, ContextPrefs>;
    /** Web UI prefs (`digg serve`). */
    web?: { theme?: "light" | "dark" };
    /** Free-form UI state: panel sizes, toggles, per-kind sort. See `ui` below. */
    ui?: Record<string, unknown>;
}

const store = new Configstore(
    "digg",
    { contexts: {} } satisfies SettingsData,
    { configPath: join(homedir(), ".digg", "settings.json") },
);

export function getLastContext(): string | undefined {
    return store.get("lastContext");
}

export function setLastContext(context: string): void {
    store.set("lastContext", context);
}

export function getContextPrefs(context: string): ContextPrefs {
    const all = (store.get("contexts") as Record<string, ContextPrefs>) ?? {};
    const prefs = all[context] ?? {};
    // A file written before multi-select existed only knows one namespace.
    if (!prefs.namespaces && typeof prefs.namespace === "string") {
        return { ...prefs, namespaces: [prefs.namespace] };
    }
    return prefs;
}

export function setContextPrefs(context: string, prefs: ContextPrefs): void {
    const all = (store.get("contexts") as Record<string, ContextPrefs>) ?? {};
    all[context] = { ...all[context], ...prefs };
    store.set("contexts", all);
}



export function getWebPrefs(): { theme: "light" | "dark" } {
    const web = (store.get("web") as SettingsData["web"]) ?? {};
    return { theme: web.theme === "light" ? "light" : "dark" };
}

export function setWebPrefs(prefs: { theme?: "light" | "dark" }): void {
    const cur = (store.get("web") as SettingsData["web"]) ?? {};
    store.set("web", { ...cur, ...prefs });
}

/**
 * The rest of the UI's state — which rail groups are folded, the console's
 * height, how the log pane is set up, how each table is sorted.
 *
 * It lives here rather than in localStorage for the reason the namespace and
 * theme already do: a cockpit that forgets its shape because you opened it in
 * another browser, or after `digg` picked a different port (localStorage is
 * keyed on the origin, and the port is part of it), is a cockpit that feels
 * new every morning. One flat bag of small values, stamped into the page at
 * render so there is no second paint.
 */
const UI_MAX_BYTES = 64 * 1024;

export function getUiState(): Record<string, unknown> {
    const ui = store.get("ui") as Record<string, unknown> | undefined;
    return ui && typeof ui === "object" ? ui : {};
}

/** Shallow merge; a null value deletes its key so the bag cannot only grow. */
export function setUiState(patch: Record<string, unknown>): Record<string, unknown> {
    const next = { ...getUiState() };
    for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete next[k];
        else next[k] = v;
    }
    // The client is trusted, but a runaway writer must not turn settings.json
    // into something the next boot has to parse megabytes of.
    if (JSON.stringify(next).length > UI_MAX_BYTES) return getUiState();
    store.set("ui", next);
    return next;
}

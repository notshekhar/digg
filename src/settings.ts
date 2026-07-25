import { homedir } from "node:os";
import { join } from "node:path";
import Configstore from "configstore";

// Preferences persist under ~/.digg/settings.json. Per-context we remember the
// last namespace and kind so reopening a cluster lands where you left off; the
// theme is global. Anything the URL can carry (filters, tabs) lives there
// instead — see web/src/lib/query.ts.

interface ContextPrefs {
    namespace?: string | null; // null → all namespaces
    kind?: string;
}

interface SettingsData {
    lastContext?: string;
    contexts: Record<string, ContextPrefs>;
    /** Web UI prefs (`digg serve`). */
    web?: { theme?: "light" | "dark" };
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
    return all[context] ?? {};
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

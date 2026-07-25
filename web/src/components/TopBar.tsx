/**
 * The top bar: which cluster, which namespaces, and the controls that apply to
 * whatever is on screen.
 *
 * Context and namespace live here rather than in the rail because they scope
 * every page equally — putting them above the content is the honest position
 * for a filter that the whole app obeys.
 */

import { Icon } from "./icons.tsx";
import { MultiSelect, Select } from "./ui.tsx";
import { api } from "../lib/api.ts";
import { refreshNow, setDock, setState, toast, useApp } from "../lib/store.ts";
import { useNamespaces } from "../lib/query.ts";
import { useLiveStatus } from "../lib/live-data.ts";
import "./TopBar.css";

export function TopBar({ onPalette }: { onPalette: () => void }) {
    const contexts = useApp((s) => s.contexts);
    const context = useApp((s) => s.context);
    const namespaces = useApp((s) => s.namespaces);
    const [selectedNs, setSelectedNs] = useNamespaces();
    const live = useApp((s) => s.live);
    const liveMode = useLiveStatus();
    const refreshing = useApp((s) => s.refreshing);
    const dockOpen = useApp((s) => s.dock.open);
    const dockTab = useApp((s) => s.dock.tab);
    const theme = useApp((s) => s.theme);
    const cluster = useApp((s) => s.cluster);
    const forwards = useApp((s) => s.forwards);
    const activeForwards = forwards.filter((f) => f.status === "active" || f.status === "starting").length;

    const switchContext = async (next: string) => {
        setState({ context: next, ready: false, catalog: [] });
        void setSelectedNs(null);
        try {
            const [{ namespaces: ns }, { catalog }] = await Promise.all([api.namespaces(next), api.catalog(next)]);
            setState({ namespaces: ns, catalog, ready: true });
            void api.prefs({ context: next }).catch(() => {});
            refreshNow();
        } catch (err) {
            setState({ ready: true, error: err instanceof Error ? err.message : String(err) });
            toast("bad", "Could not switch context", err instanceof Error ? err.message : String(err));
        }
    };

    const setNamespaces = (next: string[]) => {
        // null clears the param instead of leaving ?ns= behind.
        void setSelectedNs(next.length ? next : null);
        void api.prefs({ context, namespace: next.length === 1 ? next[0] : null }).catch(() => {});
        refreshNow();
    };

    const toggleTheme = () => {
        const next = theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        setState({ theme: next });
        void api.prefs({ theme: next }).catch(() => {});
    };

    return (
        <header className="topbar">
            <Select
                label="Cluster"
                icon={<Icon.Cluster size={13} />}
                options={contexts}
                value={context}
                onChange={(v) => void switchContext(v)}
            />
            <MultiSelect
                label="Namespace"
                icon={<Icon.Layers size={13} />}
                options={namespaces}
                selected={selectedNs}
                onChange={setNamespaces}
            />

            <button className="palette-btn" type="button" onClick={onPalette} title="Search everything">
                <Icon.Search size={13} />
                <span>Search</span>
                <kbd>⌘K</kbd>
            </button>

            <div className="spring" />

            {cluster?.server ? (
                <span className="topbar-note mono" title={`client ${cluster.client} · ${cluster.platform}`}>
                    {cluster.server}
                </span>
            ) : null}

            {activeForwards > 0 ? (
                <button
                    className="btn ghost sm"
                    type="button"
                    aria-pressed={dockOpen && dockTab === "forwards"}
                    onClick={() =>
                        // Already looking at the forwards? Then this is the way
                        // back out, not a no-op click.
                        setDock({ open: !(dockOpen && dockTab === "forwards"), tab: "forwards" })
                    }
                    title="Port-forwards"
                >
                    <Icon.Forward size={13} />
                    <span className="mono">{activeForwards}</span>
                </button>
            ) : null}

            {/* Always available: even without pty support the console holds
                the port-forward list, and both must be reachable from any page.
                It TOGGLES — the same button that opened the panel closes it,
                which is what ⌘J does and what a pressed-looking button promises. */}
            <button
                className="btn ghost icon"
                type="button"
                aria-pressed={dockOpen}
                title={dockOpen ? "Hide the console (⌘J)" : "Console — shells and forwards (⌘J)"}
                onClick={() => setDock({ open: !dockOpen })}
            >
                <Icon.Terminal size={14} />
            </button>

            {/* Streaming and polling look identical until something breaks, so
                the mode is stated rather than implied: a dot you can read at a
                glance, and the reason in the tooltip. */}
            <button
                className={`btn ghost icon livebtn ${live ? liveMode : "paused"}`}
                type="button"
                aria-pressed={live}
                title={
                    !live
                        ? "Updates paused — click to resume"
                        : liveMode === "live"
                          ? "Live: streaming changes as they happen (click to pause)"
                          : liveMode === "connecting"
                            ? "Connecting to the live stream — polling meanwhile"
                            : "Live stream unavailable — polling instead"
                }
                onClick={() => setState({ live: !live })}
            >
                {live ? <Icon.Pause size={13} /> : <Icon.Play size={13} />}
                <span className="livedot" />
            </button>
            <button
                className={`btn ghost icon refreshbtn ${refreshing ? "spinning" : ""}`}
                type="button"
                title="Refresh now (⌘⌥R)"
                onClick={() => refreshNow()}
            >
                <Icon.Refresh size={14} />
            </button>
            <button className="btn ghost icon" type="button" title="Toggle theme" onClick={toggleTheme}>
                {theme === "dark" ? <Icon.Sun size={14} /> : <Icon.Moon size={14} />}
            </button>
        </header>
    );
}

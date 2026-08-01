/**
 * The shell: boot, layout, keymap, and which page is on screen.
 *
 * Layout is three fixed regions and two floating ones — rail, top bar, content;
 * a drawer that slides in from the right and a dock that rises from the bottom.
 * Nothing scrolls the page itself, so the grid header stays put no matter how
 * many rows the cluster has.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Console } from "./components/Console.tsx";
import { Palette } from "./components/Palette.tsx";
import { Picker } from "./components/Picker.tsx";
import { Icon } from "./components/icons.tsx";
import { Rail } from "./components/Rail.tsx";
import { AppSkeleton } from "./components/Skeleton.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { Modal, Toasts } from "./components/ui.tsx";
import { ActionDialogs } from "./lib/actions.tsx";
import { api, boot0 } from "./lib/api.ts";
import { useDelayed, useHotkeys } from "./lib/hooks.ts";
import { navigate, useRoute } from "./lib/router.ts";
import { useNamespaces, useTab } from "./lib/query.ts";
import { refreshNow, setDock, setState, toast, useApp } from "./lib/store.ts";
import type { ResourceRef } from "./lib/types.ts";
import { DetailPage } from "./pages/DetailPage.tsx";
import { EventsPage } from "./pages/EventsPage.tsx";
import { ListPage } from "./pages/ListPage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import "./app.css";

export function App() {
    const route = useRoute();
    const ready = useApp((s) => s.ready);
    const error = useApp((s) => s.error);
    const dockOpen = useApp((s) => s.dock.open);
    const [palette, setPalette] = useState(false);
    const [picker, setPicker] = useState<"cluster" | "namespace" | null>(null);
    const [help, setHelp] = useState(false);
    const [selectedNs, setSelectedNs] = useNamespaces();
    const [, setTab] = useTab();
    const nsRef = useRef({ selectedNs, setSelectedNs });
    nsRef.current = { selectedNs, setSelectedNs };
    const booting = useDelayed(!ready && !error);

    // ── boot ───────────────────────────────────────────────────────────────
    useEffect(() => {
        let live = true;
        void (async () => {
            try {
                const boot = await api.boot();
                if (!live) return;
                setState({
                    ready: true,
                    error: null,
                    version: boot.version,
                    canExec: boot.canExec,
                    cluster: boot.cluster,
                    contexts: boot.contexts,
                    context: boot.context,
                    namespaces: boot.namespaces,
                    catalog: boot.catalog,
                    kinds: boot.kinds,
                    theme: boot.prefs.theme,
                    forwards: boot.forwards,
                });
                document.documentElement.dataset.theme = boot.prefs.theme;
                // A URL that already names namespaces wins over the saved
                // preference: a pasted link must open what it says.
                if (nsRef.current.selectedNs.length === 0 && boot.selectedNamespaces.length > 0) {
                    void nsRef.current.setSelectedNs(boot.selectedNamespaces);
                }
            } catch (err) {
                if (live) setState({ ready: true, error: err instanceof Error ? err.message : String(err) });
            }
        })();
        return () => {
            live = false;
        };
    }, []);

    const openDetail = useCallback(
        (ref: ResourceRef, nextTab = "overview") => {
            navigate({ page: "detail", kind: ref.kind, name: ref.name, ns: ref.ns });
            void setTab(nextTab === "overview" ? null : nextTab);
        },
        [setTab],
    );

    /**
     * The only implementation — TopBar and the palette both call this one.
     *
     * A cluster you have used before opens where you left it: the namespaces
     * you had selected there come back with the namespace list, in the same
     * round trip. Clearing the selection first matters, because namespace names
     * are cluster-local — "payments" in staging is not "payments" in prod, and
     * carrying the old filter over would silently show you nothing.
     */
    const switchContext = useCallback(async (next: string) => {
        setState({ context: next, ready: false, catalog: [] });
        void nsRef.current.setSelectedNs(null);
        try {
            const [{ namespaces, selected }, { catalog }] = await Promise.all([
                api.namespaces(next),
                api.catalog(next),
            ]);
            setState({ namespaces, catalog, ready: true });
            if (selected.length) void nsRef.current.setSelectedNs(selected);
            void api.prefs({ context: next }).catch(() => {});
            refreshNow();
        } catch (err) {
            setState({ ready: true });
            toast("bad", "Could not switch cluster", err instanceof Error ? err.message : String(err));
        }
    }, []);

    // ── keymap ─────────────────────────────────────────────────────────────
    useHotkeys({
        "mod+k": () => setPalette((p) => !p),
        "mod+f": () => {
            const input = document.querySelector<HTMLInputElement>('input[data-filter="1"]');
            input?.focus();
            input?.select();
        },
        "mod+j": () => setDock({ open: !dockOpen }),
        "mod+alt+k": () => setPicker((p) => (p === "cluster" ? null : "cluster")),
        "mod+alt+n": () => setPicker((p) => (p === "namespace" ? null : "namespace")),
        "mod+/": () => setHelp((h) => !h),
        // ⌘R is the browser's reload and stays that way; refresh gets the
        // option key so nothing familiar is stolen.
        "mod+alt+r": () => refreshNow(),
    });

    if (error) {
        return (
            <div className="boot-error">
                <h1>digg could not reach your cluster</h1>
                <pre className="mono">{error}</pre>
                <p className="faint">
                    digg drives your local <code>kubectl</code>. Check that it is on PATH and that{" "}
                    <code>kubectl config get-contexts</code> lists a cluster.
                </p>
                <button className="btn primary" type="button" onClick={() => location.reload()}>
                    Retry
                </button>
            </div>
        );
    }

    if (!ready) {
        // The chrome digg is about to have, rather than a centred spinner that
        // is then replaced by a completely different screen. Delayed like every
        // other placeholder: a local cluster answers /api/boot before this
        // would paint.
        return booting ? <AppSkeleton /> : null;
    }

    return (
        <div className="app">
            <Rail route={route} />
            <div className="main">
                <TopBar
                    onPalette={() => setPalette(true)}
                    onClusters={() => setPicker("cluster")}
                    onNamespaces={() => setPicker("namespace")}
                />
                <div className="workspace">
                    <div className="content">
                        {route.page === "overview" ? (
                            <OverviewPage onOpen={openDetail} />
                        ) : route.page === "events" ? (
                            <EventsPage onOpen={openDetail} />
                        ) : route.page === "detail" ? (
                            <DetailPage
                                key={`${route.kind}/${route.ns ?? "-"}/${route.name}`}
                                target={{ kind: route.kind, name: route.name, ns: route.ns }}
                                onOpen={openDetail}
                            />
                        ) : (
                            <ListPage kind={route.kind} onOpen={openDetail} />
                        )}
                    </div>
                </div>
                {/* Outside the route switch on purpose: shells and forwards
                    survive navigation and are reachable from every page. */}
                <Console />
            </div>

            {palette ? (
                <Palette
                    onClose={() => setPalette(false)}
                    onOpen={openDetail}
                    onSwitchContext={(c) => void switchContext(c)}
                />
            ) : null}
            {picker ? (
                <ScopePicker kind={picker} onClose={() => setPicker(null)} onSwitchContext={switchContext} />
            ) : null}
            {help ? <HelpModal onClose={() => setHelp(false)} /> : null}
            <ActionDialogs />
            <Toasts />
        </div>
    );
}

/**
 * The cluster and namespace pickers, which are the same box asking two
 * questions. Namespaces apply as they are toggled — see Picker.tsx for why
 * there is no separate apply step — and are remembered per cluster, so the
 * answer survives a switch and a reload.
 */
function ScopePicker({
    kind,
    onClose,
    onSwitchContext,
}: {
    kind: "cluster" | "namespace";
    onClose: () => void;
    onSwitchContext: (context: string) => Promise<void> | void;
}) {
    const contexts = useApp((s) => s.contexts);
    const context = useApp((s) => s.context);
    const namespaces = useApp((s) => s.namespaces);
    const cluster = useApp((s) => s.cluster);
    const [selectedNs, setSelectedNs] = useNamespaces();

    if (kind === "cluster") {
        return (
            <Picker
                title="Switch cluster"
                placeholder="Search clusters…"
                icon={<Icon.Cluster size={15} />}
                options={contexts.map((c) => ({
                    value: c,
                    hint: c === context ? (cluster?.server ?? "current") : undefined,
                }))}
                selected={context}
                onClose={onClose}
                onPick={(next) => {
                    if (next !== context) void onSwitchContext(next);
                }}
                empty="no clusters in your kubeconfig"
            />
        );
    }

    return (
        <Picker
            multiple
            title="Namespaces"
            placeholder="Search namespaces…"
            icon={<Icon.Layers size={15} />}
            options={namespaces.map((n) => ({ value: n }))}
            allLabel="All namespaces"
            selected={selectedNs}
            onClose={onClose}
            onPick={(next) => {
                void setSelectedNs(next.length ? next : null);
                void api.prefs({ context, namespaces: next }).catch(() => {});
                refreshNow();
            }}
            empty="this cluster has no namespaces you can see"
        />
    );
}

/**
 * Every global shortcut is a ⌘ chord — see the note in lib/hooks.ts. The rest of
 * this list is dismissal and in-table movement, which only apply where focus
 * already is.
 */
const KEYS: [string, string][] = [
    ["⌘K", "Command palette — kinds, namespaces, clusters, pods"],
    ["⌘⌥K", "Switch cluster"],
    ["⌘⌥N", "Choose namespaces"],
    ["⌘F", "Filter the current table"],
    ["⌘J", "Console — shells and port-forwards"],
    ["⌘S", "Apply the YAML you are editing"],
    ["⌘⌥R", "Refresh now"],
    ["⌘/", "This list"],
    ["esc", "Back to the table / close what is open"],
    ["↑ / ↓", "Move the row cursor"],
    ["enter", "Open the selected row"],
    ["space", "Select a row (⌘-click and shift-click work too)"],
    ["right-click", "Actions for a row"],
];

function HelpModal({ onClose }: { onClose: () => void }) {
    return (
        <Modal title="Keyboard" onClose={onClose}>
            <div className="keylist-help">
                {KEYS.map(([k, v]) => (
                    <div className="keyhelp" key={k}>
                        <kbd>{k}</kbd>
                        <span>{v}</span>
                    </div>
                ))}
            </div>
            <p className="dialog-note" style={{ marginTop: 14 }}>
                digg v{boot0.version} · every action runs through your local kubectl.
            </p>
        </Modal>
    );
}

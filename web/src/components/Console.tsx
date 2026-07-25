/**
 * The console: shells and port-forwards, floating over whatever page you are
 * on.
 *
 * It is deliberately not part of any page. A shell into a pod and a running
 * forward both outlive the screen that started them — you open a shell from a
 * pod, then go read a deployment, and the shell has to still be there, still
 * connected. So it floats above the app, survives navigation, and can be
 * summoned from anywhere with ⌘` or the console button.
 *
 * Panes stay mounted while hidden. Unmounting an xterm would kill the process
 * behind it every time you glanced at the forwards tab.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
import { Badge, Empty } from "./ui.tsx";
import { api } from "../lib/api.ts";
import { ageFromMs } from "../lib/format.ts";
import { closeTerminal, openTerminal, setDock, setState, toast, useApp } from "../lib/store.ts";
import "./Console.css";

export function Console() {
    const dock = useApp((s) => s.dock);
    const terminals = useApp((s) => s.terminals);
    const forwards = useApp((s) => s.forwards);
    const context = useApp((s) => s.context);
    const canExec = useApp((s) => s.canExec);
    const [dragging, setDragging] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const startY = useRef(0);
    const startH = useRef(0);

    // Poll forwards whenever the console is open: a forward can die on its own
    // (pod restarted, connection lost) and the row must stop claiming it works.
    useEffect(() => {
        if (!dock.open) return;
        let stop = false;
        const tick = async () => {
            try {
                const { forwards: list } = await api.forwards();
                if (!stop) setState({ forwards: list });
            } catch {
                /* server went away; other surfaces report that */
            }
        };
        void tick();
        const id = setInterval(tick, 3000);
        return () => {
            stop = true;
            clearInterval(id);
        };
    }, [dock.open]);

    useEffect(() => {
        if (!dragging) return;
        const onMove = (e: MouseEvent) => {
            const next = Math.max(160, Math.min(window.innerHeight - 120, startH.current + (startY.current - e.clientY)));
            setDock({ height: next });
        };
        const onUp = () => setDragging(false);
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, [dragging]);

    /*
     * Give the page back the height the console occupies.
     *
     * The console is fixed, so without this it sits ON TOP of the content and
     * the last rows of a table — or the end of a YAML file — can never be
     * scrolled to. The app shell pads itself by --console-h, which the console
     * then fills exactly. Expanded covers everything anyway, so it reserves
     * nothing.
     */
    useEffect(() => {
        const root = document.documentElement;
        const reserved = dock.open && !expanded ? `${dock.height}px` : "0px";
        root.style.setProperty("--console-h", reserved);
        return () => root.style.setProperty("--console-h", "0px");
    }, [dock.open, dock.height, expanded]);

    if (!dock.open) return null;

    const activeForwards = forwards.filter((f) => f.status !== "stopped");
    const tab = dock.tab === "new-local" ? "forwards" : dock.tab || "forwards";

    return createPortal(
        <section
            className={`console ${expanded ? "expanded" : ""}`}
            style={expanded ? undefined : { height: dock.height }}
            aria-label="Console"
        >
            {expanded ? null : (
                <div
                    className="console-grip"
                    onMouseDown={(e) => {
                        startY.current = e.clientY;
                        startH.current = dock.height;
                        setDragging(true);
                    }}
                />
            )}

            <header className="console-tabs">
                <button
                    type="button"
                    className="console-tab"
                    aria-selected={tab === "forwards"}
                    onClick={() => setDock({ tab: "forwards" })}
                >
                    <Icon.Forward size={12} />
                    Forwards
                    {activeForwards.length ? <span className="mono tab-badge">{activeForwards.length}</span> : null}
                </button>

                {terminals.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        className="console-tab"
                        aria-selected={tab === t.id}
                        onClick={() => setDock({ tab: t.id })}
                        title={t.title}
                    >
                        <Icon.Terminal size={12} />
                        <span className="truncate">{t.title}</span>
                        <span
                            className="console-x"
                            role="button"
                            tabIndex={-1}
                            aria-label={`Close ${t.title}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                closeTerminal(t.id);
                            }}
                        >
                            <Icon.Close size={10} />
                        </span>
                    </button>
                ))}

                {canExec ? (
                    <button
                        type="button"
                        className="console-tab add"
                        title="New local shell"
                        onClick={() => openTerminal({ kind: "local", title: `shell · ${context}`, context })}
                    >
                        <Icon.Plus size={12} />
                    </button>
                ) : null}

                <div className="spring" />
                <button
                    className="btn ghost icon sm"
                    type="button"
                    title={expanded ? "Restore" : "Full screen"}
                    onClick={() => setExpanded((v) => !v)}
                >
                    {expanded ? <Icon.Collapse size={12} /> : <Icon.Expand size={12} />}
                </button>
                <button
                    className="btn ghost icon sm"
                    type="button"
                    onClick={() => setDock({ open: false })}
                    title="Hide console (⌘J)"
                >
                    <Icon.Close size={12} />
                </button>
            </header>

            <div className="console-body">
                <div className="console-pane" hidden={tab !== "forwards"}>
                    <ForwardList />
                </div>
                {terminals.map((t) => (
                    <div className="console-pane" key={t.id} hidden={tab !== t.id}>
                        <TerminalPane session={t} active={tab === t.id} onExit={() => undefined} />
                    </div>
                ))}
            </div>
        </section>,
        document.body,
    );
}

function ForwardList() {
    const forwards = useApp((s) => s.forwards);
    const rows = forwards.filter((f) => f.status !== "stopped");

    if (rows.length === 0) {
        return (
            <Empty
                title="No port-forwards"
                hint="Right-click a pod or service and choose Port-forward. Forwards keep running while digg serve is up, even if you close this tab."
            />
        );
    }

    return (
        <div className="fwd-list">
            {rows.map((f) => (
                <div className="fwd" key={f.id}>
                    <Badge tone={f.status === "active" ? "ok" : f.status === "failed" ? "bad" : "warn"}>{f.status}</Badge>
                    <span className="mono fwd-target truncate">
                        {f.namespace ? `${f.namespace}/` : ""}
                        {f.kind.replace(/s$/, "")}/{f.name}
                    </span>
                    <span className="mono fwd-ports">
                        {f.localPort ?? "?"} → {f.remotePort}
                    </span>
                    {f.url ? (
                        <a className="fwd-url mono" href={f.url} target="_blank" rel="noreferrer">
                            {f.url}
                        </a>
                    ) : (
                        <span className="faint mono truncate">{f.error}</span>
                    )}
                    <span className="spring" />
                    <span className="faint mono">{ageFromMs(f.startedAt)}</span>
                    <button
                        className="btn sm ghost"
                        type="button"
                        onClick={async () => {
                            try {
                                await api.stopForward(f.id);
                                setState((s) => ({ forwards: s.forwards.filter((x) => x.id !== f.id) }));
                                toast("ok", "Forward stopped");
                            } catch (err) {
                                toast("bad", "Could not stop", err instanceof Error ? err.message : String(err));
                            }
                        }}
                    >
                        Stop
                    </button>
                </div>
            ))}
        </div>
    );
}

/**
 * A resource, full page.
 *
 * Aptakube's model, not Lens's drawer: an object gets the whole canvas, so YAML
 * and logs are readable without a resize handle, and it is a real URL you can
 * paste. esc goes back to the table you came from.
 *
 * Which tab you are on lives in the query string (`?tab=yaml`), so a reload,
 * the back button and a shared link all land on the same thing. Terminals do
 * NOT live here — they are in the global console popover, because a shell has
 * to outlive the page you opened it from.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/icons.tsx";
import { Badge, CopyButton, ErrorBox, Facts, Menu, Tabs } from "../components/ui.tsx";
import { LogPane } from "../components/LogPane.tsx";
import { TextPane, YamlEditor } from "../components/YamlEditor.tsx";
import { DataTab } from "./DataTab.tsx";
import { api } from "../lib/api.ts";
import { act, minePorts, openForward, openScale, resourceActions } from "../lib/actions.tsx";
import { ageFromIso, toneOf } from "../lib/format.ts";
import { usePolled } from "../lib/hooks.ts";
import { useContainer, useTab } from "../lib/query.ts";
import { goBack, navigate } from "../lib/router.ts";
import { getState, openTerminal, toast, useApp } from "../lib/store.ts";
import type { ResourceRef } from "../lib/types.ts";
import "./DetailPage.css";

const LOGGABLE = new Set(["pods", "deployments", "statefulsets", "daemonsets", "jobs", "replicasets"]);
/** Kinds whose whole point is their key/value data. */
const DATA_KINDS = new Set(["configmaps", "secrets"]);
const SCALABLE = new Set(["deployments", "statefulsets", "replicasets"]);
const RESTARTABLE = new Set(["deployments", "statefulsets", "daemonsets"]);

/** Current replica count, mined from the summary so Scale opens pre-filled. */
function replicasOf(data: { summary: [string, string][] } | null): number {
    for (const [k, v] of data?.summary ?? []) {
        if (k.toLowerCase() !== "replicas") continue;
        const m = /(\d+)\s*desired/.exec(v) ?? /^(\d+)/.exec(v);
        if (m) return Number(m[1]);
    }
    return 1;
}

export function DetailPage({
    target,
    onOpen,
}: {
    target: ResourceRef;
    onOpen: (ref: ResourceRef, tab?: string) => void;
}) {
    const context = useApp((s) => s.context);
    const canExec = useApp((s) => s.canExec);
    const [tab, setTab] = useTab();
    const [container, setContainer] = useContainer();

    const { data, error } = usePolled(
        () => api.detail({ context, kind: target.kind, name: target.name, ns: target.ns }),
        [context, target.kind, target.name, target.ns],
    );

    const back = useCallback(() => goBack({ page: "list", kind: target.kind }), [target.kind]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // A dialog or the palette on top owns esc first.
            if (e.key !== "Escape" || document.querySelector(".overlay")) return;
            back();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [back]);

    const containers = useMemo(() => {
        if (data?.section?.title?.toLowerCase().includes("container")) {
            return data.section.rows.map((r) => r[0] ?? "").filter(Boolean);
        }
        return [];
    }, [data]);

    const canLogs = data?.canLogs || LOGGABLE.has(target.kind);
    const hasData = DATA_KINDS.has(target.kind);
    const tabs = [
        { id: "overview", label: "Overview" },
        // Data comes before YAML: for a ConfigMap or Secret it IS the object,
        // and the raw manifest is the fallback view, not the main one.
        ...(hasData ? [{ id: "data", label: "Data", badge: data?.section?.dataKeys?.keys.length }] : []),
        { id: "yaml", label: "YAML" },
        { id: "describe", label: "Describe" },
        { id: "events", label: "Events", badge: data?.events.length || undefined },
        ...(canLogs ? [{ id: "logs", label: "Logs" }] : []),
    ];

    return (
        <div className="page detail">
            <header className="detail-head">
                <button className="btn ghost sm backbtn" type="button" onClick={back} title="Back (esc)">
                    <span className="backarrow">
                        <Icon.Chevron size={12} />
                    </span>
                    {data?.kind.title ?? target.kind}
                </button>

                <div className="detail-id">
                    <h1 className="mono truncate">{target.name}</h1>
                    {target.ns ? (
                        <button
                            className="detail-ns mono"
                            type="button"
                            title={`Filter to ${target.ns}`}
                            onClick={() => navigate({ page: "list", kind: target.kind })}
                        >
                            {target.ns}
                        </button>
                    ) : null}
                </div>

                <div className="spring" />

                {SCALABLE.has(target.kind) ? (
                    <button className="btn sm" type="button" onClick={() => openScale(target, replicasOf(data))}>
                        <Icon.Scale size={12} /> Scale
                    </button>
                ) : null}
                {RESTARTABLE.has(target.kind) ? (
                    <button
                        className="btn sm"
                        type="button"
                        title="Roll every pod of this workload"
                        onClick={() => void act({ action: "restart", ref: target })}
                    >
                        <Icon.Restart size={12} /> Restart
                    </button>
                ) : null}
                {(target.kind === "pods" || target.kind === "nodes") && canExec ? (
                    <button
                        className="btn sm"
                        type="button"
                        title="Open a shell in the console"
                        onClick={() =>
                            openTerminal(
                                target.kind === "nodes"
                                    ? { kind: "node", title: target.name, context, node: target.name }
                                    : {
                                          kind: "container",
                                          title: target.name,
                                          context,
                                          ns: target.ns,
                                          pod: target.name,
                                          container: containers[0],
                                      },
                            )
                        }
                    >
                        <Icon.Terminal size={12} /> Shell
                    </button>
                ) : null}

                <Menu
                    align="right"
                    trigger={({ toggle }) => (
                        <button className="btn sm" type="button" onClick={toggle}>
                            Actions <Icon.ChevronDown size={11} />
                        </button>
                    )}
                    items={resourceActions(target, { kind: target.kind, open: (ref, t) => onOpen(ref, t) })}
                />
            </header>

            <Tabs tabs={tabs} active={tab} onChange={(id) => void setTab(id)} />

            {error ? <ErrorBox error={error} /> : null}

            <div className="detail-body">
                {tab === "overview" ? (
                    <OverviewTab data={data} onOpen={onOpen} target={target} />
                ) : tab === "data" && hasData ? (
                    <DataTab target={target} />
                ) : tab === "yaml" ? (
                    <YamlTab target={target} />
                ) : tab === "describe" ? (
                    <DescribeTab target={target} />
                ) : tab === "events" ? (
                    <EventsTab events={data?.events ?? []} />
                ) : tab === "logs" ? (
                    <LogPane
                        target={{ context, kind: target.kind, name: target.name, ns: target.ns, containers }}
                        container={container}
                        onContainer={(c) => void setContainer(c)}
                    />
                ) : null}
            </div>
        </div>
    );
}

function OverviewTab({
    data,
    target,
    onOpen,
}: {
    data: Awaited<ReturnType<typeof api.detail>> | null;
    target: ResourceRef;
    onOpen: (ref: ResourceRef, tab?: string) => void;
}) {
    const [revealed, setRevealed] = useState<Record<string, string>>({});
    const context = getState().context;

    if (!data) {
        return (
            <div className="page-loading">
                <span className="spinner" /> Loading…
            </div>
        );
    }

    const facts: [string, React.ReactNode][] = data.summary.map(([k, v]) => {
        const tone = toneOf(v);
        return [k, tone === "neutral" ? <span className="mono">{v}</span> : <Badge tone={tone}>{v}</Badge>];
    });

    const section = data.section;

    return (
        <div className="detail-scroll">
            <Facts rows={facts} />

            {section ? (
                <section className="detail-section">
                    <header className="detail-section-head">
                        <h3>{section.title}</h3>
                        <span className="mono faint">{section.rows.length}</span>
                    </header>
                    {section.dataKeys ? (
                        <div className="keylist">
                            {section.dataKeys.keys.map((key) => (
                                <div className="keyrow" key={key}>
                                    <button
                                        type="button"
                                        className="keyname mono"
                                        onClick={async () => {
                                            if (revealed[key]) {
                                                setRevealed((r) => {
                                                    const next = { ...r };
                                                    delete next[key];
                                                    return next;
                                                });
                                                return;
                                            }
                                            try {
                                                const res = await api.dataKey({
                                                    context,
                                                    kind: target.kind,
                                                    name: target.name,
                                                    ns: target.ns,
                                                    key,
                                                    decode: section.dataKeys?.decode,
                                                });
                                                setRevealed((r) => ({ ...r, [key]: res.text }));
                                            } catch (err) {
                                                toast("bad", "Could not read key", err instanceof Error ? err.message : String(err));
                                            }
                                        }}
                                    >
                                        {revealed[key] ? "▾" : "▸"} {key}
                                    </button>
                                    {revealed[key] !== undefined ? (
                                        <>
                                            <CopyButton text={revealed[key]!} />
                                            <pre className="keyval mono">{revealed[key]}</pre>
                                        </>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : section.rows.length === 0 ? (
                        <div className="detail-empty faint">nothing here</div>
                    ) : (
                        <div className="minitable">
                            <div className="mt-head" style={{ gridTemplateColumns: `repeat(${section.columns.length}, minmax(0, 1fr))` }}>
                                {section.columns.map((c) => (
                                    <span key={c}>{c}</span>
                                ))}
                            </div>
                            {section.rows.map((row, i) => {
                                const drill = section.drill?.[i];
                                const toneCol = section.tones?.[i];
                                return (
                                    <div
                                        className={`mt-row ${drill ? "clickable" : ""}`}
                                        key={i}
                                        style={{ gridTemplateColumns: `repeat(${section.columns.length}, minmax(0, 1fr))` }}
                                        onClick={() => drill && onOpen({ kind: drill.kind, name: drill.name, ns: drill.ns })}
                                    >
                                        {row.map((cell, j) => {
                                            const tone =
                                                typeof toneCol === "number" && toneCol === j ? sectionTone(cell) : "neutral";
                                            // A cell that is a URL is a thing you
                                            // want to open — an ingress route is
                                            // useless if you have to retype it.
                                            if (/^https?:\/\//.test(cell)) {
                                                return (
                                                    <a
                                                        key={j}
                                                        className="mono truncate"
                                                        href={cell}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        title={cell}
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        {cell}
                                                    </a>
                                                );
                                            }
                                            return (
                                                <span
                                                    key={j}
                                                    className={`mono truncate ${tone !== "neutral" ? `t-${tone}` : ""}`}
                                                    title={cell}
                                                >
                                                    {cell}
                                                </span>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>
            ) : null}

            {target.kind === "services" || target.kind === "pods" ? (
                <div className="detail-actionrow">
                    <button className="btn sm" type="button" onClick={() => openForward(target, data ? minePorts(data.summary) : [])}>
                        <Icon.Forward size={12} /> Port-forward
                    </button>
                </div>
            ) : null}

            <section className="detail-section">
                <header className="detail-section-head">
                    <h3>Events</h3>
                    <span className="mono faint">{data.events.length}</span>
                </header>
                <EventsTab events={data.events} compact />
            </section>
        </div>
    );
}

/**
 * Tone for a section cell. Beyond the shared status words, the ingress routing
 * table reports backend health in prose ("no endpoints"), and those read as
 * broken even though no Kubernetes phase is involved.
 */
function sectionTone(cell: string): ReturnType<typeof toneOf> {
    const v = cell.toLowerCase();
    if (v === "no such service") return "bad";
    if (v === "no endpoints") return "warn";
    if (/^\d+ endpoints?$/.test(v)) return "ok";
    return toneOf(cell);
}

function EventsTab({ events, compact }: { events: { type: string; reason: string; message: string; count: number; lastSeen: string; source: string }[]; compact?: boolean }) {
    if (events.length === 0) {
        return <div className={`detail-empty faint ${compact ? "" : "pad"}`}>no events for this object</div>;
    }
    return (
        <div className={`evlist ${compact ? "compact" : ""}`}>
            {events.map((e, i) => (
                <div className={`ev ${e.type === "Warning" ? "warn" : ""}`} key={i}>
                    <Badge tone={e.type === "Warning" ? "warn" : "idle"}>{e.reason}</Badge>
                    <span className="ev-body">{e.message}</span>
                    <span className="faint mono ev-meta">
                        {e.count > 1 ? `×${e.count} · ` : ""}
                        {ageFromIso(e.lastSeen)}
                    </span>
                </div>
            ))}
        </div>
    );
}

function YamlTab({ target }: { target: ResourceRef }) {
    const context = getState().context;
    const [text, setText] = useState<string | null>(null);
    const [buffer, setBuffer] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dirty = text !== null && buffer !== text;

    useEffect(() => {
        let live = true;
        setText(null);
        void api
            .yaml({ context, kind: target.kind, name: target.name, ns: target.ns })
            .then((r) => {
                if (!live) return;
                setText(r.text);
                setBuffer(r.text);
            })
            .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
        return () => {
            live = false;
        };
    }, [context, target.kind, target.name, target.ns]);

    const apply = async () => {
        setBusy(true);
        const ok = await act({ action: "apply", yaml: buffer }, "applied");
        setBusy(false);
        if (ok) setText(buffer);
    };

    if (error) return <ErrorBox error={error} />;
    if (text === null) {
        return (
            <div className="page-loading">
                <span className="spinner" /> Reading YAML…
            </div>
        );
    }

    return (
        <div className="yamltab">
            <div className="yaml-bar">
                {dirty ? (
                    <span className="badge warn">
                        <span className="dot warn" /> unsaved
                    </span>
                ) : (
                    <span className="faint">in sync with cluster</span>
                )}
                <div className="spring" />
                <CopyButton text={buffer} />
                <button className="btn sm" type="button" disabled={!dirty || busy} onClick={() => setBuffer(text)}>
                    Revert
                </button>
                <button className="btn sm primary" type="button" disabled={!dirty || busy} onClick={() => void apply()}>
                    {busy ? "Applying…" : "Apply"} <kbd>⌘S</kbd>
                </button>
            </div>
            <YamlEditor value={buffer} onChange={setBuffer} onSave={() => dirty && void apply()} />
        </div>
    );
}

function DescribeTab({ target }: { target: ResourceRef }) {
    const context = getState().context;
    const { data, error } = usePolled(
        () => api.describe({ context, kind: target.kind, name: target.name, ns: target.ns }),
        [context, target.kind, target.name, target.ns],
    );
    if (error) return <ErrorBox error={error} />;
    if (!data) {
        return (
            <div className="page-loading">
                <span className="spinner" /> Describing…
            </div>
        );
    }
    return <TextPane text={data.text} />;
}

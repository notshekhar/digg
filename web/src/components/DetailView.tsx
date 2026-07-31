/**
 * The rich resource page: identity card, fact groups, container cards, pods.
 *
 * The server sends a model (src/detail-view.ts), never markup, so this file is
 * only ever deciding how to draw four things: a fact, a chip, a gauge and a pod
 * row. Every kind that gets a rich page reuses those four.
 */

import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";
import { Badge } from "./ui.tsx";
import { ageFromIso, formatBytes, formatCpu } from "../lib/format.ts";
import type { ContainerView, DetailView, Fact, FactGroup, Gauge, PodLine, ResourceRef } from "../lib/types.ts";
import "./DetailView.css";

/**
 * A gauge as a percentage.
 *
 * With a limit set, the bar is usage against that limit — the line the kernel
 * actually enforces. Without one there is no ceiling to draw against, so the
 * bar falls back to the larger of usage and request and reads as "how much of
 * what it asked for is it using", never as a fraction of an invented total.
 */
function gaugePct(g: Gauge): { pct: number | null; mark: number | null } {
    const ceiling = g.limits > 0 ? g.limits : Math.max(g.used ?? 0, g.requests) * 1.15;
    if (ceiling <= 0) return { pct: g.used === null ? null : 0, mark: null };
    return {
        pct: g.used === null ? null : Math.min(100, (g.used / ceiling) * 100),
        mark: g.requests > 0 ? Math.min(100, (g.requests / ceiling) * 100) : null,
    };
}

function Bar({ gauge }: { gauge: Gauge }) {
    const { pct, mark } = gaugePct(gauge);
    const tone = pct === null ? "unknown" : pct >= 90 ? "bad" : pct >= 75 ? "warn" : "ok";
    return (
        <span className={`gauge ${pct === null ? "unknown" : ""}`}>
            {pct !== null ? <span className={`gauge-fill ${tone}`} style={{ width: `${pct}%` }} /> : null}
            {mark !== null && mark > 0 ? <span className="gauge-mark" style={{ left: `${mark}%` }} title="requested" /> : null}
        </span>
    );
}

/** A number with its unit set smaller, the way kubectl-ish quantities read. */
function Quantity({ text }: { text: string }) {
    const m = /^([\d.]+)(\D*)$/.exec(text);
    if (!m) return <span className="qty">{text}</span>;
    return (
        <span className="qty">
            {m[1]}
            <span className="qty-unit">{m[2]}</span>
        </span>
    );
}

const cpuText = (n: number | null) => (n === null ? "—" : formatCpu(n));
const memText = (n: number | null) => (n === null ? "—" : formatBytes(n));

function FactValue({ fact, onOpen }: { fact: Fact; onOpen: (ref: ResourceRef) => void }) {
    // Each ref carries where the spec reached it from, set beside the name
    // rather than hidden in a tooltip: with six ConfigMaps under one label, the
    // one you want is identified by "env DB_HOST", not by its name.
    if (fact.refs) {
        if (!fact.refs.length) return <span className="faint">-</span>;
        return (
            <span className="reflinks">
                {fact.refs.map((r, i) => (
                    <button
                        type="button"
                        className="reflink"
                        key={`${r.kind}/${r.name}-${i}`}
                        title={`${r.kind}/${r.name}${r.via ? ` — ${r.via}` : ""}`}
                        onClick={() => onOpen({ kind: r.kind, name: r.name, ns: r.ns })}
                    >
                        <span className="reflink-name mono">{r.name}</span>
                        {r.via ? <span className="reflink-via mono">{r.via}</span> : null}
                    </button>
                ))}
            </span>
        );
    }
    if (fact.chips) {
        if (!fact.chips.length) return <span className="faint">-</span>;
        return (
            <span className="chips">
                {fact.chips.map((c, i) => (
                    <span className={`chip ${c.tone ?? ""}`} key={i}>
                        {c.k ? <span className="chip-k mono">{c.k}:</span> : null}
                        <span className="chip-v mono">{c.v}</span>
                    </span>
                ))}
            </span>
        );
    }
    if (fact.items) {
        if (!fact.items.length) return <span className="faint">-</span>;
        return (
            <span className="factlines">
                {fact.items.map((line, i) => (
                    <span className="factline mono" key={i}>
                        {line}
                    </span>
                ))}
            </span>
        );
    }
    if (!fact.text) return <span className="faint">-</span>;
    if (fact.ref) {
        return (
            <button type="button" className="link mono" onClick={() => onOpen(fact.ref!)}>
                {fact.text}
            </button>
        );
    }
    if (fact.tone && fact.tone !== "neutral") {
        return <Badge tone={fact.tone}>{fact.text}</Badge>;
    }
    return <span className="mono">{fact.text}</span>;
}

function FactList({ group, onOpen, boxed }: { group: FactGroup; onOpen: (ref: ResourceRef) => void; boxed?: boolean }) {
    return (
        <div className={`factgrid ${boxed ? "boxed" : ""}`}>
            {group.facts.map((f, i) => (
                <div className={`factcell ${f.wide ? "wide" : ""}`} key={`${f.label}-${i}`}>
                    <div className="factlabel">{f.label}</div>
                    <div className="factvalue">
                        <FactValue fact={f} onOpen={onOpen} />
                    </div>
                </div>
            ))}
        </div>
    );
}

function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
    return (
        <section className="vsection">
            <header className="vsection-head">
                <h2>{title}</h2>
                {note ? <span className="faint vsection-note">{note}</span> : null}
            </header>
            {children}
        </section>
    );
}

function ContainerCard({
    c,
    onShell,
    onLogs,
}: {
    c: ContainerView;
    onShell?: (container: string) => void;
    onLogs?: (container: string) => void;
}) {
    return (
        <article className="ccard">
            <header className="ccard-head">
                <span className="ccard-title">
                    <Icon.Box size={12} />
                    <span className="mono">{c.name}</span>
                    {c.init ? <span className="tag">init</span> : null}
                </span>
                <span className="ccard-image mono truncate" title={c.image}>
                    {c.image}
                </span>
            </header>

            {c.state || c.ready !== undefined ? (
                <div className="ccard-status">
                    <div className="ccard-statusrow">
                        <div>
                            <div className="factlabel">Status</div>
                            <div className="statuswords">
                                <span className={`t-${c.stateTone ?? "neutral"}`}>{c.state ?? "—"}</span>
                                {c.started ? <span className="t-ok">Started</span> : null}
                                {c.ready ? <span className="t-ok">Ready</span> : c.ready === false ? <span className="t-warn">Not ready</span> : null}
                            </div>
                        </div>
                        <div className="ccard-actions">
                            {onLogs ? (
                                <button className="btn ghost sm" type="button" onClick={() => onLogs(c.name)} title="Logs">
                                    <Icon.Logs size={12} />
                                </button>
                            ) : null}
                            {onShell ? (
                                <button className="btn ghost sm" type="button" onClick={() => onShell(c.name)} title="Shell">
                                    <Icon.Terminal size={12} />
                                </button>
                            ) : null}
                        </div>
                    </div>
                    <div className="ccard-restarts">
                        <div>
                            <div className="factlabel">Restart Reason</div>
                            <div className="mono">{c.restartReason || "-"}</div>
                        </div>
                        <div>
                            <div className="factlabel">Last Restart</div>
                            <div className="mono">{c.lastRestart ? ageFromIso(c.lastRestart) : "-"}</div>
                        </div>
                        <div>
                            <div className="factlabel">Restarts</div>
                            <div className="mono">{c.restarts ?? 0}</div>
                        </div>
                    </div>
                </div>
            ) : null}

            <div className="ccard-usage">
                <div className="usebox">
                    <div className="usehead">
                        <span className="uselabel">
                            <Icon.Cpu size={12} /> CPU Usage
                        </span>
                        <Quantity text={cpuText(c.cpu.used)} />
                    </div>
                    <Bar gauge={c.cpu} />
                    <div className="alloc">
                        <div className="alloc-title">Allocation</div>
                        <div className="alloc-row">
                            <span>Requests:</span>
                            <Quantity text={c.cpu.requests ? formatCpu(c.cpu.requests) : "-"} />
                        </div>
                        <div className="alloc-row">
                            <span>Limits:</span>
                            <Quantity text={c.cpu.limits ? formatCpu(c.cpu.limits) : "-"} />
                        </div>
                    </div>
                </div>
                <div className="usebox">
                    <div className="usehead">
                        <span className="uselabel">
                            <Icon.Memory size={12} /> Memory Usage
                        </span>
                        <Quantity text={memText(c.mem.used)} />
                    </div>
                    <Bar gauge={c.mem} />
                    <div className="alloc">
                        <div className="alloc-title">Allocation</div>
                        <div className="alloc-row">
                            <span>Requests:</span>
                            <Quantity text={c.mem.requests ? formatBytes(c.mem.requests) : "-"} />
                        </div>
                        <div className="alloc-row">
                            <span>Limits:</span>
                            <Quantity text={c.mem.limits ? formatBytes(c.mem.limits) : "-"} />
                        </div>
                    </div>
                </div>
            </div>

            {c.ports ? (
                <footer className="ccard-foot">
                    <span className="factlabel">Ports</span>
                    <span className="mono">{c.ports}</span>
                </footer>
            ) : null}
        </article>
    );
}

const POD_COLUMNS = [
    "NAME",
    "READY",
    "STATUS",
    "CPU USAGE",
    "MEMORY USAGE",
    "RESTARTS",
    "LAST RESTART",
    "LAST RESTART REASON",
    "NODE",
];

function PodsTable({ rows, onOpen }: { rows: PodLine[]; onOpen: (ref: ResourceRef) => void }) {
    if (!rows.length) return <div className="detail-empty faint">no pods</div>;
    return (
        <div className="podtable">
            <div className="podtable-head">
                {POD_COLUMNS.map((c) => (
                    <span key={c}>{c}</span>
                ))}
            </div>
            {rows.map((p) => (
                <div className="podtable-row" key={`${p.ns}/${p.name}`}>
                    <button
                        type="button"
                        className="link mono truncate"
                        title={p.name}
                        onClick={() => onOpen({ kind: "pods", name: p.name, ns: p.ns })}
                    >
                        {p.name}
                    </button>
                    <span className={`mono t-${p.ready.split("/")[0] === p.ready.split("/")[1] ? "ok" : "warn"}`}>{p.ready}</span>
                    <span className={`mono t-${p.tone}`}>{p.status}</span>
                    <span className="cellgauge">
                        <Quantity text={cpuText(p.cpu.used)} />
                        <Bar gauge={p.cpu} />
                    </span>
                    <span className="cellgauge">
                        <Quantity text={memText(p.mem.used)} />
                        <Bar gauge={p.mem} />
                    </span>
                    <span className="mono">{p.restarts}</span>
                    <span className="mono">{p.lastRestart ? ageFromIso(p.lastRestart) : "-"}</span>
                    <span className="mono truncate" title={p.lastRestartReason}>
                        {p.lastRestartReason || "-"}
                    </span>
                    {p.node ? (
                        <button type="button" className="link mono truncate" onClick={() => onOpen({ kind: "nodes", name: p.node })}>
                            {p.node}
                        </button>
                    ) : (
                        <span className="faint">-</span>
                    )}
                </div>
            ))}
        </div>
    );
}

export function DetailViewPane({
    view,
    onOpen,
    onShell,
    onLogs,
}: {
    view: DetailView;
    onOpen: (ref: ResourceRef) => void;
    onShell?: (container: string) => void;
    onLogs?: (container: string) => void;
}) {
    const pods = view.pods;
    return (
        <>
            <FactList group={view.header} onOpen={onOpen} boxed />

            {view.groups.map((g, i) =>
                g.title ? (
                    <Section title={g.title} key={i}>
                        <FactList group={g} onOpen={onOpen} />
                    </Section>
                ) : (
                    <FactList group={g} onOpen={onOpen} key={i} />
                ),
            )}

            {view.containers.length ? (
                <Section title="Containers" note={view.containersNote}>
                    <div className="ccards">
                        {view.containers.map((c) => (
                            <ContainerCard key={`${c.init ? "init:" : ""}${c.name}`} c={c} onShell={onShell} onLogs={onLogs} />
                        ))}
                    </div>
                </Section>
            ) : null}

            {pods ? (
                <Section title="Pods">
                    <div className="podcounts">
                        <span>
                            <strong className="mono">{pods.desired}</strong> desired
                        </span>
                        <span>
                            <strong className="mono">{pods.updated}</strong> updated
                        </span>
                        <span>
                            <strong className="mono">{pods.ready}</strong> ready
                        </span>
                        <span>
                            <strong className="mono">{pods.available}</strong> available
                        </span>
                    </div>
                    <PodsTable rows={pods.rows} onOpen={onOpen} />
                </Section>
            ) : null}
        </>
    );
}

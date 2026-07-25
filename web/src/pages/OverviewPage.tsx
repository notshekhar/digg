/**
 * Cluster overview — the glance screen.
 *
 * Order is the argument: capacity first (can this cluster take more work),
 * then anything unhealthy (what is broken right now), then nodes, then the
 * warning stream. Counts are clickable and land on the filtered list, because
 * "3 pods not running" is only useful if it takes one click to see which.
 */

import { Icon } from "../components/icons.tsx";
import { Badge, Empty, ErrorBox, Meter, Panel, Stat } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { formatBytes, formatCpu, ageFromIso } from "../lib/format.ts";
import { usePolled } from "../lib/hooks.ts";
import { navigate } from "../lib/router.ts";
import { useApp } from "../lib/store.ts";
import type { ResourceRef } from "../lib/types.ts";
import "./OverviewPage.css";

export function OverviewPage({ onOpen }: { onOpen: (ref: ResourceRef, tab?: string) => void }) {
    const context = useApp((s) => s.context);
    const { data, error, initial } = usePolled(() => api.overview(context), [context], { enabled: Boolean(context) });

    if (error) return <ErrorBox error={error} />;
    if (!data) {
        return (
            <div className="page-loading">
                <span className="spinner" /> Reading cluster…
            </div>
        );
    }

    const t = data.totals;
    const running = t.podPhases.Running ?? 0;
    const notRunning = t.pods - running - (t.podPhases.Succeeded ?? 0);
    const cpuPct = t.cpuUsed === null ? null : (t.cpuUsed / Math.max(t.cpuCapacity, 0.001)) * 100;
    const memPct = t.memUsed === null ? null : (t.memUsed / Math.max(t.memCapacity, 1)) * 100;

    return (
        <div className="page overview">
            <div className="toolbar">
                <div className="toolbar-title">
                    <h1>{data.context}</h1>
                    <span className="count mono">{data.version.server}</span>
                </div>
                <div className="spring" />
                {!data.metricsAvailable ? (
                    <span className="faint" title="Install metrics-server for live CPU and memory">
                        no metrics-server — usage unavailable
                    </span>
                ) : null}
                {initial ? <span className="spinner" /> : null}
            </div>

            <div className="overview-scroll">
                <div className="stat-row">
                    <Stat
                        label="Nodes"
                        value={`${t.nodesReady}/${t.nodes}`}
                        sub={t.nodesReady === t.nodes ? "all ready" : "not all ready"}
                        tone={t.nodesReady === t.nodes ? "ok" : "bad"}
                        onClick={() => navigate({ page: "list", kind: "nodes" })}
                    />
                    <Stat
                        label="Pods"
                        value={t.pods}
                        sub={`${running} running · ${t.containers} containers`}
                        onClick={() => navigate({ page: "list", kind: "pods" })}
                    />
                    <Stat
                        label="Not running"
                        value={notRunning}
                        tone={notRunning === 0 ? "ok" : notRunning > 5 ? "bad" : "warn"}
                        sub={Object.entries(t.podPhases)
                            .filter(([p]) => p !== "Running")
                            .map(([p, n]) => `${n} ${p.toLowerCase()}`)
                            .join(" · ") || "everything is running"}
                        onClick={() => navigate({ page: "list", kind: "pods" })}
                    />
                    <Stat
                        label="Restarts"
                        value={t.restarts}
                        tone={t.restarts === 0 ? "ok" : t.restarts > 50 ? "bad" : "warn"}
                        sub="across all containers"
                    />
                    <Stat
                        label="Namespaces"
                        value={t.namespaces}
                        onClick={() => navigate({ page: "list", kind: "namespaces" })}
                    />
                </div>

                <div className="grid-2">
                    <Panel title="Capacity">
                        <div className="capacity">
                            <Meter
                                value={cpuPct}
                                mark={(t.cpuRequested / Math.max(t.cpuCapacity, 0.001)) * 100}
                                label="CPU"
                                sub={
                                    t.cpuUsed === null
                                        ? `${formatCpu(t.cpuRequested)} requested of ${formatCpu(t.cpuCapacity)}`
                                        : `${formatCpu(t.cpuUsed)} used · ${formatCpu(t.cpuRequested)} requested · ${formatCpu(t.cpuCapacity)} total`
                                }
                            />
                            <Meter
                                value={memPct}
                                mark={(t.memRequested / Math.max(t.memCapacity, 1)) * 100}
                                label="Memory"
                                sub={
                                    t.memUsed === null
                                        ? `${formatBytes(t.memRequested)} requested of ${formatBytes(t.memCapacity)}`
                                        : `${formatBytes(t.memUsed)} used · ${formatBytes(t.memRequested)} requested · ${formatBytes(t.memCapacity)} total`
                                }
                            />
                            <div className="legend faint">
                                <span className="legend-mark" /> requested
                            </div>
                        </div>
                    </Panel>

                    <Panel title="Workloads">
                        <div className="workloads">
                            {data.workloads.map((w) => (
                                <button
                                    key={w.kind}
                                    type="button"
                                    className="workload"
                                    onClick={() => navigate({ page: "list", kind: w.kind })}
                                >
                                    <span className="wl-name">{w.kind}</span>
                                    <span className="spring" />
                                    <span className={`mono ${w.ready === w.total ? "t-ok" : "t-warn"}`}>
                                        {w.ready}/{w.total}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </Panel>
                </div>

                {data.problems.length > 0 ? (
                    <Panel
                        title={
                            <span className="row">
                                <Icon.Warn size={13} /> Needs attention
                                <span className="mono faint">{data.problems.length}</span>
                            </span>
                        }
                        flush
                    >
                        <div className="rowlist">
                            {data.problems.map((p) => (
                                <button
                                    key={`${p.namespace}/${p.object}`}
                                    type="button"
                                    className="rowitem"
                                    onClick={() => onOpen({ kind: "pods", name: p.object, ns: p.namespace })}
                                >
                                    <Badge tone="bad">{p.reason}</Badge>
                                    <span className="mono name truncate">
                                        {p.namespace}/{p.object}
                                    </span>
                                    <span className="msg truncate faint">{p.message}</span>
                                </button>
                            ))}
                        </div>
                    </Panel>
                ) : null}

                <Panel title={`Nodes (${data.nodes.length})`} flush>
                    <div className="nodecards">
                        {data.nodes.map((n) => (
                            <button
                                key={n.name}
                                type="button"
                                className="nodecard"
                                onClick={() => onOpen({ kind: "nodes", name: n.name })}
                            >
                                <div className="nodecard-head">
                                    <Icon.Node size={13} />
                                    <span className="mono name truncate">{n.name}</span>
                                    <div className="spring" />
                                    {!n.schedulable ? <Badge tone="warn">cordoned</Badge> : null}
                                    <Badge tone={n.ready ? "ok" : "bad"}>{n.ready ? "Ready" : "NotReady"}</Badge>
                                </div>
                                <div className="nodecard-meta faint mono">
                                    {n.roles} · {n.version} · {n.pods}/{n.podCapacity} pods · {n.age}
                                </div>
                                <Meter
                                    value={n.cpu.usedPercent}
                                    mark={(n.cpu.requested / Math.max(n.cpu.capacity, 0.001)) * 100}
                                    label="CPU"
                                    sub={
                                        n.cpu.used === null
                                            ? `${formatCpu(n.cpu.requested)} req / ${formatCpu(n.cpu.capacity)}`
                                            : `${formatCpu(n.cpu.used)} / ${formatCpu(n.cpu.capacity)}`
                                    }
                                />
                                <Meter
                                    value={n.memory.usedPercent}
                                    mark={(n.memory.requested / Math.max(n.memory.capacity, 1)) * 100}
                                    label="Memory"
                                    sub={
                                        n.memory.used === null
                                            ? `${formatBytes(n.memory.requested)} req / ${formatBytes(n.memory.capacity)}`
                                            : `${formatBytes(n.memory.used)} / ${formatBytes(n.memory.capacity)}`
                                    }
                                />
                            </button>
                        ))}
                    </div>
                </Panel>

                <Panel
                    title={
                        <span className="row">
                            Recent warnings <span className="mono faint">{data.warnings.length}</span>
                        </span>
                    }
                    flush
                >
                    {data.warnings.length === 0 ? (
                        <Empty title="No warnings" hint="Nothing has complained recently." />
                    ) : (
                        <div className="rowlist">
                            {data.warnings.slice(0, 25).map((w, i) => (
                                <div className="rowitem static" key={`${w.object}-${i}`}>
                                    <Badge tone="warn">{w.reason}</Badge>
                                    <span className="mono name truncate">
                                        {w.namespace ? `${w.namespace}/` : ""}
                                        {w.object}
                                    </span>
                                    <span className="msg truncate faint">{w.message}</span>
                                    <span className="mono faint when">
                                        {w.count > 1 ? `×${w.count} · ` : ""}
                                        {ageFromIso(w.lastSeen)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </Panel>
            </div>
        </div>
    );
}

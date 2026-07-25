/**
 * The navigation rail: every kind in the cluster, grouped.
 *
 * Groups collapse and the state persists, because the useful shape of this list
 * is personal — someone living in Workloads wants Config and Access Control
 * folded away, and re-folding them on every page load is the fastest way to
 * make a sidebar annoying. The filter box searches kind titles, resource names
 * and short names at once, so typing "hpa" or "po" lands where you expect.
 */

import { useMemo, useState } from "react";
import { Icon } from "./icons.tsx";
import { navigate, type Route } from "../lib/router.ts";
import { useApp } from "../lib/store.ts";
import type { CatalogGroup } from "../lib/types.ts";
import "./Rail.css";

const GROUP_ICON: Record<string, (p: { size?: number }) => React.ReactElement> = {
    cluster: Icon.Cluster,
    workloads: Icon.Box,
    config: Icon.Sliders,
    network: Icon.Network,
    storage: Icon.Disk,
    access: Icon.Shield,
    definitions: Icon.Code,
    other: Icon.Layers,
};

function groupIcon(id: string) {
    if (id.startsWith("crd:")) return Icon.Code;
    return GROUP_ICON[id] ?? Icon.Layers;
}

const COLLAPSE_KEY = "digg.rail.collapsed";

function loadCollapsed(): Set<string> {
    try {
        const raw = localStorage.getItem(COLLAPSE_KEY);
        return new Set(raw ? (JSON.parse(raw) as string[]) : ["config", "access", "definitions", "other"]);
    } catch {
        return new Set();
    }
}

export function Rail({ route }: { route: Route }) {
    const catalog = useApp((s) => s.catalog);
    const version = useApp((s) => s.version);
    const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
    const [q, setQ] = useState("");

    const filtered: CatalogGroup[] = useMemo(() => {
        const needle = q.trim().toLowerCase();
        if (!needle) return catalog;
        return catalog
            .map((g) => ({
                ...g,
                kinds: g.kinds.filter(
                    (k) =>
                        k.title.toLowerCase().includes(needle) ||
                        k.name.toLowerCase().includes(needle) ||
                        k.shortNames.some((s) => s.toLowerCase().includes(needle)),
                ),
            }))
            .filter((g) => g.kinds.length > 0);
    }, [catalog, q]);

    const toggle = (id: string) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            try {
                localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
            } catch {
                /* private mode */
            }
            return next;
        });
    };

    const activeKind = route.page === "list" ? route.kind : "";

    return (
        <nav className="rail" aria-label="Resources">
            <div className="rail-brand">
                <span className="mark" />
                <span className="name">digg</span>
                <span className="ver mono">{version}</span>
            </div>

            <div className="rail-search">
                <div className="search">
                    <Icon.Search size={13} />
                    <input
                        placeholder="Filter resources…"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") setQ("");
                            if (e.key === "Enter") {
                                const first = filtered[0]?.kinds[0];
                                if (first) navigate({ page: "list", kind: first.name });
                            }
                        }}
                    />
                </div>
            </div>

            <div className="rail-scroll">
                <button
                    type="button"
                    className="navrow"
                    aria-current={route.page === "overview"}
                    onClick={() => navigate({ page: "overview" })}
                >
                    <Icon.Grid size={14} />
                    <span className="label">Overview</span>
                </button>
                <button
                    type="button"
                    className="navrow"
                    aria-current={route.page === "events"}
                    onClick={() => navigate({ page: "events" })}
                >
                    <Icon.Bolt size={14} />
                    <span className="label">Events</span>
                </button>

                {filtered.map((group) => {
                    const GroupIcon = groupIcon(group.id);
                    const isCollapsed = collapsed.has(group.id) && !q;
                    const hasActive = group.kinds.some((k) => k.name === activeKind);
                    return (
                        <div className="rail-group" key={group.id}>
                            <button
                                type="button"
                                className={`rail-group-head ${hasActive && isCollapsed ? "has-active" : ""}`}
                                onClick={() => toggle(group.id)}
                                aria-expanded={!isCollapsed}
                            >
                                <span className={`caret ${isCollapsed ? "" : "open"}`}>
                                    <Icon.Chevron size={10} />
                                </span>
                                <GroupIcon size={13} />
                                <span className="label truncate">{group.title}</span>
                                <span className="count mono">{group.kinds.length}</span>
                            </button>
                            {!isCollapsed && (
                                <div className="rail-kinds">
                                    {group.kinds.map((k) => (
                                        <button
                                            key={k.name}
                                            type="button"
                                            className="navrow kind"
                                            aria-current={k.name === activeKind}
                                            title={`${k.name}${k.apiVersion ? ` · ${k.apiVersion}` : ""}`}
                                            onClick={() => navigate({ page: "list", kind: k.name })}
                                        >
                                            <span className="label truncate">{k.title}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}

                {filtered.length === 0 ? <div className="rail-empty">no kind matches “{q}”</div> : null}
            </div>
        </nav>
    );
}

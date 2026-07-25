/**
 * ⌘K — one box that reaches everything.
 *
 * Four sources, ranked in the order people mean them: commands, kinds,
 * namespaces, clusters. Above two characters it also searches live pods, which
 * is the single most common "take me to that thing" in a cluster and the only
 * one that needs a round trip. That query is debounced and capped; the palette
 * must never make the cluster do real work while you type.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.tsx";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { openTerminal, refreshNow, setDock, setState, useApp } from "../lib/store.ts";
import { useNamespaces } from "../lib/query.ts";
import type { ResourceRef } from "../lib/types.ts";
import "./Palette.css";

interface Item {
    id: string;
    group: string;
    label: string;
    hint?: string;
    icon?: React.ReactNode;
    run: () => void;
}

export function Palette({
    onClose,
    onOpen,
    onSwitchContext,
}: {
    onClose: () => void;
    onOpen: (ref: ResourceRef) => void;
    onSwitchContext: (context: string) => void;
}) {
    const catalog = useApp((s) => s.catalog);
    const namespaces = useApp((s) => s.namespaces);
    const contexts = useApp((s) => s.contexts);
    const context = useApp((s) => s.context);
    const canExec = useApp((s) => s.canExec);
    const theme = useApp((s) => s.theme);
    const [selectedNs, setSelectedNs] = useNamespaces();
    const [q, setQ] = useState("");
    const [cursor, setCursor] = useState(0);
    const [pods, setPods] = useState<{ name: string; ns?: string }[]>([]);
    const listRef = useRef<HTMLDivElement>(null);

    // Live pod search, debounced.
    useEffect(() => {
        const needle = q.trim();
        if (needle.length < 2) {
            setPods([]);
            return;
        }
        const id = setTimeout(async () => {
            try {
                const res = await api.list({
                    context,
                    kind: "pods",
                    ns: selectedNs.length === 1 ? selectedNs[0]! : "*",
                    q: needle,
                });
                setPods(res.rows.slice(0, 8).map((r) => ({ name: r.name, ns: r.ns })));
            } catch {
                setPods([]);
            }
        }, 180);
        return () => clearTimeout(id);
    }, [q, context, selectedNs]);

    const items = useMemo<Item[]>(() => {
        const out: Item[] = [];

        out.push(
            {
                id: "cmd:overview",
                group: "Go",
                label: "Cluster overview",
                icon: <Icon.Grid size={13} />,
                run: () => navigate({ page: "overview" }),
            },
            {
                id: "cmd:events",
                group: "Go",
                label: "Events",
                icon: <Icon.Bolt size={13} />,
                run: () => navigate({ page: "events" }),
            },
            {
                id: "cmd:forwards",
                group: "Go",
                label: "Console — shells and forwards",
                icon: <Icon.Forward size={13} />,
                run: () => setDock({ open: true, tab: "forwards" }),
            },
        );

        if (canExec) {
            out.push({
                id: "cmd:shell",
                group: "Command",
                label: "New local shell",
                icon: <Icon.Terminal size={13} />,
                run: () => openTerminal({ kind: "local", title: `shell · ${context}`, context }),
            });
        }

        out.push(
            {
                id: "cmd:refresh",
                group: "Command",
                label: "Refresh now",
                icon: <Icon.Refresh size={13} />,
                run: () => refreshNow(),
            },
            {
                id: "cmd:theme",
                group: "Command",
                label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
                icon: theme === "dark" ? <Icon.Sun size={13} /> : <Icon.Moon size={13} />,
                run: () => {
                    const next = theme === "dark" ? "light" : "dark";
                    document.documentElement.dataset.theme = next;
                    setState({ theme: next });
                    void api.prefs({ theme: next }).catch(() => {});
                },
            },
        );

        for (const p of pods) {
            out.push({
                id: `pod:${p.ns}/${p.name}`,
                group: "Pods",
                label: p.ns ? `${p.ns}/${p.name}` : p.name,
                icon: <Icon.Box size={13} />,
                run: () => onOpen({ kind: "pods", name: p.name, ns: p.ns }),
            });
        }

        for (const g of catalog) {
            for (const k of g.kinds) {
                out.push({
                    id: `kind:${k.name}`,
                    group: g.title,
                    label: k.title,
                    hint: k.name,
                    icon: <Icon.Layers size={13} />,
                    run: () => navigate({ page: "list", kind: k.name }),
                });
            }
        }

        for (const ns of namespaces) {
            out.push({
                id: `ns:${ns}`,
                group: "Namespace",
                label: ns,
                icon: <Icon.Layers size={13} />,
                run: () => {
                    void setSelectedNs([ns]);
                    void api.prefs({ context, namespace: ns }).catch(() => {});
                    refreshNow();
                },
            });
        }

        for (const c of contexts) {
            if (c === context) continue;
            out.push({
                id: `ctx:${c}`,
                group: "Cluster",
                label: c,
                icon: <Icon.Cluster size={13} />,
                run: () => onSwitchContext(c),
            });
        }

        return out;
    }, [catalog, namespaces, contexts, context, pods, canExec, theme, onOpen, onSwitchContext, setSelectedNs]);

    const filtered = useMemo(() => {
        const needle = q.trim().toLowerCase();
        if (!needle) return items.slice(0, 40);
        const scored = items
            .map((item) => {
                const label = item.label.toLowerCase();
                const hint = (item.hint ?? "").toLowerCase();
                let score = -1;
                if (label === needle) score = 100;
                else if (label.startsWith(needle)) score = 80;
                else if (hint.startsWith(needle)) score = 70;
                else if (label.includes(needle)) score = 50;
                else if (hint.includes(needle)) score = 40;
                // Pods are already server-filtered; keep them near the top.
                if (item.group === "Pods") score = Math.max(score, 75);
                return { item, score };
            })
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score);
        return scored.slice(0, 40).map((s) => s.item);
    }, [items, q]);

    useEffect(() => setCursor(0), [q]);

    useEffect(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
        el?.scrollIntoView({ block: "nearest" });
    }, [cursor]);

    const choose = (item: Item | undefined) => {
        if (!item) return;
        onClose();
        item.run();
    };

    let lastGroup = "";

    return createPortal(
        <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className="palette" role="dialog" aria-modal="true">
                <div className="palette-input">
                    <Icon.Search size={15} />
                    <input
                        autoFocus
                        placeholder="Jump to a kind, namespace, cluster or pod…"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
                                e.preventDefault();
                                setCursor((c) => Math.min(filtered.length - 1, c + 1));
                            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
                                e.preventDefault();
                                setCursor((c) => Math.max(0, c - 1));
                            } else if (e.key === "Enter") {
                                e.preventDefault();
                                choose(filtered[cursor]);
                            } else if (e.key === "Escape") {
                                e.preventDefault();
                                onClose();
                            }
                        }}
                    />
                    <kbd>esc</kbd>
                </div>
                <div className="palette-list" ref={listRef}>
                    {filtered.length === 0 ? (
                        <div className="palette-empty faint">nothing matches “{q}”</div>
                    ) : (
                        filtered.map((item, i) => {
                            const header = item.group !== lastGroup ? item.group : null;
                            lastGroup = item.group;
                            return (
                                <div key={item.id}>
                                    {header ? <div className="palette-group eyebrow">{header}</div> : null}
                                    <button
                                        type="button"
                                        data-index={i}
                                        className={`palette-item ${i === cursor ? "on" : ""}`}
                                        onMouseEnter={() => setCursor(i)}
                                        onClick={() => choose(item)}
                                    >
                                        <span className="pi-icon">{item.icon}</span>
                                        <span className="spring truncate">{item.label}</span>
                                        {item.hint ? <kbd>{item.hint}</kbd> : null}
                                    </button>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}

/**
 * The resource table.
 *
 * Written from scratch rather than pulled from a grid library because four
 * behaviours decide whether a cluster browser feels fast, and all four are
 * cheap to do right and awkward to retrofit:
 *
 *   1. WINDOWED ROWS. A busy cluster has thousands of pods. Only the visible
 *      slice is in the DOM; the rest is one spacer div. Row height is a
 *      constant shared with the stylesheet, which is what makes the arithmetic
 *      exact instead of measured.
 *   2. SELECTION THAT MATCHES A FILE MANAGER. Click selects, ⌘/ctrl-click
 *      toggles, shift-click extends from the anchor. Bulk actions are the whole
 *      point of the checkbox column.
 *   3. SORT ON VALUES, NOT ON TEXT. Age sorts by timestamp, "3/5" by ratio,
 *      numbers numerically; only real strings fall back to locale compare.
 *   4. KEYBOARD FIRST. ↑/↓ move a cursor, enter opens, space selects, and the
 *      cursor row is always scrolled into view. No bare-letter bindings: this
 *      grid shares a page with filter boxes and an editor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";
import { Menu } from "./ui.tsx";
import type { MenuItem } from "./ui.tsx";
import type { Row, Tone } from "../lib/types.ts";
import { readyTone } from "../lib/format.ts";
import "./DataGrid.css";

export const ROW_H = 27;
const OVERSCAN = 12;

export interface RowKeyed extends Row {
    key: string;
}

export function rowKey(r: Row): string {
    return `${r.ns ?? ""}/${r.name}`;
}

type SortDir = "asc" | "desc";

/** Rank a cell for sorting: number, ratio, byte-ish quantity, or text. */
function sortValue(cell: string): number | string {
    const t = cell.trim();
    if (!t || t === "-" || t === "—" || t === "<none>") return -Infinity;
    const ratio = /^(\d+)\/(\d+)$/.exec(t);
    if (ratio) return Number(ratio[1]) / Math.max(1, Number(ratio[2])) + Number(ratio[2]) / 1e6;
    const num = Number(t.replace(/[,%]/g, ""));
    if (Number.isFinite(num)) return num;
    const quantity = /^([\d.]+)(m|Ki|Mi|Gi|Ti)$/.exec(t);
    if (quantity) {
        const mult: Record<string, number> = { m: 0.001, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
        return Number(quantity[1]) * (mult[quantity[2]!] ?? 1);
    }
    return t.toLowerCase();
}

/** Column widths keyed on the header kubectl gave us. */
const WIDTHS: Record<string, string> = {
    NAME: "minmax(180px, 2.4fr)",
    NAMESPACE: "minmax(110px, 0.9fr)",
    MESSAGE: "minmax(220px, 3fr)",
    STATUS: "minmax(104px, 0.8fr)",
    READY: "72px",
    RESTARTS: "82px",
    AGE: "62px",
    "LAST SEEN": "88px",
    IP: "minmax(112px, 0.7fr)",
    NODE: "minmax(120px, 0.9fr)",
    IMAGE: "minmax(180px, 1.6fr)",
    CPU: "78px",
    MEM: "78px",
    TYPE: "minmax(96px, 0.7fr)",
    DATA: "60px",
    RULES: "60px",
    COUNT: "60px",
    "CLUSTER-IP": "minmax(112px, 0.8fr)",
    "EXTERNAL-IP": "minmax(112px, 0.8fr)",
    PORTS: "minmax(120px, 1fr)",
    SCHEDULE: "minmax(110px, 0.8fr)",
    OBJECT: "minmax(150px, 1.2fr)",
    REASON: "minmax(130px, 0.9fr)",
};

function columnWidth(label: string, index: number): string {
    const known = WIDTHS[label];
    if (known) return known;
    // The leading column is what the eye anchors on, whatever it is called.
    return index === 0 ? "minmax(160px, 2fr)" : "minmax(88px, 1fr)";
}

export interface DataGridProps {
    columns: string[];
    rows: Row[];
    /** Column index whose values carry status colour, from the server. */
    onOpen: (row: Row) => void;
    selected: Set<string>;
    onSelectedChange: (next: Set<string>) => void;
    rowMenu?: (row: Row) => (MenuItem | "-")[];
    /** Extra cell renderer, e.g. metrics injected client-side. */
    renderCell?: (row: Row, col: number, value: string) => ReactNode;
    hiddenColumns?: Set<string>;
    empty?: ReactNode;
    /** Ages come from row.ts, so the AGE column re-renders live. */
    ageColumn?: number;
}

export function DataGrid({
    columns,
    rows,
    onOpen,
    selected,
    onSelectedChange,
    rowMenu,
    renderCell,
    hiddenColumns,
    empty,
}: DataGridProps) {
    const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
    const [cursor, setCursor] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(600);
    const anchor = useRef<number | null>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const [menuFor, setMenuFor] = useState<{ row: Row; x: number; y: number } | null>(null);

    const visibleCols = useMemo(
        () => columns.map((c, i) => ({ label: c, index: i })).filter((c) => !hiddenColumns?.has(c.label)),
        [columns, hiddenColumns],
    );

    const sorted = useMemo(() => {
        if (!sort) return rows;
        const { col, dir } = sort;
        const factor = dir === "asc" ? 1 : -1;
        const isAge = columns[col] === "AGE" || columns[col] === "LAST SEEN";
        const copy = [...rows];
        copy.sort((a, b) => {
            if (isAge) return (a.ts - b.ts) * factor * -1; // newest first when ascending "age"
            const av = sortValue(a.cells[col] ?? "");
            const bv = sortValue(b.cells[col] ?? "");
            if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
            return String(av).localeCompare(String(bv)) * factor;
        });
        return copy;
    }, [rows, sort, columns]);

    useEffect(() => {
        setCursor((c) => Math.min(c, Math.max(0, sorted.length - 1)));
    }, [sorted.length]);

    // Measure the viewport so the window maths knows how many rows fit.
    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setHeight(el.clientHeight));
        ro.observe(el);
        setHeight(el.clientHeight);
        return () => ro.disconnect();
    }, []);

    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const count = Math.ceil(height / ROW_H) + OVERSCAN * 2;
    const slice = sorted.slice(first, first + count);

    const scrollCursorIntoView = useCallback(
        (index: number) => {
            const el = scroller.current;
            if (!el) return;
            const top = index * ROW_H;
            if (top < el.scrollTop) el.scrollTop = top;
            else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
        },
        [],
    );

    const move = useCallback(
        (delta: number) => {
            setCursor((c) => {
                const next = Math.max(0, Math.min(sorted.length - 1, c + delta));
                scrollCursorIntoView(next);
                return next;
            });
        },
        [sorted.length, scrollCursorIntoView],
    );

    const toggleSelect = (key: string, index: number, e: React.MouseEvent | React.KeyboardEvent) => {
        const next = new Set(selected);
        if ("shiftKey" in e && e.shiftKey && anchor.current !== null) {
            const [from, to] = anchor.current < index ? [anchor.current, index] : [index, anchor.current];
            for (let i = from; i <= to; i++) {
                const r = sorted[i];
                if (r) next.add(rowKey(r));
            }
        } else if (next.has(key)) {
            next.delete(key);
            anchor.current = index;
        } else {
            next.add(key);
            anchor.current = index;
        }
        onSelectedChange(next);
    };

    const allSelected = sorted.length > 0 && sorted.every((r) => selected.has(rowKey(r)));

    // Grid template: checkbox column, then one column per visible field.
    // Widths are per-column because "Succeeded" truncating to "Succee…" in a
    // 70px status column is the difference between a table you can scan and one
    // you have to hover.
    const template = `28px ${visibleCols.map((c, i) => columnWidth(c.label, i)).join(" ")}`;

    return (
        <div
            className="grid"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    move(1);
                } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    move(-1);
                } else if (e.key === "PageDown") {
                    e.preventDefault();
                    move(Math.floor(height / ROW_H));
                } else if (e.key === "PageUp") {
                    e.preventDefault();
                    move(-Math.floor(height / ROW_H));
                } else if (e.key === "Home") {
                    e.preventDefault();
                    setCursor(0);
                    scrollCursorIntoView(0);
                } else if (e.key === "End") {
                    e.preventDefault();
                    setCursor(sorted.length - 1);
                    scrollCursorIntoView(sorted.length - 1);
                } else if (e.key === "Enter") {
                    const row = sorted[cursor];
                    if (row) onOpen(row);
                } else if (e.key === " ") {
                    e.preventDefault();
                    const row = sorted[cursor];
                    if (row) toggleSelect(rowKey(row), cursor, e);
                }
            }}
        >
            <div className="grid-head" style={{ gridTemplateColumns: template }}>
                <div className="grid-cell check">
                    <input
                        type="checkbox"
                        checked={allSelected}
                        aria-label="Select all"
                        onChange={() => onSelectedChange(allSelected ? new Set() : new Set(sorted.map(rowKey)))}
                    />
                </div>
                {visibleCols.map((c) => (
                    <button
                        key={c.label}
                        type="button"
                        className={`grid-cell head ${sort?.col === c.index ? "sorted" : ""}`}
                        onClick={() =>
                            setSort((s) =>
                                s?.col === c.index
                                    ? s.dir === "asc"
                                        ? { col: c.index, dir: "desc" }
                                        : null
                                    : { col: c.index, dir: "asc" },
                            )
                        }
                        title={`Sort by ${c.label}`}
                    >
                        <span className="truncate">{c.label}</span>
                        {sort?.col === c.index ? (
                            <span className={`sort ${sort.dir}`}>
                                <Icon.Chevron size={10} />
                            </span>
                        ) : null}
                    </button>
                ))}
            </div>

            <div className="grid-body" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
                {sorted.length === 0 ? (
                    <div className="grid-empty">{empty ?? "Nothing here."}</div>
                ) : (
                    <div style={{ height: sorted.length * ROW_H, position: "relative" }}>
                        <div style={{ position: "absolute", top: first * ROW_H, left: 0, right: 0 }}>
                            {slice.map((row, i) => {
                                const index = first + i;
                                const key = rowKey(row);
                                const isSel = selected.has(key);
                                return (
                                    <div
                                        key={key}
                                        className={`grid-row ${isSel ? "selected" : ""} ${index === cursor ? "cursor" : ""}`}
                                        style={{ gridTemplateColumns: template, height: ROW_H }}
                                        onClick={(e) => {
                                            setCursor(index);
                                            if (e.metaKey || e.ctrlKey || e.shiftKey) toggleSelect(key, index, e);
                                            else onOpen(row);
                                        }}
                                        onContextMenu={(e) => {
                                            if (!rowMenu) return;
                                            e.preventDefault();
                                            setCursor(index);
                                            setMenuFor({ row, x: e.clientX, y: e.clientY });
                                        }}
                                    >
                                        <div className="grid-cell check" onClick={(e) => e.stopPropagation()}>
                                            <input
                                                type="checkbox"
                                                checked={isSel}
                                                aria-label={`Select ${row.name}`}
                                                onChange={(e) =>
                                                    toggleSelect(key, index, e as unknown as React.MouseEvent)
                                                }
                                            />
                                        </div>
                                        {visibleCols.map((c) => {
                                            const value = row.cells[c.index] ?? "";
                                            const tone: Tone | undefined =
                                                (row.tones[c.index] as Tone | undefined) ??
                                                (readyTone(value) ?? undefined);
                                            return (
                                                <div
                                                    key={c.label}
                                                    className={`grid-cell mono ${tone && tone !== "neutral" ? `t-${tone}` : ""} ${
                                                        c.label === "NAME" ? "name" : ""
                                                    }`}
                                                    title={value}
                                                >
                                                    {renderCell ? renderCell(row, c.index, value) : <span className="truncate">{value}</span>}
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {menuFor && rowMenu ? (
                <ContextMenu x={menuFor.x} y={menuFor.y} items={rowMenu(menuFor.row)} onClose={() => setMenuFor(null)} />
            ) : null}
        </div>
    );
}

/** Right-click menu, positioned at the pointer and flipped near the edges. */
function ContextMenu({
    x,
    y,
    items,
    onClose,
}: {
    x: number;
    y: number;
    items: (MenuItem | "-")[];
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: x, top: y });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setPos({
            left: Math.min(x, window.innerWidth - rect.width - 8),
            top: Math.min(y, window.innerHeight - rect.height - 8),
        });
    }, [x, y]);

    useEffect(() => {
        const close = () => onClose();
        window.addEventListener("click", close);
        window.addEventListener("resize", close);
        window.addEventListener("keydown", close);
        return () => {
            window.removeEventListener("click", close);
            window.removeEventListener("resize", close);
            window.removeEventListener("keydown", close);
        };
    }, [onClose]);

    return (
        <div className="menu ctx" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu">
            {items.map((item, i) =>
                item === "-" ? (
                    <div className="menu-sep" key={`s${i}`} />
                ) : (
                    <button
                        key={item.id}
                        type="button"
                        className={`menu-item ${item.danger ? "danger" : ""}`}
                        disabled={item.disabled}
                        onClick={() => {
                            onClose();
                            item.onSelect();
                        }}
                    >
                        <span className="spring">{item.label}</span>
                        {item.hint ? <kbd>{item.hint}</kbd> : null}
                    </button>
                ),
            )}
        </div>
    );
}

/** Column visibility control, kept next to the grid it drives. */
export function ColumnsMenu({
    columns,
    hidden,
    onChange,
}: {
    columns: string[];
    hidden: Set<string>;
    onChange: (next: Set<string>) => void;
}) {
    return (
        <Menu
            align="right"
            trigger={({ toggle }) => (
                <button className="btn ghost sm" type="button" onClick={toggle} title="Columns">
                    <Icon.Columns size={13} />
                </button>
            )}
            items={columns.map((c) => ({
                id: c,
                label: (
                    <span className="row">
                        <span className="tickbox">{hidden.has(c) ? null : <Icon.Check size={11} />}</span>
                        {c}
                    </span>
                ),
                onSelect: () => {
                    const next = new Set(hidden);
                    if (next.has(c)) next.delete(c);
                    else next.add(c);
                    onChange(next);
                },
            }))}
        />
    );
}

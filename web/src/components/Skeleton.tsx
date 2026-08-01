/**
 * The shapes digg draws while it is waiting.
 *
 * A spinner tells you to wait; a skeleton tells you what is coming, and lands
 * the real thing without moving anything. Every screen here draws its own
 * geometry — a table keeps its real header row and its real column widths, a
 * detail page keeps its fact grid, the overview keeps its stat row — so the
 * data replaces placeholders in place rather than replacing a screen.
 *
 * Nothing in this file decides WHEN to appear. That is `useDelayed` in
 * lib/hooks.ts, and every caller goes through it: a read through the proxy
 * takes ~13ms and a placeholder painted for one frame is worse than none.
 */

import { ROW_H, gridTemplate } from "./DataGrid.tsx";
import "./Skeleton.css";

/**
 * Bar widths.
 *
 * Real cells are ragged, so uniform bars read as a progress meter rather than
 * as text. The raggedness has to be STABLE though — a width from Math.random()
 * changes on every re-render and the placeholder twitches — so it comes from
 * the cell's coordinates.
 */
const WIDTHS = [72, 46, 88, 58, 34, 66, 92, 51, 79, 41, 61, 84];

function widthAt(row: number, col: number): string {
    return `${WIDTHS[(row * 5 + col * 3) % WIDTHS.length]}%`;
}

export function Bar({ w, className = "" }: { w?: number | string; className?: string }) {
    return <span className={`sk ${className}`} style={{ width: typeof w === "number" ? `${w}px` : w }} />;
}

/**
 * A table that is still loading: the header is real, the rows are not.
 *
 * The row count deliberately overflows any viewport — the bottom of the block
 * is faded out by the mask in the CSS, so the placeholder ends in a fade rather
 * than in a hard edge that reads as "these are all the rows there are".
 *
 * `columns` comes from the kind catalog, which the app already has — so the
 * columns of a table you have never opened are known before its first row is.
 * When even that is missing (a CRD reached by URL) it falls back to a plausible
 * three, and the header row is left blank rather than invented.
 */
export function TableSkeleton({ columns, rows = 40 }: { columns?: string[]; rows?: number }) {
    const cols = columns?.length ? columns : ["", "", ""];
    const template = gridTemplate(cols);
    return (
        <div className="grid sk-grid" aria-busy="true" aria-label="Loading rows">
            <div className="grid-head" style={{ gridTemplateColumns: template }}>
                <div className="grid-cell check" />
                {cols.map((c, i) => (
                    <div className={`grid-cell head`} key={`${c}-${i}`}>
                        <span className="truncate">{c}</span>
                    </div>
                ))}
            </div>
            <div className="sk-rows">
                <div className="skeleton">
                    {Array.from({ length: rows }, (_, r) => (
                        <div className="grid-row sk-row" key={r} style={{ gridTemplateColumns: template, height: ROW_H }}>
                            <div className="grid-cell check">
                                <span className="sk-check" />
                            </div>
                            {cols.map((c, i) => (
                                <div className="grid-cell" key={`${c}-${i}`}>
                                    <Bar w={widthAt(r, i)} />
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

/** The overview tab of a detail page: identity facts, then container cards. */
export function DetailSkeleton({ facts = 10, cards = 3 }: { facts?: number; cards?: number }) {
    return (
        <div className="sk-detail skeleton" aria-busy="true" aria-label="Loading">
            <div className="sk-facts">
                {Array.from({ length: facts }, (_, i) => (
                    <div className="sk-fact" key={i}>
                        <Bar w={i % 3 === 0 ? 58 : 74} />
                        <Bar w={widthAt(i, 1)} className="line" />
                    </div>
                ))}
            </div>

            <div className="sk-section">
                <div className="sk-section-head">
                    <Bar w={92} className="tall" />
                    <Bar w={48} />
                </div>
                <div className="sk-cards">
                    {Array.from({ length: cards }, (_, i) => (
                        <div className="sk-card" key={i}>
                            <div className="sk-card-head">
                                <Bar w={120} className="tall" />
                                <Bar w={220} />
                            </div>
                            <Bar w="70%" />
                            <Bar w="45%" />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

/**
 * The cluster overview.
 *
 * It keeps the real toolbar with the real context name — the one thing on this
 * screen that is known before the cluster is asked anything — then the stat row
 * and the same panel geometry the loaded page uses, so nothing below the title
 * moves when the numbers arrive.
 */
export function OverviewSkeleton({ context }: { context?: string }) {
    const panel = (p: number, lines = 4) => (
        <div className="sk-panel" key={p}>
            <div className="sk-panel-head">
                <Bar w={p % 2 ? 128 : 96} />
            </div>
            <div className="sk-panel-body">
                {Array.from({ length: lines }, (_, i) => (
                    <Bar w={widthAt(p, i)} key={i} className="line" />
                ))}
            </div>
        </div>
    );
    return (
        <div className="page overview">
            <div className="toolbar">
                <div className="toolbar-title">
                    <h1>{context ?? ""}</h1>
                </div>
            </div>
            <div className="sk-detail skeleton" aria-busy="true" aria-label="Reading cluster">
                <div className="sk-stats">
                    {Array.from({ length: 5 }, (_, i) => (
                        <div className="sk-stat" key={i}>
                            <Bar w={62} />
                            <Bar w={86} className="tall" />
                            <Bar w={48} />
                        </div>
                    ))}
                </div>
                {/* Capacity beside Workloads, then Nodes, then warnings — the
                    real page's shape (see OverviewPage.css .grid-2). */}
                <div className="sk-two">
                    {panel(0, 3)}
                    {panel(1, 3)}
                </div>
                {panel(2, 3)}
                {panel(3, 2)}
            </div>
        </div>
    );
}

/** A stream of one-line records: events, revisions, a key list. */
export function RowsSkeleton({ rows = 18 }: { rows?: number }) {
    return (
        <div className="sk-text skeleton" aria-busy="true" aria-label="Loading">
            {Array.from({ length: rows }, (_, i) => (
                <Bar w={widthAt(i, i % 4)} key={i} className="line" />
            ))}
        </div>
    );
}

/**
 * Monospace text — YAML, describe output.
 *
 * Indentation is the shape of a manifest, so the bars are indented rather than
 * merely ragged: it reads as a document before a single character arrives.
 */
export function TextSkeleton({ lines = 44 }: { lines?: number }) {
    return (
        <div className="sk-text skeleton" aria-busy="true" aria-label="Loading">
            {Array.from({ length: lines }, (_, i) => {
                const indent = [0, 0, 14, 14, 28, 28, 14, 42, 42, 28][i % 10];
                return (
                    <span style={{ paddingLeft: indent, display: "block" }} key={i}>
                        <Bar w={widthAt(i, 2)} />
                    </span>
                );
            })}
        </div>
    );
}

/**
 * First paint, before the boot call answers.
 *
 * The rail and the top bar are drawn at their real sizes so the app assembles
 * itself in one movement. The note under it is the only place digg says
 * "connecting" in words — a cluster on the far side of a VPN can take a few
 * seconds, and a silent screen at that point looks broken.
 */
export function AppSkeleton() {
    return (
        <div className="sk-app" aria-busy="true" aria-label="Connecting to cluster">
            <div className="sk-rail skeleton">
                <Bar w={78} className="tall" />
                {Array.from({ length: 9 }, (_, i) => (
                    <Bar w={i % 3 === 0 ? "52%" : "72%"} key={i} />
                ))}
            </div>
            <div className="sk-main">
                <div className="sk-topbar skeleton">
                    <Bar w={150} className="tall" />
                    <Bar w={110} className="tall" />
                    <span className="spring" />
                    <Bar w={64} />
                </div>
                <div className="sk-boot-note">
                    <span className="spinner" /> connecting to cluster…
                </div>
                <TableSkeleton rows={14} />
            </div>
        </div>
    );
}

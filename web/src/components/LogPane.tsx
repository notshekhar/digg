/**
 * Live log viewer.
 *
 * Streams `kubectl logs -f` over SSE and keeps the last LINE_CAP lines. The cap
 * is not a nicety: a chatty pod will push a hundred thousand lines through this
 * pane in a minute, and a browser tab that holds them all stops repainting.
 *
 * Follow behaves the way a tail should — it sticks to the bottom until you
 * scroll up, and turns itself off when you do, because a viewer that yanks you
 * back to the tail while you are reading is unusable.
 *
 * Two things make "turns itself off" harder than it looks, and both used to
 * drag the reader back to the tail:
 *
 *  - **The cap trims the head.** Dropping lines off the FRONT while the reader
 *    sits at a fixed scrollTop slides every surviving line up under them: the
 *    scrollbar never moves, but the text marches toward the newest. Rows are
 *    keyed by index, so React rewrites them in place and the browser's scroll
 *    anchoring cannot see it either. So the head is only trimmed while pinned
 *    to the bottom, where removing it is invisible. Paused, the buffer grows to
 *    PAUSED_CAP and then refuses new lines — a paused viewer that keeps its
 *    place and says what it missed beats one that quietly moves.
 *  - **Scroll events are async.** A wheel-up can land after the follow effect
 *    has already pinned us back to the bottom, so the scroll handler measures
 *    "at bottom" and never turns follow off. Wheel and touch say so directly,
 *    and our own scrolls are marked so they cannot be read as user intent.
 *
 * Lines are parsed once on arrival (lib/logline.ts) and rows are keyed by a
 * sequence id rather than an array index. Both are for the same reason: with
 * index keys, trimming the head rewrites the text of every surviving row, so
 * React re-renders the whole buffer — and re-runs the colouring — on every
 * frame of a chatty pod. Keyed by id, a trim unmounts the head, mounts the new
 * tail, and leaves the thousands of rows in between untouched.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { streamUrl } from "../lib/api.ts";
import { useUiState } from "../lib/ui-state.ts";
import { LEVEL_LABEL, LEVEL_RANK, type Level, type LogLine, findHits, parseLine, pieces } from "../lib/logline.ts";
import "./LogPane.css";

/** Live buffer while following: what a pinned tail can afford to repaint. */
const LINE_CAP = 5000;
/** Paused buffer: bigger, because nothing may be dropped from under a reader. */
const PAUSED_CAP = 20000;

/**
 * Floors for the level filter. "all" keeps unclassified lines, everything else
 * drops them — a plain-text line has no level to compare, and a filter that
 * kept them would show almost the whole stream back at you.
 */
const FLOORS: { id: string; label: string; min: Level | null }[] = [
    { id: "all", label: "all levels", min: null },
    { id: "debug", label: "debug+", min: "debug" },
    { id: "info", label: "info+", min: "info" },
    { id: "warn", label: "warn+", min: "warn" },
    { id: "error", label: "errors", min: "error" },
];

export interface LogTarget {
    context: string;
    kind: string;
    name: string;
    ns?: string;
    containers?: string[];
}

export function LogPane({
    target,
    container: containerProp,
    onContainer,
}: {
    target: LogTarget;
    /** Controlled by the page so the choice can live in the URL. */
    container?: string;
    onContainer?: (next: string) => void;
}) {
    const [lines, setLines] = useState<LogLine[]>([]);
    const [status, setStatus] = useState<"connecting" | "streaming" | "ended" | "error">("connecting");
    const [follow, setFollow] = useState(true);
    /** Lines the stream delivered while paused and full. Honest, not silent. */
    const [missed, setMissed] = useState(0);
    // How the pane is set up is a lasting preference; what it is showing is
    // not. `previous` stays local — it belongs to one crash, not to a habit.
    const [wrap, setWrap] = useUiState("logs.wrap", false);
    const [timestamps, setTimestamps] = useUiState("logs.timestamps", false);
    const [floor, setFloor] = useUiState("logs.floor", "all");
    const [previous, setPrevious] = useState(false);
    const [tail, setTail] = useUiState("logs.tail", 500);
    const [localContainer, setLocalContainer] = useState("");
    const container = containerProp ?? localContainer;
    const setContainer = onContainer ?? setLocalContainer;
    const [q, setQ] = useState("");
    const [onlyMatches, setOnlyMatches] = useState(false);
    const [nonce, setNonce] = useState(0);
    const body = useRef<HTMLDivElement>(null);
    const pending = useRef<string[]>([]);
    /** The buffer itself. `lines` is a snapshot of it; the appender needs it synchronously. */
    const buffer = useRef<LogLine[]>([]);
    /** Row identity, monotonic for the life of a stream. */
    const seq = useRef(0);
    /** Follow, readable from the SSE callbacks without re-subscribing the stream. */
    const following = useRef(follow);
    /** Set while we move the scrollbar ourselves, so onScroll ignores the echo. */
    const selfScroll = useRef(false);

    const setFollowing = useCallback((next: boolean) => {
        following.current = next;
        setFollow(next);
    }, []);

    // Batch incoming lines into one state update per animation frame: a pod
    // logging 2k lines/second would otherwise schedule 2k renders.
    useEffect(() => {
        buffer.current = [];
        seq.current = 0;
        setLines([]);
        setMissed(0);
        setStatus("connecting");
        const url = streamUrl("/api/logs", {
            context: target.context,
            kind: target.kind,
            name: target.name,
            ns: target.ns,
            container: container || undefined,
            tail,
            timestamps: timestamps ? 1 : 0,
            previous: previous ? 1 : 0,
        });
        const es = new EventSource(url);
        let frame = 0;
        const flush = () => {
            frame = 0;
            if (!pending.current.length) return;
            const raws = pending.current;
            pending.current = [];
            // Parse here, not in the row: a stack frame needs the level of the
            // line above it, which only the arrival order knows.
            let prev = buffer.current[buffer.current.length - 1]?.level ?? "none";
            let incoming = raws.map((raw) => {
                const line = parseLine(raw, seq.current++, prev);
                prev = line.level;
                return line;
            });
            if (following.current) {
                // Pinned to the bottom: trimming the head is invisible.
                let next = buffer.current.concat(incoming);
                if (next.length > LINE_CAP) next = next.slice(next.length - LINE_CAP);
                buffer.current = next;
            } else {
                // Paused: grow, then stop taking. Anything the head lost here
                // would come out of the reader's scroll position.
                const room = PAUSED_CAP - buffer.current.length;
                if (incoming.length > room) {
                    setMissed((m) => m + incoming.length - Math.max(room, 0));
                    incoming = room > 0 ? incoming.slice(0, room) : [];
                }
                if (!incoming.length) return;
                buffer.current = buffer.current.concat(incoming);
            }
            setLines(buffer.current);
        };
        es.onmessage = (e) => {
            setStatus("streaming");
            try {
                pending.current.push(JSON.parse(e.data) as string);
            } catch {
                pending.current.push(String(e.data));
            }
            if (!frame) frame = requestAnimationFrame(flush);
        };
        es.addEventListener("end", () => {
            flush();
            setStatus("ended");
            es.close();
        });
        es.onerror = () => {
            flush();
            setStatus((s) => (s === "streaming" ? "ended" : "error"));
            es.close();
        };
        return () => {
            if (frame) cancelAnimationFrame(frame);
            pending.current = [];
            es.close();
        };
    }, [target.context, target.kind, target.name, target.ns, container, tail, timestamps, previous, nonce]);

    const min = FLOORS.find((f) => f.id === floor)?.min ?? null;
    const shown = useMemo(() => {
        const needle = q.toLowerCase();
        const drop = needle && onlyMatches;
        if (!min && !drop) return lines;
        return lines.filter(
            (l) =>
                (!min || LEVEL_RANK[l.level] >= LEVEL_RANK[min]) &&
                (!drop || l.raw.toLowerCase().includes(needle)),
        );
    }, [lines, q, onlyMatches, min]);

    // Layout effect, not effect: pin before the browser paints, or a fast pod
    // shows one frame of the old offset on every batch.
    useLayoutEffect(() => {
        if (!follow || !body.current) return;
        selfScroll.current = true;
        body.current.scrollTop = body.current.scrollHeight;
    }, [shown, follow]);

    /** Resume the tail: drop back to the live cap and jump to the end. */
    const resume = useCallback(() => {
        if (buffer.current.length > LINE_CAP) {
            buffer.current = buffer.current.slice(buffer.current.length - LINE_CAP);
            setLines(buffer.current);
        }
        setMissed(0);
        setFollowing(true);
    }, [setFollowing]);

    const download = () => {
        const blob = new Blob([lines.map((l) => l.raw).join("\n")], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${target.name}${container ? `-${container}` : ""}.log`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    const matches = q ? lines.filter((l) => l.raw.toLowerCase().includes(q.toLowerCase())).length : 0;

    // Counts drive the two chips in the bar. A pane filtered to warn+ still has
    // to say how much it is hiding, or a quiet screen reads as a quiet pod.
    const counts = useMemo(() => {
        let bad = 0;
        let warn = 0;
        for (const l of lines) {
            if (l.level === "error" || l.level === "fatal") bad++;
            else if (l.level === "warn") warn++;
        }
        return { bad, warn };
    }, [lines]);

    return (
        <div className="logs">
            <div className="logs-bar">
                <span className={`dot ${status === "streaming" ? "ok pulse" : status === "error" ? "bad" : ""}`} />
                <span className="faint mono logs-status">{status}</span>

                {target.containers && target.containers.length > 1 ? (
                    <select className="select sm" value={container} onChange={(e) => setContainer(e.target.value)}>
                        <option value="">all containers</option>
                        {target.containers.map((c) => (
                            <option key={c} value={c}>
                                {c}
                            </option>
                        ))}
                    </select>
                ) : null}

                <div className="search logs-search">
                    <Icon.Search size={12} />
                    <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
                    {q ? <span className="faint mono">{matches}</span> : null}
                </div>
                {q ? (
                    <button className="btn sm" type="button" aria-pressed={onlyMatches} onClick={() => setOnlyMatches((v) => !v)}>
                        only matches
                    </button>
                ) : null}

                <select
                    className="select sm"
                    value={floor}
                    onChange={(e) => setFloor(e.target.value)}
                    title="Hide lines below this level. Lines with no level of their own only show under “all”."
                >
                    {FLOORS.map((f) => (
                        <option key={f.id} value={f.id}>
                            {f.label}
                        </option>
                    ))}
                </select>

                {counts.bad ? (
                    <button
                        className="logs-count bad"
                        type="button"
                        title="Jump to errors only"
                        onClick={() => setFloor(floor === "error" ? "all" : "error")}
                    >
                        {counts.bad.toLocaleString()} error{counts.bad === 1 ? "" : "s"}
                    </button>
                ) : null}
                {counts.warn ? (
                    <button
                        className="logs-count warn"
                        type="button"
                        title="Jump to warnings and above"
                        onClick={() => setFloor(floor === "warn" ? "all" : "warn")}
                    >
                        {counts.warn.toLocaleString()} warn
                    </button>
                ) : null}

                <div className="spring" />

                {min && lines.length ? (
                    <span className="faint mono logs-status">
                        {shown.length.toLocaleString()} / {lines.length.toLocaleString()}
                    </span>
                ) : null}

                <select className="select sm" value={tail} onChange={(e) => setTail(Number(e.target.value))} title="Lines of history">
                    {[100, 500, 2000, 10000].map((n) => (
                        <option key={n} value={n}>
                            {n} lines
                        </option>
                    ))}
                </select>
                <button className="btn sm" type="button" aria-pressed={timestamps} onClick={() => setTimestamps((v) => !v)}>
                    time
                </button>
                <button
                    className="btn sm"
                    type="button"
                    aria-pressed={previous}
                    title="Logs from the previous container instance (after a crash)"
                    onClick={() => setPrevious((v) => !v)}
                >
                    previous
                </button>
                <button className="btn sm" type="button" aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>
                    wrap
                </button>
                <button
                    className="btn sm"
                    type="button"
                    aria-pressed={follow}
                    onClick={() => (follow ? setFollowing(false) : resume())}
                >
                    follow
                </button>
                <button className="btn sm ghost" type="button" title="Reconnect" onClick={() => setNonce((n) => n + 1)}>
                    <Icon.Refresh size={12} />
                </button>
                <button className="btn sm ghost" type="button" title="Download" onClick={download}>
                    <Icon.Download size={12} />
                </button>
            </div>

            <div
                className={`logs-body ${wrap ? "wrap" : ""}`}
                ref={body}
                // Wheel and touch are the user speaking, and they arrive before
                // the scroll event they cause — which is the only reading of
                // intent a pinned pane cannot race against.
                onWheel={(e) => {
                    if (e.deltaY < 0 && following.current) setFollowing(false);
                }}
                onTouchMove={() => {
                    if (following.current) setFollowing(false);
                }}
                onScroll={(e) => {
                    if (selfScroll.current) {
                        selfScroll.current = false;
                        return;
                    }
                    const el = e.currentTarget;
                    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                    if (!atBottom && following.current) setFollowing(false);
                    else if (atBottom && !following.current) resume();
                }}
            >
                {shown.length === 0 ? (
                    <div className="logs-empty faint">
                        {status === "connecting"
                            ? "connecting…"
                            : lines.length
                              ? `no lines at ${FLOORS.find((f) => f.id === floor)?.label ?? floor}`
                              : "no output"}
                    </div>
                ) : (
                    shown.map((line) => <Row key={line.id} line={line} q={onlyMatches ? "" : q} />)
                )}
            </div>

            {!follow ? (
                <button className="logs-jump" type="button" onClick={resume}>
                    ↓ jump to live
                    {missed ? <span className="logs-missed">{missed.toLocaleString()} skipped</span> : null}
                </button>
            ) : null}
        </div>
    );
}

/**
 * One line: a severity stripe, a fixed-width level gutter, and the text.
 *
 * The gutter is fixed width even when empty so every message in the pane starts
 * at the same column — a ragged left edge is what makes a mixed-format log hard
 * to skim, and it is the whole reason the level is lifted out of the text.
 *
 * Memoized because the buffer is not virtualized: without this, one appended
 * line re-renders all five thousand rows.
 */
const Row = memo(function Row({ line, q }: { line: LogLine; q: string }) {
    const parts = pieces(line.raw, line.segs, q ? findHits(line.raw, q) : []);
    return (
        <div className={`logline lv-${line.level}${line.inherited ? " cont" : ""}`}>
            <span className="logline-lvl" aria-label={line.level === "none" ? undefined : line.level}>
                {LEVEL_LABEL[line.level]}
            </span>
            <span className="logline-text">
                {parts.map((p, i) =>
                    p.cls ? (
                        <span key={i} className={p.cls}>
                            {p.text}
                        </span>
                    ) : (
                        p.text
                    ),
                )}
            </span>
        </div>
    );
});

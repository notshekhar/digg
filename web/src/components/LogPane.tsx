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
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { streamUrl } from "../lib/api.ts";
import { useUiState } from "../lib/ui-state.ts";
import "./LogPane.css";

/** Live buffer while following: what a pinned tail can afford to repaint. */
const LINE_CAP = 5000;
/** Paused buffer: bigger, because nothing may be dropped from under a reader. */
const PAUSED_CAP = 20000;

export interface LogTarget {
    context: string;
    kind: string;
    name: string;
    ns?: string;
    containers?: string[];
}

type Severity = "error" | "warn" | "info" | "debug" | "plain";

function severity(line: string): Severity {
    const l = line.toLowerCase();
    if (/\b(error|err|fatal|panic|exception|failed|refused)\b/.test(l)) return "error";
    if (/\b(warn|warning|deprecated)\b/.test(l)) return "warn";
    if (/\b(info)\b/.test(l)) return "info";
    if (/\b(debug|trace)\b/.test(l)) return "debug";
    return "plain";
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
    const [lines, setLines] = useState<string[]>([]);
    const [status, setStatus] = useState<"connecting" | "streaming" | "ended" | "error">("connecting");
    const [follow, setFollow] = useState(true);
    /** Lines the stream delivered while paused and full. Honest, not silent. */
    const [missed, setMissed] = useState(0);
    // How the pane is set up is a lasting preference; what it is showing is
    // not. `previous` stays local — it belongs to one crash, not to a habit.
    const [wrap, setWrap] = useUiState("logs.wrap", false);
    const [timestamps, setTimestamps] = useUiState("logs.timestamps", false);
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
    const buffer = useRef<string[]>([]);
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
            let incoming = pending.current;
            pending.current = [];
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

    const shown = useMemo(() => {
        if (!q) return lines;
        const needle = q.toLowerCase();
        return onlyMatches ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines;
    }, [lines, q, onlyMatches]);

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
        const blob = new Blob([lines.join("\n")], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${target.name}${container ? `-${container}` : ""}.log`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    const matches = q ? lines.filter((l) => l.toLowerCase().includes(q.toLowerCase())).length : 0;

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

                <div className="spring" />

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
                    <div className="logs-empty faint">{status === "connecting" ? "connecting…" : "no output"}</div>
                ) : (
                    shown.map((line, i) => (
                        <div className={`logline ${severity(line)}`} key={i}>
                            {q && !onlyMatches ? highlight(line, q) : line}
                        </div>
                    ))
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

/** Wrap search hits in <mark> without letting the needle become HTML. */
function highlight(line: string, needle: string) {
    const lower = line.toLowerCase();
    const n = needle.toLowerCase();
    const out: React.ReactNode[] = [];
    let at = 0;
    for (;;) {
        const found = lower.indexOf(n, at);
        if (found === -1 || !n) break;
        if (found > at) out.push(line.slice(at, found));
        out.push(
            <mark key={found} className="loghit">
                {line.slice(found, found + n.length)}
            </mark>,
        );
        at = found + n.length;
    }
    out.push(line.slice(at));
    return out;
}

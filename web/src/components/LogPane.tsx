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
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { streamUrl } from "../lib/api.ts";
import "./LogPane.css";

const LINE_CAP = 5000;

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
    const [wrap, setWrap] = useState(false);
    const [timestamps, setTimestamps] = useState(false);
    const [previous, setPrevious] = useState(false);
    const [tail, setTail] = useState(500);
    const [localContainer, setLocalContainer] = useState("");
    const container = containerProp ?? localContainer;
    const setContainer = onContainer ?? setLocalContainer;
    const [q, setQ] = useState("");
    const [onlyMatches, setOnlyMatches] = useState(false);
    const [nonce, setNonce] = useState(0);
    const body = useRef<HTMLDivElement>(null);
    const pending = useRef<string[]>([]);

    // Batch incoming lines into one state update per animation frame: a pod
    // logging 2k lines/second would otherwise schedule 2k renders.
    useEffect(() => {
        setLines([]);
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
            const incoming = pending.current;
            pending.current = [];
            setLines((prev) => {
                const next = prev.concat(incoming);
                return next.length > LINE_CAP ? next.slice(next.length - LINE_CAP) : next;
            });
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

    useEffect(() => {
        if (!follow || !body.current) return;
        body.current.scrollTop = body.current.scrollHeight;
    }, [shown, follow]);

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
                <button className="btn sm" type="button" aria-pressed={follow} onClick={() => setFollow((v) => !v)}>
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
                onScroll={(e) => {
                    const el = e.currentTarget;
                    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                    if (!atBottom && follow) setFollow(false);
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
                <button className="logs-jump" type="button" onClick={() => setFollow(true)}>
                    ↓ jump to live
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

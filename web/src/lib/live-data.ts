/**
 * Screens ask for data; this decides how it arrives.
 *
 * The happy path is the watch socket: a snapshot, then deltas. When it is not
 * available — the socket is down, the kind cannot be watched, or the user hit
 * pause — the same hook reports `streaming: false` and the caller polls, so a
 * screen never has to know which mode it is in and never silently freezes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { type LiveStatus, live } from "./live.ts";
import type { Detail, KindMeta, ListResult, Row } from "./types.ts";
import { useApp } from "./store.ts";

export function useLiveStatus(): LiveStatus {
    const [status, setStatus] = useState<LiveStatus>(live.status);
    useEffect(() => live.onStatus(setStatus), []);
    return status;
}

const keyOf = (row: { ns?: string; name: string }) => `${row.ns ?? ""}/${row.name}`;

/**
 * Rows in a stable order.
 *
 * The server sends them in `kubectl get` order, but a delta arrives whenever
 * the cluster feels like it, and appending an updated row would make it jump
 * down the table under the reader's cursor. Sorting by namespace then name
 * gives every row a fixed home, which is the same order kubectl prints anyway.
 */
function ordered(map: Map<string, Row>): Row[] {
    return [...map.values()].sort(
        (a, b) => (a.ns ?? "").localeCompare(b.ns ?? "") || a.name.localeCompare(b.name),
    );
}

export interface LiveList {
    data: ListResult | null;
    error: string | null;
    /** True while the socket is feeding this list; false means "please poll". */
    streaming: boolean;
    initial: boolean;
}

export function useLiveList(kind: string, ns: string | null): LiveList {
    const context = useApp((s) => s.context);
    const paused = !useApp((s) => s.live);
    const [rows, setRows] = useState<Row[]>([]);
    const [meta, setMeta] = useState<{ columns: string[]; kind: KindMeta } | null>(null);
    const [fatal, setFatal] = useState(false);
    const [ready, setReady] = useState(false);
    const store = useRef(new Map<string, Row>());
    const status = useLiveStatus();

    useEffect(() => {
        if (!context || !kind || paused) return;
        setReady(false);
        setFatal(false);
        store.current = new Map();
        const stop = live.subscribe(
            { type: "list", context, kind, ns },
            {
                onSnapshot: ({ columns, rows: fresh, kind: kindMeta }) => {
                    // A snapshot replaces everything: it is also what arrives
                    // after a reconnect, and it is the only thing that can
                    // clear out objects deleted while we were away.
                    store.current = new Map(fresh.map((r) => [keyOf(r), r]));
                    setMeta({ columns, kind: kindMeta });
                    setRows(ordered(store.current));
                    setReady(true);
                },
                onDelta: ({ upsert, remove }) => {
                    for (const row of upsert) store.current.set(keyOf(row), row);
                    for (const key of remove) store.current.delete(key);
                    setRows(ordered(store.current));
                },
                onError: (_message, isFatal) => {
                    if (isFatal) setFatal(true);
                },
            },
        );
        return stop;
    }, [context, kind, ns, paused]);

    const data = useMemo<ListResult | null>(
        () => (meta && ready ? { kind: meta.kind, columns: meta.columns, rows, count: rows.length } : null),
        [meta, ready, rows],
    );

    // Streaming means: connected, not paused, not fatally rejected. Anything
    // else and the caller must poll — including the moment before the first
    // snapshot lands, so a slow watch never shows an empty table.
    const streaming = status === "live" && !paused && !fatal && ready;
    // A watch failure is never the user's problem: polling covers it, and the
    // page has nothing to do about "watch is not supported on this kind". Only
    // a failure of the data itself (the polled path) earns an error box.
    return { data, error: null, streaming, initial: !ready };
}

export interface LiveDetail {
    data: Detail | null;
    error: string | null;
    streaming: boolean;
    /** The object no longer exists — the page should go back. */
    gone: boolean;
}

export function useLiveDetail(kind: string, name: string, ns?: string): LiveDetail {
    const context = useApp((s) => s.context);
    const paused = !useApp((s) => s.live);
    const [data, setData] = useState<Detail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [fatal, setFatal] = useState(false);
    const [gone, setGone] = useState(false);
    const status = useLiveStatus();

    useEffect(() => {
        if (!context || !kind || !name || paused) return;
        setData(null);
        setFatal(false);
        setGone(false);
        const stop = live.subscribe(
            { type: "detail", context, kind, name, ns },
            {
                onDetail: (payload) => {
                    setData(payload as Detail);
                    setError(null);
                },
                onError: (message, isFatal, isGone) => {
                    setError(message);
                    if (isFatal) setFatal(true);
                    if (isGone) setGone(true);
                },
            },
        );
        return stop;
    }, [context, kind, name, ns, paused]);

    const streaming = status === "live" && !paused && !fatal && data !== null;
    return { data, error, streaming, gone };
}

/** Merge a live source with a polled one, preferring live when it is working. */
export function useEither<T>(
    liveData: T | null,
    streaming: boolean,
    polled: { data: T | null; error: string | null; initial: boolean; loading: boolean },
): { data: T | null; error: string | null; initial: boolean; loading: boolean; streaming: boolean } {
    // When the socket drops, the last streamed state stays on screen until the
    // fallback poll answers. Blanking the table for a round-trip would make a
    // one-second network blip look like an empty cluster.
    const data = streaming ? liveData : (polled.data ?? liveData);
    return {
        data,
        error: streaming ? null : polled.error,
        initial: data === null && (streaming ? false : polled.initial),
        loading: streaming ? false : polled.loading,
        streaming,
    };
}

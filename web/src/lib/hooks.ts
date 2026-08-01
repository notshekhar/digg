/** Small hooks the screens share: polling, hotkeys, click-outside, latest-ref. */

import { useCallback, useEffect, useRef, useState } from "react";
import { getState, useApp } from "./store.ts";

export function useLatest<T>(value: T) {
    const ref = useRef(value);
    ref.current = value;
    return ref;
}

export interface Loadable<T> {
    data: T | null;
    error: string | null;
    loading: boolean;
    /** True only for the first load, so refreshes never blank the screen. */
    initial: boolean;
    reload: () => void;
}

/**
 * Fetch on mount and on every live tick.
 *
 * Two behaviours matter for a cluster browser and neither is the default:
 * a refresh must not clear the table (the rows would flash), and a request that
 * lands after a newer one must not overwrite it (switching kinds fast otherwise
 * shows the previous kind's rows under the new kind's columns).
 */
export function usePolled<T>(fn: () => Promise<T>, deps: unknown[], opts: { enabled?: boolean } = {}): Loadable<T> {
    const enabled = opts.enabled !== false;
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(enabled);
    const [initial, setInitial] = useState(true);
    const [nonce, setNonce] = useState(0);
    const live = useApp((s) => s.live);
    const seconds = useApp((s) => s.refreshSeconds);
    const tick = useApp((s) => s.refreshTick);
    const fnRef = useLatest(fn);
    const seq = useRef(0);

    const run = useCallback(async () => {
        const mine = ++seq.current;
        setLoading(true);
        try {
            const result = await fnRef.current();
            if (mine !== seq.current) return; // a newer request already answered
            setData(result);
            setError(null);
        } catch (err) {
            if (mine !== seq.current) return;
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (mine === seq.current) {
                setLoading(false);
                setInitial(false);
            }
        }
    }, [fnRef]);

    // Reset to the loading state when the *subject* changes (a new kind, a new
    // context) — but not when it is merely time to refresh.
    useEffect(() => {
        if (!enabled) return;
        setInitial(true);
        setData(null);
        void run();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, enabled, nonce]);

    useEffect(() => {
        if (!enabled || !live) return;
        const id = setInterval(() => void run(), Math.max(1000, seconds * 1000));
        return () => clearInterval(id);
    }, [enabled, live, seconds, run]);

    useEffect(() => {
        if (!enabled || tick === 0) return;
        void run();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick]);

    return { data, error, loading, initial, reload: () => setNonce((n) => n + 1) };
}

/**
 * True only once `active` has been true continuously for `ms`.
 *
 * Every loading state in digg goes through this. Reads land in ~13ms through
 * the proxy, so a placeholder painted the moment a fetch starts is a one-frame
 * flash — worse than no placeholder at all, because the eye registers movement
 * and nothing else. Below the threshold the screen simply does not change; past
 * it, the wait is real and worth showing.
 */
export function useDelayed(active: boolean, ms = 160): boolean {
    const [shown, setShown] = useState(false);
    useEffect(() => {
        if (!active) {
            setShown(false);
            return;
        }
        const id = setTimeout(() => setShown(true), ms);
        return () => clearTimeout(id);
    }, [active, ms]);
    return active && shown;
}

type Handler = (e: KeyboardEvent) => void;

/**
 * Global shortcuts, and every one of them takes ⌘/ctrl.
 *
 * Bare letters are not shortcuts in this app. A cluster browser is full of
 * filter boxes, a YAML editor and a live terminal, and a single key that does
 * something global is a key that fires while you meant to type. Keys written
 * as "mod+k"; Escape is the one exception, because dismissing is not a
 * shortcut.
 */
export function useHotkeys(map: Record<string, Handler>, enabled = true): void {
    const mapRef = useLatest(map);

    useEffect(() => {
        if (!enabled) return;
        const onKey = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;
            if (!mod && e.key !== "Escape") return;

            const parts: string[] = [];
            if (mod) parts.push("mod");
            if (e.altKey) parts.push("alt");
            if (e.shiftKey && e.key.length > 1) parts.push("shift");
            // Letters come from `code`, not `key`: on macOS option composes a
            // character, so ⌘⌥n arrives as "˜" and a chord written "mod+alt+n"
            // could never match. Everything else (/, Escape) keeps its key.
            const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
            parts.push(letter ? letter.toLowerCase() : e.key.toLowerCase());

            const fn = mapRef.current[parts.join("+")];
            if (!fn) return;
            e.preventDefault();
            fn(e);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [enabled, mapRef]);
}

export function useClickOutside<T extends HTMLElement>(onOutside: () => void) {
    const ref = useRef<T>(null);
    const cb = useLatest(onOutside);
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [cb]);
    return ref;
}

/** The namespace the API should be asked for: one name, or "*" for all. */
export function nsParam(selected: string[]): string {
    return selected.length === 1 ? selected[0]! : "*";
}

/** Client-side filter for the multi-namespace case the API cannot express. */
export function nsFilter<T extends { ns?: string; namespace?: string }>(rows: T[], selected: string[]): T[] {
    if (selected.length <= 1) return rows;
    const set = new Set(selected);
    return rows.filter((r) => set.has(r.ns ?? r.namespace ?? ""));
}

export function currentContext(): string {
    return getState().context;
}

/**
 * Saved UI state — the shape of the cockpit, kept in `~/.digg/settings.json`.
 *
 * Not localStorage. `digg serve` walks up from its default port when one is
 * busy, and localStorage is keyed on the origin, so port 9911 would remember a
 * layout that port 9910 had never heard of. The server already owns the theme
 * and the last namespace for the same reason; this is the rest of it.
 *
 * The initial values are stamped into the page (`window.__DIGG__.ui`), so the
 * first paint is already the right shape. Writes are debounced — dragging the
 * console's edge must not be one POST per pixel — and flushed on the way out
 * with `sendBeacon`, which is the only request the browser promises to send
 * for a tab that is closing.
 *
 * Values are small and JSON-clean. `null` deletes a key.
 */

import { useCallback, useSyncExternalStore } from "react";
import { boot0, streamUrl } from "./api.ts";

const FLUSH_MS = 400;

let state: Record<string, unknown> = { ...(boot0.ui ?? {}) };
let dirty: Record<string, unknown> = {};
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function flush(beacon = false): void {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    const patch = dirty;
    dirty = {};
    if (!Object.keys(patch).length) return;
    const body = JSON.stringify(patch);
    // sendBeacon cannot set headers, so the token rides in the query string —
    // the same door EventSource and the WebSocket use.
    const url = streamUrl("/api/ui");
    if (beacon && navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
    void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: beacon,
    }).catch(() => {
        /* a dropped preference is not worth a toast */
    });
}

if (typeof window !== "undefined") {
    // pagehide fires where unload does not (bfcache, mobile Safari); the
    // visibility hook catches a tab switched away from and never returned to.
    window.addEventListener("pagehide", () => flush(true));
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush(true);
    });
}

export function readUiState<T>(key: string, fallback: T): T {
    const v = state[key];
    return v === undefined ? fallback : (v as T);
}

export function writeUiState(key: string, value: unknown): void {
    if (Object.is(state[key], value)) return;
    state = { ...state, [key]: value };
    dirty[key] = value === undefined ? null : value;
    for (const l of listeners) l();
    if (!timer) timer = setTimeout(() => flush(), FLUSH_MS);
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * `useState` that outlives the tab. The setter takes a value or an updater,
 * like the real one, so callers do not have to restructure to use it.
 */
export function useUiState<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
    const value = useSyncExternalStore(
        subscribe,
        () => (state[key] === undefined ? fallback : (state[key] as T)),
        () => fallback,
    );
    const set = useCallback(
        (next: T | ((prev: T) => T)) => {
            const prev = state[key] === undefined ? fallback : (state[key] as T);
            writeUiState(key, typeof next === "function" ? (next as (p: T) => T)(prev) : next);
        },
        // `fallback` is a literal at every call site; keying on it would make
        // the setter new on every render for object defaults.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [key],
    );
    return [value, set];
}

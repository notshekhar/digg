/**
 * App state in ~80 lines instead of a state library.
 *
 * What lives here is only the state that two distant components must agree on:
 * which cluster and namespaces are selected, the kind catalog, the open
 * terminals, the port-forwards and the toasts. Anything one screen owns alone
 * (a filter box, a scroll position, an editor buffer) stays in that component.
 */

import { useSyncExternalStore } from "react";
import type { CatalogGroup, Forward, KindMeta } from "./types.ts";
import { live } from "./live.ts";

export interface TerminalSession {
    id: string;
    title: string;
    kind: "container" | "node" | "local" | "debug";
    context: string;
    ns?: string;
    pod?: string;
    container?: string;
    node?: string;
}

export interface Toast {
    id: number;
    tone: "ok" | "bad" | "info";
    text: string;
    detail?: string;
}

export interface AppState {
    ready: boolean;
    error: string | null;
    version: string;
    canExec: boolean;
    cluster: { client: string; server: string; platform: string } | null;

    contexts: string[];
    context: string;

    namespaces: string[];

    catalog: CatalogGroup[];
    kinds: KindMeta[];

    theme: "light" | "dark";
    live: boolean;
    refreshSeconds: number;

    forwards: Forward[];
    terminals: TerminalSession[];
    dock: { open: boolean; tab: string; height: number };

    toasts: Toast[];
    /** Bumped to force every data view to refetch now. */
    refreshTick: number;
    /** True for a beat after a manual refresh, purely so it is visible. */
    refreshing: boolean;
}

const initial: AppState = {
    ready: false,
    error: null,
    version: "",
    canExec: false,
    cluster: null,
    contexts: [],
    context: "",
    namespaces: [],
    catalog: [],
    kinds: [],
    theme: (document.documentElement.dataset.theme as "light" | "dark") ?? "dark",
    live: true,
    refreshSeconds: 5,
    forwards: [],
    terminals: [],
    dock: { open: false, tab: "", height: 320 },
    toasts: [],
    refreshTick: 0,
    refreshing: false,
};

let state = initial;
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
    const next = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...next };
    emit();
}

export function getState(): AppState {
    return state;
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function useApp<T>(selector: (s: AppState) => T): T {
    return useSyncExternalStore(
        subscribe,
        () => selector(state),
        () => selector(initial),
    );
}

/** Whole-state hook, for the few components that need most of it. */
export function useAppState(): AppState {
    return useSyncExternalStore(subscribe, () => state, () => initial);
}

// ── toasts ─────────────────────────────────────────────────────────────────

let toastSeq = 0;

export function toast(tone: Toast["tone"], text: string, detail?: string): void {
    const id = ++toastSeq;
    setState((s) => ({ toasts: [...s.toasts, { id, tone, text, detail }] }));
    // Failures stay long enough to read a kubectl error; successes get out of
    // the way.
    setTimeout(() => dismissToast(id), tone === "bad" ? 9000 : 3500);
}

export function dismissToast(id: number): void {
    setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/**
 * Refresh everything, now.
 *
 * With a live stream this button looks redundant, and it is not: it is how you
 * say "I do not trust what I am looking at". It re-asks the socket for a fresh
 * snapshot AND kicks the polled views, then flags `refreshing` for a beat —
 * without that flag a refresh on a healthy stream changes nothing on screen and
 * the button feels broken.
 */
export function refreshNow(): void {
    setState((s) => ({ refreshTick: s.refreshTick + 1, refreshing: true }));
    live.resync();
    setTimeout(() => setState({ refreshing: false }), 650);
}

// ── terminals ──────────────────────────────────────────────────────────────

let termSeq = 0;

export function openTerminal(session: Omit<TerminalSession, "id">): string {
    const id = `t${++termSeq}`;
    setState((s) => ({
        terminals: [...s.terminals, { ...session, id }],
        dock: { ...s.dock, open: true, tab: id },
    }));
    return id;
}

export function closeTerminal(id: string): void {
    setState((s) => {
        const terminals = s.terminals.filter((t) => t.id !== id);
        const tab = s.dock.tab === id ? (terminals[terminals.length - 1]?.id ?? "forwards") : s.dock.tab;
        return { terminals, dock: { ...s.dock, tab, open: terminals.length > 0 || tab === "forwards" } };
    });
}

export function setDock(patch: Partial<AppState["dock"]>): void {
    setState((s) => ({ dock: { ...s.dock, ...patch } }));
}

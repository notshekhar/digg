/**
 * The one place that talks to the server.
 *
 * Every call carries the per-run token from the page (see serve.ts) — as a
 * header for fetch, as a query parameter for EventSource and WebSocket, which
 * cannot set headers. Errors arrive as `{error}` JSON and are rethrown as real
 * Errors so callers can just try/catch.
 */

import type {
    ActionResult,
    Boot,
    ClusterEvent,
    Detail,
    Forward,
    ListResult,
    Overview,
    ResourceRef,
    RevisionRow,
} from "./types.ts";

declare global {
    interface Window {
        __DIGG__?: { theme: "light" | "dark"; version: string; token: string; context?: string };
    }
}

export const boot0 = window.__DIGG__ ?? { theme: "dark" as const, version: "dev", token: "", context: undefined };

/** Dev server (bun run dev) has no injected token; the proxy target has one. */
const TOKEN = boot0.token;

type Params = Record<string, string | number | boolean | null | undefined>;

function qs(params: Params = {}): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v === null || v === undefined || v === "") continue;
        sp.set(k, String(v));
    }
    return sp.toString();
}

async function req<T>(path: string, params: Params = {}, init?: RequestInit): Promise<T> {
    const query = qs(params);
    const res = await fetch(`${path}${query ? `?${query}` : ""}`, {
        ...init,
        headers: {
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            "x-digg-token": TOKEN,
            ...(init?.headers ?? {}),
        },
    });
    const text = await res.text();
    let data: unknown = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(text.slice(0, 500) || `${res.status} ${res.statusText}`);
    }
    if (!res.ok) {
        const msg = (data as { error?: string; message?: string })?.error ?? (data as { message?: string })?.message;
        throw new Error(msg || `${res.status} ${res.statusText}`);
    }
    return data as T;
}

/** URL for endpoints the browser opens itself (EventSource, WebSocket). */
export function streamUrl(path: string, params: Params = {}): string {
    const query = qs({ ...params, token: TOKEN });
    return `${path}?${query}`;
}

export const api = {
    boot: () => req<Boot>("/api/boot"),

    namespaces: (context: string) => req<{ namespaces: string[] }>("/api/namespaces", { context }),

    catalog: (context: string) => req<{ catalog: Boot["catalog"] }>("/api/catalog", { context }),

    list: (p: { context: string; kind: string; ns?: string | null; q?: string }) =>
        req<ListResult>("/api/list", { context: p.context, kind: p.kind, ns: p.ns ?? "*", q: p.q }),

    detail: (p: { context: string; kind: string; name: string; ns?: string }) => req<Detail>("/api/detail", p),

    yaml: (p: { context: string; kind: string; name: string; ns?: string }) => req<{ text: string }>("/api/yaml", p),

    describe: (p: { context: string; kind: string; name: string; ns?: string }) =>
        req<{ text: string }>("/api/describe", p),

    dataKey: (p: { context: string; kind: string; name: string; ns?: string; key: string; decode?: boolean }) =>
        req<{ key: string; text: string }>("/api/data-key", { ...p, decode: p.decode ? 1 : 0 }),

    /** Every entry of a ConfigMap/Secret, decoded, for the data editor. */
    data: (p: { context: string; kind: string; name: string; ns?: string }) =>
        req<{
            kind: string;
            encoded: boolean;
            immutable: boolean;
            type: string;
            entries: { key: string; text: string; binary: boolean; bytes: number }[];
        }>("/api/data", p),

    events: (p: { context: string; ns?: string | null; limit?: number }) =>
        req<{ events: ClusterEvent[] }>("/api/events", { context: p.context, ns: p.ns ?? "*", limit: p.limit }),

    overview: (context: string) => req<Overview>("/api/overview", { context }),

    metrics: (p: { context: string; ns?: string | null }) =>
        req<{
            nodes: Record<string, { cpu: string; cpuPercent: number | null; memory: string; memoryPercent: number | null }>;
            pods: Record<string, { cpu: string; memory: string }>;
            available: boolean;
        }>("/api/metrics", { context: p.context, ns: p.ns ?? "*" }),

    history: (p: { context: string; kind: string; name: string; ns?: string }) =>
        req<{ revisions: { revision: string; change: string }[] }>("/api/history", p),

    /** ReplicaSets (or ControllerRevisions) behind a workload's rollout. */
    revisions: (p: { context: string; kind: string; name: string; ns?: string }) =>
        req<{ revisions: RevisionRow[] }>("/api/revisions", p),

    action: (body: Record<string, unknown>) =>
        req<ActionResult>("/api/action", {}, { method: "POST", body: JSON.stringify(body) }),

    prefs: (body: Record<string, unknown>) =>
        req<{ ok: boolean }>("/api/prefs", {}, { method: "POST", body: JSON.stringify(body) }),

    forwards: (context?: string) => req<{ forwards: Forward[] }>("/api/forwards", { context }),

    startForward: (body: { context: string; kind: string; name: string; ns?: string; remotePort: number; localPort?: number }) =>
        req<{ forward: Forward }>("/api/forwards", {}, { method: "POST", body: JSON.stringify(body) }),

    stopForward: (id: string) => req<{ ok: boolean }>("/api/forwards", { id }, { method: "DELETE" }),
};

/** Convenience for the many call sites that hold a ref plus a context. */
export function refParams(context: string, ref: ResourceRef) {
    return { context, kind: ref.kind, name: ref.name, ns: ref.ns };
}

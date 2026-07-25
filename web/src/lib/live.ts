/**
 * The live socket, client side.
 *
 * One WebSocket for the whole app, multiplexed by subscription id: switching
 * kinds is a message, not a new connection. The server pushes a snapshot then
 * deltas, so a table updates the moment the cluster does instead of on the next
 * poll.
 *
 * Degradation is explicit, never silent. If the socket cannot connect, or the
 * server says a kind is unwatchable (aggregated APIs like metrics.k8s.io have
 * no watch verb, and RBAC can allow list but forbid watch), subscribers are
 * told so the screen falls back to polling — a table that quietly stops
 * updating is worse than one that admits it is sampling.
 */

import type { KindMeta, Row } from "./types.ts";
import { streamUrl } from "./api.ts";

export type LiveStatus = "connecting" | "live" | "offline";

export interface ListSubscription {
    type: "list";
    context: string;
    kind: string;
    ns: string | null;
}

export interface DetailSubscription {
    type: "detail";
    context: string;
    kind: string;
    ns?: string;
    name: string;
}

export type Subscription = ListSubscription | DetailSubscription;

export interface Handlers {
    onSnapshot?: (payload: { columns: string[]; rows: Row[]; kind: KindMeta }) => void;
    onDelta?: (payload: { upsert: Row[]; remove: string[] }) => void;
    onDetail?: (data: unknown) => void;
    /** `fatal` means this subscription will never work — go poll instead. */
    onError?: (message: string, fatal: boolean, gone: boolean) => void;
}

interface Entry {
    id: string;
    sub: Subscription;
    handlers: Handlers;
}

/** Reconnect backoff: quick enough to feel instant, slow enough not to spin. */
const BACKOFF_MS = [400, 800, 1600, 3200, 6400, 10_000];

class LiveClient {
    private ws: WebSocket | null = null;
    private readonly entries = new Map<string, Entry>();
    private readonly statusListeners = new Set<(s: LiveStatus) => void>();
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private seq = 0;
    status: LiveStatus = "offline";

    subscribe(sub: Subscription, handlers: Handlers): () => void {
        const id = `s${++this.seq}`;
        const entry: Entry = { id, sub, handlers };
        this.entries.set(id, entry);
        this.ensureSocket();
        if (this.ws?.readyState === WebSocket.OPEN) this.sendSub(entry);
        return () => {
            this.entries.delete(id);
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.send({ t: "unsub", id });
            }
            // The socket is kept open: subscriptions come and go constantly as
            // the user browses, and reconnecting each time would cost a
            // round-trip on every navigation.
        };
    }

    onStatus(fn: (s: LiveStatus) => void): () => void {
        this.statusListeners.add(fn);
        fn(this.status);
        return () => this.statusListeners.delete(fn);
    }

    private setStatus(status: LiveStatus): void {
        if (this.status === status) return;
        this.status = status;
        for (const fn of this.statusListeners) fn(status);
    }

    private ensureSocket(): void {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        if (this.reconnectTimer) return;
        this.connect();
    }

    private connect(): void {
        this.setStatus(this.attempt === 0 ? "connecting" : this.status);
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const url = `${proto}://${window.location.host}${streamUrl("/api/watch")}`;
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.attempt = 0;
            this.setStatus("live");
            for (const entry of this.entries.values()) this.sendSub(entry);
            // A browser that suspends a background tab kills the socket without
            // telling us; a ping every 25s makes that visible quickly.
            this.heartbeat = setInterval(() => this.send({ t: "ping" }), 25_000);
        };

        ws.onmessage = (event) => {
            let msg: {
                t: string;
                id?: string;
                columns?: string[];
                rows?: Row[];
                kind?: KindMeta;
                upsert?: Row[];
                remove?: string[];
                data?: unknown;
                message?: string;
                fatal?: boolean;
                gone?: boolean;
            };
            try {
                msg = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (msg.t === "pong") return;
            const entry = msg.id ? this.entries.get(msg.id) : undefined;
            if (!entry) return;
            switch (msg.t) {
                case "snapshot":
                    entry.handlers.onSnapshot?.({ columns: msg.columns ?? [], rows: msg.rows ?? [], kind: msg.kind! });
                    break;
                case "delta":
                    entry.handlers.onDelta?.({ upsert: msg.upsert ?? [], remove: msg.remove ?? [] });
                    break;
                case "detail":
                    entry.handlers.onDetail?.(msg.data);
                    break;
                case "error":
                    entry.handlers.onError?.(msg.message ?? "watch failed", Boolean(msg.fatal), Boolean(msg.gone));
                    break;
            }
        };

        const down = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            if (this.heartbeat) {
                clearInterval(this.heartbeat);
                this.heartbeat = null;
            }
            this.setStatus("offline");
            if (this.entries.size > 0) this.scheduleReconnect();
        };
        ws.onclose = down;
        ws.onerror = down;
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
        this.attempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.entries.size > 0) this.connect();
        }, delay);
    }

    private sendSub(entry: Entry): void {
        this.send({ t: "sub", id: entry.id, sub: entry.sub });
    }

    private send(payload: Record<string, unknown>): void {
        try {
            this.ws?.send(JSON.stringify(payload));
        } catch {
            /* the socket is going down; onclose will reconnect */
        }
    }

    /**
     * Re-ask the server for everything.
     *
     * Streaming makes a refresh button look pointless, but it is not: it is how
     * you say "I don't trust what I'm looking at". Re-sending each subscription
     * makes the server drop its rendered state and reply with a fresh snapshot
     * (from the watch's own store, so no extra kubectl list), and a detail page
     * rebuilds immediately.
     */
    resync(): void {
        if (this.ws?.readyState !== WebSocket.OPEN) {
            this.wake();
            return;
        }
        for (const entry of this.entries.values()) this.sendSub(entry);
    }

    /** Called when the tab becomes visible again — reconnect without waiting. */
    wake(): void {
        if (this.entries.size === 0) return;
        if (this.ws?.readyState === WebSocket.OPEN) return;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.attempt = 0;
        this.connect();
    }
}

export const live = new LiveClient();

if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") live.wake();
    });
    window.addEventListener("online", () => live.wake());
}

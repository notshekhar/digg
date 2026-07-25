/** Display helpers. The server sends facts; these turn them into type. */

import type { Tone } from "./types.ts";

export function ageFromMs(ts: number): string {
    if (!ts) return "";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    const m = s / 60;
    if (m < 60) return `${Math.floor(m)}m`;
    const h = m / 60;
    if (h < 24) return `${Math.floor(h)}h`;
    const d = h / 24;
    if (d < 365) return `${Math.floor(d)}d`;
    return `${Math.floor(d / 365)}y`;
}

export function ageFromIso(iso: string): string {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? ageFromMs(t) : "";
}

const UNITS = ["B", "Ki", "Mi", "Gi", "Ti", "Pi"];

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0";
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < UNITS.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n >= 100 || i === 0 ? Math.round(n) : Math.round(n * 10) / 10}${UNITS[i]}`;
}

export function formatCpu(cores: number): string {
    if (!Number.isFinite(cores) || cores === 0) return "0";
    if (cores < 1) return `${Math.round(cores * 1000)}m`;
    return cores < 10 ? String(Math.round(cores * 100) / 100) : String(Math.round(cores));
}

/**
 * Status → colour. The one classifier the whole UI shares, so a Pending pod is
 * the same amber in the grid, the drawer and the overview.
 */
export function toneOf(value: string): Tone {
    const v = value.toLowerCase().trim();
    if (!v) return "neutral";
    if (
        v === "running" ||
        v === "active" ||
        v === "ready" ||
        v === "bound" ||
        v === "succeeded" ||
        v === "completed" ||
        v === "available" ||
        v === "true" ||
        v === "healthy"
    ) {
        return "ok";
    }
    if (
        v === "pending" ||
        v === "containercreating" ||
        v === "podinitializing" ||
        v === "terminating" ||
        v === "notready" ||
        v === "progressing" ||
        v === "suspended" ||
        v === "released" ||
        v === "false"
    ) {
        return "warn";
    }
    if (
        v.includes("error") ||
        v.includes("failed") ||
        v.includes("backoff") ||
        v === "evicted" ||
        v === "oomkilled" ||
        v === "unknown" ||
        v === "lost"
    ) {
        return "bad";
    }
    return "neutral";
}

/** "3/3" → ok, "1/3" → warn, "0/3" → bad. Used for READY columns. */
export function readyTone(value: string): Tone | null {
    const m = /^(\d+)\/(\d+)$/.exec(value.trim());
    if (!m) return null;
    const have = Number(m[1]);
    const want = Number(m[2]);
    if (want === 0) return "neutral";
    if (have >= want) return "ok";
    return have === 0 ? "bad" : "warn";
}

export function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** Locale-free, sortable clock for log timestamps and event tables. */
export function clock(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function shortDate(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

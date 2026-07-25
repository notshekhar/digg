/**
 * Kubernetes quantity parsing and display.
 *
 * The API and `kubectl top` speak in suffixed quantities — "100m", "1Gi",
 * "2500Ki", "1e3" — and every gauge in the UI needs them as plain numbers.
 * Two conversions matter and they are not the same:
 *
 *   CPU     millicores → cores. "100m" is 0.1 of a core; a bare "2" is 2 cores.
 *   MEMORY  binary and decimal suffixes coexist. Ki/Mi/Gi are 1024-based and
 *           K/M/G are 1000-based; treating them alike understates a limit by 7%
 *           at Gi, which is exactly the kind of quiet error a dashboard should
 *           never introduce.
 */

const BINARY: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
};

const DECIMAL: Record<string, number> = {
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    "": 1,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
};

/** Parse any quantity to its base unit (cores for CPU, bytes for memory). */
export function parseQuantity(value: string | number | undefined | null): number {
    if (value === undefined || value === null) return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const text = value.trim();
    if (!text) return 0;

    const m = /^([+-]?[0-9.]+(?:[eE][+-]?[0-9]+)?)\s*([A-Za-z]*)$/.exec(text);
    if (!m) return 0;
    const num = Number(m[1]);
    if (!Number.isFinite(num)) return 0;
    const suffix = m[2] ?? "";
    if (suffix in BINARY) return num * BINARY[suffix]!;
    if (suffix in DECIMAL) return num * DECIMAL[suffix]!;
    return num;
}

/** Cores as a number: "250m" → 0.25, "2" → 2. */
export const parseCpu = parseQuantity;

/** Bytes as a number: "1Gi" → 1073741824. */
export const parseMemory = parseQuantity;

/** Cores for humans: 0.25 → "250m", 2 → "2", 2.5 → "2.5". */
export function formatCpu(cores: number): string {
    if (!Number.isFinite(cores) || cores === 0) return "0";
    if (cores < 1) return `${Math.round(cores * 1000)}m`;
    return cores < 10 ? String(Math.round(cores * 100) / 100) : String(Math.round(cores));
}

const UNITS = ["B", "Ki", "Mi", "Gi", "Ti", "Pi"];

/** Bytes for humans, binary units the way kubectl prints them. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0";
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < UNITS.length - 1) {
        n /= 1024;
        i++;
    }
    const rounded = n >= 100 || i === 0 ? Math.round(n) : Math.round(n * 10) / 10;
    return `${rounded}${UNITS[i]}`;
}

/** Percentage clamped to [0,100]; returns null when the denominator is unknown. */
export function percent(used: number, total: number): number | null {
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
    return Math.max(0, Math.min(100, (used / total) * 100));
}

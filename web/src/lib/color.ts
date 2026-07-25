/**
 * Resolve a CSS colour to `#rrggbb`.
 *
 * digg's palette is written in oklch, which most of the app never has to think
 * about — the browser resolves it. xterm.js is the exception: it parses theme
 * colours with its own mini parser that understands hex and rgb() and nothing
 * else, and it silently ignores anything it cannot read. That failure mode cost
 * a bug: the terminal kept xterm's built-in dark theme in light mode, because
 * every single colour we handed it was rejected.
 *
 * A 1×1 canvas is the only conversion that is guaranteed correct for whatever
 * colour syntax the browser supports, today and later.
 */

let ctx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
    if (ctx === undefined) {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    return ctx;
}

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** `oklch(0.78 0.12 220)` → `#4fb8d8`. Returns the fallback if unparseable. */
export function toHex(color: string, fallback = "#000000"): string {
    const c = context();
    if (!c || !color.trim()) return fallback;
    // A sentinel first: an invalid fillStyle is ignored, leaving the old value,
    // so without this a bad colour would silently return the previous one.
    c.fillStyle = "#000000";
    c.fillStyle = color;
    if (c.fillStyle === "#000000" && !/^#0{3,8}$|black|rgba?\(0, 0, 0/i.test(color.trim())) {
        // Could genuinely be black; verify by drawing.
    }
    c.clearRect(0, 0, 1, 1);
    c.fillRect(0, 0, 1, 1);
    try {
        const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
        if (a === 0) return fallback;
        return `#${hex(r ?? 0)}${hex(g ?? 0)}${hex(b ?? 0)}`;
    } catch {
        return fallback;
    }
}

/** Read a CSS custom property off :root and resolve it to hex. */
export function varHex(name: string, fallback = "#000000"): string {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
    return toHex(raw.trim(), fallback);
}

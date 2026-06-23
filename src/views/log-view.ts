import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { logLevelColor, ui } from "../theme.ts";
import { spinnerFrame } from "../spinner.ts";
import { center } from "./layout.ts";

const MAX_LINES = 5000;

/**
 * A live log pane. Lines are appended as `kubectl logs -f` streams them.
 * While "following", the view sticks to the bottom; scrolling up detaches
 * follow, and `f` toggles it back on (re-attaching to the tail).
 *
 * Horizontal panning is clamped to the widest line in the buffer, and `w`
 * toggles soft-wrap (VS Code style) which drops horizontal scrolling entirely.
 */
const HSTEP = 8;

export class LogView {
    private title: string;
    private lines: string[] = [];
    private offset = 0;
    private hoffset = 0;
    private follow = true;
    private wrap = false;
    private margin = 1;
    private pending = "";
    private mouseOn = true;
    /** Widest line in the buffer (visible columns) — bounds horizontal pan. */
    private maxWidth = 0;
    /** Body column width + total visual rows from the last render, for clamping. */
    private lastColWidth = 80;
    private lastTotalRows = 0;

    public onBack?: () => void;
    /** Toggle mouse capture; returns whether capture is now on. */
    public onToggleMouse?: () => boolean;

    constructor(title: string) {
        this.title = title;
    }

    /** Feed a raw chunk of stdout; splits into lines and keeps the tail. */
    append(chunk: string): void {
        this.pending += chunk;
        const parts = this.pending.split("\n");
        this.pending = parts.pop() ?? "";
        for (const line of parts) {
            this.lines.push(line);
            const w = visibleWidth(line);
            if (w > this.maxWidth) {
                this.maxWidth = w;
            }
        }
        const overflow = this.lines.length - MAX_LINES;
        if (overflow > 0) {
            const dropped = this.lines.splice(0, overflow);
            // Only rescan when we might have dropped the current widest line.
            if (dropped.some((l) => visibleWidth(l) >= this.maxWidth)) {
                this.maxWidth = this.lines.reduce((m, l) => Math.max(m, visibleWidth(l)), 0);
            }
        }
        // Follow snapping happens in render(), which knows the wrapped row count.
    }

    private viewportHeight(): number {
        // header + rule + footer = 3 reserved; body fills the rest.
        return Math.max(1, (process.stdout.rows || 24) - 3);
    }

    private maxOffset(): number {
        return Math.max(0, this.lastTotalRows - this.viewportHeight());
    }

    /** Furthest right we can pan: the widest line minus the viewport width. */
    private maxHoffset(): number {
        if (this.wrap) {
            return 0;
        }
        return Math.max(0, this.maxWidth - this.lastColWidth);
    }

    private clamp(): void {
        this.offset = Math.min(Math.max(0, this.offset), this.maxOffset());
        this.hoffset = Math.min(Math.max(0, this.hoffset), this.maxHoffset());
    }

    handleInput(data: string): void {
        const page = Math.max(1, this.viewportHeight() - 1);
        if (matchesKey(data, "up") || matchesKey(data, "k")) {
            this.offset -= 1;
            this.follow = false;
        } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
            this.offset += 1;
        } else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
            this.offset -= page;
            this.follow = false;
        } else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) {
            this.offset += page;
        } else if (matchesKey(data, "g") || matchesKey(data, "home")) {
            this.offset = 0;
            this.follow = false;
        } else if (matchesKey(data, "left") || matchesKey(data, "h")) {
            this.hoffset = Math.max(0, this.hoffset - HSTEP);
        } else if (matchesKey(data, "right") || matchesKey(data, "l")) {
            this.hoffset += HSTEP;
        } else if (matchesKey(data, "f")) {
            this.follow = !this.follow;
            if (this.follow) {
                this.offset = this.maxOffset();
            }
        } else if (matchesKey(data, "w")) {
            this.wrap = !this.wrap;
            this.hoffset = 0;
        } else if (matchesKey(data, "m")) {
            this.mouseOn = this.onToggleMouse?.() ?? this.mouseOn;
        } else if (matchesKey(data, "escape") || matchesKey(data, "q")) {
            this.onBack?.();
            return;
        } else if (data.startsWith("\x1b[<")) {
            this.handleMouse(data);
        }
        this.clamp();
    }

    private handleMouse(data: string): void {
        const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
        if (!match) {
            return;
        }
        const button = Number(match[1]);
        if (button === 64) {
            // wheel up
            this.offset -= 3;
            this.follow = false;
        } else if (button === 65) {
            // wheel down
            this.offset += 3;
        } else if (button === 66) {
            // wheel left (or shift+wheel on some terminals)
            this.hoffset = Math.max(0, this.hoffset - HSTEP);
        } else if (button === 67) {
            // wheel right
            this.hoffset += HSTEP;
        }
    }

    render(width: number): string[] {
        const height = this.viewportHeight();
        const gutter = " ".repeat(this.margin);
        const colWidth = Math.max(1, width - this.margin);
        this.lastColWidth = colWidth;

        let body: string[];
        if (this.wrap) {
            // Soft-wrap each line into visual rows; offset indexes those rows.
            const rows: Array<{ text: string; src: string }> = [];
            for (const line of this.lines) {
                for (const piece of wrapTextWithAnsi(line, colWidth)) {
                    rows.push({ text: piece, src: line });
                }
            }
            this.lastTotalRows = rows.length;
            if (this.follow) {
                this.offset = Math.max(0, rows.length - height);
            }
            this.clamp();
            body = rows.slice(this.offset, this.offset + height).map(({ text, src }) => {
                const color = logLevelColor(src);
                const visible = truncateToWidth(text, colWidth);
                return `${gutter}${color ? color(visible) : visible}`;
            });
        } else {
            this.lastTotalRows = this.lines.length;
            if (this.follow) {
                this.offset = Math.max(0, this.lines.length - height);
            }
            this.clamp();
            body = this.lines.slice(this.offset, this.offset + height).map((line) => {
                // Detect level from the full line, but color only the visible slice
                // (slicing first keeps horizontal panning ANSI-safe).
                const visible = truncateToWidth(line.slice(this.hoffset), colWidth);
                const color = logLevelColor(line);
                return `${gutter}${color ? color(visible) : visible}`;
            });
        }
        while (body.length < height) {
            body.push("");
        }
        // Nothing has streamed yet: float a centered "waiting for logs…" line so
        // the pane never looks frozen while `kubectl logs -f` connects.
        if (this.lines.length === 0) {
            body[Math.floor(height / 2)] = center(ui.dim(`${spinnerFrame()} waiting for logs…`), width);
        }

        const state = this.follow ? ui.accent("following") : ui.dim("paused");
        const wrapTag = this.wrap ? `  ${ui.dim("wrap")}` : "";
        const mouse = this.mouseOn ? "" : `  ${ui.accent("select mode — drag to copy")}`;
        const header = pad(`${ui.headerBar(` ${this.title} `)}  ${state}${wrapTag}${mouse}`, width);
        const rule = ui.rule("─".repeat(width));
        const hint = this.wrap
            ? "↑/↓ scroll · w unwrap · f follow · m select · esc back"
            : "↑/↓ scroll · ←/→ pan · w wrap · f follow · m select · esc back";
        const footer = pad(`${gutter}${ui.footer(hint)}`, width);
        return [header, rule, ...body, footer];
    }
}

function pad(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

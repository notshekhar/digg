import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { ui } from "../theme.ts";

const HSTEP = 8;

/**
 * A full-screen scrollable text pane for YAML / describe / revisions output.
 * Scrolls vertically (keys + wheel) and horizontally (←/→), reports esc/q via
 * onBack, and optionally exposes an edit action (onEdit) for editable YAML.
 */
export class ScrollView {
    private title: string;
    private lines: string[];
    private offset = 0;
    private hoffset = 0;
    private margin = 1;
    private mouseOn = false;

    public onBack?: () => void;
    public onEdit?: () => void;
    /** Toggle mouse capture; returns whether capture is now on. */
    public onToggleMouse?: () => boolean;

    constructor(title: string, text: string) {
        this.title = title;
        this.lines = text.split("\n");
    }

    private viewportHeight(): number {
        const rows = process.stdout.rows || 24;
        return Math.max(1, rows - 3);
    }

    private maxOffset(): number {
        return Math.max(0, this.lines.length - this.viewportHeight());
    }

    private maxHoffset(): number {
        return this.lines.reduce((max, line) => Math.max(max, line.length), 0);
    }

    private clamp(): void {
        this.offset = Math.min(Math.max(0, this.offset), this.maxOffset());
        this.hoffset = Math.min(Math.max(0, this.hoffset), this.maxHoffset());
    }

    handleInput(data: string): boolean {
        const page = Math.max(1, this.viewportHeight() - 1);
        if (matchesKey(data, "up") || matchesKey(data, "k")) {
            this.offset -= 1;
        } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
            this.offset += 1;
        } else if (matchesKey(data, "left") || matchesKey(data, "h")) {
            this.hoffset -= HSTEP;
        } else if (matchesKey(data, "right") || matchesKey(data, "l")) {
            this.hoffset += HSTEP;
        } else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
            this.offset -= page;
        } else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) {
            this.offset += page;
        } else if (matchesKey(data, "g") || matchesKey(data, "home")) {
            this.offset = 0;
            this.hoffset = 0;
        } else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) {
            this.offset = this.maxOffset();
        } else if (matchesKey(data, "e") && this.onEdit) {
            this.onEdit();
            return true;
        } else if (matchesKey(data, "m") && this.onToggleMouse) {
            this.mouseOn = this.onToggleMouse();
            return true;
        } else if (matchesKey(data, "escape") || matchesKey(data, "q")) {
            this.onBack?.();
            return true;
        } else if (data.startsWith("\x1b[<")) {
            this.handleMouse(data);
        } else {
            return false;
        }
        this.clamp();
        return true;
    }

    private handleMouse(data: string): void {
        const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
        if (!match) {
            return;
        }
        const button = Number(match[1]);
        if (button === 64) {
            this.offset -= 3;
        } else if (button === 65) {
            this.offset += 3;
        }
        this.clamp();
    }

    render(width: number): string[] {
        this.clamp();
        const height = this.viewportHeight();
        const gutter = " ".repeat(this.margin);
        const colWidth = Math.max(1, width - this.margin);
        const window = this.lines.slice(this.offset, this.offset + height);
        const body = window.map((line) => `${gutter}${slice(line, this.hoffset, colWidth)}`);
        while (body.length < height) {
            body.push("");
        }

        const total = Math.max(1, this.lines.length);
        const percent = Math.round((Math.min(this.offset + height, total) / total) * 100);
        const col = this.hoffset > 0 ? ` ·  ←${this.hoffset}` : "";

        const mouse = this.mouseOn ? `  ${ui.accent("wheel-scroll on")}` : `  ${ui.dim("drag to select/copy")}`;
        const header = padLine(`${ui.headerBar(` ${this.title} `)}${mouse}`, width);
        const rule = ui.rule("─".repeat(width));
        const editHint = this.onEdit ? " · e edit" : "";
        const footer = padLine(
            `${gutter}${ui.footer(`↑/↓ scroll · ←/→ pan · g/G top/bottom${editHint} · m wheel · esc back`)}  ${ui.accent(`${percent}%${col}`)}`,
            width,
        );
        return [header, rule, ...body, footer];
    }
}

/** Plain-text horizontal slice (kubectl output has no ANSI), then truncate. */
function slice(text: string, from: number, width: number): string {
    const sliced = text.slice(from);
    return sliced.length <= width ? sliced : sliced.slice(0, Math.max(0, width - 1)) + "…";
}

function padLine(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

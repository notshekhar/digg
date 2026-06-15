import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { ui } from "../theme.ts";

/**
 * A full-screen scrollable text pane for YAML / describe / logs output.
 * Handles keyboard + mouse-wheel scrolling and reports `esc`/`q` via onBack.
 */
export class ScrollView {
    private title: string;
    private lines: string[];
    private offset = 0;
    private margin = 1;

    public onBack?: () => void;

    constructor(title: string, text: string) {
        this.title = title;
        this.lines = text.split("\n");
    }

    private viewportHeight(): number {
        const rows = process.stdout.rows || 24;
        return Math.max(1, rows - 4);
    }

    private maxOffset(): number {
        return Math.max(0, this.lines.length - this.viewportHeight());
    }

    private clamp(): void {
        this.offset = Math.min(Math.max(0, this.offset), this.maxOffset());
    }

    handleInput(data: string): boolean {
        const page = Math.max(1, this.viewportHeight() - 1);
        if (matchesKey(data, "up") || matchesKey(data, "k")) {
            this.offset -= 1;
        } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
            this.offset += 1;
        } else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
            this.offset -= page;
        } else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) {
            this.offset += page;
        } else if (matchesKey(data, "g") || matchesKey(data, "home")) {
            this.offset = 0;
        } else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) {
            this.offset = this.maxOffset();
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
        const window = this.lines.slice(this.offset, this.offset + height);
        const body = window.map((line) => `${gutter}${truncate(line, width - this.margin)}`);
        while (body.length < height) {
            body.push("");
        }

        const total = Math.max(1, this.lines.length);
        const percent = Math.round((Math.min(this.offset + height, total) / total) * 100);

        const header = padLine(ui.headerBar(` ${this.title} `), width);
        const rule = ui.rule("─".repeat(width));
        const footer = padLine(
            `${gutter}${ui.footer("↑/↓ scroll · g/G top/bottom · esc back")}  ${ui.accent(`${percent}%`)}`,
            width,
        );
        return [header, rule, ...body, footer];
    }
}

function truncate(text: string, width: number): string {
    if (visibleWidth(text) <= width) {
        return text;
    }
    // Plain (no ANSI) truncation is enough for kubectl text output.
    return text.slice(0, Math.max(0, width - 1)) + "…";
}

function padLine(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

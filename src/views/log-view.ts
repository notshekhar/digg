import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ui } from "../theme.ts";

const MAX_LINES = 5000;

/**
 * A live log pane. Lines are appended as `kubectl logs -f` streams them.
 * While "following", the view sticks to the bottom; scrolling up detaches
 * follow, and `G`/End re-attaches it.
 */
const HSTEP = 8;

export class LogView {
    private title: string;
    private lines: string[] = [];
    private offset = 0;
    private hoffset = 0;
    private follow = true;
    private margin = 1;
    private pending = "";
    private mouseOn = true;

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
        }
        if (this.lines.length > MAX_LINES) {
            this.lines.splice(0, this.lines.length - MAX_LINES);
        }
        if (this.follow) {
            this.offset = this.maxOffset();
        }
    }

    private viewportHeight(): number {
        // header + rule + footer = 3 reserved; body fills the rest.
        return Math.max(1, (process.stdout.rows || 24) - 3);
    }

    private maxOffset(): number {
        return Math.max(0, this.lines.length - this.viewportHeight());
    }

    private clamp(): void {
        this.offset = Math.min(Math.max(0, this.offset), this.maxOffset());
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
        } else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) {
            this.follow = true;
            this.offset = this.maxOffset();
        } else if (matchesKey(data, "left") || matchesKey(data, "h")) {
            this.hoffset = Math.max(0, this.hoffset - HSTEP);
        } else if (matchesKey(data, "right")) {
            this.hoffset += HSTEP;
        } else if (matchesKey(data, "f")) {
            this.follow = !this.follow;
            if (this.follow) {
                this.offset = this.maxOffset();
            }
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
            this.offset -= 3;
            this.follow = false;
        } else if (button === 65) {
            this.offset += 3;
        }
    }

    render(width: number): string[] {
        this.clamp();
        const height = this.viewportHeight();
        const gutter = " ".repeat(this.margin);
        const colWidth = Math.max(1, width - this.margin);
        const window = this.lines.slice(this.offset, this.offset + height);
        const body = window.map((line) => `${gutter}${truncateToWidth(line.slice(this.hoffset), colWidth)}`);
        while (body.length < height) {
            body.push("");
        }

        const state = this.follow ? ui.accent("following") : ui.dim("paused");
        const mouse = this.mouseOn ? "" : `  ${ui.accent("mouse off — select to copy")}`;
        const header = pad(`${ui.headerBar(` ${this.title} `)}  ${state}${mouse}`, width);
        const rule = ui.rule("─".repeat(width));
        const footer = pad(
            `${gutter}${ui.footer("↑/↓ scroll · ←/→ pan · f follow · G live · m select · esc back")}`,
            width,
        );
        return [header, rule, ...body, footer];
    }
}

function pad(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

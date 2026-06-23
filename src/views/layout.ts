import { visibleWidth } from "@earendil-works/pi-tui";
import { ui } from "../theme.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Grey out the screen behind a modal so the popup reads as floating *above* the
 * content, not spliced into it. Existing colours are stripped first — otherwise
 * a bright selected row or status would still pop through the wash.
 */
function dimBackground(lines: string[]): string[] {
    return lines.map((line) => ui.dim(line.replace(ANSI, "")));
}

/** Pad a (possibly ANSI-styled) line with spaces to the given width. */
export function pad(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Pad a block of lines down to the full terminal height. */
export function fill(lines: string[]): string[] {
    const total = process.stdout.rows || 24;
    const out = [...lines];
    while (out.length < total) {
        out.push("");
    }
    return out;
}

/** Left-pad a line so its content is horizontally centered within width. */
export function center(text: string, width: number): string {
    const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
    return " ".repeat(left) + text;
}

/** Truncate plain (no-ANSI) text with an ellipsis. */
export function clipPlain(text: string, width: number): string {
    return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…";
}

/** Splice a centered, red confirmation box over the base screen lines. */
export function overlayConfirm(base: string[], message: string, width: number): string[] {
    const keys = `${ui.danger("[y] confirm")}    ${ui.dim("[n / esc] cancel")}`;
    const content = Math.min(width - 6, Math.max(visibleWidth(message), 24));
    const boxLine = (inner: string): string => {
        const padded = inner + " ".repeat(Math.max(0, content - visibleWidth(inner)));
        return ui.danger("│ ") + padded + ui.danger(" │");
    };
    const titleText = " Confirm ";
    const box = [
        ui.danger(`┌${titleText}${"─".repeat(Math.max(0, content + 2 - titleText.length))}┐`),
        boxLine(clipPlain(message, content)),
        boxLine(""),
        boxLine(center(keys, content)),
        ui.danger(`└${"─".repeat(content + 2)}┘`),
    ];

    return spliceBox(dimBackground(base), box, content, width);
}

/** Splice a centered input prompt over the base screen lines. */
export function overlayPrompt(base: string[], message: string, value: string, width: number): string[] {
    const content = Math.min(width - 6, Math.max(visibleWidth(message), 32));
    const boxLine = (inner: string): string => {
        const padded = inner + " ".repeat(Math.max(0, content - visibleWidth(inner)));
        return ui.accent("│ ") + padded + ui.accent(" │");
    };
    const titleText = " Input ";
    const input = `${ui.accent("›")} ${value}${ui.accent("▏")}`;
    const box = [
        ui.accent(`┌${titleText}${"─".repeat(Math.max(0, content + 2 - titleText.length))}┐`),
        boxLine(clipPlain(message, content)),
        boxLine(""),
        boxLine(input),
        boxLine(ui.dim("enter confirm · esc cancel")),
        ui.accent(`└${"─".repeat(content + 2)}┘`),
    ];
    return spliceBox(dimBackground(base), box, content, width);
}

/** Splice a small centered spinner box over the base screen lines. */
export function overlayLoading(base: string[], label: string, frame: string, width: number): string[] {
    const text = `${ui.accent(frame)} ${label}`;
    const content = Math.min(width - 6, Math.max(visibleWidth(text), 18));
    const boxLine = (inner: string): string => {
        const padded = inner + " ".repeat(Math.max(0, content - visibleWidth(inner)));
        return ui.accent("│ ") + padded + ui.accent(" │");
    };
    const box = [
        ui.accent(`┌${"─".repeat(content + 2)}┐`),
        boxLine(center(text, content)),
        ui.accent(`└${"─".repeat(content + 2)}┘`),
    ];
    return spliceBox(dimBackground(base), box, content, width);
}

function spliceBox(base: string[], box: string[], content: number, width: number): string[] {
    const lines = [...base];
    const startRow = Math.max(0, Math.floor((lines.length - box.length) / 2));
    const leftPad = " ".repeat(Math.max(0, Math.floor((width - (content + 4)) / 2)));
    box.forEach((line, i) => {
        if (startRow + i < lines.length) {
            lines[startRow + i] = leftPad + line;
        }
    });
    return lines;
}

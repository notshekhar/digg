import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { ui } from "../theme.ts";
import { colorizeStatus } from "../format.ts";

const GAP = 2;
const MIN_COL = 4;
const MIN_NAME = 12;

/**
 * A scrollable, selectable resource table. The owner sets columns + rows; the
 * table manages the cursor, vertical scrolling, and column layout.
 */
export class Table {
    private columns: string[] = [];
    private rows: string[][] = [];
    private statusCol = -1;
    private offset = 0;
    public selectedIndex = 0;

    setData(columns: string[], rows: string[][], statusCol: number): void {
        this.columns = columns;
        this.rows = rows;
        this.statusCol = statusCol;
        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, rows.length - 1));
    }

    get count(): number {
        return this.rows.length;
    }

    selected(): number {
        return this.selectedIndex;
    }

    handleInput(data: string, bodyHeight: number): boolean {
        const page = Math.max(1, bodyHeight - 2);
        if (matchesKey(data, "up") || matchesKey(data, "k")) {
            this.selectedIndex -= 1;
        } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
            this.selectedIndex += 1;
        } else if (matchesKey(data, "pageUp")) {
            this.selectedIndex -= page;
        } else if (matchesKey(data, "pageDown")) {
            this.selectedIndex += page;
        } else if (matchesKey(data, "g") || matchesKey(data, "home")) {
            this.selectedIndex = 0;
        } else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) {
            this.selectedIndex = this.rows.length - 1;
        } else if (data.startsWith("\x1b[<")) {
            this.handleMouse(data);
        } else {
            return false;
        }
        this.clamp(bodyHeight);
        return true;
    }

    private handleMouse(data: string): void {
        const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
        if (!match) {
            return;
        }
        const button = Number(match[1]);
        if (button === 64) {
            this.selectedIndex -= 3;
        } else if (button === 65) {
            this.selectedIndex += 3;
        }
    }

    private clamp(bodyHeight: number): void {
        const rowsVisible = Math.max(1, bodyHeight - 1); // minus header row
        if (this.rows.length === 0) {
            this.selectedIndex = 0;
            this.offset = 0;
            return;
        }
        this.selectedIndex = Math.min(Math.max(0, this.selectedIndex), this.rows.length - 1);
        if (this.selectedIndex < this.offset) {
            this.offset = this.selectedIndex;
        } else if (this.selectedIndex >= this.offset + rowsVisible) {
            this.offset = this.selectedIndex - rowsVisible + 1;
        }
    }

    /** Render the table into `bodyHeight` lines (header + rows). */
    render(width: number, bodyHeight: number): string[] {
        this.clamp(bodyHeight);
        if (this.rows.length === 0) {
            return [ui.columnHeader(fit(this.columns.join("  "), width)), ui.dim("  (no resources)")];
        }

        const widths = this.layout(width);
        const header = ui.columnHeader(this.formatRow(this.columns, widths, -1));

        const rowsVisible = Math.max(1, bodyHeight - 1);
        const slice = this.rows.slice(this.offset, this.offset + rowsVisible);
        const lines = [header];
        slice.forEach((row, i) => {
            const absolute = this.offset + i;
            const isSelected = absolute === this.selectedIndex;
            lines.push(this.renderRow(row, widths, isSelected, width));
        });
        return lines;
    }

    private renderRow(row: string[], widths: number[], selected: boolean, width: number): string {
        if (selected) {
            // Selected row uses a solid background; render plain text so the
            // highlight stays readable, then pad to full width.
            const text = this.formatRow(row, widths, -1);
            return ui.selectedRow(padTo(text, width));
        }
        return this.formatRow(row, widths, this.statusCol);
    }

    private formatRow(cells: string[], widths: number[], statusCol: number): string {
        const parts = widths.map((w, i) => {
            const raw = cells[i] ?? "";
            const clipped = clip(raw, w);
            const padded = clipped + " ".repeat(Math.max(0, w - visibleWidth(clipped)));
            return i === statusCol ? colorizeStatus(padded) : padded;
        });
        return parts.join(" ".repeat(GAP));
    }

    /** Compute per-column widths that fit within the viewport. */
    private layout(width: number): number[] {
        const natural = this.columns.map((col, i) => {
            let w = visibleWidth(col);
            for (const row of this.rows) {
                w = Math.max(w, visibleWidth(row[i] ?? ""));
            }
            return w;
        });

        const totalGap = GAP * Math.max(0, natural.length - 1);
        let total = natural.reduce((a, b) => a + b, 0) + totalGap;
        if (total <= width) {
            return natural;
        }

        // Shrink the NAME column first (column 0), then trim the rest down to a
        // minimum so everything fits.
        let overflow = total - width;
        const shrinkName = Math.min(overflow, Math.max(0, natural[0] - MIN_NAME));
        natural[0] -= shrinkName;
        overflow -= shrinkName;

        for (let i = natural.length - 1; i > 0 && overflow > 0; i--) {
            const shrink = Math.min(overflow, Math.max(0, natural[i] - MIN_COL));
            natural[i] -= shrink;
            overflow -= shrink;
        }
        total = natural.reduce((a, b) => a + b, 0) + totalGap;
        if (total > width && natural[0] > MIN_COL) {
            natural[0] = Math.max(MIN_COL, natural[0] - (total - width));
        }
        return natural;
    }
}

function clip(text: string, width: number): string {
    if (visibleWidth(text) <= width) {
        return text;
    }
    return text.slice(0, Math.max(0, width - 1)) + "…";
}

function fit(text: string, width: number): string {
    return clip(text, width);
}

function padTo(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

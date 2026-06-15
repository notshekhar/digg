import { SelectList, fuzzyFilter, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { getSelectListTheme, ui } from "../theme.ts";

export interface Choice {
    value: string;
    label: string;
}

/**
 * A full-screen fuzzy picker used for switching kind / namespace / context.
 * Wraps pi-tui's SelectList (nav/enter/escape) and adds type-to-filter.
 */
export class Selector {
    private title: string;
    private choices: Choice[];
    private filter = "";
    private list: SelectList;

    public onPick?: (value: string) => void;
    public onCancel?: () => void;

    constructor(title: string, choices: Choice[]) {
        this.title = title;
        this.choices = choices;
        this.list = this.build(choices);
    }

    private maxVisible(): number {
        return Math.max(3, (process.stdout.rows || 24) - 5);
    }

    private build(choices: Choice[]): SelectList {
        const list = new SelectList(
            choices.map((c) => ({ value: c.value, label: c.label })),
            this.maxVisible(),
            getSelectListTheme(),
        );
        list.onSelect = (item) => this.onPick?.(item.value);
        list.onCancel = () => this.onCancel?.();
        this.list = list;
        return list;
    }

    private apply(): void {
        const matches = this.filter ? fuzzyFilter(this.choices, this.filter, (c) => c.label) : this.choices;
        this.build(matches);
    }

    handleInput(data: string): void {
        if (
            matchesKey(data, "up") ||
            matchesKey(data, "down") ||
            matchesKey(data, "enter") ||
            matchesKey(data, "escape") ||
            data.startsWith("\x1b[<")
        ) {
            this.list.handleInput?.(data);
            return;
        }
        if (matchesKey(data, "backspace")) {
            this.filter = this.filter.slice(0, -1);
            this.apply();
            return;
        }
        if (data.length === 1 && data >= " " && data !== "\x7f") {
            this.filter += data;
            this.apply();
        }
    }

    render(width: number): string[] {
        const header = padLine(ui.headerBar(` ${this.title} `), width);
        const query = this.filter ? ui.accent(this.filter) : ui.dim("(type to filter)");
        const filterLine = padLine(`  ${ui.dim("filter:")} ${query}`, width);
        const lines = [header, filterLine, ""];
        lines.push(...this.list.render(width));
        lines.push("");
        lines.push(padLine(`  ${ui.footer("↑/↓ move · enter select · esc cancel")}`, width));
        return lines;
    }
}

function padLine(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

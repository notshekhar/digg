import { type Component, TUI, ProcessTerminal, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
    type K8sObject,
    type ResourceRef,
    deleteResource,
    describe,
    getContexts,
    getCurrentContext,
    getNamespaces,
    getYaml,
    isKubectlAvailable,
    listResources,
} from "./kubectl.ts";
import { type KindDef, KINDS, findKind } from "./format.ts";
import { ui } from "./theme.ts";
import { Table } from "./views/table.ts";
import { ScrollView } from "./views/scroll-view.ts";
import { LogView } from "./views/log-view.ts";
import { Selector } from "./views/selector.ts";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
const REFRESH_MS = 5000;

type Mode = "list" | "detail" | "logs" | "select" | "confirm";

export class KubeApp implements Component {
    private tui = new TUI(new ProcessTerminal());
    private quitting = false;

    private context = "";
    private contexts: string[] = [];
    private namespaces: string[] = [];
    private namespace: string | null = null; // null → all namespaces
    private kind: KindDef = KINDS[0];

    private objects: K8sObject[] = [];
    private visible: K8sObject[] = [];
    private filter = "";
    private filtering = false;

    private table = new Table();
    private mode: Mode = "list";
    private detail?: ScrollView;
    private logView?: LogView;
    private logProc?: ReturnType<typeof Bun.spawn>;
    private selector?: Selector;
    private confirm?: { message: string; action: () => Promise<string> };

    private status = "connecting…";
    private timer?: ReturnType<typeof setInterval>;

    // ── lifecycle ──────────────────────────────────────────────────────────
    async start(): Promise<void> {
        if (!(await isKubectlAvailable())) {
            process.stderr.write("kube: kubectl not found on PATH. Install kubectl and try again.\n");
            process.exit(1);
        }

        this.tui.addInputListener((data) => {
            if (matchesKey(data, "ctrl+c") || data === "\x03") {
                this.quit();
                return { consume: true };
            }
            return undefined;
        });
        process.on("SIGINT", () => this.quit());
        // Always restore mouse reporting, even if pi-tui throws mid-render —
        // otherwise the terminal keeps emitting raw mouse escape sequences.
        process.on("exit", () => process.stdout.write(DISABLE_MOUSE));

        process.stdout.write(ENABLE_MOUSE);
        this.tui.addChild(this);
        this.tui.setFocus(this);
        this.tui.start();
        this.tui.requestRender();

        await this.init();
        this.timer = setInterval(() => {
            if (this.mode === "list") {
                void this.refresh(true);
            }
        }, REFRESH_MS);
    }

    private quit(): void {
        if (this.quitting) {
            return;
        }
        this.quitting = true;
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.stopLogs();
        process.stdout.write(DISABLE_MOUSE);
        this.tui.stop();
        process.exit(0);
    }

    private async init(): Promise<void> {
        try {
            this.context = await getCurrentContext().catch(() => "");
            this.contexts = await getContexts();
            // Land on a context menu (Fleet-style), defaulting to the current one.
            this.openContextSelector(true);
            this.tui.requestRender();
        } catch (err) {
            this.status = errorText(err);
            this.tui.requestRender();
        }
    }

    private async enterCluster(context: string): Promise<void> {
        this.context = context;
        this.namespace = null;
        this.closeSelector();
        await this.loadNamespaces();
        await this.refresh(false);
    }

    private async loadNamespaces(): Promise<void> {
        try {
            this.namespaces = await getNamespaces(this.context);
        } catch {
            this.namespaces = [];
        }
    }

    private async refresh(silent: boolean): Promise<void> {
        if (!silent) {
            this.status = `loading ${this.kind.title.toLowerCase()}…`;
            this.tui.requestRender();
        }
        try {
            this.objects = await listResources(this.kind.name, {
                context: this.context,
                namespace: this.kind.clusterScoped ? undefined : this.namespace ?? undefined,
                clusterScoped: this.kind.clusterScoped,
            });
            this.status = "";
            this.rebuild();
        } catch (err) {
            this.status = errorText(err);
        }
        this.tui.requestRender();
    }

    private rebuild(): void {
        const allNs = this.namespace === null && !this.kind.clusterScoped;
        this.visible = this.objects.filter((o) => {
            if (!this.filter) {
                return true;
            }
            return (o.metadata?.name ?? "").toLowerCase().includes(this.filter.toLowerCase());
        });

        const columns = allNs ? ["NAMESPACE", ...this.kind.columns] : [...this.kind.columns];
        const rows = this.visible.map((o) => {
            const cells = this.kind.row(o);
            return allNs ? [o.metadata?.namespace ?? "", ...cells] : cells;
        });
        const statusCol = columns.indexOf("STATUS");
        this.table.setData(columns, rows, statusCol);
    }

    // ── input ────────────────────────────────────────────────────────────────
    invalidate(): void {}

    handleInput(data: string): void {
        switch (this.mode) {
            case "select":
                this.selector?.handleInput(data);
                break;
            case "detail":
                this.detail?.handleInput(data);
                break;
            case "logs":
                this.logView?.handleInput(data);
                break;
            case "confirm":
                this.handleConfirmInput(data);
                break;
            case "list":
                this.handleListInput(data);
                break;
        }
        this.tui.requestRender();
    }

    private handleListInput(data: string): void {
        if (this.filtering) {
            this.handleFilterInput(data);
            return;
        }
        const bodyHeight = this.bodyHeight();
        if (this.table.handleInput(data, bodyHeight)) {
            return;
        }
        if (data === "/") {
            this.filtering = true;
        } else if (matchesKey(data, "escape")) {
            if (this.filter) {
                this.filter = "";
                this.rebuild();
            }
        } else if (matchesKey(data, "enter") || matchesKey(data, "y")) {
            void this.showText("yaml");
        } else if (matchesKey(data, "d")) {
            void this.showText("describe");
        } else if (matchesKey(data, "l")) {
            this.streamLogs();
        } else if (matchesKey(data, "x")) {
            this.promptDelete();
        } else if (data === ":") {
            this.openKindSelector();
        } else if (matchesKey(data, "n")) {
            this.openNamespaceSelector();
        } else if (matchesKey(data, "c")) {
            this.openContextSelector();
        } else if (matchesKey(data, "shift+r")) {
            void this.refresh(false);
        }
    }

    private handleFilterInput(data: string): void {
        if (matchesKey(data, "escape")) {
            this.filtering = false;
            this.filter = "";
            this.rebuild();
        } else if (matchesKey(data, "enter")) {
            this.filtering = false;
        } else if (matchesKey(data, "backspace")) {
            this.filter = this.filter.slice(0, -1);
            this.rebuild();
        } else if (data.length === 1 && data >= " " && data !== "\x7f") {
            this.filter += data;
            this.rebuild();
        }
    }

    private handleConfirmInput(data: string): void {
        if (matchesKey(data, "y")) {
            const action = this.confirm?.action;
            this.confirm = undefined;
            this.mode = "list";
            if (action) {
                void this.runAction(action);
            }
        } else {
            this.confirm = undefined;
            this.mode = "list";
        }
    }

    private async runAction(action: () => Promise<string>): Promise<void> {
        try {
            this.status = (await action()).trim() || "done";
        } catch (err) {
            this.status = errorText(err);
        }
        await this.refresh(false);
    }

    // ── actions ──────────────────────────────────────────────────────────────
    private selectedRef(): ResourceRef | undefined {
        const obj = this.visible[this.table.selected()];
        if (!obj?.metadata?.name) {
            return undefined;
        }
        return {
            kind: this.kind.name,
            name: obj.metadata.name,
            namespace: this.kind.clusterScoped ? undefined : obj.metadata.namespace ?? this.namespace ?? undefined,
            context: this.context,
        };
    }

    private async showText(what: "yaml" | "describe"): Promise<void> {
        const ref = this.selectedRef();
        if (!ref) {
            return;
        }
        this.status = `loading ${what}…`;
        this.tui.requestRender();
        try {
            const text = what === "yaml" ? await getYaml(ref) : await describe(ref);
            this.detail = new ScrollView(`${ref.name} · ${what}`, text || "(empty)");
            this.detail.onBack = () => {
                this.mode = "list";
                this.detail = undefined;
                this.tui.requestRender();
            };
            this.mode = "detail";
            this.status = "";
        } catch (err) {
            this.status = errorText(err);
        }
        this.tui.requestRender();
    }

    /** Stream `kubectl logs -f` into a live, auto-following pane. */
    private streamLogs(): void {
        const ref = this.selectedRef();
        if (!ref || this.kind.name !== "pods") {
            this.status = "logs are only available for pods";
            return;
        }

        const view = new LogView(`${ref.name} · logs (live)`);
        view.onBack = () => {
            this.stopLogs();
            this.logView = undefined;
            this.mode = "list";
            this.tui.requestRender();
        };
        this.logView = view;
        this.mode = "logs";

        const args = ["--context", ref.context, "logs", ref.name, "-f", "--tail=500", "--all-containers=true"];
        if (ref.namespace) {
            args.push("-n", ref.namespace);
        }
        const proc = Bun.spawn(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" });
        this.logProc = proc;
        void this.pumpStream(proc, view);
        this.tui.requestRender();
    }

    private async pumpStream(proc: ReturnType<typeof Bun.spawn>, view: LogView): Promise<void> {
        const decoder = new TextDecoder();
        const consume = async (stream: ReadableStream<Uint8Array> | undefined) => {
            if (!stream) {
                return;
            }
            for await (const chunk of stream) {
                // Ignore output from a stream we've since navigated away from.
                if (this.logView !== view) {
                    return;
                }
                view.append(decoder.decode(chunk, { stream: true }));
                this.tui.requestRender();
            }
        };
        try {
            await Promise.all([consume(proc.stdout as ReadableStream<Uint8Array>), consume(proc.stderr as ReadableStream<Uint8Array>)]);
        } catch {
            // stream torn down on stop — nothing to do
        }
    }

    private stopLogs(): void {
        if (this.logProc) {
            try {
                this.logProc.kill();
            } catch {
                // already exited
            }
            this.logProc = undefined;
        }
    }

    private promptDelete(): void {
        const ref = this.selectedRef();
        if (!ref) {
            return;
        }
        this.confirm = {
            message: `Delete ${this.kind.name.replace(/s$/, "")} ${ref.name}? (y/N)`,
            action: () => deleteResource(ref),
        };
        this.mode = "confirm";
    }

    private openKindSelector(): void {
        const selector = new Selector(
            "Switch resource",
            KINDS.map((k) => ({ value: k.name, label: k.title })),
        );
        selector.onPick = (value) => {
            const kind = findKind(value);
            if (kind) {
                this.kind = kind;
                this.filter = "";
            }
            this.closeSelector();
            void this.refresh(false);
        };
        selector.onCancel = () => this.closeSelector();
        this.selector = selector;
        this.mode = "select";
    }

    private openNamespaceSelector(): void {
        const choices = [{ value: "*", label: "<all namespaces>" }, ...this.namespaces.map((n) => ({ value: n, label: n }))];
        const selector = new Selector("Switch namespace", choices);
        selector.onPick = (value) => {
            this.namespace = value === "*" ? null : value;
            this.closeSelector();
            void this.refresh(false);
        };
        selector.onCancel = () => this.closeSelector();
        this.selector = selector;
        this.mode = "select";
    }

    private openContextSelector(landing = false): void {
        const title = landing ? "Select a cluster" : "Switch context";
        const selector = new Selector(
            title,
            this.contexts.map((c) => ({ value: c, label: c })),
        );
        selector.onPick = (value) => {
            void this.enterCluster(value);
        };
        // On the landing menu there's nothing behind us, so esc quits.
        selector.onCancel = landing ? () => this.quit() : () => this.closeSelector();
        this.selector = selector;
        this.mode = "select";
    }

    private closeSelector(): void {
        this.selector = undefined;
        this.mode = "list";
        this.tui.requestRender();
    }

    // ── rendering ──────────────────────────────────────────────────────────
    private bodyHeight(): number {
        return Math.max(1, (process.stdout.rows || 24) - 3);
    }

    render(width: number): string[] {
        let lines: string[];
        if (this.mode === "select" && this.selector) {
            lines = fill(this.selector.render(width), width);
        } else if (this.mode === "detail" && this.detail) {
            lines = fill(this.detail.render(width), width);
        } else if (this.mode === "logs" && this.logView) {
            lines = fill(this.logView.render(width), width);
        } else {
            const header = pad(this.headerLine(), width);
            const rule = ui.rule("─".repeat(width));
            const body = this.table.render(width, this.bodyHeight());
            const footer = pad(this.footerLine(), width);
            lines = [header, rule, ...body];
            const total = process.stdout.rows || 24;
            while (lines.length < total - 1) {
                lines.push("");
            }
            lines.push(footer);
        }
        // pi-tui hard-crashes on any line wider than the terminal; truncate as a
        // final safety net so a long footer/row can never take the UI down.
        return lines.map((line) => truncateToWidth(line, width));
    }

    private headerLine(): string {
        const ns = this.kind.clusterScoped ? "—" : this.namespace ?? "all";
        const segments = [
            `${ui.headerKey("context:")} ${ui.headerVal(this.context || "?")}`,
            `${ui.headerKey("ns:")} ${ui.headerVal(ns)}`,
            `${ui.headerKey("kind:")} ${ui.headerVal(this.kind.title)}`,
            `${ui.headerKey("count:")} ${ui.headerVal(String(this.visible.length))}`,
        ];
        return ui.headerBar(` kube `) + "  " + segments.join(ui.dim("  ·  "));
    }

    private footerLine(): string {
        if (this.mode === "confirm" && this.confirm) {
            return ui.danger(`  ${this.confirm.message}`);
        }
        if (this.filtering || this.filter) {
            return `  ${ui.dim("/")} ${ui.accent(this.filter)}${this.filtering ? ui.accent("▏") : ""}`;
        }
        if (this.status) {
            return `  ${ui.dim(this.status)}`;
        }
        return `  ${ui.accent("[:] resources")}  ${ui.footer("n ns · c ctx · / filter · enter yaml · d describe · l logs · x del · R refresh · ctrl+c quit")}`;
    }
}

function pad(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function fill(lines: string[], _width: number): string[] {
    const total = process.stdout.rows || 24;
    const out = [...lines];
    while (out.length < total) {
        out.push("");
    }
    return out;
}

function errorText(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.split("\n")[0].slice(0, 200);
}

export function run(): void {
    void new KubeApp().start();
}

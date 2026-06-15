import { type Component, TUI, ProcessTerminal, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
    type K8sObject,
    type PodMetrics,
    type ResourceRef,
    deleteResource,
    describe,
    getYaml,
    isKubectlAvailable,
    listResources,
    topPods,
} from "./kubectl.ts";
import { WORKLOAD_KINDS, formatRevisions } from "./format.ts";
import { ClusterStore } from "./cluster.ts";
import { type LogSpec, LogController, logSpecFor } from "./log-stream.ts";
import { ScrollView } from "./views/scroll-view.ts";
import { type DetailHost, DetailView } from "./views/detail-view.ts";
import { Selector } from "./views/selector.ts";
import { contextSelector, kindSelector, namespaceSelector } from "./views/selectors.ts";
import { renderList } from "./views/list-view.ts";
import { fill, overlayConfirm } from "./views/layout.ts";
import { errorText } from "./util.ts";
import { getLastContext } from "./settings.ts";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
const REFRESH_MS = 5000;

type Mode = "list" | "detail" | "logs" | "drill" | "select" | "confirm";

/**
 * Root TUI component and orchestrator. Owns the terminal lifecycle, the active
 * mode + input routing, and the render dispatch. Cluster/data state lives in
 * ClusterStore; log streaming in LogController; presentation in the view files.
 */
export class DiggApp implements Component, DetailHost {
    private tui = new TUI(new ProcessTerminal());
    private quitting = false;
    // Mouse capture on by default: the wheel scrolls the app, not the terminal.
    // `m` releases it for native text selection/copy.
    private mouseEnabled = true;

    private store = new ClusterStore();
    private logs = new LogController({
        requestRender: () => this.tui.requestRender(),
        toggleMouse: () => this.toggleMouse(),
        onClose: () => {
            this.mode = this.afterLogs;
            this.tui.requestRender();
        },
    });

    private mode: Mode = "list";
    private afterLogs: Mode = "list";
    private detail?: ScrollView;
    private drillStack: DetailView[] = [];
    private selector?: Selector;
    private confirm?: { message: string; action: () => Promise<string> };

    private filtering = false;
    private status = "connecting…";
    private timer?: ReturnType<typeof setInterval>;

    // ── lifecycle ──────────────────────────────────────────────────────────
    async start(): Promise<void> {
        if (!(await isKubectlAvailable())) {
            process.stderr.write("digg: kubectl not found on PATH. Install kubectl and try again.\n");
            process.exit(1);
        }
        process.on("SIGINT", () => this.quit());
        // Restore mouse reporting even if pi-tui throws mid-render.
        process.on("exit", () => process.stdout.write(DISABLE_MOUSE));

        this.mountTui();
        this.startTimer();
        await this.init();
    }

    /** Attach to the terminal. Also used to re-attach after running $EDITOR. */
    private mountTui(): void {
        this.tui.addInputListener((data) => {
            if (matchesKey(data, "ctrl+c") || data === "\x03") {
                this.quit();
                return { consume: true };
            }
            return undefined;
        });
        if (this.mouseEnabled) {
            process.stdout.write(ENABLE_MOUSE);
        }
        this.tui.addChild(this);
        this.tui.setFocus(this);
        this.tui.start();
        this.tui.requestRender();
    }

    private startTimer(): void {
        this.timer = setInterval(() => {
            if (this.mode === "list") {
                void this.reload(true);
            } else if (this.mode === "drill" && this.drillStack.length > 0) {
                void this.drillStack[this.drillStack.length - 1].refresh();
            }
        }, REFRESH_MS);
    }

    private toggleMouse(): boolean {
        this.mouseEnabled = !this.mouseEnabled;
        process.stdout.write(this.mouseEnabled ? ENABLE_MOUSE : DISABLE_MOUSE);
        return this.mouseEnabled;
    }

    private quit(): void {
        if (this.quitting) {
            return;
        }
        this.quitting = true;
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.logs.stop();
        process.stdout.write(DISABLE_MOUSE);
        this.tui.stop();
        process.exit(0);
    }

    private async init(): Promise<void> {
        try {
            await this.store.loadContexts();
            this.openContextSelector(); // land on the cluster picker (home)
        } catch (err) {
            this.status = errorText(err);
        }
        this.tui.requestRender();
    }

    private async enterCluster(context: string): Promise<void> {
        await this.store.enter(context);
        this.selector = undefined;
        this.mode = "list";
        await this.reload(false);
    }

    /** Re-fetch the current resource list. `silent` skips the loading status. */
    private async reload(silent: boolean): Promise<void> {
        if (!silent) {
            this.status = `loading ${this.store.kind.title.toLowerCase()}…`;
            this.tui.requestRender();
        }
        try {
            await this.store.refresh();
            this.status = "";
        } catch (err) {
            this.status = errorText(err);
        }
        this.tui.requestRender();
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
                this.logs.handleInput(data);
                break;
            case "drill":
                this.drillStack[this.drillStack.length - 1]?.handleInput(data);
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
        if (this.store.table.handleInput(data, this.bodyHeight())) {
            return;
        }
        if (data === "/") {
            this.filtering = true;
        } else if (matchesKey(data, "escape")) {
            // esc clears an active filter, otherwise goes home (cluster picker).
            if (this.store.filter) {
                this.store.setFilter("");
            } else {
                this.openContextSelector();
            }
        } else if (matchesKey(data, "enter")) {
            this.openDetail();
        } else if (matchesKey(data, "y")) {
            const ref = this.store.selectedRef();
            if (ref) void this.showText(ref, "yaml");
        } else if (matchesKey(data, "d")) {
            const ref = this.store.selectedRef();
            if (ref) void this.showText(ref, "describe");
        } else if (matchesKey(data, "l")) {
            this.logsForSelected();
        } else if (matchesKey(data, "x")) {
            this.promptDelete();
        } else if (data === ":") {
            this.openKindSelector();
        } else if (matchesKey(data, "n")) {
            this.openNamespaceSelector();
        } else if (matchesKey(data, "c")) {
            this.openContextSelector();
        } else if (matchesKey(data, "shift+r")) {
            void this.reload(false);
        } else if (matchesKey(data, "m")) {
            this.toggleMouse();
        }
    }

    private handleFilterInput(data: string): void {
        if (matchesKey(data, "escape")) {
            this.filtering = false;
            this.store.setFilter("");
        } else if (matchesKey(data, "enter")) {
            this.filtering = false;
        } else if (matchesKey(data, "backspace")) {
            this.store.setFilter(this.store.filter.slice(0, -1));
        } else if (data.length === 1 && data >= " " && data !== "\x7f") {
            this.store.setFilter(this.store.filter + data);
        }
    }

    private handleConfirmInput(data: string): void {
        const action = this.confirm?.action;
        this.confirm = undefined;
        this.mode = "list";
        if (matchesKey(data, "y") && action) {
            void this.runAction(action);
        }
    }

    private async runAction(action: () => Promise<string>): Promise<void> {
        try {
            this.status = (await action()).trim() || "done";
        } catch (err) {
            this.status = errorText(err);
        }
        await this.reload(false);
    }

    // ── actions / presenters ─────────────────────────────────────────────────
    /** Open a scrollable text pane; `editRef` makes it editable via `e`. */
    private present(title: string, text: string, prev: Mode, editRef?: ResourceRef): void {
        const view = new ScrollView(title, text || "(empty)");
        view.onToggleMouse = () => this.toggleMouse();
        if (editRef) {
            // e launches `kubectl edit` ($EDITOR) and applies on save.
            view.onEdit = () => this.editResource(editRef);
        }
        view.onBack = () => {
            this.detail = undefined;
            this.mode = prev;
            this.tui.requestRender();
        };
        this.detail = view;
        this.mode = "detail";
        this.status = "";
        this.tui.requestRender();
    }

    private async showText(ref: ResourceRef, what: "yaml" | "describe"): Promise<void> {
        const prev = this.mode;
        this.status = `loading ${what}…`;
        this.tui.requestRender();
        try {
            const text = what === "yaml" ? await getYaml(ref) : await describe(ref);
            this.present(`${ref.name} · ${what}`, text, prev, what === "yaml" ? ref : undefined);
        } catch (err) {
            this.status = errorText(err);
            this.tui.requestRender();
        }
    }

    /**
     * Edit with `kubectl edit` — opens the live YAML in $EDITOR and applies on
     * save. The TUI is suspended for the editor, then a fresh one is mounted.
     */
    private editResource(ref: ResourceRef): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
        process.stdout.write(DISABLE_MOUSE);
        this.tui.stop();

        const args = ["--context", ref.context, "edit", ref.kind, ref.name];
        if (ref.namespace) {
            args.push("-n", ref.namespace);
        }
        try {
            Bun.spawnSync(["kubectl", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
        } catch {
            // restore the UI regardless
        }

        this.detail = undefined;
        this.mode = this.drillStack.length > 0 ? "drill" : "list";
        this.tui = new TUI(new ProcessTerminal());
        this.mountTui();
        this.startTimer();
        this.status = "applied edits (if saved)";
        void this.reload(false);
    }

    /** Logs for the selected list row: a pod directly, or all pods of a workload. */
    private logsForSelected(): void {
        const obj = this.store.selectedObject();
        if (!obj) {
            return;
        }
        const spec = logSpecFor(this.store.kind.name, obj, this.store.context);
        if (spec) {
            this.openLogs(spec);
        } else {
            this.status = "no logs for this resource";
        }
    }

    /** Open the Lens/Aptakube-style detail dashboard for the selected row. */
    private openDetail(): void {
        const obj = this.store.selectedObject();
        if (!obj?.metadata?.name) {
            return;
        }
        const isWorkload = WORKLOAD_KINDS.has(this.store.kind.name);
        if (!isWorkload && this.store.kind.name !== "pods") {
            const ref = this.store.selectedRef();
            if (ref) void this.showText(ref, "yaml");
            return;
        }
        this.pushDetail(new DetailView(this, obj, this.store.kind.name, this.store.context, isWorkload));
    }

    private pushDetail(view: DetailView): void {
        this.drillStack.push(view);
        this.mode = "drill";
        void view.refresh();
        this.tui.requestRender();
    }

    // ── DetailHost ───────────────────────────────────────────────────────────
    requestRender(): void {
        this.tui.requestRender();
    }

    back(): void {
        this.drillStack.pop();
        this.mode = this.drillStack.length > 0 ? "drill" : "list";
        this.tui.requestRender();
    }

    openYaml(ref: ResourceRef): void {
        void this.showText(ref, "yaml");
    }

    openDescribe(ref: ResourceRef): void {
        void this.showText(ref, "describe");
    }

    openLogs(spec: LogSpec): void {
        this.afterLogs = this.mode;
        this.mode = "logs";
        this.logs.open(spec);
    }

    openPod(pod: K8sObject): void {
        if (pod.metadata?.name) {
            this.pushDetail(new DetailView(this, pod, "pods", this.store.context, false));
        }
    }

    /** Show a deployment's rollout history (its ReplicaSets, newest first). */
    async openRevisions(obj: K8sObject, selector: string): Promise<void> {
        const prev = this.mode;
        const name = obj.metadata?.name ?? "";
        this.status = "loading revisions…";
        this.tui.requestRender();
        try {
            const all = await listResources("replicasets", {
                context: this.store.context,
                namespace: obj.metadata?.namespace,
                labelSelector: selector,
            });
            const owned = all.filter((rs) =>
                (rs.metadata as { ownerReferences?: { kind?: string; name?: string }[] })?.ownerReferences?.some(
                    (o) => o.kind === "Deployment" && o.name === name,
                ),
            );
            this.present(`${name} · revisions`, formatRevisions(owned) || "(no revisions found)", prev);
        } catch (err) {
            this.status = errorText(err);
            this.tui.requestRender();
        }
    }

    async fetchPods(
        namespace: string | undefined,
        selector: string,
    ): Promise<{ pods: K8sObject[]; top: Map<string, PodMetrics> }> {
        const [pods, top] = await Promise.all([
            listResources("pods", { context: this.store.context, namespace, labelSelector: selector }),
            topPods(this.store.context, namespace, selector),
        ]);
        return { pods, top };
    }

    // ── delete + selectors ─────────────────────────────────────────────────
    private promptDelete(): void {
        const ref = this.store.selectedRef();
        if (!ref) {
            return;
        }
        this.confirm = {
            message: `Delete ${this.store.kind.name.replace(/s$/, "")} "${ref.name}"?`,
            action: () => deleteResource(ref),
        };
        this.mode = "confirm";
    }

    private openKindSelector(): void {
        this.openSelector(
            kindSelector(
                (value) => {
                    this.store.setKind(value);
                    this.closeSelector();
                    void this.reload(false);
                },
                () => this.closeSelector(),
            ),
        );
    }

    private openNamespaceSelector(): void {
        this.openSelector(
            namespaceSelector(
                this.store.namespaces,
                (value) => {
                    this.store.setNamespace(value === "*" ? null : value);
                    this.closeSelector();
                    void this.reload(false);
                },
                () => this.closeSelector(),
            ),
        );
    }

    /** The cluster picker is "home": esc has nowhere to go, so it does nothing. */
    private openContextSelector(): void {
        this.openSelector(
            contextSelector(this.store.contexts, getLastContext(), (value) => void this.enterCluster(value)),
        );
    }

    private openSelector(selector: Selector): void {
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
            lines = fill(this.selector.render(width));
        } else if (this.mode === "detail" && this.detail) {
            lines = fill(this.detail.render(width));
        } else if (this.mode === "logs" && this.logs.active) {
            lines = fill(this.logs.render(width));
        } else if (this.mode === "drill" && this.drillStack.length > 0) {
            lines = fill(this.drillStack[this.drillStack.length - 1].render(width));
        } else if (this.mode === "confirm" && this.confirm) {
            lines = overlayConfirm(this.list(width), this.confirm.message, width);
        } else {
            lines = this.list(width);
        }
        // pi-tui hard-crashes on any line wider than the terminal — clamp.
        return lines.map((line) => truncateToWidth(line, width));
    }

    private list(width: number): string[] {
        const state = { filtering: this.filtering, status: this.status, mouseEnabled: this.mouseEnabled };
        return renderList(this.store, state, width, this.bodyHeight());
    }
}

export function run(): void {
    void new DiggApp().start();
}

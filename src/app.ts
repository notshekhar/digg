import { type Component, TUI, ProcessTerminal, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
    type K8sEvent,
    type K8sObject,
    type PodMetrics,
    type ResourceRef,
    applyManifest,
    deleteResource,
    describe,
    drainNode,
    execArgs,
    getEvents,
    getJson,
    getYaml,
    isKubectlAvailable,
    listResources,
    portForwardArgs,
    rolloutRestart,
    scaleResource,
    setNodeSchedulable,
    setSuspend,
    topPods,
    triggerCronJob,
} from "./kubectl.ts";
import { WORKLOAD_KINDS, revisionLabel, sortRevisions } from "./format.ts";
import { ClusterStore } from "./cluster.ts";
import { type LogSpec, LogController, logSpecFor } from "./log-stream.ts";
import { ScrollView } from "./views/scroll-view.ts";
import { type DetailHost, DetailView } from "./views/detail-view.ts";
import { Selector } from "./views/selector.ts";
import { contextSelector, kindSelector, namespaceSelector } from "./views/selectors.ts";
import { renderList } from "./views/list-view.ts";
import { VimEditor } from "./views/editor/vim-editor.ts";
import { PortForwardController } from "./port-forward.ts";
import { WatchController } from "./watch.ts";
import { fill, overlayConfirm, overlayPrompt } from "./views/layout.ts";
import { errorText } from "./util.ts";
import { fromEditableYaml, isSecretOrConfigMap, toEditableYaml } from "./secret-yaml.ts";
import { getEditorOptions, getLastContext, setEditorOptions } from "./settings.ts";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
// The list updates live via the watch stream; this timer drives the detail
// dashboard (which also needs polled `kubectl top` metrics) and a periodic full
// list resync as a safety net in case the watch drops an event.
const TICK_MS = 2000;
const LIST_RESYNC_TICKS = 4; // full list reload every ~8s

type Mode = "list" | "detail" | "logs" | "drill" | "select" | "confirm" | "edit" | "prompt";

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
    private editor?: VimEditor;
    private afterEdit: Mode = "list";
    private drillStack: DetailView[] = [];
    private selector?: Selector;
    private confirm?: { message: string; action: () => Promise<string> };
    private prompt?: { message: string; value: string; onSubmit: (value: string) => void };
    /** The mode a confirm/prompt overlay sits on top of (where esc returns). */
    private overlayReturn: Mode = "list";
    private afterShell: Mode = "drill";
    private forwards = new PortForwardController();
    private watch = new WatchController();
    private tick = 0;

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

        this.wireTui();
        this.resumeTui();
        this.startTimer();
        await this.init();
    }

    /** One-time wiring: listeners + child + focus persist across suspend/resume. */
    private wireTui(): void {
        this.tui.addInputListener((data) => {
            if (matchesKey(data, "ctrl+c") || data === "\x03") {
                this.quit();
                return { consume: true };
            }
            return undefined;
        });
        this.tui.addChild(this);
        this.tui.setFocus(this);
    }

    /**
     * Suspend the TUI to hand the raw terminal to a child process (interactive
     * `kubectl exec`/shell). Stops the refresh timer, releases mouse capture,
     * and restores cooked mode. Pair with resumeTui().
     */
    private suspendTui(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        process.stdout.write(DISABLE_MOUSE);
        this.tui.stop();
    }

    /** Re-attach the TUI after start or after a suspend, forcing a clean repaint. */
    private resumeTui(): void {
        if (this.mouseEnabled) {
            process.stdout.write(ENABLE_MOUSE);
        }
        this.tui.start();
        this.tui.requestRender(true);
    }

    private startTimer(): void {
        this.timer = setInterval(() => {
            this.tick++;
            if (this.mode === "drill" && this.drillStack.length > 0) {
                void this.drillStack[this.drillStack.length - 1].refresh();
            } else if (this.mode === "list" && this.tick % LIST_RESYNC_TICKS === 0) {
                // The watch keeps the list live; this is only a safety resync.
                void this.reload(true);
            }
        }, TICK_MS);
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
        this.forwards.stopAll();
        this.watch.stop();
        for (const view of this.drillStack) {
            view.stop();
        }
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
        this.restartWatch();
    }

    /**
     * (Re)start the live watch for the current list target. Called whenever the
     * target changes (cluster / kind / namespace). Watch events upsert into the
     * store and trigger an immediate re-render, so the list reflects pod churn
     * the moment the API server reports it.
     */
    private restartWatch(): void {
        this.watch.start(this.store.context, this.store.watchTarget(), {
            onEvent: (type, obj) => {
                if (this.store.applyWatchEvent(type, obj)) {
                    this.tui.requestRender();
                }
            },
        });
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
            case "edit":
                this.editor?.handleInput(data);
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
            case "prompt":
                this.handlePromptInput(data);
                break;
            case "list":
                this.handleListInput(data);
                break;
        }
        this.tui.requestRender();
    }

    private handlePromptInput(data: string): void {
        if (!this.prompt) {
            return;
        }
        if (matchesKey(data, "escape")) {
            this.prompt = undefined;
            this.mode = this.overlayReturn;
        } else if (matchesKey(data, "enter")) {
            const { value, onSubmit } = this.prompt;
            this.prompt = undefined;
            this.mode = this.overlayReturn;
            onSubmit(value.trim());
        } else if (matchesKey(data, "backspace")) {
            this.prompt.value = this.prompt.value.slice(0, -1);
        } else if (data.length === 1 && data >= " " && data !== "\x7f") {
            this.prompt.value += data;
        }
    }

    /** Open a single-line input overlay; onSubmit fires on enter with the value. */
    private openPrompt(message: string, initial: string, onSubmit: (value: string) => void): void {
        this.overlayReturn = this.mode;
        this.prompt = { message, value: initial, onSubmit };
        this.mode = "prompt";
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
        } else if (matchesKey(data, "shift+x")) {
            // Capital X (not plain x) so a resource can't be deleted by accident.
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
        } else {
            this.handleListAction(data);
        }
    }

    /** Resource-specific action keys on the selected list row (mirror the detail dashboard). */
    private handleListAction(data: string): void {
        const obj = this.store.selectedObject();
        const kindName = this.store.kind.name;
        if (!obj) {
            return;
        }
        if (matchesKey(data, "s") && kindName === "pods") {
            this.shellIntoPod(obj);
        } else if (matchesKey(data, "f") && (kindName === "pods" || kindName === "services")) {
            this.portForward(obj, kindName);
        } else if (matchesKey(data, "shift+s") && ["deployments", "statefulsets", "replicasets"].includes(kindName)) {
            this.scaleResource(obj, kindName);
        } else if (matchesKey(data, "shift+t") && ["deployments", "statefulsets", "daemonsets"].includes(kindName)) {
            this.restartResource(obj, kindName);
        } else if (matchesKey(data, "shift+c") && kindName === "nodes") {
            this.cordonNode(obj, false);
        } else if (matchesKey(data, "shift+u") && kindName === "nodes") {
            this.cordonNode(obj, true);
        } else if (matchesKey(data, "space") && kindName === "cronjobs") {
            const suspended = (obj.spec as { suspend?: boolean })?.suspend ?? false;
            this.suspendCronJob(obj, !suspended);
        } else if (matchesKey(data, "t") && kindName === "cronjobs") {
            this.triggerCronJob(obj);
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
        this.mode = this.overlayReturn;
        if (matchesKey(data, "y") && action) {
            void this.runAction(action);
        }
    }

    /** Open a yes/no confirmation; esc/n returns to the current screen. */
    private openConfirm(message: string, action: () => Promise<string>): void {
        this.overlayReturn = this.mode;
        this.confirm = { message, action };
        this.mode = "confirm";
    }

    private async runAction(action: () => Promise<string>): Promise<void> {
        try {
            this.status = (await action()).trim() || "done";
        } catch (err) {
            this.status = errorText(err);
        }
        // Refresh whatever we're looking at: a drill-in dashboard or the list.
        if (this.drillStack.length > 0) {
            await this.drillStack[this.drillStack.length - 1].refresh();
        } else {
            await this.reload(false);
        }
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

    /** Open the in-app modal editor on a resource and apply on save. */
    private editResource(ref: ResourceRef): void {
        void this.openEditor(ref);
    }

    /**
     * Fetch the resource, mount the VimEditor, and apply on save. Secrets and
     * ConfigMaps are decoded (base64 → text) so values edit as plain text; all
     * other kinds open their live YAML. The refresh timer is paused while
     * editing so a background reload can't clobber the buffer.
     */
    private async openEditor(ref: ResourceRef): Promise<void> {
        this.status = "loading…";
        this.tui.requestRender();
        try {
            const obj = await getJson(ref);
            const decoded = isSecretOrConfigMap(obj);
            const text = decoded ? toEditableYaml(obj) : await getYaml(ref);
            this.afterEdit = this.drillStack.length > 0 ? "drill" : "list";
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = undefined;
            }
            this.editor = new VimEditor({
                title: `${ref.name} · ${ref.kind}`,
                text,
                filetype: "yaml",
                options: getEditorOptions(),
                onOptionsChange: (opts) => setEditorOptions(opts),
                requestRender: () => this.tui.requestRender(),
                onSave: async (edited) => {
                    const manifest = decoded ? fromEditableYaml(edited, ref) : edited;
                    return await applyManifest(manifest, ref.context);
                },
                onQuit: () => this.closeEditor(),
            });
            this.detail = undefined;
            this.mode = "edit";
            this.status = "";
            this.tui.requestRender();
        } catch (err) {
            this.status = errorText(err);
            this.tui.requestRender();
        }
    }

    private closeEditor(): void {
        this.editor = undefined;
        this.mode = this.afterEdit;
        this.startTimer();
        this.status = "";
        // Refresh whatever we return to so the just-saved edit shows immediately:
        // the drill detail (re-fetches its own object) and the underlying list.
        if (this.drillStack.length > 0) {
            void this.drillStack[this.drillStack.length - 1].refresh();
        }
        void this.reload(false);
        this.tui.requestRender();
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
        const kind = this.store.kind;
        const isWorkload = WORKLOAD_KINDS.has(kind.name);
        this.pushDetail(new DetailView(this, obj, kind.name, kind.kind, this.store.context, isWorkload));
    }

    private pushDetail(view: DetailView): void {
        // Pause the view being covered so only the visible one holds a watch.
        this.drillStack[this.drillStack.length - 1]?.stop();
        this.drillStack.push(view);
        this.mode = "drill";
        view.start();
        this.tui.requestRender();
    }

    // ── DetailHost ───────────────────────────────────────────────────────────
    requestRender(): void {
        this.tui.requestRender();
    }

    back(): void {
        this.drillStack.pop()?.stop();
        const top = this.drillStack[this.drillStack.length - 1];
        if (top) {
            this.mode = "drill";
            top.start(); // resume its watch + refresh
        } else {
            this.mode = "list";
        }
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
            this.pushDetail(new DetailView(this, pod, "pods", "Pod", this.store.context, false));
        }
    }

    openResource(obj: K8sObject, kindName: string, singular: string): void {
        if (obj.metadata?.name) {
            const isWorkload = WORKLOAD_KINDS.has(kindName);
            this.pushDetail(new DetailView(this, obj, kindName, singular, this.store.context, isWorkload));
        }
    }

    openText(title: string, text: string): void {
        this.present(title, text, this.mode);
    }

    listObjects(
        kind: string,
        opts: { namespace?: string; labelSelector?: string; fieldSelector?: string },
    ): Promise<K8sObject[]> {
        return listResources(kind, {
            context: this.store.context,
            namespace: opts.namespace,
            labelSelector: opts.labelSelector,
            fieldSelector: opts.fieldSelector,
        });
    }

    async getObject(ref: ResourceRef): Promise<K8sObject | undefined> {
        return getJson(ref).catch(() => undefined);
    }

    getEvents(ref: ResourceRef, involvedKind: string): Promise<K8sEvent[]> {
        return getEvents(ref, involvedKind);
    }

    // ── write verbs (from the detail dashboard) ───────────────────────────────
    private refFor(obj: K8sObject, kindName: string): ResourceRef {
        return { kind: kindName, name: obj.metadata?.name ?? "", namespace: obj.metadata?.namespace, context: this.store.context };
    }

    scaleResource(obj: K8sObject, kindName: string): void {
        const ref = this.refFor(obj, kindName);
        const current = String((obj.spec as { replicas?: number })?.replicas ?? "");
        this.openPrompt(`Scale ${ref.name} to how many replicas?`, current, (value) => {
            const n = Number(value);
            if (!Number.isInteger(n) || n < 0) {
                this.status = "invalid replica count";
                this.tui.requestRender();
                return;
            }
            void this.runAction(() => scaleResource(ref, n));
        });
    }

    restartResource(obj: K8sObject, kindName: string): void {
        const ref = this.refFor(obj, kindName);
        this.openConfirm(`Restart rollout of ${kindName.replace(/s$/, "")} "${ref.name}"?`, () => rolloutRestart(ref));
    }

    cordonNode(obj: K8sObject, schedulable: boolean): void {
        const node = obj.metadata?.name ?? "";
        void this.runAction(() => setNodeSchedulable(this.store.context, node, schedulable));
    }

    drainNode(obj: K8sObject): void {
        const node = obj.metadata?.name ?? "";
        this.openConfirm(`Drain node "${node}"? Evicts its pods.`, () => drainNode(this.store.context, node));
    }

    suspendCronJob(obj: K8sObject, suspend: boolean): void {
        const ref = this.refFor(obj, "cronjobs");
        void this.runAction(() => setSuspend(ref, suspend));
    }

    triggerCronJob(obj: K8sObject): void {
        const ref = this.refFor(obj, "cronjobs");
        this.openConfirm(`Trigger CronJob "${ref.name}" now?`, () => triggerCronJob(ref));
    }

    // ── interactive subprocesses ──────────────────────────────────────────────
    shellIntoPod(pod: K8sObject): void {
        const ref = this.refFor(pod, "pods");
        const containers = (pod.spec as { containers?: { name?: string }[] })?.containers ?? [];
        if (containers.length > 1) {
            const picker = new Selector(
                `${ref.name} · container`,
                containers.map((c) => ({ value: c.name ?? "", label: c.name ?? "" })),
            );
            picker.onPick = (value) => {
                this.selector = undefined;
                this.mode = this.afterShell;
                void this.execShell(ref, value);
            };
            picker.onCancel = () => {
                this.selector = undefined;
                this.mode = this.afterShell;
                this.tui.requestRender();
            };
            this.afterShell = this.mode;
            this.openSelector(picker);
        } else {
            void this.execShell(ref, containers[0]?.name);
        }
    }

    /** Suspend the TUI, hand the terminal to an interactive shell, then resume. */
    private async execShell(ref: ResourceRef, container: string | undefined): Promise<void> {
        this.suspendTui();
        let exited = false;
        for (const shell of ["/bin/bash", "/bin/sh"]) {
            try {
                const proc = Bun.spawn(["kubectl", ...execArgs(ref, container, shell)], {
                    stdin: "inherit",
                    stdout: "inherit",
                    stderr: "inherit",
                });
                const code = await proc.exited;
                // 126/127 ≈ shell missing; try the next candidate.
                if (code !== 126 && code !== 127) {
                    exited = true;
                    break;
                }
            } catch {
                // try next shell
            }
        }
        this.resumeTui();
        this.startTimer();
        this.status = exited ? "" : "no shell (/bin/bash, /bin/sh) in container";
        if (this.drillStack.length > 0) {
            void this.drillStack[this.drillStack.length - 1].refresh();
        }
        this.tui.requestRender();
    }

    portForward(obj: K8sObject, kindName: string): void {
        const ref = this.refFor(obj, kindName);
        this.openPrompt(`Port-forward ${kindName.replace(/s$/, "")} "${ref.name}" (local:remote)`, "", (value) => {
            if (!/^\d+:\d+$/.test(value)) {
                this.status = "expected local:remote, e.g. 8080:80";
                this.tui.requestRender();
                return;
            }
            this.status = this.forwards.start(portForwardArgs(ref, value), `${ref.name} ${value}`);
            this.tui.requestRender();
        });
    }

    /**
     * Show a deployment's rollout history as a selectable list of its
     * ReplicaSets (newest first). Enter drills into the chosen revision.
     */
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
            const owned = sortRevisions(
                all.filter((rs) =>
                    (rs.metadata as { ownerReferences?: { kind?: string; name?: string }[] })?.ownerReferences?.some(
                        (o) => o.kind === "Deployment" && o.name === name,
                    ),
                ),
            );
            const byName = new Map(owned.map((rs) => [rs.metadata?.name ?? "", rs]));
            const picker = new Selector(
                `${name} · revisions`,
                owned.map((rs) => ({ value: rs.metadata?.name ?? "", label: revisionLabel(rs) })),
            );
            picker.onPick = (value) => {
                const rs = byName.get(value);
                this.selector = undefined;
                if (rs) {
                    this.pushDetail(new DetailView(this, rs, "replicasets", "ReplicaSet", this.store.context, true));
                } else {
                    this.mode = prev;
                }
            };
            picker.onCancel = () => {
                this.selector = undefined;
                this.mode = prev;
                this.tui.requestRender();
            };
            this.openSelector(picker);
            this.status = "";
        } catch (err) {
            this.status = errorText(err);
        }
        this.tui.requestRender();
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
        this.openConfirm(`Delete ${this.store.kind.title.replace(/s$/, "")} "${ref.name}"?`, () => deleteResource(ref));
    }

    private openKindSelector(): void {
        this.openSelector(
            kindSelector(
                this.store.allKinds(),
                (value) => {
                    this.store.setKind(value);
                    this.closeSelector();
                    void this.reloadAndWatch();
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
                    void this.reloadAndWatch();
                },
                () => this.closeSelector(),
            ),
        );
    }

    /** Full reload + (re)point the live watch at the new target. */
    private async reloadAndWatch(): Promise<void> {
        await this.reload(false);
        this.restartWatch();
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
        } else if (this.mode === "edit" && this.editor) {
            lines = fill(this.editor.render(width));
        } else if (this.mode === "logs" && this.logs.active) {
            lines = fill(this.logs.render(width));
        } else if (this.mode === "drill" && this.drillStack.length > 0) {
            lines = fill(this.drillStack[this.drillStack.length - 1].render(width));
        } else if (this.mode === "confirm" && this.confirm) {
            lines = overlayConfirm(this.overlayBackground(width), this.confirm.message, width);
        } else if (this.mode === "prompt" && this.prompt) {
            lines = overlayPrompt(this.overlayBackground(width), this.prompt.message, this.prompt.value, width);
        } else {
            lines = this.list(width);
        }
        // pi-tui writes back every line verbatim: it clamps width but not the
        // line count, so a view taller than the terminal scrolls the screen into
        // "full screen". Clamp both — width (pi-tui hard-crashes on overflow) and
        // height (cap to the terminal's rows so output never exceeds the viewport).
        const rows = process.stdout.rows || 24;
        return lines.slice(0, rows).map((line) => truncateToWidth(line, width));
    }

    /** The screen a confirm/prompt overlay sits on: the drill view or the list. */
    private overlayBackground(width: number): string[] {
        if (this.overlayReturn === "drill" && this.drillStack.length > 0) {
            return fill(this.drillStack[this.drillStack.length - 1].render(width));
        }
        return this.list(width);
    }

    private list(width: number): string[] {
        const state = {
            filtering: this.filtering,
            status: this.status,
            mouseEnabled: this.mouseEnabled,
            forwards: this.forwards.status(),
        };
        return renderList(this.store, state, width, this.bodyHeight());
    }
}

export function run(): void {
    void new DiggApp().start();
}

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { K8sEvent, K8sObject, PodMetrics, ResourceRef } from "../kubectl.ts";
import { age, findKind, podContainers } from "../format.ts";
import {
    type DetailModel,
    type Section,
    detailModel,
    ingressRuleRows,
    jobOwnedByCronJob,
    jobStatus,
    podMountsPVC,
} from "../details.ts";
import { decodeSecretValue } from "../secret-yaml.ts";
import type { LogSpec } from "../log-stream.ts";
import { type WatchTarget, WatchController } from "../watch.ts";
import { ui } from "../theme.ts";
import { Table } from "./table.ts";

export interface DetailHost {
    requestRender(): void;
    back(): void;
    openYaml(ref: ResourceRef): void;
    openDescribe(ref: ResourceRef): void;
    openLogs(spec: LogSpec): void;
    openPod(pod: K8sObject): void;
    /** Drill into an arbitrary object (e.g. a Job from a CronJob). */
    openResource(obj: K8sObject, kindName: string, singular: string): void;
    /** Show plain text in a scroll pane (e.g. a ConfigMap/Secret value). */
    openText(title: string, text: string): void;
    openRevisions(obj: K8sObject, selector: string): void;
    fetchPods(namespace: string | undefined, selector: string): Promise<{ pods: K8sObject[]; top: Map<string, PodMetrics> }>;
    listObjects(kind: string, opts: { namespace?: string; labelSelector?: string; fieldSelector?: string }): Promise<K8sObject[]>;
    getObject(ref: ResourceRef): Promise<K8sObject | undefined>;
    getEvents(ref: ResourceRef, involvedKind: string): Promise<K8sEvent[]>;
    // write verbs (Phase 4/5) — invoked from the detail dashboard:
    scaleResource(obj: K8sObject, kindName: string, singular: string): void;
    restartResource(obj: K8sObject, kindName: string, singular: string): void;
    cordonNode(obj: K8sObject, schedulable: boolean): void;
    drainNode(obj: K8sObject): void;
    suspendCronJob(obj: K8sObject, suspend: boolean): void;
    triggerCronJob(obj: K8sObject): void;
    shellIntoPod(pod: K8sObject): void;
    portForward(obj: K8sObject, kindName: string): void;
}

const podsKind = findKind("pods");

/**
 * The generic detail dashboard. Driven by a per-kind `DetailModel`
 * (see details.ts): renders a summary, one navigable section (pods, containers,
 * data keys, rules…), and a live Events panel — so every kind gets a real page,
 * not a YAML dump. Actions (yaml/describe/logs/scale/exec…) hang off the footer.
 */
export class DetailView {
    private host: DetailHost;
    private obj: K8sObject;
    private kindName: string;
    private singular: string;
    private context: string;
    private isWorkload: boolean;

    private model: DetailModel;
    private table = new Table();
    private top = new Map<string, PodMetrics>();
    private sectionObjects: K8sObject[] = [];
    private events: K8sEvent[] = [];
    private loading = true;
    /** What enter does on the selected section row, if anything. */
    private onEnterRow?: (index: number) => void;

    // Live updates: a scoped watch on this page's pods (or the pod itself) that
    // triggers a debounced refresh, so status flips the instant the API server
    // reports it — same feel as the main list, including inside a workload.
    private watch = new WatchController();
    private watchStarted = false;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;

    constructor(host: DetailHost, obj: K8sObject, kindName: string, singular: string, context: string, isWorkload: boolean) {
        this.host = host;
        this.obj = obj;
        this.kindName = kindName;
        this.singular = singular;
        this.context = context;
        this.isWorkload = isWorkload;
        this.model = detailModel(kindName, obj, isWorkload, this.top);
    }

    private get ns(): string | undefined {
        return this.obj.metadata?.namespace;
    }

    private get ref(): ResourceRef {
        return { kind: this.kindName, name: this.obj.metadata?.name ?? "", namespace: this.ns, context: this.context };
    }

    /** Called when this view becomes the visible top of the drill stack. */
    start(): void {
        this.disposed = false;
        this.ensureWatch();
        void this.refresh();
    }

    /** Called when this view is covered by another or popped off the stack. */
    stop(): void {
        this.disposed = true;
        this.watch.stop();
        this.watchStarted = false;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    async refresh(): Promise<void> {
        try {
            // Re-fetch self FIRST so sections built from this.obj (a secret's
            // data keys, an ingress's rules) and the summary reflect live edits;
            // then load the section's related objects and events.
            await this.reloadSelf();
            await Promise.all([this.loadSection(), this.loadEvents()]);
        } catch {
            // keep previous data on transient errors
        }
        this.model = detailModel(this.kindName, this.obj, this.isWorkload, this.top);
        this.loading = false;
        this.ensureWatch();
        this.host.requestRender();
    }

    /**
     * Re-fetch this object so the page always reflects the live cluster — its
     * own status (a pod's containers, a workload's replicas) and its data (a
     * secret/configmap's keys after an edit). One GET per refresh is cheap.
     */
    private async reloadSelf(): Promise<void> {
        if (!this.obj.metadata?.name) {
            return;
        }
        const fresh = await this.host.getObject(this.ref).catch(() => undefined);
        if (fresh) {
            this.obj = fresh;
        }
    }

    /** Start the pod/self watch once; events coalesce into a debounced refresh. */
    private ensureWatch(): void {
        if (this.watchStarted || this.disposed) {
            return;
        }
        const target = this.watchTarget();
        if (!target) {
            return;
        }
        this.watchStarted = true;
        this.watch.start(this.context, target, { onEvent: () => this.scheduleRefresh() });
    }

    /** The watch scope for this page: its pods, or the pod itself. */
    private watchTarget(): WatchTarget | undefined {
        const section = this.model.section;
        if (section?.type === "workloadPods" || section?.type === "endpointPods") {
            return { kind: "pods", namespace: this.ns, labelSelector: section.selector };
        }
        if (section?.type === "nodePods") {
            return { kind: "pods", fieldSelector: `spec.nodeName=${section.node}` };
        }
        if (section?.type === "pvcConsumers") {
            return { kind: "pods", namespace: this.ns };
        }
        if (section?.type === "cronjobJobs") {
            return { kind: "jobs", namespace: this.ns };
        }
        if (this.kindName === "pods") {
            return { kind: "pods", namespace: this.ns, fieldSelector: `metadata.name=${this.obj.metadata?.name}` };
        }
        // Any other namespaced kind (secret, configmap, ingress, CRD, …): watch
        // the object itself so edits — yours or external — show without delay.
        if (this.ns) {
            return { kind: this.kindName, namespace: this.ns, fieldSelector: `metadata.name=${this.obj.metadata?.name}` };
        }
        return undefined;
    }

    /** Coalesce a burst of watch events (a rollout) into one refresh. */
    private scheduleRefresh(): void {
        if (this.refreshTimer || this.disposed) {
            return;
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
        }, 150);
    }

    private async loadEvents(): Promise<void> {
        this.events = await this.host.getEvents(this.ref, this.singular).catch(() => []);
    }

    private async loadSection(): Promise<void> {
        const section = this.model.section;
        if (!section) {
            this.onEnterRow = undefined;
            return;
        }
        switch (section.type) {
            case "workloadPods":
            case "endpointPods": {
                const { pods, top } = await this.host.fetchPods(this.ns, section.selector);
                this.sectionObjects = pods;
                this.top = top;
                this.setPodMetricTable(pods, top);
                this.onEnterRow = (i) => this.sectionObjects[i] && this.host.openPod(this.sectionObjects[i]);
                break;
            }
            case "podContainers": {
                this.sectionObjects = [];
                // Pull namespace pod metrics so the summary's CPU/Mem is live.
                const { top } = await this.host.fetchPods(this.ns, "");
                this.top = top;
                const rows = podContainers(this.obj).map((c) => [c.name, c.image, c.ready, c.restarts]);
                this.table.setData(["CONTAINER", "IMAGE", "READY", "RESTARTS"], rows, -1);
                this.onEnterRow = undefined;
                break;
            }
            case "nodePods": {
                const pods = await this.host.listObjects("pods", { fieldSelector: `spec.nodeName=${section.node}` });
                this.sectionObjects = pods;
                const rows = pods.map((p) => {
                    const base = podsKind ? podsKind.row(p) : [p.metadata?.name ?? "", "", "", "", "", "", age(p)];
                    return [p.metadata?.namespace ?? "", base[0], base[2], base[3], age(p)];
                });
                this.table.setData(["NAMESPACE", "NAME", "STATUS", "RESTARTS", "AGE"], rows, 2);
                this.onEnterRow = (i) => this.sectionObjects[i] && this.host.openPod(this.sectionObjects[i]);
                break;
            }
            case "pvcConsumers": {
                const pods = (await this.host.listObjects("pods", { namespace: this.ns })).filter((p) =>
                    podMountsPVC(p, section.pvc),
                );
                this.sectionObjects = pods;
                this.setPodMetricTable(pods, this.top);
                this.onEnterRow = (i) => this.sectionObjects[i] && this.host.openPod(this.sectionObjects[i]);
                break;
            }
            case "cronjobJobs": {
                const name = this.obj.metadata?.name ?? "";
                const jobs = (await this.host.listObjects("jobs", { namespace: this.ns }))
                    .filter((j) => jobOwnedByCronJob(j, name))
                    .sort((a, b) => new Date(b.metadata?.creationTimestamp ?? 0).getTime() - new Date(a.metadata?.creationTimestamp ?? 0).getTime());
                this.sectionObjects = jobs;
                const rows = jobs.map((j) => [
                    j.metadata?.name ?? "",
                    jobStatus(j),
                    String((j.status as { succeeded?: number })?.succeeded ?? 0),
                    age(j),
                ]);
                this.table.setData(["NAME", "STATUS", "SUCCEEDED", "AGE"], rows, 1);
                this.onEnterRow = (i) => this.sectionObjects[i] && this.host.openResource(this.sectionObjects[i], "jobs", "Job");
                break;
            }
            case "dataKeys": {
                this.sectionObjects = [];
                const data = (this.obj.data as Record<string, string>) ?? {};
                const keys = Object.keys(data).sort();
                const rows = keys.map((k) => [k, `${decodedLength(data[k], section.decode)} B`]);
                this.table.setData(["KEY", "SIZE"], rows, -1);
                this.onEnterRow = (i) => {
                    const key = keys[i];
                    if (key !== undefined) {
                        const value = section.decode ? decodeSecretValue(data[key]) : data[key];
                        this.host.openText(`${this.ref.name} · ${key}`, value);
                    }
                };
                break;
            }
            case "ingressRules": {
                this.sectionObjects = [];
                this.table.setData(["HOST", "PATH", "SERVICE", "PORT"], ingressRuleRows(this.obj), -1);
                this.onEnterRow = undefined;
                break;
            }
        }
    }

    private setPodMetricTable(pods: K8sObject[], top: Map<string, PodMetrics>): void {
        const columns = ["NAME", "READY", "STATUS", "RESTARTS", "CPU", "MEM", "NODE", "AGE"];
        const rows = pods.map((p) => {
            const base = podsKind ? podsKind.row(p) : [p.metadata?.name ?? "", "", "", "", "", "", age(p)];
            const m = top.get(p.metadata?.name ?? "");
            // base = [name, ready, status, restarts, ip, node, age]
            return [base[0], base[1], base[2], base[3], m?.cpu ?? "—", m?.memory ?? "—", base[5], base[6]];
        });
        this.table.setData(columns, rows, 2);
    }

    private selectedSectionObject(): K8sObject | undefined {
        return this.sectionObjects[this.table.selected()];
    }

    handleInput(data: string): void {
        if (this.model.section && this.table.handleInput(data, this.tableHeight())) {
            return;
        }
        if (matchesKey(data, "escape") || matchesKey(data, "q")) {
            this.host.back();
        } else if (matchesKey(data, "enter")) {
            if (this.onEnterRow) {
                this.onEnterRow(this.table.selected());
            } else {
                this.host.openYaml(this.ref);
            }
        } else if (matchesKey(data, "y")) {
            this.host.openYaml(this.ref);
        } else if (matchesKey(data, "d")) {
            this.host.openDescribe(this.ref);
        } else if (matchesKey(data, "l")) {
            this.openLogs();
        } else if (matchesKey(data, "p") && this.isWorkload) {
            const pod = this.selectedSectionObject();
            if (pod) this.host.openPod(pod);
        } else if (matchesKey(data, "f")) {
            this.handleForward();
        } else if (matchesKey(data, "s") && this.kindName === "pods") {
            this.host.shellIntoPod(this.obj);
        } else if (matchesKey(data, "shift+s") && this.canScale()) {
            this.host.scaleResource(this.obj, this.kindName, this.singular);
        } else if (matchesKey(data, "shift+t") && this.canRestart()) {
            this.host.restartResource(this.obj, this.kindName, this.singular);
        } else if (matchesKey(data, "shift+c") && this.kindName === "nodes") {
            this.host.cordonNode(this.obj, false);
        } else if (matchesKey(data, "shift+u") && this.kindName === "nodes") {
            this.host.cordonNode(this.obj, true);
        } else if (matchesKey(data, "shift+d") && this.kindName === "nodes") {
            this.host.drainNode(this.obj);
        } else if (matchesKey(data, "space") && this.kindName === "cronjobs") {
            const suspended = (this.obj.spec as { suspend?: boolean })?.suspend ?? false;
            this.host.suspendCronJob(this.obj, !suspended);
        } else if (matchesKey(data, "t") && this.kindName === "cronjobs") {
            this.host.triggerCronJob(this.obj);
        } else if (matchesKey(data, "r") && this.kindName === "deployments") {
            const selector = (this.model.section?.type === "workloadPods" && this.model.section.selector) || undefined;
            if (selector) this.host.openRevisions(this.obj, selector);
        }
    }

    private canScale(): boolean {
        return ["deployments", "statefulsets", "replicasets"].includes(this.kindName);
    }

    private canRestart(): boolean {
        return ["deployments", "statefulsets", "daemonsets"].includes(this.kindName);
    }

    private handleForward(): void {
        if (this.kindName === "pods" || this.kindName === "services") {
            this.host.portForward(this.obj, this.kindName);
        }
    }

    private openLogs(): void {
        const section = this.model.section;
        if (this.isWorkload && section?.type === "workloadPods") {
            this.host.openLogs({
                context: this.context,
                namespace: this.ns,
                selector: section.selector,
                title: `${this.ref.name} · logs (all pods, live)`,
            });
        } else if (this.kindName === "pods") {
            this.host.openLogs({
                context: this.context,
                namespace: this.ns,
                podName: this.ref.name,
                title: `${this.ref.name} · logs (live)`,
            });
        }
    }

    // ── layout / render ──────────────────────────────────────────────────────
    private get rows(): number {
        return process.stdout.rows || 24;
    }

    /** Lines available to the section table (header + rows). */
    private tableHeight(): number {
        const top = 1 + this.model.summary.length + 1; // header + summary + blank
        const eventsBlock = this.eventsRowCount() ? this.eventsRowCount() + 2 : 0;
        const sectionLabel = this.model.section ? 1 : 0;
        return Math.max(2, this.rows - top - 1 /*footer*/ - eventsBlock - sectionLabel);
    }

    private eventsRowCount(): number {
        if (this.events.length === 0) return 0;
        const top = 1 + this.model.summary.length + 1;
        // When there's no section, events can take the whole middle.
        const cap = this.model.section ? 8 : Math.max(1, this.rows - top - 1);
        return Math.min(this.events.length, cap);
    }

    render(width: number): string[] {
        const kind = this.kindName.replace(/s$/, "");
        const lines = [ui.headerBar(` ${kind}: ${this.ref.name} `)];
        for (const [key, value] of this.model.summary) {
            lines.push(`  ${ui.headerKey(`${key}:`)} ${ui.headerVal(value)}`);
        }
        lines.push("");

        if (this.model.section) {
            const count = this.sectionObjects.length || this.table.count;
            lines.push(ui.columnHeader(`  ${this.model.section.title} (${count})${this.loading ? "  loading…" : ""}`));
            const tableHeight = this.tableHeight();
            const tableLines = this.table.render(width, tableHeight);
            while (tableLines.length < tableHeight) tableLines.push("");
            lines.push(...tableLines);
        }

        const eventRows = this.eventsRowCount();
        if (eventRows > 0) {
            lines.push("");
            lines.push(ui.columnHeader(`  Events (${this.events.length})`));
            for (const e of this.events.slice(0, eventRows)) {
                lines.push(eventLine(e, width));
            }
        }

        while (lines.length < this.rows - 1) lines.push("");
        lines.push(`  ${ui.footer(this.hint())}`);
        return lines;
    }

    private hint(): string {
        const parts: string[] = [];
        if (this.onEnterRow) parts.push("enter open");
        parts.push("y yaml", "d describe");
        if (this.isWorkload || this.kindName === "pods") parts.push("l logs");
        if (this.kindName === "pods") parts.push("s shell", "f forward");
        if (this.kindName === "services") parts.push("f forward");
        if (this.canScale()) parts.push("S scale");
        if (this.canRestart()) parts.push("T restart");
        if (this.kindName === "deployments") parts.push("r revisions");
        if (this.kindName === "nodes") parts.push("C cordon", "U uncordon", "D drain");
        if (this.kindName === "cronjobs") parts.push("space suspend", "t trigger");
        parts.push("esc back");
        return parts.join(" · ");
    }
}

function decodedLength(value: string, decode: boolean): number {
    if (!decode) return value.length;
    try {
        return Buffer.from(value, "base64").length;
    } catch {
        return value.length;
    }
}

function eventLine(e: K8sEvent, width: number): string {
    const when = e.lastSeen ? age({ metadata: { creationTimestamp: e.lastSeen } } as K8sObject) : "";
    const count = e.count > 1 ? ` x${e.count}` : "";
    const head = `  ${when.padEnd(5)} ${e.reason}${count}`;
    const color = e.type === "Warning" ? ui.warn : ui.dim;
    const msg = ` ${e.message}`;
    const line = head + msg;
    return color(truncateToWidth(line, width));
}

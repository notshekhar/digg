import { matchesKey } from "@earendil-works/pi-tui";
import type { K8sObject, PodMetrics, ResourceRef } from "../kubectl.ts";
import { findKind, podContainers, workloadSelector, workloadSummary, age } from "../format.ts";
import { ui } from "../theme.ts";
import { Table } from "./table.ts";

export interface LogSpec {
    context: string;
    namespace?: string;
    podName?: string;
    selector?: string;
    title: string;
}

export interface DetailHost {
    requestRender(): void;
    back(): void;
    openYaml(ref: ResourceRef): void;
    openDescribe(ref: ResourceRef): void;
    openLogs(spec: LogSpec): void;
    openPod(pod: K8sObject): void;
    openRevisions(obj: K8sObject, selector: string): void;
    fetchPods(namespace: string | undefined, selector: string): Promise<{ pods: K8sObject[]; top: Map<string, PodMetrics> }>;
}

const podsKind = findKind("pods");

/**
 * A Lens/Aptakube-style drill-in. For a workload it shows a summary plus its
 * live pods (with CPU/memory) and lets you open the YAML, describe, aggregated
 * logs, or drill into an individual pod. For a pod it shows containers.
 */
export class DetailView {
    private host: DetailHost;
    private obj: K8sObject;
    private kindName: string;
    private context: string;
    private isWorkload: boolean;
    private selector?: string;

    private summary: [string, string][] = [];
    private table = new Table();
    private pods: K8sObject[] = [];
    private top = new Map<string, PodMetrics>();
    private loading = true;

    constructor(host: DetailHost, obj: K8sObject, kindName: string, context: string, isWorkload: boolean) {
        this.host = host;
        this.obj = obj;
        this.kindName = kindName;
        this.context = context;
        this.isWorkload = isWorkload;
        this.selector = isWorkload ? workloadSelector(obj) : undefined;
        this.buildSummary();
    }

    private get ref(): ResourceRef {
        return {
            kind: this.kindName,
            name: this.obj.metadata?.name ?? "",
            namespace: this.obj.metadata?.namespace,
            context: this.context,
        };
    }

    private buildSummary(): void {
        if (this.isWorkload) {
            this.summary = workloadSummary(this.obj);
        } else {
            const status = this.obj.status as { phase?: string; podIP?: string; qosClass?: string };
            const node = (this.obj.spec as { nodeName?: string })?.nodeName ?? "—";
            const metrics = this.top.get(this.obj.metadata?.name ?? "");
            this.summary = [
                ["Namespace", this.obj.metadata?.namespace ?? "—"],
                ["Node", node],
                ["Pod IP", status?.podIP ?? "—"],
                ["Status", status?.phase ?? "—"],
                ["QoS", status?.qosClass ?? "—"],
                ["CPU / Mem", metrics ? `${metrics.cpu} / ${metrics.memory}` : "—"],
                ["Age", age(this.obj)],
            ];
        }
    }

    async refresh(): Promise<void> {
        try {
            if (this.isWorkload && this.selector) {
                const { pods, top } = await this.host.fetchPods(this.obj.metadata?.namespace, this.selector);
                this.pods = pods;
                this.top = top;
            } else if (!this.isWorkload) {
                // No selector → metrics for the namespace; we read this pod by name.
                const { top } = await this.host.fetchPods(this.obj.metadata?.namespace, "");
                this.top = top;
                this.buildSummary();
            }
        } catch {
            // leave previous data in place on transient errors
        }
        this.loading = false;
        this.rebuildTable();
        this.host.requestRender();
    }

    private rebuildTable(): void {
        if (this.isWorkload) {
            const columns = ["NAME", "READY", "STATUS", "RESTARTS", "CPU", "MEM", "NODE", "AGE"];
            const rows = this.pods.map((p) => {
                const base = podsKind ? podsKind.row(p) : [p.metadata?.name ?? "", "", "", "", age(p)];
                const metrics = this.top.get(p.metadata?.name ?? "");
                const node = (p.spec as { nodeName?: string })?.nodeName ?? "";
                // base = [name, ready, status, restarts, age]
                return [base[0], base[1], base[2], base[3], metrics?.cpu ?? "—", metrics?.memory ?? "—", node, base[4]];
            });
            this.table.setData(columns, rows, 2);
        } else {
            const columns = ["CONTAINER", "IMAGE", "READY", "RESTARTS"];
            const rows = podContainers(this.obj).map((c) => [c.name, c.image, c.ready, c.restarts]);
            this.table.setData(columns, rows, -1);
        }
    }

    private selectedPod(): K8sObject | undefined {
        return this.isWorkload ? this.pods[this.table.selected()] : undefined;
    }

    handleInput(data: string): void {
        const bodyHeight = this.tableHeight();
        if (this.table.handleInput(data, bodyHeight)) {
            return;
        }
        // Table handled nav above; here handle actions. Use matchesKey so
        // esc/enter work under the Kitty keyboard protocol (not raw bytes).
        if (matchesKey(data, "escape") || matchesKey(data, "q")) {
            this.host.back();
        } else if (matchesKey(data, "enter")) {
            if (this.isWorkload) {
                const pod = this.selectedPod();
                if (pod) {
                    this.host.openPod(pod);
                }
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
            const pod = this.selectedPod();
            if (pod) {
                this.host.openPod(pod);
            }
        } else if (matchesKey(data, "r") && this.kindName === "deployments" && this.selector) {
            this.host.openRevisions(this.obj, this.selector);
        }
    }

    private openLogs(): void {
        if (this.isWorkload && this.selector) {
            // Inside a workload: aggregate live logs from every pod it owns.
            this.host.openLogs({
                context: this.context,
                namespace: this.obj.metadata?.namespace,
                selector: this.selector,
                title: `${this.ref.name} · logs (all pods, live)`,
            });
        } else {
            // Inside a pod: that pod's logs only.
            this.host.openLogs({
                context: this.context,
                namespace: this.obj.metadata?.namespace,
                podName: this.ref.name,
                title: `${this.ref.name} · logs (live)`,
            });
        }
    }

    private tableHeight(): number {
        const rows = process.stdout.rows || 24;
        // header(1) + summary + blank(1) + section label(1) + footer(1)
        return Math.max(2, rows - (1 + this.summary.length + 1 + 1 + 1));
    }

    render(width: number): string[] {
        const kind = this.kindName.replace(/s$/, "");
        const header = `${ui.headerBar(` ${kind}: ${this.ref.name} `)}`;
        const lines = [header];
        for (const [key, value] of this.summary) {
            lines.push(`  ${ui.headerKey(`${key}:`)} ${ui.headerVal(value)}`);
        }
        lines.push("");

        if (this.isWorkload) {
            lines.push(ui.columnHeader(`  Pods (${this.pods.length})${this.loading ? "  loading…" : ""}`));
        } else {
            lines.push(ui.columnHeader("  Containers"));
        }

        // Pad the table region to its reserved height so the footer pins to the
        // bottom of the screen instead of floating below short content.
        const tableHeight = this.tableHeight();
        const tableLines = this.table.render(width, tableHeight);
        while (tableLines.length < tableHeight) {
            tableLines.push("");
        }
        lines.push(...tableLines);

        const revisions = this.kindName === "deployments" ? " · r revisions" : "";
        const hint = this.isWorkload
            ? `enter/p open pod · y yaml · d describe · l logs (all pods, live)${revisions} · esc back`
            : "y yaml · d describe · l logs (live) · esc back";
        lines.push(`  ${ui.footer(hint)}`);
        return lines;
    }
}

// Per-kind detail "models": the summary key/values and the one navigable
// section a resource's dashboard shows. DetailView (views/detail-view.ts) is the
// generic executor — it loads section data + events and renders. This file is
// the per-kind knowledge, so every kind gets a real page instead of a YAML dump.

import type { K8sObject, PodMetrics } from "./kubectl.ts";
import {
    age,
    jobStatus,
    nodeRoles,
    pvcAccessModes,
    workloadSelector,
    workloadSummary,
} from "./format.ts";

/** A declarative description of a detail page's main section. */
export type Section =
    | { type: "workloadPods"; title: string; selector: string }
    | { type: "podContainers"; title: string }
    | { type: "endpointPods"; title: string; selector: string }
    | { type: "nodePods"; title: string; node: string }
    | { type: "pvcConsumers"; title: string; pvc: string }
    | { type: "cronjobJobs"; title: string }
    | { type: "dataKeys"; title: string; decode: boolean }
    | { type: "ingressRules"; title: string };

export interface DetailModel {
    summary: [string, string][];
    section?: Section;
}

const dash = (v: string | undefined | null): string => (v && v.length > 0 ? v : "—");

/**
 * Build the detail model for a resource. `top` (pod metrics) is threaded in so
 * a pod's summary can show live CPU/Mem; it's rebuilt each refresh.
 */
export function detailModel(
    kindName: string,
    obj: K8sObject,
    isWorkload: boolean,
    top: Map<string, PodMetrics>,
): DetailModel {
    if (isWorkload) {
        const selector = workloadSelector(obj);
        return {
            summary: workloadSummary(obj),
            section: selector ? { type: "workloadPods", title: "Pods", selector } : undefined,
        };
    }
    switch (kindName) {
        case "pods":
            return { summary: podSummary(obj, top), section: { type: "podContainers", title: "Containers" } };
        case "services":
            return serviceModel(obj);
        case "nodes":
            return nodeModel(obj);
        case "configmaps":
            return {
                summary: cmSummary(obj),
                section: { type: "dataKeys", title: "Data", decode: false },
            };
        case "secrets":
            return {
                summary: secretSummary(obj),
                section: { type: "dataKeys", title: "Data", decode: true },
            };
        case "ingresses":
            return ingressModel(obj);
        case "persistentvolumeclaims":
            return pvcModel(obj);
        case "cronjobs":
            return cronjobModel(obj);
        case "namespaces":
            return { summary: namespaceSummary(obj) };
        default:
            return { summary: genericSummary(obj) };
    }
}

function podSummary(obj: K8sObject, top: Map<string, PodMetrics>): [string, string][] {
    const status = obj.status as { phase?: string; podIP?: string; qosClass?: string };
    const node = (obj.spec as { nodeName?: string })?.nodeName ?? "—";
    const metrics = top.get(obj.metadata?.name ?? "");
    return [
        ["Namespace", dash(obj.metadata?.namespace)],
        ["Node", node],
        ["Pod IP", dash(status?.podIP)],
        ["Status", dash(status?.phase)],
        ["QoS", dash(status?.qosClass)],
        ["CPU / Mem", metrics ? `${metrics.cpu} / ${metrics.memory}` : "—"],
        ["Age", age(obj)],
    ];
}

function serviceModel(obj: K8sObject): DetailModel {
    const spec = obj.spec as {
        type?: string;
        clusterIP?: string;
        selector?: Record<string, string>;
        ports?: { name?: string; port?: number; targetPort?: number | string; protocol?: string }[];
    };
    const selector = spec?.selector
        ? Object.entries(spec.selector).map(([k, v]) => `${k}=${v}`).join(",")
        : "";
    const ports = (spec?.ports ?? [])
        .map((p) => `${p.name ? `${p.name}:` : ""}${p.port}→${p.targetPort ?? p.port}/${p.protocol ?? "TCP"}`)
        .join(", ");
    const summary: [string, string][] = [
        ["Namespace", dash(obj.metadata?.namespace)],
        ["Type", dash(spec?.type)],
        ["Cluster IP", dash(spec?.clusterIP)],
        ["Ports", dash(ports)],
        ["Selector", dash(selector)],
        ["Age", age(obj)],
    ];
    return {
        summary,
        section: selector ? { type: "endpointPods", title: "Endpoints (pods)", selector } : undefined,
    };
}

function nodeModel(obj: K8sObject): DetailModel {
    const info = (obj.status as {
        nodeInfo?: {
            kubeletVersion?: string;
            osImage?: string;
            kernelVersion?: string;
            containerRuntimeVersion?: string;
            operatingSystem?: string;
            architecture?: string;
        };
        capacity?: { cpu?: string; memory?: string; pods?: string };
        addresses?: { type?: string; address?: string }[];
    })?.nodeInfo;
    const status = obj.status as {
        capacity?: { cpu?: string; memory?: string; pods?: string };
        addresses?: { type?: string; address?: string }[];
    };
    const internalIP = (status?.addresses ?? []).find((a) => a.type === "InternalIP")?.address;
    const cap = status?.capacity;
    const summary: [string, string][] = [
        ["Roles", nodeRoles(obj)],
        ["Version", dash(info?.kubeletVersion)],
        ["OS", dash(info?.osImage)],
        ["Kernel", dash(info?.kernelVersion)],
        ["Runtime", dash(info?.containerRuntimeVersion)],
        ["Arch", dash(info?.architecture)],
        ["Internal IP", dash(internalIP)],
        ["Capacity", cap ? `${cap.cpu ?? "?"} cpu · ${cap.memory ?? "?"} mem · ${cap.pods ?? "?"} pods` : "—"],
        ["Age", age(obj)],
    ];
    return { summary, section: { type: "nodePods", title: "Pods on node", node: obj.metadata?.name ?? "" } };
}

function cmSummary(obj: K8sObject): [string, string][] {
    return [
        ["Namespace", dash(obj.metadata?.namespace)],
        ["Keys", String(Object.keys((obj.data as object) ?? {}).length)],
        ["Age", age(obj)],
    ];
}

function secretSummary(obj: K8sObject): [string, string][] {
    return [
        ["Namespace", dash(obj.metadata?.namespace)],
        ["Type", dash(String(obj.type ?? ""))],
        ["Keys", String(Object.keys((obj.data as object) ?? {}).length)],
        ["Age", age(obj)],
    ];
}

function ingressModel(obj: K8sObject): DetailModel {
    const spec = obj.spec as { ingressClassName?: string };
    return {
        summary: [
            ["Namespace", dash(obj.metadata?.namespace)],
            ["Class", dash(spec?.ingressClassName)],
            ["Age", age(obj)],
        ],
        section: { type: "ingressRules", title: "Rules" },
    };
}

function pvcModel(obj: K8sObject): DetailModel {
    const spec = obj.spec as { volumeName?: string; storageClassName?: string };
    const status = obj.status as { phase?: string; capacity?: { storage?: string } };
    return {
        summary: [
            ["Namespace", dash(obj.metadata?.namespace)],
            ["Status", dash(status?.phase)],
            ["Volume", dash(spec?.volumeName)],
            ["Capacity", dash(status?.capacity?.storage)],
            ["Access Modes", dash(pvcAccessModes(obj))],
            ["StorageClass", dash(spec?.storageClassName)],
            ["Age", age(obj)],
        ],
        section: { type: "pvcConsumers", title: "Mounted by (pods)", pvc: obj.metadata?.name ?? "" },
    };
}

function cronjobModel(obj: K8sObject): DetailModel {
    const spec = obj.spec as { schedule?: string; suspend?: boolean };
    const status = obj.status as { active?: unknown[]; lastScheduleTime?: string };
    return {
        summary: [
            ["Namespace", dash(obj.metadata?.namespace)],
            ["Schedule", dash(spec?.schedule)],
            ["Suspend", String(spec?.suspend ?? false)],
            ["Active", String(status?.active?.length ?? 0)],
            ["Last Schedule", status?.lastScheduleTime ? age({ metadata: { creationTimestamp: status.lastScheduleTime } } as K8sObject) : "—"],
            ["Age", age(obj)],
        ],
        section: { type: "cronjobJobs", title: "Jobs" },
    };
}

function namespaceSummary(obj: K8sObject): [string, string][] {
    const labels = obj.metadata?.labels ?? {};
    const labelStr = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(", ");
    return [
        ["Status", dash((obj.status as { phase?: string })?.phase)],
        ["Labels", dash(labelStr)],
        ["Age", age(obj)],
    ];
}

function genericSummary(obj: K8sObject): [string, string][] {
    const rows: [string, string][] = [];
    if (obj.metadata?.namespace) {
        rows.push(["Namespace", obj.metadata.namespace]);
    }
    if (typeof obj.apiVersion === "string") {
        rows.push(["API Version", obj.apiVersion]);
    }
    const phase = (obj.status as { phase?: string })?.phase;
    if (phase) {
        rows.push(["Status", phase]);
    }
    rows.push(["Age", age(obj)]);
    return rows;
}

// ── section row builders (pure; DetailView fetches the objects) ──────────────

export const POD_SECTION_COLUMNS = ["NAME", "READY", "STATUS", "RESTARTS", "CPU", "MEM", "NODE", "AGE"];

/** Flatten an ingress's rules into [HOST, PATH, SERVICE, PORT] rows. */
export function ingressRuleRows(obj: K8sObject): string[][] {
    const rules =
        (obj.spec as {
            rules?: {
                host?: string;
                http?: { paths?: { path?: string; backend?: { service?: { name?: string; port?: { number?: number; name?: string } } } }[] };
            }[];
        })?.rules ?? [];
    const rows: string[][] = [];
    for (const rule of rules) {
        const host = rule.host ?? "*";
        const paths = rule.http?.paths ?? [];
        if (paths.length === 0) {
            rows.push([host, "/", "—", "—"]);
            continue;
        }
        for (const p of paths) {
            const svc = p.backend?.service;
            const port = svc?.port?.number ?? svc?.port?.name ?? "";
            rows.push([host, p.path ?? "/", svc?.name ?? "—", String(port)]);
        }
    }
    return rows;
}

/** Does this pod mount the named PVC? */
export function podMountsPVC(pod: K8sObject, pvc: string): boolean {
    const volumes = (pod.spec as { volumes?: { persistentVolumeClaim?: { claimName?: string } }[] })?.volumes ?? [];
    return volumes.some((v) => v.persistentVolumeClaim?.claimName === pvc);
}

/** Is this job owned by the named CronJob? */
export function jobOwnedByCronJob(job: K8sObject, name: string): boolean {
    const owners = (job.metadata as { ownerReferences?: { kind?: string; name?: string }[] })?.ownerReferences ?? [];
    return owners.some((o) => o.kind === "CronJob" && o.name === name);
}

export { jobStatus };

/**
 * Fetching half of the rich detail page: gather what src/detail-view.ts needs
 * (the pods a workload owns, per-container metrics, the ReplicaSets behind a
 * rollout) and hand it to the pure builders.
 */

import {
    type K8sEvent,
    type K8sObject,
    type PodMetrics,
    type ResourceRef,
    getEvents,
    getJson,
    listResources,
    topPodContainers,
    topPods,
} from "../kubectl.ts";
import { type KindDef, WORKLOAD_KINDS, age, findKind, podContainers, revisionOf, workloadSelector } from "../format.ts";
import { detailModel, ingressRuleRows, jobOwnedByCronJob, jobStatus, podMountsPVC } from "../details.ts";
import { logSpecFor } from "../log-stream.ts";
import { type DetailView, RICH_KINDS, nodeView, podView, workloadView } from "../detail-view.ts";
import { NO_METRICS, metricsFromContainers, metricsView } from "../usage.ts";

export async function buildDetailView(
    kindName: string,
    obj: K8sObject,
    context: string,
): Promise<DetailView | null> {
    if (!RICH_KINDS.has(kindName)) return null;
    const ns = obj.metadata?.namespace;
    const name = obj.metadata?.name ?? "";

    if (kindName === "pods") {
        const containers = await topPodContainers(context, { namespace: ns, pod: name }).catch(() => new Map());
        return podView(obj, containers.size ? metricsFromContainers(containers) : NO_METRICS);
    }

    if (kindName === "nodes") {
        const [pods, top] = await Promise.all([
            listResources("pods", { context, fieldSelector: `spec.nodeName=${name}` }).catch(() => [] as K8sObject[]),
            topPods(context, undefined).catch(() => new Map()),
        ]);
        return nodeView(obj, pods, metricsView(top));
    }

    if (WORKLOAD_KINDS.has(kindName)) {
        const selector = workloadSelector(obj);
        const [pods, containers] = await Promise.all([
            selector
                ? listResources("pods", { context, namespace: ns, labelSelector: selector }).catch(
                      () => [] as K8sObject[],
                  )
                : Promise.resolve([] as K8sObject[]),
            selector
                ? topPodContainers(context, { namespace: ns, labelSelector: selector }).catch(() => new Map())
                : Promise.resolve(new Map()),
        ]);
        pods.sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
        return workloadView(obj, kindName, pods, containers.size ? metricsFromContainers(containers) : NO_METRICS);
    }

    return null;
}

export interface RevisionRow {
    revision: number;
    name: string;
    /** The kind to open when the row is clicked. */
    kind: string;
    ns?: string;
    replicas: number;
    ready: number;
    images: string;
    age: string;
    ts: number;
    current: boolean;
}

/**
 * Rollout history as objects rather than `kubectl rollout history` text.
 *
 * Deployments keep every revision as a ReplicaSet, so the list can be clicked
 * through to the pods each one ran; StatefulSets and DaemonSets use
 * ControllerRevisions, which carry the revision number but no replica count.
 */
export async function buildRevisions(kindName: string, obj: K8sObject, context: string): Promise<RevisionRow[]> {
    const ns = obj.metadata?.namespace;
    const uid = obj.metadata?.uid;
    const name = obj.metadata?.name ?? "";
    const ownedByThis = (o: K8sObject) =>
        (o.metadata?.ownerReferences ?? []).some((r) => (uid ? r.uid === uid : r.name === name));

    if (kindName === "deployments") {
        const sets = (await listResources("replicasets", { context, namespace: ns }).catch(() => [] as K8sObject[]))
            .filter(ownedByThis)
            .sort((a, b) => revisionOf(b) - revisionOf(a));
        const currentRevision = sets.length ? revisionOf(sets[0]!) : 0;
        return sets.map((rs) => {
            const status = rs.status as { replicas?: number; readyReplicas?: number };
            const containers =
                ((rs.spec as { template?: { spec?: { containers?: { image?: string }[] } } })?.template?.spec
                    ?.containers) ?? [];
            return {
                revision: revisionOf(rs),
                name: rs.metadata?.name ?? "",
                kind: "replicasets",
                ns: rs.metadata?.namespace,
                replicas: (rs.spec as { replicas?: number })?.replicas ?? 0,
                ready: status?.readyReplicas ?? 0,
                images: containers.map((c) => c.image ?? "").filter(Boolean).join(", "),
                age: age(rs),
                ts: new Date(rs.metadata?.creationTimestamp ?? 0).getTime(),
                current: revisionOf(rs) === currentRevision && (status?.replicas ?? 0) > 0,
            };
        });
    }

    if (kindName === "statefulsets" || kindName === "daemonsets") {
        const revs = (await listResources("controllerrevisions", { context, namespace: ns }).catch(
            () => [] as K8sObject[],
        )).filter(ownedByThis);
        const rows = revs
            .map((r) => ({
                revision: Number(r.revision ?? 0),
                name: r.metadata?.name ?? "",
                kind: "controllerrevisions",
                ns: r.metadata?.namespace,
                replicas: 0,
                ready: 0,
                images: "",
                age: age(r),
                ts: new Date(r.metadata?.creationTimestamp ?? 0).getTime(),
                current: false,
            }))
            .sort((a, b) => b.revision - a.revision);
        if (rows[0]) rows[0].current = true;
        return rows;
    }

    return [];
}

// ── the whole detail payload, shared by /api/detail and the live socket ──

export async function buildSection(
    kindName: string,
    obj: K8sObject,
    context: string,
    isWorkload: boolean,
    /** Kinds with a rich page already fetched their pods; don't fetch twice. */
    skipSection = false,
): Promise<{
    summary: [string, string][];
    section: {
        title: string;
        columns: string[];
        rows: string[][];
        tones?: (number | null)[];
        drill?: { kind: string; name: string; ns?: string }[];
        dataKeys?: { keys: string[]; decode: boolean };
    } | null;
    events: K8sEvent[];
    canLogs: boolean;
}> {
    let top = new Map<string, PodMetrics>();
    const model = detailModel(kindName, obj, isWorkload, top);
    const ns = obj.metadata?.namespace;
    let section: {
        title: string;
        columns: string[];
        rows: string[][];
        tones?: (number | null)[];
        drill?: { kind: string; name: string; ns?: string }[];
        dataKeys?: { keys: string[]; decode: boolean };
    } | null = null;

    const sec = skipSection ? undefined : model.section;
    if (sec) {
        switch (sec.type) {
            case "workloadPods":
            case "endpointPods": {
                const pods = await listResources("pods", {
                    context,
                    namespace: ns,
                    labelSelector: sec.selector,
                }).catch(() => [] as K8sObject[]);
                top = await topPods(context, ns, sec.selector);
                const podsKind = findKind("pods")!;
                const columns = ["NAME", "READY", "STATUS", "RESTARTS", "CPU", "MEM", "NODE", "AGE"];
                const rows = pods.map((p) => {
                    const base = podsKind.row(p);
                    const m = top.get(p.metadata?.name ?? "");
                    return [base[0], base[1], base[2], base[3], m?.cpu ?? "—", m?.memory ?? "—", base[5], base[6]];
                });
                section = {
                    title: sec.title,
                    columns,
                    rows,
                    tones: rows.map((r) => 2),
                    drill: pods.map((p) => ({
                        kind: "pods",
                        name: p.metadata?.name ?? "",
                        ns: p.metadata?.namespace,
                    })),
                };
                break;
            }
            case "podContainers": {
                top = await topPods(context, ns);
                const containers = podContainers(obj);
                section = {
                    title: sec.title,
                    columns: ["CONTAINER", "IMAGE", "READY", "RESTARTS"],
                    rows: containers.map((c) => [c.name, c.image, c.ready, c.restarts]),
                    tones: containers.map(() => 2),
                };
                break;
            }
            case "nodePods": {
                const pods = await listResources("pods", {
                    context,
                    fieldSelector: `spec.nodeName=${sec.node}`,
                }).catch(() => [] as K8sObject[]);
                const podsKind = findKind("pods")!;
                section = {
                    title: sec.title,
                    columns: ["NAMESPACE", "NAME", "STATUS", "RESTARTS", "AGE"],
                    rows: pods.map((p) => {
                        const base = podsKind.row(p);
                        return [p.metadata?.namespace ?? "", base[0], base[2], base[3], age(p)];
                    }),
                    tones: pods.map(() => 2),
                    drill: pods.map((p) => ({
                        kind: "pods",
                        name: p.metadata?.name ?? "",
                        ns: p.metadata?.namespace,
                    })),
                };
                break;
            }
            case "pvcConsumers": {
                const pods = (await listResources("pods", { context, namespace: ns }).catch(() => [] as K8sObject[])).filter(
                    (p) => podMountsPVC(p, sec.pvc),
                );
                const podsKind = findKind("pods")!;
                const columns = ["NAME", "READY", "STATUS", "RESTARTS", "CPU", "MEM", "NODE", "AGE"];
                const rows = pods.map((p) => {
                    const base = podsKind.row(p);
                    return [base[0], base[1], base[2], base[3], "—", "—", base[5], base[6]];
                });
                section = {
                    title: sec.title,
                    columns,
                    rows,
                    tones: rows.map(() => 2),
                    drill: pods.map((p) => ({
                        kind: "pods",
                        name: p.metadata?.name ?? "",
                        ns: p.metadata?.namespace,
                    })),
                };
                break;
            }
            case "cronjobJobs": {
                const name = obj.metadata?.name ?? "";
                const jobs = (await listResources("jobs", { context, namespace: ns }).catch(() => [] as K8sObject[]))
                    .filter((j) => jobOwnedByCronJob(j, name))
                    .sort(
                        (a, b) =>
                            new Date(b.metadata?.creationTimestamp ?? 0).getTime() -
                            new Date(a.metadata?.creationTimestamp ?? 0).getTime(),
                    );
                section = {
                    title: sec.title,
                    columns: ["NAME", "STATUS", "SUCCEEDED", "AGE"],
                    rows: jobs.map((j) => [
                        j.metadata?.name ?? "",
                        jobStatus(j),
                        String((j.status as { succeeded?: number })?.succeeded ?? 0),
                        age(j),
                    ]),
                    tones: jobs.map(() => 1),
                    drill: jobs.map((j) => ({
                        kind: "jobs",
                        name: j.metadata?.name ?? "",
                        ns: j.metadata?.namespace,
                    })),
                };
                break;
            }
            case "dataKeys": {
                const data = (obj.data as Record<string, string>) ?? {};
                const keys = Object.keys(data).sort();
                section = {
                    title: sec.title,
                    columns: ["KEY", "SIZE"],
                    rows: keys.map((k) => {
                        const raw = data[k] ?? "";
                        const bytes = sec.decode
                            ? Buffer.from(raw, "base64").byteLength
                            : Buffer.byteLength(raw);
                        return [k, `${bytes} B`];
                    }),
                    dataKeys: { keys, decode: sec.decode },
                };
                break;
            }
            case "ingressRules": {
                /*
                 * A routing table that says whether each route actually works.
                 *
                 * The rules alone are just intent — the useful question is
                 * whether the backend Service exists and has endpoints behind
                 * it, because a typo'd service name or a selector that matches
                 * nothing is the ordinary way an Ingress breaks, and kubectl
                 * will not tell you. Two list calls answer it for every row.
                 */
                const [services, endpoints] = await Promise.all([
                    listResources("services", { context, namespace: ns }).catch(() => [] as K8sObject[]),
                    listResources("endpoints", { context, namespace: ns }).catch(() => [] as K8sObject[]),
                ]);
                const svcByName = new Map(services.map((s) => [s.metadata?.name ?? "", s]));
                const readyByName = new Map(
                    endpoints.map((e) => {
                        const subsets = (e.subsets as { addresses?: unknown[] }[] | undefined) ?? [];
                        const ready = subsets.reduce((n, sub) => n + (sub.addresses?.length ?? 0), 0);
                        return [e.metadata?.name ?? "", ready];
                    }),
                );
                const tlsHosts = new Set(
                    ((obj.spec as { tls?: { hosts?: string[] }[] })?.tls ?? []).flatMap((t) => t.hosts ?? []),
                );

                const rows: string[][] = [];
                const drill: { kind: string; name: string; ns?: string }[] = [];
                for (const rule of ingressRuleRows(obj)) {
                    const [host, path, svcName, port] = rule as [string, string, string, string];
                    const svc = svcByName.get(svcName);
                    const ready = readyByName.get(svcName) ?? 0;
                    const backend = !svc ? "no such service" : ready === 0 ? "no endpoints" : `${ready} endpoints`;
                    const scheme = tlsHosts.has(host) ? "https" : "http";
                    const url = host === "*" ? "" : `${scheme}://${host}${path === "/" ? "" : path}`;
                    rows.push([host, path, `${svcName}:${port}`, backend, url]);
                    drill.push({ kind: "services", name: svcName, ns });
                }

                section = {
                    title: sec.title,
                    columns: ["HOST", "PATH", "BACKEND", "STATUS", "URL"],
                    rows,
                    tones: rows.map(() => 3),
                    drill,
                };
                break;
            }
        }
    }

    // Rebuild summary with live top metrics for pods/workloads.
    const summary = detailModel(kindName, obj, isWorkload, top).summary;
    const singular = findKind(kindName)?.kind ?? obj.kind ?? kindName;
    const events = await getEvents(
        {
            kind: kindName,
            name: obj.metadata?.name ?? "",
            namespace: ns,
            context,
        },
        singular,
    ).catch(() => [] as K8sEvent[]);

    const canLogs = Boolean(logSpecFor(kindName, obj, context));
    return { summary, section, events, canLogs };
}

/**
 * Everything a detail page renders, in one object.
 *
 * The HTTP route and the WebSocket both call this, so a pushed update and a
 * refreshed one can never disagree about what a page contains.
 */
export async function buildDetailPayload(kind: KindDef, ref: ResourceRef) {
    const obj = await getJson(ref);
    const isWorkload = WORKLOAD_KINDS.has(kind.name);
    // The rich view and the generic section are built together: kinds that have
    // a real page get one, everything else keeps the summary + table that every
    // kind is guaranteed.
    const [built, view] = await Promise.all([
        buildSection(kind.name, obj, ref.context, isWorkload, RICH_KINDS.has(kind.name)),
        buildDetailView(kind.name, obj, ref.context).catch(() => null),
    ]);
    return {
        kind: {
            name: kind.name,
            title: kind.title,
            kind: kind.kind,
            clusterScoped: Boolean(kind.clusterScoped),
            generic: Boolean(kind.generic),
            columns: kind.columns,
        },
        name: obj.metadata?.name ?? ref.name,
        ns: obj.metadata?.namespace,
        summary: built.summary,
        section: view ? null : built.section,
        view,
        events: built.events,
        canLogs: built.canLogs,
    };
}

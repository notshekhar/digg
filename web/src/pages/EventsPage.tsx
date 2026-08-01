/**
 * Cluster events, newest first.
 *
 * Events are the cluster's log of what it decided, and the single most useful
 * default here is "warnings only" being one click away — a busy cluster emits
 * hundreds of Normal events an hour and none of them are why you opened this
 * page.
 */

import { useMemo, useState } from "react";
import { Icon } from "../components/icons.tsx";
import { RowsSkeleton } from "../components/Skeleton.tsx";
import { Badge, Empty, ErrorBox } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ageFromIso, shortDate } from "../lib/format.ts";
import { useDelayed, usePolled } from "../lib/hooks.ts";
import { useApp } from "../lib/store.ts";
import { useFilter, useNamespaces, nsParam } from "../lib/query.ts";
import type { ResourceRef } from "../lib/types.ts";
import "./EventsPage.css";

const KIND_TO_RESOURCE: Record<string, string> = {
    Pod: "pods",
    Deployment: "deployments",
    StatefulSet: "statefulsets",
    DaemonSet: "daemonsets",
    ReplicaSet: "replicasets",
    Job: "jobs",
    CronJob: "cronjobs",
    Service: "services",
    Ingress: "ingresses",
    Node: "nodes",
    PersistentVolumeClaim: "persistentvolumeclaims",
    HorizontalPodAutoscaler: "horizontalpodautoscalers",
};

export function EventsPage({ onOpen }: { onOpen: (ref: ResourceRef, tab?: string) => void }) {
    const context = useApp((s) => s.context);
    const [selectedNs] = useNamespaces();
    const [warningsOnly, setWarningsOnly] = useState(true);
    const [q, setQ] = useFilter();

    const nsForApi = nsParam(selectedNs);
    const { data, error, initial } = usePolled(
        () => api.events({ context, ns: nsForApi, limit: 1000 }),
        [context, nsForApi],
        { enabled: Boolean(context) },
    );

    const waiting = useDelayed(initial && !data && !error);

    const rows = useMemo(() => {
        let out = data?.events ?? [];
        if (selectedNs.length > 1) {
            const set = new Set(selectedNs);
            out = out.filter((e) => set.has(e.namespace));
        }
        if (warningsOnly) out = out.filter((e) => e.type === "Warning");
        const needle = q.trim().toLowerCase();
        if (needle) {
            out = out.filter(
                (e) =>
                    e.object.toLowerCase().includes(needle) ||
                    e.reason.toLowerCase().includes(needle) ||
                    e.message.toLowerCase().includes(needle) ||
                    e.namespace.toLowerCase().includes(needle),
            );
        }
        return out;
    }, [data, warningsOnly, q, selectedNs]);

    const warnings = (data?.events ?? []).filter((e) => e.type === "Warning").length;

    return (
        <div className="page">
            <div className="toolbar">
                <div className="toolbar-title">
                    <h1>Events</h1>
                    <span className="count mono">{rows.length}</span>
                </div>
                <div className="spring" />
                <button
                    className="btn sm"
                    type="button"
                    aria-pressed={warningsOnly}
                    onClick={() => setWarningsOnly((w) => !w)}
                    title="Show warnings only"
                >
                    <Icon.Warn size={12} /> Warnings {warnings > 0 ? <span className="mono">{warnings}</span> : null}
                </button>
                <div className="search list-search">
                    <Icon.Search size={13} />
                    <input placeholder="Filter events…" value={q} onChange={(e) => void setQ(e.target.value || null)} />
                </div>
            </div>

            {error ? <ErrorBox error={error} /> : null}

            {waiting ? (
                <RowsSkeleton />
            ) : rows.length === 0 ? (
                <Empty
                    title={warningsOnly ? "No warnings" : "No events"}
                    hint={
                        warningsOnly
                            ? "Nothing has gone wrong recently. Turn off the warnings filter to see everything the cluster did."
                            : "The cluster has not recorded any events in its retention window."
                    }
                />
            ) : (
                <div className="events">
                    {rows.map((e, i) => {
                        const [kind, name] = e.object.split("/");
                        const resource = KIND_TO_RESOURCE[kind ?? ""];
                        return (
                            <div className={`event ${e.type === "Warning" ? "warn" : ""}`} key={`${e.object}-${e.lastSeen}-${i}`}>
                                <span className="ev-when mono" title={shortDate(e.lastSeen)}>
                                    {ageFromIso(e.lastSeen)}
                                </span>
                                <Badge tone={e.type === "Warning" ? "warn" : "idle"}>{e.reason}</Badge>
                                <button
                                    type="button"
                                    className="ev-obj mono truncate"
                                    disabled={!resource || !name}
                                    onClick={() => resource && name && onOpen({ kind: resource, name, ns: e.namespace })}
                                    title={e.object}
                                >
                                    {e.namespace ? `${e.namespace}/` : ""}
                                    {name ?? e.object}
                                </button>
                                <span className="ev-msg">{e.message}</span>
                                {e.count > 1 ? <span className="ev-count mono faint">×{e.count}</span> : null}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

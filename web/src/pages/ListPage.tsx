/**
 * A kind's rows: toolbar, grid, bulk bar.
 *
 * The namespace selector can hold several namespaces, which the API cannot
 * express — kubectl takes one namespace or all of them. So a multi-selection
 * fetches everything and filters here. It is the only place in digg where the
 * client second-guesses the server, and it exists because "prod + staging, not
 * the other forty" is a real way people look at a cluster.
 */

import { useEffect, useMemo, useState } from "react";
import { DataGrid, rowKey } from "../components/DataGrid.tsx";
import { ColumnsMenu } from "../components/DataGrid.tsx";
import { Icon } from "../components/icons.tsx";
import { Empty, ErrorBox } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { confirmDelete, resourceActions } from "../lib/actions.tsx";
import { usePolled } from "../lib/hooks.ts";
import { useEither, useLiveList } from "../lib/live-data.ts";
import { navigate } from "../lib/router.ts";
import { useApp } from "../lib/store.ts";
import { useFilter, useNamespaces, nsParam } from "../lib/query.ts";
import type { ResourceRef, Row } from "../lib/types.ts";
import "./ListPage.css";

export function ListPage({ kind, onOpen }: { kind: string; onOpen: (ref: ResourceRef, tab?: string) => void }) {
    const context = useApp((s) => s.context);
    const [selectedNs] = useNamespaces();
    const kinds = useApp((s) => s.kinds);
    const catalog = useApp((s) => s.catalog);
    const [q, setQ] = useFilter();
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [hidden, setHidden] = useState<Set<string>>(new Set());
    const refreshing = useApp((s) => s.refreshing);

    const meta = useMemo(() => {
        for (const g of catalog) {
            const found = g.kinds.find((k) => k.name === kind);
            if (found) return found;
        }
        return kinds.find((k) => k.name === kind);
    }, [catalog, kinds, kind]);

    const apiVersion = meta && "apiVersion" in meta ? ((meta as { apiVersion?: string }).apiVersion ?? "") : "";
    const nsForApi = nsParam(selectedNs);

    // Live first: a watch pushes changes the moment they happen. Polling stays
    // wired up underneath and takes over whenever the socket cannot serve this
    // table — a kind with no watch verb, a dropped connection, or pause.
    const stream = useLiveList(kind, nsForApi);
    const polled = usePolled(
        () => api.list({ context, kind, ns: nsForApi }),
        [context, kind, nsForApi],
        { enabled: Boolean(context && kind) && !stream.streaming },
    );
    const { data, error, initial, loading } = useEither(stream.data, stream.streaming, polled);

    // Clear selection when the subject changes; a checked box that survives a
    // kind switch is a bulk delete waiting to happen. The filter is NOT cleared
    // here — it lives in the URL, so back/forward must be able to restore it.
    useEffect(() => {
        setSelected(new Set());
    }, [kind, context]);

    const rows = useMemo(() => {
        if (!data) return [];
        let out = data.rows;
        if (selectedNs.length > 1) {
            const set = new Set(selectedNs);
            out = out.filter((r) => set.has(r.ns ?? ""));
        }
        const needle = q.trim().toLowerCase();
        if (needle) {
            out = out.filter(
                (r) =>
                    r.name.toLowerCase().includes(needle) ||
                    (r.ns ?? "").toLowerCase().includes(needle) ||
                    r.cells.some((c) => c.toLowerCase().includes(needle)),
            );
        }
        return out;
    }, [data, q, selectedNs]);

    const refOf = (row: Row): ResourceRef => ({ kind, name: row.name, ns: row.ns });
    const selectedRefs = rows.filter((r) => selected.has(rowKey(r))).map(refOf);

    const title = meta?.title ?? kind;

    return (
        <div className="page">
            <div className="toolbar">
                <div className="toolbar-title">
                    <h1>{title}</h1>
                    <span className="count mono">{data ? `${rows.length}${rows.length !== data.rows.length ? ` / ${data.rows.length}` : ""}` : "—"}</span>
                    {apiVersion ? <span className="apiver mono faint">{apiVersion}</span> : null}
                </div>

                <div className="spring" />

                <div className="search list-search">
                    <Icon.Search size={13} />
                    <input
                        placeholder="Filter rows…   /"
                        value={q}
                        data-filter="1"
                        onChange={(e) => void setQ(e.target.value || null)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                void setQ(null);
                                (e.target as HTMLInputElement).blur();
                            }
                        }}
                    />
                </div>
                {data ? <ColumnsMenu columns={data.columns} hidden={hidden} onChange={setHidden} /> : null}
            </div>

            {/* The hairline is the second half of the refresh acknowledgement:
                the icon spins up here, and the table says it is working. */}
            {(loading && !initial) || refreshing ? (
                <div className="hairline" />
            ) : (
                <div style={{ height: 2, flex: "0 0 auto" }} />
            )}

            {selected.size > 0 ? (
                <div className="bulkbar">
                    <strong className="mono">{selected.size}</strong> selected
                    <button className="btn sm ghost" type="button" onClick={() => setSelected(new Set())}>
                        Clear
                    </button>
                    <div className="spring" />
                    <button
                        className="btn sm danger"
                        type="button"
                        onClick={() => confirmDelete(selectedRefs, title)}
                    >
                        <Icon.Trash size={12} /> Delete {selected.size}
                    </button>
                </div>
            ) : null}

            {error ? <ErrorBox error={error} /> : null}

            {initial && !data ? (
                <div className="page-loading">
                    <span className="spinner" /> Loading {title.toLowerCase()}…
                </div>
            ) : data ? (
                <DataGrid
                    columns={data.columns}
                    rows={rows}
                    hiddenColumns={hidden}
                    selected={selected}
                    onSelectedChange={setSelected}
                    onOpen={(row) => navigate({ page: "detail", kind, name: row.name, ns: row.ns })}
                    onOpenRef={(ref) => navigate({ page: "detail", kind: ref.kind, name: ref.name, ns: ref.ns })}
                    rowMenu={(row) => resourceActions(refOf(row), { kind, open: (ref, tab) => onOpen(ref, tab) })}
                    empty={
                        <Empty
                            title={q ? "No row matches the filter" : `No ${title.toLowerCase()} here`}
                            hint={
                                q
                                    ? "Clear the filter to see everything."
                                    : selectedNs.length
                                      ? "Try selecting all namespaces in the top bar."
                                      : "Nothing of this kind exists in the cluster."
                            }
                        />
                    }
                />
            ) : null}
        </div>
    );
}

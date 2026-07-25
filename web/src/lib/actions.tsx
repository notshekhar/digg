/**
 * Day-2 actions: the menus, the dialogs, and the one function that runs them.
 *
 * Two rules hold everything together:
 *
 *   1. THE SAME ACTION IS THE SAME EVERYWHERE. A right-click in the grid, a
 *      button in the detail drawer and the command palette all call
 *      `resourceActions()`, so a pod is scaled, restarted or deleted by exactly
 *      one code path with exactly one confirmation.
 *   2. IRREVERSIBLE MEANS TYPE THE NAME. Delete and drain ask for the object's
 *      name; scale, restart, suspend and rollback take a plain confirm. Asking
 *      for typed confirmation everywhere would teach people to type without
 *      reading, which is how a guard stops guarding.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { getState, refreshNow, openTerminal, setDock, setState, toast } from "./store.ts";
import type { MenuItem } from "../components/ui.tsx";
import { Confirm, Modal } from "../components/ui.tsx";
import type { ResourceRef } from "./types.ts";

// ── pending-dialog store ───────────────────────────────────────────────────

type Dialog =
    | { type: "delete"; refs: ResourceRef[]; kindTitle: string }
    | { type: "scale"; ref: ResourceRef; current: number }
    | { type: "confirm"; title: string; body: string; label: string; danger?: boolean; run: () => Promise<string> }
    | { type: "forward"; ref: ResourceRef; ports: number[] }
    | { type: "rollback"; ref: ResourceRef };

let dialog: Dialog | null = null;
const listeners = new Set<() => void>();

function setDialog(next: Dialog | null) {
    dialog = next;
    for (const l of listeners) l();
}

function useDialog(): Dialog | null {
    return useSyncExternalStore(
        (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        () => dialog,
        () => null,
    );
}

// ── runner ─────────────────────────────────────────────────────────────────

export async function act(body: Record<string, unknown>, pending?: string): Promise<boolean> {
    const context = getState().context;
    try {
        const result = await api.action({ context, ...body });
        if (result.ok) {
            toast("ok", result.message || pending || "done");
            refreshNow();
            return true;
        }
        toast("bad", result.message, result.results?.filter((r) => !r.ok).map((r) => `${r.target}: ${r.message}`).join("\n"));
        return false;
    } catch (err) {
        toast("bad", "Action failed", err instanceof Error ? err.message : String(err));
        return false;
    }
}

// ── menu construction ──────────────────────────────────────────────────────

const SCALABLE = new Set(["deployments", "statefulsets", "replicasets", "replicationcontrollers"]);
const RESTARTABLE = new Set(["deployments", "statefulsets", "daemonsets"]);
const LOGGABLE = new Set(["pods", "deployments", "statefulsets", "daemonsets", "jobs", "replicasets"]);
const FORWARDABLE = new Set(["pods", "services", "deployments", "statefulsets"]);

export interface ActionContext {
    kind: string;
    /** Called when the caller wants a drawer tab opened (yaml, logs, events). */
    open?: (ref: ResourceRef, tab: string) => void;
}

export function resourceActions(ref: ResourceRef, ctx: ActionContext): (MenuItem | "-")[] {
    const kind = ctx.kind;
    const items: (MenuItem | "-")[] = [];
    const open = (tab: string) => () => ctx.open?.(ref, tab);

    items.push({ id: "open", label: "Open", onSelect: open("overview") });
    items.push({ id: "yaml", label: "Edit YAML", onSelect: open("yaml") });
    items.push({ id: "describe", label: "Describe", onSelect: open("describe") });
    items.push({ id: "events", label: "Events", onSelect: open("events") });

    if (LOGGABLE.has(kind)) {
        items.push("-");
        items.push({ id: "logs", label: "Logs", onSelect: open("logs") });
    }

    if (kind === "pods" && getState().canExec) {
        items.push({
            id: "shell",
            label: "Shell",
            hint: "s",
            onSelect: () =>
                openTerminal({
                    kind: "container",
                    title: ref.name,
                    context: getState().context,
                    ns: ref.ns,
                    pod: ref.name,
                }),
        });
    }
    if (kind === "nodes" && getState().canExec) {
        items.push("-");
        items.push({
            id: "nodeshell",
            label: "Node shell",
            onSelect: () => openTerminal({ kind: "node", title: ref.name, context: getState().context, node: ref.name }),
        });
    }

    if (FORWARDABLE.has(kind)) {
        items.push({
            id: "forward",
            label: "Port-forward…",
            hint: "f",
            onSelect: () => setDialog({ type: "forward", ref, ports: [] }),
        });
    }

    if (SCALABLE.has(kind) || RESTARTABLE.has(kind)) items.push("-");
    if (SCALABLE.has(kind)) {
        items.push({ id: "scale", label: "Scale…", onSelect: () => setDialog({ type: "scale", ref, current: 1 }) });
    }
    if (RESTARTABLE.has(kind)) {
        items.push({
            id: "restart",
            label: "Restart rollout",
            hint: "T",
            onSelect: () =>
                setDialog({
                    type: "confirm",
                    title: "Restart rollout",
                    body: `Every pod of ${ref.name} will be replaced, one batch at a time.`,
                    label: "Restart",
                    run: async () => {
                        await act({ action: "restart", ref });
                        return "";
                    },
                }),
        });
        items.push({ id: "rollback", label: "Rollback…", onSelect: () => setDialog({ type: "rollback", ref }) });
    }

    if (kind === "cronjobs") {
        items.push("-");
        items.push({
            id: "suspend",
            label: "Suspend / resume",
            onSelect: () =>
                setDialog({
                    type: "confirm",
                    title: "Toggle suspend",
                    body: `Flip the suspend flag on ${ref.name}. A suspended CronJob creates no new Jobs.`,
                    label: "Toggle",
                    run: async () => {
                        // The current value is not in the row, so ask the object.
                        const detail = await api.detail({ context: getState().context, kind: "cronjobs", name: ref.name, ns: ref.ns });
                        const suspended = detail.summary.some(([k, v]) => k.toLowerCase() === "suspend" && v === "true");
                        await act({ action: suspended ? "resume" : "suspend", ref });
                        return "";
                    },
                }),
        });
        items.push({
            id: "trigger",
            label: "Trigger now",
            hint: "t",
            onSelect: () =>
                setDialog({
                    type: "confirm",
                    title: "Trigger CronJob",
                    body: `Create a Job from ${ref.name} right now.`,
                    label: "Trigger",
                    run: async () => {
                        await act({ action: "trigger", ref });
                        return "";
                    },
                }),
        });
    }

    if (kind === "nodes") {
        items.push({
            id: "cordon",
            label: "Cordon",
            onSelect: () =>
                setDialog({
                    type: "confirm",
                    title: "Cordon node",
                    body: `${ref.name} will stop accepting new pods. Running pods stay put.`,
                    label: "Cordon",
                    run: async () => {
                        await act({ action: "cordon", node: ref.name });
                        return "";
                    },
                }),
        });
        items.push({
            id: "uncordon",
            label: "Uncordon",
            onSelect: () =>
                setDialog({
                    type: "confirm",
                    title: "Uncordon node",
                    body: `${ref.name} will accept pods again.`,
                    label: "Uncordon",
                    run: async () => {
                        await act({ action: "uncordon", node: ref.name });
                        return "";
                    },
                }),
        });
        items.push({
            id: "drain",
            label: "Drain…",
            danger: true,
            onSelect: () =>
                setDialog({
                    type: "confirm",
                    title: "Drain node",
                    body: `Every pod on ${ref.name} will be evicted and rescheduled elsewhere. DaemonSet pods are left alone. This can take a while and can disrupt workloads with no room to move.`,
                    label: "Drain",
                    danger: true,
                    run: async () => {
                        await act({ action: "drain", node: ref.name });
                        return "";
                    },
                }),
        });
    }

    items.push("-");
    items.push({
        id: "delete",
        label: "Delete…",
        hint: "X",
        danger: true,
        onSelect: () => setDialog({ type: "delete", refs: [ref], kindTitle: kind }),
    });

    return items;
}

export function confirmDelete(refs: ResourceRef[], kindTitle: string): void {
    setDialog({ type: "delete", refs, kindTitle });
}

export function openScale(ref: ResourceRef, current: number): void {
    setDialog({ type: "scale", ref, current });
}

export function openForward(ref: ResourceRef, ports: number[]): void {
    setDialog({ type: "forward", ref, ports });
}

// ── dialog host ────────────────────────────────────────────────────────────

export function ActionDialogs() {
    const d = useDialog();
    const [busy, setBusy] = useState(false);
    if (!d) return null;
    const close = () => {
        setBusy(false);
        setDialog(null);
    };

    if (d.type === "delete") {
        const one = d.refs.length === 1 ? d.refs[0]! : null;
        return (
            <Confirm
                danger
                busy={busy}
                title={one ? `Delete ${one.name}?` : `Delete ${d.refs.length} objects?`}
                confirmLabel="Delete"
                confirmText={one ? one.name : undefined}
                body={
                    one ? (
                        <>
                            This deletes <strong>{one.name}</strong>
                            {one.ns ? (
                                <>
                                    {" "}
                                    in <strong>{one.ns}</strong>
                                </>
                            ) : null}
                            . If a controller owns it, it will be recreated; if not, it is gone.
                        </>
                    ) : (
                        <>
                            {d.refs.length} objects will be deleted:
                            <ul className="dialog-list mono">
                                {d.refs.slice(0, 12).map((r) => (
                                    <li key={`${r.ns}/${r.name}`}>{r.ns ? `${r.ns}/${r.name}` : r.name}</li>
                                ))}
                                {d.refs.length > 12 ? <li>+{d.refs.length - 12} more</li> : null}
                            </ul>
                        </>
                    )
                }
                onCancel={close}
                onConfirm={async () => {
                    setBusy(true);
                    await act({ action: "delete", refs: d.refs.map((r) => ({ kind: r.kind, name: r.name, ns: r.ns })) });
                    close();
                }}
            />
        );
    }

    if (d.type === "scale") return <ScaleDialog ref_={d.ref} current={d.current} onClose={close} />;
    if (d.type === "forward") return <ForwardDialog ref_={d.ref} ports={d.ports} onClose={close} />;
    if (d.type === "rollback") return <RollbackDialog ref_={d.ref} onClose={close} />;

    return (
        <Confirm
            busy={busy}
            danger={d.danger}
            title={d.title}
            body={d.body}
            confirmLabel={d.label}
            onCancel={close}
            onConfirm={async () => {
                setBusy(true);
                await d.run();
                close();
            }}
        />
    );
}

function ScaleDialog({ ref_, current, onClose }: { ref_: ResourceRef; current: number; onClose: () => void }) {
    const [value, setValue] = useState(String(current));
    const [busy, setBusy] = useState(false);
    const n = Number(value);
    const valid = Number.isInteger(n) && n >= 0 && n <= 1000;
    return (
        <Modal
            title={`Scale ${ref_.name}`}
            onClose={onClose}
            footer={
                <>
                    <button className="btn" type="button" onClick={onClose} disabled={busy}>
                        Cancel
                    </button>
                    <button
                        className="btn primary"
                        type="button"
                        disabled={!valid || busy}
                        onClick={async () => {
                            setBusy(true);
                            await act({ action: "scale", ref: ref_, replicas: n });
                            onClose();
                        }}
                    >
                        {busy ? "Scaling…" : "Scale"}
                    </button>
                </>
            }
        >
            <div className="field-row">
                <label htmlFor="replicas">Replicas</label>
                <input
                    id="replicas"
                    className="input mono"
                    autoFocus
                    value={value}
                    inputMode="numeric"
                    onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
                    onKeyDown={async (e) => {
                        if (e.key === "Enter" && valid) {
                            setBusy(true);
                            await act({ action: "scale", ref: ref_, replicas: n });
                            onClose();
                        }
                    }}
                />
            </div>
            <p className="dialog-note">Scaling to 0 stops the workload without deleting it.</p>
        </Modal>
    );
}

/**
 * Ports a resource actually listens on, read from the "Ports" row of its
 * detail summary.
 *
 * Only that row: scanning the whole summary for numbers finds the octets of a
 * cluster IP and offers 10 and 145 as ports. Service rows read
 * "http:8080→80/TCP" and the forwardable port is the one BEFORE the arrow —
 * `kubectl port-forward svc/x` takes the service port, not the target port.
 */
export function minePorts(summary: [string, string][]): number[] {
    const row = summary.find(([k]) => k.toLowerCase() === "ports" || k.toLowerCase() === "port");
    if (!row) return [];
    const out: number[] = [];
    for (const part of row[1].split(",")) {
        const beforeArrow = part.split(/→|->/)[0] ?? part;
        const nums = [...beforeArrow.matchAll(/(\d{1,5})/g)].map((m) => Number(m[1]));
        const port = nums[nums.length - 1];
        if (port && port > 0 && port < 65536 && !out.includes(port)) out.push(port);
    }
    return out.slice(0, 8);
}

function ForwardDialog({ ref_, ports, onClose }: { ref_: ResourceRef; ports: number[]; onClose: () => void }) {
    const [known, setKnown] = useState<number[]>(ports);
    const [remote, setRemote] = useState(ports[0] ? String(ports[0]) : "");
    const [local, setLocal] = useState("");
    const [busy, setBusy] = useState(false);
    const remoteN = Number(remote);
    const valid = Number.isInteger(remoteN) && remoteN > 0 && remoteN < 65536;

    // Opened from a row, we know nothing about the object yet — ask, so the
    // dialog offers real ports instead of a guess the user has to correct.
    useEffect(() => {
        if (ports.length) return;
        let live = true;
        void api
            .detail({ context: getState().context, kind: ref_.kind, name: ref_.name, ns: ref_.ns })
            .then((d) => {
                if (!live) return;
                const found = minePorts(d.summary);
                setKnown(found);
                setRemote((r) => (r === "" && found[0] ? String(found[0]) : r));
            })
            .catch(() => {
                /* the object may be gone; the field stays free-form */
            });
        return () => {
            live = false;
        };
    }, [ports.length, ref_.kind, ref_.name, ref_.ns]);

    const start = async () => {
        setBusy(true);
        try {
            const { forward } = await api.startForward({
                context: getState().context,
                kind: ref_.kind,
                name: ref_.name,
                ns: ref_.ns,
                remotePort: remoteN,
                localPort: Number(local) || 0,
            });
            setState((s) => ({ forwards: [...s.forwards.filter((f) => f.id !== forward.id), forward] }));
            if (forward.status === "failed") {
                toast("bad", "Port-forward failed", forward.error);
            } else {
                toast("ok", `Forwarding ${forward.localPort ?? "?"} → ${forward.remotePort}`, forward.url ?? undefined);
                // Show the thing that is now running: a forward with no visible
                // home is one people forget and leave holding a port.
                setDock({ open: true, tab: "forwards" });
            }
        } catch (err) {
            toast("bad", "Port-forward failed", err instanceof Error ? err.message : String(err));
        }
        onClose();
    };

    return (
        <Modal
            title={`Port-forward ${ref_.name}`}
            onClose={onClose}
            footer={
                <>
                    <button className="btn" type="button" onClick={onClose} disabled={busy}>
                        Cancel
                    </button>
                    <button className="btn primary" type="button" disabled={!valid || busy} onClick={() => void start()}>
                        {busy ? "Starting…" : "Start"}
                    </button>
                </>
            }
        >
            <div className="field-row">
                <label htmlFor="remote">Container port</label>
                <input
                    id="remote"
                    className="input mono"
                    autoFocus
                    value={remote}
                    onChange={(e) => setRemote(e.target.value.replace(/[^\d]/g, ""))}
                />
            </div>
            {known.length > 0 ? (
                <div className="chiprow">
                    {known.map((p) => (
                        <button key={p} type="button" className="btn sm" onClick={() => setRemote(String(p))}>
                            {p}
                        </button>
                    ))}
                </div>
            ) : null}
            <div className="field-row">
                <label htmlFor="local">Local port</label>
                <input
                    id="local"
                    className="input mono"
                    placeholder="auto"
                    value={local}
                    onChange={(e) => setLocal(e.target.value.replace(/[^\d]/g, ""))}
                />
            </div>
            <p className="dialog-note">Leave local blank to let the OS pick a free port. Forwards keep running until you stop them.</p>
        </Modal>
    );
}

function RollbackDialog({ ref_, onClose }: { ref_: ResourceRef; onClose: () => void }) {
    const [revisions, setRevisions] = useState<{ revision: string; change: string }[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        void api
            .history({ context: getState().context, kind: ref_.kind, name: ref_.name, ns: ref_.ns })
            .then((r) => live && setRevisions(r.revisions))
            .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
        return () => {
            live = false;
        };
    }, [ref_.kind, ref_.name, ref_.ns]);

    return (
        <Modal title={`Rollback ${ref_.name}`} onClose={onClose}>
            {error ? <div className="errbox">{error}</div> : null}
            {revisions === null ? (
                <p className="dialog-note">Loading revisions…</p>
            ) : revisions.length === 0 ? (
                <p className="dialog-note">No rollout history for this workload.</p>
            ) : (
                <div className="revlist">
                    {revisions.map((r) => (
                        <div className="revrow" key={r.revision}>
                            <span className="mono rev">#{r.revision}</span>
                            <span className="spring truncate">{r.change || "—"}</span>
                            <button
                                className="btn sm"
                                type="button"
                                disabled={busy}
                                onClick={async () => {
                                    setBusy(true);
                                    await act({ action: "rollback", ref: ref_, revision: r.revision });
                                    onClose();
                                }}
                            >
                                Roll back
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </Modal>
    );
}

/**
 * The ConfigMap / Secret editor.
 *
 * Editing these through raw YAML is hostile: Secret values are base64, so you
 * cannot read what you are changing, and a multi-line value is one bad escape
 * away from corruption. This edits the *values* — decoded, in a textarea, one
 * key at a time — and writes back a JSON merge patch touching only the keys you
 * changed. Nothing else in the object is rewritten, so a save can never clobber
 * a field somebody else edited.
 *
 * Two rules keep it honest:
 *   1. BINARY IS NEVER EDITED. A value that is not clean UTF-8 (a TLS key, a
 *      gzipped blob) shows its size and stays read-only — editing it as text
 *      would silently corrupt it on save.
 *   2. SECRETS ARE MASKED UNTIL ASKED FOR. The value is on screen only when you
 *      reveal or edit it, because these pages get screen-shared.
 */

import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/icons.tsx";
import { Badge, Confirm, CopyButton, Empty, ErrorBox, Modal } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { act } from "../lib/actions.tsx";
import { usePolled } from "../lib/hooks.ts";
import { getState } from "../lib/store.ts";
import type { ResourceRef } from "../lib/types.ts";
import "./DataTab.css";

interface Entry {
    key: string;
    text: string;
    binary: boolean;
    bytes: number;
}

function sizeOf(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KiB`;
    return `${Math.round(n / (1024 * 102.4)) / 10} MiB`;
}

export function DataTab({ target }: { target: ResourceRef }) {
    const context = getState().context;
    const { data, error } = usePolled(
        () => api.data({ context, kind: target.kind, name: target.name, ns: target.ns }),
        [context, target.kind, target.name, target.ns],
    );

    /** Edits by key. Absent means untouched; a string means changed. */
    const [edits, setEdits] = useState<Record<string, string>>({});
    const [removed, setRemoved] = useState<string[]>([]);
    const [open, setOpen] = useState<Set<string>>(new Set());
    const [revealed, setRevealed] = useState<Set<string>>(new Set());
    const [adding, setAdding] = useState(false);
    const [confirmKey, setConfirmKey] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const isSecret = data?.encoded ?? target.kind === "secrets";
    const entries: Entry[] = data?.entries ?? [];
    const immutable = data?.immutable ?? false;

    // A refresh landing mid-edit must not wipe what you typed, so edits are
    // only cleared when the object itself changes or a save succeeds.
    useEffect(() => {
        setEdits({});
        setRemoved([]);
        setOpen(new Set());
        setRevealed(new Set());
    }, [target.kind, target.name, target.ns, context]);

    const dirty = useMemo(
        () => Object.keys(edits).length + removed.length,
        [edits, removed],
    );

    if (error) return <ErrorBox error={error} />;
    if (!data) {
        return (
            <div className="page-loading">
                <span className="spinner" /> Reading data…
            </div>
        );
    }

    const save = async () => {
        setBusy(true);
        const ok = await act({
            action: "setData",
            ref: { kind: target.kind, name: target.name, ns: target.ns },
            set: edits,
            remove: removed,
        });
        setBusy(false);
        if (ok) {
            setEdits({});
            setRemoved([]);
        }
    };

    const visible = entries.filter((e) => !removed.includes(e.key));

    return (
        <div className="datatab">
            <div className="data-bar">
                {immutable ? (
                    <Badge tone="warn">immutable — the API server will reject edits</Badge>
                ) : (
                    <span className="faint">
                        {isSecret ? "Values are decoded here and re-encoded on save." : "Plain values."}
                    </span>
                )}
                <div className="spring" />
                {isSecret && visible.some((e) => !e.binary) ? (
                    <button
                        className="btn sm"
                        type="button"
                        aria-pressed={revealed.size > 0}
                        onClick={() =>
                            setRevealed((r) => (r.size > 0 ? new Set() : new Set(visible.map((e) => e.key))))
                        }
                    >
                        {revealed.size > 0 ? "Hide values" : "Reveal values"}
                    </button>
                ) : null}
                <button className="btn sm" type="button" disabled={immutable} onClick={() => setAdding(true)}>
                    <Icon.Plus size={12} /> Add key
                </button>
                <button
                    className="btn sm"
                    type="button"
                    disabled={!dirty || busy}
                    onClick={() => {
                        setEdits({});
                        setRemoved([]);
                    }}
                >
                    Revert
                </button>
                <button className="btn sm primary" type="button" disabled={!dirty || busy} onClick={() => void save()}>
                    {busy ? "Saving…" : dirty ? `Save ${dirty} change${dirty === 1 ? "" : "s"}` : "Save"}
                </button>
            </div>

            {visible.length === 0 && !Object.keys(edits).length ? (
                <Empty title="No data" hint="This object has no keys yet. Add one." />
            ) : (
                <div className="data-list">
                    {visible.map((entry) => {
                        const edited = edits[entry.key];
                        const isOpen = open.has(entry.key);
                        const show = revealed.has(entry.key) || isOpen || !isSecret;
                        const value = edited ?? entry.text;
                        return (
                            <div className={`data-row ${edited !== undefined ? "changed" : ""}`} key={entry.key}>
                                <div className="data-head">
                                    <button
                                        className="data-key mono"
                                        type="button"
                                        disabled={entry.binary}
                                        onClick={() =>
                                            setOpen((o) => {
                                                const next = new Set(o);
                                                if (next.has(entry.key)) next.delete(entry.key);
                                                else next.add(entry.key);
                                                return next;
                                            })
                                        }
                                    >
                                        <span className={`caret ${isOpen ? "open" : ""}`}>
                                            <Icon.Chevron size={10} />
                                        </span>
                                        {entry.key}
                                    </button>
                                    <span className="faint mono size">{sizeOf(entry.bytes)}</span>
                                    {entry.binary ? <Badge tone="idle">binary</Badge> : null}
                                    {edited !== undefined ? <Badge tone="warn">edited</Badge> : null}
                                    <div className="spring" />
                                    {!entry.binary ? <CopyButton text={value} label="" /> : null}
                                    {isSecret && !entry.binary ? (
                                        <button
                                            className="btn sm ghost"
                                            type="button"
                                            title={show ? "Hide" : "Reveal"}
                                            onClick={() =>
                                                setRevealed((r) => {
                                                    const next = new Set(r);
                                                    if (next.has(entry.key)) next.delete(entry.key);
                                                    else next.add(entry.key);
                                                    return next;
                                                })
                                            }
                                        >
                                            {show ? "hide" : "reveal"}
                                        </button>
                                    ) : null}
                                    <button
                                        className="btn sm ghost danger"
                                        type="button"
                                        disabled={immutable}
                                        title="Remove this key"
                                        onClick={() => setConfirmKey(entry.key)}
                                    >
                                        <Icon.Trash size={12} />
                                    </button>
                                </div>

                                {entry.binary ? (
                                    <div className="data-binary faint">
                                        {sizeOf(entry.bytes)} of binary data — not editable as text.
                                    </div>
                                ) : isOpen ? (
                                    <textarea
                                        className="data-value mono"
                                        spellCheck={false}
                                        value={value}
                                        disabled={immutable}
                                        rows={Math.min(20, Math.max(3, value.split("\n").length + 1))}
                                        onChange={(e) => {
                                            const next = e.target.value;
                                            setEdits((prev) => {
                                                const copy = { ...prev };
                                                // Typing it back to the original is not a change.
                                                if (next === entry.text) delete copy[entry.key];
                                                else copy[entry.key] = next;
                                                return copy;
                                            });
                                        }}
                                    />
                                ) : (
                                    <div className="data-preview mono">
                                        {show ? (
                                            value.split("\n")[0]!.slice(0, 200) || <span className="faint">(empty)</span>
                                        ) : (
                                            <span className="faint">••••••••••••</span>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {adding ? (
                <AddKeyDialog
                    existing={new Set(entries.map((e) => e.key))}
                    onCancel={() => setAdding(false)}
                    onAdd={(key, value) => {
                        setEdits((prev) => ({ ...prev, [key]: value }));
                        setOpen((o) => new Set(o).add(key));
                        setAdding(false);
                    }}
                />
            ) : null}

            {confirmKey ? (
                <Confirm
                    danger
                    title={`Remove ${confirmKey}?`}
                    confirmLabel="Remove"
                    body={
                        <>
                            <strong>{confirmKey}</strong> will be deleted from this{" "}
                            {isSecret ? "Secret" : "ConfigMap"} when you save. Anything mounting it keeps the old value
                            until it restarts.
                        </>
                    }
                    onCancel={() => setConfirmKey(null)}
                    onConfirm={() => {
                        setRemoved((r) => [...r, confirmKey]);
                        setEdits((prev) => {
                            const copy = { ...prev };
                            delete copy[confirmKey];
                            return copy;
                        });
                        setConfirmKey(null);
                    }}
                />
            ) : null}
        </div>
    );
}

function AddKeyDialog({
    existing,
    onCancel,
    onAdd,
}: {
    existing: Set<string>;
    onCancel: () => void;
    onAdd: (key: string, value: string) => void;
}) {
    const [key, setKey] = useState("");
    const [value, setValue] = useState("");
    const bad = key !== "" && !/^[-._a-zA-Z0-9]+$/.test(key);
    const dupe = existing.has(key);
    const ok = key !== "" && !bad && !dupe;

    return (
        <Modal
            title="Add key"
            onClose={onCancel}
            footer={
                <>
                    <button className="btn" type="button" onClick={onCancel}>
                        Cancel
                    </button>
                    <button className="btn primary" type="button" disabled={!ok} onClick={() => onAdd(key, value)}>
                        Add
                    </button>
                </>
            }
        >
            <div className="field-row">
                <label htmlFor="datakey">Key</label>
                <input
                    id="datakey"
                    className="input mono"
                    autoFocus
                    value={key}
                    spellCheck={false}
                    onChange={(e) => setKey(e.target.value)}
                />
                {bad ? <span className="field-err">letters, digits, - . _ only</span> : null}
                {dupe ? <span className="field-err">that key already exists</span> : null}
            </div>
            <div className="field-row">
                <label htmlFor="dataval">Value</label>
                <textarea
                    id="dataval"
                    className="data-value mono"
                    rows={6}
                    spellCheck={false}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                />
            </div>
            <p className="dialog-note">Nothing is written until you press Save.</p>
        </Modal>
    );
}

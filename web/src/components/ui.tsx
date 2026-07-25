/**
 * The component kit. Everything digg draws is in here or in a page — there is
 * no third-party UI library, because a Kubernetes cockpit is mostly bespoke
 * density (27px rows, gauges that admit missing metrics, a dropdown that can
 * hold 400 namespaces) and a generic kit fights all three.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.tsx";
import { useApp, dismissToast } from "../lib/store.ts";
import { useClickOutside } from "../lib/hooks.ts";
import type { Tone } from "../lib/types.ts";
import "./ui.css";

// ── badge / dot ────────────────────────────────────────────────────────────

export function Badge({ tone = "idle", children }: { tone?: Tone | "idle" | "accent" | "info"; children: ReactNode }) {
    const cls = tone === "neutral" ? "idle" : tone;
    return <span className={`badge ${cls}`}>{children}</span>;
}

export function StatusDot({ tone, pulse }: { tone: Tone | "info"; pulse?: boolean }) {
    return <span className={`dot ${tone === "neutral" ? "" : tone} ${pulse ? "pulse" : ""}`} />;
}

// ── meter ──────────────────────────────────────────────────────────────────

/**
 * A usage bar that can say "I don't know".
 *
 * `value === null` means no metrics-server, and the bar renders hatched rather
 * than empty — an empty bar reads as 0%, which is a lie a capacity screen must
 * never tell. The optional `mark` draws requests against the same track, so you
 * can see reservation and real usage at once.
 */
export function Meter({
    value,
    mark,
    tone,
    label,
    sub,
}: {
    value: number | null;
    mark?: number | null;
    tone?: Tone;
    label?: ReactNode;
    sub?: ReactNode;
}) {
    const pct = value === null ? null : Math.max(0, Math.min(100, value));
    const auto: Tone = pct === null ? "neutral" : pct >= 90 ? "bad" : pct >= 75 ? "warn" : "ok";
    const t = tone ?? auto;
    return (
        <div className="meter">
            {(label || sub) && (
                <div className="meter-head">
                    <span className="meter-label">{label}</span>
                    <span className="meter-sub mono">{sub}</span>
                </div>
            )}
            <div className={`meter-track ${pct === null ? "unknown" : ""}`}>
                {pct !== null && <div className={`meter-fill ${t}`} style={{ width: `${pct}%` }} />}
                {mark !== null && mark !== undefined && mark > 0 && (
                    <div className="meter-mark" style={{ left: `${Math.min(100, mark)}%` }} title="requested" />
                )}
            </div>
        </div>
    );
}

// ── stat tile ──────────────────────────────────────────────────────────────

export function Stat({
    label,
    value,
    sub,
    tone,
    onClick,
}: {
    label: string;
    value: ReactNode;
    sub?: ReactNode;
    tone?: Tone;
    onClick?: () => void;
}) {
    const Tag = onClick ? "button" : "div";
    return (
        <Tag className={`stat ${onClick ? "clickable" : ""} ${tone ?? ""}`} onClick={onClick} type={onClick ? "button" : undefined}>
            <div className="stat-label eyebrow">{label}</div>
            <div className="stat-value mono">{value}</div>
            {sub ? <div className="stat-sub">{sub}</div> : null}
        </Tag>
    );
}

// ── panel ──────────────────────────────────────────────────────────────────

export function Panel({
    title,
    actions,
    children,
    scroll,
    flush,
}: {
    title?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
    scroll?: boolean;
    flush?: boolean;
}) {
    return (
        <section className="panel">
            {(title || actions) && (
                <header className="panel-head">
                    <h3>{title}</h3>
                    <div className="spring" />
                    {actions}
                </header>
            )}
            <div className={`panel-body ${scroll ? "scroll" : ""} ${flush ? "flush" : ""}`}>{children}</div>
        </section>
    );
}

// ── tabs ───────────────────────────────────────────────────────────────────

export function Tabs({
    tabs,
    active,
    onChange,
}: {
    tabs: { id: string; label: ReactNode; badge?: ReactNode }[];
    active: string;
    onChange: (id: string) => void;
}) {
    return (
        <div className="tabs" role="tablist">
            {tabs.map((t) => (
                <button
                    key={t.id}
                    role="tab"
                    type="button"
                    aria-selected={t.id === active}
                    className="tab"
                    onClick={() => onChange(t.id)}
                >
                    {t.label}
                    {t.badge !== undefined && t.badge !== null ? <span className="tab-badge mono">{t.badge}</span> : null}
                </button>
            ))}
        </div>
    );
}

// ── dropdown menu ──────────────────────────────────────────────────────────

export interface MenuItem {
    id: string;
    label: ReactNode;
    hint?: string;
    danger?: boolean;
    disabled?: boolean;
    onSelect: () => void;
}

export function Menu({
    trigger,
    items,
    align = "left",
}: {
    trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
    items: (MenuItem | "-")[];
    align?: "left" | "right";
}) {
    const [open, setOpen] = useState(false);
    const ref = useClickOutside<HTMLDivElement>(() => setOpen(false));
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    return (
        <div className="menu-wrap" ref={ref}>
            {trigger({ open, toggle: () => setOpen((o) => !o) })}
            {open && (
                <div className={`menu ${align}`} role="menu">
                    {items.map((item, i) =>
                        item === "-" ? (
                            <div className="menu-sep" key={`sep${i}`} />
                        ) : (
                            <button
                                key={item.id}
                                type="button"
                                role="menuitem"
                                className={`menu-item ${item.danger ? "danger" : ""}`}
                                disabled={item.disabled}
                                onClick={() => {
                                    setOpen(false);
                                    item.onSelect();
                                }}
                            >
                                <span className="spring">{item.label}</span>
                                {item.hint ? <kbd>{item.hint}</kbd> : null}
                            </button>
                        ),
                    )}
                </div>
            )}
        </div>
    );
}

// ── modal ──────────────────────────────────────────────────────────────────

export function Modal({
    title,
    onClose,
    children,
    footer,
    wide,
}: {
    title: ReactNode;
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
    wide?: boolean;
}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onClose]);

    return createPortal(
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
                <header className="modal-head">
                    <h2>{title}</h2>
                    <div className="spring" />
                    <button className="btn ghost icon" type="button" onClick={onClose} aria-label="Close">
                        <Icon.Close />
                    </button>
                </header>
                <div className="modal-body">{children}</div>
                {footer ? <footer className="modal-foot">{footer}</footer> : null}
            </div>
        </div>,
        document.body,
    );
}

/**
 * Destructive confirmation.
 *
 * `confirmText` demands the object's name be typed. That is reserved for the
 * irreversible ones (delete, drain) — asking for it on every scale would train
 * people to paste without reading, which is how the guard stops working.
 */
export function Confirm({
    title,
    body,
    confirmLabel = "Confirm",
    confirmText,
    danger,
    busy,
    onCancel,
    onConfirm,
}: {
    title: ReactNode;
    body: ReactNode;
    confirmLabel?: string;
    confirmText?: string;
    danger?: boolean;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const [typed, setTyped] = useState("");
    const ok = !confirmText || typed === confirmText;
    return (
        <Modal
            title={title}
            onClose={onCancel}
            footer={
                <>
                    <button className="btn" type="button" onClick={onCancel} disabled={busy}>
                        Cancel
                    </button>
                    <button
                        className={`btn ${danger ? "danger solid" : "primary"}`}
                        type="button"
                        disabled={!ok || busy}
                        onClick={onConfirm}
                    >
                        {busy ? "Working…" : confirmLabel}
                    </button>
                </>
            }
        >
            <div className="confirm-body">{body}</div>
            {confirmText ? (
                <label className="confirm-type">
                    <span>
                        Type <code className="mono">{confirmText}</code> to confirm
                    </span>
                    <input
                        className="input mono"
                        autoFocus
                        value={typed}
                        spellCheck={false}
                        onChange={(e) => setTyped(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && ok) onConfirm();
                        }}
                    />
                </label>
            ) : null}
        </Modal>
    );
}

// ── searchable multi-select (namespaces) ───────────────────────────────────

export function MultiSelect({
    label,
    options,
    selected,
    onChange,
    allLabel = "All namespaces",
    icon,
}: {
    label: string;
    options: string[];
    selected: string[];
    onChange: (next: string[]) => void;
    allLabel?: string;
    icon?: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const ref = useClickOutside<HTMLDivElement>(() => setOpen(false));
    const id = useId();
    const shown = options.filter((o) => o.toLowerCase().includes(q.toLowerCase()));
    const summary = selected.length === 0 ? allLabel : selected.length === 1 ? selected[0]! : `${selected.length} selected`;

    return (
        <div className="picker" ref={ref}>
            <button
                type="button"
                className="picker-trigger"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setOpen((o) => !o)}
                title={`${label}: ${summary}`}
            >
                {icon}
                <span className="picker-label eyebrow">{label}</span>
                <span className="picker-value truncate">{summary}</span>
                <Icon.ChevronDown size={12} />
            </button>
            {open && (
                <div className="picker-pop" id={id}>
                    <div className="search">
                        <Icon.Search size={13} />
                        <input autoFocus placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
                    </div>
                    <div className="picker-list">
                        <button
                            type="button"
                            className={`picker-opt ${selected.length === 0 ? "on" : ""}`}
                            onClick={() => {
                                onChange([]);
                                setOpen(false);
                            }}
                        >
                            <span className="tick">{selected.length === 0 ? <Icon.Check size={12} /> : null}</span>
                            <span className="spring">{allLabel}</span>
                        </button>
                        <div className="menu-sep" />
                        {shown.map((o) => {
                            const on = selected.includes(o);
                            return (
                                <button
                                    key={o}
                                    type="button"
                                    className={`picker-opt ${on ? "on" : ""}`}
                                    onClick={(e) => {
                                        // Plain click selects just this one — the
                                        // common case. mod-click accumulates.
                                        if (e.metaKey || e.ctrlKey) {
                                            onChange(on ? selected.filter((s) => s !== o) : [...selected, o]);
                                        } else {
                                            onChange([o]);
                                            setOpen(false);
                                        }
                                    }}
                                >
                                    <span className="tick">{on ? <Icon.Check size={12} /> : null}</span>
                                    <span className="spring truncate">{o}</span>
                                </button>
                            );
                        })}
                        {shown.length === 0 ? <div className="picker-empty">no match</div> : null}
                    </div>
                    <div className="picker-foot faint">⌘-click to select several</div>
                </div>
            )}
        </div>
    );
}

// ── single select (context) ────────────────────────────────────────────────

export function Select({
    label,
    options,
    value,
    onChange,
    icon,
}: {
    label: string;
    options: string[];
    value: string;
    onChange: (v: string) => void;
    icon?: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const ref = useClickOutside<HTMLDivElement>(() => setOpen(false));
    const shown = options.filter((o) => o.toLowerCase().includes(q.toLowerCase()));
    return (
        <div className="picker" ref={ref}>
            <button type="button" className="picker-trigger" onClick={() => setOpen((o) => !o)} title={`${label}: ${value}`}>
                {icon}
                <span className="picker-label eyebrow">{label}</span>
                <span className="picker-value truncate">{value || "—"}</span>
                <Icon.ChevronDown size={12} />
            </button>
            {open && (
                <div className="picker-pop">
                    {options.length > 8 && (
                        <div className="search">
                            <Icon.Search size={13} />
                            <input autoFocus placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
                        </div>
                    )}
                    <div className="picker-list">
                        {shown.map((o) => (
                            <button
                                key={o}
                                type="button"
                                className={`picker-opt ${o === value ? "on" : ""}`}
                                onClick={() => {
                                    onChange(o);
                                    setOpen(false);
                                }}
                            >
                                <span className="tick">{o === value ? <Icon.Check size={12} /> : null}</span>
                                <span className="spring truncate">{o}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── toasts ─────────────────────────────────────────────────────────────────

export function Toasts() {
    const toasts = useApp((s) => s.toasts);
    if (!toasts.length) return null;
    return createPortal(
        <div className="toasts">
            {toasts.map((t) => (
                <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismissToast(t.id)}>
                    <span className="toast-icon">
                        {t.tone === "ok" ? <Icon.Check size={13} /> : t.tone === "bad" ? <Icon.Warn size={13} /> : <Icon.Info size={13} />}
                    </span>
                    <div className="col">
                        <span>{t.text}</span>
                        {t.detail ? <span className="toast-detail mono">{t.detail}</span> : null}
                    </div>
                </div>
            ))}
        </div>,
        document.body,
    );
}

// ── misc ───────────────────────────────────────────────────────────────────

export function Empty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
    return (
        <div className="empty">
            <div className="title">{title}</div>
            {hint ? <div className="hint">{hint}</div> : null}
            {action}
        </div>
    );
}

export function ErrorBox({ error }: { error: string }) {
    return <div className="errbox">{error}</div>;
}

/** Copy-to-clipboard button that reports success in place. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
    const [done, setDone] = useState(false);
    return (
        <button
            className="btn sm ghost"
            type="button"
            onClick={async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    setDone(true);
                    setTimeout(() => setDone(false), 1200);
                } catch {
                    /* clipboard blocked; the button simply does nothing */
                }
            }}
        >
            {done ? <Icon.Check size={12} /> : <Icon.Copy size={12} />}
            {done ? "Copied" : label}
        </button>
    );
}

/** Key/value grid used by every detail summary. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
    return (
        <dl className="facts">
            {rows.map(([k, v], i) => (
                <div className="fact" key={`${k}-${i}`}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                </div>
            ))}
        </dl>
    );
}

/** Auto-scrolling container that sticks to the bottom while following. */
export function useStickToBottom(deps: unknown[], enabled: boolean) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (!enabled || !ref.current) return;
        ref.current.scrollTop = ref.current.scrollHeight;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, enabled]);
    return ref;
}

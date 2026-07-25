/**
 * The ⌘K palette's shape, for a single question: which cluster, which
 * namespaces.
 *
 * A dropdown is the wrong control once a list is long — you cannot type at it
 * from the keyboard without reaching for the mouse first, and on a cluster with
 * eighty namespaces the scroll is the whole interaction. This is the same
 * centred, search-first box ⌘K uses, so the muscle memory is one thing rather
 * than three.
 *
 * ## The multi-select flow
 *
 * Everything toggles and nothing closes on you. Click a namespace, click
 * another, click one again to drop it; enter and space do the same from the
 * keyboard, and esc closes. There is no separate "apply" because each change
 * applies as you make it — the table behind the box is already showing the set
 * you have built, which is the only preview worth having.
 *
 * The rule that makes it feel right is that a click cannot be a shortcut for
 * "this one only": choosing three namespaces would otherwise mean learning
 * which modifier the third click needs.
 *
 * Selected rows sort to the top while the box is empty, so what you have picked
 * is visible without scrolling for it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.tsx";
import "./Palette.css";

export interface PickerOption {
    value: string;
    /** Second line, e.g. a cluster's server or a namespace's pod count. */
    hint?: string;
}

interface BaseProps {
    title: string;
    placeholder: string;
    options: PickerOption[];
    icon?: React.ReactNode;
    onClose: () => void;
    /** Row for "everything" — namespaces use it, clusters have no such thing. */
    allLabel?: string;
    empty?: string;
}

interface SingleProps extends BaseProps {
    multiple?: false;
    selected: string;
    onPick: (value: string) => void;
}

interface MultiProps extends BaseProps {
    multiple: true;
    selected: string[];
    /** Fired on every change; the caller applies it immediately. */
    onPick: (values: string[]) => void;
}

export function Picker(props: SingleProps | MultiProps) {
    const { title, placeholder, options, icon, onClose, allLabel, empty } = props;
    const multiple = props.multiple === true;
    const selected = useMemo(
        () => (multiple ? new Set(props.selected as string[]) : new Set([props.selected as string])),
        [multiple, props.selected],
    );
    const [q, setQ] = useState("");
    const [cursor, setCursor] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    /**
     * Which rows float to the top — decided when the search changes, NOT when
     * the selection does. Re-sorting on every toggle would slide the next row
     * you meant to click out from under the pointer.
     */
    const [pinned, setPinned] = useState(() => new Set(selected));
    useEffect(() => {
        setPinned(new Set(multiple ? (props.selected as string[]) : [props.selected as string]));
        // Deliberately not on `selected`; see above.
    }, [q]);

    const rows = useMemo(() => {
        const needle = q.trim().toLowerCase();
        const matches = options.filter(
            (o) => !needle || o.value.toLowerCase().includes(needle) || (o.hint ?? "").toLowerCase().includes(needle),
        );
        if (!needle) {
            // What you have chosen belongs where you can see it.
            matches.sort((a, b) => Number(pinned.has(b.value)) - Number(pinned.has(a.value)));
        }
        const out: (PickerOption & { all?: boolean })[] = matches;
        return allLabel && !needle ? [{ value: "", hint: undefined, all: true }, ...out] : out;
    }, [options, q, pinned, allLabel]);

    useEffect(() => setCursor(0), [q]);

    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
    }, [cursor]);

    /**
     * Single-select — a cluster — answers the question and is done. Multi-select
     * adds or removes and stays open; the "all" row is how you get back to
     * nothing selected.
     */
    const choose = (row: { value: string; all?: boolean }) => {
        if (!multiple) {
            (props.onPick as (v: string) => void)(row.value);
            onClose();
            return;
        }
        if (row.all) {
            (props.onPick as (v: string[]) => void)([]);
            return;
        }
        const next = new Set(props.selected as string[]);
        if (next.has(row.value)) next.delete(row.value);
        else next.add(row.value);
        (props.onPick as (v: string[]) => void)([...next]);
    };

    const count = multiple ? (props.selected as string[]).length : 0;

    return createPortal(
        <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className="palette picker-palette" role="dialog" aria-modal="true" aria-label={title}>
                <div className="palette-input">
                    {icon ?? <Icon.Search size={15} />}
                    <input
                        autoFocus
                        placeholder={placeholder}
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        onKeyDown={(e) => {
                            const row = rows[cursor];
                            if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
                                e.preventDefault();
                                setCursor((c) => Math.min(rows.length - 1, c + 1));
                            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
                                e.preventDefault();
                                setCursor((c) => Math.max(0, c - 1));
                            } else if (e.key === "Enter") {
                                e.preventDefault();
                                if (row) choose(row);
                            } else if (e.key === " " && multiple) {
                                // Safe to claim: a namespace is a DNS label and
                                // a context name with a space in it is not a
                                // thing anyone has to search for by space.
                                e.preventDefault();
                                if (row) choose(row);
                            } else if (e.key === "Escape") {
                                e.preventDefault();
                                onClose();
                            }
                        }}
                    />
                    {count > 1 ? <span className="picker-count mono">{count}</span> : null}
                </div>

                <div className="palette-list" ref={listRef}>
                    {rows.length === 0 ? (
                        <div className="palette-empty faint">{empty ?? `nothing matches “${q}”`}</div>
                    ) : (
                        rows.map((row, i) => {
                            const on = row.all ? count === 0 && multiple : selected.has(row.value);
                            return (
                                <button
                                    key={row.all ? "__all__" : row.value}
                                    type="button"
                                    data-index={i}
                                    className={`palette-item ${i === cursor ? "on" : ""} ${on ? "picked" : ""}`}
                                    onMouseEnter={() => setCursor(i)}
                                    onClick={() => choose(row)}
                                >
                                    <span className="pi-icon">
                                        {on ? <Icon.Check size={13} /> : <span className="pi-dot" />}
                                    </span>
                                    <span className="spring truncate">{row.all ? allLabel : row.value}</span>
                                    {row.hint ? <span className="faint truncate picker-hint">{row.hint}</span> : null}
                                </button>
                            );
                        })
                    )}
                </div>

                <div className="palette-foot faint">
                    {multiple ? (
                        <>
                            <kbd>click</kbd> <kbd>space</kbd> add or remove <kbd>esc</kbd> done
                        </>
                    ) : (
                        <>
                            <kbd>enter</kbd> switch <kbd>esc</kbd> cancel
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}

/**
 * YAML editor built on CodeMirror 6, themed to match the rest of digg.
 *
 * Applying a manifest is the most dangerous button in the product, so the
 * editor is explicit about state: the tab shows a dot while the buffer differs
 * from the cluster, ⌘S applies, and a refresh that arrives while you are typing
 * never overwrites your buffer — the live object is only re-read when the
 * buffer is clean.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection,
    dropCursor,
    rectangularSelection,
    crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting, indentUnit, foldGutter, bracketMatching } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { yaml } from "@codemirror/lang-yaml";
import "./YamlEditor.css";

/**
 * Colours come from CSS variables so the editor follows the app theme.
 *
 * `dark` is not cosmetic here: CodeMirror's own base theme sets
 * `caret-color: black` unless it is told the editor is dark, which on our
 * background is an invisible cursor. The flag cannot be baked in either, since
 * the theme toggles at runtime — hence the compartment below.
 */
const themeSpec = {
    "&": { backgroundColor: "transparent", color: "var(--fg)", height: "100%", fontSize: "12.5px" },
    ".cm-content": {
        fontFamily: "var(--mono)",
        padding: "8px 0 40px",
        // The fallback for the drawn cursor: with a real selection layer this
        // is rarely seen, but a dropped/native caret must never be black.
        caretColor: "var(--accent)",
    },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55", overflow: "auto" },
    ".cm-gutters": {
        backgroundColor: "var(--bg-sunk)",
        color: "var(--fg-faint)",
        border: "none",
        borderRight: "1px solid var(--line-soft)",
        fontFamily: "var(--mono)",
    },
    ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--bg-hover)", color: "var(--fg-muted)" },

    // The cursor is drawn by drawSelection(), so it is a real element we can
    // make thick enough to find on a dark background — a 1px native caret in a
    // 12.5px mono face is not.
    ".cm-cursor, .cm-dropCursor": {
        borderLeft: "2px solid var(--accent)",
        marginLeft: "-1px",
    },
    "&.cm-focused .cm-cursor": { animation: "cm-blink 1.06s steps(1) infinite" },
    "@keyframes cm-blink": { "0%, 49%": { opacity: 1 }, "50%, 100%": { opacity: 0 } },

    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--accent-soft)",
    },
    ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
    ".cm-searchMatch": { backgroundColor: "var(--warn-soft)", outline: "1px solid var(--warn)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
    ".cm-panels": { backgroundColor: "var(--bg-sunk)", color: "var(--fg)", borderTop: "1px solid var(--line)" },
    ".cm-panel input, .cm-panel button": {
        backgroundColor: "var(--bg-elev)",
        color: "var(--fg)",
        border: "1px solid var(--line)",
        borderRadius: 0,
    },

    // Fold markers. The defaults are a bare chevron in a 9px column with a 1px
    // hit area — technically present, practically unclickable and easy to
    // mistake for punctuation. Give them room, a resting state that reads as
    // faint, and a hover that says they are controls.
    //
    // Only colour and width are touched here: CodeMirror lays the gutter
    // elements out itself and sizes them against the line, so overriding their
    // `display` collapses them to zero height and the marker stops being
    // clickable at all.
    ".cm-foldGutter": { minWidth: "16px" },
    ".cm-foldGutter .cm-gutterElement": {
        padding: "0 2px",
        cursor: "pointer",
        color: "var(--fg-faint)",
        opacity: "0.5",
        transition: "opacity 90ms ease, color 90ms ease",
    },
    ".cm-foldGutter .cm-gutterElement:hover": { opacity: "1", color: "var(--accent)" },
    ".cm-foldPlaceholder": {
        backgroundColor: "var(--accent-soft)",
        border: "1px solid var(--line)",
        borderRadius: "3px",
        color: "var(--fg-muted)",
        margin: "0 2px",
        padding: "0 6px",
    },
} as const;

const lightTheme = EditorView.theme(themeSpec, { dark: false });
const darkTheme = EditorView.theme(themeSpec, { dark: true });
const themeCompartment = new Compartment();

const isDark = () => document.documentElement.dataset.theme !== "light";

const diggHighlight = HighlightStyle.define([
    { tag: [t.definition(t.propertyName), t.propertyName], color: "var(--accent)" },
    { tag: [t.string, t.special(t.string)], color: "var(--ok)" },
    { tag: [t.number, t.bool, t.null], color: "var(--warn)" },
    { tag: t.comment, color: "var(--fg-faint)", fontStyle: "italic" },
    { tag: [t.keyword, t.operator], color: "var(--info)" },
    { tag: t.meta, color: "var(--fg-muted)" },
    { tag: t.invalid, color: "var(--bad)" },
]);

export function YamlEditor({
    value,
    readOnly,
    onChange,
    onSave,
}: {
    value: string;
    readOnly?: boolean;
    onChange?: (next: string) => void;
    onSave?: () => void;
}) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const saveRef = useRef(onSave);
    saveRef.current = onSave;
    const changeRef = useRef(onChange);
    changeRef.current = onChange;

    const extensions = useMemo<Extension[]>(
        () => [
            lineNumbers(),
            foldGutter({
                // The defaults are "⌄" and "›", which differ in weight and
                // sit at different optical heights. One glyph rotated reads as
                // one control in two states.
                markerDOM: (open) => {
                    const el = document.createElement("span");
                    el.className = `cm-foldMarker${open ? "" : " cm-foldMarker-closed"}`;
                    el.textContent = "▾";
                    el.title = open ? "Fold this block" : "Unfold this block";
                    return el;
                },
            }),
            history(),
            bracketMatching(),
            // Without drawSelection the cursor and selection are the browser's
            // own, which means every .cm-cursor/.cm-selectionBackground rule
            // below is dead CSS and the caret is whatever the base theme says.
            drawSelection(),
            dropCursor(),
            rectangularSelection(),
            crosshairCursor(),
            highlightActiveLine(),
            highlightActiveLineGutter(),
            highlightSelectionMatches(),
            search({ top: true }),
            indentUnit.of("  "),
            yaml(),
            syntaxHighlighting(diggHighlight),
            themeCompartment.of(isDark() ? darkTheme : lightTheme),
            EditorView.lineWrapping,
            keymap.of([
                {
                    key: "Mod-s",
                    preventDefault: true,
                    run: () => {
                        saveRef.current?.();
                        return true;
                    },
                },
                ...defaultKeymap,
                ...historyKeymap,
                ...searchKeymap,
                indentWithTab,
            ]),
            EditorView.updateListener.of((u) => {
                if (u.docChanged) changeRef.current?.(u.state.doc.toString());
            }),
        ],
        [],
    );

    useEffect(() => {
        if (!host.current) return;
        const state = EditorState.create({
            doc: value,
            extensions: [...extensions, EditorState.readOnly.of(Boolean(readOnly)), EditorView.editable.of(!readOnly)],
        });
        const v = new EditorView({ state, parent: host.current });
        view.current = v;
        return () => {
            v.destroy();
            view.current = null;
        };
        // The document is pushed in by the effect below; recreating the view on
        // every keystroke would lose the cursor.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [readOnly]);

    useEffect(() => {
        const v = view.current;
        if (!v) return;
        if (v.state.doc.toString() === value) return;
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }, [value]);

    // The theme toggles at runtime from three places (the top bar, the palette,
    // and boot), all of which just set data-theme. Watching the attribute keeps
    // the editor in step without threading a prop through any of them.
    useEffect(() => {
        const sync = () => {
            view.current?.dispatch({
                effects: themeCompartment.reconfigure(isDark() ? darkTheme : lightTheme),
            });
        };
        const observer = new MutationObserver(sync);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        return () => observer.disconnect();
    }, []);

    return <div className="cm-host" ref={host} />;
}

/** Read-only text pane for `kubectl describe` and secret values. */
export function TextPane({ text }: { text: string }) {
    const [q, setQ] = useState("");
    const lines = useMemo(() => text.split("\n"), [text]);
    const shown = q ? lines.filter((l) => l.toLowerCase().includes(q.toLowerCase())) : lines;
    return (
        <div className="textpane">
            <div className="textpane-bar">
                <div className="search">
                    <input placeholder="Filter lines…" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                {q ? (
                    <span className="faint mono">
                        {shown.length}/{lines.length}
                    </span>
                ) : null}
            </div>
            <pre className="textpane-body mono">{shown.join("\n")}</pre>
        </div>
    );
}

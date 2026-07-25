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
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting, indentUnit, foldGutter, bracketMatching } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { yaml } from "@codemirror/lang-yaml";
import "./YamlEditor.css";

/** Colours come from CSS variables so the editor follows the app theme. */
const diggTheme = EditorView.theme({
    "&": { backgroundColor: "transparent", color: "var(--fg)", height: "100%", fontSize: "12.5px" },
    ".cm-content": { fontFamily: "var(--mono)", padding: "8px 0 40px" },
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
    ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
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
    ".cm-foldGutter span": { color: "var(--fg-faint)" },
});

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
            foldGutter(),
            history(),
            bracketMatching(),
            highlightActiveLine(),
            highlightActiveLineGutter(),
            highlightSelectionMatches(),
            search({ top: true }),
            indentUnit.of("  "),
            yaml(),
            syntaxHighlighting(diggHighlight),
            diggTheme,
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

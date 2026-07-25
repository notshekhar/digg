/**
 * An xterm.js terminal wired to the WebSocket in src/web/exec.ts.
 *
 * Output arrives as binary frames and is handed to xterm as bytes, never as a
 * decoded string: a UTF-8 character split across two reads would otherwise be
 * mangled into two replacement characters. Input and resize go back as JSON.
 */

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { streamUrl } from "../lib/api.ts";
import { varHex } from "../lib/color.ts";
import { openTerminal, useApp, type TerminalSession } from "../lib/store.ts";
import "./TerminalPane.css";

/**
 * Build xterm's theme from our CSS variables.
 *
 * Every value goes through toHex first: xterm parses hex and rgb() only, and it
 * ignores what it cannot read rather than complaining — which is how the
 * terminal silently kept a dark theme in light mode while every colour we
 * handed it (all oklch) was being dropped on the floor.
 */
function themeFromCss(): Record<string, string> {
    const v = (name: string, fallback: string) => varHex(name, fallback);
    return {
        background: v("--bg-sunk", "#111114"),
        foreground: v("--fg", "#eeeeee"),
        cursor: v("--accent", "#3fbcd8"),
        cursorAccent: v("--bg-sunk", "#111114"),
        selectionBackground: v("--accent-dim", "#2b6f80"),
        selectionForeground: v("--fg", "#eeeeee"),
        black: v("--t-black", "#2a2a2e"),
        red: v("--t-red", "#e05561"),
        green: v("--t-green", "#4db380"),
        yellow: v("--t-yellow", "#d5a03a"),
        blue: v("--t-blue", "#5b9bd5"),
        magenta: v("--t-magenta", "#c678dd"),
        cyan: v("--t-cyan", "#3fbcd8"),
        white: v("--t-white", "#d8d8dc"),
        brightBlack: v("--t-bright-black", "#6c6c72"),
        brightRed: v("--t-bright-red", "#ff6b78"),
        brightGreen: v("--t-bright-green", "#5fd39a"),
        brightYellow: v("--t-bright-yellow", "#f0bc50"),
        brightBlue: v("--t-bright-blue", "#7ab4e8"),
        brightMagenta: v("--t-bright-magenta", "#dd92ee"),
        brightCyan: v("--t-bright-cyan", "#6fd6ec"),
        brightWhite: v("--t-bright-white", "#ffffff"),
    };
}

/** Vertical padding on .termpane; kept in sync with TerminalPane.css. */
const PANE_PADDING_Y = 10;

export function TerminalPane({
    session,
    onExit,
    active = true,
}: {
    session: TerminalSession;
    onExit: (code: number) => void;
    /** False while this pane is behind another console tab (display: none). */
    active?: boolean;
}) {
    const host = useRef<HTMLDivElement>(null);
    const term = useRef<Terminal | null>(null);
    const refit = useRef<() => void>(() => {});
    /** Set when the shell died 127 and we are waiting for the "d" offer. */
    const offerDebug = useRef(false);
    const exitRef = useRef(onExit);
    exitRef.current = onExit;
    const theme = useApp((s) => s.theme);

    // Repaint on a theme flip instead of recreating the terminal — the shell is
    // a live process, and rebuilding the pane would kill it.
    useEffect(() => {
        if (term.current) term.current.options.theme = themeFromCss();
    }, [theme]);

    useEffect(() => {
        if (!host.current) return;
        const t = new Terminal({
            /*
             * A literal font stack, NOT var(--mono).
             *
             * xterm measures character width by setting this string on a canvas
             * context, and canvas font parsing does not understand var() — the
             * whole declaration is rejected and the measurement silently falls
             * back to the browser default. That is what made the terminal render
             * in the wrong face with letters spaced too far apart: cells sized
             * for one font, glyphs drawn in another.
             */
            fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 12.5,
            letterSpacing: 0,
            lineHeight: 1.25,
            cursorBlink: true,
            allowProposedApi: true,
            // Any ANSI colour that lands too close to the background gets
            // nudged until it is readable. Programs pick colours assuming a
            // dark terminal; on a white one, "bright black" dim text is
            // otherwise nearly invisible.
            minimumContrastRatio: 5,
            theme: themeFromCss(),
            scrollback: 10000,
        });
        const fit = new FitAddon();
        t.loadAddon(fit);
        t.open(host.current);
        term.current = t;
        fit.fit();

        const params: Record<string, string | number | undefined> = {
            kind: session.kind,
            context: session.context,
            ns: session.ns,
            pod: session.pod,
            container: session.container,
            node: session.node,
            cols: t.cols,
            rows: t.rows,
        };
        const url = new URL(streamUrl("/api/exec", params), location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(url.toString());
        ws.binaryType = "arraybuffer";

        const send = (msg: unknown) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        };

        ws.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
                t.write(new Uint8Array(e.data));
                return;
            }
            try {
                const msg = JSON.parse(String(e.data)) as { t: string; message?: string; code?: number };
                if (msg.t === "error") t.write(`\r\n\x1b[31m${msg.message ?? "error"}\x1b[0m\r\n`);
                else if (msg.t === "exit") {
                    // 127 from `exec` means the shell binary is not in the
                    // image — distroless and scratch images have none. Say so,
                    // and hand over the command that does work, instead of
                    // leaving a bare exit code on screen.
                    if (msg.code === 127 && session.kind === "container") {
                        t.write(
                            `\r\n\x1b[33mThat image has no shell (distroless or scratch).\x1b[0m\r\n` +
                                `\x1b[36mPress d\x1b[0m to attach a busybox debug container that shares its process namespace.\r\n` +
                                `\x1b[90m(this adds an ephemeral container to the pod, which cannot be removed until the pod restarts)\x1b[0m\r\n`,
                        );
                        offerDebug.current = true;
                    }
                    t.write(`\r\n\x1b[90m[exited ${msg.code ?? 0}] press any key to close\x1b[0m\r\n`);
                    exitRef.current(msg.code ?? 0);
                }
            } catch {
                /* non-JSON text frame: ignore */
            }
        };
        ws.onerror = () => t.write("\r\n\x1b[31mconnection failed\x1b[0m\r\n");
        ws.onclose = () => t.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");

        const dataSub = t.onData((d) => {
            // After a shell-less exec we are waiting on one keystroke, not on
            // input for a process that is already dead.
            if (offerDebug.current) {
                offerDebug.current = false;
                if (d === "d" || d === "D") {
                    openTerminal({
                        kind: "debug",
                        title: `debug · ${session.pod ?? ""}`,
                        context: session.context,
                        ns: session.ns,
                        pod: session.pod,
                        container: session.container,
                    });
                    return;
                }
            }
            send({ t: "in", d });
        });

        let disposed = false;

        /*
         * Fit, then verify.
         *
         * FitAddon divides the pane height by the cell height, and the cell
         * height is fractional (a 12.5px font at 1.25 line-height is 15.625px).
         * The rounding error accumulates down the pane until the grid is a few
         * pixels taller than the box holding it, and the bottom row — the one
         * with your prompt and the tail of whatever you just printed — is cut in
         * half by the container. Measuring the rendered screen and giving back a
         * row when it overflows is the only fix that holds for any font size,
         * zoom level or pane height.
         */
        const resize = () => {
            if (disposed || !host.current) return;
            try {
                fit.fit();
            } catch {
                return; // the pane is hidden; nothing to fit
            }
            const avail = host.current.clientHeight - PANE_PADDING_Y;
            for (let guard = 0; guard < 3; guard++) {
                const screen = t.element?.querySelector(".xterm-screen") as HTMLElement | null;
                if (!screen || t.rows <= 1 || screen.offsetHeight <= avail) break;
                t.resize(t.cols, t.rows - 1);
            }
            send({ t: "resize", cols: t.cols, rows: t.rows });
        };
        refit.current = resize;

        /*
         * Fit again once the webfont has actually loaded.
         *
         * xterm sizes its grid by measuring one character, and at mount that
         * measurement happens in the FALLBACK font — Geist Mono is still being
         * fetched. The fallback is wider, so it computes too few columns, and
         * when the real font lands every glyph shrinks and the terminal leaves a
         * dead strip down the right-hand side. Nothing resizes, so the
         * ResizeObserver never corrects it.
         */
        requestAnimationFrame(resize);
        // Ask for the face explicitly: fonts.ready only waits for fonts already
        // requested, and nothing else on the page may have needed Geist Mono yet.
        void document.fonts
            ?.load('12.5px "Geist Mono"')
            .then(() => document.fonts.ready)
            .then(resize)
            .catch(() => {});

        const ro = new ResizeObserver(resize);
        ro.observe(host.current);
        setTimeout(() => t.focus(), 20);

        return () => {
            disposed = true;
            ro.disconnect();
            dataSub.dispose();
            try {
                ws.close();
            } catch {
                /* already closed */
            }
            t.dispose();
            term.current = null;
        };
    }, [session.id, session.kind, session.context, session.ns, session.pod, session.container, session.node]);

    // A hidden pane measures zero, so a terminal opened behind another tab has
    // to be re-fitted the moment it is shown.
    useEffect(() => {
        if (!active) return;
        const id = requestAnimationFrame(() => refit.current());
        return () => cancelAnimationFrame(id);
    }, [active]);

    return <div className="termpane" ref={host} />;
}

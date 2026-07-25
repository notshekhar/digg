/**
 * Terminal sessions over WebSocket: a shell inside a container, a shell on a
 * node, or a local shell with kubectl already pointed at the right context.
 *
 * Wire protocol, deliberately tiny:
 *
 *   server → client   binary frame   raw terminal bytes
 *                     text frame     JSON status: {t:"ready"|"exit"|"error"}
 *   client → server   text frame     JSON: {t:"in",d} | {t:"resize",cols,rows}
 *
 * Output is binary because terminal streams are bytes, and a UTF-8 multi-byte
 * sequence split across two reads must reach xterm.js unmangled — decoding it
 * to a string on this side would corrupt the split character.
 *
 * SECURITY: any website can open a WebSocket to 127.0.0.1 — the same-origin
 * policy does not apply to WS handshakes. A shell endpoint with no auth is
 * therefore remote code execution from a random browser tab. Every session is
 * gated on the per-run token in serve.ts, which only a page served by this
 * process can read.
 */

import { Pty, ptyAvailable } from "../pty.ts";

export interface ExecTarget {
    kind: "container" | "node" | "local" | "debug";
    context: string;
    namespace?: string;
    pod?: string;
    container?: string;
    node?: string;
    /** Shell to run inside a container; ignored for local sessions. */
    shell?: string;
    cols: number;
    rows: number;
}

export interface ExecSocketData {
    target: ExecTarget;
    pty?: Pty;
}

/**
 * Probe for bash and exec it, else fall back to sh — one round trip instead of
 * a failed exec followed by a retry, which would leave a dead pane on screen.
 */
function shellCommand(preferred?: string): string {
    if (preferred && preferred !== "auto") return `exec ${preferred}`;
    return "command -v bash >/dev/null 2>&1 && exec bash || exec sh";
}

export function execArgvFor(t: ExecTarget): { command: string; args: string[] } {
    if (t.kind === "local") {
        // A local shell with the cluster pre-selected: the same thing you get
        // from Lens's terminal. kubectl is on PATH because digg required it to
        // start at all.
        const shell = process.env.SHELL || "/bin/sh";
        return { command: shell, args: ["-l"] };
    }
    if (t.kind === "debug") {
        /*
         * Distroless and scratch images have no shell, so `exec` can only fail.
         * An ephemeral debug container shares the target's process namespace and
         * brings its own busybox — the only way into those pods.
         *
         * This MUTATES the pod (the ephemeral container is recorded in its
         * spec and cannot be removed until the pod is), so it is only ever
         * started when the user explicitly asks for it.
         */
        const args = ["--context", t.context];
        if (t.namespace) args.push("-n", t.namespace);
        args.push("debug", "-it", t.pod ?? "", "--image=busybox");
        if (t.container) args.push(`--target=${t.container}`);
        args.push("--", "sh");
        return { command: "kubectl", args };
    }
    if (t.kind === "node") {
        // `kubectl debug node/x` attaches a privileged pod with the host
        // filesystem under /host — the standard way to get a node shell.
        const args = ["--context", t.context, "debug", `node/${t.node}`, "-it", "--image=busybox", "--", "sh"];
        return { command: "kubectl", args };
    }
    const args = ["--context", t.context];
    if (t.namespace) args.push("-n", t.namespace);
    args.push("exec", "-it", t.pod ?? "");
    if (t.container) args.push("-c", t.container);
    args.push("--", "/bin/sh", "-c", shellCommand(t.shell));
    return { command: "kubectl", args };
}

/** Human label for the session tab. */
export function execTitle(t: ExecTarget): string {
    if (t.kind === "local") return `shell · ${t.context}`;
    if (t.kind === "node") return `node · ${t.node}`;
    if (t.kind === "debug") return `debug · ${t.pod}`;
    return t.container ? `${t.pod} · ${t.container}` : (t.pod ?? "shell");
}

export function startExecSession(
    data: ExecSocketData,
    send: (payload: Uint8Array | string) => void,
    onExit: (code: number) => void,
): Pty | null {
    if (!ptyAvailable()) {
        send(
            JSON.stringify({
                t: "error",
                message:
                    "digg: this platform has no pty support, so an interactive shell is not available. Use `digg` in a terminal instead.",
            }),
        );
        return null;
    }

    const { command, args } = execArgvFor(data.target);
    const env: Record<string, string | undefined> = { ...process.env };
    if (data.target.kind === "local") {
        // The prompt should say which cluster you are about to break.
        env.DIGG_CONTEXT = data.target.context;
        env.KUBECTL_CONTEXT = data.target.context;
    }

    let pty: Pty;
    try {
        pty = new Pty({
            command,
            args,
            env,
            cols: Math.max(20, Math.min(500, data.target.cols || 80)),
            rows: Math.max(5, Math.min(200, data.target.rows || 24)),
        });
    } catch (err) {
        send(JSON.stringify({ t: "error", message: err instanceof Error ? err.message : String(err) }));
        return null;
    }

    pty.onData((chunk) => send(chunk));
    pty.onExit((code) => {
        send(JSON.stringify({ t: "exit", code }));
        onExit(code);
    });
    send(JSON.stringify({ t: "ready", title: execTitle(data.target) }));
    return pty;
}

export function parseExecTarget(url: URL): ExecTarget | null {
    const p = url.searchParams;
    const kind = p.get("kind");
    const context = p.get("context")?.trim();
    if (!context) return null;
    if (kind !== "container" && kind !== "node" && kind !== "local" && kind !== "debug") return null;
    if ((kind === "container" || kind === "debug") && !p.get("pod")) return null;
    if (kind === "node" && !p.get("node")) return null;
    return {
        kind,
        context,
        namespace: p.get("ns") || undefined,
        pod: p.get("pod") || undefined,
        container: p.get("container") || undefined,
        node: p.get("node") || undefined,
        shell: p.get("shell") || undefined,
        cols: Number(p.get("cols")) || 80,
        rows: Number(p.get("rows")) || 24,
    };
}

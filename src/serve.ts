/**
 * `digg serve` — the cluster browser in a browser.
 *
 * One Bun.serve process: the embedded React app on GET /, a JSON+SSE API under
 * /api, and WebSocket terminals under /api/exec.
 *
 * ## Why there is a token
 *
 * Binding to 127.0.0.1 is not access control. Any web page you visit can issue
 * requests to localhost, and for WebSockets the same-origin policy does not even
 * apply to the handshake — so an unauthenticated /api/exec on a loopback port is
 * remote code execution from a random tab. digg mints a token per run, embeds it
 * in the page it serves, and requires it on every /api call. A cross-origin page
 * can trigger requests but can never read our HTML, so it can never learn the
 * token.
 *
 * The page itself is unauthenticated on purpose: it is a static document, and
 * gating it would only mean pasting a URL with a secret in it.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getVersion } from "./commands.ts";
import { isKubectlAvailable } from "./kubectl.ts";
import { getLastContext, getWebPrefs } from "./settings.ts";
import { handleApi } from "./web/api.ts";
import { pageHtml } from "./web/page.ts";
import { type ExecSocketData, parseExecTarget, startExecSession } from "./web/exec.ts";
import { stopAllForwards } from "./web/forwards.ts";

export const DEFAULT_PORT = 9787;

export interface ServeOptions {
    port?: number;
    host?: string;
    open?: boolean;
}

const TOKEN = randomBytes(24).toString("base64url");

/** Exported for tests: the guard every /api request passes through. */
export function isAuthorized(req: Request, url: URL, token: string, port: number): boolean {
    const header = req.headers.get("x-digg-token");
    const param = url.searchParams.get("token"); // EventSource and WebSocket cannot set headers
    if (header !== token && param !== token) return false;

    // Belt and braces: a token leak via a copied URL should still not let a
    // hostile page drive the API from its own origin.
    const origin = req.headers.get("origin");
    if (origin) {
        try {
            const o = new URL(origin);
            const okHost = o.hostname === "127.0.0.1" || o.hostname === "localhost" || o.hostname === "[::1]";
            if (!okHost || (o.port && Number(o.port) !== port && Number(o.port) !== 9788)) return false;
        } catch {
            return false;
        }
    }
    return true;
}

export async function runServe(opts: ServeOptions = {}): Promise<void> {
    if (!(await isKubectlAvailable())) {
        process.stderr.write("digg: kubectl not found on PATH. Install kubectl and try again.\n");
        process.exit(1);
    }

    const host = opts.host ?? "127.0.0.1";
    const preferred = opts.port ?? DEFAULT_PORT;
    const openBrowser = opts.open !== false;

    let boundPort = preferred;

    const server = startServer(host, preferred, {
        async fetch(req, srv) {
            const url = new URL(req.url);

            if (url.pathname === "/favicon.ico") {
                return new Response(FAVICON, {
                    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" },
                });
            }

            if (url.pathname === "/api/exec") {
                if (!isAuthorized(req, url, TOKEN, boundPort)) return new Response("unauthorized", { status: 401 });
                const target = parseExecTarget(url);
                if (!target) return new Response("bad exec target", { status: 400 });
                const data: ExecSocketData = { target };
                if (srv.upgrade(req, { data })) return undefined as unknown as Response;
                return new Response("websocket upgrade failed", { status: 400 });
            }

            if (url.pathname.startsWith("/api/")) {
                if (!isAuthorized(req, url, TOKEN, boundPort)) {
                    return new Response(JSON.stringify({ error: "unauthorized" }), {
                        status: 401,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                const res = await handleApi(req);
                if (res) return res;
                return new Response(JSON.stringify({ error: "not found" }), {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (req.method === "GET") {
                const prefs = getWebPrefs();
                return new Response(
                    pageHtml({
                        theme: prefs.theme,
                        version: getVersion(),
                        token: TOKEN,
                        context: getLastContext(),
                    }),
                    {
                        headers: {
                            "Content-Type": "text/html; charset=utf-8",
                            "Cache-Control": "no-store",
                            // The page has no third-party anything except the
                            // Google Fonts stylesheet it asks for by name.
                            "X-Content-Type-Options": "nosniff",
                            "Referrer-Policy": "no-referrer",
                        },
                    },
                );
            }
            return new Response("not found", { status: 404 });
        },

        websocket: {
            open(ws) {
                const data = ws.data as ExecSocketData;
                const pty = startExecSession(
                    data,
                    (payload) => {
                        try {
                            ws.send(payload);
                        } catch {
                            /* client vanished mid-write */
                        }
                    },
                    () => {
                        try {
                            ws.close();
                        } catch {
                            /* already closed */
                        }
                    },
                );
                if (pty) data.pty = pty;
            },
            message(ws, message) {
                const data = ws.data as ExecSocketData;
                if (!data.pty) return;
                if (typeof message !== "string") {
                    data.pty.write(new Uint8Array(message as unknown as ArrayBuffer));
                    return;
                }
                try {
                    const msg = JSON.parse(message) as { t?: string; d?: string; cols?: number; rows?: number };
                    if (msg.t === "in" && typeof msg.d === "string") data.pty.write(msg.d);
                    else if (msg.t === "resize") data.pty.resize(msg.cols ?? 80, msg.rows ?? 24);
                } catch {
                    /* not our protocol; ignore rather than kill the shell */
                }
            },
            close(ws) {
                const data = ws.data as ExecSocketData;
                data.pty?.kill();
            },
        },
    });

    boundPort = server.port ?? preferred;
    const url = `http://${host}:${server.port}/`;
    process.stdout.write(`digg serve v${getVersion()} → ${url}\n`);
    process.stdout.write(`  host: ${host}\n`);
    process.stdout.write(`  ctrl+c to stop\n`);

    // Forwards are children of this process; leaving them running after ctrl+c
    // would strand listening ports with no way to find them from the UI again.
    const shutdown = () => {
        stopAllForwards();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    if (openBrowser) openUrl(url);

    await new Promise<void>(() => {});
}

type ServeHandlers = Omit<Parameters<typeof Bun.serve>[0], "port" | "hostname">;

function startServer(host: string, preferred: number, handlers: ServeHandlers): ReturnType<typeof Bun.serve> {
    const maxTries = 20;
    let lastErr: unknown;
    for (let i = 0; i < maxTries; i++) {
        const port = preferred + i;
        try {
            return Bun.serve({
                hostname: host,
                port,
                ...handlers,
                error(err: Error) {
                    return new Response(String(err), { status: 500 });
                },
            } as Parameters<typeof Bun.serve>[0]);
        } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            if (!/EADDRINUSE|already in use|Failed to start server/i.test(msg)) {
                throw err;
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`could not bind port near ${preferred}`);
}

/** The rail mark, as a favicon: one cyan square on transparent. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="#3fbcd8"/></svg>`;

function openUrl(url: string): void {
    const platform = process.platform;
    const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
    const args = platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    } catch {
        process.stderr.write(`digg: could not open browser; visit ${url}\n`);
    }
}

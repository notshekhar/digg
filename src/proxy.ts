/**
 * One long-lived `kubectl proxy` per context, over a unix socket.
 *
 * ## Why
 *
 * Every read used to be its own `kubectl` process, and a process is not free:
 * measured against a local minikube, `kubectl get pods -A -o json` costs ~50ms
 * where the same request over a warm proxy costs ~3ms. On a cloud cluster the
 * gap is far wider, because each process re-does the whole handshake — parse
 * the kubeconfig, run the **exec credential plugin** (`aws eks get-token`,
 * gcloud, oidc), negotiate TLS — before it asks anything. Proven, not assumed:
 * five `kubectl get` calls run the exec plugin five times; five requests
 * through one proxy run it once. A detail page makes half a dozen calls, so
 * that is half a dozen token fetches per page view.
 *
 * This is what makes Lens feel instant on a big cluster — it spawns one
 * `lens-k8s-proxy` per cluster and every request is plain HTTP into it. Same
 * idea here, with kubectl still doing the authenticating, so client certs,
 * tokens and every exec plugin keep working exactly as they did.
 *
 * ## Why a unix socket
 *
 * digg refused an embedded `kubectl proxy` once already, for a good reason: a
 * TCP proxy on localhost is an unauthenticated cluster-admin port, and any page
 * in any browser can reach 127.0.0.1. A **unix socket** has no port to reach.
 * kubectl creates it `srwx------`, so the only thing that can open it is a
 * process running as this user — which can read ~/.kube/config anyway. The
 * socket is also started with `--reject-methods`, so nothing can write through
 * it even then: every mutation in digg still goes out as its own kubectl.
 *
 * A proxy that will not start is not an error. Callers fall back to spawning
 * kubectl, which is exactly what they did before this file existed.
 */

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How long a proxy gets to come up before we give up and use kubectl. */
const START_TIMEOUT_MS = 8000;
/** After a failure, don't try to start it again for this long. */
const RETRY_AFTER_MS = 30_000;
const POLL_MS = 25;

export interface KubeProxy {
    readonly socket: string;
    /** `path` starts with a slash: "/api/v1/pods". */
    fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

interface Entry {
    proc: Bun.Subprocess | null;
    socket: string;
    starting: Promise<KubeProxy | null> | null;
    proxy: KubeProxy | null;
    failedAt: number;
}

const entries = new Map<string, Entry>();
/** Set by disable() when the environment says not to use a proxy at all. */
let disabled = process.env.DIGG_NO_PROXY === "1";

/**
 * macOS caps a unix socket path at ~104 bytes and fails with a bare
 * `bind: invalid argument` when it is longer, so the name is a short hash
 * rather than anything readable. ~/.digg already exists for settings.json.
 */
function socketPath(context: string): string {
    const hash = createHash("sha1").update(context).digest("hex").slice(0, 10);
    return join(homedir(), ".digg", `k-${hash}.sock`);
}

function removeSocket(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        /* not there, which is the state we wanted */
    }
}

async function probe(socket: string): Promise<boolean> {
    try {
        const res = await fetch("http://localhost/version", { unix: socket });
        await res.text();
        return res.ok;
    } catch {
        return false;
    }
}

async function startProxy(context: string, entry: Entry): Promise<KubeProxy | null> {
    const socket = entry.socket;
    // A digg that was killed rather than stopped leaves the file behind, and
    // kubectl will not bind over it.
    removeSocket(socket);
    let proc: Bun.Subprocess;
    try {
        proc = Bun.spawn(
            [
                "kubectl",
                "--context",
                context,
                "proxy",
                `--unix-socket=${socket}`,
                // The socket is for reading. Every write in digg is still its
                // own kubectl, so nothing legitimate loses anything here.
                "--reject-methods=POST,PUT,PATCH,DELETE",
            ],
            { stdout: "pipe", stderr: "pipe" },
        );
    } catch {
        entry.failedAt = Date.now();
        return null;
    }
    entry.proc = proc;

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) break; // died on the way up
        if (await probe(socket)) {
            const proxy: KubeProxy = {
                socket,
                fetch: (path, init) => fetch(`http://localhost${path}`, { ...init, unix: socket }),
            };
            entry.proxy = proxy;
            entry.failedAt = 0;
            // If it dies later, the next caller starts a fresh one instead of
            // talking to a socket nobody is listening on.
            void proc.exited.then(() => {
                if (entries.get(context) === entry) {
                    entry.proxy = null;
                    entry.proc = null;
                    entry.starting = null;
                    removeSocket(socket);
                }
            });
            return proxy;
        }
        await Bun.sleep(POLL_MS);
    }

    try {
        proc.kill();
    } catch {
        /* already gone */
    }
    entry.proc = null;
    entry.failedAt = Date.now();
    removeSocket(socket);
    return null;
}

/**
 * The proxy for a context, starting it if needed. Null means "use kubectl" —
 * no proxy, no kubectl on PATH, no permission to bind the socket, or a recent
 * failure we are not retrying yet.
 */
export function getProxy(context: string): Promise<KubeProxy | null> {
    if (disabled || !context) return Promise.resolve(null);
    let entry = entries.get(context);
    if (!entry) {
        entry = { proc: null, socket: socketPath(context), starting: null, proxy: null, failedAt: 0 };
        entries.set(context, entry);
    }
    if (entry.proxy) return Promise.resolve(entry.proxy);
    if (entry.failedAt && Date.now() - entry.failedAt < RETRY_AFTER_MS) return Promise.resolve(null);
    if (!entry.starting) {
        const e = entry;
        entry.starting = startProxy(context, e).finally(() => {
            e.starting = null;
        });
    }
    return entry.starting;
}

/** The proxy only if it is already up: for callers that must not wait. */
export function currentProxy(context: string): KubeProxy | null {
    return entries.get(context)?.proxy ?? null;
}

export function stopAllProxies(): void {
    for (const [, entry] of entries) {
        try {
            entry.proc?.kill();
        } catch {
            /* already gone */
        }
        removeSocket(entry.socket);
    }
    entries.clear();
}

/** Test seam, and the escape hatch behind DIGG_NO_PROXY=1. */
export function setProxyDisabled(value: boolean): void {
    disabled = value;
    if (value) stopAllProxies();
}

export function isProxyDisabled(): boolean {
    return disabled;
}

/**
 * A JSON GET through the proxy, or null when there is no proxy to use.
 * HTTP errors throw — a 403 from the API server is a real answer, and hiding
 * it behind a kubectl retry would just cost another round trip to learn the
 * same thing.
 */
export async function proxyGet<T>(context: string, path: string): Promise<T | null> {
    const proxy = await getProxy(context);
    if (!proxy) return null;
    let res: Response;
    try {
        res = await proxy.fetch(path);
    } catch {
        // The socket went away underneath us; the caller falls back.
        return null;
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError(apiMessage(text) || `${res.status} ${res.statusText}`, res.status);
    return JSON.parse(text) as T;
}

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

/** Kubernetes errors are a Status object; its `message` is the human part. */
export function apiMessage(body: string): string {
    try {
        const status = JSON.parse(body) as { message?: string };
        return status.message ?? "";
    } catch {
        return body.slice(0, 300);
    }
}

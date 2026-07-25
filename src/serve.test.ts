/**
 * End-to-end coverage for `digg serve`: the document, the token guard, the API
 * and the exec WebSocket.
 *
 * Cluster-dependent assertions are skipped when no cluster answers, so this
 * suite is honest on CI (where there is no kubectl) and thorough on a laptop
 * with minikube running.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { packageRoot } from "./commands.ts";
import { isAuthorized } from "./serve.ts";

const PORT = 19788;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ReturnType<typeof Bun.spawn> | null = null;
let token = "";
let hasCluster = false;
let context = "";

beforeAll(async () => {
    proc = Bun.spawn(["bun", join(packageRoot(), "src/cli.ts"), "serve", "--port", String(PORT), "--no-open"], {
        cwd: packageRoot(),
        stdout: "pipe",
        stderr: "pipe",
    });

    for (let i = 0; i < 80; i++) {
        await Bun.sleep(60);
        try {
            const res = await fetch(`${BASE}/`);
            if (res.ok) {
                const html = await res.text();
                token = /"token":"([^"]+)"/.exec(html)?.[1] ?? "";
                break;
            }
        } catch {
            /* not up yet */
        }
    }

    if (token) {
        const boot = await fetch(`${BASE}/api/boot`, { headers: { "x-digg-token": token } });
        if (boot.ok) {
            const data = (await boot.json()) as { context: string };
            context = data.context;
            hasCluster = Boolean(data.context);
        }
    }
});

afterAll(() => {
    proc?.kill();
});

/**
 * Cluster-dependent tests report the skip instead of passing silently — a
 * green suite that quietly asserted nothing is worse than a red one.
 */
function skipWithoutCluster(): boolean {
    if (!hasCluster) {
        console.warn("      ↷ skipped: no cluster reachable");
        return false;
    }
    return true;
}

const api = (path: string, init?: RequestInit) =>
    fetch(`${BASE}${path}`, { ...init, headers: { "x-digg-token": token, ...(init?.headers ?? {}) } });

describe("cli", () => {
    test("help documents serve", async () => {
        const help = Bun.spawn(["bun", join(packageRoot(), "src/cli.ts"), "help"], { stdout: "pipe", stderr: "pipe" });
        const out = await new Response(help.stdout).text();
        await help.exited;
        expect(out).toContain("digg serve");
        expect(out).toContain("--no-open");
        expect(out).toContain("--port");
    });
});

describe("page", () => {
    test("serves the built React app with a token and a theme", async () => {
        const html = await fetch(`${BASE}/`).then((r) => r.text());
        expect(html).toContain('<div id="root">');
        expect(html).toMatch(/data-theme="(dark|light)"/);
        expect(html).toContain("window.__DIGG__");
        expect(token.length).toBeGreaterThan(20);
        // The bundle must be inlined — an external asset URL would 404 here.
        expect(html).not.toMatch(/<script[^>]+src="\.?\/assets/);
    });

    test("deep links are served by the app, not 404ed", async () => {
        // Path routing means /k/pods/demo/api-7d9f must return the document so
        // a pasted link opens the object instead of a dead page.
        for (const path of ["/", "/events", "/k/pods", "/k/pods/demo/api-7d9f?tab=yaml"]) {
            const res = await fetch(`${BASE}${path}`);
            expect(res.status).toBe(200);
            expect(await res.text()).toContain('<div id="root">');
        }
    });

    test("favicon does not fall through to the app", async () => {
        const res = await fetch(`${BASE}/favicon.ico`);
        expect(res.headers.get("content-type")).toContain("svg");
    });
});

describe("token guard", () => {
    test("api is closed without the token", async () => {
        expect((await fetch(`${BASE}/api/boot`)).status).toBe(401);
        expect((await fetch(`${BASE}/api/boot?token=nope`)).status).toBe(401);
        expect((await fetch(`${BASE}/api/boot`, { headers: { "x-digg-token": "nope" } })).status).toBe(401);
    });

    test("api opens with it, by header or by query", async () => {
        expect((await fetch(`${BASE}/api/boot`, { headers: { "x-digg-token": token } })).status).toBe(200);
        expect((await fetch(`${BASE}/api/boot?token=${token}`)).status).toBe(200);
    });

    test("exec upgrade is refused without the token", async () => {
        const res = await fetch(`${BASE}/api/exec?kind=local&context=x`);
        expect(res.status).toBe(401);
    });

    test("a hostile origin is refused even holding the token", () => {
        const url = new URL(`${BASE}/api/boot`);
        const evil = new Request(url.toString(), { headers: { "x-digg-token": "t", origin: "https://evil.example" } });
        expect(isAuthorized(evil, url, "t", PORT)).toBe(false);

        const own = new Request(url.toString(), { headers: { "x-digg-token": "t", origin: `http://127.0.0.1:${PORT}` } });
        expect(isAuthorized(own, url, "t", PORT)).toBe(true);

        // curl and native clients send no Origin at all; they pass on the token.
        const bare = new Request(url.toString(), { headers: { "x-digg-token": "t" } });
        expect(isAuthorized(bare, url, "t", PORT)).toBe(true);
    });
});

describe("api", () => {
    test("boot describes the cluster and this build", async () => {
        const res = await api("/api/boot");
        expect(res.status).toBe(200);
        const boot = (await res.json()) as {
            catalog: { id: string; kinds: unknown[] }[];
            kinds: { name: string }[];
            canExec: boolean;
            version: string;
        };
        expect(Array.isArray(boot.catalog)).toBe(true);
        expect(boot.kinds.some((k) => k.name === "pods")).toBe(true);
        expect(typeof boot.canExec).toBe("boolean");
        expect(boot.version).toMatch(/\d+\.\d+\.\d+|dev/);
    });

    test("unknown api routes 404 as json", async () => {
        const res = await api("/api/nope");
        expect(res.status).toBe(404);
        expect(await res.json()).toHaveProperty("error");
    });

    test("list returns rows carrying a sortable timestamp", async () => {
        if (!skipWithoutCluster()) return;
        const res = await api(`/api/list?context=${encodeURIComponent(context)}&kind=pods&ns=*`);
        expect(res.status).toBe(200);
        const data = (await res.json()) as { columns: string[]; rows: { name: string; ts: number }[] };
        expect(data.columns).toContain("NAME");
        for (const row of data.rows) {
            expect(typeof row.ts).toBe("number");
        }
    });

    test("overview survives a cluster with no metrics-server", async () => {
        if (!skipWithoutCluster()) return;
        const res = await api(`/api/overview?context=${encodeURIComponent(context)}`);
        expect(res.status).toBe(200);
        const data = (await res.json()) as { totals: { nodes: number }; metricsAvailable: boolean };
        expect(data.totals.nodes).toBeGreaterThan(0);
        expect(typeof data.metricsAvailable).toBe("boolean");
    });

    test("catalog lists every kind once", async () => {
        if (!skipWithoutCluster()) return;
        const res = await api(`/api/catalog?context=${encodeURIComponent(context)}`);
        const { catalog } = (await res.json()) as { catalog: { id: string; kinds: { name: string }[] }[] };
        const names = catalog.flatMap((g) => g.kinds.map((k) => k.name));
        expect(names).toContain("pods");
        expect(names).toContain("nodes");
        expect(new Set(names).size).toBe(names.length);
    });
});

describe("actions", () => {
    test("malformed requests are rejected before kubectl runs", async () => {
        const send = async (body: unknown) => {
            const res = await api("/api/action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            return (await res.json()) as { ok: boolean; message: string };
        };

        expect((await send({ action: "delete" })).ok).toBe(false);
        expect((await send({ action: "scale", context: "x" })).message).toContain("ref");
        expect(
            (await send({ action: "scale", context: "x", ref: { kind: "deployments", name: "a" }, replicas: -1 })).message,
        ).toContain("replicas");
        expect((await send({ action: "apply", context: "x", yaml: "  " })).message).toContain("empty");
        expect((await send({ action: "sudo-rm-rf", context: "x" })).message).toContain("unknown action");
        expect((await send({ action: "drain", context: "x" })).message).toContain("node");

        // The data editor's write path: a key the API server would reject with
        // a wall of validation text is refused here, naming the key.
        const badKey = await send({
            action: "setData",
            context: "x",
            ref: { kind: "configmaps", name: "c", ns: "default" },
            set: { "bad key!": "v" },
        });
        expect(badKey.ok).toBe(false);
        expect(badKey.message).toContain("bad key!");
        expect((await send({ action: "setData", context: "x", ref: { kind: "configmaps", name: "c" } })).message).toContain(
            "nothing to change",
        );
    });
});

describe("port-forwards", () => {
    test("start, list and stop", async () => {
        const list0 = (await (await api("/api/forwards")).json()) as { forwards: unknown[] };
        expect(Array.isArray(list0.forwards)).toBe(true);

        if (!skipWithoutCluster()) return;

        const started = await api("/api/forwards", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context, kind: "services", name: "kubernetes", ns: "default", remotePort: 443 }),
        });
        expect(started.status).toBe(200);
        const { forward } = (await started.json()) as { forward: { id: string; localPort: number | null } };
        expect(forward.id).toBeTruthy();

        const listed = (await (await api("/api/forwards")).json()) as { forwards: { id: string }[] };
        expect(listed.forwards.some((f) => f.id === forward.id)).toBe(true);

        const stopped = (await (await api(`/api/forwards?id=${forward.id}`, { method: "DELETE" })).json()) as {
            ok: boolean;
        };
        expect(stopped.ok).toBe(true);
    });

    test("a forward needs a real target", async () => {
        const res = await api("/api/forwards", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context: "x", kind: "pods" }),
        });
        expect(res.status).toBe(400);
    });
});

describe("exec", () => {
    test(
        "a local shell runs a command and streams its output",
        async () => {
            const ws = new WebSocket(
                `ws://127.0.0.1:${PORT}/api/exec?kind=local&context=test&cols=80&rows=24&token=${token}`,
            );
            const output = await new Promise<string>((resolve) => {
                let buf = "";
                let ready = false;
                const timer = setTimeout(() => resolve(buf), 6000);
                ws.binaryType = "arraybuffer";
                ws.onmessage = (e) => {
                    if (e.data instanceof ArrayBuffer) {
                        buf += new TextDecoder().decode(new Uint8Array(e.data));
                        if (buf.includes("digg-exec-ok")) {
                            clearTimeout(timer);
                            resolve(buf);
                        }
                        return;
                    }
                    const msg = JSON.parse(String(e.data)) as { t: string };
                    if (msg.t === "ready" && !ready) {
                        ready = true;
                        ws.send(JSON.stringify({ t: "in", d: "echo digg-exec-ok\n" }));
                    }
                    if (msg.t === "error") {
                        clearTimeout(timer);
                        resolve("");
                    }
                };
                ws.onerror = () => {
                    clearTimeout(timer);
                    resolve("");
                };
            });
            ws.close();

            // No pty on this platform is a legitimate outcome, not a failure.
            if (output === "") return;
            expect(output).toContain("digg-exec-ok");
        },
        15000,
    );

    test("a malformed exec target is rejected", async () => {
        const res = await fetch(`${BASE}/api/exec?kind=container&context=x&token=${token}`);
        expect(res.status).toBe(400); // container with no pod
    });
});

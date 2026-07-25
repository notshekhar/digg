/**
 * HTTP API for `digg serve` — thin JSON wrappers around kubectl helpers and
 * the format/details models in src/.
 */

import {
    type K8sEvent,
    type K8sObject,
    type PodMetrics,
    type ResourceRef,
    KubectlError,
    describe,
    getContexts,
    getCurrentContext,
    getEvents,
    getJson,
    getNamespaces,
    getYaml,
    isKubectlAvailable,
    listResources,
    topPods,
} from "../kubectl.ts";
import {
    type KindDef,
    KINDS,
    WORKLOAD_KINDS,
    age,
    findKind,
    genericKind,
    podContainers,
} from "../format.ts";
import {
    detailModel,
    ingressRuleRows,
    jobOwnedByCronJob,
    jobStatus,
    podMountsPVC,
} from "../details.ts";
import { RICH_KINDS } from "../detail-view.ts";
import { apiResources } from "../discovery.ts";
import { decodeEntry, decodeSecretValue } from "../secret-yaml.ts";
import { logSpecFor } from "../log-stream.ts";
import {
    clusterVersion,
    listEvents,
    rolloutHistory,
    topNodes,
} from "../kubectl.ts";
import { buildCatalog } from "./catalog.ts";
import { buildDetailPayload, buildRevisions } from "./detail.ts";
import { usageColumns } from "./gauges.ts";
import { buildRow, columnsFor } from "./rows.ts";
import { buildOverview } from "./overview.ts";
import { runAction } from "./actions.ts";
import { listForwards, pruneForwards, startForward, stopForward } from "./forwards.ts";
import { ptyAvailable } from "../pty.ts";
import {
    getContextPrefs,
    getLastContext,
    getWebPrefs,
    setContextPrefs,
    setLastContext,
    setWebPrefs,
} from "../settings.ts";
import { getVersion } from "../commands.ts";

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" },
    });

const bad = (message: string, status = 400) => json({ error: message }, status);

function resolveKind(name: string, discovered: { name: string; kind: string; namespaced: boolean }[]): KindDef | undefined {
    const curated = findKind(name);
    if (curated) return curated;
    const d = discovered.find((r) => r.name === name || r.kind === name);
    return d ? genericKind(d) : undefined;
}

function allKinds(discovered: { name: string; kind: string; namespaced: boolean }[]): KindDef[] {
    const curatedNames = new Set(KINDS.map((k) => k.name));
    const generics = discovered.filter((d) => !curatedNames.has(d.name)).map((d) => genericKind(d));
    return [...KINDS, ...generics];
}

function kindMeta(k: KindDef) {
    return {
        name: k.name,
        title: k.title,
        kind: k.kind,
        clusterScoped: Boolean(k.clusterScoped),
        generic: Boolean(k.generic),
        columns: k.columns,
    };
}

function refFromParams(url: URL): ResourceRef | null {
    const context = url.searchParams.get("context")?.trim();
    const kind = url.searchParams.get("kind")?.trim();
    const name = url.searchParams.get("name")?.trim();
    if (!context || !kind || !name) return null;
    const ns = url.searchParams.get("ns");
    return {
        context,
        kind,
        name,
        namespace: ns && ns.length > 0 ? ns : undefined,
    };
}

async function listWithOpts(
    kind: KindDef,
    context: string,
    namespace: string | null | undefined,
    extra?: { labelSelector?: string; fieldSelector?: string },
): Promise<K8sObject[]> {
    return listResources(kind.name, {
        context,
        namespace: kind.clusterScoped ? undefined : namespace ?? undefined,
        clusterScoped: kind.clusterScoped,
        labelSelector: extra?.labelSelector,
        fieldSelector: extra?.fieldSelector,
    });
}

export async function handleApi(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (!pathname.startsWith("/api/")) return null;

    try {
        if (pathname === "/api/boot" && req.method === "GET") {
            if (!(await isKubectlAvailable())) {
                return bad("kubectl not found on PATH", 503);
            }
            let contexts: string[] = [];
            try {
                contexts = await getContexts();
            } catch {
                contexts = [];
            }
            let context = getLastContext() ?? "";
            if (!context || !contexts.includes(context)) {
                try {
                    context = await getCurrentContext();
                } catch {
                    context = "";
                }
            }
            if (!context && contexts.length > 0) context = contexts[0]!;
            const prefs = context ? getContextPrefs(context) : {};
            const discovered = context ? await apiResources(context).catch(() => []) : [];
            const kinds = allKinds(discovered).map(kindMeta);
            let namespaces: string[] = [];
            if (context) {
                try {
                    namespaces = await getNamespaces(context);
                } catch {
                    namespaces = [];
                }
            }
            const kindName = (prefs.kind && resolveKind(prefs.kind, discovered)?.name) || "pods";
            const web = getWebPrefs();
            return json({
                contexts,
                context,
                namespaces,
                namespace: prefs.namespace === undefined ? null : prefs.namespace,
                kind: kindName,
                kinds,
                catalog: buildCatalog(discovered),
                curated: KINDS.map((k) => k.name),
                prefs: web,
                version: getVersion(),
                cluster: context ? await clusterVersion(context).catch(() => null) : null,
                // The shell tab is hidden rather than broken where no pty exists.
                canExec: ptyAvailable(),
                forwards: listForwards(),
            });
        }

        if (pathname === "/api/prefs" && req.method === "POST") {
            const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
            if (!body) return bad("invalid json");
            if (body.theme === "light" || body.theme === "dark") {
                setWebPrefs({ theme: body.theme });
            }
            const context = typeof body.context === "string" ? body.context : undefined;
            if (context) {
                setLastContext(context);
                const patch: { namespace?: string | null; kind?: string } = {};
                if ("namespace" in body) {
                    patch.namespace = body.namespace === null || body.namespace === "" ? null : String(body.namespace);
                }
                if (typeof body.kind === "string") patch.kind = body.kind;
                if (Object.keys(patch).length) setContextPrefs(context, patch);
            }
            return json({ ok: true, prefs: getWebPrefs() });
        }

        if (pathname === "/api/namespaces" && req.method === "GET") {
            const context = url.searchParams.get("context")?.trim();
            if (!context) return bad("context required");
            let namespaces: string[] = [];
            try {
                namespaces = await getNamespaces(context);
            } catch {
                namespaces = [];
            }
            return json({ namespaces });
        }

        if (pathname === "/api/kinds" && req.method === "GET") {
            const context = url.searchParams.get("context")?.trim();
            if (!context) return bad("context required");
            const discovered = await apiResources(context).catch(() => []);
            return json({ kinds: allKinds(discovered).map(kindMeta), curated: KINDS.map((k) => k.name) });
        }

        if (pathname === "/api/list" && req.method === "GET") {
            const context = url.searchParams.get("context")?.trim();
            const kindName = url.searchParams.get("kind")?.trim() || "pods";
            if (!context) return bad("context required");
            const nsParam = url.searchParams.get("ns");
            const namespace = nsParam === null || nsParam === "" || nsParam === "*" ? null : nsParam;
            const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
            const discovered = await apiResources(context).catch(() => []);
            const kind = resolveKind(kindName, discovered);
            if (!kind) return bad(`unknown kind: ${kindName}`, 404);
            const items = await listWithOpts(kind, context, namespace);
            const usage = await usageColumns(kind.name, items, context, namespace);
            const { columns, insertAt } = columnsFor(kind, usage);
            const rows = items
                .filter((obj) => {
                    if (!q) return true;
                    const name = (obj.metadata?.name ?? "").toLowerCase();
                    return name.includes(q) || (obj.metadata?.namespace ?? "").toLowerCase().includes(q);
                })
                .map((obj) => buildRow(obj, kind, usage, insertAt));
            return json({
                kind: kindMeta(kind),
                columns,
                rows,
                count: rows.length,
            });
        }

        if (pathname === "/api/detail" && req.method === "GET") {
            const ref = refFromParams(url);
            if (!ref) return bad("context, kind, name required");
            const discovered = await apiResources(ref.context).catch(() => []);
            const kind = resolveKind(ref.kind, discovered);
            if (!kind) return bad(`unknown kind: ${ref.kind}`, 404);
            return json(await buildDetailPayload(kind, ref));
        }

        if (pathname === "/api/yaml" && req.method === "GET") {
            const ref = refFromParams(url);
            if (!ref) return bad("context, kind, name required");
            const text = await getYaml(ref);
            return json({ text });
        }

        if (pathname === "/api/describe" && req.method === "GET") {
            const ref = refFromParams(url);
            if (!ref) return bad("context, kind, name required");
            const text = await describe(ref);
            return json({ text });
        }

        if (pathname === "/api/data-key" && req.method === "GET") {
            const ref = refFromParams(url);
            const key = url.searchParams.get("key")?.trim();
            if (!ref || !key) return bad("context, kind, name, key required");
            const obj = await getJson(ref);
            const data = (obj.data as Record<string, string>) ?? {};
            if (!(key in data)) return bad("key not found", 404);
            const decode = url.searchParams.get("decode") === "1" || obj.kind === "Secret";
            const text = decode ? decodeSecretValue(data[key]!) : data[key]!;
            return json({ key, text });
        }

        if (pathname === "/api/data" && req.method === "GET") {
            const ref = refFromParams(url);
            if (!ref) return bad("context, kind, name required");
            const obj = await getJson(ref);
            const encoded = obj.kind === "Secret";
            const data = (obj.data as Record<string, string>) ?? {};
            // binaryData is ConfigMap's escape hatch for non-text values; it is
            // always base64 and always read-only here.
            const binaryData = (obj.binaryData as Record<string, string>) ?? {};
            const entries = [
                ...Object.entries(data).map(([key, value]) => ({ key, ...decodeEntry(value, encoded) })),
                ...Object.entries(binaryData).map(([key, value]) => ({
                    key,
                    ...decodeEntry(value, true),
                    binary: true,
                })),
            ].sort((a, b) => a.key.localeCompare(b.key));
            return json({
                kind: obj.kind ?? "",
                encoded,
                immutable: Boolean(obj.immutable),
                type: String(obj.type ?? ""),
                entries,
            });
        }

        if (pathname === "/api/logs" && req.method === "GET") {
            const ref = refFromParams(url);
            if (!ref) return bad("context, kind, name required");
            const obj = await getJson(ref);
            const spec = logSpecFor(ref.kind, obj, ref.context);
            if (!spec) return bad("logs not available for this resource", 400);

            const container = url.searchParams.get("container")?.trim();
            const tail = Number(url.searchParams.get("tail")) || 500;
            const timestamps = url.searchParams.get("timestamps") === "1";
            const previous = url.searchParams.get("previous") === "1";
            const follow = url.searchParams.get("follow") !== "0";

            const args = ["--context", spec.context, "logs", `--tail=${Math.max(1, Math.min(20000, tail))}`];
            if (follow && !previous) args.push("-f"); // --previous and -f are mutually exclusive
            if (timestamps) args.push("--timestamps");
            if (previous) args.push("--previous");
            if (container) {
                args.push("-c", container);
            } else {
                args.push("--all-containers=true");
            }
            if (spec.podName) args.push(spec.podName);
            if (spec.selector) args.push("-l", spec.selector, "--prefix", "--max-log-requests=20");
            if (spec.namespace) args.push("-n", spec.namespace);

            const proc = Bun.spawn(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" });
            const stream = new ReadableStream({
                start(controller) {
                    const enc = new TextEncoder();
                    const send = (line: string) => {
                        controller.enqueue(enc.encode(`data: ${JSON.stringify(line)}\n\n`));
                    };
                    send(`── ${spec.title} ──`);
                    const reader = proc.stdout.getReader();
                    const errReader = proc.stderr.getReader();
                    const dec = new TextDecoder();
                    let buf = "";
                    type Reader = { read(): Promise<{ done: boolean; value?: Uint8Array }> };
                    const pump = async (r: Reader, isErr: boolean) => {
                        while (true) {
                            const { done, value } = await r.read();
                            if (done) break;
                            buf += dec.decode(value, { stream: true });
                            const parts = buf.split("\n");
                            buf = parts.pop() ?? "";
                            for (const line of parts) {
                                if (line.length) send(isErr ? `[stderr] ${line}` : line);
                            }
                        }
                        if (buf.length) {
                            send(isErr ? `[stderr] ${buf}` : buf);
                            buf = "";
                        }
                    };
                    void (async () => {
                        try {
                            await Promise.all([pump(reader, false), pump(errReader, true)]);
                            await proc.exited;
                            controller.enqueue(enc.encode("event: end\ndata: {}\n\n"));
                            controller.close();
                        } catch (e) {
                            try {
                                send(`stream error: ${e instanceof Error ? e.message : String(e)}`);
                                controller.close();
                            } catch {
                                /* closed */
                            }
                        }
                    })();
                    req.signal.addEventListener("abort", () => {
                        try {
                            proc.kill();
                        } catch {
                            /* */
                        }
                    });
                },
                cancel() {
                    try {
                        proc.kill();
                    } catch {
                        /* */
                    }
                },
            });

            return new Response(stream, {
                headers: {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                },
            });
        }

        // ── catalog, overview, metrics, events ──────────────────────────────

        if (pathname === "/api/catalog" && req.method === "GET") {
            const context = url.searchParams.get("context")?.trim();
            if (!context) return bad("context required");
            const discovered = await apiResources(context).catch(() => []);
            return json({ catalog: buildCatalog(discovered) });
        }

        if (pathname === "/api/overview" && req.method === "GET") {
            const context = url.searchParams.get("context")?.trim();
            if (!context) return bad("context required");
            return json(await buildOverview(context));
        }

        if (pathname === "/api/events" && req.method === "GET") {
            const context = url.searchParams.get("context")?.trim();
            if (!context) return bad("context required");
            const nsParam = url.searchParams.get("ns");
            const namespace = nsParam === null || nsParam === "" || nsParam === "*" ? undefined : nsParam;
            const limit = Number(url.searchParams.get("limit")) || 500;
            return json({ events: await listEvents(context, namespace, limit) });
        }

        if (pathname === "/api/metrics" && req.method === "GET") {
            const context = url.searchParams.get("context")?.trim();
            if (!context) return bad("context required");
            const nsParam = url.searchParams.get("ns");
            const namespace = nsParam === null || nsParam === "" || nsParam === "*" ? undefined : nsParam;
            const [nodes, pods] = await Promise.all([
                topNodes(context).catch(() => new Map()),
                topPods(context, namespace).catch(() => new Map()),
            ]);
            return json({
                nodes: Object.fromEntries(nodes),
                pods: Object.fromEntries(pods),
                available: nodes.size > 0 || pods.size > 0,
            });
        }

        if (pathname === "/api/history" && req.method === "GET") {
            const ref = refFromParams(url);
            if (!ref) return bad("context, kind, name required");
            return json({ revisions: await rolloutHistory(ref) });
        }

        if (pathname === "/api/revisions" && req.method === "GET") {
            const ref = refFromParams(url);
            if (!ref) return bad("context, kind, name required");
            const obj = await getJson(ref);
            return json({ revisions: await buildRevisions(ref.kind, obj, ref.context) });
        }

        // ── writes ──────────────────────────────────────────────────────────

        if (pathname === "/api/action" && req.method === "POST") {
            const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
            if (!body) return bad("invalid json");
            try {
                const result = await runAction(body);
                return json(result, result.ok ? 200 : 400);
            } catch (err) {
                // A kubectl failure here is the user's problem to read, not a
                // server fault: surface the exact stderr with a 400.
                return json(
                    { ok: false, message: err instanceof Error ? err.message : String(err) },
                    err instanceof KubectlError ? 400 : 500,
                );
            }
        }

        // ── port-forwards ───────────────────────────────────────────────────

        if (pathname === "/api/forwards" && req.method === "GET") {
            pruneForwards();
            const context = url.searchParams.get("context")?.trim() || undefined;
            return json({ forwards: listForwards(context) });
        }

        if (pathname === "/api/forwards" && req.method === "POST") {
            const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
            if (!body) return bad("invalid json");
            const context = String(body.context ?? "");
            const kind = String(body.kind ?? "");
            const name = String(body.name ?? "");
            const remotePort = Number(body.remotePort);
            if (!context || !kind || !name) return bad("context, kind, name required");
            if (!Number.isInteger(remotePort) || remotePort <= 0) return bad("remotePort required");
            const forward = startForward({
                context,
                kind,
                name,
                namespace: body.ns ? String(body.ns) : undefined,
                remotePort,
                localPort: Number(body.localPort) || 0,
            });
            // kubectl needs a beat to bind and print the chosen port; without
            // this the UI would show "starting" and no URL on the happy path.
            await Bun.sleep(350);
            const current = listForwards().find((f) => f.id === forward.id) ?? forward;
            return json({ forward: current });
        }

        if (pathname === "/api/forwards" && req.method === "DELETE") {
            const id = url.searchParams.get("id")?.trim();
            if (!id) return bad("id required");
            return json({ ok: stopForward(id) });
        }

        return bad("not found", 404);
    } catch (err) {
        const msg = err instanceof KubectlError ? err.message : err instanceof Error ? err.message : String(err);
        return bad(msg, err instanceof KubectlError ? 502 : 500);
    }
}

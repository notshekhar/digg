// Thin wrapper around the kubectl CLI. We shell out rather than talking to the
// API directly so every auth method (client certs, tokens, and exec plugins
// like aws/gcp/oidc) works for free — kubectl already handles all of it.

export interface K8sObject {
    apiVersion?: string;
    kind?: string;
    metadata?: {
        name?: string;
        namespace?: string;
        creationTimestamp?: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
        ownerReferences?: { kind?: string; name?: string; uid?: string; controller?: boolean }[];
        deletionTimestamp?: string;
        uid?: string;
    };
    status?: Record<string, unknown>;
    spec?: Record<string, unknown>;
    [key: string]: unknown;
}

interface RunResult {
    stdout: string;
    stderr: string;
    code: number;
}

async function run(args: string[], context?: string): Promise<RunResult> {
    const full = context ? ["--context", context, ...args] : args;
    const proc = Bun.spawn(["kubectl", ...full], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, code };
}

export class KubectlError extends Error {}

async function runOrThrow(args: string[], context?: string): Promise<string> {
    const result = await run(args, context);
    if (result.code !== 0) {
        throw new KubectlError(result.stderr.trim() || `kubectl ${args.join(" ")} failed`);
    }
    return result.stdout;
}

export async function isKubectlAvailable(): Promise<boolean> {
    try {
        const result = await run(["version", "--client", "-o", "json"]);
        return result.code === 0;
    } catch {
        return false;
    }
}

export async function getContexts(): Promise<string[]> {
    const out = await runOrThrow(["config", "get-contexts", "-o", "name"]);
    return out.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

export async function getCurrentContext(): Promise<string> {
    return (await runOrThrow(["config", "current-context"])).trim();
}

export async function getNamespaces(context: string): Promise<string[]> {
    const items = await listResources("namespaces", { context });
    return items.map((item) => item.metadata?.name ?? "").filter(Boolean);
}

export interface ListOptions {
    context: string;
    namespace?: string; // undefined → all namespaces (-A)
    clusterScoped?: boolean;
    labelSelector?: string;
    fieldSelector?: string;
}

export async function listResources(kind: string, opts: ListOptions): Promise<K8sObject[]> {
    const args = ["get", kind, "-o", "json"];
    if (!opts.clusterScoped) {
        if (opts.namespace) {
            args.push("-n", opts.namespace);
        } else {
            args.push("-A");
        }
    }
    if (opts.labelSelector) {
        args.push("-l", opts.labelSelector);
    }
    if (opts.fieldSelector) {
        args.push("--field-selector", opts.fieldSelector);
    }
    const out = await runOrThrow(args, opts.context);
    const parsed = JSON.parse(out) as { items?: K8sObject[] };
    return parsed.items ?? [];
}

export interface PodMetrics {
    cpu: string;
    memory: string;
}

/**
 * Per-pod CPU/memory via `kubectl top`. Returns an empty map when metrics
 * aren't available (no metrics-server) rather than throwing.
 */
export async function topPods(
    context: string,
    namespace: string | undefined,
    labelSelector?: string,
): Promise<Map<string, PodMetrics>> {
    const args = ["top", "pods", "--no-headers"];
    if (namespace) {
        args.push("-n", namespace);
    } else {
        // No namespace means "everything" everywhere else in digg; without -A
        // kubectl would quietly answer for the current namespace only.
        args.push("-A");
    }
    if (labelSelector) {
        args.push("-l", labelSelector);
    }
    const result = await run(args, context);
    const map = new Map<string, PodMetrics>();
    if (result.code !== 0) {
        return map;
    }
    for (const line of result.stdout.split("\n")) {
        const cols = line.trim().split(/\s+/);
        // -A prepends the namespace. Both keys go in the map: callers that know
        // the namespace get an exact hit, and the older name-only lookups still
        // work (they collide only for same-named pods in different namespaces).
        const cells = namespace ? cols : cols.slice(1);
        if (cells.length >= 3) {
            const metrics = { cpu: cells[1]!, memory: cells[2]! };
            if (!namespace && cols[0]) map.set(`${cols[0]}/${cells[0]}`, metrics);
            if (namespace) map.set(`${namespace}/${cells[0]}`, metrics);
            map.set(cells[0]!, metrics);
        }
    }
    return map;
}

/**
 * Per-CONTAINER CPU/memory (`kubectl top pods --containers`), keyed
 * "pod/container".
 *
 * A pod-level number cannot answer "which of these three containers is eating
 * the node", which is the question a container card exists to answer, so the
 * detail pages ask for this instead of topPods.
 */
export async function topPodContainers(
    context: string,
    opts: { namespace?: string; labelSelector?: string; pod?: string } = {},
): Promise<Map<string, PodMetrics>> {
    const args = ["top", "pods"];
    if (opts.pod) args.push(opts.pod);
    args.push("--containers", "--no-headers");
    if (opts.namespace) {
        args.push("-n", opts.namespace);
    } else {
        args.push("-A");
    }
    if (opts.labelSelector) {
        args.push("-l", opts.labelSelector);
    }
    const result = await run(args, context);
    const map = new Map<string, PodMetrics>();
    if (result.code !== 0) {
        return map;
    }
    for (const line of result.stdout.split("\n")) {
        const cols = line.trim().split(/\s+/);
        // With -A the first column is the namespace; both the qualified and the
        // bare key go in, as topPods does.
        const cells = opts.namespace ? cols : cols.slice(1);
        if (cells.length >= 4) {
            const metrics = { cpu: cells[2]!, memory: cells[3]! };
            const ns = opts.namespace ?? cols[0];
            if (ns) map.set(`${ns}/${cells[0]}/${cells[1]}`, metrics);
            map.set(`${cells[0]}/${cells[1]}`, metrics);
        }
    }
    return map;
}

export interface ResourceRef {
    kind: string;
    name: string;
    namespace?: string;
    context: string;
}

export async function getYaml(ref: ResourceRef): Promise<string> {
    const args = ["get", ref.kind, ref.name, "-o", "yaml"];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    return runOrThrow(args, ref.context);
}

/** Live object as JSON — the source we transform for the secret/config editor. */
export async function getJson(ref: ResourceRef): Promise<K8sObject> {
    const args = ["get", ref.kind, ref.name, "-o", "json"];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    const out = await runOrThrow(args, ref.context);
    return JSON.parse(out) as K8sObject;
}

/**
 * Apply a manifest piped on stdin (`kubectl apply -f -`). Used by the in-app
 * editor on save. Returns kubectl's stdout (e.g. "secret/foo configured").
 */
export async function applyManifest(manifest: string, context: string): Promise<string> {
    const full = ["--context", context, "apply", "-f", "-"];
    const proc = Bun.spawn(["kubectl", ...full], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(manifest);
    await proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (code !== 0) {
        throw new KubectlError(stderr.trim() || "kubectl apply failed");
    }
    // apply warns (not fails) when the object lacks a last-applied annotation;
    // keep stdout as the success message and ignore that warning on stderr.
    return stdout.trim();
}

export async function describe(ref: ResourceRef): Promise<string> {
    const args = ["describe", ref.kind, ref.name];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    return runOrThrow(args, ref.context);
}

export async function getLogs(ref: ResourceRef, tail = 1000): Promise<string> {
    const args = ["logs", ref.name, `--tail=${tail}`, "--all-containers=true"];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    const result = await run(args, ref.context);
    // kubectl logs can exit non-zero (e.g. container not started) but still
    // print a useful message on stderr; surface whatever we got.
    return result.code === 0 ? result.stdout : `${result.stdout}${result.stderr}`.trim();
}

export async function deleteResource(ref: ResourceRef): Promise<string> {
    const args = ["delete", ref.kind, ref.name];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    return runOrThrow(args, ref.context);
}

// ── events ─────────────────────────────────────────────────────────────────

export interface K8sEvent {
    type: string; // Normal | Warning
    reason: string;
    message: string;
    count: number;
    source: string;
    lastSeen: string; // ISO timestamp (lastTimestamp or eventTime)
}

/**
 * Events for one object, newest-first. We filter with a field selector on the
 * involved object's *Kind* (PascalCase singular, e.g. "Pod") — not the plural
 * resource name — and on its name (+ namespace for namespaced kinds).
 */
export async function getEvents(ref: ResourceRef, involvedKind: string): Promise<K8sEvent[]> {
    const selector = [`involvedObject.kind=${involvedKind}`, `involvedObject.name=${ref.name}`];
    const args = ["get", "events", "-o", "json", "--field-selector", selector.join(",")];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    } else {
        args.push("-A");
    }
    const result = await run(args, ref.context);
    if (result.code !== 0) {
        return [];
    }
    const parsed = JSON.parse(result.stdout) as { items?: RawEvent[] };
    const items = parsed.items ?? [];
    const events = items.map(normalizeEvent);
    events.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
    return events;
}

interface RawEvent {
    type?: string;
    reason?: string;
    message?: string;
    count?: number;
    lastTimestamp?: string;
    eventTime?: string;
    firstTimestamp?: string;
    source?: { component?: string; host?: string };
    reportingComponent?: string;
}

function normalizeEvent(e: RawEvent): K8sEvent {
    return {
        type: e.type ?? "Normal",
        reason: e.reason ?? "",
        message: (e.message ?? "").replace(/\s+/g, " ").trim(),
        count: e.count ?? 1,
        source: e.source?.component ?? e.reportingComponent ?? "",
        lastSeen: e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? "",
    };
}

// ── write verbs ────────────────────────────────────────────────────────────

export async function scaleResource(ref: ResourceRef, replicas: number): Promise<string> {
    const args = ["scale", ref.kind, ref.name, `--replicas=${replicas}`];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    return runOrThrow(args, ref.context);
}

export async function rolloutRestart(ref: ResourceRef): Promise<string> {
    const args = ["rollout", "restart", `${ref.kind}/${ref.name}`];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    return runOrThrow(args, ref.context);
}

export async function setNodeSchedulable(context: string, node: string, schedulable: boolean): Promise<string> {
    return runOrThrow([schedulable ? "uncordon" : "cordon", node], context);
}

export async function drainNode(context: string, node: string): Promise<string> {
    return runOrThrow(
        ["drain", node, "--ignore-daemonsets", "--delete-emptydir-data", "--force", "--timeout=60s"],
        context,
    );
}

export async function setSuspend(ref: ResourceRef, suspend: boolean): Promise<string> {
    const args = ["patch", ref.kind, ref.name, "-p", JSON.stringify({ spec: { suspend } })];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    return runOrThrow(args, ref.context);
}

/**
 * JSON merge patch. `null` for a value deletes that key, which is how the data
 * editor removes a ConfigMap/Secret entry without rewriting the whole object.
 */
export async function patchResource(ref: ResourceRef, patch: unknown): Promise<string> {
    const args = ["patch", ref.kind, ref.name, "--type", "merge", "-p", JSON.stringify(patch)];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    return runOrThrow(args, ref.context);
}

/** Manually trigger a CronJob by creating a one-off Job from it. */
export async function triggerCronJob(ref: ResourceRef): Promise<string> {
    const jobName = `${ref.name}-manual-${Date.now().toString(36)}`.slice(0, 63);
    const args = ["create", "job", jobName, `--from=cronjob/${ref.name}`];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    return runOrThrow(args, ref.context);
}

/** Delete with the knobs the web UI exposes: grace period and --force. */
export async function deleteResourceWith(
    ref: ResourceRef,
    opts: { force?: boolean; gracePeriod?: number } = {},
): Promise<string> {
    const args = ["delete", ref.kind, ref.name];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    if (opts.gracePeriod !== undefined) {
        args.push(`--grace-period=${opts.gracePeriod}`);
    }
    if (opts.force) {
        // --force without an explicit grace period is rejected by kubectl.
        if (opts.gracePeriod === undefined) args.push("--grace-period=0");
        args.push("--force");
    }
    return runOrThrow(args, ref.context);
}

/** `kubectl rollout history` rows for a workload, newest first. */
export async function rolloutHistory(ref: ResourceRef): Promise<{ revision: string; change: string }[]> {
    const args = ["rollout", "history", `${ref.kind}/${ref.name}`];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    const result = await run(args, ref.context);
    if (result.code !== 0) return [];
    const rows: { revision: string; change: string }[] = [];
    for (const line of result.stdout.split("\n")) {
        const m = /^(\d+)\s+(.*)$/.exec(line.trim());
        if (m) rows.push({ revision: m[1]!, change: m[2]!.trim() });
    }
    return rows.reverse();
}

export async function rolloutUndo(ref: ResourceRef, revision?: string): Promise<string> {
    const args = ["rollout", "undo", `${ref.kind}/${ref.name}`];
    if (revision) args.push(`--to-revision=${revision}`);
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    return runOrThrow(args, ref.context);
}

/** `kubectl rollout status` in one shot (no --watch) for a status pill. */
export async function rolloutStatus(ref: ResourceRef): Promise<string> {
    const args = ["rollout", "status", `${ref.kind}/${ref.name}`, "--timeout=2s"];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    const result = await run(args, ref.context);
    return (result.stdout || result.stderr).trim();
}

// ── metrics ────────────────────────────────────────────────────────────────

export interface NodeMetrics {
    cpu: string;
    cpuPercent: number | null;
    memory: string;
    memoryPercent: number | null;
}

/**
 * Per-node CPU/memory via `kubectl top nodes`. Like topPods, a cluster without
 * metrics-server gets an empty map instead of an error — metrics are a bonus
 * column, never a precondition for browsing.
 */
export async function topNodes(context: string): Promise<Map<string, NodeMetrics>> {
    const result = await run(["top", "nodes", "--no-headers"], context);
    const map = new Map<string, NodeMetrics>();
    if (result.code !== 0) return map;
    for (const line of result.stdout.split("\n")) {
        const cols = line.trim().split(/\s+/);
        // NAME CPU(cores) CPU% MEMORY(bytes) MEMORY%
        if (cols.length >= 5) {
            map.set(cols[0]!, {
                cpu: cols[1]!,
                cpuPercent: pct(cols[2]!),
                memory: cols[3]!,
                memoryPercent: pct(cols[4]!),
            });
        }
    }
    return map;
}

function pct(value: string): number | null {
    const n = Number(value.replace("%", ""));
    return Number.isFinite(n) ? n : null;
}

/** Cluster-wide (or namespaced) events, newest first. */
export async function listEvents(
    context: string,
    namespace: string | undefined,
    limit = 500,
): Promise<(K8sEvent & { object: string; namespace: string })[]> {
    const args = ["get", "events", "-o", "json"];
    if (namespace) {
        args.push("-n", namespace);
    } else {
        args.push("-A");
    }
    const result = await run(args, context);
    if (result.code !== 0) return [];
    const parsed = JSON.parse(result.stdout) as {
        items?: (RawEvent & {
            metadata?: { namespace?: string };
            involvedObject?: { kind?: string; name?: string };
        })[];
    };
    const rows = (parsed.items ?? []).map((e) => ({
        ...normalizeEvent(e),
        object: `${e.involvedObject?.kind ?? ""}/${e.involvedObject?.name ?? ""}`,
        namespace: e.metadata?.namespace ?? "",
    }));
    rows.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
    return rows.slice(0, limit);
}

export interface ClusterVersion {
    client: string;
    server: string;
    platform: string;
}

export async function clusterVersion(context: string): Promise<ClusterVersion> {
    const result = await run(["version", "-o", "json"], context);
    const out: ClusterVersion = { client: "", server: "", platform: "" };
    if (result.code !== 0 && !result.stdout) return out;
    try {
        const v = JSON.parse(result.stdout) as {
            clientVersion?: { gitVersion?: string };
            serverVersion?: { gitVersion?: string; platform?: string };
        };
        out.client = v.clientVersion?.gitVersion ?? "";
        out.server = v.serverVersion?.gitVersion ?? "";
        out.platform = v.serverVersion?.platform ?? "";
    } catch {
        /* kubectl printed something that isn't json — leave the blanks */
    }
    return out;
}

// ── interactive arg builders (src/web/exec.ts owns the pty and the spawn) ────

/** kubectl argv (sans "kubectl") for an interactive shell into a pod container. */
export function execArgs(ref: ResourceRef, container: string | undefined, shell: string): string[] {
    const args = ["--context", ref.context];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    args.push("exec", "-it", ref.name);
    if (container) {
        args.push("-c", container);
    }
    args.push("--", shell);
    return args;
}

/** kubectl argv (sans "kubectl") for a `port-forward`. mapping is "local:remote". */
export function portForwardArgs(ref: ResourceRef, mapping: string): string[] {
    const args = ["--context", ref.context];
    if (ref.namespace) {
        args.push("-n", ref.namespace);
    }
    args.push("port-forward", `${ref.kind}/${ref.name}`, mapping);
    return args;
}

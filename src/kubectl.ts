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
        if (cols.length >= 3) {
            map.set(cols[0], { cpu: cols[1], memory: cols[2] });
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

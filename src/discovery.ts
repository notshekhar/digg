// Resource discovery via `kubectl api-resources`. Lets digg browse *any* kind
// the cluster exposes — built-ins, CRDs, RBAC, HPAs — not just the curated set
// in format.ts. The curated kinds keep their rich columns + detail pages; every
// other discovered kind falls back to a generic list + yaml/describe/edit/events.

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

export interface DiscoveredResource {
    /** Plural resource name used in `kubectl get <name>` (e.g. "horizontalpodautoscalers"). */
    name: string;
    /** PascalCase singular Kind (e.g. "HorizontalPodAutoscaler") — used for events. */
    kind: string;
    /** apiVersion group/version (e.g. "autoscaling/v2"). */
    apiVersion: string;
    namespaced: boolean;
    shortNames: string[];
}

/**
 * Parse `kubectl api-resources -o wide`. Columns are whitespace-aligned:
 *   NAME  SHORTNAMES  APIVERSION  NAMESPACED  KIND  VERBS  CATEGORIES
 * We locate columns by the header's start offsets so values with internal
 * spaces (VERBS like "[get list ...]") don't shift parsing.
 */
export async function apiResources(context: string): Promise<DiscoveredResource[]> {
    const result = await run(["api-resources", "-o", "wide", "--cached", "--verbs=get"], context);
    if (result.code !== 0) {
        return [];
    }
    return parseApiResources(result.stdout);
}

/** Pure parser for `kubectl api-resources -o wide` output. Exported for tests. */
export function parseApiResources(stdout: string): DiscoveredResource[] {
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    if (lines.length < 2) {
        return [];
    }
    const header = lines[0];
    const at = (label: string): number => header.indexOf(label);
    const col = { name: at("NAME"), short: at("SHORTNAMES"), api: at("APIVERSION"), ns: at("NAMESPACED"), kind: at("KIND") };
    const out: DiscoveredResource[] = [];
    const seen = new Set<string>();
    for (const line of lines.slice(1)) {
        const slice = (from: number, to: number): string => line.slice(from, to < 0 ? undefined : to).trim();
        const name = slice(col.name, col.short);
        if (!name || seen.has(name)) {
            continue;
        }
        seen.add(name);
        const shortRaw = slice(col.short, col.api);
        out.push({
            name,
            shortNames: shortRaw ? shortRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
            apiVersion: slice(col.api, col.ns),
            namespaced: slice(col.ns, col.kind).toLowerCase() === "true",
            kind: slice(col.kind, -1).split(/\s+/)[0] ?? "",
        });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

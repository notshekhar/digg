import { describe, expect, test } from "bun:test";
import { parseApiResources } from "./discovery.ts";

// kubectl pads every column to a fixed width (header included), so build the
// fixture the same way to mirror real `api-resources -o wide` output.
const WIDTHS = [26, 13, 17, 13, 26];
function row(cells: string[]): string {
    return cells.map((c, i) => (i < WIDTHS.length ? c.padEnd(WIDTHS[i]) : c)).join("").trimEnd();
}
const SAMPLE = [
    row(["NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND", "VERBS"]),
    row(["pods", "po", "v1", "true", "Pod", "[get list watch]"]),
    row(["nodes", "no", "v1", "false", "Node", "[get list watch]"]),
    row(["horizontalpodautoscalers", "hpa", "autoscaling/v2", "true", "HorizontalPodAutoscaler", "[get list]"]),
].join("\n");

describe("parseApiResources", () => {
    test("parses columns by header offset", () => {
        const out = parseApiResources(SAMPLE);
        const pod = out.find((r) => r.name === "pods")!;
        expect(pod.kind).toBe("Pod");
        expect(pod.namespaced).toBe(true);
        expect(pod.shortNames).toEqual(["po"]);
    });

    test("captures cluster-scoped resources", () => {
        const node = parseApiResources(SAMPLE).find((r) => r.name === "nodes")!;
        expect(node.namespaced).toBe(false);
        expect(node.kind).toBe("Node");
    });

    test("handles long names and grouped apiVersions", () => {
        const hpa = parseApiResources(SAMPLE).find((r) => r.name === "horizontalpodautoscalers")!;
        expect(hpa.kind).toBe("HorizontalPodAutoscaler");
        expect(hpa.apiVersion).toBe("autoscaling/v2");
        expect(hpa.shortNames).toEqual(["hpa"]);
    });

    test("results are sorted by name", () => {
        const names = parseApiResources(SAMPLE).map((r) => r.name);
        expect(names).toEqual([...names].sort());
    });

    test("empty input yields no resources", () => {
        expect(parseApiResources("")).toEqual([]);
    });
});

import { describe, expect, test } from "bun:test";
import type { K8sObject } from "../kubectl.ts";
import { findKind } from "../format.ts";
import type { UsageColumns } from "./gauges.ts";
import { buildRow, columnsFor, rowFingerprint, statusTone } from "./rows.ts";

const pods = findKind("pods")!;
const ingresses = findKind("ingresses")!;
const nodes = findKind("nodes")!;

const pod = (name: string, ns = "demo"): K8sObject =>
    ({
        kind: "Pod",
        metadata: { name, namespace: ns, creationTimestamp: "2026-07-01T00:00:00Z", labels: { app: "web" } },
        spec: { nodeName: "node-1", containers: [{ name: "app" }] },
        status: { phase: "Running", podIP: "10.0.0.1", containerStatuses: [{ name: "app", ready: true, restartCount: 0 }] },
    }) as K8sObject;

const usageFor = (key: string): UsageColumns => ({
    columns: ["CPU USAGE", "MEMORY USAGE"],
    insertBefore: "AGE",
    byKey: new Map([[key, { cells: ["7m", "40Mi"], meters: [{ pct: 7, mark: 25 }, { pct: 40, mark: 33 }] }]]),
});

describe("columnsFor", () => {
    test("usage columns land before AGE, not after it", () => {
        const { columns, insertAt } = columnsFor(pods, usageFor("demo/web"));
        expect(columns).toEqual(["NAMESPACE", "NAME", "READY", "STATUS", "RESTARTS", "IP", "NODE", "CPU USAGE", "MEMORY USAGE", "AGE"]);
        expect(insertAt).toBe(7);
    });

    test("cluster-scoped kinds get no NAMESPACE column", () => {
        expect(columnsFor(nodes, null).columns[0]).toBe("NAME");
    });

    test("without usage the kind's own columns are untouched", () => {
        expect(columnsFor(pods, null).columns).toEqual(["NAMESPACE", ...pods.columns]);
    });
});

describe("buildRow", () => {
    test("carries cells, tones, timestamp and labels", () => {
        const row = buildRow(pod("web-1"), pods, null, columnsFor(pods, null).insertAt);
        expect(row.name).toBe("web-1");
        expect(row.ns).toBe("demo");
        expect(row.cells[0]).toBe("demo");
        expect(row.cells[3]).toBe("Running");
        expect(row.tones[3]).toBe("ok");
        expect(row.ts).toBe(new Date("2026-07-01T00:00:00Z").getTime());
        expect(row.labels).toEqual({ app: "web" });
    });

    test("usage cells and meters are spliced at the same index as the header", () => {
        const usage = usageFor("demo/web-1");
        const { columns, insertAt } = columnsFor(pods, usage);
        const row = buildRow(pod("web-1"), pods, usage, insertAt);
        expect(row.cells[columns.indexOf("CPU USAGE")]).toBe("7m");
        expect(row.cells[columns.indexOf("MEMORY USAGE")]).toBe("40Mi");
        expect(row.meters?.[columns.indexOf("CPU USAGE")]).toEqual({ pct: 7, mark: 25 });
        // AGE must still be the last cell, not pushed off the end.
        expect(row.cells).toHaveLength(columns.length);
    });

    test("a row the metrics pass never saw keeps its shape", () => {
        // A pod created between the list and the top call has no metrics; its
        // columns must still line up with the header.
        const usage = usageFor("demo/someone-else");
        const { columns, insertAt } = columnsFor(pods, usage);
        const row = buildRow(pod("web-1"), pods, usage, insertAt);
        expect(row.cells).toHaveLength(columns.length);
        expect(row.cells[columns.indexOf("CPU USAGE")]).toBe("—");
        expect(row.meters).toBeUndefined();
    });

    test("ingress rows carry routes and ask for extra height", () => {
        const ing = {
            kind: "Ingress",
            metadata: { name: "web", namespace: "demo" },
            spec: {
                rules: [
                    { host: "a.example.com", http: { paths: [{ path: "/", backend: { service: { name: "a", port: { number: 80 } } } }] } },
                    { host: "b.example.com", http: { paths: [{ path: "/x", backend: { service: { name: "b", port: { number: 90 } } } }] } },
                ],
            },
        } as unknown as K8sObject;
        const row = buildRow(ing, ingresses, null, columnsFor(ingresses, null).insertAt);
        expect(row.rules).toHaveLength(2);
        expect(row.rules?.[0]?.url).toBe("http://a.example.com/");
        expect(row.lines).toBe(2);
    });

    test("a single-rule ingress stays one line tall", () => {
        const ing = {
            kind: "Ingress",
            metadata: { name: "web", namespace: "demo" },
            spec: { rules: [{ host: "a.example.com", http: { paths: [{ path: "/", backend: { service: { name: "a", port: { number: 80 } } } }] } }] },
        } as unknown as K8sObject;
        expect(buildRow(ing, ingresses, null, 0).lines).toBeUndefined();
    });

    test("the same object always renders the same row", () => {
        // The live socket and /api/list share this builder precisely so a
        // streamed row and a polled row cannot disagree and make the table
        // flicker when it switches between them.
        const insertAt = columnsFor(pods, null).insertAt;
        const a = buildRow(pod("web-1"), pods, null, insertAt);
        const b = buildRow(pod("web-1"), pods, null, insertAt);
        expect(rowFingerprint(a)).toBe(rowFingerprint(b));
    });

    test("a changed status changes the fingerprint", () => {
        const insertAt = columnsFor(pods, null).insertAt;
        const before = buildRow(pod("web-1"), pods, null, insertAt);
        const crashed = pod("web-1");
        (crashed.status as { containerStatuses: unknown[] }).containerStatuses = [
            { name: "app", ready: false, restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } } },
        ];
        const after = buildRow(crashed, pods, null, insertAt);
        expect(rowFingerprint(after)).not.toBe(rowFingerprint(before));
        expect(after.cells[3]).toBe("CrashLoopBackOff");
        expect(after.tones[3]).toBe("bad");
    });
});

describe("statusTone", () => {
    test("classifies the words that matter", () => {
        expect(statusTone("Running")).toBe("ok");
        expect(statusTone("Pending")).toBe("warn");
        expect(statusTone("CrashLoopBackOff")).toBe("bad");
        expect(statusTone("ealen/echo-server:latest")).toBe("neutral");
    });
});

import { describe, expect, test } from "bun:test";
import type { K8sObject } from "./kubectl.ts";
import {
    addGauge,
    containerAllocation,
    metricsFromContainers,
    metricsView,
    podAllocation,
    selectorMatches,
} from "./usage.ts";

const pod = (spec: Record<string, unknown>, metadata: Record<string, unknown> = {}): K8sObject =>
    ({ kind: "Pod", metadata, spec }) as K8sObject;

describe("allocation", () => {
    test("parses a container's requests and limits into cores and bytes", () => {
        const alloc = containerAllocation({
            name: "web",
            resources: { requests: { cpu: "250m", memory: "64Mi" }, limits: { cpu: "1", memory: "1Gi" } },
        });
        expect(alloc.cpu.requests).toBeCloseTo(0.25);
        expect(alloc.cpu.limits).toBe(1);
        expect(alloc.mem.requests).toBe(64 * 1024 * 1024);
        expect(alloc.mem.limits).toBe(1024 ** 3);
    });

    test("a pod's request is the sum of its containers", () => {
        const alloc = podAllocation(
            pod({
                containers: [
                    { name: "a", resources: { requests: { cpu: "100m", memory: "32Mi" } } },
                    { name: "b", resources: { requests: { cpu: "150m", memory: "32Mi" } } },
                ],
            }),
        );
        expect(alloc.cpu.requests).toBeCloseTo(0.25);
        expect(alloc.mem.requests).toBe(64 * 1024 * 1024);
    });

    test("init containers count as a maximum, not as an addition", () => {
        // They never run alongside the app containers, so the scheduler takes
        // the larger of the two — adding them would overstate the pod.
        const alloc = podAllocation(
            pod({
                initContainers: [{ name: "migrate", resources: { requests: { cpu: "2" } } }],
                containers: [{ name: "web", resources: { requests: { cpu: "100m" } } }],
            }),
        );
        expect(alloc.cpu.requests).toBe(2);
    });

    test("a pod template is read through spec.template", () => {
        const deployment = {
            kind: "Deployment",
            spec: { template: { spec: { containers: [{ name: "web", resources: { limits: { cpu: "500m" } } }] } } },
        } as K8sObject;
        expect(podAllocation(deployment).cpu.limits).toBeCloseTo(0.5);
    });

    test("adding gauges keeps unknown usage unknown", () => {
        const unknown = { used: null, requests: 1, limits: 2 };
        expect(addGauge(unknown, unknown).used).toBeNull();
        expect(addGauge(unknown, { used: 3, requests: 0, limits: 0 }).used).toBe(3);
    });
});

describe("selectorMatches", () => {
    const labelled = (labels: Record<string, string>) => pod({}, { labels });

    test("matches on matchLabels", () => {
        expect(selectorMatches(labelled({ app: "web", tier: "x" }), { matchLabels: { app: "web" } })).toBe(true);
        expect(selectorMatches(labelled({ app: "api" }), { matchLabels: { app: "web" } })).toBe(false);
    });

    test("handles matchExpressions", () => {
        const obj = labelled({ app: "web" });
        expect(selectorMatches(obj, { matchExpressions: [{ key: "app", operator: "In", values: ["web", "api"] }] })).toBe(true);
        expect(selectorMatches(obj, { matchExpressions: [{ key: "app", operator: "NotIn", values: ["web"] }] })).toBe(false);
        expect(selectorMatches(obj, { matchExpressions: [{ key: "app", operator: "Exists" }] })).toBe(true);
        expect(selectorMatches(obj, { matchExpressions: [{ key: "gone", operator: "DoesNotExist" }] })).toBe(true);
    });

    test("an empty selector matches nothing, not everything", () => {
        // A workload with no selector must not adopt the whole namespace.
        expect(selectorMatches(labelled({ app: "web" }), {})).toBe(false);
        expect(selectorMatches(labelled({ app: "web" }), undefined)).toBe(false);
    });
});

describe("metrics lookups", () => {
    test("namespace-qualified keys win over bare names", () => {
        const view = metricsView(
            new Map([
                ["demo/web", { cpu: "10m", memory: "20Mi" }],
                ["web", { cpu: "999m", memory: "999Mi" }],
            ]),
        );
        expect(view.pod("web", "demo")!.cpu).toBeCloseTo(0.01);
        expect(view.pod("web")!.cpu).toBeCloseTo(0.999);
    });

    test("pod totals are summed from container rows", () => {
        const view = metricsFromContainers(
            new Map([
                ["demo/web/app", { cpu: "10m", memory: "20Mi" }],
                ["demo/web/sidecar", { cpu: "5m", memory: "10Mi" }],
            ]),
        );
        expect(view.pod("web", "demo")!.cpu).toBeCloseTo(0.015);
        expect(view.pod("web", "demo")!.mem).toBe(30 * 1024 * 1024);
        expect(view.container("web", "sidecar", "demo")!.cpu).toBeCloseTo(0.005);
        expect(view.available).toBe(true);
    });

    test("no metrics-server means unknown, never zero", () => {
        const view = metricsView(new Map());
        expect(view.available).toBe(false);
        expect(view.pod("web", "demo")).toBeNull();
    });
});

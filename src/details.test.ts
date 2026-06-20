import { describe, expect, test } from "bun:test";
import type { K8sObject, PodMetrics } from "./kubectl.ts";
import { detailModel, ingressRuleRows, jobOwnedByCronJob, podMountsPVC } from "./details.ts";

const noTop = new Map<string, PodMetrics>();

describe("ingressRuleRows", () => {
    test("flattens host/path/service/port", () => {
        const ing = {
            spec: {
                rules: [
                    {
                        host: "app.example.com",
                        http: { paths: [{ path: "/", backend: { service: { name: "web", port: { number: 80 } } } }] },
                    },
                ],
            },
        } as unknown as K8sObject;
        expect(ingressRuleRows(ing)).toEqual([["app.example.com", "/", "web", "80"]]);
    });

    test("uses * when host is omitted", () => {
        const ing = { spec: { rules: [{ http: { paths: [{ path: "/api" }] } }] } } as unknown as K8sObject;
        expect(ingressRuleRows(ing)[0][0]).toBe("*");
    });
});

describe("podMountsPVC", () => {
    const pod = {
        spec: { volumes: [{ persistentVolumeClaim: { claimName: "data" } }, { emptyDir: {} }] },
    } as unknown as K8sObject;
    test("true when a volume references the claim", () => {
        expect(podMountsPVC(pod, "data")).toBe(true);
    });
    test("false otherwise", () => {
        expect(podMountsPVC(pod, "other")).toBe(false);
    });
});

describe("jobOwnedByCronJob", () => {
    test("matches ownerReference kind+name", () => {
        const job = { metadata: { ownerReferences: [{ kind: "CronJob", name: "nightly" }] } } as unknown as K8sObject;
        expect(jobOwnedByCronJob(job, "nightly")).toBe(true);
        expect(jobOwnedByCronJob(job, "other")).toBe(false);
    });
});

describe("detailModel", () => {
    test("service builds an endpointPods section from its selector", () => {
        const svc = {
            metadata: { name: "api", namespace: "default" },
            spec: { type: "ClusterIP", clusterIP: "10.0.0.1", selector: { app: "api" }, ports: [{ port: 80, targetPort: 8080 }] },
        } as unknown as K8sObject;
        const model = detailModel("services", svc, false, noTop);
        expect(model.section?.type).toBe("endpointPods");
        expect(model.summary.find(([k]) => k === "Selector")?.[1]).toBe("app=api");
    });

    test("node builds a nodePods section", () => {
        const node = { metadata: { name: "node-1" }, status: { nodeInfo: { kubeletVersion: "v1.29.0" } } } as unknown as K8sObject;
        const model = detailModel("nodes", node, false, noTop);
        expect(model.section).toEqual({ type: "nodePods", title: "Pods on node", node: "node-1" });
    });

    test("unknown kinds still get a summary (no dead end)", () => {
        const crd = { metadata: { name: "x", namespace: "default" }, apiVersion: "example.com/v1" } as unknown as K8sObject;
        const model = detailModel("widgets", crd, false, noTop);
        expect(model.summary.length).toBeGreaterThan(0);
        expect(model.section).toBeUndefined();
    });

    test("pod summary injects live CPU/Mem from metrics", () => {
        const pod = { metadata: { name: "web" }, status: { phase: "Running" } } as unknown as K8sObject;
        const top = new Map<string, PodMetrics>([["web", { cpu: "5m", memory: "20Mi" }]]);
        const model = detailModel("pods", pod, false, top);
        expect(model.summary.find(([k]) => k === "CPU / Mem")?.[1]).toBe("5m / 20Mi");
    });
});

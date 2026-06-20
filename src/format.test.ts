import { describe, expect, test } from "bun:test";
import type { K8sObject } from "./kubectl.ts";
import { findKind, genericKind, jobStatus, nodeRoles, podPhase, pvcAccessModes } from "./format.ts";

describe("podPhase", () => {
    test("surfaces a waiting reason over phase", () => {
        const pod = {
            status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason: "CrashLoopBackOff" } } }] },
        } as unknown as K8sObject;
        expect(podPhase(pod)).toBe("CrashLoopBackOff");
    });

    test("reports Terminating when deletionTimestamp is set", () => {
        const pod = { metadata: { deletionTimestamp: "2020-01-01T00:00:00Z" }, status: { phase: "Running" } } as K8sObject;
        expect(podPhase(pod)).toBe("Terminating");
    });

    test("falls back to phase when containers are healthy", () => {
        const pod = {
            status: { phase: "Running", containerStatuses: [{ state: { terminated: { reason: "Completed" } } }] },
        } as unknown as K8sObject;
        expect(podPhase(pod)).toBe("Running");
    });
});

describe("jobStatus", () => {
    test("Complete when the Complete condition is True", () => {
        const job = { status: { conditions: [{ type: "Complete", status: "True" }] } } as unknown as K8sObject;
        expect(jobStatus(job)).toBe("Complete");
    });
    test("Failed when the Failed condition is True", () => {
        const job = { status: { conditions: [{ type: "Failed", status: "True" }] } } as unknown as K8sObject;
        expect(jobStatus(job)).toBe("Failed");
    });
    test("Running when there are active pods", () => {
        const job = { status: { active: 2 } } as unknown as K8sObject;
        expect(jobStatus(job)).toBe("Running");
    });
});

describe("nodeRoles", () => {
    test("extracts roles from node-role labels", () => {
        const node = {
            metadata: { labels: { "node-role.kubernetes.io/control-plane": "", "node-role.kubernetes.io/worker": "" } },
        } as unknown as K8sObject;
        expect(nodeRoles(node)).toBe("control-plane,worker");
    });
    test("<none> with no role labels", () => {
        const node = { metadata: { labels: { foo: "bar" } } } as K8sObject;
        expect(nodeRoles(node)).toBe("<none>");
    });
});

describe("pvcAccessModes", () => {
    test("abbreviates access modes", () => {
        const pvc = { status: { accessModes: ["ReadWriteOnce", "ReadOnlyMany"] } } as unknown as K8sObject;
        expect(pvcAccessModes(pvc)).toBe("RWO,ROX");
    });
});

describe("KINDS rows", () => {
    test("pod row carries IP and NODE", () => {
        const pod = {
            metadata: { name: "web", creationTimestamp: new Date().toISOString() },
            spec: { nodeName: "node-1", containers: [{ name: "c" }] },
            status: { phase: "Running", podIP: "10.0.0.5", containerStatuses: [{ ready: true, restartCount: 0 }] },
        } as unknown as K8sObject;
        const row = findKind("pods")!.row(pod);
        // [NAME, READY, STATUS, RESTARTS, IP, NODE, AGE]
        expect(row[0]).toBe("web");
        expect(row[4]).toBe("10.0.0.5");
        expect(row[5]).toBe("node-1");
    });
});

describe("genericKind", () => {
    test("builds a namespaced generic kind from discovery", () => {
        const k = genericKind({ name: "widgets", kind: "Widget", namespaced: true });
        expect(k.name).toBe("widgets");
        expect(k.kind).toBe("Widget");
        expect(k.generic).toBe(true);
        expect(k.clusterScoped).toBe(false);
        expect(k.columns).toEqual(["NAME", "STATUS", "AGE"]);
    });
    test("cluster-scoped when not namespaced", () => {
        const k = genericKind({ name: "clusterthings", kind: "ClusterThing", namespaced: false });
        expect(k.clusterScoped).toBe(true);
    });
});

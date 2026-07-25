import { describe, expect, test } from "bun:test";
import type { K8sObject } from "./kubectl.ts";
import { findKind, genericKind, ingressRoutes, jobStatus, nodeRoles, podPhase, pvcAccessModes } from "./format.ts";

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

describe("ingressRoutes", () => {
    const ing = {
        spec: {
            tls: [{ hosts: ["secure.example.com"], secretName: "tls" }],
            rules: [
                {
                    host: "secure.example.com",
                    http: { paths: [{ path: "/", backend: { service: { name: "web", port: { number: 8080 } } } }] },
                },
                {
                    host: "plain.example.com",
                    http: { paths: [{ path: "/api", backend: { service: { name: "api", port: { name: "http" } } } }] },
                },
            ],
        },
    } as unknown as K8sObject;

    test("a TLS host gets an https URL, everything else http", () => {
        const routes = ingressRoutes(ing);
        expect(routes[0]).toEqual({
            url: "https://secure.example.com/",
            host: "secure.example.com",
            path: "/",
            service: "web",
            port: "8080",
        });
        expect(routes[1]!.url).toBe("http://plain.example.com/api");
        expect(routes[1]!.port).toBe("http");
    });

    test("a wildcard host has no URL to open", () => {
        const wild = { spec: { rules: [{ http: { paths: [{ path: "/", backend: {} }] } }] } } as unknown as K8sObject;
        expect(ingressRoutes(wild)[0]).toMatchObject({ host: "*", url: "" });
    });

    test("the ingress row lists every route", () => {
        const row = findKind("ingresses")!.row(ing);
        expect(row[1]).toContain("https://secure.example.com/ → web:8080");
        expect(row[1]).toContain("http://plain.example.com/api → api:http");
        expect(row[3]).toBe("Pending");
    });
});

import { describe, expect, test } from "bun:test";
import { buildCatalog, catalogKinds } from "./catalog.ts";
import type { DiscoveredResource } from "../discovery.ts";

const res = (name: string, kind: string, apiVersion: string, namespaced = true): DiscoveredResource => ({
    name,
    kind,
    apiVersion,
    namespaced,
    shortNames: [],
});

const CORE: DiscoveredResource[] = [
    res("pods", "Pod", "v1"),
    res("services", "Service", "v1"),
    res("nodes", "Node", "v1", false),
    res("namespaces", "Namespace", "v1", false),
    res("events", "Event", "v1"),
    res("deployments", "Deployment", "apps/v1"),
    res("secrets", "Secret", "v1"),
    res("persistentvolumeclaims", "PersistentVolumeClaim", "v1"),
    res("clusterroles", "ClusterRole", "rbac.authorization.k8s.io/v1", false),
];

describe("buildCatalog", () => {
    test("groups curated kinds in rail order", () => {
        const groups = buildCatalog(CORE);
        expect(groups.map((g) => g.id)).toEqual(["cluster", "workloads", "config", "network", "storage", "access"]);
        expect(groups[0]!.kinds.map((k) => k.name)).toEqual(["nodes", "namespaces", "events"]);
    });

    test("never lists a kind the cluster does not have", () => {
        // A cluster with only pods must not show EndpointSlices or HPAs.
        const groups = buildCatalog([res("pods", "Pod", "v1")]);
        const names = catalogKinds(groups).map((k) => k.name);
        expect(names).toEqual(["pods"]);
    });

    test("never hides a kind the cluster does have", () => {
        const groups = buildCatalog([...CORE, res("widgets", "Widget", "example.com/v1")]);
        const names = catalogKinds(groups).map((k) => k.name);
        expect(names).toContain("widgets");
        const custom = groups.find((g) => g.id === "crd:example.com");
        expect(custom?.title).toBe("example.com");
        expect(custom?.kinds[0]!.generic).toBe(true);
    });

    test("built-in groups are not mistaken for CRDs", () => {
        const groups = buildCatalog([...CORE, res("csidrivers", "CSIDriver", "storage.k8s.io/v1", false)]);
        expect(groups.some((g) => g.id.startsWith("crd:"))).toBe(false);
        expect(groups.find((g) => g.id === "other")?.kinds.map((k) => k.name)).toContain("csidrivers");
    });

    test("resource.k8s.io (DRA) is built in, not somebody's CRD", () => {
        const groups = buildCatalog([...CORE, res("resourceclaims", "ResourceClaim", "resource.k8s.io/v1")]);
        expect(groups.some((g) => g.id === "crd:resource.k8s.io")).toBe(false);
    });

    test("empty discovery still yields a usable sidebar", () => {
        // api-resources can fail on a restricted cluster; an empty rail would
        // leave no way to browse at all.
        const groups = buildCatalog([]);
        expect(groups.length).toBeGreaterThan(3);
        expect(catalogKinds(groups).some((k) => k.name === "pods")).toBe(true);
    });

    test("cluster-scoped flag survives into the catalog", () => {
        const groups = buildCatalog(CORE);
        const nodes = catalogKinds(groups).find((k) => k.name === "nodes");
        expect(nodes?.clusterScoped).toBe(true);
        const pods = catalogKinds(groups).find((k) => k.name === "pods");
        expect(pods?.clusterScoped).toBe(false);
    });
});

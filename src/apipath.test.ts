import { describe, expect, test } from "bun:test";
import { groupPath, resourcePath, withQuery } from "./apipath.ts";

describe("groupPath", () => {
    test("core resources live under /api", () => {
        expect(groupPath("v1")).toBe("/api/v1");
    });

    test("everything else lives under /apis", () => {
        expect(groupPath("apps/v1")).toBe("/apis/apps/v1");
        expect(groupPath("metrics.k8s.io/v1beta1")).toBe("/apis/metrics.k8s.io/v1beta1");
    });
});

describe("resourcePath", () => {
    const pods = { name: "pods", apiVersion: "v1", namespaced: true };
    const nodes = { name: "nodes", apiVersion: "v1", namespaced: false };
    const deployments = { name: "deployments", apiVersion: "apps/v1", namespaced: true };

    test("collection across every namespace", () => {
        expect(resourcePath(pods)).toBe("/api/v1/pods");
    });

    test("collection in one namespace", () => {
        expect(resourcePath(pods, { namespace: "demo" })).toBe("/api/v1/namespaces/demo/pods");
    });

    test("one object", () => {
        expect(resourcePath(pods, { namespace: "demo", objectName: "api-7d9f" })).toBe(
            "/api/v1/namespaces/demo/pods/api-7d9f",
        );
    });

    test("a grouped kind", () => {
        expect(resourcePath(deployments, { namespace: "demo", objectName: "api" })).toBe(
            "/apis/apps/v1/namespaces/demo/deployments/api",
        );
    });

    test("a cluster-scoped kind never gets a namespace segment", () => {
        expect(resourcePath(nodes, { namespace: "demo" })).toBe("/api/v1/nodes");
    });

    test("names are escaped", () => {
        expect(resourcePath(pods, { namespace: "a b", objectName: "c/d" })).toBe("/api/v1/namespaces/a%20b/pods/c%2Fd");
    });

    test("subresources hang off the object", () => {
        expect(resourcePath(pods, { namespace: "demo", objectName: "p", subresource: "log" })).toBe(
            "/api/v1/namespaces/demo/pods/p/log",
        );
    });
});

describe("withQuery", () => {
    test("no options means no query string", () => {
        expect(withQuery("/api/v1/pods")).toBe("/api/v1/pods");
    });

    test("resourceVersion=0 survives — it means the server's cache, not 'unset'", () => {
        expect(withQuery("/api/v1/pods", { resourceVersion: "0" })).toBe("/api/v1/pods?resourceVersion=0");
    });

    test("a watch carries its version, bookmarks and timeout", () => {
        expect(
            withQuery("/api/v1/pods", {
                watch: true,
                resourceVersion: "12345",
                allowWatchBookmarks: true,
                timeoutSeconds: 290,
            }),
        ).toBe("/api/v1/pods?resourceVersion=12345&watch=1&allowWatchBookmarks=true&timeoutSeconds=290");
    });

    test("selectors are escaped", () => {
        expect(withQuery("/api/v1/events", { fieldSelector: "involvedObject.name=a b" })).toBe(
            "/api/v1/events?fieldSelector=involvedObject.name%3Da+b",
        );
    });
});

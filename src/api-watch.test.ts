/**
 * The API watch, driven through a fake proxy: no cluster, no sockets.
 *
 * What matters here is the behaviour the kubectl watch could not have — that a
 * closed stream resumes from its resourceVersion instead of re-listing, and
 * that only a 410 sends us back to a list.
 */

import { describe, expect, test } from "bun:test";
import { ApiResourceWatch } from "./api-watch.ts";
import type { K8sObject } from "./kubectl.ts";
import type { KubeProxy } from "./proxy.ts";

const coords = { name: "pods", apiVersion: "v1", namespaced: true };

function pod(name: string, resourceVersion: string): K8sObject {
    return { kind: "Pod", metadata: { name, namespace: "demo", resourceVersion } } as K8sObject;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A watch response that emits the given frames and then closes, like a timeout. */
function streamResponse(frames: unknown[], status = 200): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            for (const f of frames) controller.enqueue(encoder.encode(`${JSON.stringify(f)}\n`));
            controller.close();
        },
    });
    return new Response(body, { status });
}

interface Recorded {
    snapshots: K8sObject[][];
    events: { type: string; name: string }[];
    errors: { message: string; permanent: boolean }[];
}

/**
 * Runs a watch against a scripted list of responses and resolves once they have
 * all been consumed. `paths` records what was actually requested — the point of
 * most of these tests.
 */
async function drive(responses: ((path: string) => Response)[]): Promise<Recorded & { paths: string[] }> {
    const paths: string[] = [];
    const rec: Recorded = { snapshots: [], events: [], errors: [] };
    let done: () => void;
    const finished = new Promise<void>((resolve) => {
        done = resolve;
    });
    let i = 0;
    const proxy: KubeProxy = {
        socket: "test",
        fetch: (path: string) => {
            paths.push(path);
            const next = responses[i++];
            if (!next) {
                done();
                // Park: the watch loop would otherwise spin on the fake proxy.
                return new Promise<Response>(() => {});
            }
            return Promise.resolve(next(path));
        },
    };
    const watch = new ApiResourceWatch(
        { context: "test", kind: "pods", namespace: "demo", proxy, coords, setTimer: (fn) => setTimeout(fn, 0) },
        {
            onSnapshot: (objects) => rec.snapshots.push(objects),
            onEvent: (e) => rec.events.push({ type: e.type, name: e.object.metadata?.name ?? "" }),
            onError: (message, permanent) => {
                rec.errors.push({ message, permanent });
                // A permanent failure ends the loop, so no further request is
                // coming to signal the end of the script.
                if (permanent) done();
            },
        },
    );
    watch.start();
    await finished;
    watch.stop();
    return { ...rec, paths };
}

describe("ApiResourceWatch", () => {
    test("lists from the server's cache, then watches from the list's version", async () => {
        const rec = await drive([
            () => jsonResponse({ items: [pod("a", "10")], metadata: { resourceVersion: "42" } }),
            () => streamResponse([{ type: "ADDED", object: pod("b", "43") }]),
        ]);

        expect(rec.paths[0]).toBe("/api/v1/namespaces/demo/pods?resourceVersion=0");
        expect(rec.snapshots).toEqual([[pod("a", "10")]]);
        expect(rec.paths[1]).toContain("resourceVersion=42");
        expect(rec.paths[1]).toContain("watch=1");
        expect(rec.events).toEqual([{ type: "ADDED", name: "b" }]);
    });

    test("a closed stream resumes from the last event, and does NOT re-list", async () => {
        const rec = await drive([
            () => jsonResponse({ items: [], metadata: { resourceVersion: "42" } }),
            () => streamResponse([{ type: "MODIFIED", object: pod("a", "77") }]),
            () => streamResponse([]),
        ]);

        // Exactly one list, and the second watch picks up where the first left off.
        expect(rec.snapshots).toHaveLength(1);
        expect(rec.paths.filter((p) => !p.includes("watch=1"))).toHaveLength(1);
        expect(rec.paths[2]).toContain("resourceVersion=77");
    });

    test("a bookmark advances the version without showing anything", async () => {
        const rec = await drive([
            () => jsonResponse({ items: [], metadata: { resourceVersion: "42" } }),
            () => streamResponse([{ type: "BOOKMARK", object: { metadata: { resourceVersion: "500" } } }]),
            () => streamResponse([]),
        ]);

        expect(rec.events).toEqual([]);
        expect(rec.paths[2]).toContain("resourceVersion=500");
    });

    test("410 Gone re-lists instead of erroring", async () => {
        const rec = await drive([
            () => jsonResponse({ items: [], metadata: { resourceVersion: "42" } }),
            () => jsonResponse({ kind: "Status", code: 410, message: "too old resource version" }, 410),
            () => jsonResponse({ items: [pod("a", "99")], metadata: { resourceVersion: "100" } }),
            () => streamResponse([]),
        ]);

        expect(rec.errors).toEqual([]);
        expect(rec.snapshots).toHaveLength(2);
        expect(rec.paths[3]).toContain("resourceVersion=100");
    });

    test("an ERROR frame carrying 410 also re-lists", async () => {
        const rec = await drive([
            () => jsonResponse({ items: [], metadata: { resourceVersion: "42" } }),
            () => streamResponse([{ type: "ERROR", object: { kind: "Status", code: 410, reason: "Expired" } }]),
            () => jsonResponse({ items: [], metadata: { resourceVersion: "200" } }),
            () => streamResponse([]),
        ]);

        expect(rec.errors).toEqual([]);
        expect(rec.snapshots).toHaveLength(2);
    });

    test("forbidden is permanent, and the message is the API's own", async () => {
        const rec = await drive([
            () => jsonResponse({ kind: "Status", code: 403, message: 'pods is forbidden: User "x" cannot list' }, 403),
        ]);

        expect(rec.errors).toEqual([{ message: 'pods is forbidden: User "x" cannot list', permanent: true }]);
    });

    test("a 500 is transient — it is retried, not reported as fatal", async () => {
        const rec = await drive([
            () => jsonResponse({ message: "etcd is having a moment" }, 500),
            () => jsonResponse({ items: [], metadata: { resourceVersion: "1" } }),
            () => streamResponse([]),
        ]);

        expect(rec.errors).toEqual([{ message: "etcd is having a moment", permanent: false }]);
        expect(rec.snapshots).toHaveLength(1);
    });

    test("a cluster-scoped kind asks for the unnamespaced collection", async () => {
        const paths: string[] = [];
        const proxy: KubeProxy = {
            socket: "test",
            fetch: (path) => {
                paths.push(path);
                if (paths.length === 1) {
                    return Promise.resolve(jsonResponse({ items: [], metadata: { resourceVersion: "1" } }));
                }
                return new Promise<Response>(() => {});
            },
        };
        const watch = new ApiResourceWatch(
            {
                context: "test",
                kind: "nodes",
                namespace: "demo",
                clusterScoped: true,
                proxy,
                coords: { name: "nodes", apiVersion: "v1", namespaced: false },
            },
            { onSnapshot: () => {}, onEvent: () => {}, onError: () => {} },
        );
        watch.start();
        await Bun.sleep(20);
        watch.stop();

        expect(paths[0]).toBe("/api/v1/nodes?resourceVersion=0");
    });
});

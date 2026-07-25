import { describe, expect, test } from "bun:test";
import type { K8sObject } from "./kubectl.ts";
import {
    type WatchProcess,
    ResourceWatch,
    createJsonSplitter,
    isPermanentWatchFailure,
    objectKey,
} from "./watch.ts";

describe("createJsonSplitter", () => {
    test("splits one compact document per line (kubectl 1.35)", () => {
        const split = createJsonSplitter();
        const docs = split('{"type":"ADDED","object":{"kind":"Pod"}}\n{"type":"MODIFIED","object":{"kind":"Pod"}}\n');
        expect(docs).toHaveLength(2);
        expect(JSON.parse(docs[0]!).type).toBe("ADDED");
    });

    test("splits pretty-printed documents (older kubectl)", () => {
        const split = createJsonSplitter();
        const docs = split('{\n  "type": "ADDED",\n  "object": {\n    "kind": "Pod"\n  }\n}\n{\n  "type": "DELETED",\n  "object": {}\n}');
        expect(docs).toHaveLength(2);
        expect(JSON.parse(docs[1]!).type).toBe("DELETED");
    });

    test("reassembles a document split across chunks", () => {
        const split = createJsonSplitter();
        expect(split('{"type":"ADD')).toEqual([]);
        expect(split('ED","object":{"kind"')).toEqual([]);
        const docs = split(':"Pod"}}');
        expect(docs).toHaveLength(1);
        expect(JSON.parse(docs[0]!).object.kind).toBe("Pod");
    });

    test("braces inside strings do not frame a document", () => {
        const split = createJsonSplitter();
        // Annotations routinely contain serialised JSON — last-applied-config
        // is a whole manifest inside one string value.
        const doc = JSON.stringify({ type: "ADDED", object: { metadata: { annotations: { a: '{"nested":"}}}"}' } } } });
        const docs = split(`${doc}\n`);
        expect(docs).toHaveLength(1);
        expect(JSON.parse(docs[0]!).object.metadata.annotations.a).toBe('{"nested":"}}}"}');
    });

    test("escaped quotes inside strings are respected", () => {
        const split = createJsonSplitter();
        const doc = JSON.stringify({ type: "ADDED", object: { metadata: { name: 'a"b{' } } });
        expect(split(doc)).toHaveLength(1);
    });
});

describe("isPermanentWatchFailure", () => {
    test("aggregated APIs that only list are permanent", () => {
        expect(
            isPermanentWatchFailure('Error from server (MethodNotAllowed): watch is not supported on resources of kind "pods.metrics.k8s.io"'),
        ).toBe(true);
    });

    test("RBAC denial is permanent", () => {
        expect(isPermanentWatchFailure('Error from server (Forbidden): pods is forbidden: User "x" cannot watch')).toBe(true);
    });

    test("a network blip is not permanent", () => {
        expect(isPermanentWatchFailure("Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout")).toBe(false);
    });
});

describe("ResourceWatch", () => {
    /** A scriptable stand-in for `kubectl get --watch`. */
    function fakeProcess(chunks: string[], opts: { stderr?: string; code?: number } = {}) {
        let exit: (code: number) => void = () => {};
        const exited = new Promise<number>((r) => (exit = r));
        let killed = false;
        const stdout = new ReadableStream<Uint8Array>({
            start(controller) {
                const enc = new TextEncoder();
                for (const c of chunks) controller.enqueue(enc.encode(c));
                if (opts.code !== undefined) {
                    controller.close();
                } else {
                    // Stay open like a real watch until killed.
                    setTimeout(() => {
                        try {
                            controller.close();
                        } catch {
                            /* already closed */
                        }
                    }, 50);
                }
            },
        });
        const stderr = new ReadableStream<Uint8Array>({
            start(controller) {
                if (opts.stderr) controller.enqueue(new TextEncoder().encode(opts.stderr));
                controller.close();
            },
        });
        const proc: WatchProcess = {
            stdout,
            stderr,
            exited,
            kill: () => {
                killed = true;
                exit(0);
            },
        };
        // Real kubectl exits on its own for the failure cases.
        if (opts.code !== undefined) setTimeout(() => exit(opts.code!), 10);
        return { proc, wasKilled: () => killed };
    }

    const event = (type: string, name: string, ns = "demo") =>
        `${JSON.stringify({ type, object: { kind: "Pod", metadata: { name, namespace: ns } } })}\n`;

    test("the initial burst arrives as one snapshot, then events stream", async () => {
        const snapshots: K8sObject[][] = [];
        const events: string[] = [];
        const { proc } = fakeProcess([event("ADDED", "a"), event("ADDED", "b")]);
        const watch = new ResourceWatch(
            { context: "c", kind: "pods", namespace: "demo", spawn: () => proc },
            {
                onSnapshot: (objects) => snapshots.push(objects),
                onEvent: (e) => events.push(`${e.type}:${e.object.metadata?.name}`),
                onError: () => {},
            },
        );
        watch.start();
        await Bun.sleep(500);
        watch.stop();

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]!.map((o) => o.metadata?.name)).toEqual(["a", "b"]);
        expect(events).toEqual([]); // nothing arrived after the burst
    });

    test("a delete inside the initial burst never reaches the snapshot", async () => {
        // kubectl re-lists on reconnect; an object that appears and disappears
        // during that burst must not show up as an existing row.
        const snapshots: K8sObject[][] = [];
        const { proc } = fakeProcess([event("ADDED", "a"), event("ADDED", "b"), event("DELETED", "a")]);
        const watch = new ResourceWatch(
            { context: "c", kind: "pods", namespace: "demo", spawn: () => proc },
            { onSnapshot: (o) => snapshots.push(o), onEvent: () => {}, onError: () => {} },
        );
        watch.start();
        await Bun.sleep(500);
        watch.stop();
        expect(snapshots[0]!.map((o) => o.metadata?.name)).toEqual(["b"]);
    });

    test("a kind that cannot be watched reports a permanent failure and stops", async () => {
        const errors: { message: string; permanent: boolean }[] = [];
        let spawns = 0;
        const watch = new ResourceWatch(
            {
                context: "c",
                kind: "componentstatuses",
                spawn: () => {
                    spawns++;
                    return fakeProcess([], {
                        // kubectl prints its deprecation warning FIRST and the
                        // real reason last; the message must be the reason.
                        stderr:
                            'Warning: v1 ComponentStatus is deprecated in v1.19+\nError from server (MethodNotAllowed): watch is not supported on resources of kind "componentstatuses"\n',
                        code: 1,
                    }).proc;
                },
            },
            { onSnapshot: () => {}, onEvent: () => {}, onError: (message, permanent) => errors.push({ message, permanent }) },
        );
        watch.start();
        await Bun.sleep(600);
        watch.stop();

        expect(errors).toHaveLength(1);
        expect(errors[0]!.permanent).toBe(true);
        expect(errors[0]!.message).toContain("watch is not supported");
        expect(errors[0]!.message).not.toContain("deprecated");
        expect(spawns).toBe(1); // no retry storm
    });

    test("objects listed before an unwatchable failure are still delivered", async () => {
        // componentstatuses streams the whole collection, THEN fails: the rows
        // are real and worth showing while the UI switches to polling.
        const snapshots: K8sObject[][] = [];
        const watch = new ResourceWatch(
            {
                context: "c",
                kind: "componentstatuses",
                spawn: () =>
                    fakeProcess([event("ADDED", "etcd-0", "")], {
                        stderr: 'Error from server (MethodNotAllowed): watch is not supported on resources of kind "componentstatuses"',
                        code: 1,
                    }).proc,
            },
            { onSnapshot: (o) => snapshots.push(o), onEvent: () => {}, onError: () => {} },
        );
        watch.start();
        await Bun.sleep(600);
        watch.stop();
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]!.map((o) => o.metadata?.name)).toEqual(["etcd-0"]);
    });

    test("stop() kills the process and cancels retries", async () => {
        const { proc, wasKilled } = fakeProcess([event("ADDED", "a")]);
        let spawns = 0;
        const watch = new ResourceWatch(
            {
                context: "c",
                kind: "pods",
                spawn: () => {
                    spawns++;
                    return proc;
                },
            },
            { onSnapshot: () => {}, onEvent: () => {}, onError: () => {} },
        );
        watch.start();
        await Bun.sleep(100);
        watch.stop();
        await Bun.sleep(400);
        expect(wasKilled()).toBe(true);
        expect(spawns).toBe(1);
    });

    test("cluster-scoped kinds are not asked for a namespace", () => {
        const watch = new ResourceWatch(
            { context: "prod", kind: "nodes", clusterScoped: true },
            { onSnapshot: () => {}, onEvent: () => {}, onError: () => {} },
        );
        expect(watch.args).toEqual(["--context", "prod", "get", "nodes", "--watch", "--output-watch-events", "-o", "json"]);
    });

    test("no namespace means every namespace", () => {
        const watch = new ResourceWatch(
            { context: "prod", kind: "pods" },
            { onSnapshot: () => {}, onEvent: () => {}, onError: () => {} },
        );
        expect(watch.args).toContain("-A");
    });
});

describe("objectKey", () => {
    test("namespaces the key, so same-named objects never collide", () => {
        expect(objectKey({ metadata: { name: "web", namespace: "a" } } as K8sObject)).toBe("a/web");
        expect(objectKey({ metadata: { name: "node-1" } } as K8sObject)).toBe("/node-1");
    });
});

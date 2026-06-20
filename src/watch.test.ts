import { describe, expect, test } from "bun:test";
import { JsonStream } from "./watch.ts";

describe("JsonStream", () => {
    test("parses concatenated pretty-printed objects", () => {
        const s = new JsonStream();
        const input = '{\n  "type": "ADDED",\n  "object": {"kind":"Pod"}\n}\n{\n  "type": "DELETED",\n  "object": {}\n}\n';
        const out = s.feed(input) as { type: string }[];
        expect(out.map((o) => o.type)).toEqual(["ADDED", "DELETED"]);
    });

    test("handles a value split across chunks", () => {
        const s = new JsonStream();
        expect(s.feed('{"type":"ADD')).toEqual([]);
        expect(s.feed('ED","object":{}}')).toEqual([{ type: "ADDED", object: {} }]);
    });

    test("braces and quotes inside strings do not break splitting", () => {
        const s = new JsonStream();
        const out = s.feed('{"object":{"metadata":{"name":"a{b}\\"c"}}}') as { object: { metadata: { name: string } } }[];
        expect(out).toHaveLength(1);
        expect(out[0].object.metadata.name).toBe('a{b}"c');
    });

    test("emits each object as soon as it completes", () => {
        const s = new JsonStream();
        expect(s.feed('{"n":1}')).toEqual([{ n: 1 }]);
        expect(s.feed('{"n":2}')).toEqual([{ n: 2 }]);
    });

    test("skips a garbled value without throwing", () => {
        const s = new JsonStream();
        // unterminated string inside -> JSON.parse fails -> skipped, next ok
        const out = s.feed('{"a": nope}{"b":2}') as Record<string, number>[];
        expect(out).toEqual([{ b: 2 }]);
    });
});

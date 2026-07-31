import { describe, expect, test } from "bun:test";
import { type Level, findHits, parseLine, pieces } from "./logline.ts";

const lvl = (raw: string, prev: Level = "none") => parseLine(raw, 0, prev).level;
/** The text a seg kind covers, for asserting spans without counting offsets. */
const spanOf = (raw: string, t: string) => {
    const seg = parseLine(raw, 0).segs.find((s) => s.t === t);
    return seg ? raw.slice(seg.s, seg.e) : undefined;
};

describe("level detection", () => {
    test("klog letter prefix", () => {
        expect(lvl("E0725 10:22:31.123456       1 kubelet.go:42] pod failed")).toBe("error");
        expect(lvl("I0725 10:22:31.123456       1 kubelet.go:42] started")).toBe("info");
        expect(lvl("W0725 10:22:31.1 1 x.go:1] slow")).toBe("warn");
        expect(lvl("F0725 10:22:31.1 1 x.go:1] bye")).toBe("fatal");
    });

    test("klog behind a kubectl --timestamps prefix", () => {
        expect(lvl("2026-07-25T10:22:31.123456789Z E0725 10:22:31.1 1 x.go:1] boom")).toBe("error");
    });

    test("json level field", () => {
        expect(lvl('{"ts":1690000,"level":"error","msg":"upstream gone"}')).toBe("error");
        expect(lvl('{"severity":"WARNING","message":"slow"}')).toBe("warn");
        expect(lvl('{"levelname": "DEBUG", "msg": "x"}')).toBe("debug");
    });

    test("numeric json level (pino)", () => {
        expect(lvl('{"level":50,"msg":"nope"}')).toBe("error");
        expect(lvl('{"level":30,"msg":"ok"}')).toBe("info");
        expect(lvl('{"level":10,"msg":"noisy"}')).toBe("trace");
    });

    test("logfmt", () => {
        expect(lvl('ts=2026-07-25T10:00:00Z level=warn msg="disk filling"')).toBe("warn");
        expect(lvl("lvl=eror caller=main.go:12 err=timeout")).toBe("error");
    });

    test("bracketed token, any case", () => {
        expect(lvl("2026/07/25 10:00:00 [error] 12#12: *1 upstream timed out")).toBe("error");
        expect(lvl("[WARN ] com.foo.Bar - retry 1")).toBe("warn");
        expect(lvl("|debug| cache miss")).toBe("debug");
    });

    test("shouted bare token", () => {
        expect(lvl("10:00:00 ERROR could not bind")).toBe("error");
        expect(lvl("INFO: listening on :8080")).toBe("info");
        expect(lvl("TRACE enter handler")).toBe("trace");
    });

    test("prose is not a level", () => {
        // The old keyword scan painted all three of these red.
        expect(lvl("INFO reconcile complete: 0 failed, 12 ok")).toBe("info");
        expect(lvl('{"level":"info","msg":"error budget is 99.1%"}')).toBe("info");
        expect(lvl("level=info msg=\"retry on error is enabled\"")).toBe("info");
    });

    test("bare lower-case level word deep in a message is ignored", () => {
        expect(lvl("the handler returned a value the client did not expect at all today error")).toBe("none");
    });

    test("conservative fallback for unformatted output", () => {
        expect(lvl("panic: runtime error: invalid memory address")).toBe("fatal");
        expect(lvl("Traceback (most recent call last):")).toBe("error");
        expect(lvl("dial tcp 10.0.0.5:5432: connection refused")).toBe("error");
        expect(lvl("apiVersion extensions/v1beta1 is deprecated")).toBe("warn");
        expect(lvl("listening on port 8080")).toBe("none");
    });

    test("continuation lines inherit the level above", () => {
        expect(lvl("\tat com.foo.Bar.run(Bar.java:42)", "error")).toBe("error");
        expect(lvl("Caused by: java.lang.NullPointerException", "error")).toBe("error");
        expect(lvl("  ... 12 more", "error")).toBe("error");
        expect(parseLine("\tat com.foo.Bar.run(Bar.java:42)", 0, "error").inherited).toBe(true);
        // Only when the line has nothing of its own to say.
        expect(lvl("  INFO recovered", "error")).toBe("info");
        expect(lvl("\tat com.foo.Bar.run(Bar.java:42)", "none")).toBe("none");
        expect(lvl("a normal unindented line", "error")).toBe("none");
    });

    test("empty line", () => {
        const line = parseLine("", 0, "error");
        expect(line.level).toBe("none");
        expect(line.segs).toEqual([]);
    });
});

describe("segments", () => {
    test("leading timestamp is its own span", () => {
        expect(spanOf("2026-07-25T10:22:31.123456789Z hello", "ts")).toBe("2026-07-25T10:22:31.123456789Z");
        expect(spanOf("Jul 25 10:22:31 sshd: accepted", "ts")).toBe("Jul 25 10:22:31");
        expect(spanOf("[10:22:31] hello", "ts")).toBe("[10:22:31]");
    });

    test("klog splits the letter from the date", () => {
        const raw = "E0725 10:22:31.1 1 x.go:1] boom";
        expect(spanOf(raw, "lvl")).toBe("E");
        expect(spanOf(raw, "ts")).toBe("0725 10:22:31.1");
    });

    test("the level word itself is marked wherever it sits", () => {
        expect(spanOf("ts=2026-07-25T10:00:00Z level=warn msg=x", "lvl")).toBe("warn");
        expect(spanOf('{"level":"error","msg":"x"}', "lvl")).toBe("error");
    });

    test("keys, strings, urls and numbers", () => {
        const raw = 'level=info url=https://api.internal/v1 took=142ms peer=10.0.0.5:9090 msg="all good"';
        const line = parseLine(raw, 0);
        const kinds = (t: string) => line.segs.filter((s) => s.t === t).map((s) => raw.slice(s.s, s.e));
        expect(kinds("key")).toEqual(["level", "url", "took", "peer", "msg"]);
        expect(kinds("url")).toEqual(["https://api.internal/v1"]);
        expect(kinds("num")).toEqual(["142ms", "10.0.0.5:9090"]);
        expect(kinds("str")).toEqual(['"all good"']);
    });

    test("numbers inside identifiers are left alone", () => {
        const raw = "worker-0 started pod api-7d9f v2 at kubelet.go:42 after 30s, 3 left";
        const line = parseLine(raw, 0);
        // Not the 0 in worker-0, the 2 in v2, or the line number in go:42.
        expect(line.segs.filter((s) => s.t === "num").map((s) => raw.slice(s.s, s.e))).toEqual(["30s", "3"]);
    });

    test("json keys are keys, not strings", () => {
        const raw = '{"msg":"boom","count":3}';
        const line = parseLine(raw, 0);
        const kinds = (t: string) => line.segs.filter((s) => s.t === t).map((s) => raw.slice(s.s, s.e));
        expect(kinds("key")).toEqual(['"msg"', '"count"']);
        expect(kinds("str")).toEqual(['"boom"']);
        expect(kinds("num")).toEqual(["3"]);
    });

    test("segments never overlap and stay sorted", () => {
        const raw = '2026-07-25T10:00:00Z {"level":"error","url":"https://x/y","n":10.5,"ip":"10.0.0.1"}';
        const segs = parseLine(raw, 0).segs;
        for (let i = 1; i < segs.length; i++) {
            expect(segs[i]!.s).toBeGreaterThanOrEqual(segs[i - 1]!.e);
            expect(segs[i]!.e).toBeGreaterThan(segs[i]!.s);
        }
    });

    test("a blob line is left alone but still gets its level", () => {
        const raw = `ERROR body=${"x=1 ".repeat(1200)}`;
        const line = parseLine(raw, 0);
        expect(line.level).toBe("error");
        expect(line.segs.filter((s) => s.t === "key")).toHaveLength(0);
    });
});

describe("pieces", () => {
    const text = (ps: { text: string }[]) => ps.map((p) => p.text).join("");

    test("plain line stays one piece", () => {
        expect(pieces("hello world", [], [])).toEqual([{ text: "hello world", cls: "" }]);
    });

    test("pieces reassemble into the original line", () => {
        const raw = 'level=error msg="dial 10.0.0.5:80 failed" took=3s';
        const line = parseLine(raw, 0);
        expect(text(pieces(raw, line.segs, findHits(raw, "failed")))).toBe(raw);
    });

    test("a hit straddling a token keeps both classes", () => {
        const raw = "took=142ms";
        const line = parseLine(raw, 0);
        const out = pieces(raw, line.segs, findHits(raw, "k=14"));
        expect(text(out)).toBe(raw);
        expect(out.find((p) => p.text === "k")!.cls).toBe("key hit");
        expect(out.find((p) => p.text === "=")!.cls).toBe("hit");
        expect(out.find((p) => p.text === "14")!.cls).toBe("num hit");
        expect(out.find((p) => p.text === "2ms")!.cls).toBe("num");
    });

    test("search is case-insensitive and non-overlapping", () => {
        expect(findHits("aAaA", "aa")).toEqual([
            { s: 0, e: 2 },
            { s: 2, e: 4 },
        ]);
        expect(findHits("abc", "")).toEqual([]);
    });

    test("adjacent plain pieces are merged", () => {
        const out = pieces("abcdef", [{ t: "num", s: 2, e: 3 }], []);
        expect(out).toEqual([
            { text: "ab", cls: "" },
            { text: "c", cls: "num" },
            { text: "def", cls: "" },
        ]);
    });
});

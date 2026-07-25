import { describe, expect, test } from "bun:test";
import { formatBytes, formatCpu, parseQuantity, percent } from "./quantity.ts";

describe("parseQuantity", () => {
    test("cpu suffixes are millicores, not milli-anything-else", () => {
        expect(parseQuantity("100m")).toBeCloseTo(0.1);
        expect(parseQuantity("2")).toBe(2);
        expect(parseQuantity("1500m")).toBeCloseTo(1.5);
        expect(parseQuantity("250n")).toBeCloseTo(2.5e-7);
    });

    test("binary and decimal memory suffixes differ", () => {
        expect(parseQuantity("1Ki")).toBe(1024);
        expect(parseQuantity("1Mi")).toBe(1024 * 1024);
        expect(parseQuantity("1Gi")).toBe(1024 ** 3);
        // The bug this guards: treating G as Gi understates by ~7%.
        expect(parseQuantity("1G")).toBe(1e9);
        expect(parseQuantity("1G")).not.toBe(parseQuantity("1Gi"));
    });

    test("junk is zero, never NaN", () => {
        expect(parseQuantity("")).toBe(0);
        expect(parseQuantity(undefined)).toBe(0);
        expect(parseQuantity(null)).toBe(0);
        expect(parseQuantity("<unknown>")).toBe(0);
        expect(parseQuantity("abc")).toBe(0);
    });

    test("exponent notation, as the API sometimes emits", () => {
        expect(parseQuantity("1e3")).toBe(1000);
        expect(parseQuantity("1.5e2")).toBe(150);
    });
});

describe("formatting", () => {
    test("cpu", () => {
        expect(formatCpu(0.25)).toBe("250m");
        expect(formatCpu(0)).toBe("0");
        expect(formatCpu(2)).toBe("2");
        expect(formatCpu(2.53)).toBe("2.53");
        expect(formatCpu(64)).toBe("64");
    });

    test("bytes round-trip through binary units", () => {
        expect(formatBytes(1024)).toBe("1Ki");
        expect(formatBytes(1024 ** 3)).toBe("1Gi");
        expect(formatBytes(0)).toBe("0");
        expect(formatBytes(1536)).toBe("1.5Ki");
    });

    test("percent clamps and refuses an unknown denominator", () => {
        expect(percent(1, 2)).toBe(50);
        expect(percent(5, 0)).toBeNull();
        expect(percent(10, 5)).toBe(100);
        expect(percent(-1, 5)).toBe(0);
    });
});

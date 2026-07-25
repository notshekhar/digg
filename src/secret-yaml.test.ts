import { describe, expect, test } from "bun:test";
import YAML from "yaml";
import type { K8sObject, ResourceRef } from "./kubectl.ts";
import { decodeEntry, fromEditableYaml, toEditableYaml } from "./secret-yaml.ts";

const ref: ResourceRef = { kind: "Secret", name: "app-secret", namespace: "default", context: "test" };

function secret(data: Record<string, string>): K8sObject {
    return {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: { name: "app-secret", namespace: "default" },
        data,
    } as K8sObject;
}

/** What the API server would return for a Secret given raw values. */
function b64(value: string): string {
    return Buffer.from(value, "utf-8").toString("base64");
}

function appliedData(text: string): Record<string, string> {
    return (YAML.parse(text) as K8sObject).data as Record<string, string>;
}

describe("secret round-trip", () => {
    test("single-line token re-encodes to the exact original base64 (no trailing newline)", () => {
        const token = "ya29.a0AfH-NOT-A-REAL-TOKEN";
        const obj = secret({ token: b64(token) });
        const editable = toEditableYaml(obj);
        expect(editable).toContain("stringData:");
        expect(editable).toContain(token);
        const out = fromEditableYaml(editable, ref);
        expect(appliedData(out).token).toBe(b64(token));
    });

    test("multiline cert is byte-identical after round-trip", () => {
        const cert = "-----BEGIN CERTIFICATE-----\nMIIB\nQUJD\n-----END CERTIFICATE-----\n";
        const obj = secret({ "tls.crt": b64(cert) });
        const editable = toEditableYaml(obj);
        const out = fromEditableYaml(editable, ref);
        const decoded = Buffer.from(appliedData(out)["tls.crt"], "base64").toString("utf-8");
        expect(decoded).toBe(cert);
    });

    test("value without trailing newline stays without one", () => {
        const value = "no-newline-here";
        const obj = secret({ k: b64(value) });
        const out = fromEditableYaml(toEditableYaml(obj), ref);
        expect(Buffer.from(appliedData(out).k, "base64").toString("utf-8")).toBe(value);
    });

    test("literal backslash-n is preserved as two characters, not a newline", () => {
        const json = '{"msg":"line1\\nline2"}';
        const obj = secret({ config: b64(json) });
        const out = fromEditableYaml(toEditableYaml(obj), ref);
        expect(Buffer.from(appliedData(out).config, "base64").toString("utf-8")).toBe(json);
    });

    test("binary value stays base64 and untouched", () => {
        const binary = Buffer.from([0x00, 0xff, 0x10, 0x80]).toString("base64");
        const obj = secret({ blob: binary, name: b64("plain") });
        const editable = toEditableYaml(obj);
        expect(editable).toContain("data:");
        expect(editable).toContain(binary);
        const out = fromEditableYaml(editable, ref);
        expect(appliedData(out).blob).toBe(binary);
        expect(appliedData(out).name).toBe(b64("plain"));
    });

    test("unquoted numeric / boolean / date values are re-encoded as their text", () => {
        // Simulates a user editing values without quotes; YAML would otherwise
        // coerce these to number/bool/Date and break base64 encoding.
        const edited = [
            "apiVersion: v1",
            "kind: Secret",
            "type: Opaque",
            "metadata:",
            "  name: app-secret",
            "  namespace: default",
            "stringData:",
            "  port: 8080",
            "  flag: true",
            "  when: 2026-06-15",
            "",
        ].join("\n");
        const data = appliedData(fromEditableYaml(edited, ref));
        const decode = (k: string) => Buffer.from(data[k], "base64").toString("utf-8");
        expect(decode("port")).toBe("8080");
        expect(decode("flag")).toBe("true");
        expect(decode("when")).toBe("2026-06-15");
    });

    test("rejects an edited name", () => {
        const obj = secret({ k: b64("v") });
        const editable = toEditableYaml(obj).replace("name: app-secret", "name: other-secret");
        expect(() => fromEditableYaml(editable, ref)).toThrow(/immutable/);
    });
});

describe("configmap round-trip", () => {
    const cmRef: ResourceRef = { kind: "ConfigMap", name: "app-config", namespace: "default", context: "test" };
    const configmap = (): K8sObject =>
        ({
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: { name: "app-config", namespace: "default" },
            data: { "app.properties": "a=1\nb=2\n", greeting: "hello" },
        }) as K8sObject;

    test("plain data round-trips unchanged", () => {
        const out = fromEditableYaml(toEditableYaml(configmap()), cmRef);
        const data = (YAML.parse(out) as K8sObject).data as Record<string, string>;
        expect(data["app.properties"]).toBe("a=1\nb=2\n");
        expect(data.greeting).toBe("hello");
    });
});

describe("decodeEntry", () => {
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

    test("decodes clean text and reports its real size", () => {
        const e = decodeEntry(b64("host: db\nport: 5432"), true);
        expect(e.text).toBe("host: db\nport: 5432");
        expect(e.binary).toBe(false);
        expect(e.bytes).toBe(19);
    });

    test("unencoded values (ConfigMaps) pass straight through", () => {
        const e = decodeEntry("LOG_LEVEL=debug", false);
        expect(e.text).toBe("LOG_LEVEL=debug");
        expect(e.binary).toBe(false);
    });

    test("binary is flagged, never mangled into text", () => {
        // A NUL byte is not editable text; the editor must refuse it rather
        // than round-trip it through a textarea and corrupt the value.
        const e = decodeEntry(Buffer.from([0x00, 0xff, 0x10]).toString("base64"), true);
        expect(e.binary).toBe(true);
        expect(e.text).toBe("");
        expect(e.bytes).toBe(3);
    });

    test("multi-byte UTF-8 survives", () => {
        const e = decodeEntry(b64("café ☕ नमस्ते"), true);
        expect(e.text).toBe("café ☕ नमस्ते");
        expect(e.binary).toBe(false);
    });

    test("an empty value is text, not binary", () => {
        expect(decodeEntry("", true)).toEqual({ text: "", binary: false, bytes: 0 });
    });
});

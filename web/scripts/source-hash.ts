#!/usr/bin/env bun
/**
 * A fingerprint of the UI sources, recorded next to the built bundle.
 *
 * The bundle in src/internal/server/webdist/ is committed so a clean checkout
 * builds with only Go. That leaves one failure mode: someone edits web/src and
 * forgets to rebuild, and a stale UI ships silently.
 *
 * go:embed does not help here — it guarantees the BINARY matches the committed
 * bundle, not that the bundle matches the sources it was built from.
 *
 * The obvious check is "rebuild in CI and byte-compare", but that makes CI
 * depend on the Vite output being reproducible across machines and on a
 * resolvable lockfile. Hashing the inputs instead needs neither: no install, no
 * build, no toolchain beyond bun itself.
 *
 * Content only — never mtimes. A git checkout writes files in arbitrary order,
 * so anything timestamp-based flakes on CI.
 *
 *     bun web/scripts/source-hash.ts            print the hash of the tree
 *     bun web/scripts/source-hash.ts --check    compare against the recorded one
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const webDir = join(import.meta.dir, "..");
export const HASH_FILE = join(webDir, "..", "src", "internal", "server", "webdist", "SOURCE_HASH");

/** Everything that can change what the built page contains. */
const INPUTS = ["src", "index.html", "vite.config.ts", "package.json", "tsconfig.json"];

function walk(path: string, out: string[]): void {
    let info: ReturnType<typeof statSync>;
    try {
        info = statSync(path);
    } catch {
        return; // an optional input that this checkout does not have
    }
    if (info.isDirectory()) {
        // Sorted, so the hash does not depend on readdir order — which differs
        // between filesystems and would make the check machine-dependent.
        for (const entry of readdirSync(path).sort()) {
            walk(join(path, entry), out);
        }
        return;
    }
    out.push(path);
}

export function sourceHash(): string {
    const files: string[] = [];
    for (const input of INPUTS) {
        walk(join(webDir, input), files);
    }

    const hash = createHash("sha256");
    for (const file of files) {
        // Path separators are normalised so a Windows checkout agrees with a
        // POSIX one.
        hash.update(relative(webDir, file).split(sep).join("/"));
        hash.update("\0");
        hash.update(readFileSync(file));
        hash.update("\0");
    }
    return hash.digest("hex").slice(0, 16);
}

if (import.meta.main) {
    const want = sourceHash();

    if (!process.argv.includes("--check")) {
        console.log(want);
        process.exit(0);
    }

    let have = "";
    try {
        have = readFileSync(HASH_FILE, "utf8").trim();
    } catch {
        console.error("✗ no SOURCE_HASH recorded next to the bundle.");
        console.error("  Run: bun run build:web");
        process.exit(1);
    }

    if (have !== want) {
        console.error(`✗ the committed web bundle is stale (recorded ${have}, sources hash to ${want}).`);
        console.error("  Someone changed web/ without rebuilding. Run:");
        console.error("      bun run build:web");
        console.error("  and commit src/internal/server/webdist/.");
        process.exit(1);
    }
    console.log(`✓ web bundle matches web/src (${want})`);
}

/**
 * A content fingerprint of the browser UI source.
 *
 * `src/web/bundle.ts` is generated from `web/`, and the two must not drift —
 * a binary built against a stale bundle ships an old UI against a new API and
 * nothing complains until someone opens the page.
 *
 * Freshness is judged on CONTENT, never on timestamps: a git checkout writes
 * every file at whatever moment it gets to it, so an mtime comparison would
 * fail at random on CI while being perfectly correct on the machine where the
 * files were actually edited.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Files outside web/src that also change the built output. */
const EXTRA = ["index.html", "vite.config.ts", "package.json"];

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

/**
 * Hash every input of the Vite build. Returns "" when web/ is absent — the
 * published npm package ships only src/, and that is not a stale bundle.
 */
export function webSourceHash(repoRoot: string): string {
    const webDir = join(repoRoot, "web");
    const srcDir = join(webDir, "src");
    if (!existsSync(srcDir)) return "";

    const files = walk(srcDir);
    for (const name of EXTRA) {
        const full = join(webDir, name);
        if (existsSync(full) && statSync(full).isFile()) files.push(full);
    }

    const hash = createHash("sha256");
    for (const file of files.sort()) {
        hash.update(relative(webDir, file).replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(readFileSync(file));
        hash.update("\0");
    }
    return hash.digest("hex").slice(0, 16);
}

/** The hash recorded in a generated bundle, or "" if it predates this check. */
export function bundleHash(bundlePath: string): string {
    if (!existsSync(bundlePath)) return "";
    const head = readFileSync(bundlePath, "utf8").slice(0, 2000);
    return /SOURCE_HASH = "([a-f0-9]+)"/.exec(head)?.[1] ?? "";
}

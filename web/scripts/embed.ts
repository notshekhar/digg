#!/usr/bin/env bun
/**
 * Bakes `web/dist/index.html` into `src/web/bundle.ts`.
 *
 * That generated module is COMMITTED. `bun ./src/cli.ts` and `bun build
 * --compile` must work on a clean checkout with no node toolchain — the Vite
 * app is a build-time dependency of the repo, never a runtime one. Anyone
 * touching web/ runs `bun run build` in web/ and commits both sides.
 *
 * The html is emitted as a JSON string literal (one long line). It is not meant
 * to be read or diffed; the reviewable source is web/src.
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { webSourceHash } from "../../scripts/web-hash.ts";

const webDir = join(import.meta.dir, "..");
const src = join(webDir, "dist", "index.html");
const out = join(webDir, "..", "src", "web", "bundle.ts");

let html: string;
try {
    html = readFileSync(src, "utf8");
} catch {
    console.error(`embed: ${src} missing — run \`vite build\` first`);
    process.exit(1);
}

if (!html.includes('<div id="root">')) {
    console.error("embed: dist/index.html has no #root — build looks wrong");
    process.exit(1);
}
if (/<script[^>]+src=/.test(html) || /<link[^>]+rel="stylesheet"[^>]+href="\.?\//.test(html)) {
    console.error("embed: dist/index.html still references external assets — singlefile did not inline");
    process.exit(1);
}

const header = `/**
 * GENERATED — do not edit. Source lives in web/; rebuild with:
 *
 *     cd web && bun install && bun run build
 *
 * One self-contained html document: React app, styles and fonts-link inlined.
 * serve.ts injects the theme and boot state into it per request.
 */

`;

// The fingerprint of the sources this was built from; build-bin.ts compares it
// against the working tree so a stale bundle can never be shipped.
const sourceHash = webSourceHash(join(webDir, ".."));
writeFileSync(
    out,
    `${header}export const SOURCE_HASH = ${JSON.stringify(sourceHash)};\n\nexport const INDEX_HTML: string = ${JSON.stringify(html)};\n`,
);

const kb = (statSync(out).size / 1024).toFixed(0);
console.log(`✓ embedded web UI → src/web/bundle.ts (${kb} KB)`);

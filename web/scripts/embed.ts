#!/usr/bin/env bun
/**
 * Copies `web/dist/index.html` to where the Go build embeds it from.
 *
 * go:embed cannot reach outside its own package directory, so the built bundle
 * has to live next to the package that embeds it. That copy is COMMITTED: a
 * clean checkout must build with nothing but the Go toolchain, and the Vite app
 * stays a build-time dependency of the repo rather than a runtime one.
 *
 * Anyone touching web/ runs `bun run build` in web/ and commits both sides.
 *
 * This replaces the old bundle.ts generator. The Bun build had to serialise the
 * html as a TypeScript string literal and guard it with a content hash, because
 * a checkout writes files in arbitrary order and an mtime check flakes on CI.
 * embed.FS needs neither: the bundle cannot be stale relative to a binary that
 * compiled it in.
 */
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HASH_FILE, sourceHash } from "./source-hash.ts";

const webDir = join(import.meta.dir, "..");
const src = join(webDir, "dist", "index.html");
const out = join(webDir, "..", "src", "internal", "server", "webdist", "index.html");

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
// The server stamps the theme onto this attribute per request; without it the
// page would always paint dark first and then flip.
if (!html.includes('data-theme="dark"')) {
    console.error('embed: dist/index.html has no data-theme="dark" for the server to stamp');
    process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
copyFileSync(src, out);

// The fingerprint of the sources this was built from. CI compares it against
// the working tree, so a bundle that no longer matches web/src cannot ship.
const hash = sourceHash();
writeFileSync(HASH_FILE, `${hash}\n`);

const kb = (statSync(out).size / 1024).toFixed(0);
console.log(`✓ embedded web UI → src/internal/server/webdist/index.html (${kb} KB, sources ${hash})`);

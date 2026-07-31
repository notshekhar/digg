package server

import _ "embed"

// The built React app, compiled into the binary.
//
// The Bun build committed src/web/bundle.ts — the same HTML as a TypeScript
// string — and guarded its freshness with a content hash (scripts/web-hash.ts),
// because a checkout writes files in arbitrary order and an mtime check flakes
// on CI. embed.FS makes both unnecessary: the bundle cannot be stale relative
// to the binary, because it is read at compile time.
//
// Run `bun run build:web` in the repo root after any web/src change, then
// rebuild.
//
//go:embed webdist/index.html
var indexHTML string

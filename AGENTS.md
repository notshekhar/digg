# digg — notes for agents

A Kubernetes cockpit in the browser over a kubectl-shelling core. There is no
TUI any more — it was removed 2026-07-25 and `digg` now means `digg serve`.

## Layout

| path | what |
|------|------|
| `src/kubectl.ts` | every kubectl call. Nothing else spawns kubectl. |
| `src/format.ts` | `KINDS` — the curated kind table: columns + row extraction. |
| `src/details.ts` | per-kind detail models (which related objects a kind shows). |
| `src/detail-view.ts` | the RICH page model (pods, workloads, nodes): fact groups, container cards, pod lines. Pure. |
| `src/usage.ts` | requests/limits/usage arithmetic + selector matching. Pure. |
| `examples/` | sample manifests (ingress) for poking at the UI. |
| `src/serve.ts` | `digg serve`: Bun.serve, token guard, WebSocket wiring. |
| `src/web/` | the web backend — `api.ts` (routes), `catalog.ts` (grouped kinds), `actions.ts` (writes), `overview.ts`, `detail.ts` (rich page + revisions), `gauges.ts` (table usage columns), `forwards.ts`, `exec.ts`, `page.ts`. |
| `src/web/bundle.ts` | **generated** — the built browser UI as one HTML string. Committed. |
| `src/pty.ts` | openpty via bun:ffi, for browser shells. |
| `web/` | the browser UI source: React + Vite + TypeScript, no UI library. |

## Web UI shape

Path routing (`web/src/lib/router.ts`) over real paths — `digg serve` returns
the app for every non-`/api` GET, so `/k/pods/demo/api-7d9f` is a deep link.
The query string belongs to **nuqs** (`web/src/lib/query.ts`): namespace
selection, table filter, detail tab and log container all live there, so a
reload or a pasted URL restores the screen. Never put those in component state.

Global shortcuts are ⌘ chords ONLY (`lib/hooks.ts` ignores un-modified keys) —
bare letters fire while someone is typing in a filter, an editor or a shell.

Terminals and port-forwards live in `components/Console.tsx`, rendered outside
the route switch and portalled to `body`: a shell must survive navigation.
Panes stay mounted while hidden — unmounting an xterm kills the process.

## The rule that bites

`src/web/bundle.ts` is a build artefact that is committed, so a clean checkout
needs no node toolchain. **After any change under `web/src`, run
`bun run build:web` and commit both sides.** `bun run build` (the binary) refuses to
run when the bundle's recorded `SOURCE_HASH` does not match the working tree.
The check is on content, not mtimes — a git checkout writes files in arbitrary
order and a timestamp check would fail at random on CI.

## Live data

`src/watch.ts` keeps one `kubectl get --watch --output-watch-events` per
(context, kind, namespace); `src/web/live.ts` refcounts those across sessions
and turns events into row deltas on `/api/watch` (same token guard as the rest).
The client (`web/src/lib/live.ts` + `live-data.ts`) prefers the socket and
**falls back to polling** whenever it cannot serve — unwatchable kind, dropped
connection, paused session — keeping the last rows on screen while it switches.

Rules that matter here:
- `src/web/rows.ts` builds every row. Both `/api/list` and the watch use it, so
  a streamed row and a polled row are byte-identical; two builders would flicker.
- kubectl gives no resourceVersion and no bookmark, so a reconnect re-lists.
  The initial burst is buffered and emitted as ONE snapshot (quiet for 250ms, or
  2.5s hard stop), which also repairs anything deleted while disconnected.
- **Metrics are not watchable** (`metrics.k8s.io` is get/list only) — usage bars
  refresh on a 15s timer inside the session, sent as deltas.
- A kind whose watch fails permanently (aggregated API, RBAC) must report
  `fatal` so the client polls instead of retrying forever.

## Detail pages: two tiers

Every kind gets `src/details.ts` — a key/value summary plus one related table.
Kinds in `RICH_KINDS` (pods, deployments, statefulsets, daemonsets, replicasets,
jobs, nodes) get a full model instead: identity card, fact groups, container
cards with usage against requests/limits, and the pods they own.
`/api/detail` returns `view` for those and `section: null`, so the two never
render at once. Bars are **null-safe**: no metrics-server means a hatched bar,
never a confident 0%.

## Adding a kind

Add it to `KINDS` in `src/format.ts` (name = the kubectl plural, `columns` +
`row()` mirroring `kubectl get`), then list it in the right group in
`src/web/catalog.ts`. Uncurated kinds still work
— they fall back to `genericKind()` and land under their API group.

## ConfigMaps and Secrets

`GET /api/data` returns every entry decoded (`src/secret-yaml.ts:decodeEntry`
flags binary values); `setData` in `src/web/actions.ts` writes a JSON merge
patch. Secrets go through **`stringData`** so the API server does the base64 —
encoding in the browser risks a silently-wrong secret. Deletion is `data: {key:
null}`. Only changed keys are sent, so a save cannot clobber a field someone
else edited.

## Adding an action

One switch case in `src/web/actions.ts`, one entry in `resourceActions()` in
`web/src/lib/actions.tsx`. Destructive actions get a `Confirm`; irreversible
ones (delete, drain) pass `confirmText` so the name must be typed.

## Security invariants

- `digg serve` binds 127.0.0.1 and requires a per-run token on every `/api`
  request and every WebSocket. Localhost is not an access boundary — a hostile
  page can reach it, and WS handshakes ignore the same-origin policy.
- Never add an endpoint that runs a command without going through the guard in
  `serve.ts`.

## Testing

`bun test` runs unit tests plus a live integration suite that spawns a real
server. Cluster-dependent assertions print `↷ skipped` when no cluster answers
rather than passing silently. Browser verification is done with headless Chrome
over CDP against `digg serve`.

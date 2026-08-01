# digg — notes for agents

A Kubernetes cockpit in the browser. **A Go program since v2.0.0** — it reads
your kubeconfig and talks to the API server through client-go, so there is no
kubectl to shell out to and no TUI (that went in v1.0.0). `digg` and
`digg serve` are the same command.

## Layout

| path | what |
|------|------|
| `src/cmd/digg/main.go` | argument parsing, signals, `digg update`. |
| `src/internal/kube/client.go` | one `Cluster` per context, cached forever: rest.Config, typed/dynamic/metrics clients, discovery, RESTMapper. |
| `src/internal/kube/resources.go` | list/get/apply/patch/delete/scale/rollout — every read and write against the API. |
| `src/internal/kube/watch.go` | SharedIndexInformers, one per (kind, namespace), refcounted; `CachedList`/`ListCached` answer reads out of a warm store. |
| `src/internal/kube/cache.go` | TTL + single-flight memo, used by metrics. |
| `src/internal/kube/{metrics,logs,exec,forwards,events,discovery,drain,pty}.go` | metrics.k8s.io, log streams, exec/attach, port-forwards, events, discovery, drain, ptys. |
| `src/internal/model/format.go` | `Kinds` — the curated kind table: columns + row extraction. Pure. |
| `src/internal/model/details.go` | per-kind detail models (which related objects a kind shows). Pure. |
| `src/internal/model/detailview.go` | the RICH page model (pods, workloads, nodes): fact groups, container cards, pod lines. Pure. |
| `src/internal/model/{usage,quantity,secretyaml,obj}.go` | requests/limits arithmetic, quantity parsing, ConfigMap/Secret decoding, object helpers. Pure. |
| `src/internal/server/server.go` | `digg serve`: routes, the token guard, the listener. |
| `src/internal/server/` | the web backend — `api.go` (routes), `catalog.go` (grouped kinds), `actions.go` (writes), `overview.go`, `detail.go`, `gauges.go` (table usage columns), `live.go` (watch → deltas), `rows.go`, `sockets.go`, `page.go`. |
| `src/internal/server/webdist/index.html` | **generated** — the built browser UI, `go:embed`ed. Committed. |
| `src/internal/{settings,update}/` | `~/.digg/settings.json`, and self-update. |
| `web/` | the browser UI source: React + Vite + TypeScript, no UI library. |
| `examples/` | sample manifests (ingress) for poking at the UI. |

Everything under `model/` is pure and has tests; everything that talks to a
cluster lives in `kube/`. Keep it that way — it is why the model has real unit
tests and the cluster layer only has live ones that skip.

## Web UI shape

Path routing (`web/src/lib/router.ts`) over real paths — digg returns the app
for every non-`/api` GET, so `/k/pods/demo/api-7d9f` is a deep link. The query
string belongs to **nuqs** (`web/src/lib/query.ts`): namespace selection, table
filter, detail tab and log container all live there, so a reload or a pasted URL
restores the screen. Never put those in component state.

Global shortcuts are ⌘ chords ONLY (`lib/hooks.ts` ignores un-modified keys) —
bare letters fire while someone is typing in a filter, an editor or a shell.

Terminals and port-forwards live in `components/Console.tsx`, rendered outside
the route switch and portalled to `body`: a shell must survive navigation.
Panes stay mounted while hidden — unmounting an xterm kills the process.

## The rule that bites

`src/internal/server/webdist/index.html` is a build artefact that is committed,
so a clean checkout builds with the Go toolchain alone. **After any change under
`web/src`, run `bun run build:web` from the repo root and commit both sides.**
CI checks it with `bun web/scripts/source-hash.ts --check`, which compares a
hash of the sources against the one recorded at build time — content, not
mtimes, because a git checkout writes files in arbitrary order.

## Waiting is a designed state

Every loading state goes through `useDelayed` (`web/src/lib/hooks.ts`) and then
draws a skeleton from `components/Skeleton.tsx`. Two rules:

- **Nothing appears for the first 160ms.** Most reads answer in single-digit
  milliseconds, and a placeholder painted for one frame is worse than none.
- **A skeleton draws the geometry of what is coming, and fakes nothing already
  known.** A table keeps its real header row and its real column widths (the
  kind catalog carries `columns` before any row is fetched); a detail page keeps
  its header and tabs; the overview keeps its context name. The data replaces
  bars in place rather than replacing a screen.

Do not add a bare spinner to a screen. The one that remains is the boot note,
where there is genuinely nothing yet to be shaped like.

## Speed: one client, warm stores, no serial round trips

There is no kubectl and no proxy any more; `kube.For(context)` builds one
authenticated client per context and keeps it for the life of the process, so
an exec credential plugin (`aws eks get-token`, gcloud, oidc) and a TLS
handshake happen once, not per request. Four rules keep it fast:

1. **Reads list with `resourceVersion=0`** (`ListOptions.Quorum` opts out),
   which the apiserver answers from its own watch cache instead of a quorum read
   through etcd. The tables are watch-fed and correct themselves, so the few
   milliseconds of possible lag are not worth a slower read.
2. **A warm informer IS the answer.** `ListCached` serves any read a running,
   synced watch already holds — including a namespaced or label-selected slice
   of an all-namespaces store — for zero API calls. Measured on minikube: 18µs
   against 8.5ms. Every read-only caller in `server/` uses it.
3. **Streams outlive their readers by `idleGrace` (5 min)**, which is what makes
   rule 2 pay: navigate away and back and the table is already in memory. This
   is the store-lifetime trick Lens gets from keeping its KubeObjectStores alive.
4. **Independent reads run concurrently.** A detail page builds its section and
   its rich view in parallel; usage columns fetch metrics and pods in parallel;
   the overview fans out entirely. Anything that adds a second serial round trip
   to a page build is a regression.

Metrics are the exception to everything: `metrics.k8s.io` samples every 60s and
carries `window: 1m`, so `kube/cache.go` holds answers for 10s and collapses
concurrent misses into one call.

## Live data

`server/live.go` turns informer events into row deltas on `/api/watch` (same
token guard as the rest); `kube/watch.go` owns one SharedIndexInformer per
(context, kind, namespace) shared across every socket. The informer gives what
`kubectl --watch` could not: a resourceVersion to resume from, and a `Synced`
marker for "the initial list is done" — so the 250ms settle heuristic the Bun
build needed is gone.

The client (`web/src/lib/live.ts` + `live-data.ts`) prefers the socket and
**falls back to polling** whenever it cannot serve — unwatchable kind, dropped
connection, paused session — keeping the last rows on screen while it switches.
It gives the socket a 300ms head start (`pending`) before polling, so opening a
table does not ask the cluster for the same collection twice.

Rules that matter here:
- `server/rows.go` builds every row. Both `/api/list` and the watch use it, so a
  streamed row and a polled row are byte-identical; two builders would flicker.
- **Metrics are not watchable** (`metrics.k8s.io` is get/list only) — usage bars
  refresh on a 15s timer inside the session, sent as deltas.
- A kind whose watch fails permanently (aggregated API, RBAC) must report
  `fatal` so the client polls instead of retrying forever.

## Detail pages: two tiers

Every kind gets `model/details.go` — a key/value summary plus one related table.
Kinds in `RichKinds` (pods, deployments, statefulsets, daemonsets, replicasets,
jobs, services, nodes) get a full model instead: identity card, fact groups,
container cards with usage against requests/limits, and the pods they own.
`/api/detail` returns `view` for those and `section: null`, so the two never
render at once. Bars are **null-safe**: no metrics-server means a hatched bar,
never a confident 0%.

Services live in `model/serviceview.go` rather than `detailview.go`, and their
embedded pod table sets `PodsBlock.Title`/`Counts` — a Service's pods are
"selected" and "serving", never a workload's four rollout counters.

## Relations: the third build

`server/links.go` resolves what an object is connected to and returns fact
groups the client renders as **Related**, on every kind — rich page or not. It
is the third goroutine in `BuildDetailPayload`, alongside the section and the
view. The pure half (selector matching, owner-chain plurals, endpoint parsing,
`RefSet.Uses` — SpecRefs read backwards) is in `model/links.go` and has tests.

Four rules, and breaking any of them makes the block worse than absent:

- **Reads go through `ListCached`**, and `linkResolver.list` memoises per page
  build; several relations want the same namespace's pods.
- **An empty selector matches nothing** (`model.LabelsMatch`). The opposite of
  what an empty `metav1.LabelSelector` means, and getting it backwards puts a
  whole namespace behind an ExternalName Service.
- **A relation that resolves to nothing is dropped, not shown empty.** A heading
  with a dash under it claims the link does not exist, which is a different
  statement from "digg did not look".
- **Pods fold into their controller** (`workloadsBehind` → `rootOwner`, which
  climbs ReplicaSet→Deployment and Job→CronJob), hinted "6 pods". Never list
  replicas beside the thing that made them.

A cluster-wide relation (PriorityClass → pods, StorageClass → PVCs) caps at 25
with a kind-less `Ref`, which the client draws as text rather than a dead link.

## Adding a kind

Add it to `Kinds` in `model/format.go` (name = the kubectl plural, `Columns` +
`Row()` mirroring `kubectl get`), then list it in the right group in
`server/catalog.go`. Uncurated kinds still work — they fall back to the generic
kind and land under their API group.

## ConfigMaps and Secrets

`GET /api/data` returns every entry decoded (`model.DecodeEntry` flags binary
values); `setData` in `server/actions.go` writes a JSON merge patch. Secrets go
through **`stringData`** so the API server does the base64 — encoding in the
browser risks a silently-wrong secret. Deletion is `data: {key: null}`. Only
changed keys are sent, so a save cannot clobber a field someone else edited.

## Adding an action

One switch case in `server/actions.go`, one entry in `resourceActions()` in
`web/src/lib/actions.tsx`. Destructive actions get a `Confirm`; irreversible
ones (delete, drain) pass `confirmText` so the name must be typed. Writes are
never served from a cache and never take the `resourceVersion=0` shortcut.

## Security invariants

- `digg serve` binds 127.0.0.1 and requires a per-run token on every `/api`
  request and every WebSocket. Localhost is not an access boundary — a hostile
  page can reach it, and WS handshakes ignore the same-origin policy.
- Never add an endpoint that runs a command without going through `guard()` in
  `server/server.go`.

## Testing

`go test ./...` runs the pure model/settings/update tests plus live suites that
**skip themselves** when no kubeconfig answers, so it stays green on a machine
with no cluster. `cd web && bun run typecheck` covers the UI. CI also vets the
Windows build, because the pty is split across `pty.go` and
`pty_stub_windows.go` and a change to one can leave the other missing a symbol.
Browser verification is done with headless Chrome over CDP — randomise the
debugging port AND the user-data-dir per launch, or a second launch silently
attaches to the Chrome already running and drives a stale page.

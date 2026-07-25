# Changelog

## v1.4.1

- **Fixed: picking a namespace with the mouse killed the arrow keys.** The key
  handler lived on the search input, and clicking a row moved focus to that
  row's button — so after one mouse click the highlight could not be moved from
  the keyboard at all. Rows no longer take focus on mousedown, the handler sits
  on the dialog where keystrokes bubble to it either way, and the caret is put
  back in the search box after every toggle. Type, click, arrow, space, in any
  order.

## v1.4.0

- **Fixed: switching cluster forgot where you were in it.** Every switch
  cleared the namespace selection and never asked what that cluster had been
  left on, so going from staging to prod and back meant re-picking your
  namespaces every time. Each context now remembers its own selection —
  **all** of it, not just the one namespace the old code could store — and gets
  it back on the way in, in the same round trip that fetches the namespace
  list. Namespace names are cluster-local, so the selection is cleared on the
  way out rather than carried across: "payments" in staging is not "payments"
  in prod, and a filter that silently matches nothing is worse than none.
  A namespace deleted since your last visit is quietly dropped.
- **Cluster and namespace pickers, in the ⌘K box.** Both were dropdowns, which
  is the wrong control once a cluster has eighty namespaces: you cannot type at
  a menu without reaching for the mouse first. They are now the same centred,
  search-first palette ⌘K uses — `⌘⌥K` for clusters, `⌘⌥N` for namespaces, or
  click either control in the top bar.
- **Namespaces multi-select the way a set of checkboxes should.** Click a
  namespace to add it, click it again to drop it, and the box stays open the
  whole time; enter and space do the same from the keyboard, esc closes. There
  is no apply step because every change applies as you make it — the table
  behind the box is the preview. Selected namespaces float to the top, but only
  when the search changes, never mid-click: a list that re-sorts as you toggle
  slides the next row out from under the pointer.
- **⌘ chords with option in them actually fire now.** The keymap matched on the
  character the browser reported, and on macOS option composes one — ⌘⌥N
  arrives as "˜", so a chord written "mod+alt+n" could never match. Chords are
  read off the physical key instead. `⌘⌥R` (refresh) has presumably been dead
  on macOS since it was added.

## v1.3.0

**digg stops paying for a process per question.** Every read used to be its own
`kubectl`, and a process re-does the whole handshake before it asks anything:
parse the kubeconfig, run the exec credential plugin, negotiate TLS. Now there
is one long-lived `kubectl proxy` per context and reads are plain HTTP into it.

- **One proxy, on a unix socket.** Measured against a local minikube: `kubectl
  get pods -A -o json` costs ~50ms per call, the same request over the proxy
  ~3ms. digg's own endpoints, end to end: a pod list 112ms → 13ms, a pod detail
  page 107ms → 11ms. On a cloud cluster the gap is wider, because the exec
  credential plugin is the expensive part — proven, not assumed: five `kubectl
  get` calls run `aws eks get-token` five times, five requests through one proxy
  run it once, and a detail page makes half a dozen calls.
- **Why a socket and not a port.** v1.1.0 rejected an embedded `kubectl proxy`
  because a TCP proxy on localhost is an unauthenticated cluster-admin port and
  any page in any browser can reach 127.0.0.1. A unix socket has no port to
  reach: kubectl creates it `srwx------` in `~/.digg`, so only a process running
  as you can open it, and it is started with `--reject-methods` so nothing can
  write through it even then.
- **kubectl still does the authenticating**, so client certs, tokens and every
  exec plugin (aws/gcp/oidc) work exactly as before. **Every write is still its
  own kubectl** — apply, patch, scale, delete, drain, exec, port-forward — as
  are `describe` and YAML, whose output is kubectl's own. If the proxy cannot
  start, every read falls back to the argv it always used; `DIGG_NO_PROXY=1`
  forces that path.
- **Watches resume instead of re-listing.** The API server closes a watch every
  few minutes by design. The kubectl watch could only answer that by re-listing
  every object in the kind, because kubectl accepts no resourceVersion; the API
  watch reconnects from the last version it saw and is sent only what changed.
  Bookmarks keep that version fresh, and a 410 — the one case where the version
  has aged out — is the only thing that triggers a fresh list.
- **The list now has an end.** `?resourceVersion=0` is a list with a version
  attached, served from the API server's cache, so the initial snapshot is exact
  and immediate. The kubectl path had to guess: buffer the opening burst and
  call it done after 250ms of quiet. That guess is now only used on that path.
- **Discovery is cached in memory** for five minutes. It answers nearly every
  request — a list needs it, a detail page needs it — and it was a `kubectl
  api-resources` spawn each time.
- **Usage numbers come from metrics.k8s.io directly**, so they are no longer
  rounded to whole millicores and mebibytes by `kubectl top` on the way in. Node
  percentages are computed against allocatable, as kubectl computes them.

## v1.2.0

- **Fixed: the log pane dragged you back to the newest line.** Scrolling up in a
  busy pod's logs held for a moment and then crept forward again, with follow on
  or off. The scrollbar was innocent: once the buffer hit its 5,000-line cap
  every batch of new lines dropped the same number off the FRONT, so the
  surviving lines slid up under a scroll position that never moved, and the
  reader was fed the tail one frame at a time. (Rows are keyed by index, so
  React rewrote them in place and the browser's scroll anchoring never saw a
  thing.) The head is now only trimmed while pinned to the bottom, where it is
  invisible. Paused, the buffer grows to 20,000 lines and then declines new ones
  rather than moving anything the reader is looking at — the jump-to-live button
  says how many it skipped.
- **Follow now turns off when you say so, not when the scrollbar agrees.**
  Scroll events arrive asynchronously, so a wheel-up on a fast stream could land
  after follow had already snapped the pane back to the bottom, be measured as
  "still at the bottom", and be ignored. Wheel and touch turn follow off
  directly, and the pane's own scrolls are marked so they cannot be mistaken for
  user intent. Scrolling back to the bottom re-attaches.
- **The UI remembers its shape, in `~/.digg/settings.json`.** Folded rail
  groups, the console's height, log toggles (wrap, timestamps, tail length) and
  each table's sort column now persist with the theme and the last namespace,
  instead of living in the tab. localStorage was the wrong home for them: it is
  keyed on the origin, and `digg serve` walks up a port when one is busy, so the
  cockpit forgot its layout whenever it landed on 9911 instead of 9910. State is
  stamped into the page at render — no boot fetch, no second paint — and written
  back debounced, with a `sendBeacon` flush when the tab goes away.

## v1.1.1

- **Fixed: opening the console squashed the page behind it.** Panels in a
  scrolling flex column inherit `flex-shrink: 1`, and `.panel` sets
  `min-height: 0`, so halving the viewport squeezed each card to a third of its
  height and its contents painted over the card below. The container scrolls;
  children keep their natural size. Same guard applied to the events list, the
  overview row lists and the namespace picker.

## v1.1.0

**digg is live.** Tables and detail pages are fed by Kubernetes watches over a
WebSocket instead of a five-second poll: a pod appears the moment it is
scheduled, goes yellow the moment it restarts, and disappears when it is gone.

- **Watches, not polls.** The server runs `kubectl get <kind> --watch
  --output-watch-events -o json` — one process per (context, kind, namespace),
  refcounted across every tab and page, killed ten seconds after the last
  reader leaves. Shelling out keeps kubectl in charge of authentication, so
  exec plugins (aws/gcp/oidc), client certs and tokens all keep working; an
  embedded `kubectl proxy` would have been faster to write and would have
  opened an unauthenticated cluster-admin port on localhost.
- **Deltas that are deltas.** Only rows whose rendered form actually changed go
  down the wire, coalesced into 100ms frames, so a rollout emitting hundreds of
  events a second still renders at a readable rate.
- **Metrics stay polled, deliberately.** `metrics.k8s.io` implements only get
  and list (`watch is not supported on resources of kind pods.metrics.k8s.io`)
  and metrics-server samples on its own schedule — 60s by default — so usage
  bars refresh on a 15s timer rather than pretending to stream. Lens splits it
  the same way; its charts are Prometheus `query_range` polls at a 60s step.
- **Degradation is visible, never silent.** A kind with no watch verb, a
  dropped socket or a paused session falls back to polling automatically, the
  last known rows stay on screen while it switches, and the dot on the pause
  button says which mode you are in. Objects listed before an unwatchable kind
  fails are still shown.
- **Deleting the object you are looking at** now closes its page and says so,
  instead of leaving a detail view that quietly stopped updating.
- **Refresh actually refreshes, visibly.** On a live stream the button used to
  do nothing at all: it kicked the pollers, and streaming views do not poll. It
  now re-asks the socket for a fresh snapshot, spins its icon and shows the
  progress hairline — an action that changes nothing on screen still has to be
  acknowledged.
- **The console button toggles**, like ⌘J always did, and shows a pressed
  state. Hiding the console no longer kills what is running in it: the panel is
  hidden with CSS rather than unmounted, because unmounting an xterm closes its
  socket and the server kills the pty with it.

**Detail pages that answer the question.** Pods, workloads and nodes get a full
page instead of a summary and a table — the shape Aptakube proved right.

- **Deployment / StatefulSet / DaemonSet / ReplicaSet / Job pages**: identity
  card (age, namespace, selector, labels, annotations), the rollout knobs
  (strategy, max surge, max unavailable) with live conditions, the scheduling
  block that explains a Pending pod (node selector, node affinity, topology
  spread, tolerations), container cards with usage against their own requests
  and limits, and the pods the workload owns — desired/updated/ready/available,
  each row with CPU and memory bars, restarts, last restart and its reason.
- **Pod pages**: phase, conditions, start time, pod IP, host IP, node, service
  account, QoS, priority class, restart policy; per-container status
  (Running/Started/Ready), restart reason, and CPU/memory usage with the
  allocation it was given. Container cards open logs or a shell in place.
- **Revisions tab** for deployments, statefulsets and daemonsets: every
  revision as a real object you can open, the live one marked, one-click
  rollback to any older one.
- **Usage columns in the tables.** Pods, workloads and nodes now show CPU and
  memory with a bar — filled against the limit, ticked at the request, so
  throttling and OOM risk are visible while scanning. Nodes also get pods
  against capacity and CPU/memory allocation percentages. Deployments gained a
  DESIRED column.
- **Ingress rules are clickable.** The routes column lists every rule as an
  openable URL (https when the host is in a TLS block) beside the Service it
  lands on, one route per line — the grid now lays out variable-height rows.
- **Port-forward moved into the page header**, beside Shell and Actions, for
  pods and services — it is a verb you apply to the object, not a fact about
  it, and it was buried under the container cards.
- No metrics-server still means a hatched bar, never a confident 0%.

## v1.0.0

**digg is now a browser cockpit.** The terminal UI is gone; `digg` starts the
server and opens your cluster in a browser. Everything the TUI did, the web UI
does — and a good deal it never could.

### Breaking

- **The TUI is removed.** `digg` and `digg serve` are the same command. The
  single-letter keybindings (`:`, `n`, `c`, `y`, `d`, `l`, `s`, `f`, `S`, `T`,
  `X`, …) no longer exist. Dropped the `@earendil-works/pi-tui` and `chalk`
  dependencies with it.
- **Shortcuts are ⌘ chords only** — `⌘K` palette, `⌘F` filter, `⌘J` console,
  `⌘S` apply, `⌘⌥R` refresh, `⌘/` help. A bare letter is never a shortcut: this
  app is full of filter boxes, a YAML editor and a live shell, and a single key
  that does something global is a key that fires while you meant to type.

### The browser UI

- **Every kind, grouped** — Cluster, Workloads, Config, Network, Storage, Access
  Control, Definitions, then every CRD bucketed by API group. ~20 new curated
  kinds (RBAC, PVs, StorageClasses, HPAs, PDBs, webhooks, leases, …). Nothing is
  listed that the cluster does not have; nothing it has is hidden.
- **Cluster overview** with live CPU/memory from `kubectl top`, requested vs.
  used on one track, pods needing attention, and a warning feed. A cluster with
  no metrics-server gets hatched gauges instead of a confident 0%.
- **A real datagrid** — virtualised, sorted on values not text (age by
  timestamp, `3/5` by ratio), filterable, multi-select with shift/⌘ ranges,
  column visibility, right-click actions.
- **Full-page resource views** at real URLs (`/k/pods/demo/api-7d9f`) with
  Overview / Data / YAML / Describe / Events / Logs.
- **ConfigMap & Secret data editor** — every key decoded into its own field, add
  and remove keys, save only what you touched. Secret values masked until
  revealed; binary entries marked read-only rather than corrupted; saves go
  through `stringData` so the API server does the base64.
- **Ingress routing view** that resolves every backend against live Services and
  Endpoints — "1 endpoints", "no endpoints", "no such service" — with clickable
  URLs that pick https from the TLS block.
- **YAML editor** (CodeMirror) with search and folding; ⌘S applies, and a
  background refresh never overwrites a buffer you are editing.
- **Live logs** — follow, search with highlight, only-matches, wrap, timestamps,
  `--previous`, container picker, adjustable history, download.
- **Shells in the browser** over a real PTY: any container, a node via `kubectl
  debug`, or a local shell. Shell-less images (distroless, scratch) explain
  themselves and offer an ephemeral debug container.
- **Port-forward manager** with server-side state, so forwards survive a reload.
- **A console that follows you** (⌘J) — shells and forwards float above every
  page and survive navigation.
- **Every day-2 action**: apply, delete (incl. bulk), scale, restart, rollback,
  cordon/uncordon/drain, suspend/resume/trigger CronJobs. Destructive ones ask;
  irreversible ones want the object's name typed.
- **URL-backed state** via nuqs — namespace selection, table filter, open tab and
  log container all live in the query string, so reload, back/forward and a
  pasted link restore the same screen.
- Light and dark throughout, including a full terminal ANSI palette per theme.

### Security

`digg serve` binds 127.0.0.1 and mints a **per-run token** embedded in the page
it serves; every API call and terminal WebSocket requires it, and cross-origin
requests are refused. Localhost is not an access boundary — any page you visit
can send requests to it, and WebSocket handshakes are not covered by the
same-origin policy at all.

### Internals

- The UI is a React + Vite app under `web/`, compiled to one self-contained HTML
  document and baked into `src/web/bundle.ts`, which is committed — a clean
  checkout builds with nothing but Bun. A content hash refuses a stale bundle.
- `src/pty.ts` allocates real PTYs via `bun:ffi` (`openpty` + an ioctl shim
  compiled at runtime), verified working inside a `bun build --compile` binary.

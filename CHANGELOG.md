# Changelog

## Unreleased

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

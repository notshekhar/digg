# Changelog

## v2.2.0

- **`digg update` shows you the download.** Both installers have drawn a
  ■■■･･･ bar since v1.4.2; the self-updater — the easy path, the one you are
  meant to use — printed a line and then sat silent for the length of an 80MB
  transfer, which on a slow link is indistinguishable from a hang. It now draws
  the same bar, glyph for glyph, off bytes that have actually arrived. Piped or
  redirected output stays a clean log.
- **And it is no longer capped at one minute.** The updater's HTTP client had a
  60-second timeout that covered reading the body, so any connection slower than
  about 11 Mbit had the download killed partway through. The header timeout
  still catches a server that never answers; after that a slow link is allowed
  to be slow.
- **Services get a real page.** A Service used to be six key/value rows and a
  list of pods, which is a thin answer for an object that is almost entirely
  pointers. It is now parsed the way pods and workloads are: every port as its
  own row with its targetPort, nodePort and appProtocol, the in-cluster DNS name
  you actually paste into another app's config, session affinity and both
  traffic policies, IP families, source ranges, and the headless case named as
  headless instead of reported as "Cluster IP: None".
- **A Service now says why nothing is serving it.** `kubectl` prints only the
  ready endpoints, so a Service with no selector, a selector matching no pods,
  and matched pods all failing readiness look identical — three different bugs
  with three different fixes. Each is now its own sentence, and the pod table
  underneath is counted in the Service's own words (selected / serving / not
  serving) rather than a workload's rollout counters.
- **Every page shows what the object is connected to.** A new Related block
  follows the pointers that go *into* an object as well as out of it: the
  Deployment behind a Service (through its pods' owner chain, and through pod
  templates when the Service has no endpoints at all), the Ingresses routing to
  it, the workloads that mount a ConfigMap or read a Secret, the pods holding a
  PVC open, the bindings that grant a Role, the HPA that scales a workload and
  the PodDisruptionBudget that protects it, a pod's route in from the outside
  two hops away. Kinds without a rich page — ConfigMaps, Secrets, PVCs,
  ServiceAccounts, RoleBindings, IngressClasses — get it too; for several of
  them the links are the entire point of the object.
- **Broken links stay links.** An Ingress backend that does not exist is
  labelled "no such Service" and remains clickable, because opening it and
  getting a 404 is a clearer answer than a name that was never a link.
- **Twelve replicas fold into the one Deployment that made them.** Every list of
  pods reached through a relation is collapsed to its controller, hinted with
  how many pods it accounts for, so "who mounts this ConfigMap" is one row and
  not one row per replica. Jobs fold into their CronJob the same way.
- **A CronJob's mounts are no longer invisible.** Its pod template sits one
  level deeper than every other workload's, behind `jobTemplate`, which meant a
  Secret used only by a CronJob read as unused.

## v2.1.0

- **Waiting looks like the thing you are waiting for.** Every screen used to
  answer a slow read with a 10px spinning square in the top-left corner and a
  line of text, and then replace it wholesale with a table — so a navigation was
  a blank, a flash and a jump. Each screen now draws its own geometry instead: a
  table keeps its real header row and its real column widths, because the kind
  catalog carries the column names before the first row is fetched; a detail
  page keeps its header, its tabs and its fact grid; the overview keeps its
  context name and its stat row; YAML and describe keep an indented document.
  The data lands in place of the placeholders rather than in place of a screen.
- **And nothing at all appears for the first 160ms.** Most reads answer in
  single-digit milliseconds, so the old spinner was usually a one-frame flash —
  movement the eye registers and cannot read. Below the threshold the screen
  simply does not change.
- **Revisiting a table you have already opened costs the cluster nothing.** The
  watch behind every table holds the whole collection in memory, and reads are
  now answered from that store when one is running and synced — 18µs against
  8.5ms on a local cluster, and a whole round trip against a remote one.
  Streams are also kept for five minutes after the last reader rather than ten
  seconds, which is what makes walking away and coming back free.
- **Opening a table no longer asks the cluster for it twice.** The socket and
  the polling fallback both fired on mount; the poll now waits 300ms for the
  socket and is skipped entirely when the snapshot beats it.
- **Reads come from the apiserver's watch cache** (`resourceVersion=0`, the same
  thing every informer in Kubernetes does on its initial list) instead of a
  quorum read through etcd. Writes and read-after-write paths are unchanged.
- **Page builds stopped waiting in a queue.** A detail page built its section
  and its rich view one after the other, and the usage columns fetched metrics
  and then listed pods; each of those is now concurrent, which is most
  noticeable on a cluster that is not on your laptop. Deployments list on
  minikube: 27ms → 13ms.
- **Metrics are fetched once per 10s, not once per question.** metrics-server
  samples every 60s and its readings carry `window: 1m`, so the four calls one
  navigation used to make returned identical numbers; concurrent misses now
  collapse into a single upstream call.

## v2.0.0

- **digg is a Go program now, and it no longer needs kubectl.** It reads your
  kubeconfig and talks to the API server itself, so every auth method still
  works — client certs, tokens, and exec plugins like aws/gcp/oidc, which are
  launched from the kubeconfig rather than by kubectl. One static binary with
  nothing to install alongside it, and half the size: 26MB against 56MB.
- **Watches survive a dropped connection.** The old build drove `kubectl
  --watch`, which reports no resourceVersion and no marker for "the first list
  is done" — so every reconnect re-listed the whole collection, and the table
  had to guess when its opening burst had finished by waiting for 250ms of
  quiet. Watches are informers now: they resume from where they left off, share
  one upstream stream across every tab and subscription, and know when they are
  synced. Measured on a live cluster, a reconnect costs zero extra list calls.
- **Metrics are no longer rounded.** They come from `metrics.k8s.io` directly
  rather than from `kubectl top`, which prints whole mebibytes — where a
  container reads 1Mi in kubectl, its card here reads 1.8Mi. Clusters with no
  metrics-server still show hatched gauges rather than a confident 0%.
- **One connection per cluster, not one per question.** Opening a page used to
  re-run your exec credential plugin and redo a TLS handshake for each request
  it made. Now that happens once for the life of the process, which is most
  noticeable on EKS and GKE, where every one of those was a subprocess.
- **`digg update` updates itself.** It resolves the latest release, verifies
  its checksum, and replaces the binary in place — including when the thing on
  your PATH is a symlink into `~/.digg-bin`, where it replaces the file the link
  points at instead of clobbering the link. If the swap fails the previous
  binary is put back, so an interrupted update never leaves you without a
  working digg. `digg update --check` says what it would do without downloading
  anything, and `--version=vX.Y.Z` installs a specific release.
- **The YAML editor's cursor is visible in dark mode.** It was drawing a black
  caret on a dark background: the editor never enabled its own selection layer,
  so every cursor rule in the theme was dead CSS and CodeMirror's default took
  over. It now draws a 2px accent cursor that follows the light/dark toggle at
  runtime. Fold markers got a real hit area too — they were a chevron in a
  9px-wide column with a 1px target, easy to mistake for punctuation — and a
  folded block stays visibly folded instead of only showing it on hover.

Three things behave differently to v1.x. Applying a manifest uses server-side
apply under the field manager `digg`. `digg version` reports digg's own build
rather than the kubectl it used to shell out to. And kubectl is no longer a
runtime dependency at all — a readable kubeconfig is the only precondition.

## v1.5.0

- **The names in a workload's spec are links now.** A Deployment's YAML is full
  of pointers — the ConfigMap a volume mounts, the Secret one env var reads a
  single key out of, the claim a StatefulSet writes to — and following one used
  to mean reading the manifest, holding a name in your head and going to find it
  in another list. Pods and workloads grow a **References** group instead, with
  every ConfigMap, Secret and volume claim the spec names, each one a click away
  from its own page. Every site the API server resolves is walked, not just the
  obvious two: `projected` sources, `envFrom`, `env[].valueFrom`,
  `imagePullSecrets` and the CSI and in-tree driver `secretRef`s. A name reached
  more than once appears once, carrying where it was reached from — `volume
  config, envFrom in app` — because which of six ConfigMaps a container actually
  reads, and whether as a file or an env var, is the question the group exists
  to answer. Workloads also link their service account and priority class; a pod
  already showed the first and now links the second. A spec that names nothing
  gets no group rather than a heading over three dashes.
- **The log pane reads levels instead of guessing at them.** It used to scan
  each line for words: anything containing "failed" was an error, so
  `INFO reconcile complete: 0 failed` painted the pane red and a real error
  stopped standing out. Levels now come from where loggers actually write them
  — klog's `E0725` letter, a JSON `level` field (including pino's numeric
  levels), a logfmt `level=`, a bracketed `[error]` or a shouted `ERROR` near
  the head of the line — and only fall back to keywords for markers that are
  never prose, like `panic:` and `Traceback`. A stack frame with no level of
  its own stays with the error above it.
- **Levels are shown, not just tinted.** Each line gets a severity stripe and a
  fixed-width level tag, so every message starts at the same column no matter
  what shape the line arrived in. Timestamps, keys, quoted values, URLs, IPs
  and numbers are coloured quietly on top. Error and warn lines carry a wash;
  the message text itself stays at reading contrast, because a pane where every
  error line is red is a pane where the error is the least legible text on it.
- **Filter by level**, with error and warning counts in the bar that are
  themselves the filter for that level. Search highlighting composes with the
  token colouring rather than replacing it, and a filtered pane says how many
  of how many lines it is showing.
- Rows are keyed by a sequence id and parsed once on arrival, so trimming the
  head of a chatty pod's buffer no longer re-renders — or re-colours — every
  line still on screen.

## v1.4.2

- **The download shows the ■■■･･･ bar** that hehe, loop and markdown install
  with, instead of curl's own line. It is the same implementation: curl traces
  into a FIFO, and content-length plus `<= recv data` records drive the bar. A
  terminal gets it; a pipe or a host without FIFOs falls back to plain curl and
  installs exactly as before.
- **A Windows installer.** `irm https://raw.githubusercontent.com/notshekhar/digg/main/install.ps1 | iex`
  — streamed with the same bar (HttpClient with `ResponseHeadersRead`, so it
  moves before the body lands), checksum verified, installed to
  `%LOCALAPPDATA%\digg` and added to your user PATH. It says so plainly if
  kubectl is not on PATH, since digg cannot reach a cluster without it. The sh
  installer now points Windows users here rather than at the Releases page.

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

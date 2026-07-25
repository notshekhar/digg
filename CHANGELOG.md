# Changelog

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

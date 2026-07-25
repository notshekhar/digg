# digg

A **Kubernetes cockpit in your browser** — the ground Lens and Aptakube cover,
as a single binary you run from a terminal. Browse every resource the cluster
exposes (built-ins and CRDs), read a cluster overview with live CPU and memory,
edit YAML, stream logs, **shell into containers**, **port-forward**, and run
every day-2 action: scale, restart, roll back, cordon/drain, suspend cron,
delete.

It drives your local `kubectl`, so every auth method works out of the box —
client certs, tokens, and exec plugins like aws/gcp/oidc. **kubectl must be on
your PATH.**

## Install

Prebuilt binary — macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/notshekhar/digg/main/install.sh | bash
```

Windows:

```powershell
irm https://raw.githubusercontent.com/notshekhar/digg/main/install.ps1 | iex
```

From source:

```bash
bun install
bun ./src/cli.ts        # run it
bun build-bin.ts        # standalone binary in dist/bin/<target>/digg
```

Update with `digg update`. Uninstall with `DIGG_UNINSTALL=1 curl -fsSL .../install.sh | bash`,
or `irm .../install.ps1 | iex` with `-Uninstall` on Windows.

## Usage

```bash
digg                       # opens http://127.0.0.1:9787/ in your browser
digg --port 8080           # pick a port
digg --no-open             # print the URL only
digg update                # update to the latest version
digg version               # print the version
```

`digg serve` does the same thing, said explicitly.

### What you get

- **Every kind, grouped.** Cluster, Workloads, Config, Network, Storage, Access
  Control, Definitions, then every CRD bucketed by API group. Nothing is listed
  that the cluster does not have, and nothing the cluster has is hidden.
- **Cluster overview.** Node and pod capacity with live CPU/memory from
  `kubectl top`, requested-vs-used on one track, pods needing attention, and a
  warning-event feed. Clusters with no metrics-server show hatched gauges rather
  than a confident 0%.
- **A real datagrid.** Virtualised (thousands of rows stay smooth), sortable on
  values not text, filterable, multi-select with shift/⌘ ranges, per-column
  visibility, right-click actions, and full keyboard nav.
- **Detail drawer.** Overview / YAML / Describe / Events / Logs for any object,
  side by side with the list. Owner and related objects drill through.
- **YAML editor.** CodeMirror with syntax highlighting, search and folding.
  ⌘S applies. A background refresh never overwrites a buffer you are editing.
- **Live logs.** Follow, search with highlight, filter to matches, wrap,
  timestamps, `--previous`, container picker, adjustable history, download.
- **Shell in the browser.** A real PTY into any container, a node shell via
  `kubectl debug`, or a local shell with kubectl pointed at the context.
- **A console that follows you.** Shells and port-forwards live in a floating
  console (⌘`) that is reachable from every page and survives navigation — a
  shell opened from a pod keeps running while you go read something else.
- **Port-forward manager.** Start from any pod or service, pick a local port or
  let the kernel choose, and the forwards keep running in the dock — a page
  reload does not kill them.
- **Every day-2 action.** Apply, delete (incl. bulk), scale, restart rollout,
  rollback to a revision, cordon / uncordon / drain, suspend / resume / trigger
  CronJobs. Destructive ones ask; irreversible ones want the name typed.
- **⌘K palette.** Jump to any kind, namespace, cluster, or live pod.
- **Everything is a URL.** Real paths (`/k/pods/demo/api-7d9f`) plus query state
  for the namespace selection, table filter, open tab and log container — so
  reload, back/forward and a pasted link all restore the same screen.
- Light and dark, `?` for the keymap, prefs persisted in `~/.digg/settings.json`.

**Security.** The server binds 127.0.0.1 and mints a token per run which it
embeds in the page it serves. Every API call and every terminal WebSocket
requires it, and cross-origin requests are refused. That matters because
localhost is not a security boundary: any web page you visit can send requests
to it, and WebSocket handshakes are not covered by the same-origin policy at
all. A page from another origin can never read digg's HTML, so it can never
learn the token.

### Keys

Every global shortcut takes ⌘ (ctrl on Linux/Windows). Bare letters are not
bound to anything: this app is full of filter boxes, a YAML editor and a live
terminal, and a single key that does something global is a key that fires while
you meant to type.

| Key            | Action                                    |
| -------------- | ----------------------------------------- |
| `⌘K`           | palette — kinds, namespaces, clusters, pods |
| `⌘F`           | filter the current table                  |
| `⌘J`           | console — shells and port-forwards        |
| `⌘S`           | apply the YAML you are editing            |
| `⌘⌥R`          | refresh now                               |
| `⌘/`           | keyboard help                             |
| `esc`          | back to the table / close what is open    |
| `↑` `↓`, `enter`, `space` | move, open, select (inside a table) |
| right-click    | actions for a row                         |

### Resource pages

Click any row for its own page — URL and all, so it can be pasted into Slack.
Every page carries a summary, the objects that matter to it, and live events:

- **workloads** (deployment / statefulset / daemonset / job) → their pods with
  live CPU and memory, plus Scale, Restart and Rollback.
- **pods** → containers, ports and metrics; shell in, port-forward, stream logs.
- **services** → the pods actually behind them, ports and selector.
- **ingresses** → a routing table that resolves every backend against the
  cluster: host, path, service:port, whether that service exists and how many
  endpoints it has, and a clickable URL (https when the host is in a TLS block).
  A typo'd backend shows up red instead of silently 404ing later.
- **nodes** → pods on the node, capacity, conditions; cordon, drain, node shell.
- **configmaps / secrets** → a real **Data editor**: every key decoded into its
  own textarea, add and remove keys, save only what you touched. Secret values
  are masked until revealed, binary entries are marked read-only rather than
  corrupted, and saves go through `stringData` so the API server does the
  base64. Raw YAML is still one tab over when you want it.
- **PVCs** → the pods mounting them. **cronjobs** → recent jobs, suspend, trigger.

Tabs on every page: Overview, YAML (editable, ⌘S applies), Describe, Events,
Logs. `esc` goes back to the table you came from, with your filter intact.

## Resources

Curated kinds — Pods, Deployments, StatefulSets, DaemonSets, Services, Ingresses,
ConfigMaps, Secrets, Jobs, CronJobs, Nodes, Namespaces, PVCs — get rich columns
and tailored dashboards. Press `:` to switch to those **or any other kind the
cluster exposes** (CRDs, RBAC, HPAs, …), discovered via `kubectl api-resources`;
those open a generic list with yaml / describe / edit / delete / events.

## Development

The server is plain TypeScript under `src/`. The browser UI is a React + Vite app
under `web/`, compiled to a single self-contained HTML document and baked into
`src/web/bundle.ts`, which is committed — so a clean checkout runs and builds
with nothing but Bun.

```bash
bun test                 # unit + live-cluster integration suite
bun run typecheck
bun run build:web        # after ANY change under web/src — rebuilds bundle.ts
bun run build            # standalone binary (refuses a stale bundle)

cd web && bun run dev    # Vite dev server on :9788, proxying to digg serve
```

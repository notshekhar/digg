# digg

A **Kubernetes cockpit in your browser** — the ground Lens and Aptakube cover,
as a single binary you run from a terminal. Browse every resource the cluster
exposes (built-ins and CRDs), read a cluster overview with live CPU and memory,
edit YAML, stream logs, **shell into containers**, **port-forward**, and run
every day-2 action: scale, restart, roll back, cordon/drain, suspend cron,
delete.

It reads your kubeconfig and talks to the API server directly, so every auth
method works out of the box — client certs, tokens, and exec plugins like
aws/gcp/oidc. **No kubectl required**, just a kubeconfig.

One static binary, no runtime, no dependencies.

## Install

Prebuilt binary — macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/notshekhar/digg/main/install.sh | bash
```

Windows:

```powershell
irm https://raw.githubusercontent.com/notshekhar/digg/main/install.ps1 | iex
```

With Go:

```bash
go install github.com/notshekhar/digg/src/cmd/digg@latest
```

From source:

```bash
git clone https://github.com/notshekhar/digg && cd digg
go build -o digg ./src/cmd/digg && ./digg
```

The browser UI is committed pre-built, so a clean checkout needs nothing but the
Go toolchain.

Update with `digg update` — it resolves the latest release, verifies its
sha256, and swaps the binary in place (resolving the install symlink, so the
install is never orphaned). Uninstall with
`DIGG_UNINSTALL=1 curl -fsSL .../install.sh | bash`, or `irm .../install.ps1 | iex`
with `-Uninstall` on Windows.

## Usage

```bash
digg                       # opens http://127.0.0.1:9787/ in your browser
digg --port 8080           # pick a port
digg --host 0.0.0.0        # bind elsewhere (read the security note first)
digg --no-open             # print the URL only
digg update                # update to the latest version
digg update --check        # say what an update would do, download nothing
digg update --version=v2.0.0   # install a specific release
digg version               # print the version
```

`digg serve` does the same thing as bare `digg`, said explicitly, and
`digg upgrade` is an alias for `digg update`.

### What you get

- **Every kind, grouped.** Cluster, Workloads, Config, Network, Storage, Access
  Control, Definitions, then every CRD bucketed by API group. Nothing is listed
  that the cluster does not have, and nothing the cluster has is hidden.
- **Cluster overview.** Node and pod capacity with live CPU/memory read
  straight from `metrics.k8s.io` (unrounded — where `kubectl top` says 1Mi you
  get 1.8Mi), requested-vs-used on one track, pods needing attention, and a
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
- **Shell in the browser.** A real terminal into any container over the exec
  API, a node shell via a privileged debug pod, an ephemeral busybox for
  shell-less images (distroless, scratch), or a local shell with the context
  pre-selected.
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
cluster exposes** (CRDs, RBAC, HPAs, …), discovered from the API server itself;
those open a generic list with yaml / describe / edit / delete / events.

## Development

digg is a Go program. The browser UI is a React + Vite app under `web/`,
compiled to one self-contained HTML document and committed to
`src/internal/server/webdist/` — a clean checkout builds with only Go.

```
src/cmd/digg          the CLI
src/internal/kube     cluster access: client, resources, watch, metrics,
                      events, logs, exec, pty, forwards, discovery, drain
src/internal/model    pure logic — the kind table, detail views, usage
                      arithmetic, quantity parsing (all unit-tested)
src/internal/server   HTTP + WebSockets, rows, gauges, catalog, overview,
                      actions, detail, live deltas
src/internal/settings ~/.digg/settings.json
src/internal/update   `digg update` — the self-updater
web/                  the React app
```

```bash
go build -o digg ./src/cmd/digg   # build
go test ./...                     # unit + live-cluster suite (skips with no cluster)
go vet ./...

bun run build:web                 # after ANY change under web/src
cd web && bun run dev             # Vite dev server on :9788, proxying to digg
```

The live-cluster tests skip themselves when there is no reachable cluster, so
`go test ./...` is green on a laptop with no kubeconfig and thorough on one with
minikube running.

CI cross-compiles all five release targets on every push, and checks that the
committed web bundle still matches `web/src` — a stale bundle would otherwise
ship silently.

### Talking to Kubernetes

digg uses `client-go` directly rather than shelling out to `kubectl`:

- **Watches are informers.** They resume from a `resourceVersion` after a
  dropped connection instead of re-listing, share one upstream stream across
  every tab and subscription, and know when the initial sync is done.
- **One client per context** means one exec-credential plugin run and one TLS
  handshake for the process lifetime, not per request.
- **Writes go through kubectl's own libraries** (`describe`, `drain`,
  `polymorphichelpers`), so the output and error text are the ones you already
  know.

Reads stream; metrics poll. That split is not a compromise — `metrics.k8s.io`
implements only get and list, and metrics-server samples on its own schedule.

Three behaviours differ from the pre-2.0 releases, which shelled out to kubectl:
**apply** uses server-side apply with the field manager `digg`; **kubectl is no
longer required on PATH** (a readable kubeconfig is the only precondition); and
`version` reports digg's own build rather than kubectl's.

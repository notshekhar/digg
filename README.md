# digg

A fast **Kubernetes TUI** for your terminal — a Lens/k9s-style cockpit that
browses **any** resource (built-ins and CRDs), opens a rich per-kind dashboard
with live **events** on every object, streams logs, **shells into pods**,
**port-forwards**, and runs day-2 actions (scale, restart, cordon/drain,
suspend cron). Switch namespaces and contexts; view/edit YAML and describe.
Built in Bun on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)
(the renderer behind pi).

It wraps your local `kubectl`, so every auth method (client certs, tokens, and
exec plugins like aws/gcp/oidc) works out of the box. **kubectl must be on your
PATH.**

## Install

Prebuilt binary:

```bash
curl -fsSL https://raw.githubusercontent.com/notshekhar/digg/main/install.sh | bash
```

From source:

```bash
bun install
bun ./src/cli.ts        # run it
bun build-bin.ts        # standalone binary in dist/bin/<target>/digg
```

Update with `digg update`. Uninstall with `DIGG_UNINSTALL=1 curl -fsSL .../install.sh | bash`.

## Usage

```bash
digg            # launch the cluster browser
digg update     # update to the latest version
digg version    # print the version
```

### Keys

| Key            | Action                          |
| -------------- | ------------------------------- |
| `↑`/`↓`, `j`/`k` | move                          |
| `g` / `G`      | top / bottom                    |
| `:`            | switch resource kind (any CRD)  |
| `n`            | switch namespace                |
| `c`            | switch context                  |
| `/`            | filter by name                  |
| `enter`        | open detail dashboard           |
| `y`            | view YAML (`e` to edit)         |
| `d`            | describe                        |
| `l`            | logs (live)                     |
| `s`            | shell / exec into a pod         |
| `f`            | port-forward (pod / service)    |
| `S`            | scale (deploy / sts / rs)       |
| `T`            | restart rollout                 |
| `C` / `U`      | cordon / uncordon a node        |
| `D`            | drain a node                    |
| `space`        | suspend / resume a CronJob      |
| `t`            | trigger a CronJob now           |
| `r`            | rollout revisions (deployments) |
| `X`            | delete (confirm)                |
| `R`            | refresh now                     |
| `esc`          | back / clear filter             |
| `ctrl+c`       | quit                            |

The list auto-refreshes every few seconds. Mouse wheel scrolls everywhere.

### Detail dashboard

Press `enter` on **any** resource to drill into a Lens/Aptakube-style dashboard
— no more raw YAML dumps. Every page shows a **summary**, a relevant **section**,
and a live **Events** panel:

- **workloads** (deployment / statefulset / daemonset / job) → live **pods with
  CPU / memory** (`kubectl top`); `p` open pod, `l` aggregated logs, `S` scale,
  `T` restart, `r` revisions.
- **pods** → containers + pod metrics; `s` shell in, `f` port-forward, `l` logs.
- **services** → endpoint pods + ports/selector; `f` port-forward.
- **nodes** → pods on the node + capacity/roles/version; `C`/`U` cordon, `D` drain.
- **configmaps / secrets** → data keys (`enter` reveals a value; secrets decoded).
- **ingresses** → host/path → service rules. **PVCs** → mounting pods.
- **cronjobs** → recent jobs; `space` suspend, `t` trigger now.

Logs stream live (`kubectl logs -f`) and auto-follow the tail; `f` toggles
follow, `G` jumps to live. Shells suspend the TUI and hand you the raw terminal
(`/bin/bash`, falling back to `/bin/sh`), then restore on exit. Port-forwards
keep running in the background and show in the header while you browse.

## Resources

Curated kinds — Pods, Deployments, StatefulSets, DaemonSets, Services, Ingresses,
ConfigMaps, Secrets, Jobs, CronJobs, Nodes, Namespaces, PVCs — get rich columns
and tailored dashboards. Press `:` to switch to those **or any other kind the
cluster exposes** (CRDs, RBAC, HPAs, …), discovered via `kubectl api-resources`;
those open a generic list with yaml / describe / edit / delete / events.

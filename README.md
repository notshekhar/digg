# kube

A fast **Kubernetes TUI** for your terminal — browse pods, deployments,
services, nodes and more; switch namespaces and contexts; view YAML, describe,
and logs. Built in Bun on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)
(the renderer behind pi).

It wraps your local `kubectl`, so every auth method (client certs, tokens, and
exec plugins like aws/gcp/oidc) works out of the box. **kubectl must be on your
PATH.**

## Install

Prebuilt binary:

```bash
curl -fsSL https://raw.githubusercontent.com/notshekhar/kube/main/install.sh | bash
```

From source:

```bash
bun install
bun ./src/cli.ts        # run it
bun build-bin.ts        # standalone binary in dist/bin/<target>/kube
```

Update with `kube update`. Uninstall with `KUBE_UNINSTALL=1 curl -fsSL .../install.sh | bash`.

## Usage

```bash
kube            # launch the cluster browser
kube update     # update to the latest version
kube version    # print the version
```

### Keys

| Key            | Action                |
| -------------- | --------------------- |
| `↑`/`↓`, `j`/`k` | move                |
| `g` / `G`      | top / bottom          |
| `:`            | switch resource kind  |
| `n`            | switch namespace      |
| `c`            | switch context        |
| `/`            | filter by name        |
| `enter` / `y`  | view YAML             |
| `d`            | describe              |
| `l`            | logs (pods)           |
| `x`            | delete (confirm)      |
| `R`            | refresh now           |
| `esc`          | back / clear filter   |
| `ctrl+c`       | quit                  |

The list auto-refreshes every few seconds. Mouse wheel scrolls everywhere.

## Resources

Pods, Deployments, StatefulSets, DaemonSets, Services, Ingresses, ConfigMaps,
Secrets, Jobs, CronJobs, Nodes, Namespaces, and PVCs. Press `:` to switch.

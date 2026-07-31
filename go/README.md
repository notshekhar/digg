# digg, in Go

A port of digg's backend from Bun/TypeScript to Go. The React app in `../web`
is **unchanged** — this serves the same bundle and speaks the same API, so the
two builds are interchangeable from the browser's point of view.

    go build -o digg ./cmd/digg && ./digg

## Why

Not speed. The Bun build already fixed that in v1.3.0 by putting one
`kubectl proxy` on a unix socket in front of every read; measured head to head
on the same cluster, `/api/list?kind=pods` is ~7ms there and ~9.5ms here. The
port is worth doing for what client-go removes:

| the Bun build had to | here |
|---|---|
| `watch.ts` + `api-watch.ts` + `watch-source.ts` + a refcounted registry — because `kubectl --watch` surfaces no resourceVersion and no "list done" marker | one `SharedIndexInformer`. Measured: 0 LIST calls, every reconnect resumes from a resourceVersion, subscribers share one upstream stream |
| `proxy.ts` + `apipath.ts` + `discovery.ts` — one long-lived `kubectl proxy` per context, hand-built REST paths, a memoised `api-resources` parse | one `rest.Config`. One exec-credential run and one TLS handshake for the process lifetime |
| `pty.ts` — 240 lines of bun:ffi, writing a C shim for the variadic ioctl to a temp file at runtime and compiling it with Bun's bundled TinyCC | `remotecommand` for pod/debug/node shells; `creack/pty` only for the local shell |
| `forwards.ts` — a kubectl child per forward, its stdout regex-scraped for `Forwarding from 127.0.0.1:54321` | `portforward.GetPorts()` returns the bound port as data |
| `bundle.ts` + `scripts/web-hash.ts` — the HTML committed as a TS string, freshness guarded by a content hash | `embed.FS`. The bundle cannot be stale relative to the binary |

Binary: 26MB stripped, against the Bun build's 56MB.

## Layout

    cmd/digg          the CLI (same flags as src/cli.ts)
    internal/kube     client, resources, watch, metrics, events, logs,
                      exec, pty, forwards, discovery, drain
    internal/model    pure logic, ported 1:1 from src/: quantity, format
                      (the KINDS table), details, detail-view, usage,
                      secret-yaml
    internal/server   HTTP + both WebSockets, rows, gauges, catalog,
                      overview, actions, detail, live, page, bundle
    internal/settings ~/.digg/settings.json — the SAME file the Bun build
                      writes, so the two are interchangeable

## Deliberate differences

- **Apply** uses server-side apply with field manager `digg`, rather than
  piping to `kubectl apply -f -`. Same API the CLI is built on; the field
  manager name differs and conflicts are forced.
- **`version.client`** reported kubectl's version. There is no kubectl now, so
  it carries digg's own build.
- **kubectl is no longer required on PATH.** The precondition is a readable
  kubeconfig. `clientcmd` implements the merge rules natively, so every auth
  method still works, including exec plugins.
- **`toEditableYaml`/`fromEditableYaml` were not ported.** They were referenced
  only by their own tests in the Bun build; the live editor path is the Data
  tab (`DecodeEntry` + a `stringData` merge patch), which is ported.

## Rebuilding the web bundle

`internal/server/webdist/index.html` is a copy of `../web/dist/index.html`.
After any change under `../web/src`:

    (cd .. && bun run build:web) && cp ../web/dist/index.html internal/server/webdist/

#!/usr/bin/env bun
import { getVersion, runUpgrade } from "./commands.ts";
import { DEFAULT_PORT, runServe } from "./serve.ts";

const HELP = `digg — a Kubernetes cockpit in your browser

Usage:
  digg                     Open the cluster browser (starts the server)
  digg serve               Same thing, said explicitly
  digg update, upgrade     Update to the latest version
  digg version             Print the version
  digg help                Show this help

Options:
  --port <n>               Port (default ${DEFAULT_PORT}; walks up if busy)
  --host <addr>            Host (default 127.0.0.1)
  --no-open                Print the URL only; do not open a browser
  -v, --version            Print the version
  -h, --help               Show this help

In the browser:
  Every kind the cluster exposes, grouped like Lens. A cluster overview with
  live CPU/memory. Sortable, filterable, multi-select tables. Per-object pages
  with YAML editing, describe, events and live logs. Real shells into containers
  and nodes, a port-forward manager, and every day-2 action (scale, restart,
  rollback, cordon/drain, suspend cron, delete).

  ⌘K palette · ⌘F filter · ⌘J console · ⌘/ shortcuts · esc back

digg drives your local kubectl, so every auth method works — client certs,
tokens, and exec plugins like aws/gcp/oidc. kubectl must be on your PATH.`;

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
        process.stdout.write(`${HELP}\n`);
        return;
    }
    if (args.includes("-v") || args.includes("--version") || args[0] === "version") {
        process.stdout.write(`${getVersion()}\n`);
        return;
    }
    if (args[0] === "update" || args[0] === "upgrade") {
        runUpgrade({ force: args.includes("--force") });
        return;
    }

    // Everything else is the server. `digg` and `digg serve` are the same
    // command: there is only one thing to run now.
    let port: number | undefined;
    let host: string | undefined;
    let open = true;
    const rest = args[0] === "serve" ? args.slice(1) : args;
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === "--port" && rest[i + 1]) {
            port = Number(rest[++i]);
        } else if (a.startsWith("--port=")) {
            port = Number(a.slice("--port=".length));
        } else if (a === "--host" && rest[i + 1]) {
            host = rest[++i];
        } else if (a.startsWith("--host=")) {
            host = a.slice("--host=".length);
        } else if (a === "--no-open") {
            open = false;
        } else {
            process.stderr.write(`digg: unknown option ${a}\n\n${HELP}\n`);
            process.exit(1);
        }
    }
    if (port !== undefined && (!Number.isFinite(port) || port <= 0)) {
        process.stderr.write("digg: invalid --port\n");
        process.exit(1);
    }
    await runServe({ port, host, open });
}

main();

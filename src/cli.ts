#!/usr/bin/env bun
import { run } from "./app.ts";
import { getVersion, runUpgrade } from "./commands.ts";

const HELP = `digg — a fast Kubernetes TUI

Usage:
  digg                     Launch the interactive cluster browser
  digg update, upgrade     Update to the latest version
  digg version             Print the version
  digg help                Show this help

Options:
  -v, --version            Print the version
  -h, --help               Show this help

Interactive keys:
  ↑/↓ or j/k    move          g/G    top/bottom
  enter         open detail   :      switch kind (any CRD)
  n             namespace     c      context
  /             filter        y      YAML (e to edit)
  d             describe      l      logs (live)
  s             shell (exec)  f      port-forward
  S             scale         T      restart rollout
  C/U           cordon/uncord D      drain node
  space         suspend cron  t      trigger cron
  r             revisions     X      delete (confirm)
  R             refresh       m      toggle mouse (select mode)
  esc           back          ctrl+c quit

Every resource opens a Lens-style dashboard with a summary, related
objects, and a live Events panel. Mouse wheel scrolls everywhere by
default; press m to release the mouse for text selection/copy.`;

function main(): void {
    const args = process.argv.slice(2);

    if (args.includes("-h") || args.includes("--help")) {
        process.stdout.write(`${HELP}\n`);
        return;
    }
    if (args.includes("-v") || args.includes("--version")) {
        process.stdout.write(`${getVersion()}\n`);
        return;
    }

    switch (args[0]) {
        case "update":
        case "upgrade":
            runUpgrade({ force: args.includes("--force") });
            return;
        case "version":
            process.stdout.write(`${getVersion()}\n`);
            return;
        case "help":
            process.stdout.write(`${HELP}\n`);
            return;
    }

    if (!process.stdout.isTTY) {
        process.stderr.write("digg: interactive UI requires a TTY.\n");
        process.exit(1);
    }

    run();
}

main();

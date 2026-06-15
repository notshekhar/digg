#!/usr/bin/env bun
import { run } from "./app.ts";
import { getVersion, runUpgrade } from "./commands.ts";

const HELP = `kube — a fast Kubernetes TUI

Usage:
  kube                     Launch the interactive cluster browser
  kube update, upgrade     Update to the latest version
  kube version             Print the version
  kube help                Show this help

Options:
  -v, --version            Print the version
  -h, --help               Show this help

Interactive keys:
  ↑/↓ or j/k    move          g/G    top/bottom
  :             switch kind   n      switch namespace
  c             switch ctx    /      filter
  enter / y     view YAML     d      describe
  l             logs (pods)   x      delete (confirm)
  R             refresh       esc    back / clear filter
  ctrl+c        quit`;

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
        process.stderr.write("kube: interactive UI requires a TTY.\n");
        process.exit(1);
    }

    run();
}

main();

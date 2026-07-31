// Command digg is a Kubernetes cockpit in your browser.
//
// Port of src/cli.ts. `digg` and `digg serve` are the same command: there is
// only one thing to run.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/notshekhar/digg/src/internal/kube"
	"github.com/notshekhar/digg/src/internal/server"
	"github.com/notshekhar/digg/src/internal/update"
)

// Version is stamped at build time with -ldflags "-X main.Version=…".
var Version = "dev"

const help = `digg — a Kubernetes cockpit in your browser

Usage:
  digg                     Open the cluster browser (starts the server)
  digg serve               Same thing, said explicitly
  digg update, upgrade     Update to the latest version
  digg version             Print the version
  digg help                Show this help

Options:
  --port <n>               Port (default %d; walks up if busy)
  --host <addr>            Host (default 127.0.0.1)
  --no-open                Print the URL only; do not open a browser
  -v, --version            Print the version
  -h, --help               Show this help

Update options:
  --force                  Reinstall even if already up to date
  --check                  Report what an update would do, download nothing
  --version=vX.Y.Z         Install a specific release

In the browser:
  Every kind the cluster exposes, grouped like Lens. A cluster overview with
  live CPU/memory. Sortable, filterable, multi-select tables. Per-object pages
  with YAML editing, describe, events and live logs. Real shells into containers
  and nodes, a port-forward manager, and every day-2 action (scale, restart,
  rollback, cordon/drain, suspend cron, delete).

  ⌘K palette · ⌘F filter · ⌘J console · ⌘/ shortcuts · esc back

digg reads your kubeconfig directly, so every auth method works — client certs,
tokens, and exec plugins like aws/gcp/oidc.`

func main() {
	args := os.Args[1:]

	// `update --version=v1.2.3` pins a release, so the bare -v/--version check
	// below must not swallow it.
	updating := len(args) > 0 && (args[0] == "update" || args[0] == "upgrade")

	for _, a := range args {
		if a == "-h" || a == "--help" {
			fmt.Printf(help+"\n", server.DefaultPort)
			return
		}
		if !updating && (a == "-v" || a == "--version") {
			fmt.Println(Version)
			return
		}
	}
	if len(args) > 0 {
		switch args[0] {
		case "help":
			fmt.Printf(help+"\n", server.DefaultPort)
			return
		case "version":
			fmt.Println(Version)
			return
		case "update", "upgrade":
			runUpdate(args[1:])
			return
		}
	}

	opts := server.Options{Open: true, Version: Version}

	rest := args
	if len(rest) > 0 && rest[0] == "serve" {
		rest = rest[1:]
	}
	for i := 0; i < len(rest); i++ {
		a := rest[i]
		switch {
		case a == "--port" && i+1 < len(rest):
			i++
			opts.Port = mustPort(rest[i])
		case strings.HasPrefix(a, "--port="):
			opts.Port = mustPort(strings.TrimPrefix(a, "--port="))
		case a == "--host" && i+1 < len(rest):
			i++
			opts.Host = rest[i]
		case strings.HasPrefix(a, "--host="):
			opts.Host = strings.TrimPrefix(a, "--host=")
		case a == "--no-open":
			opts.Open = false
		default:
			fmt.Fprintf(os.Stderr, "digg: unknown option %s\n\n", a)
			fmt.Fprintf(os.Stderr, help+"\n", server.DefaultPort)
			os.Exit(1)
		}
	}

	// Forwards and watches are children of this process; leaving them running
	// after ctrl+c would strand listening ports with no way to find them from
	// the UI again.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		kube.StopAllForwards()
		kube.StopAllWatches()
		os.Exit(0)
	}()

	if err := server.Run(opts); err != nil {
		fmt.Fprintf(os.Stderr, "digg: %v\n", err)
		os.Exit(1)
	}
}

func mustPort(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 || n > 65535 {
		fmt.Fprintln(os.Stderr, "digg: invalid --port")
		os.Exit(1)
	}
	return n
}

func runUpdate(args []string) {
	opts := update.Options{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--force" || a == "-f":
			opts.Force = true
		case a == "--check" || a == "-n":
			opts.Check = true
		case strings.HasPrefix(a, "--version="):
			opts.Version = strings.TrimPrefix(a, "--version=")
		case a == "--version" && i+1 < len(args):
			i++
			opts.Version = args[i]
		default:
			fmt.Fprintf(os.Stderr, "digg update: unknown option %s\n", a)
			os.Exit(1)
		}
	}
	if err := update.Run(Version, opts); err != nil {
		fmt.Fprintf(os.Stderr, "digg: %v\n", err)
		os.Exit(1)
	}
}

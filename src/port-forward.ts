// Background `kubectl port-forward` processes. Unlike logs (a full-screen view),
// forwards keep running while you browse — so this just tracks the child
// processes and surfaces a one-line status. Stopped on quit or on demand.

interface Forward {
    proc: ReturnType<typeof Bun.spawn>;
    label: string; // e.g. "svc/api 8080:80"
}

export class PortForwardController {
    private forwards: Forward[] = [];

    /** Spawn a forward. argv is the full kubectl argv (sans "kubectl"). */
    start(argv: string[], label: string): string {
        const proc = Bun.spawn(["kubectl", ...argv], { stdout: "pipe", stderr: "pipe" });
        const forward: Forward = { proc, label };
        this.forwards.push(forward);
        // Drop the forward from the active list if the process dies.
        void proc.exited.then(() => {
            this.forwards = this.forwards.filter((f) => f !== forward);
        });
        return `forwarding ${label}`;
    }

    get count(): number {
        return this.forwards.length;
    }

    /** One-line summary for the footer/status, or "" when nothing is forwarding. */
    status(): string {
        if (this.forwards.length === 0) {
            return "";
        }
        return `⇄ ${this.forwards.map((f) => f.label).join(", ")}`;
    }

    stopAll(): void {
        for (const f of this.forwards) {
            try {
                f.proc.kill();
            } catch {
                // already exited
            }
        }
        this.forwards = [];
    }
}

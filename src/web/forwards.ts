/**
 * Port-forward manager.
 *
 * State lives in the server process, not the page: a forward you started should
 * survive a browser reload, exactly like `kubectl port-forward` in a spare
 * terminal survives closing the tab you launched it from. Every forward is a
 * child process whose stdout we parse for the port kubectl actually bound
 * (asking for local port 0 lets the kernel choose, which is the only way to
 * never collide with something already listening).
 */

const forwards = new Map<string, Forward>();
let seq = 0;

export interface ForwardSpec {
    context: string;
    kind: string; // pods | services | deployments …
    name: string;
    namespace?: string;
    remotePort: number;
    /** 0 or undefined → let the kernel pick and report back. */
    localPort?: number;
    address?: string;
}

interface Forward {
    id: string;
    spec: ForwardSpec;
    proc: ReturnType<typeof Bun.spawn>;
    localPort: number | null;
    status: "starting" | "active" | "failed" | "stopped";
    error: string;
    startedAt: number;
}

export interface ForwardView {
    id: string;
    context: string;
    kind: string;
    name: string;
    namespace: string;
    remotePort: number;
    localPort: number | null;
    status: Forward["status"];
    error: string;
    url: string | null;
    startedAt: number;
}

function view(f: Forward): ForwardView {
    return {
        id: f.id,
        context: f.spec.context,
        kind: f.spec.kind,
        name: f.spec.name,
        namespace: f.spec.namespace ?? "",
        remotePort: f.spec.remotePort,
        localPort: f.localPort,
        status: f.status,
        error: f.error,
        url: f.localPort ? `http://127.0.0.1:${f.localPort}` : null,
        startedAt: f.startedAt,
    };
}

/** `kubectl port-forward` singularises the resource type; svc/foo, pod/foo. */
function targetRef(spec: ForwardSpec): string {
    const singular: Record<string, string> = {
        pods: "pod",
        services: "svc",
        deployments: "deployment",
        statefulsets: "statefulset",
        replicasets: "replicaset",
        daemonsets: "daemonset",
    };
    const kind = singular[spec.kind] ?? spec.kind.replace(/s$/, "");
    return `${kind}/${spec.name}`;
}

export function startForward(spec: ForwardSpec): ForwardView {
    const id = `pf${++seq}`;
    const args = ["--context", spec.context];
    if (spec.namespace) args.push("-n", spec.namespace);
    args.push("port-forward", targetRef(spec), `${spec.localPort ?? 0}:${spec.remotePort}`);
    if (spec.address) args.push(`--address=${spec.address}`);

    const proc = Bun.spawn(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" });
    const f: Forward = {
        id,
        spec,
        proc,
        localPort: spec.localPort && spec.localPort > 0 ? spec.localPort : null,
        status: "starting",
        error: "",
        startedAt: Date.now(),
    };
    forwards.set(id, f);

    void pump(proc.stdout, (line) => {
        // "Forwarding from 127.0.0.1:54321 -> 80"
        const m = /Forwarding from [\d.:[\]]*?:(\d+)\s*->/.exec(line);
        if (m) {
            f.localPort = Number(m[1]);
            f.status = "active";
        }
    });
    void pump(proc.stderr, (line) => {
        if (!line.trim()) return;
        f.error = line.trim();
        // kubectl reports transient "lost connection to pod" on stderr while
        // staying alive; only a dead process is a failed forward.
        if (/unable to|error:|failed/i.test(line)) f.status = f.localPort ? "active" : "failed";
    });

    void proc.exited.then((code) => {
        f.status = code === 0 ? "stopped" : "failed";
        if (code !== 0 && !f.error) f.error = `kubectl port-forward exited with ${code}`;
    });

    return view(f);
}

async function pump(stream: ReadableStream<Uint8Array> | undefined, onLine: (line: string) => void): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n");
            buf = parts.pop() ?? "";
            for (const line of parts) onLine(line);
        }
        if (buf) onLine(buf);
    } catch {
        /* stream closed with the process */
    }
}

export function listForwards(context?: string): ForwardView[] {
    const all = [...forwards.values()]
        .filter((f) => !context || f.spec.context === context)
        .map(view)
        .sort((a, b) => a.startedAt - b.startedAt);
    return all;
}

export function stopForward(id: string): boolean {
    const f = forwards.get(id);
    if (!f) return false;
    try {
        f.proc.kill();
    } catch {
        /* already gone */
    }
    forwards.delete(id);
    return true;
}

export function stopAllForwards(): void {
    for (const id of [...forwards.keys()]) stopForward(id);
}

/** Drop finished rows so the panel does not accumulate dead entries forever. */
export function pruneForwards(): void {
    for (const [id, f] of forwards) {
        if (f.status === "stopped") forwards.delete(id);
    }
}

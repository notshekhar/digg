/**
 * A pseudo-terminal for `kubectl exec -it`, built on bun:ffi.
 *
 * The browser shell needs a real TTY: without one kubectl refuses `-t` ("Unable
 * to use a TTY - input is not a terminal") and a shell run with plain pipes has
 * no prompt, no echo and no job control. node-pty does not work under Bun (its
 * libuv socket pump never fires), so digg talks to the OS the way drover does:
 *
 *   openpty()   allocate the master/slave pair, sized up front
 *   Bun.spawn   fork+exec the child onto the slave fd (Bun's fork is fork-safe;
 *               forking from JS is not)
 *   ioctl shim  resize, because ioctl(2) is variadic and bun:ffi only knows
 *               fixed signatures — on arm64 a direct call gets a garbage pointer
 *
 * Byte I/O uses node:fs (libuv threadpool), never synchronous FFI reads: a tight
 * FFI read loop starves Bun's own event loop and the server stops answering.
 *
 * Everything here is optional. `ptyAvailable()` is false on Windows and on any
 * box where the dlopen fails, and callers fall back to a pipe-based exec. A
 * missing C compiler costs only the resize shim, which degrades to a no-op —
 * the shell still runs at the size it opened with.
 */

import { ptr } from "bun:ffi";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const SHIM_C = `#include <sys/ioctl.h>
#include <termios.h>
int digg_set_winsize(int fd, unsigned short rows, unsigned short cols) {
    struct winsize ws;
    ws.ws_row = rows;
    ws.ws_col = cols;
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;
    return ioctl(fd, TIOCSWINSZ, &ws);
}
`;

interface Sys {
    openpty: (a: number, b: number, c: null, d: null, e: number) => number;
    close: (fd: number) => number;
    setWinsize: ((fd: number, rows: number, cols: number) => number) | null;
}

let sysCache: Sys | null = null;
let sysTried = false;

function loadSys(): Sys | null {
    if (sysTried) return sysCache;
    sysTried = true;
    if (process.platform !== "darwin" && process.platform !== "linux") return null;
    try {
        // Imported lazily: `bun:ffi` on an unsupported platform, or a hardened
        // environment that blocks dlopen, must not take the whole server down.
        const { cc, dlopen, FFIType, suffix } = require("bun:ffi") as typeof import("bun:ffi");
        const isMac = process.platform === "darwin";
        const libc = isMac ? "libSystem.dylib" : `libc.${suffix}.6`;
        const libutil = isMac ? "libSystem.dylib" : `libutil.${suffix}.1`;

        const util = dlopen(libutil, {
            // int openpty(int *amaster, int *aslave, char *name, termios *t, winsize *w)
            openpty: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
        });
        const c = dlopen(libc, { close: { args: [FFIType.int], returns: FFIType.int } });

        let setWinsize: Sys["setWinsize"] = null;
        try {
            // The shim is written out rather than shipped as a file: inside a
            // `bun build --compile` binary there is no repo to read it from.
            const path = join(tmpdir(), "digg-pty-shim.c");
            writeFileSync(path, SHIM_C);
            const shim = cc({
                source: path,
                symbols: { digg_set_winsize: { args: ["int", "u16", "u16"], returns: "int" } },
            });
            setWinsize = shim.symbols.digg_set_winsize as unknown as Sys["setWinsize"];
        } catch {
            // No compiler: keep the pty, lose live resize.
            setWinsize = null;
        }

        sysCache = {
            openpty: util.symbols.openpty as unknown as Sys["openpty"],
            close: c.symbols.close as unknown as Sys["close"],
            setWinsize,
        };
    } catch {
        sysCache = null;
    }
    return sysCache;
}

export function ptyAvailable(): boolean {
    return loadSys() !== null;
}

/** struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; } */
function winsize(rows: number, cols: number): Uint8Array {
    const buf = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    view.setUint16(0, rows, true);
    view.setUint16(2, cols, true);
    return buf;
}

export interface PtyOptions {
    command: string;
    args?: string[];
    env?: Record<string, string | undefined>;
    cols: number;
    rows: number;
}

const READ_CHUNK = 65536;

export class Pty {
    cols: number;
    rows: number;
    private master: number;
    private child: Bun.Subprocess;
    private readBuf = Buffer.allocUnsafe(READ_CHUNK);
    private dataListeners = new Set<(chunk: Uint8Array) => void>();
    private exitListeners = new Set<(code: number) => void>();
    private alive = true;
    private reading = false;
    private writeQueue: Buffer[] = [];
    private writing = false;
    private sys: Sys;

    constructor(opts: PtyOptions) {
        const sys = loadSys();
        if (!sys) throw new Error("digg: no pty support on this platform");
        this.sys = sys;
        this.cols = opts.cols;
        this.rows = opts.rows;

        const am = new Int32Array(1);
        const as = new Int32Array(1);
        const ws = winsize(opts.rows, opts.cols);
        if (sys.openpty(ptr(am), ptr(as), null, null, ptr(ws)) !== 0) {
            throw new Error("digg: openpty() failed");
        }
        this.master = am[0]!;
        const slave = as[0]!;

        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(opts.env ?? process.env)) {
            if (v !== undefined) env[k] = v;
        }
        env.TERM = env.TERM ?? "xterm-256color";

        this.child = Bun.spawn([opts.command, ...(opts.args ?? [])], {
            env,
            stdio: [slave, slave, slave] as never,
            onExit: (_p, code) => this.handleExit(code ?? 0),
        });

        this.sys.close(slave); // the child holds its own copy
        this.readLoop();
    }

    onData(fn: (chunk: Uint8Array) => void): () => void {
        this.dataListeners.add(fn);
        return () => this.dataListeners.delete(fn);
    }

    onExit(fn: (code: number) => void): () => void {
        this.exitListeners.add(fn);
        return () => this.exitListeners.delete(fn);
    }

    /**
     * Queue-drained writes: concurrent async fs.write calls can complete out of
     * order and scramble multi-chunk input ("echo" arriving as "ech" + "o").
     */
    write(data: string | Uint8Array): void {
        if (!this.alive) return;
        this.writeQueue.push(typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data));
        this.drainWrites();
    }

    private drainWrites(): void {
        if (this.writing || this.writeQueue.length === 0 || !this.alive) return;
        this.writing = true;
        const buf = this.writeQueue.shift()!;
        fs.write(this.master, buf, 0, buf.length, null, () => {
            this.writing = false;
            this.drainWrites();
        });
    }

    resize(cols: number, rows: number): void {
        if (!this.alive) return;
        this.cols = cols;
        this.rows = rows;
        this.sys.setWinsize?.(this.master, rows, cols);
    }

    kill(signal: number | NodeJS.Signals = "SIGHUP"): void {
        if (!this.alive) return;
        try {
            this.child.kill(signal as number);
        } catch {
            /* already gone */
        }
    }

    get pid(): number {
        return this.child.pid;
    }

    private readLoop(): void {
        if (!this.alive || this.reading) return;
        this.reading = true;
        fs.read(this.master, this.readBuf, 0, READ_CHUNK, null, (err, bytes) => {
            this.reading = false;
            if (!this.alive || err) return; // EIO/EBADF: child gone, onExit handles it
            if (bytes > 0) {
                const chunk = Uint8Array.prototype.slice.call(this.readBuf, 0, bytes);
                for (const fn of this.dataListeners) fn(chunk);
            }
            if (bytes === 0) return; // EOF
            this.readLoop();
        });
    }

    private handleExit(code: number): void {
        if (!this.alive) return;
        this.alive = false;
        try {
            this.sys.close(this.master);
        } catch {
            /* ignore */
        }
        for (const fn of this.exitListeners) fn(code);
    }
}

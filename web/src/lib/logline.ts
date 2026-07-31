/**
 * Log line parsing: level, timestamp, and the tokens worth colouring.
 *
 * Pure and separate from the pane because getting a level *wrong* is worse than
 * having none. The old rule was a keyword scan — any line containing the word
 * "failed" was an error — so `INFO  reconcile complete: 0 failed` painted the
 * whole pane red and a real error stopped standing out. Levels are therefore
 * read from where a logger actually writes them, in order of how much the
 * format commits: klog's letter prefix, a JSON `level` field, a logfmt
 * `level=`, a bracketed or shouted token near the head of the line. Only when
 * all of those miss does a keyword fallback run, and it is restricted to
 * markers that are never prose ("panic:", "Traceback", "connection refused").
 *
 * Parsing happens once per line as it arrives, not per render: a pod pushing
 * 2k lines/second re-renders the whole buffer every frame, and a regex pass
 * inside the row component would be paid thousands of times for every line.
 *
 * Continuation lines (an indented stack frame, `Caused by:`, `... 12 more`)
 * carry no level of their own and inherit the line above, so a Java trace stays
 * with the error that threw it instead of dropping to unclassified in the
 * middle — including when the level filter is on.
 */

export type Level = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "none";

/** Ordered for "warn and above" style filtering. `none` sorts below trace. */
export const LEVEL_RANK: Record<Level, number> = {
    none: 0,
    trace: 1,
    debug: 2,
    info: 3,
    warn: 4,
    error: 5,
    fatal: 6,
};

export const LEVEL_LABEL: Record<Level, string> = {
    fatal: "FATAL",
    error: "ERROR",
    warn: "WARN",
    info: "INFO",
    debug: "DEBUG",
    trace: "TRACE",
    none: "",
};

/** What a span of the line is, which is what decides its colour. */
export type SegKind = "ts" | "lvl" | "key" | "str" | "num" | "url";

export interface Seg {
    t: SegKind;
    s: number;
    e: number;
}

export interface LogLine {
    /** Stable identity, so React keeps rows put when the head is trimmed. */
    id: number;
    raw: string;
    level: Level;
    /** Level came from a continuation rule, not from this line's own text. */
    inherited: boolean;
    /** Sorted, non-overlapping. Gaps are plain text. */
    segs: Seg[];
}

/* -- level vocabularies ---------------------------------------------------- */

const NAMED: Record<string, Level> = {
    fatal: "fatal",
    ftl: "fatal",
    crit: "fatal",
    critical: "fatal",
    emerg: "fatal",
    emergency: "fatal",
    alert: "fatal",
    panic: "fatal",
    error: "error",
    err: "error",
    eror: "error",
    erro: "error",
    severe: "error",
    warn: "warn",
    warning: "warn",
    wrn: "warn",
    info: "info",
    inf: "info",
    information: "info",
    notice: "info",
    debug: "debug",
    dbg: "debug",
    dbug: "debug",
    fine: "debug",
    trace: "trace",
    trce: "trace",
    verbose: "trace",
};

/** klog/glog: the first character of `E0725 10:22:31.123456  1 file.go:42]`. */
const KLOG_LETTER: Record<string, Level> = { F: "fatal", E: "error", W: "warn", I: "info", D: "debug", V: "trace" };

/** pino and friends log a number: 10 trace, 20 debug, 30 info, 40 warn, … */
function numericLevel(n: number): Level {
    if (n >= 60) return "fatal";
    if (n >= 50) return "error";
    if (n >= 40) return "warn";
    if (n >= 30) return "info";
    if (n >= 20) return "debug";
    return "trace";
}

/* -- head: timestamps and the klog letter ---------------------------------- */

const KLOG = /^([FEWIDV])(\d{4}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;

const STAMPS: RegExp[] = [
    // RFC3339 / ISO 8601, which is what `kubectl logs --timestamps` prepends.
    /^\[?(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\]?/,
    // Syslog and friends: `Jul 25 10:22:31`.
    /^\[?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\]?/,
    // Bare clock, with or without a date-less bracket.
    /^\[?(\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?)\]?/,
];

/* -- level, from most committed format to least ---------------------------- */

const JSON_LVL = /"(?:level|severity|levelname|lvl|loglevel|log\.level)"\s*:\s*(?:"([A-Za-z]+)"|(\d{1,3}))/;
const LOGFMT_LVL = /(?:^|[\s,{])(?:level|lvl|severity|loglevel)=["']?([A-Za-z]+)["']?/i;
/** `[error]`, `(WARN)`, `|debug|` — a delimiter is enough to trust lower case. */
const BRACKET_LVL = /[[(<|]\s*(fatal|critical|crit|error|err|warning|warn|notice|info|debug|trace|verbose)\s*[\])>|]/i;
/** Bare and shouted. Case-sensitive on purpose: prose says "error", loggers say "ERROR". */
const SHOUT_LVL = /(?:^|\s)(FATAL|CRITICAL|CRIT|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|TRACE|VERBOSE)(?=[\s:.\-|]|$)/;

/** How far into a line a bare level token is still a level and not a word. */
const HEAD = 80;

/** Never prose. Safe to read as a level when the line declared none. */
const FALLBACK: [RegExp, Level][] = [
    [/\bpanic:|^fatal error:|\bsegmentation fault\b|\bOOMKilled\b|\bsignal SIGSEGV\b/i, "fatal"],
    [
        /Traceback \(most recent call last\)|\bunhandled exception\b|\bconnection refused\b|\bfailed to\b|\bpermission denied\b|\bno such host\b|\bcontext deadline exceeded\b|\berr(?:or)?=/i,
        "error",
    ],
    [/\bdeprecat(?:ed|ion)\b|\bretrying\b|\bwill retry\b|\bthrottl(?:ed|ing)\b/i, "warn"],
];

/** Indented frames, `at com.foo(Bar.java:1)`, `Caused by:`, `... 12 more`. */
const CONTINUATION = /^\s+\S|^(?:at\s+\S|Caused by:|\.{3}\s+\d+\s+more\b|\s*File ")/;

/* -- tokens ---------------------------------------------------------------- */

/**
 * One pass, ordered by specificity. Quoted runs first so a URL or number inside
 * a string is not split back out of it.
 *
 * The lookbehind on the numeric branches is what keeps `worker-0`, `v2` and
 * `kubelet.go:42` whole: without it the tokenizer reaches into the middle of
 * every identifier in the stream and paints one digit of it a different colour,
 * which is worse than not colouring numbers at all. A number is only a number
 * when something that is not part of a name comes before it — and the second
 * lookbehind is narrower than it looks: it rejects `go:42` and `:9090` while
 * still allowing `"count":3`, because there the colon follows a quote, not a
 * name.
 */
const TOKEN =
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\bhttps?:\/\/[^\s"'<>)\]]+|(?<![\w.\-])(?<!\w:)\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|[A-Za-z_][\w.\-]*(?==)|(?<![\w.\-])(?<!\w:)\d+(?:\.\d+)?(?:ns|µs|us|ms|s|m|h|d|%|B|[KMGT]i?B?)?\b/g;

/** A line longer than this is a blob (a dumped body, a 50KB trace frame). */
const TOKEN_LIMIT = 4000;
/** Enough to colour a structured line; past this the line is noise anyway. */
const MAX_TOKENS = 48;

function level(name: string): Level {
    return NAMED[name.toLowerCase()] ?? "none";
}

/**
 * Parse one line. `prev` is the level of the line above, used only to continue
 * a stack trace; pass "none" for the first line of a stream.
 */
export function parseLine(raw: string, id: number, prev: Level = "none"): LogLine {
    const segs: Seg[] = [];
    let at = 0;
    let lvl: Level = "none";

    // Head: up to three leading stamps, because --timestamps prepends one in
    // front of whatever the container already printed.
    for (let pass = 0; pass < 3; pass++) {
        while (raw[at] === " " || raw[at] === "\t") at++;
        const rest = raw.slice(at);
        const k = KLOG.exec(rest);
        if (k) {
            if (lvl === "none") lvl = KLOG_LETTER[k[1]!]!;
            segs.push({ t: "lvl", s: at, e: at + 1 });
            segs.push({ t: "ts", s: at + 1, e: at + k[0].length });
            at += k[0].length;
            continue;
        }
        let m: RegExpExecArray | null = null;
        for (const p of STAMPS) if ((m = p.exec(rest))) break;
        if (!m) break;
        segs.push({ t: "ts", s: at, e: at + m[0].length });
        at += m[0].length;
    }

    const tail = raw.slice(at);
    if (lvl === "none") {
        const found = findLevel(tail);
        if (found) {
            lvl = found.level;
            segs.push({ t: "lvl", s: at + found.s, e: at + found.e });
        }
    }

    let inherited = false;
    if (lvl === "none" && prev !== "none" && CONTINUATION.test(raw)) {
        lvl = prev;
        inherited = true;
    }

    if (raw.length <= TOKEN_LIMIT) tokenize(raw, at, segs);

    return { id, raw, level: lvl, inherited, segs: normalize(segs) };
}

function findLevel(tail: string): { level: Level; s: number; e: number } | null {
    const j = JSON_LVL.exec(tail);
    if (j) {
        const lvl = j[1] ? level(j[1]) : numericLevel(Number(j[2]));
        if (lvl !== "none") {
            const inner = j[0].lastIndexOf(j[1] ?? j[2]!);
            return { level: lvl, s: j.index + inner, e: j.index + inner + (j[1] ?? j[2]!).length };
        }
    }
    const f = LOGFMT_LVL.exec(tail);
    if (f) {
        const lvl = level(f[1]!);
        if (lvl !== "none") {
            const inner = f[0].lastIndexOf(f[1]!);
            return { level: lvl, s: f.index + inner, e: f.index + inner + f[1]!.length };
        }
    }
    const head = tail.slice(0, HEAD);
    for (const re of [BRACKET_LVL, SHOUT_LVL]) {
        const m = re.exec(head);
        if (!m) continue;
        const lvl = level(m[1]!);
        if (lvl === "none") continue;
        const inner = m[0].lastIndexOf(m[1]!);
        return { level: lvl, s: m.index + inner, e: m.index + inner + m[1]!.length };
    }
    for (const [re, lvl] of FALLBACK) if (re.test(tail)) return { level: lvl, s: 0, e: 0 };
    return null;
}

function tokenize(raw: string, from: number, out: Seg[]) {
    TOKEN.lastIndex = from;
    let n = 0;
    for (let m = TOKEN.exec(raw); m && n < MAX_TOKENS; m = TOKEN.exec(raw)) {
        const text = m[0];
        const s = m.index;
        const e = s + text.length;
        const c = text[0]!;
        let t: SegKind;
        if (c === '"' || c === "'") {
            // A quoted run followed by a colon is a JSON key, not a value.
            t = raw[e] === ":" || raw.slice(e, e + 2) === " :" ? "key" : "str";
        } else if (c === "h") t = "url";
        else if (raw[e] === "=") t = "key";
        else t = "num";
        out.push({ t, s, e });
        n++;
    }
    TOKEN.lastIndex = 0;
}

/**
 * Sort and drop overlaps, with the level and timestamp winning every collision.
 * They have to: in `{"level":"error"}` the tokenizer sees `"error"` as a quoted
 * string starting one character earlier, and first-past-the-post would let a
 * string colour swallow the one span the reader is scanning for.
 */
function normalize(segs: Seg[]): Seg[] {
    const strong = segs.filter((s) => s.t === "lvl" || s.t === "ts").sort((a, b) => a.s - b.s);
    const weak = segs.filter((s) => s.t !== "lvl" && s.t !== "ts").sort((a, b) => a.s - b.s || b.e - a.e);
    const out: Seg[] = [];
    let end = -1;
    for (const seg of strong) {
        if (seg.s < end || seg.e <= seg.s) continue;
        out.push(seg);
        end = seg.e;
    }
    for (const seg of weak) {
        if (seg.e <= seg.s) continue;
        if (out.some((k) => seg.s < k.e && k.s < seg.e)) continue;
        out.push(seg);
    }
    return out.sort((a, b) => a.s - b.s);
}

/* -- render pieces --------------------------------------------------------- */

export interface Piece {
    text: string;
    /** "" for plain text; otherwise a seg kind, a "hit", or both. */
    cls: string;
}

export interface Range {
    s: number;
    e: number;
}

/** Case-insensitive search ranges, non-overlapping, left to right. */
export function findHits(raw: string, needle: string): Range[] {
    if (!needle) return [];
    const hay = raw.toLowerCase();
    const n = needle.toLowerCase();
    const out: Range[] = [];
    for (let at = hay.indexOf(n); at !== -1; at = hay.indexOf(n, at + n.length)) out.push({ s: at, e: at + n.length });
    return out;
}

/**
 * Cut the line at every seg and hit boundary, so a search match that straddles
 * a token still highlights whole — the two colourings compose instead of one
 * winning. Adjacent pieces of the same class are merged back so a plain line
 * stays a single text node.
 */
export function pieces(raw: string, segs: Seg[], hits: Range[] = []): Piece[] {
    if (!segs.length && !hits.length) return raw ? [{ text: raw, cls: "" }] : [];

    const cuts = new Set<number>([0, raw.length]);
    for (const s of segs) {
        cuts.add(s.s);
        cuts.add(s.e);
    }
    for (const h of hits) {
        cuts.add(h.s);
        cuts.add(h.e);
    }
    const bounds = [...cuts].filter((c) => c >= 0 && c <= raw.length).sort((a, b) => a - b);

    const out: Piece[] = [];
    let si = 0;
    let hi = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
        const s = bounds[i]!;
        const e = bounds[i + 1]!;
        if (s === e) continue;
        while (si < segs.length && segs[si]!.e <= s) si++;
        while (hi < hits.length && hits[hi]!.e <= s) hi++;
        const seg = segs[si];
        const hit = hits[hi];
        let cls = seg && seg.s <= s && seg.e >= e ? seg.t : "";
        if (hit && hit.s <= s && hit.e >= e) cls = cls ? `${cls} hit` : "hit";
        const last = out[out.length - 1];
        if (last && last.cls === cls) last.text += raw.slice(s, e);
        else out.push({ text: raw.slice(s, e), cls });
    }
    return out;
}

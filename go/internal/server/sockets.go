package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/coder/websocket"

	"github.com/notshekhar/digg/internal/kube"
)

// The two WebSocket endpoints. Port of the websocket half of src/serve.ts.
//
// Both socket flavours are separate paths here rather than one handler with a
// `kind` discriminator: Bun.serve has a single websocket callback, Go does not,
// so the discriminator the Bun build needed has no purpose.
//
// SECURITY: any website can open a WebSocket to 127.0.0.1 — the same-origin
// policy does not apply to WS handshakes. A shell endpoint with no auth is
// therefore remote code execution from a random browser tab. Both sockets are
// gated on the per-run token, which only a page served by this process can read.

// acceptOptions disables the library's own origin check because Authorized()
// already does it — and does it against the port we actually bound.
var acceptOptions = &websocket.AcceptOptions{InsecureSkipVerify: true}

// ── exec ────────────────────────────────────────────────────────────────────

func parseExecTarget(r *http.Request) (kube.ExecTarget, bool) {
	q := r.URL.Query()
	kind := q.Get("kind")
	context := strings.TrimSpace(q.Get("context"))
	if context == "" {
		return kube.ExecTarget{}, false
	}
	switch kind {
	case "container", "node", "local", "debug":
	default:
		return kube.ExecTarget{}, false
	}
	if (kind == "container" || kind == "debug") && q.Get("pod") == "" {
		return kube.ExecTarget{}, false
	}
	if kind == "node" && q.Get("node") == "" {
		return kube.ExecTarget{}, false
	}
	size := func(s string, def uint16) uint16 {
		n, err := strconv.Atoi(s)
		if err != nil || n <= 0 {
			return def
		}
		return uint16(n)
	}
	return kube.ExecTarget{
		Kind: kind, Context: context,
		Namespace: q.Get("ns"), Pod: q.Get("pod"),
		Container: q.Get("container"), Node: q.Get("node"),
		Shell: q.Get("shell"),
		Cols:  size(q.Get("cols"), 80), Rows: size(q.Get("rows"), 24),
	}, true
}

func (s *Server) handleExec(w http.ResponseWriter, r *http.Request) {
	if !s.Authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	target, ok := parseExecTarget(r)
	if !ok {
		http.Error(w, "bad exec target", http.StatusBadRequest)
		return
	}
	conn, err := websocket.Accept(w, r, acceptOptions)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	// A shell can produce a lot at once; the default read limit would kill the
	// socket on a `cat` of anything large.
	conn.SetReadLimit(4 << 20)

	ctx := r.Context()
	var writeMu sync.Mutex
	sendBytes := func(b []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		// Output is binary because terminal streams are bytes, and a UTF-8
		// multi-byte sequence split across two reads must reach xterm.js
		// unmangled — decoding it here would corrupt the split rune.
		conn.Write(ctx, websocket.MessageBinary, b)
	}
	sendJSON := func(v any) {
		raw, err := json.Marshal(v)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		conn.Write(ctx, websocket.MessageText, raw)
	}

	cl, err := kube.For(target.Context)
	if err != nil {
		sendJSON(map[string]any{"t": "error", "message": err.Error()})
		return
	}

	closed := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(closed) }) }

	sess, err := cl.StartExec(target, sendBytes, sendJSON, func(int) { finish() })
	if err != nil {
		return
	}
	defer sess.Close()

	go func() {
		defer finish()
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageBinary {
				sess.Write(data)
				continue
			}
			var msg struct {
				T    string `json:"t"`
				D    string `json:"d"`
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if err := json.Unmarshal(data, &msg); err != nil {
				// not our protocol; ignore rather than kill the shell
				continue
			}
			switch msg.T {
			case "in":
				sess.Write([]byte(msg.D))
			case "resize":
				cols, rows := msg.Cols, msg.Rows
				if cols == 0 {
					cols = 80
				}
				if rows == 0 {
					rows = 24
				}
				sess.Resize(cols, rows)
			}
		}
	}()

	select {
	case <-closed:
	case <-ctx.Done():
	}
}

// ── live watches ────────────────────────────────────────────────────────────

func (s *Server) handleWatch(w http.ResponseWriter, r *http.Request) {
	if !s.Authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, acceptOptions)
	if err != nil {
		return
	}
	defer conn.CloseNow()

	ctx := r.Context()
	var writeMu sync.Mutex
	push := func(v any) {
		raw, err := json.Marshal(v)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		// The socket went away mid-write; the read loop below will notice and
		// close() will clean up.
		conn.Write(ctx, websocket.MessageText, raw)
	}

	live := newLiveSession(push)
	// The socket is the lifetime of its subscriptions: a closed tab must not
	// leave a watch running.
	defer live.close()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		live.handle(data)
	}
}

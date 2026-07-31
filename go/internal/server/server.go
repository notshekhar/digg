// Package server is `digg serve` — the cluster browser in a browser.
//
// One process: the embedded React app on GET /, a JSON+SSE API under /api, and
// WebSockets for terminals and live watches. Port of src/serve.ts.
//
// ## Why there is a token
//
// Binding to 127.0.0.1 is not access control. Any web page you visit can issue
// requests to localhost, and for WebSockets the same-origin policy does not
// even apply to the handshake — so an unauthenticated /api/exec on a loopback
// port is remote code execution from a random tab. digg mints a token per run,
// embeds it in the page it serves, and requires it on every /api call. A
// cross-origin page can trigger requests but can never read our HTML, so it can
// never learn the token.
//
// The page itself is unauthenticated on purpose: it is a static document, and
// gating it would only mean pasting a URL with a secret in it.
package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/notshekhar/digg/internal/kube"
	"github.com/notshekhar/digg/internal/settings"
)

// DefaultPort is where digg serves unless told otherwise.
const DefaultPort = 9787

// Options configures one run.
type Options struct {
	Port    int
	Host    string
	Open    bool
	Version string
}

// Server holds one run's state.
type Server struct {
	token   string
	port    int
	host    string
	version string
	page    []byte

	mu sync.Mutex
}

// favicon is the rail mark: one cyan square on transparent.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
	`<rect x="2" y="2" width="12" height="12" fill="#3fbcd8"/></svg>`

func mintToken() string {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		panic("digg: no entropy for a session token: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

// Authorized is the guard every /api request passes through. Exported for
// tests, as isAuthorized() was.
func (s *Server) Authorized(r *http.Request) bool {
	header := r.Header.Get("x-digg-token")
	// EventSource and WebSocket cannot set headers.
	param := r.URL.Query().Get("token")
	if subtle.ConstantTimeCompare([]byte(header), []byte(s.token)) != 1 &&
		subtle.ConstantTimeCompare([]byte(param), []byte(s.token)) != 1 {
		return false
	}

	// Belt and braces: a token leak via a copied URL should still not let a
	// hostile page drive the API from its own origin.
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return false
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || (n != s.port && n != 9788) {
			return false
		}
	}
	return true
}

// Run starts the server and blocks.
func Run(opts Options) error {
	if !kube.Available() {
		return fmt.Errorf("no kubeconfig contexts found. Configure kubectl and try again")
	}

	host := opts.Host
	if host == "" {
		host = "127.0.0.1"
	}
	preferred := opts.Port
	if preferred == 0 {
		preferred = DefaultPort
	}

	s := &Server{token: mintToken(), host: host, version: opts.Version}

	ln, err := listenNear(host, preferred)
	if err != nil {
		return err
	}
	s.port = ln.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	s.routes(mux)

	addr := fmt.Sprintf("http://%s:%d/", host, s.port)
	fmt.Printf("digg serve v%s → %s\n", opts.Version, addr)
	fmt.Printf("  host: %s\n", host)
	fmt.Printf("  ctrl+c to stop\n")

	if opts.Open {
		openBrowser(addr)
	}

	// Forwards are children of this process; leaving them running after ctrl+c
	// would strand listening ports with no way to find them from the UI again.
	// Watches are informers holding streams; they must not outlive the process
	// either.
	defer func() {
		kube.StopAllForwards()
		kube.StopAllWatches()
	}()

	srv := &http.Server{Handler: mux}
	return srv.Serve(ln)
}

// listenNear walks up from the preferred port, as the Bun build did, so a
// second digg does not simply fail to start.
func listenNear(host string, preferred int) (net.Listener, error) {
	const maxTries = 20
	var lastErr error
	for i := 0; i < maxTries; i++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, preferred+i))
		if err == nil {
			return ln, nil
		}
		lastErr = err
		if !strings.Contains(err.Error(), "address already in use") {
			return nil, err
		}
	}
	return nil, fmt.Errorf("could not bind a port near %d: %w", preferred, lastErr)
}

func (s *Server) routes(mux *http.ServeMux) {
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "max-age=86400")
		w.Write([]byte(favicon))
	})

	mux.HandleFunc("/api/exec", s.handleExec)
	mux.HandleFunc("/api/watch", s.handleWatch)
	mux.HandleFunc("/api/logs", s.guard(s.handleLogs))

	mux.HandleFunc("/api/boot", s.guard(s.handleBoot))
	mux.HandleFunc("/api/prefs", s.guard(s.handlePrefs))
	mux.HandleFunc("/api/ui", s.guard(s.handleUI))
	mux.HandleFunc("/api/namespaces", s.guard(s.handleNamespaces))
	mux.HandleFunc("/api/kinds", s.guard(s.handleKinds))
	mux.HandleFunc("/api/list", s.guard(s.handleList))
	mux.HandleFunc("/api/detail", s.guard(s.handleDetail))
	mux.HandleFunc("/api/yaml", s.guard(s.handleYAML))
	mux.HandleFunc("/api/describe", s.guard(s.handleDescribe))
	mux.HandleFunc("/api/data", s.guard(s.handleData))
	mux.HandleFunc("/api/data-key", s.guard(s.handleDataKey))
	mux.HandleFunc("/api/catalog", s.guard(s.handleCatalog))
	mux.HandleFunc("/api/overview", s.guard(s.handleOverview))
	mux.HandleFunc("/api/events", s.guard(s.handleEvents))
	mux.HandleFunc("/api/metrics", s.guard(s.handleMetrics))
	mux.HandleFunc("/api/history", s.guard(s.handleHistory))
	mux.HandleFunc("/api/revisions", s.guard(s.handleRevisions))
	mux.HandleFunc("/api/action", s.guard(s.handleAction))
	mux.HandleFunc("/api/forwards", s.guard(s.handleForwards))

	mux.HandleFunc("/", s.handlePage)
}

// guard wraps a handler in the token check and the JSON 401.
func (s *Server) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.Authorized(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		h(w, r)
	}
}

func (s *Server) handlePage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Any unknown /api path that reached here is a 404 in JSON, as it was.
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	s.mu.Lock()
	page := s.page
	s.mu.Unlock()
	if page == nil {
		prefs := settings.GetWebPrefs()
		page = renderPage(pageData{
			Theme:   prefs.Theme,
			Version: s.version,
			Token:   s.token,
			Context: settings.LastContext(),
			UI:      settings.UIState(),
		})
		s.mu.Lock()
		s.page = page
		s.mu.Unlock()
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// The page has no third-party anything except the Google Fonts stylesheet
	// it asks for by name.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Write(page)
}

// invalidatePage drops the cached HTML after a preference changes, so the next
// load is stamped with the new theme/ui rather than the old one.
func (s *Server) invalidatePage() {
	s.mu.Lock()
	s.page = nil
	s.mu.Unlock()
}

func openBrowser(addr string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", addr)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", addr)
	default:
		cmd = exec.Command("xdg-open", addr)
	}
	if err := cmd.Start(); err != nil {
		fmt.Printf("digg: could not open browser; visit %s\n", addr)
		return
	}
	go cmd.Wait()
}

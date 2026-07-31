// Package settings persists preferences under ~/.digg/settings.json.
//
// Per-context we remember the last namespace and kind so reopening a cluster
// lands where you left off; the theme is global. Anything the URL can carry
// (filters, tabs) lives there instead — see web/src/lib/query.ts.
//
// Port of src/settings.ts. The file format is unchanged, so a settings.json
// written by the Bun build is read by this one and vice versa.
package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// ContextPrefs is what we remember per cluster.
type ContextPrefs struct {
	// Namespace is the legacy single selection, still read so an old
	// settings.json still works. A null means all namespaces, which is why it
	// is a pointer: absent and "all" are different states.
	Namespace *string `json:"namespace,omitempty"`
	// Namespaces is every selected namespace. Empty means all of them, as
	// `kubectl -A` does.
	Namespaces []string `json:"namespaces,omitempty"`
	Kind       string   `json:"kind,omitempty"`
}

type webPrefs struct {
	Theme string `json:"theme,omitempty"`
}

type data struct {
	LastContext string                   `json:"lastContext,omitempty"`
	Contexts    map[string]*ContextPrefs `json:"contexts"`
	Web         *webPrefs                `json:"web,omitempty"`
	UI          map[string]any           `json:"ui,omitempty"`
}

// uiMaxBytes caps the free-form UI bag. The client is trusted, but a runaway
// writer must not turn settings.json into something the next boot has to parse
// megabytes of.
const uiMaxBytes = 64 * 1024

var (
	mu    sync.Mutex
	state *data
	path  string
)

func file() string {
	if path != "" {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	path = filepath.Join(home, ".digg", "settings.json")
	return path
}

// SetPathForTest points the store at a scratch file.
func SetPathForTest(p string) {
	mu.Lock()
	defer mu.Unlock()
	path = p
	state = nil
}

func load() *data {
	if state != nil {
		return state
	}
	state = &data{Contexts: map[string]*ContextPrefs{}}
	raw, err := os.ReadFile(file())
	if err != nil {
		return state
	}
	// A corrupt file is not worth crashing over; configstore silently starts
	// fresh in the same situation.
	if err := json.Unmarshal(raw, state); err != nil {
		state = &data{Contexts: map[string]*ContextPrefs{}}
		return state
	}
	if state.Contexts == nil {
		state.Contexts = map[string]*ContextPrefs{}
	}
	return state
}

func save() {
	d := load()
	raw, err := json.MarshalIndent(d, "", "\t")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(file()), 0o700); err != nil {
		return
	}
	// Write-then-rename: a half-written settings.json is one the next boot
	// throws away, losing every preference at once.
	tmp := file() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return
	}
	os.Rename(tmp, file())
}

func LastContext() string {
	mu.Lock()
	defer mu.Unlock()
	return load().LastContext
}

func SetLastContext(context string) {
	mu.Lock()
	defer mu.Unlock()
	load().LastContext = context
	save()
}

func GetContextPrefs(context string) ContextPrefs {
	mu.Lock()
	defer mu.Unlock()
	p := load().Contexts[context]
	if p == nil {
		return ContextPrefs{}
	}
	out := *p
	// A file written before multi-select existed only knows one namespace.
	if out.Namespaces == nil && out.Namespace != nil {
		out.Namespaces = []string{*out.Namespace}
	}
	return out
}

// Patch is a partial update to a context's prefs; nil fields are left alone.
// Namespace is doubly optional — *string(nil) inside a set field means "all
// namespaces", which is why this cannot just reuse ContextPrefs.
type Patch struct {
	SetNamespace bool
	Namespace    *string
	Namespaces   []string
	Kind         string
}

func SetContextPrefs(context string, patch Patch) {
	mu.Lock()
	defer mu.Unlock()
	d := load()
	cur := d.Contexts[context]
	if cur == nil {
		cur = &ContextPrefs{}
		d.Contexts[context] = cur
	}
	if patch.SetNamespace {
		cur.Namespace = patch.Namespace
	}
	if patch.Namespaces != nil {
		cur.Namespaces = patch.Namespaces
	}
	if patch.Kind != "" {
		cur.Kind = patch.Kind
	}
	save()
}

// WebPrefs is the global UI preference bag. Theme defaults to dark, matching
// the TS `theme === "light" ? "light" : "dark"`.
type WebPrefs struct {
	Theme string `json:"theme"`
}

func GetWebPrefs() WebPrefs {
	mu.Lock()
	defer mu.Unlock()
	d := load()
	if d.Web != nil && d.Web.Theme == "light" {
		return WebPrefs{Theme: "light"}
	}
	return WebPrefs{Theme: "dark"}
}

func SetWebPrefs(theme string) {
	mu.Lock()
	defer mu.Unlock()
	d := load()
	if d.Web == nil {
		d.Web = &webPrefs{}
	}
	if theme != "" {
		d.Web.Theme = theme
	}
	save()
}

// UIState is the rest of the UI's shape — which rail groups are folded, the
// console's height, how the log pane is set up, how each table is sorted.
//
// It lives here rather than in localStorage for the reason the namespace and
// theme already do: localStorage is keyed on the origin and the port is part of
// it, so a cockpit that picked a different port would forget its shape.
func UIState() map[string]any {
	mu.Lock()
	defer mu.Unlock()
	ui := load().UI
	if ui == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(ui))
	for k, v := range ui {
		out[k] = v
	}
	return out
}

// SetUIState shallow-merges a patch; a null value deletes its key so the bag
// cannot only grow.
func SetUIState(patch map[string]any) map[string]any {
	mu.Lock()
	defer mu.Unlock()
	d := load()
	next := map[string]any{}
	for k, v := range d.UI {
		next[k] = v
	}
	for k, v := range patch {
		if v == nil {
			delete(next, k)
		} else {
			next[k] = v
		}
	}
	if raw, err := json.Marshal(next); err != nil || len(raw) > uiMaxBytes {
		out := map[string]any{}
		for k, v := range d.UI {
			out[k] = v
		}
		return out
	}
	d.UI = next
	save()
	out := map[string]any{}
	for k, v := range next {
		out[k] = v
	}
	return out
}

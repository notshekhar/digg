package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The Go build and the Bun build must read each other's settings.json — the
// file format is the contract, not an implementation detail.

func TestReadsAFileWrittenByTheBunBuild(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	// Exactly what configstore writes, including the legacy single "namespace".
	os.WriteFile(path, []byte(`{
		"lastContext": "minikube",
		"contexts": {"minikube": {"namespace": "demo", "kind": "deployments"}},
		"web": {"theme": "light"},
		"ui": {"consoleH": 240, "railFolds": {"config": true}}
	}`), 0o600)
	SetPathForTest(path)

	if got := LastContext(); got != "minikube" {
		t.Errorf("lastContext = %q", got)
	}
	if got := GetWebPrefs().Theme; got != "light" {
		t.Errorf("theme = %q", got)
	}
	prefs := GetContextPrefs("minikube")
	if prefs.Kind != "deployments" {
		t.Errorf("kind = %q", prefs.Kind)
	}
	// A file written before multi-select existed only knows one namespace.
	if len(prefs.Namespaces) != 1 || prefs.Namespaces[0] != "demo" {
		t.Errorf("namespaces = %v, want [demo] migrated from the legacy field", prefs.Namespaces)
	}
	if ui := UIState(); ui["consoleH"] != float64(240) {
		t.Errorf("ui.consoleH = %v", ui["consoleH"])
	}
}

func TestWritesAFileTheBunBuildCanRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	SetPathForTest(path)

	SetLastContext("prod")
	SetWebPrefs("dark")
	SetContextPrefs("prod", Patch{Namespaces: []string{"a", "b"}, Kind: "pods"})
	SetUIState(map[string]any{"sort": "NAME", "tail": 500})

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no file written: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("not valid json: %v", err)
	}
	if got["lastContext"] != "prod" {
		t.Errorf("lastContext = %v", got["lastContext"])
	}
	ctxs := got["contexts"].(map[string]any)["prod"].(map[string]any)
	if ctxs["kind"] != "pods" {
		t.Errorf("kind = %v", ctxs["kind"])
	}
	if n := ctxs["namespaces"].([]any); len(n) != 2 {
		t.Errorf("namespaces = %v", n)
	}
	if got["web"].(map[string]any)["theme"] != "dark" {
		t.Errorf("theme = %v", got["web"])
	}
}

// A null deletes its key, so the bag cannot only grow.
func TestUIStateNullDeletes(t *testing.T) {
	SetPathForTest(filepath.Join(t.TempDir(), "settings.json"))
	SetUIState(map[string]any{"a": 1, "b": 2})
	next := SetUIState(map[string]any{"a": nil})
	if _, still := next["a"]; still {
		t.Error("a null should have removed the key")
	}
	if next["b"] != 2 {
		t.Errorf("b = %v, should be untouched", next["b"])
	}
}

// A runaway writer must not turn settings.json into megabytes.
func TestUIStateRefusesAnOversizedBag(t *testing.T) {
	SetPathForTest(filepath.Join(t.TempDir(), "settings.json"))
	SetUIState(map[string]any{"keep": "me"})
	huge := make([]byte, uiMaxBytes+1024)
	for i := range huge {
		huge[i] = 'x'
	}
	next := SetUIState(map[string]any{"blob": string(huge)})
	if _, ok := next["blob"]; ok {
		t.Error("an oversized patch should have been refused")
	}
	if next["keep"] != "me" {
		t.Error("refusing the patch must not lose what was already there")
	}
}

// A corrupt file is not worth crashing over; configstore starts fresh too.
func TestCorruptFileStartsFresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(path, []byte("{not json at all"), 0o600)
	SetPathForTest(path)
	if got := LastContext(); got != "" {
		t.Errorf("lastContext = %q, want empty", got)
	}
	if got := GetWebPrefs().Theme; got != "dark" {
		t.Errorf("theme = %q, want the dark default", got)
	}
}

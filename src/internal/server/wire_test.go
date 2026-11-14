package server

import (
	"bytes"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/notshekhar/digg/src/internal/model"
)

// A decoded Secret value is arbitrary bytes. Under encoding/json/v2's defaults
// invalid UTF-8 is an error, which would drop the whole detail page; the row
// must still go out, with U+FFFD in place of the bad bytes as v1 did.
func TestMarshalKeepsInvalidUTF8RowsThroughTheirOwnMarshaler(t *testing.T) {
	payload := model.DetailModel{Summary: []model.Row{{Key: "token", Value: "ok\xffbad"}}}
	raw, err := marshal(payload)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if want := `{"summary":[["token","ok` + string(utf8.RuneError) + `bad"]]}`; string(raw) != want {
		t.Errorf("got %s, want %s", raw, want)
	}
}

// Live updates are de-duplicated by comparing encoded payloads, so a map must
// encode the same way every time or every update looks new.
func TestMarshalIsDeterministicForMaps(t *testing.T) {
	m := map[string]int{}
	for _, k := range strings.Split("a b c d e f g h i j k l m n o p", " ") {
		m[k] = len(k)
	}
	first, _ := marshal(m)
	for range 50 {
		again, _ := marshal(m)
		if !bytes.Equal(first, again) {
			t.Fatalf("encoding changed: %s vs %s", first, again)
		}
	}
}

// v2 no longer escapes '<', so the page must, or a context named
// `</script>…` would end the boot script and inject markup.
func TestRenderPageCannotCloseTheBootScript(t *testing.T) {
	html := string(renderPage(pageData{Theme: "dark", Context: "</script><b>x"}))
	if strings.Contains(html, "</script><b>") {
		t.Fatalf("boot script closed early: %s", html)
	}
	escapedLT := `\` + "u003c" // two parts, so the backslash survives tools that unescape \u sequences
	if !strings.Contains(html, escapedLT+"/script>"+escapedLT+"b>x") {
		t.Errorf("context not escaped in boot object: %s", html)
	}
}

package server

import (
	"encoding/json"
	"strings"
)

// The document `digg serve` returns for every GET. Port of src/web/page.ts.
//
// The React app is one embedded file (see bundle.go). Two things are stamped
// into it per request instead of fetched by the client:
//
//   - the theme, on <html data-theme>, because a boot fetch paints the wrong
//     colours first and then flips them;
//   - a small boot object, so the shell can name the version, the last context
//     and the saved UI state before its first round trip. The UI state is
//     stamped for the same reason as the theme: fetching it would render the
//     default layout first and rearrange it a moment later.

type pageData struct {
	Theme   string `json:"theme"`
	Version string `json:"version"`
	// Token is the per-run API token; see the security note in server.go.
	Token   string         `json:"token"`
	Context string         `json:"context,omitempty"`
	UI      map[string]any `json:"ui,omitempty"`
}

func renderPage(boot pageData) []byte {
	raw, err := json.Marshal(boot)
	if err != nil {
		raw = []byte("{}")
	}
	// `</` inside a <script> would close the tag early; escaping the slash keeps
	// any context or namespace name from ending the script block.
	safe := strings.ReplaceAll(string(raw), "<", `<`)
	tag := "<script>window.__DIGG__=" + safe + ";</script>"

	html := strings.Replace(indexHTML, `data-theme="dark"`, `data-theme="`+boot.Theme+`"`, 1)
	html = strings.Replace(html, "</head>", tag+"</head>", 1)
	return []byte(html)
}

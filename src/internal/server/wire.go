package server

import (
	"encoding/json/jsontext"
	json "encoding/json/v2"
)

// wireOptions is how every payload the server sends is encoded.
//
//   - AllowInvalidUTF8: pod logs and decoded Secret values are arbitrary bytes.
//     v2 rejects invalid UTF-8 by default, which would silently drop the frame;
//     this writes U+FFFD instead, as encoding/json v1 always did.
//   - Deterministic: v2 does not sort map keys. Live updates are de-duplicated by
//     comparing encoded payloads (see live.go), so the same value must always
//     produce the same bytes.
var wireOptions = json.JoinOptions(
	jsontext.AllowInvalidUTF8(true),
	json.Deterministic(true),
)

// marshal encodes v for the browser.
func marshal(v any) ([]byte, error) {
	return json.Marshal(v, wireOptions)
}

package model

import (
	"encoding/base64"
	"errors"
	"fmt"
	"unicode/utf8"
)

// Secret/ConfigMap-aware transforms for the in-app editor. Port of
// src/secret-yaml.ts.
//
// Kubernetes stores Secret values as base64 and (for binary ConfigMap entries)
// under binaryData. Editing that raw is hostile: base64 is unreadable and a
// value containing a literal "\n" is trivially corrupted by YAML escaping. So
// on display we DECODE clean-text values, and on save we re-ENCODE them. Values
// that are not clean UTF-8 text (binary, or containing CR/other control chars)
// stay as base64 and are left untouched — they bypass text editing entirely.

// IsSecretOrConfigMap reports whether the object gets the data editor.
func IsSecretOrConfigMap(o *Obj) bool {
	k := o.GetKind()
	return k == "Secret" || k == "ConfigMap"
}

// DecodeSecretValue decodes a single base64 Secret value for display. Clean
// UTF-8 text is returned as-is; binary values fall back to their base64 form
// (with a note) so the viewer never shows mojibake.
func DecodeSecretValue(b64 string) string {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return fmt.Sprintf("(binary, base64)\n%s", b64)
	}
	if text, ok := asCleanText(raw); ok {
		return text
	}
	return fmt.Sprintf("(binary, base64)\n%s", b64)
}

// DataEntry is one decoded key for the data editor.
type DataEntry struct {
	Key  string `json:"key"`
	Text string `json:"text"`
	// Binary is true when the bytes are not clean UTF-8 — never offer to edit
	// those.
	Binary bool `json:"binary"`
	Bytes  int  `json:"bytes"`
}

// DecodeEntry decodes one entry for the data editor.
//
// Binary values are reported rather than mangled: editing a TLS key or a
// gzipped blob as text would silently corrupt it on save, so the editor shows
// the size and refuses to touch it.
func DecodeEntry(value string, encoded bool) DataEntry {
	if !encoded {
		return DataEntry{Text: value, Bytes: len(value)}
	}
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return DataEntry{Binary: true, Bytes: len(value)}
	}
	if text, ok := asCleanText(raw); ok {
		return DataEntry{Text: text, Bytes: len(raw)}
	}
	return DataEntry{Binary: true, Bytes: len(raw)}
}

// asCleanText reports valid UTF-8 with no control chars except tab and newline.
//
// CR (0x0d) is deliberately excluded, so CRLF values round-trip as base64
// rather than losing their \r.
func asCleanText(b []byte) (string, bool) {
	if !utf8.Valid(b) {
		return "", false
	}
	for _, c := range b {
		if (c <= 0x08) || (c >= 0x0b && c <= 0x1f) {
			return "", false
		}
	}
	return string(b), true
}

// EncodeSecretValue re-encodes an edited value for `stringData`-free writes.
func EncodeSecretValue(text string) string {
	return base64.StdEncoding.EncodeToString([]byte(text))
}

// AssertIdentity refuses an edit whose identity no longer matches the object
// being saved — names are immutable and editing them would target the wrong
// object.
func AssertIdentity(name, namespace, refName, refNamespace string) error {
	if name != "" && name != refName {
		return errors.New(fmt.Sprintf(
			"name changed (%s → %s); names are immutable. Revert and re-edit.", refName, name))
	}
	if refNamespace != "" && namespace != "" && namespace != refNamespace {
		return errors.New(fmt.Sprintf(
			"namespace changed (%s → %s); revert to apply.", refNamespace, namespace))
	}
	return nil
}

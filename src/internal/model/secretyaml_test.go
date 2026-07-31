package model

import (
	"encoding/base64"
	"strings"
	"testing"
)

// Ported from the decodeEntry half of src/secret-yaml.test.ts.
//
// The toEditableYaml/fromEditableYaml round-trip tests are NOT ported: those
// two functions were referenced only by their own tests in the Bun build. The
// live editor path is the Data tab, which is decodeEntry plus a stringData
// merge patch — that is what the routes call and what is ported here.

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestDecodeEntryCleanText(t *testing.T) {
	e := DecodeEntry(b64("host: db\nport: 5432"), true)
	if e.Text != "host: db\nport: 5432" {
		t.Errorf("text = %q", e.Text)
	}
	if e.Binary {
		t.Error("clean text flagged binary")
	}
	if e.Bytes != 19 {
		t.Errorf("bytes = %d, want 19", e.Bytes)
	}
}

func TestDecodeEntryUnencodedPassesThrough(t *testing.T) {
	e := DecodeEntry("LOG_LEVEL=debug", false)
	if e.Text != "LOG_LEVEL=debug" || e.Binary {
		t.Errorf("got %+v", e)
	}
}

func TestDecodeEntryBinaryIsFlaggedNeverMangled(t *testing.T) {
	// A NUL byte is not editable text; the editor must refuse it rather than
	// round-trip it through a textarea and corrupt the value.
	e := DecodeEntry(base64.StdEncoding.EncodeToString([]byte{0x00, 0xff, 0x10}), true)
	if !e.Binary {
		t.Error("binary not flagged")
	}
	if e.Text != "" {
		t.Errorf("binary leaked text %q", e.Text)
	}
	if e.Bytes != 3 {
		t.Errorf("bytes = %d, want 3", e.Bytes)
	}
}

func TestDecodeEntryMultiByteUTF8Survives(t *testing.T) {
	const s = "café ☕ नमस्ते"
	e := DecodeEntry(b64(s), true)
	if e.Text != s {
		t.Errorf("text = %q, want %q", e.Text, s)
	}
	if e.Binary {
		t.Error("utf-8 flagged binary")
	}
}

func TestDecodeEntryEmptyIsTextNotBinary(t *testing.T) {
	e := DecodeEntry("", true)
	if e.Binary || e.Text != "" || e.Bytes != 0 {
		t.Errorf("got %+v", e)
	}
}

func TestDecodeEntryCRLFStaysBinary(t *testing.T) {
	// CR is excluded from clean text so a CRLF value round-trips as base64
	// rather than silently losing its \r.
	e := DecodeEntry(b64("line1\r\nline2"), true)
	if !e.Binary {
		t.Error("CRLF value should not be offered as editable text")
	}
}

func TestDecodeSecretValueBinaryFallsBackToBase64(t *testing.T) {
	raw := base64.StdEncoding.EncodeToString([]byte{0x00, 0xff})
	got := DecodeSecretValue(raw)
	if !strings.HasPrefix(got, "(binary, base64)") || !strings.Contains(got, raw) {
		t.Errorf("got %q", got)
	}
	if got := DecodeSecretValue(b64("hello")); got != "hello" {
		t.Errorf("clean value = %q", got)
	}
}

func TestAssertIdentityRefusesRenames(t *testing.T) {
	if err := AssertIdentity("other", "default", "app-secret", "default"); err == nil {
		t.Error("expected a rename to be refused")
	}
	if err := AssertIdentity("app-secret", "kube-system", "app-secret", "default"); err == nil {
		t.Error("expected a namespace change to be refused")
	}
	if err := AssertIdentity("app-secret", "default", "app-secret", "default"); err != nil {
		t.Errorf("unchanged identity refused: %v", err)
	}
}

package model

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Obj is one API object — the same bag of fields src/format.ts called K8sObject.
type Obj = unstructured.Unstructured

// The accessors below exist because the TS could write `o.status?.phase ?? ""`
// and get "" for every kind of absence. These do the same: a missing path, a
// wrong type and a null all read as the zero value, so a malformed object
// renders a blank cell instead of taking the table down.

func str(o *Obj, path ...string) string {
	v, ok, err := unstructured.NestedString(o.Object, path...)
	if err != nil || !ok {
		return ""
	}
	return v
}

// numStr renders a numeric field the way JS String() would: integers without a
// decimal point. JSON numbers arrive as int64 or float64 depending on the
// decoder, so both are handled.
func numStr(o *Obj, path ...string) string {
	v, ok, err := unstructured.NestedFieldNoCopy(o.Object, path...)
	if err != nil || !ok || v == nil {
		return ""
	}
	return valueString(v)
}

func valueString(v any) string {
	switch n := v.(type) {
	case int64:
		return strconv.FormatInt(n, 10)
	case int32:
		return strconv.FormatInt(int64(n), 10)
	case int:
		return strconv.Itoa(n)
	case float64:
		if n == math.Trunc(n) && math.Abs(n) < 1e15 {
			return strconv.FormatInt(int64(n), 10)
		}
		return strconv.FormatFloat(n, 'f', -1, 64)
	case string:
		return n
	case bool:
		return strconv.FormatBool(n)
	case nil:
		return ""
	}
	return fmt.Sprintf("%v", v)
}

// numOr is a number field with a default, for the many `?? 0` reads.
func numOr(o *Obj, def int64, path ...string) string {
	v, ok, err := unstructured.NestedFieldNoCopy(o.Object, path...)
	if err != nil || !ok || v == nil {
		return strconv.FormatInt(def, 10)
	}
	return valueString(v)
}

func intOf(o *Obj, path ...string) int64 {
	v, ok, err := unstructured.NestedFieldNoCopy(o.Object, path...)
	if err != nil || !ok {
		return 0
	}
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	case int32:
		return int64(n)
	}
	return 0
}

func boolOf(o *Obj, path ...string) bool {
	v, ok, err := unstructured.NestedBool(o.Object, path...)
	if err != nil || !ok {
		return false
	}
	return v
}

func slice(o *Obj, path ...string) []any {
	v, ok, err := unstructured.NestedSlice(o.Object, path...)
	if err != nil || !ok {
		return nil
	}
	return v
}

func mapOf(o *Obj, path ...string) map[string]any {
	v, ok, err := unstructured.NestedMap(o.Object, path...)
	if err != nil || !ok {
		return nil
	}
	return v
}

func stringMap(o *Obj, path ...string) map[string]string {
	v, ok, err := unstructured.NestedStringMap(o.Object, path...)
	if err != nil || !ok {
		return nil
	}
	return v
}

// mstr reads a string out of a decoded map element.
func mstr(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key]; ok {
		return valueString(v)
	}
	return ""
}

func mmap(m map[string]any, key string) map[string]any {
	if m == nil {
		return nil
	}
	if v, ok := m[key].(map[string]any); ok {
		return v
	}
	return nil
}

func mslice(m map[string]any, key string) []any {
	if m == nil {
		return nil
	}
	if v, ok := m[key].([]any); ok {
		return v
	}
	return nil
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// Name is the NAME cell. Port of NAME().
func Name(o *Obj) string {
	if n := o.GetName(); n != "" {
		return n
	}
	return "<none>"
}

// none renders an empty value as "<none>", as kubectl does.
func none(v string) string {
	if v == "" {
		return "<none>"
	}
	return v
}

// Now is overridable so age calculations are testable.
var Now = time.Now

// Age is the AGE cell. Port of age().
func Age(o *Obj) string {
	return AgeFrom(str(o, "metadata", "creationTimestamp"))
}

// AgeFrom renders an RFC3339 timestamp as kubectl's compact age.
func AgeFrom(ts string) string {
	if ts == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ""
	}
	seconds := math.Max(0, Now().Sub(t).Seconds())
	if seconds < 60 {
		return fmt.Sprintf("%ds", int64(seconds))
	}
	minutes := seconds / 60
	if minutes < 60 {
		return fmt.Sprintf("%dm", int64(minutes))
	}
	hours := minutes / 60
	if hours < 24 {
		return fmt.Sprintf("%dh", int64(hours))
	}
	days := hours / 24
	if days < 365 {
		return fmt.Sprintf("%dd", int64(days))
	}
	return fmt.Sprintf("%dy", int64(days/365))
}

// collapseSpace mirrors `.replace(/\s+/g, " ").trim()`.
func collapseSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// nestedRaw reports whether a path exists at all, which the TS expressed as
// `x !== undefined`. DaemonSets are distinguished from Deployments this way.
func nestedRaw(o *Obj, path ...string) (any, bool, error) {
	return unstructured.NestedFieldNoCopy(o.Object, path...)
}

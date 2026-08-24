package server

import (
	"math"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/notshekhar/digg/src/internal/model"
)

// Objects → table rows. Port of src/web/rows.ts.
//
// Extracted so /api/list and the live watch stream cannot drift: a row built
// from a watch event must be byte-identical to the same row built from a list,
// or a table that switches between the two would flicker in ways nobody could
// reproduce.

// Row is one line of a resource table.
type Row struct {
	Cells []string       `json:"cells"`
	Name  string         `json:"name"`
	NS    string         `json:"ns,omitempty"`
	Tones map[int]string `json:"tones"`
	// TS is the creation timestamp in ms, so the grid can sort by real age.
	// Sorting the rendered "5d" string puts 9m after 5d, which is the kind of
	// wrong that looks right.
	TS     int64                `json:"ts"`
	Labels map[string]string    `json:"labels,omitempty"`
	Meters map[int]*Meter       `json:"meters,omitempty"`
	Rules  []model.IngressRoute `json:"rules,omitempty"`
	// RulesMore is how many routes were dropped by the per-row cap, so the cell
	// can say so instead of silently lying about the shape of the Ingress.
	RulesMore int `json:"rulesMore,omitempty"`
	// Lines makes a multi-route Ingress taller; the grid lays rows out by their
	// own heights. It MUST equal the number of text lines the cell renders —
	// under-counting here is what makes tall rows overlap their neighbours.
	Lines int `json:"lines,omitempty"`
}

// StatusTone colours a cell by what its text means.
func StatusTone(value string) string {
	v := strings.ToLower(value)
	switch v {
	case "running", "active", "ready", "bound", "succeeded", "true":
		return "ok"
	case "pending", "containercreating", "terminating", "notready", "false":
		return "warn"
	case "crashloopbackoff", "evicted", "oomkilled":
		return "bad"
	}
	if strings.Contains(v, "error") || strings.Contains(v, "failed") {
		return "bad"
	}
	return "neutral"
}

// ColumnsFor says where the usage columns get spliced in, and what the header
// ends up as.
//
// Usage sits inside the kind's own columns rather than after them, so CPU reads
// next to the replica counts and before AGE, where an operator looks.
func ColumnsFor(kind *model.KindDef, usage *UsageColumns) ([]string, int) {
	base := make([]string, 0, len(kind.Columns)+1)
	if !kind.ClusterScoped {
		base = append(base, "NAMESPACE")
	}
	base = append(base, kind.Columns...)

	if usage == nil {
		return base, len(base)
	}
	insertAt := len(base)
	for i, c := range base {
		if c == usage.InsertBefore {
			insertAt = i
			break
		}
	}
	out := make([]string, 0, len(base)+len(usage.Columns))
	out = append(out, base[:insertAt]...)
	out = append(out, usage.Columns...)
	out = append(out, base[insertAt:]...)
	return out, insertAt
}

const maxIngressRules = 12

// BuildRow renders one object as a row.
func BuildRow(o *model.Obj, kind *model.KindDef, usage *UsageColumns, insertAt int) Row {
	name, ns := o.GetName(), o.GetNamespace()

	withNS := kind.Row(o)
	if !kind.ClusterScoped {
		withNS = append([]string{ns}, withNS...)
	}

	cells := withNS
	meters := map[int]*Meter{}
	if usage != nil {
		extra, ok := usage.ByKey[ns+"/"+name]
		if !ok {
			// A row the metrics pass never saw (it appeared between the list and
			// the top call) keeps its place in the grid with em dashes rather
			// than shifting every column left.
			blanks := make([]string, len(usage.Columns))
			for i := range blanks {
				blanks[i] = "—"
			}
			extra = usageCell{Cells: blanks}
		}
		out := make([]string, 0, len(withNS)+len(extra.Cells))
		out = append(out, withNS[:insertAt]...)
		out = append(out, extra.Cells...)
		out = append(out, withNS[insertAt:]...)
		cells = out

		for i, m := range extra.Meters {
			if m != nil {
				meters[insertAt+i] = m
			}
		}
	}

	tones := map[int]string{}
	for i, c := range cells {
		if t := StatusTone(c); t != "neutral" {
			tones[i] = t
		}
	}

	row := Row{Cells: cells, Name: name, NS: ns, Tones: tones, Labels: o.GetLabels()}

	if ts := o.GetCreationTimestamp(); !ts.IsZero() {
		row.TS = ts.UnixMilli()
	}
	if len(meters) > 0 {
		row.Meters = meters
	}

	// An Ingress row's whole meaning is its routes, so they travel as
	// structured links: the URL is openable and the backend clickable, instead
	// of a comma-joined string you have to retype.
	if kind.Name == "ingresses" {
		rules := model.IngressRoutes(o)
		lines := len(rules)
		if len(rules) > maxIngressRules {
			row.RulesMore = len(rules) - maxIngressRules
			rules = rules[:maxIngressRules]
			lines = len(rules) + 1 // the "+N more" line is a line too
		}
		row.Rules = rules
		if lines > 1 {
			row.Lines = lines
		}
	}
	return row
}

// RowKey identifies a row across list and watch.
func RowKey(ns, name string) string { return ns + "/" + name }

// RowFingerprint is a cheap identity for "did this row actually change?" delta
// suppression.
//
// This used to be `json.Marshal(row)`, which is correct and stable (encoding/json
// sorts map keys) but costs an allocation and a full re-encode of every row on
// every metrics pass — 5,000 pods across every namespace meant 5,000 marshals
// and ~2MB of retained fingerprint strings every fifteen seconds, on the same
// goroutine that has to answer the socket. A 64-bit FNV-1a over the same fields
// says the same thing for a fraction of the work and 8 bytes of state per row.
//
// Go randomises map iteration order, so the two maps are folded in with
// ADDITION rather than by appending: a commutative combine is what makes the
// digest independent of the order the runtime happens to hand them back. Get
// that wrong and every row looks changed on every pass, which is precisely the
// storm the fingerprint exists to prevent.
func RowFingerprint(r Row) uint64 {
	h := fnvOffset
	h = hashString(h, r.Name)
	h = hashString(h, r.NS)
	h = hashUint(h, uint64(r.TS))
	h = hashUint(h, uint64(r.Lines))
	h = hashUint(h, uint64(r.RulesMore))
	for _, c := range r.Cells {
		h = hashString(h, c)
	}
	// Tones are a pure function of Cells (see BuildRow), so hashing them again
	// would only cost time.
	var labels uint64
	for k, v := range r.Labels {
		labels += hashString(hashString(fnvOffset, k), v)
	}
	h = hashUint(h, labels)
	var meters uint64
	for i, m := range r.Meters {
		e := hashUint(fnvOffset, uint64(i))
		e = hashFloat(e, m.Pct)
		e = hashFloat(e, m.Mark)
		meters += e
	}
	h = hashUint(h, meters)
	for _, rule := range r.Rules {
		h = hashString(h, rule.Host)
		h = hashString(h, rule.Path)
		h = hashString(h, rule.Service)
		h = hashString(h, rule.Port)
		h = hashString(h, rule.URL)
	}
	return h
}

const (
	fnvOffset uint64 = 14695981039346656037
	fnvPrime  uint64 = 1099511628211
)

func hashString(h uint64, s string) uint64 {
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= fnvPrime
	}
	// A separator, so ["ab",""] and ["a","b"] are different rows.
	h ^= 0xff
	h *= fnvPrime
	return h
}

func hashUint(h, v uint64) uint64 {
	for i := 0; i < 8; i++ {
		h ^= v & 0xff
		h *= fnvPrime
		v >>= 8
	}
	return h
}

// hashFloat folds a nullable number in. nil and 0 must not collide: "no
// metrics-server" and "using nothing" are different answers, and the client
// draws them differently, so nil gets a sentinel no float64 bit pattern of a
// real percentage can reach.
const nilFloat uint64 = 0x6469_6767_6e69_6c00 // "digg" + "nil"

func hashFloat(h uint64, f *float64) uint64 {
	if f == nil {
		return hashUint(h, nilFloat)
	}
	return hashUint(h, math.Float64bits(*f))
}

// ── small unstructured helpers shared by this package ───────────────────────

func nestedString(o *model.Obj, path ...string) string {
	v, ok, err := unstructured.NestedString(o.Object, path...)
	if err != nil || !ok {
		return ""
	}
	return v
}

func nestedMap(o *model.Obj, path ...string) map[string]any {
	v, ok, err := unstructured.NestedMap(o.Object, path...)
	if err != nil || !ok {
		return nil
	}
	return v
}

func nestedStringMap(o *model.Obj, path ...string) map[string]string {
	v, ok, err := unstructured.NestedStringMap(o.Object, path...)
	if err != nil || !ok {
		return nil
	}
	return v
}

func nestedSlice(o *model.Obj, path ...string) []any {
	v, ok, err := unstructured.NestedSlice(o.Object, path...)
	if err != nil || !ok {
		return nil
	}
	return v
}

func nestedInt(o *model.Obj, path ...string) int64 {
	v, ok, err := unstructured.NestedFieldNoCopy(o.Object, path...)
	if err != nil || !ok {
		return 0
	}
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	}
	return 0
}

func nestedBool(o *model.Obj, path ...string) bool {
	v, ok, err := unstructured.NestedBool(o.Object, path...)
	if err != nil || !ok {
		return false
	}
	return v
}

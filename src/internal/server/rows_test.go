package server

import (
	"testing"

	"github.com/notshekhar/digg/src/internal/model"
)

// The fingerprint is what stops a metrics pass from re-sending every row in the
// table, so the two properties that matter are that it is STABLE for an
// unchanged row and that it MOVES for a changed one. The first is the easy one
// to get wrong: Go randomises map iteration, and Row carries three maps.

func sampleRow() Row {
	pct, mark := 42.5, 30.0
	return Row{
		Cells: []string{"demo", "api-7d9f", "1/1", "Running", "0"},
		Name:  "api-7d9f",
		NS:    "demo",
		Tones: map[int]string{3: "ok"},
		TS:    1723200000000,
		Labels: map[string]string{
			"app": "api", "tier": "backend", "pod-template-hash": "7d9f",
			"env": "prod", "team": "platform", "region": "ap-south-1",
		},
		Meters: map[int]*Meter{5: {Pct: &pct, Mark: &mark}, 6: {Pct: &pct}},
	}
}

func TestRowFingerprintIsStableAcrossMapOrder(t *testing.T) {
	want := RowFingerprint(sampleRow())
	// Fresh maps each time, so the runtime hands the ranges back in a
	// different order on most iterations.
	for i := 0; i < 200; i++ {
		if got := RowFingerprint(sampleRow()); got != want {
			t.Fatalf("iteration %d: fingerprint moved for an identical row: %x != %x", i, got, want)
		}
	}
}

func TestRowFingerprintMovesOnEveryFieldThatRenders(t *testing.T) {
	base := RowFingerprint(sampleRow())
	zero := 0.0

	cases := map[string]func(*Row){
		"a cell":            func(r *Row) { r.Cells[3] = "CrashLoopBackOff" },
		"a cell going away": func(r *Row) { r.Cells = r.Cells[:4] },
		"the name":          func(r *Row) { r.Name = "api-7d9g" },
		"the namespace":     func(r *Row) { r.NS = "prod" },
		"the age":           func(r *Row) { r.TS = 1723200000001 },
		"a label value":     func(r *Row) { r.Labels["app"] = "api2" },
		"a label key":       func(r *Row) { delete(r.Labels, "env"); r.Labels["envx"] = "prod" },
		"a new label":       func(r *Row) { r.Labels["extra"] = "1" },
		"a meter fill":      func(r *Row) { v := 43.0; r.Meters[5].Pct = &v },
		"a meter tick":      func(r *Row) { v := 31.0; r.Meters[5].Mark = &v },
		"a meter column":    func(r *Row) { r.Meters[7] = r.Meters[5] },
		"line count":        func(r *Row) { r.Lines = 3 },
		"capped rules":      func(r *Row) { r.RulesMore = 2 },
		"an ingress route":  func(r *Row) { r.Rules = []model.IngressRoute{{Host: "a.example", Service: "web"}} },
		// The one that would quietly draw a confident 0% bar where the cluster
		// has no metrics-server at all.
		"unknown becoming zero":     func(r *Row) { r.Meters[6].Pct = &zero },
		"a number becoming unknown": func(r *Row) { r.Meters[5].Pct = nil },
	}

	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := sampleRow()
			mutate(&r)
			if RowFingerprint(r) == base {
				t.Fatalf("%s did not change the fingerprint", name)
			}
		})
	}
}

// Two rows that differ only in where a cell boundary falls must not collide —
// the separator in hashString is what buys this.
func TestRowFingerprintRespectsCellBoundaries(t *testing.T) {
	a := Row{Cells: []string{"ab", ""}, Name: "x"}
	b := Row{Cells: []string{"a", "b"}, Name: "x"}
	if RowFingerprint(a) == RowFingerprint(b) {
		t.Fatal(`["ab",""] and ["a","b"] hash the same`)
	}
}

func BenchmarkRowFingerprint(b *testing.B) {
	r := sampleRow()
	b.ReportAllocs()
	b.ResetTimer()
	var sink uint64
	for i := 0; i < b.N; i++ {
		sink = RowFingerprint(r)
	}
	_ = sink
}

// What it replaced, kept here so the claim in the comment above RowFingerprint
// stays measurable rather than remembered.
func BenchmarkRowFingerprintViaJSON(b *testing.B) {
	r := sampleRow()
	b.ReportAllocs()
	b.ResetTimer()
	var sink string
	for i := 0; i < b.N; i++ {
		out, _ := marshal(r)
		sink = string(out)
	}
	_ = sink
}

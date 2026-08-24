package model

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// Ported from src/quantity.test.ts, case for case.

func closeTo(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9*math.Max(1, math.Abs(want)) {
		t.Errorf("got %v, want ~%v", got, want)
	}
}

func TestParseQuantityCPUSuffixesAreMillicores(t *testing.T) {
	closeTo(t, ParseQuantity("100m"), 0.1)
	if got := ParseQuantity("2"); got != 2 {
		t.Errorf("2 → %v", got)
	}
	closeTo(t, ParseQuantity("1500m"), 1.5)
	closeTo(t, ParseQuantity("250n"), 2.5e-7)
}

func TestParseQuantityBinaryAndDecimalDiffer(t *testing.T) {
	if got := ParseQuantity("1Ki"); got != 1024 {
		t.Errorf("1Ki → %v", got)
	}
	if got := ParseQuantity("1Mi"); got != 1024*1024 {
		t.Errorf("1Mi → %v", got)
	}
	if got := ParseQuantity("1Gi"); got != math.Pow(1024, 3) {
		t.Errorf("1Gi → %v", got)
	}
	// The bug this guards: treating G as Gi understates by ~7%.
	if got := ParseQuantity("1G"); got != 1e9 {
		t.Errorf("1G → %v", got)
	}
	if ParseQuantity("1G") == ParseQuantity("1Gi") {
		t.Error("1G must not equal 1Gi")
	}
}

func TestParseQuantityJunkIsZeroNeverNaN(t *testing.T) {
	for _, in := range []string{"", "<unknown>", "abc"} {
		if got := ParseQuantity(in); got != 0 {
			t.Errorf("%q → %v, want 0", in, got)
		}
	}
}

func TestParseQuantityExponentNotation(t *testing.T) {
	if got := ParseQuantity("1e3"); got != 1000 {
		t.Errorf("1e3 → %v", got)
	}
	if got := ParseQuantity("1.5e2"); got != 150 {
		t.Errorf("1.5e2 → %v", got)
	}
}

func TestFormatCPU(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0.25, "250m"},
		{0, "0"},
		{2, "2"},
		{2.53, "2.53"},
		{64, "64"},
	}
	for _, c := range cases {
		if got := FormatCPU(c.in); got != c.want {
			t.Errorf("FormatCPU(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFormatBytes(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{1024, "1Ki"},
		{math.Pow(1024, 3), "1Gi"},
		{0, "0"},
		{1536, "1.5Ki"},
	}
	for _, c := range cases {
		if got := FormatBytes(c.in); got != c.want {
			t.Errorf("FormatBytes(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestPercentClampsAndRefusesUnknownDenominator(t *testing.T) {
	if got, ok := Percent(1, 2); !ok || got != 50 {
		t.Errorf("Percent(1,2) = %v,%v", got, ok)
	}
	if _, ok := Percent(5, 0); ok {
		t.Error("Percent(5,0) must be unknown")
	}
	if got, ok := Percent(10, 5); !ok || got != 100 {
		t.Errorf("Percent(10,5) = %v,%v", got, ok)
	}
	if got, ok := Percent(-1, 5); !ok || got != 0 {
		t.Errorf("Percent(-1,5) = %v,%v", got, ok)
	}
}

// ── the hand parser against the regex it replaced ───────────────────────────

// ParseQuantity used to be this. It is kept here as the oracle: the point of
// the rewrite was speed, and the only way that is a win rather than a rewrite
// of the gauges' arithmetic is if the two agree on everything, including the
// junk. The cases below are deliberately nastier than anything Kubernetes
// emits — "Inf", "0x1p3" and "NaN" are exactly what a hand-rolled split lets
// through if it forgets to check what it is handing to ParseFloat.
var legacyQuantityRe = regexp.MustCompile(`^([+-]?[0-9.]+(?:[eE][+-]?[0-9]+)?)\s*([A-Za-z]*)$`)

func legacyParseQuantity(value string) float64 {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0
	}
	m := legacyQuantityRe.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	num, err := strconv.ParseFloat(m[1], 64)
	if err != nil || math.IsInf(num, 0) || math.IsNaN(num) {
		return 0
	}
	if mult, ok := binaryUnits[m[2]]; ok {
		return num * mult
	}
	if mult, ok := decimalUnits[m[2]]; ok {
		return num * mult
	}
	return num
}

func TestParseQuantityMatchesTheRegexItReplaced(t *testing.T) {
	corpus := []string{
		// what the API actually sends
		"", "0", "1", "2", "100m", "1500m", "250n", "10u", "1Ki", "1Mi", "1Gi",
		"1Ti", "1Pi", "1Ei", "1k", "1K", "1M", "1G", "1T", "1P", "1E",
		"128974848", "129e6", "129M", "123456789", "0.5", ".5", "1.5Gi",
		"3865470566n", "-1", "-100m", "+2", "1e3", "1E3", "2.5e+3Ki", "1e-3",
		// whitespace the regex tolerated
		" 100m", "100m ", "  1Gi  ", "1.5 Gi", "1\tGi",
		// junk that must stay 0
		"m", "Gi", "abc", "1.2.3", "1Gi2", "1 2", "--1", "1..", "..", ".",
		"NaN", "Inf", "-Inf", "Infinity", "0x1p3", "0X10", "1_000", "1e", "1e+",
		"e3", "+", "-", "1Zz", "1 Gi Gi", "\n", "١٢٣", "1Gi\n",
	}
	for _, in := range corpus {
		want := legacyParseQuantity(in)
		got := ParseQuantity(in)
		if got != want && !(math.IsNaN(got) && math.IsNaN(want)) {
			t.Errorf("ParseQuantity(%q) = %v, regex said %v", in, got, want)
		}
	}
}

func BenchmarkParseQuantity(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = ParseQuantity("512Mi")
		_ = ParseQuantity("100m")
	}
}

func BenchmarkParseQuantityViaRegex(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = legacyParseQuantity("512Mi")
		_ = legacyParseQuantity("100m")
	}
}

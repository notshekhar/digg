package model

import (
	"math"
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

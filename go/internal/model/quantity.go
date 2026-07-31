// Kubernetes quantity parsing and display.
//
// The API and `kubectl top` speak in suffixed quantities — "100m", "1Gi",
// "2500Ki", "1e3" — and every gauge in the UI needs them as plain numbers.
// Two conversions matter and they are not the same:
//
//	CPU     millicores → cores. "100m" is 0.1 of a core; a bare "2" is 2 cores.
//	MEMORY  binary and decimal suffixes coexist. Ki/Mi/Gi are 1024-based and
//	        K/M/G are 1000-based; treating them alike understates a limit by 7%
//	        at Gi, which is exactly the kind of quiet error a dashboard should
//	        never introduce.
//
// Port of src/quantity.ts. Deliberately NOT apimachinery's resource.Quantity:
// this accepts a "u" (micro) suffix, falls back to the bare number for suffixes
// it does not know, and returns 0 rather than an error for junk. Substituting
// the stricter parser would change what the gauges draw.
package model

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

var binaryUnits = map[string]float64{
	"Ki": 1024,
	"Mi": 1024 * 1024,
	"Gi": 1024 * 1024 * 1024,
	"Ti": 1024 * 1024 * 1024 * 1024,
	"Pi": 1024 * 1024 * 1024 * 1024 * 1024,
	"Ei": 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
}

var decimalUnits = map[string]float64{
	"n": 1e-9,
	"u": 1e-6,
	"m": 1e-3,
	"":  1,
	"k": 1e3,
	"K": 1e3,
	"M": 1e6,
	"G": 1e9,
	"T": 1e12,
	"P": 1e15,
	"E": 1e18,
}

var quantityRe = regexp.MustCompile(`^([+-]?[0-9.]+(?:[eE][+-]?[0-9]+)?)\s*([A-Za-z]*)$`)

// ParseQuantity parses any quantity to its base unit (cores for CPU, bytes for
// memory). Anything unparseable is 0 — a gauge with a broken denominator draws
// "unknown", it does not throw.
func ParseQuantity(value string) float64 {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0
	}
	m := quantityRe.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	num, err := strconv.ParseFloat(m[1], 64)
	if err != nil || math.IsInf(num, 0) || math.IsNaN(num) {
		return 0
	}
	suffix := m[2]
	if mult, ok := binaryUnits[suffix]; ok {
		return num * mult
	}
	if mult, ok := decimalUnits[suffix]; ok {
		return num * mult
	}
	return num
}

// ParseCPU is cores as a number: "250m" → 0.25, "2" → 2.
func ParseCPU(v string) float64 { return ParseQuantity(v) }

// ParseMemory is bytes as a number: "1Gi" → 1073741824.
func ParseMemory(v string) float64 { return ParseQuantity(v) }

// FormatCPU renders cores for humans: 0.25 → "250m", 2 → "2", 2.5 → "2.5".
func FormatCPU(cores float64) string {
	if math.IsInf(cores, 0) || math.IsNaN(cores) || cores == 0 {
		return "0"
	}
	if cores < 1 {
		return trimFloat(math.Round(cores*1000)) + "m"
	}
	if cores < 10 {
		return trimFloat(math.Round(cores*100) / 100)
	}
	return trimFloat(math.Round(cores))
}

var byteUnits = []string{"B", "Ki", "Mi", "Gi", "Ti", "Pi"}

// FormatBytes renders bytes for humans, binary units the way kubectl prints
// them.
func FormatBytes(bytes float64) string {
	if math.IsInf(bytes, 0) || math.IsNaN(bytes) || bytes <= 0 {
		return "0"
	}
	n := bytes
	i := 0
	for n >= 1024 && i < len(byteUnits)-1 {
		n /= 1024
		i++
	}
	var rounded float64
	if n >= 100 || i == 0 {
		rounded = math.Round(n)
	} else {
		rounded = math.Round(n*10) / 10
	}
	return trimFloat(rounded) + byteUnits[i]
}

// Percent is a percentage clamped to [0,100]; ok is false when the denominator
// is unknown, which the gauges draw as a hatched bar rather than a confident 0%.
func Percent(used, total float64) (float64, bool) {
	if math.IsInf(used, 0) || math.IsNaN(used) || math.IsInf(total, 0) || math.IsNaN(total) || total <= 0 {
		return 0, false
	}
	return math.Max(0, math.Min(100, (used/total)*100)), true
}

// trimFloat prints a float the way JavaScript's String(number) does: no
// trailing zeros, no ".0" on integers. The TS original relied on that
// implicitly, and the strings end up in the UI.
func trimFloat(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}

package model

import (
	"math"
	"strings"
)

// Who asked for what, and who is using it. Port of src/usage.ts.
//
// Every gauge in digg — the bars in the pod/deployment/node tables, the
// allocation blocks on a container card — is the same three numbers: what the
// container is using now, what it reserved (requests) and what it may take
// (limits).
//
// Used is deliberately nullable: no metrics-server means "unknown", and an
// unknown that renders as 0 is a lie a capacity view must not tell. In Go that
// is a *float64, not a 0.

// Gauge is one resource's three numbers.
type Gauge struct {
	Used     *float64 `json:"used"`
	Requests float64  `json:"requests"`
	Limits   float64  `json:"limits"`
}

// EmptyGauge is a gauge with an unknown denominator.
func EmptyGauge() Gauge { return Gauge{} }

// Alloc pairs the CPU and memory gauges, which always travel together.
type Alloc struct {
	CPU Gauge `json:"cpu"`
	Mem Gauge `json:"mem"`
}

// PodSpecOf returns the pod spec of a pod, or of a workload's pod template.
//
// A CronJob buries its template one level deeper than everything else, behind
// jobTemplate. Without that case it falls through to the CronJob's own spec,
// which has no containers and no volumes — so a CronJob mounting a Secret would
// report mounting nothing, and the Secret's page would say nobody uses it.
func PodSpecOf(o *Obj) map[string]any {
	if tmpl := mapOf(o, "spec", "jobTemplate", "spec", "template", "spec"); tmpl != nil {
		return tmpl
	}
	if tmpl := mapOf(o, "spec", "template", "spec"); tmpl != nil {
		return tmpl
	}
	return mapOf(o, "spec")
}

// ContainersOf lists a pod's (or template's) app containers.
func ContainersOf(o *Obj) []map[string]any {
	return containerList(PodSpecOf(o), "containers")
}

// InitContainersOf lists a pod's (or template's) init containers.
func InitContainersOf(o *Obj) []map[string]any {
	return containerList(PodSpecOf(o), "initContainers")
}

func containerList(spec map[string]any, key string) []map[string]any {
	raw := mslice(spec, key)
	out := make([]map[string]any, 0, len(raw))
	for _, c := range raw {
		if m := asMap(c); m != nil {
			out = append(out, m)
		}
	}
	return out
}

// ContainerAllocation is the requests/limits of one container, in cores and
// bytes.
func ContainerAllocation(c map[string]any) Alloc {
	res := mmap(c, "resources")
	req, lim := mmap(res, "requests"), mmap(res, "limits")
	return Alloc{
		CPU: Gauge{Requests: ParseQuantity(mstr(req, "cpu")), Limits: ParseQuantity(mstr(lim, "cpu"))},
		Mem: Gauge{Requests: ParseQuantity(mstr(req, "memory")), Limits: ParseQuantity(mstr(lim, "memory"))},
	}
}

// PodAllocation is the requests/limits of a whole pod (or pod template).
//
// Init containers are counted the way the scheduler counts them — the pod's
// effective request is the larger of "all app containers at once" and "the
// greediest init container" — because they never run at the same time.
func PodAllocation(o *Obj) Alloc {
	var out Alloc
	for _, c := range ContainersOf(o) {
		a := ContainerAllocation(c)
		out.CPU.Requests += a.CPU.Requests
		out.CPU.Limits += a.CPU.Limits
		out.Mem.Requests += a.Mem.Requests
		out.Mem.Limits += a.Mem.Limits
	}
	for _, c := range InitContainersOf(o) {
		a := ContainerAllocation(c)
		out.CPU.Requests = math.Max(out.CPU.Requests, a.CPU.Requests)
		out.CPU.Limits = math.Max(out.CPU.Limits, a.CPU.Limits)
		out.Mem.Requests = math.Max(out.Mem.Requests, a.Mem.Requests)
		out.Mem.Limits = math.Max(out.Mem.Limits, a.Mem.Limits)
	}
	return out
}

// AddGauge adds b into a, treating a nil Used as "still unknown" rather than
// zero.
func AddGauge(a, b Gauge) Gauge {
	out := Gauge{Requests: a.Requests + b.Requests, Limits: a.Limits + b.Limits}
	if a.Used != nil || b.Used != nil {
		sum := deref(a.Used) + deref(b.Used)
		out.Used = &sum
	}
	return out
}

func deref(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// SelectorMatches reports whether this object's labels satisfy a workload's
// spec.selector. matchExpressions are honoured — a workload using them would
// otherwise silently match everything.
func SelectorMatches(o *Obj, selector map[string]any) bool {
	if selector == nil {
		return false
	}
	labels := o.GetLabels()

	matchLabels := mmap(selector, "matchLabels")
	for k, v := range matchLabels {
		if labels[k] != valueString(v) {
			return false
		}
	}

	exprs := mslice(selector, "matchExpressions")
	for _, raw := range exprs {
		e := asMap(raw)
		key := mstr(e, "key")
		have, present := labels[key]
		values := map[string]bool{}
		for _, v := range mslice(e, "values") {
			values[valueString(v)] = true
		}
		switch mstr(e, "operator") {
		case "In":
			if !present || !values[have] {
				return false
			}
		case "NotIn":
			if present && values[have] {
				return false
			}
		case "Exists":
			if !present {
				return false
			}
		case "DoesNotExist":
			if present {
				return false
			}
		}
	}
	return len(matchLabels) > 0 || len(exprs) > 0
}

// OwnedBy reports whether pod is owned — directly or through a ReplicaSet — by
// this workload.
func OwnedBy(pod, owner *Obj, viaKinds ...string) bool {
	name := owner.GetName()
	kind := owner.GetKind()
	via := map[string]bool{}
	for _, k := range viaKinds {
		via[k] = true
	}
	for _, ref := range pod.GetOwnerReferences() {
		if ref.Kind == kind && ref.Name == name {
			return true
		}
		if via[ref.Kind] && strings.HasPrefix(ref.Name, name+"-") {
			return true
		}
	}
	return false
}

// Sample is a measured usage pair.
type Sample struct {
	CPU float64 `json:"cpu"`
	Mem float64 `json:"mem"`
}

// Metrics is the lookup a page needs, with "no metrics at all" as a
// first-class state rather than a map of zeroes.
type Metrics struct {
	Available bool
	pods      map[string]Sample
	conts     map[string]Sample
}

// Usage is one entry of a metrics map, matching kube.PodMetrics without
// importing it (model must not depend on the cluster layer).
type Usage struct {
	CPU    string
	Memory string
}

// MetricsView builds a lookup from pod- and container-level maps.
//
// Keys are tried namespace-qualified first, because two namespaces are allowed
// to hold pods with the same name and a bare-name map would silently show one
// pod's CPU on the other's row.
func MetricsView(pods, containers map[string]Usage) *Metrics {
	m := &Metrics{
		Available: len(pods) > 0 || len(containers) > 0,
		pods:      map[string]Sample{},
		conts:     map[string]Sample{},
	}
	for k, v := range pods {
		m.pods[k] = sampleOf(v)
	}
	for k, v := range containers {
		m.conts[k] = sampleOf(v)
	}
	return m
}

// MetricsFromContainers derives pod totals from container samples.
//
// One `top --containers` call answers both questions: a pod's usage is the sum
// of its containers', so the pod-level call can be skipped entirely.
func MetricsFromContainers(containers map[string]Usage) *Metrics {
	m := &Metrics{
		Available: len(containers) > 0,
		pods:      map[string]Sample{},
		conts:     map[string]Sample{},
	}
	for key, v := range containers {
		s := sampleOf(v)
		m.conts[key] = s
		// Keys arrive both qualified (ns/pod/container) and bare
		// (pod/container); sum each shape into the matching pod key.
		parts := strings.Split(key, "/")
		if len(parts) < 2 {
			continue
		}
		podKey := strings.Join(parts[:len(parts)-1], "/")
		prev := m.pods[podKey]
		m.pods[podKey] = Sample{CPU: prev.CPU + s.CPU, Mem: prev.Mem + s.Mem}
	}
	return m
}

// NoMetrics is the empty view, for a cluster with no metrics-server.
var NoMetrics = &Metrics{pods: map[string]Sample{}, conts: map[string]Sample{}}

func sampleOf(u Usage) Sample {
	return Sample{CPU: ParseQuantity(u.CPU), Mem: ParseQuantity(u.Memory)}
}

// Pod looks up one pod's usage; ok is false when it is unknown.
func (m *Metrics) Pod(name, ns string) (Sample, bool) {
	if m == nil {
		return Sample{}, false
	}
	if ns != "" {
		if s, ok := m.pods[ns+"/"+name]; ok {
			return s, true
		}
	}
	s, ok := m.pods[name]
	return s, ok
}

// Container looks up one container's usage; ok is false when it is unknown.
func (m *Metrics) Container(pod, container, ns string) (Sample, bool) {
	if m == nil {
		return Sample{}, false
	}
	if ns != "" {
		if s, ok := m.conts[ns+"/"+pod+"/"+container]; ok {
			return s, true
		}
	}
	s, ok := m.conts[pod+"/"+container]
	return s, ok
}

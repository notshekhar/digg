package server

import (
	"fmt"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/notshekhar/digg/src/internal/model"
)

// A workloads table asks "which of these pods are mine?" once per (workload,
// pod) pair. These benchmarks are the two shapes that question can take, on a
// cluster the size the complaint came from: every namespace selected, a few
// hundred workloads, a few thousand pods.

const (
	benchNamespaces = 40
	benchPerNS      = 10 // workloads per namespace
	benchReplicas   = 15 // pods per workload
)

func benchPods() []model.Obj {
	pods := make([]model.Obj, 0, benchNamespaces*benchPerNS*benchReplicas)
	for n := 0; n < benchNamespaces; n++ {
		ns := fmt.Sprintf("team-%02d", n)
		for w := 0; w < benchPerNS; w++ {
			app := fmt.Sprintf("svc-%02d", w)
			for r := 0; r < benchReplicas; r++ {
				pods = append(pods, model.Obj{Object: map[string]any{
					"metadata": map[string]any{
						"name":      fmt.Sprintf("%s-%d", app, r),
						"namespace": ns,
						"labels": map[string]any{
							"app": app, "tier": "backend", "env": "prod",
							"pod-template-hash": "7d9f88c",
						},
					},
					"spec": map[string]any{"containers": []any{
						map[string]any{"name": "main", "resources": map[string]any{
							"requests": map[string]any{"cpu": "100m", "memory": "128Mi"},
							"limits":   map[string]any{"cpu": "500m", "memory": "512Mi"},
						}},
						map[string]any{"name": "sidecar", "resources": map[string]any{
							"requests": map[string]any{"cpu": "10m", "memory": "32Mi"},
						}},
					}},
				}})
			}
		}
	}
	return pods
}

func benchWorkloads() []model.Obj {
	out := make([]model.Obj, 0, benchNamespaces*benchPerNS)
	for n := 0; n < benchNamespaces; n++ {
		for w := 0; w < benchPerNS; w++ {
			out = append(out, model.Obj{Object: map[string]any{
				"metadata": map[string]any{
					"name": fmt.Sprintf("svc-%02d", w), "namespace": fmt.Sprintf("team-%02d", n),
				},
				"spec": map[string]any{"selector": map[string]any{
					"matchLabels": map[string]any{"app": fmt.Sprintf("svc-%02d", w), "tier": "backend"},
				}},
			}})
		}
	}
	return out
}

// scanEveryPodPerWorkload is what this used to do: no bucketing, and both the
// pod's labels and its container arithmetic re-derived inside the inner loop.
func scanEveryPodPerWorkload(items, pods []model.Obj) map[string]gaugePair {
	out := make(map[string]gaugePair, len(items))
	for i := range items {
		o := &items[i]
		selector, _, _ := unstructured.NestedMap(o.Object, "spec", "selector")
		var cpu, mem model.Gauge
		for j := range pods {
			p := &pods[j]
			if p.GetNamespace() != o.GetNamespace() {
				continue
			}
			if !model.SelectorMatches(p, selector) {
				continue
			}
			alloc := model.PodAllocation(p)
			cpu = model.AddGauge(cpu, alloc.CPU)
			mem = model.AddGauge(mem, alloc.Mem)
		}
		out[objKey(o)] = gaugePair{cpu, mem}
	}
	return out
}

// scanBucketed is the shape podsideUsage uses now: each pod reduced once, then
// a workload only ever looks at its own namespace.
func scanBucketed(items, pods []model.Obj) map[string]gaugePair {
	type podFacts struct {
		labels   map[string]string
		cpu, mem model.Gauge
	}
	byNS := make(map[string][]podFacts, 16)
	for j := range pods {
		p := &pods[j]
		alloc := model.PodAllocation(p)
		ns := p.GetNamespace()
		byNS[ns] = append(byNS[ns], podFacts{labels: p.GetLabels(), cpu: alloc.CPU, mem: alloc.Mem})
	}
	out := make(map[string]gaugePair, len(items))
	for i := range items {
		o := &items[i]
		selector, _, _ := unstructured.NestedMap(o.Object, "spec", "selector")
		var cpu, mem model.Gauge
		for _, f := range byNS[o.GetNamespace()] {
			if !model.SelectorMatchesLabels(f.labels, selector) {
				continue
			}
			cpu = model.AddGauge(cpu, f.cpu)
			mem = model.AddGauge(mem, f.mem)
		}
		out[objKey(o)] = gaugePair{cpu, mem}
	}
	return out
}

// The optimisation is only worth anything if it produces the same table.
func TestBucketedScanMatchesTheNaiveOne(t *testing.T) {
	items, pods := benchWorkloads(), benchPods()
	want := scanEveryPodPerWorkload(items, pods)
	got := scanBucketed(items, pods)

	if len(got) != len(want) {
		t.Fatalf("got %d workloads, want %d", len(got), len(want))
	}
	for k, w := range want {
		g, ok := got[k]
		if !ok {
			t.Fatalf("%s missing from the bucketed scan", k)
		}
		if g.cpu.Requests != w.cpu.Requests || g.cpu.Limits != w.cpu.Limits ||
			g.mem.Requests != w.mem.Requests || g.mem.Limits != w.mem.Limits {
			t.Fatalf("%s: got %+v, want %+v", k, g, w)
		}
	}
	// A sanity floor: every workload really did find its replicas, so the two
	// scans are not agreeing on "nothing matched anything".
	sample := got["team-00/svc-00"]
	if wantCPU := float64(benchReplicas) * 0.11; sample.cpu.Requests < wantCPU-1e-9 {
		t.Fatalf("team-00/svc-00 summed %v CPU requests, expected %v", sample.cpu.Requests, wantCPU)
	}
}

func BenchmarkWorkloadScanNaive(b *testing.B) {
	items, pods := benchWorkloads(), benchPods()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		scanEveryPodPerWorkload(items, pods)
	}
}

func BenchmarkWorkloadScanBucketed(b *testing.B) {
	items, pods := benchWorkloads(), benchPods()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		scanBucketed(items, pods)
	}
}

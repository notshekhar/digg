package server

import (
	"fmt"
	"math"

	"github.com/notshekhar/digg/src/internal/kube"
	"github.com/notshekhar/digg/src/internal/model"
)

// Usage columns for the resource tables. Port of src/web/gauges.ts.
//
// A pod list that shows READY and AGE but not what the thing is *doing* sends
// you to `kubectl top` in another window, so pods, the workloads that own them
// and nodes all get live CPU/memory columns with a bar.
//
// The bar's denominator is the honest part. A container with a limit is drawn
// against its limit and marked at its request — the two numbers that decide
// whether it gets throttled or OOM-killed. A container with no limit has no
// true ceiling, so the column falls back to the largest value in this table:
// the bar then means "relative to the busiest row here", which is a comparison,
// not a promise. Both are honest; a bar with an invented ceiling would not be.

// Meter is one bar: a fill and an optional tick.
type Meter struct {
	Pct  *float64 `json:"pct"`
	Mark *float64 `json:"mark"`
}

type usageCell struct {
	Cells  []string
	Meters []*Meter
}

// UsageColumns are the extra columns spliced into a kind's own.
type UsageColumns struct {
	// Columns are the labels to splice in.
	Columns []string
	// InsertBefore is the column label to insert before; falls back to the end
	// of the row.
	InsertBefore string
	// ByKey holds cells and bars per object, keyed "ns/name".
	ByKey map[string]usageCell
}

// UsageKinds are the kinds whose rows carry usage bars.
var UsageKinds = map[string]bool{
	"pods":         true,
	"deployments":  true,
	"statefulsets": true,
	"daemonsets":   true,
	"replicasets":  true,
	"jobs":         true,
	"nodes":        true,
}

func objKey(o *model.Obj) string {
	return o.GetNamespace() + "/" + o.GetName()
}

func pctPtr(used, total float64) *float64 {
	if v, ok := model.Percent(used, total); ok {
		return &v
	}
	return nil
}

func meterFor(g model.Gauge, fallbackMax float64) *Meter {
	ceiling := g.Limits
	if ceiling <= 0 {
		ceiling = fallbackMax
	}
	m := &Meter{}
	if g.Used != nil {
		m.Pct = pctPtr(*g.Used, ceiling)
	}
	if g.Requests > 0 {
		m.Mark = pctPtr(g.Requests, ceiling)
	}
	return m
}

// ceilingOf is the largest value a column will have to draw, so bars share one
// scale.
func ceilingOf(gauges []model.Gauge) float64 {
	max := 0.0
	for _, g := range gauges {
		max = math.Max(max, g.Limits)
		if g.Used != nil {
			max = math.Max(max, *g.Used)
		}
	}
	if max > 0 {
		return max * 1.15
	}
	return 1
}

// usageColumnsFor builds the usage columns for a listing, or nil when the kind
// has none. Metrics are a bonus column, never a reason a table fails to load,
// so every failure below returns nil rather than an error.
func usageColumnsFor(cl *kube.Cluster, kindName string, items []model.Obj, namespace string) *UsageColumns {
	if !UsageKinds[kindName] || len(items) == 0 {
		return nil
	}
	if kindName == "nodes" {
		return nodeUsage(cl, items)
	}
	return podsideUsage(cl, kindName, items, namespace)
}

// podsideUsage covers pods, and anything whose usage is the sum of the pods it
// owns.
func podsideUsage(cl *kube.Cluster, kindName string, items []model.Obj, namespace string) *UsageColumns {
	top := cl.TopPods(namespace, "")

	var pods []model.Obj
	if kindName == "pods" {
		pods = items
	} else {
		var err error
		pods, err = cl.List("pods", kube.ListOptions{Namespace: namespace})
		if err != nil {
			pods = nil
		}
	}

	sample := func(pod *model.Obj) (float64, float64, bool) {
		m, ok := top[pod.GetNamespace()+"/"+pod.GetName()]
		if !ok {
			m, ok = top[pod.GetName()]
		}
		if !ok {
			return 0, 0, false
		}
		return model.ParseQuantity(m.CPU), model.ParseQuantity(m.Memory), true
	}

	type pair struct{ cpu, mem model.Gauge }
	gauges := map[string]pair{}
	order := make([]string, 0, len(items))

	for i := range items {
		o := &items[i]
		k := objKey(o)
		order = append(order, k)

		if kindName == "pods" {
			alloc := model.PodAllocation(o)
			cpu, mem := alloc.CPU, alloc.Mem
			if c, m, ok := sample(o); ok {
				cpu.Used, mem.Used = &c, &m
			}
			gauges[k] = pair{cpu, mem}
			continue
		}

		// A workload's pods are the ones its own selector matches, in its own
		// namespace. Walking ownerReferences would need the intermediate
		// ReplicaSets — one more list call for the same answer.
		selector := nestedMap(o, "spec", "selector")
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
			pc, pm := alloc.CPU, alloc.Mem
			if c, m, ok := sample(p); ok {
				pc.Used, pm.Used = &c, &m
			}
			cpu = model.AddGauge(cpu, pc)
			mem = model.AddGauge(mem, pm)
		}
		gauges[k] = pair{cpu, mem}
	}

	cpuAll := make([]model.Gauge, 0, len(gauges))
	memAll := make([]model.Gauge, 0, len(gauges))
	for _, g := range gauges {
		cpuAll = append(cpuAll, g.cpu)
		memAll = append(memAll, g.mem)
	}
	cpuCeiling, memCeiling := ceilingOf(cpuAll), ceilingOf(memAll)

	byKey := map[string]usageCell{}
	for _, k := range order {
		g := gauges[k]
		cpuText, memText := "—", "—"
		if g.cpu.Used != nil {
			cpuText = model.FormatCPU(*g.cpu.Used)
		}
		if g.mem.Used != nil {
			memText = model.FormatBytes(*g.mem.Used)
		}
		byKey[k] = usageCell{
			Cells:  []string{cpuText, memText},
			Meters: []*Meter{meterFor(g.cpu, cpuCeiling), meterFor(g.mem, memCeiling)},
		}
	}
	return &UsageColumns{
		Columns:      []string{"CPU USAGE", "MEMORY USAGE"},
		InsertBefore: "AGE",
		ByKey:        byKey,
	}
}

// nodeUsage covers nodes: usage against capacity, and how much of it is already
// promised.
func nodeUsage(cl *kube.Cluster, items []model.Obj) *UsageColumns {
	top := cl.TopNodes()
	pods, err := cl.List("pods", kube.ListOptions{})
	if err != nil {
		pods = nil
	}

	type req struct {
		cpu, mem float64
		pods     int
	}
	requested := map[string]req{}
	for i := range pods {
		p := &pods[i]
		node := nestedString(p, "spec", "nodeName")
		phase := nestedString(p, "status", "phase")
		if node == "" || phase == "Succeeded" || phase == "Failed" {
			continue
		}
		alloc := model.PodAllocation(p)
		prev := requested[node]
		requested[node] = req{
			cpu:  prev.cpu + alloc.CPU.Requests,
			mem:  prev.mem + alloc.Mem.Requests,
			pods: prev.pods + 1,
		}
	}

	byKey := map[string]usageCell{}
	for i := range items {
		node := &items[i]
		name := node.GetName()

		alloc := nestedStringMap(node, "status", "allocatable")
		if len(alloc) == 0 {
			alloc = nestedStringMap(node, "status", "capacity")
		}
		cpuCap := model.ParseQuantity(alloc["cpu"])
		memCap := model.ParseQuantity(alloc["memory"])
		podCap := model.ParseQuantity(alloc["pods"])

		r := requested[name]
		cpuAlloc := pctPtr(r.cpu, cpuCap)
		memAlloc := pctPtr(r.mem, memCap)

		var cpuUsed, memUsed *float64
		if live, ok := top[name]; ok {
			c := model.ParseQuantity(live.CPU)
			m := model.ParseQuantity(live.Memory)
			cpuUsed, memUsed = &c, &m
		}

		podCell := fmt.Sprintf("%d", r.pods)
		if podCap > 0 {
			podCell = fmt.Sprintf("%d/%s", r.pods, model.FormatCPU(podCap))
		}
		cpuCell, memCell := "—", "—"
		if cpuUsed != nil {
			cpuCell = model.FormatCPU(*cpuUsed)
		}
		if memUsed != nil {
			memCell = model.FormatBytes(*memUsed)
		}

		cells := []string{podCell, cpuCell, pctCell(cpuAlloc), memCell, pctCell(memAlloc)}

		meters := []*Meter{
			{Pct: pctPtr(float64(r.pods), podCap)},
			{Mark: cpuAlloc},
			{Pct: cpuAlloc},
			{Mark: memAlloc},
			{Pct: memAlloc},
		}
		if cpuUsed != nil {
			meters[1].Pct = pctPtr(*cpuUsed, cpuCap)
		}
		if memUsed != nil {
			meters[3].Pct = pctPtr(*memUsed, memCap)
		}

		byKey[objKey(node)] = usageCell{Cells: cells, Meters: meters}
	}

	return &UsageColumns{
		Columns:      []string{"PODS", "CPU USAGE", "CPU ALLOC", "MEMORY USAGE", "MEM ALLOC"},
		InsertBefore: "ROLES",
		ByKey:        byKey,
	}
}

func pctCell(p *float64) string {
	if p == nil {
		return "—"
	}
	return fmt.Sprintf("%d%%", int64(math.Round(*p)))
}

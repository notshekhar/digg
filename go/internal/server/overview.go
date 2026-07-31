package server

import (
	"fmt"
	"math"
	"strings"
	"sync"

	"github.com/notshekhar/digg/internal/kube"
	"github.com/notshekhar/digg/internal/model"
)

// The cluster overview. Port of src/web/overview.ts.
//
// The screen you open first and glance at, not one you read. It answers four
// questions and nothing else — are the nodes healthy, is there room, is
// anything crash-looping, and what has the cluster complained about lately.
//
// Metrics are optional everywhere. A cluster without metrics-server still gets
// capacity, requests, counts and events; the usage numbers simply come back
// null and the UI draws the gauge as "no metrics" rather than as 0%.

// ResourceStat is one resource line on a node card.
type ResourceStat struct {
	Used        *float64 `json:"used"`
	Requested   float64  `json:"requested"`
	Capacity    float64  `json:"capacity"`
	UsedPercent *float64 `json:"usedPercent"`
}

// Condition is one node condition.
type Condition struct {
	Type   string `json:"type"`
	Status string `json:"status"`
}

// NodeCard is one node's row on the overview.
type NodeCard struct {
	Name        string       `json:"name"`
	Ready       bool         `json:"ready"`
	Schedulable bool         `json:"schedulable"`
	Roles       string       `json:"roles"`
	Version     string       `json:"version"`
	OS          string       `json:"os"`
	Pods        int          `json:"pods"`
	PodCapacity int          `json:"podCapacity"`
	CPU         ResourceStat `json:"cpu"`
	Memory      ResourceStat `json:"memory"`
	Conditions  []Condition  `json:"conditions"`
	Age         string       `json:"age"`
}

// Totals is the cluster-wide roll-up.
type Totals struct {
	Nodes        int            `json:"nodes"`
	NodesReady   int            `json:"nodesReady"`
	Namespaces   int            `json:"namespaces"`
	Pods         int            `json:"pods"`
	PodPhases    map[string]int `json:"podPhases"`
	Containers   int            `json:"containers"`
	Restarts     int64          `json:"restarts"`
	CPUCapacity  float64        `json:"cpuCapacity"`
	CPURequested float64        `json:"cpuRequested"`
	CPUUsed      *float64       `json:"cpuUsed"`
	MemCapacity  float64        `json:"memCapacity"`
	MemRequested float64        `json:"memRequested"`
	MemUsed      *float64       `json:"memUsed"`
}

// WorkloadStat is one workload kind's readiness.
type WorkloadStat struct {
	Kind  string `json:"kind"`
	Total int    `json:"total"`
	Ready int    `json:"ready"`
}

// Problem is one pod that deserves the front page.
type Problem struct {
	Object    string `json:"object"`
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
}

// Warning is one recent Warning event.
type Warning struct {
	Object    string `json:"object"`
	Namespace string `json:"namespace"`
	Reason    string `json:"reason"`
	Message   string `json:"message"`
	LastSeen  string `json:"lastSeen"`
	Count     int32  `json:"count"`
}

// Overview is the whole page.
type Overview struct {
	Context          string              `json:"context"`
	Version          kube.ClusterVersion `json:"version"`
	MetricsAvailable bool                `json:"metricsAvailable"`
	Nodes            []NodeCard          `json:"nodes"`
	Totals           Totals              `json:"totals"`
	Workloads        []WorkloadStat      `json:"workloads"`
	Problems         []Problem           `json:"problems"`
	Warnings         []Warning           `json:"warnings"`
}

const maxProblems = 50

func nodeIsReady(n *model.Obj) bool {
	for _, raw := range nestedSlice(n, "status", "conditions") {
		c, _ := raw.(map[string]any)
		if c["type"] == "Ready" && c["status"] == "True" {
			return true
		}
	}
	return false
}

func podRequests(pod *model.Obj) (cpu, mem float64) {
	for _, raw := range nestedSlice(pod, "spec", "containers") {
		c, _ := raw.(map[string]any)
		res, _ := c["resources"].(map[string]any)
		req, _ := res["requests"].(map[string]any)
		cpu += model.ParseQuantity(asString(req["cpu"]))
		mem += model.ParseQuantity(asString(req["memory"]))
	}
	return cpu, mem
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

// overviewAge is a coarser age than the tables use: the overview shows days,
// hours or minutes, never seconds.
func overviewAge(o *model.Obj) string {
	ts := o.GetCreationTimestamp()
	if ts.IsZero() {
		return ""
	}
	d := model.Now().Sub(ts.Time)
	if days := d.Hours() / 24; days >= 1 {
		return fmt.Sprintf("%dd", int64(days))
	}
	if hours := d.Hours(); hours >= 1 {
		return fmt.Sprintf("%dh", int64(hours))
	}
	return fmt.Sprintf("%dm", int64(math.Max(1, math.Floor(d.Minutes()))))
}

// podProblem reports pods that are neither Running-and-ready nor Succeeded.
func podProblem(pod *model.Obj) (reason, message string, ok bool) {
	phase := nestedString(pod, "status", "phase")
	if phase == "Succeeded" {
		return "", "", false
	}

	for _, raw := range nestedSlice(pod, "status", "containerStatuses") {
		cs, _ := raw.(map[string]any)
		state, _ := cs["state"].(map[string]any)
		if waiting, isMap := state["waiting"].(map[string]any); isMap {
			r := asString(waiting["reason"])
			if r != "" && r != "ContainerCreating" && r != "PodInitializing" {
				return r, clip(collapse(asString(waiting["message"])), 300), true
			}
		}
		if term, isMap := state["terminated"].(map[string]any); isMap {
			r := asString(term["reason"])
			if r != "" && r != "Completed" {
				return r, "", true
			}
		}
	}

	if phase == "Failed" {
		return "Failed", "", true
	}
	if phase == "Pending" {
		for _, raw := range nestedSlice(pod, "status", "conditions") {
			c, _ := raw.(map[string]any)
			if c["type"] == "PodScheduled" && c["status"] == "False" {
				r := asString(c["reason"])
				if r == "" {
					r = "Pending"
				}
				return r, clip(asString(c["message"]), 300), true
			}
		}
		return "Pending", "", true
	}
	return "", "", false
}

func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// BuildOverview gathers everything the overview needs, concurrently. Metrics
// and events are allowed to fail; a broken metrics-server must not blank the
// page.
func BuildOverview(cl *kube.Cluster, clientVersion string) Overview {
	var (
		wg                                    sync.WaitGroup
		nodes, pods, namespaces               []model.Obj
		deployments, statefulsets, daemonsets []model.Obj
		nodeMetrics                           map[string]kube.NodeMetrics
		podMetrics                            map[string]kube.PodMetrics
		events                                []kube.ObjectEvent
		version                               kube.ClusterVersion
	)

	list := func(dst *[]model.Obj, kind string, opts kube.ListOptions) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if out, err := cl.List(kind, opts); err == nil {
				*dst = out
			}
		}()
	}

	list(&nodes, "nodes", kube.ListOptions{ClusterScoped: true})
	list(&pods, "pods", kube.ListOptions{})
	list(&namespaces, "namespaces", kube.ListOptions{ClusterScoped: true})
	list(&deployments, "deployments", kube.ListOptions{})
	list(&statefulsets, "statefulsets", kube.ListOptions{})
	list(&daemonsets, "daemonsets", kube.ListOptions{})

	wg.Add(4)
	go func() { defer wg.Done(); version = cl.Version(clientVersion) }()
	go func() { defer wg.Done(); nodeMetrics = cl.TopNodes() }()
	go func() { defer wg.Done(); podMetrics = cl.TopPods("", "") }()
	go func() {
		defer wg.Done()
		events, _ = cl.ListEvents("", 200)
	}()
	wg.Wait()

	podsByNode := map[string][]*model.Obj{}
	for i := range pods {
		node := nestedString(&pods[i], "spec", "nodeName")
		podsByNode[node] = append(podsByNode[node], &pods[i])
	}

	metricsAvailable := len(nodeMetrics) > 0 || len(podMetrics) > 0

	nodeCards := make([]NodeCard, 0, len(nodes))
	for i := range nodes {
		n := &nodes[i]
		name := n.GetName()
		onNode := podsByNode[name]

		var reqCPU, reqMem float64
		for _, p := range onNode {
			c, m := podRequests(p)
			reqCPU += c
			reqMem += m
		}

		alloc := nestedStringMap(n, "status", "allocatable")
		capacity := nestedStringMap(n, "status", "capacity")
		pick := func(key string) string {
			if v, ok := alloc[key]; ok && v != "" {
				return v
			}
			return capacity[key]
		}
		cpuCapacity := model.ParseQuantity(pick("cpu"))
		memCapacity := model.ParseQuantity(pick("memory"))

		card := NodeCard{
			Name:        name,
			Ready:       nodeIsReady(n),
			Schedulable: !nestedBool(n, "spec", "unschedulable"),
			Roles:       model.NodeRoles(n),
			Version:     nestedString(n, "status", "nodeInfo", "kubeletVersion"),
			OS:          nestedString(n, "status", "nodeInfo", "osImage"),
			Pods:        len(onNode),
			PodCapacity: int(model.ParseQuantity(pick("pods"))),
			CPU:         ResourceStat{Requested: reqCPU, Capacity: cpuCapacity},
			Memory:      ResourceStat{Requested: reqMem, Capacity: memCapacity},
			Conditions:  []Condition{},
			Age:         overviewAge(n),
		}

		if m, ok := nodeMetrics[name]; ok {
			cpu := model.ParseQuantity(m.CPU)
			mem := model.ParseQuantity(m.Memory)
			card.CPU.Used, card.Memory.Used = &cpu, &mem
			card.CPU.UsedPercent = pctPtr(cpu, cpuCapacity)
			card.Memory.UsedPercent = pctPtr(mem, memCapacity)
		}

		for _, raw := range nestedSlice(n, "status", "conditions") {
			c, _ := raw.(map[string]any)
			t, s := asString(c["type"]), asString(c["status"])
			if t != "" && s != "" {
				card.Conditions = append(card.Conditions, Condition{Type: t, Status: s})
			}
		}
		nodeCards = append(nodeCards, card)
	}

	podPhases := map[string]int{}
	containers := 0
	var restarts int64
	var totalReqCPU, totalReqMem float64
	problems := []Problem{}

	for i := range pods {
		p := &pods[i]
		phase := nestedString(p, "status", "phase")
		if phase == "" {
			phase = "Unknown"
		}
		podPhases[phase]++

		cs := nestedSlice(p, "status", "containerStatuses")
		containers += len(cs)
		for _, raw := range cs {
			c, _ := raw.(map[string]any)
			if v, ok := c["restartCount"]; ok {
				restarts += int64(toFloat64(v))
			}
		}

		c, m := podRequests(p)
		totalReqCPU += c
		totalReqMem += m

		if len(problems) < maxProblems {
			if reason, message, ok := podProblem(p); ok {
				problems = append(problems, Problem{
					Object: p.GetName(), Namespace: p.GetNamespace(), Kind: "pods",
					Reason: reason, Message: message,
				})
			}
		}
	}

	// A total is only knowable when every node reported; one missing node makes
	// the sum a guess, and the UI would draw a guess as fact.
	var cpuUsedTotal, memUsedTotal *float64
	cpuSum, memSum := 0.0, 0.0
	cpuKnown, memKnown := true, true
	var cpuCapacityTotal, memCapacityTotal float64
	readyNodes := 0
	for _, n := range nodeCards {
		cpuCapacityTotal += n.CPU.Capacity
		memCapacityTotal += n.Memory.Capacity
		if n.Ready {
			readyNodes++
		}
		if n.CPU.Used == nil {
			cpuKnown = false
		} else {
			cpuSum += *n.CPU.Used
		}
		if n.Memory.Used == nil {
			memKnown = false
		} else {
			memSum += *n.Memory.Used
		}
	}
	if cpuKnown {
		cpuUsedTotal = &cpuSum
	}
	if memKnown {
		memUsedTotal = &memSum
	}

	replicaReady := func(o *model.Obj) bool {
		return nestedInt(o, "status", "readyReplicas") >= nestedInt(o, "spec", "replicas")
	}
	dsReady := func(o *model.Obj) bool {
		return nestedInt(o, "status", "numberReady") >= nestedInt(o, "status", "desiredNumberScheduled")
	}
	countReady := func(items []model.Obj, pred func(*model.Obj) bool) int {
		n := 0
		for i := range items {
			if pred(&items[i]) {
				n++
			}
		}
		return n
	}

	warnings := []Warning{}
	for i := range events {
		if len(warnings) >= maxProblems {
			break
		}
		e := &events[i]
		if e.Type != "Warning" {
			continue
		}
		warnings = append(warnings, Warning{
			Object: e.Object, Namespace: e.Namespace, Reason: e.Reason,
			Message: clip(e.Message, 300), LastSeen: e.LastSeen, Count: e.Count,
		})
	}

	return Overview{
		Context:          cl.Context,
		Version:          version,
		MetricsAvailable: metricsAvailable,
		Nodes:            nodeCards,
		Totals: Totals{
			Nodes: len(nodes), NodesReady: readyNodes,
			Namespaces: len(namespaces), Pods: len(pods),
			PodPhases: podPhases, Containers: containers, Restarts: restarts,
			CPUCapacity: cpuCapacityTotal, CPURequested: totalReqCPU, CPUUsed: cpuUsedTotal,
			MemCapacity: memCapacityTotal, MemRequested: totalReqMem, MemUsed: memUsedTotal,
		},
		Workloads: []WorkloadStat{
			{Kind: "deployments", Total: len(deployments), Ready: countReady(deployments, replicaReady)},
			{Kind: "statefulsets", Total: len(statefulsets), Ready: countReady(statefulsets, replicaReady)},
			{Kind: "daemonsets", Total: len(daemonsets), Ready: countReady(daemonsets, dsReady)},
		},
		Problems: problems,
		Warnings: warnings,
	}
}

func toFloat64(v any) float64 {
	switch n := v.(type) {
	case int64:
		return float64(n)
	case float64:
		return n
	}
	return 0
}

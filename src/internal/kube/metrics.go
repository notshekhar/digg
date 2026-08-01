package kube

import (
	"context"
	"fmt"
	"math"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	metricsv1beta1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"

	"github.com/notshekhar/digg/src/internal/model"
)

// Port of the metrics half of src/kubectl.ts.
//
// The Bun build had two routes to every number: metrics.k8s.io through the
// proxy when there was one, and scraping `kubectl top`'s columns when there was
// not. Only the first survives — client-go always has the API — which also means
// the values stay unrounded. `kubectl top` prints whole Mi; the detail page
// shows 1.8Mi where kubectl said 1Mi, and every consumer runs them through
// ParseQuantity, which reads both.
//
// A cluster without metrics-server gets an empty map, never an error: metrics
// are a bonus column, never a precondition for browsing.

// PodMetrics is one pod's or container's usage, in the string form the UI parses.
type PodMetrics struct {
	CPU    string `json:"cpu"`
	Memory string `json:"memory"`
}

// NodeMetrics adds the percentages, which need a denominator the metrics API
// does not carry.
type NodeMetrics struct {
	CPU           string   `json:"cpu"`
	CPUPercent    *float64 `json:"cpuPercent"`
	Memory        string   `json:"memory"`
	MemoryPercent *float64 `json:"memoryPercent"`
}

// TopPods is the port of topPods(), keyed both "ns/name" and "name".
//
// Both keys go in the map: callers that know the namespace get an exact hit,
// and the older name-only lookups still work. They collide only for same-named
// pods in different namespaces, which is why the qualified lookup wins.
func (c *Cluster) TopPods(namespace, labelSelector string) map[string]PodMetrics {
	return c.metricsCache.do("pods/"+namespace+"/"+labelSelector, func() any {
		return c.topPods(namespace, labelSelector)
	}).(map[string]PodMetrics)
}

func (c *Cluster) topPods(namespace, labelSelector string) map[string]PodMetrics {
	out := map[string]PodMetrics{}
	list, err := c.Metrics.MetricsV1beta1().PodMetricses(namespace).
		List(context.Background(), metav1.ListOptions{LabelSelector: labelSelector})
	if err != nil {
		return out
	}
	for _, pm := range list.Items {
		// A pod's usage is the sum of its containers'; the API only reports the
		// parts.
		var cpu, mem float64
		for _, ct := range pm.Containers {
			cpu += model.ParseQuantity(ct.Usage.Cpu().String())
			mem += model.ParseQuantity(ct.Usage.Memory().String())
		}
		// Back to strings in the units the callers already parse: cores and bytes.
		m := PodMetrics{CPU: num(cpu), Memory: num(mem)}
		ns := pm.Namespace
		if ns == "" {
			ns = namespace
		}
		if pm.Name == "" {
			continue
		}
		if ns != "" {
			out[ns+"/"+pm.Name] = m
		}
		out[pm.Name] = m
	}
	return out
}

// TopPodContainers is the port of topPodContainers(), keyed "pod/container" and
// "ns/pod/container".
//
// A pod-level number cannot answer "which of these three containers is eating
// the node", which is the question a container card exists to answer.
func (c *Cluster) TopPodContainers(namespace, labelSelector, pod string) map[string]PodMetrics {
	return c.metricsCache.do("containers/"+namespace+"/"+labelSelector+"/"+pod, func() any {
		return c.topPodContainers(namespace, labelSelector, pod)
	}).(map[string]PodMetrics)
}

func (c *Cluster) topPodContainers(namespace, labelSelector, pod string) map[string]PodMetrics {
	out := map[string]PodMetrics{}
	api := c.Metrics.MetricsV1beta1().PodMetricses(namespace)

	items := []podMetricsItem{}
	if pod != "" {
		pm, err := api.Get(context.Background(), pod, metav1.GetOptions{})
		if err != nil {
			return out
		}
		items = append(items, podMetricsItem{pm.Namespace, pm.Name, containerUsage(pm.Containers)})
	} else {
		list, err := api.List(context.Background(), metav1.ListOptions{LabelSelector: labelSelector})
		if err != nil {
			return out
		}
		for i := range list.Items {
			items = append(items, podMetricsItem{
				list.Items[i].Namespace, list.Items[i].Name, containerUsage(list.Items[i].Containers),
			})
		}
	}

	for _, it := range items {
		ns := it.namespace
		if ns == "" {
			ns = namespace
		}
		for name, m := range it.containers {
			if ns != "" {
				out[ns+"/"+it.name+"/"+name] = m
			}
			out[it.name+"/"+name] = m
		}
	}
	return out
}

type podMetricsItem struct {
	namespace  string
	name       string
	containers map[string]PodMetrics
}

func containerUsage(cs []metricsv1beta1.ContainerMetrics) map[string]PodMetrics {
	out := map[string]PodMetrics{}
	for _, ct := range cs {
		if ct.Name == "" {
			continue
		}
		out[ct.Name] = PodMetrics{
			CPU:    ct.Usage.Cpu().String(),
			Memory: ct.Usage.Memory().String(),
		}
	}
	return out
}

// TopNodes is the port of topNodes(). Two API reads and a division: usage from
// metrics.k8s.io, the denominator from each node's ALLOCATABLE (what the
// scheduler can hand out), which is what kubectl divides by too.
func (c *Cluster) TopNodes() map[string]NodeMetrics {
	return c.metricsCache.do("nodes", func() any { return c.topNodes() }).(map[string]NodeMetrics)
}

func (c *Cluster) topNodes() map[string]NodeMetrics {
	out := map[string]NodeMetrics{}
	usage, err := c.Metrics.MetricsV1beta1().NodeMetricses().List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return out
	}
	allocatable := map[string]struct{ cpu, memory float64 }{}
	if nodes, err := c.Typed.CoreV1().Nodes().List(context.Background(), metav1.ListOptions{}); err == nil {
		for i := range nodes.Items {
			n := &nodes.Items[i]
			allocatable[n.Name] = struct{ cpu, memory float64 }{
				cpu:    model.ParseQuantity(n.Status.Allocatable.Cpu().String()),
				memory: model.ParseQuantity(n.Status.Allocatable.Memory().String()),
			}
		}
	}
	for i := range usage.Items {
		item := &usage.Items[i]
		if item.Name == "" {
			continue
		}
		cpu := model.ParseQuantity(item.Usage.Cpu().String())
		mem := model.ParseQuantity(item.Usage.Memory().String())
		m := NodeMetrics{CPU: num(cpu), Memory: num(mem)}
		if cap, ok := allocatable[item.Name]; ok {
			if cap.cpu > 0 {
				p := math.Round((cpu / cap.cpu) * 100)
				m.CPUPercent = &p
			}
			if cap.memory > 0 {
				p := math.Round((mem / cap.memory) * 100)
				m.MemoryPercent = &p
			}
		}
		out[item.Name] = m
	}
	return out
}

// MetricsAvailable reports whether metrics-server answered at all, so the UI can
// draw a hatched bar rather than a confident 0%.
//
// Whether a cluster HAS metrics-server does not change minute to minute, and
// this is asked on every overview build, so the answer is held longer than the
// numbers are.
func (c *Cluster) MetricsAvailable() bool {
	return c.metricsCache.do("available", func() any {
		_, err := c.Metrics.MetricsV1beta1().NodeMetricses().List(
			context.Background(), metav1.ListOptions{Limit: 1})
		return err == nil
	}).(bool)
}

// metricsTTL is how long a sample is reused. metrics-server runs with
// --metric-resolution=60s by default and its PodMetrics carry `window: 1m`, so
// anything under a minute is returning the same numbers; 10s keeps a manual
// refresh feeling live while collapsing the burst of calls one navigation makes.
const metricsTTL = 10 * time.Second

func num(f float64) string {
	return fmt.Sprintf("%v", f)
}

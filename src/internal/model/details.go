package model

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Per-kind detail "models": the summary key/values and the one navigable
// section a resource's page shows. Port of src/details.ts.
//
// The server is the generic executor — it resolves the section against the
// cluster and ships it to the browser. This file holds the per-kind knowledge,
// so every kind gets a real page rather than a YAML dump.

// Section is a declarative description of a detail page's main section.
type Section struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Selector string `json:"selector,omitempty"`
	Node     string `json:"node,omitempty"`
	PVC      string `json:"pvc,omitempty"`
	Decode   bool   `json:"decode,omitempty"`
}

// Row is one key/value line in a summary.
//
// It travels as a two-element ARRAY, not an object: the client destructures it
// (`summary.map(([k, v]) => …)`), so `{"key":…,"value":…}` would break every
// detail page. The TS type is `[string, string][]` and this has to match it.
type Row struct {
	Key   string
	Value string
}

// MarshalJSON emits ["key","value"].
func (r Row) MarshalJSON() ([]byte, error) {
	return json.Marshal([2]string{r.Key, r.Value})
}

// UnmarshalJSON reads ["key","value"] back, so tests can round-trip a payload.
func (r *Row) UnmarshalJSON(b []byte) error {
	var pair [2]string
	if err := json.Unmarshal(b, &pair); err != nil {
		return err
	}
	r.Key, r.Value = pair[0], pair[1]
	return nil
}

// DetailModel is a page's summary plus its section.
type DetailModel struct {
	Summary []Row    `json:"summary"`
	Section *Section `json:"section,omitempty"`
}

// PodSectionColumns are the columns of every pod list embedded in a detail page.
var PodSectionColumns = []string{"NAME", "READY", "STATUS", "RESTARTS", "CPU", "MEM", "NODE", "AGE"}

// dash renders an empty value as an em dash, which is what a detail page shows
// for "this field is not set" (tables use "<none>", pages use "—").
func dash(v string) string {
	if v == "" {
		return "—"
	}
	return v
}

func rows(pairs ...[2]string) []Row {
	out := make([]Row, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, Row{Key: p[0], Value: p[1]})
	}
	return out
}

// DetailModelFor builds the detail model for a resource. Pod metrics are
// threaded in so a pod's summary can show live CPU/Mem; they are rebuilt each
// refresh.
func DetailModelFor(kindName string, o *Obj, isWorkload bool, top map[string]Usage) DetailModel {
	if isWorkload {
		summary := make([]Row, 0, 8)
		for _, p := range WorkloadSummary(o) {
			summary = append(summary, Row{Key: p[0], Value: p[1]})
		}
		m := DetailModel{Summary: summary}
		if sel := WorkloadSelector(o); sel != "" {
			m.Section = &Section{Type: "workloadPods", Title: "Pods", Selector: sel}
		}
		return m
	}

	switch kindName {
	case "pods":
		return DetailModel{
			Summary: podSummary(o, top),
			Section: &Section{Type: "podContainers", Title: "Containers"},
		}
	case "services":
		return serviceModel(o)
	case "nodes":
		return nodeModel(o)
	case "configmaps":
		return DetailModel{
			Summary: rows(
				[2]string{"Namespace", dash(o.GetNamespace())},
				[2]string{"Keys", strconv.Itoa(len(stringMap(o, "data")))},
				[2]string{"Age", Age(o)}),
			Section: &Section{Type: "dataKeys", Title: "Data"},
		}
	case "secrets":
		return DetailModel{
			Summary: rows(
				[2]string{"Namespace", dash(o.GetNamespace())},
				[2]string{"Type", dash(str(o, "type"))},
				[2]string{"Keys", strconv.Itoa(len(stringMap(o, "data")))},
				[2]string{"Age", Age(o)}),
			Section: &Section{Type: "dataKeys", Title: "Data", Decode: true},
		}
	case "ingresses":
		return ingressModel(o)
	case "persistentvolumeclaims":
		return pvcModel(o)
	case "cronjobs":
		return cronjobModel(o)
	case "namespaces":
		return DetailModel{Summary: namespaceSummary(o)}
	}
	return DetailModel{Summary: genericSummary(o)}
}

func podSummary(o *Obj, top map[string]Usage) []Row {
	node := dash(str(o, "spec", "nodeName"))
	usage := "—"
	if m, ok := lookupUsage(top, o.GetName(), o.GetNamespace()); ok {
		usage = fmt.Sprintf("%s / %s", m.CPU, m.Memory)
	}
	return rows(
		[2]string{"Namespace", dash(o.GetNamespace())},
		[2]string{"Node", node},
		[2]string{"Pod IP", dash(str(o, "status", "podIP"))},
		[2]string{"Status", dash(str(o, "status", "phase"))},
		[2]string{"QoS", dash(str(o, "status", "qosClass"))},
		[2]string{"CPU / Mem", usage},
		// Declared container ports. The port-forward dialog reads this row so
		// it can offer the right ports instead of guessing 80.
		[2]string{"Ports", dash(podPorts(o))},
		[2]string{"Age", Age(o)},
	)
}

func lookupUsage(top map[string]Usage, name, ns string) (Usage, bool) {
	if ns != "" {
		if m, ok := top[ns+"/"+name]; ok {
			return m, true
		}
	}
	m, ok := top[name]
	return m, ok
}

// podPorts renders "http:8080/TCP, 9090/TCP" across every container in the pod.
func podPorts(o *Obj) string {
	out := []string{}
	for _, craw := range slice(o, "spec", "containers") {
		for _, praw := range mslice(asMap(craw), "ports") {
			p := asMap(praw)
			port := mstr(p, "containerPort")
			if port == "" || port == "0" {
				continue
			}
			proto := mstr(p, "protocol")
			if proto == "" {
				proto = "TCP"
			}
			prefix := ""
			if n := mstr(p, "name"); n != "" {
				prefix = n + ":"
			}
			out = append(out, prefix+port+"/"+proto)
		}
	}
	return strings.Join(out, ", ")
}

func serviceModel(o *Obj) DetailModel {
	selector := sortedPairs(stringMap(o, "spec", "selector"), "=", ",")

	portParts := []string{}
	for _, raw := range slice(o, "spec", "ports") {
		p := asMap(raw)
		port := mstr(p, "port")
		target := mstr(p, "targetPort")
		if target == "" {
			target = port
		}
		proto := mstr(p, "protocol")
		if proto == "" {
			proto = "TCP"
		}
		prefix := ""
		if n := mstr(p, "name"); n != "" {
			prefix = n + ":"
		}
		portParts = append(portParts, fmt.Sprintf("%s%s→%s/%s", prefix, port, target, proto))
	}

	m := DetailModel{Summary: rows(
		[2]string{"Namespace", dash(o.GetNamespace())},
		[2]string{"Type", dash(str(o, "spec", "type"))},
		[2]string{"Cluster IP", dash(str(o, "spec", "clusterIP"))},
		[2]string{"Ports", dash(strings.Join(portParts, ", "))},
		[2]string{"Selector", dash(selector)},
		[2]string{"Age", Age(o)},
	)}
	if selector != "" {
		m.Section = &Section{Type: "endpointPods", Title: "Endpoints (pods)", Selector: selector}
	}
	return m
}

func nodeModel(o *Obj) DetailModel {
	capacity := "—"
	if cap := mapOf(o, "status", "capacity"); cap != nil {
		q := func(k string) string {
			if v := mstr(cap, k); v != "" {
				return v
			}
			return "?"
		}
		capacity = fmt.Sprintf("%s cpu · %s mem · %s pods", q("cpu"), q("memory"), q("pods"))
	}
	return DetailModel{
		Summary: rows(
			[2]string{"Roles", NodeRoles(o)},
			[2]string{"Version", dash(str(o, "status", "nodeInfo", "kubeletVersion"))},
			[2]string{"OS", dash(str(o, "status", "nodeInfo", "osImage"))},
			[2]string{"Kernel", dash(str(o, "status", "nodeInfo", "kernelVersion"))},
			[2]string{"Runtime", dash(str(o, "status", "nodeInfo", "containerRuntimeVersion"))},
			[2]string{"Arch", dash(str(o, "status", "nodeInfo", "architecture"))},
			[2]string{"Internal IP", dash(nodeInternalIP(o))},
			[2]string{"Capacity", capacity},
			[2]string{"Age", Age(o)},
		),
		Section: &Section{Type: "nodePods", Title: "Pods on node", Node: o.GetName()},
	}
}

func ingressModel(o *Obj) DetailModel {
	address := ingressAddress(o)
	if address != "" {
		address = strings.ReplaceAll(address, ",", ", ")
	}

	tlsParts := []string{}
	for _, raw := range slice(o, "spec", "tls") {
		t := asMap(raw)
		secret := mstr(t, "secretName")
		if secret == "" {
			secret = "?"
		}
		hosts := []string{}
		for _, h := range mslice(t, "hosts") {
			hosts = append(hosts, valueString(h))
		}
		if len(hosts) == 0 {
			hosts = []string{"*"}
		}
		tlsParts = append(tlsParts, secret+" → "+strings.Join(hosts, ", "))
	}
	tls := strings.Join(tlsParts, "; ")
	if tls == "" {
		tls = "none"
	}

	fallback := "—"
	if svc := mapOf(o, "spec", "defaultBackend", "service"); svc != nil {
		port := ""
		if pm := mmap(svc, "port"); pm != nil {
			port = mstr(pm, "number")
			if port == "" {
				port = mstr(pm, "name")
			}
		}
		fallback = mstr(svc, "name") + ":" + port
	}

	// An Ingress with no address is an Ingress nothing is serving — usually a
	// missing controller, and the first thing to check.
	if address == "" {
		address = "<pending>"
	}

	return DetailModel{
		Summary: rows(
			[2]string{"Namespace", dash(o.GetNamespace())},
			[2]string{"Class", dash(str(o, "spec", "ingressClassName"))},
			[2]string{"Address", address},
			[2]string{"TLS", tls},
			[2]string{"Default backend", fallback},
			[2]string{"Rules", strconv.Itoa(len(slice(o, "spec", "rules")))},
			[2]string{"Age", Age(o)},
		),
		Section: &Section{Type: "ingressRules", Title: "Routing"},
	}
}

func pvcModel(o *Obj) DetailModel {
	return DetailModel{
		Summary: rows(
			[2]string{"Namespace", dash(o.GetNamespace())},
			[2]string{"Status", dash(str(o, "status", "phase"))},
			[2]string{"Volume", dash(str(o, "spec", "volumeName"))},
			[2]string{"Capacity", dash(str(o, "status", "capacity", "storage"))},
			[2]string{"Access Modes", dash(PVCAccessModes(o))},
			[2]string{"StorageClass", dash(str(o, "spec", "storageClassName"))},
			[2]string{"Age", Age(o)},
		),
		Section: &Section{Type: "pvcConsumers", Title: "Mounted by (pods)", PVC: o.GetName()},
	}
}

func cronjobModel(o *Obj) DetailModel {
	last := "—"
	if t := str(o, "status", "lastScheduleTime"); t != "" {
		last = AgeFrom(t)
	}
	return DetailModel{
		Summary: rows(
			[2]string{"Namespace", dash(o.GetNamespace())},
			[2]string{"Schedule", dash(str(o, "spec", "schedule"))},
			[2]string{"Suspend", strconv.FormatBool(boolOf(o, "spec", "suspend"))},
			[2]string{"Active", strconv.Itoa(len(slice(o, "status", "active")))},
			[2]string{"Last Schedule", last},
			[2]string{"Age", Age(o)},
		),
		Section: &Section{Type: "cronjobJobs", Title: "Jobs"},
	}
}

func namespaceSummary(o *Obj) []Row {
	return rows(
		[2]string{"Status", dash(str(o, "status", "phase"))},
		[2]string{"Labels", dash(sortedPairs(o.GetLabels(), "=", ", "))},
		[2]string{"Age", Age(o)},
	)
}

func genericSummary(o *Obj) []Row {
	out := []Row{}
	if ns := o.GetNamespace(); ns != "" {
		out = append(out, Row{Key: "Namespace", Value: ns})
	}
	if v := o.GetAPIVersion(); v != "" {
		out = append(out, Row{Key: "API Version", Value: v})
	}
	if p := str(o, "status", "phase"); p != "" {
		out = append(out, Row{Key: "Status", Value: p})
	}
	return append(out, Row{Key: "Age", Value: Age(o)})
}

// sortedPairs renders a label map deterministically. JS object order is
// insertion order and effectively stable for a decoded object; Go map order is
// randomised, so this has to sort or the summary would flicker between reloads.
func sortedPairs(m map[string]string, sep, join string) string {
	if len(m) == 0 {
		return ""
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+sep+m[k])
	}
	return strings.Join(parts, join)
}

// PodMountsPVC reports whether this pod mounts the named PVC.
func PodMountsPVC(pod *Obj, pvc string) bool {
	for _, raw := range slice(pod, "spec", "volumes") {
		if mstr(mmap(asMap(raw), "persistentVolumeClaim"), "claimName") == pvc {
			return true
		}
	}
	return false
}

// JobOwnedByCronJob reports whether this job is owned by the named CronJob.
func JobOwnedByCronJob(job *Obj, name string) bool {
	for _, ref := range job.GetOwnerReferences() {
		if ref.Kind == "CronJob" && ref.Name == name {
			return true
		}
	}
	return false
}

// LogSpec says which pods a page can stream logs from.
type LogSpec struct {
	Namespace string
	PodName   string
	Selector  string
	Title     string
}

// LogSpecFor is the port of logSpecFor(): a pod's own logs, or all pods of a
// workload via its label selector. ok is false when logs do not apply.
func LogSpecFor(kindName string, o *Obj) (LogSpec, bool) {
	name := o.GetName()
	if name == "" {
		return LogSpec{}, false
	}
	ns := o.GetNamespace()
	if kindName == "pods" {
		return LogSpec{Namespace: ns, PodName: name, Title: name + " · logs (live)"}, true
	}
	if !WorkloadKinds[kindName] {
		return LogSpec{}, false
	}
	sel := WorkloadSelector(o)
	if sel == "" {
		return LogSpec{}, false
	}
	return LogSpec{Namespace: ns, Selector: sel, Title: name + " · logs (all pods)"}, true
}

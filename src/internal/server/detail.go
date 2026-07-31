package server

import (
	"encoding/base64"
	"fmt"
	"sort"
	"strings"

	"github.com/notshekhar/digg/src/internal/kube"
	"github.com/notshekhar/digg/src/internal/model"
)

// Fetching half of the rich detail page. Port of src/web/detail.ts.
//
// Gather what detailview.go needs (the pods a workload owns, per-container
// metrics, the ReplicaSets behind a rollout) and hand it to the pure builders.

// SectionPayload is the one navigable table a detail page shows.
type SectionPayload struct {
	Title    string     `json:"title"`
	Columns  []string   `json:"columns"`
	Rows     [][]string `json:"rows"`
	Tones    []int      `json:"tones,omitempty"`
	Drill    []DrillRef `json:"drill,omitempty"`
	DataKeys *DataKeys  `json:"dataKeys,omitempty"`
}

// DrillRef is where a row navigates to when clicked.
type DrillRef struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
	NS   string `json:"ns,omitempty"`
}

// DataKeys carries the ConfigMap/Secret key list for the data editor.
type DataKeys struct {
	Keys   []string `json:"keys"`
	Decode bool     `json:"decode"`
}

// RevisionRow is one entry of a rollout history.
type RevisionRow struct {
	Revision int    `json:"revision"`
	Name     string `json:"name"`
	// Kind is what to open when the row is clicked.
	Kind     string `json:"kind"`
	NS       string `json:"ns,omitempty"`
	Replicas int64  `json:"replicas"`
	Ready    int64  `json:"ready"`
	Images   string `json:"images"`
	Age      string `json:"age"`
	TS       int64  `json:"ts"`
	Current  bool   `json:"current"`
}

// DetailPayload is everything a detail page renders, in one object.
//
// The HTTP route and the WebSocket both build this, so a pushed update and a
// refreshed one can never disagree about what a page contains.
type DetailPayload struct {
	Kind    KindMeta          `json:"kind"`
	Name    string            `json:"name"`
	NS      string            `json:"ns,omitempty"`
	Summary []model.Row       `json:"summary"`
	Section *SectionPayload   `json:"section"`
	View    *model.DetailView `json:"view"`
	Events  []kube.Event      `json:"events"`
	CanLogs bool              `json:"canLogs"`
}

// KindMeta is the kind descriptor the client renders against.
type KindMeta struct {
	Name          string   `json:"name"`
	Title         string   `json:"title"`
	Kind          string   `json:"kind"`
	ClusterScoped bool     `json:"clusterScoped"`
	Generic       bool     `json:"generic"`
	Columns       []string `json:"columns"`
}

func kindMeta(k *model.KindDef) KindMeta {
	return KindMeta{
		Name: k.Name, Title: k.Title, Kind: k.Kind,
		ClusterScoped: k.ClusterScoped, Generic: k.Generic, Columns: k.Columns,
	}
}

// buildDetailView builds the rich page for the kinds that have one.
func buildDetailView(cl *kube.Cluster, kindName string, o *model.Obj) *model.DetailView {
	if !model.RichKinds[kindName] {
		return nil
	}
	ns, name := o.GetNamespace(), o.GetName()

	switch {
	case kindName == "pods":
		containers := cl.TopPodContainers(ns, "", name)
		metrics := model.NoMetrics
		if len(containers) > 0 {
			metrics = model.MetricsFromContainers(toUsage(containers))
		}
		v := model.PodView(o, metrics)
		return &v

	case kindName == "nodes":
		pods, err := cl.List("pods", kube.ListOptions{FieldSelector: "spec.nodeName=" + name})
		if err != nil {
			pods = nil
		}
		v := model.NodeView(o, pods, model.MetricsView(toUsage(cl.TopPods("", "")), nil))
		return &v

	case model.WorkloadKinds[kindName]:
		selector := model.WorkloadSelector(o)
		var pods []model.Obj
		metrics := model.NoMetrics
		if selector != "" {
			if list, err := cl.List("pods", kube.ListOptions{
				Namespace: ns, LabelSelector: selector,
			}); err == nil {
				pods = list
			}
			if containers := cl.TopPodContainers(ns, selector, ""); len(containers) > 0 {
				metrics = model.MetricsFromContainers(toUsage(containers))
			}
		}
		sort.Slice(pods, func(i, j int) bool { return pods[i].GetName() < pods[j].GetName() })
		v := model.WorkloadView(o, kindName, pods, metrics)
		return &v
	}
	return nil
}

func toUsage(m map[string]kube.PodMetrics) map[string]model.Usage {
	out := make(map[string]model.Usage, len(m))
	for k, v := range m {
		out[k] = model.Usage{CPU: v.CPU, Memory: v.Memory}
	}
	return out
}

// BuildRevisions renders rollout history as objects rather than
// `kubectl rollout history` text.
//
// Deployments keep every revision as a ReplicaSet, so the list can be clicked
// through to the pods each one ran; StatefulSets and DaemonSets use
// ControllerRevisions, which carry the revision number but no replica count.
func BuildRevisions(cl *kube.Cluster, kindName string, o *model.Obj) []RevisionRow {
	ns, name, uid := o.GetNamespace(), o.GetName(), o.GetUID()
	ownedByThis := func(child *model.Obj) bool {
		for _, r := range child.GetOwnerReferences() {
			if uid != "" {
				if r.UID == uid {
					return true
				}
				continue
			}
			if r.Name == name {
				return true
			}
		}
		return false
	}

	switch kindName {
	case "deployments":
		all, err := cl.List("replicasets", kube.ListOptions{Namespace: ns})
		if err != nil {
			return []RevisionRow{}
		}
		sets := []model.Obj{}
		for i := range all {
			if ownedByThis(&all[i]) {
				sets = append(sets, all[i])
			}
		}
		sets = model.SortRevisions(sets)
		currentRevision := 0
		if len(sets) > 0 {
			currentRevision = model.RevisionOf(&sets[0])
		}
		rows := make([]RevisionRow, 0, len(sets))
		for i := range sets {
			rs := &sets[i]
			rev := model.RevisionOf(rs)
			replicas := nestedInt(rs, "spec", "replicas")
			statusReplicas := nestedInt(rs, "status", "replicas")
			rows = append(rows, RevisionRow{
				Revision: rev,
				Name:     rs.GetName(),
				Kind:     "replicasets",
				NS:       rs.GetNamespace(),
				Replicas: replicas,
				Ready:    nestedInt(rs, "status", "readyReplicas"),
				Images:   model.Images(rs),
				Age:      model.Age(rs),
				TS:       creationMillis(rs),
				Current:  rev == currentRevision && statusReplicas > 0,
			})
		}
		return rows

	case "statefulsets", "daemonsets":
		all, err := cl.List("controllerrevisions", kube.ListOptions{Namespace: ns})
		if err != nil {
			return []RevisionRow{}
		}
		rows := []RevisionRow{}
		for i := range all {
			r := &all[i]
			if !ownedByThis(r) {
				continue
			}
			rows = append(rows, RevisionRow{
				Revision: int(nestedInt(r, "revision")),
				Name:     r.GetName(),
				Kind:     "controllerrevisions",
				NS:       r.GetNamespace(),
				Age:      model.Age(r),
				TS:       creationMillis(r),
			})
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].Revision > rows[j].Revision })
		if len(rows) > 0 {
			rows[0].Current = true
		}
		return rows
	}
	return []RevisionRow{}
}

func creationMillis(o *model.Obj) int64 {
	if ts := o.GetCreationTimestamp(); !ts.IsZero() {
		return ts.UnixMilli()
	}
	return 0
}

// buildSection resolves the declarative Section against the cluster.
//
// skipSection is set for kinds with a rich page: they already fetched their
// pods, and listing them twice per request is the bug this parameter exists to
// prevent.
func buildSection(cl *kube.Cluster, kindName string, o *model.Obj, isWorkload, skipSection bool) (
	[]model.Row, *SectionPayload, []kube.Event, bool,
) {
	top := map[string]model.Usage{}
	ns, name := o.GetNamespace(), o.GetName()
	m := model.DetailModelFor(kindName, o, isWorkload, top)

	var section *SectionPayload
	if !skipSection && m.Section != nil {
		sec := m.Section
		podsKind := model.FindKind("pods")

		switch sec.Type {
		case "workloadPods", "endpointPods":
			pods, err := cl.List("pods", kube.ListOptions{Namespace: ns, LabelSelector: sec.Selector})
			if err != nil {
				pods = nil
			}
			top = toUsage(cl.TopPods(ns, sec.Selector))
			rows := make([][]string, 0, len(pods))
			drill := make([]DrillRef, 0, len(pods))
			for i := range pods {
				p := &pods[i]
				base := podsKind.Row(p)
				cpu, mem := "—", "—"
				if u, ok := top[p.GetName()]; ok {
					cpu, mem = u.CPU, u.Memory
				}
				rows = append(rows, []string{base[0], base[1], base[2], base[3], cpu, mem, base[5], base[6]})
				drill = append(drill, DrillRef{Kind: "pods", Name: p.GetName(), NS: p.GetNamespace()})
			}
			section = &SectionPayload{
				Title: sec.Title, Columns: model.PodSectionColumns,
				Rows: rows, Tones: constTones(len(rows), 2), Drill: drill,
			}

		case "podContainers":
			top = toUsage(cl.TopPods(ns, ""))
			containers := model.PodContainers(o)
			rows := make([][]string, 0, len(containers))
			for _, c := range containers {
				rows = append(rows, []string{c.Name, c.Image, c.Ready, c.Restarts})
			}
			section = &SectionPayload{
				Title: sec.Title, Columns: []string{"CONTAINER", "IMAGE", "READY", "RESTARTS"},
				Rows: rows, Tones: constTones(len(rows), 2),
			}

		case "nodePods":
			pods, err := cl.List("pods", kube.ListOptions{FieldSelector: "spec.nodeName=" + sec.Node})
			if err != nil {
				pods = nil
			}
			rows := make([][]string, 0, len(pods))
			drill := make([]DrillRef, 0, len(pods))
			for i := range pods {
				p := &pods[i]
				base := podsKind.Row(p)
				rows = append(rows, []string{p.GetNamespace(), base[0], base[2], base[3], model.Age(p)})
				drill = append(drill, DrillRef{Kind: "pods", Name: p.GetName(), NS: p.GetNamespace()})
			}
			section = &SectionPayload{
				Title: sec.Title, Columns: []string{"NAMESPACE", "NAME", "STATUS", "RESTARTS", "AGE"},
				Rows: rows, Tones: constTones(len(rows), 2), Drill: drill,
			}

		case "pvcConsumers":
			all, err := cl.List("pods", kube.ListOptions{Namespace: ns})
			if err != nil {
				all = nil
			}
			rows := [][]string{}
			drill := []DrillRef{}
			for i := range all {
				p := &all[i]
				if !model.PodMountsPVC(p, sec.PVC) {
					continue
				}
				base := podsKind.Row(p)
				rows = append(rows, []string{base[0], base[1], base[2], base[3], "—", "—", base[5], base[6]})
				drill = append(drill, DrillRef{Kind: "pods", Name: p.GetName(), NS: p.GetNamespace()})
			}
			section = &SectionPayload{
				Title: sec.Title, Columns: model.PodSectionColumns,
				Rows: rows, Tones: constTones(len(rows), 2), Drill: drill,
			}

		case "cronjobJobs":
			all, err := cl.List("jobs", kube.ListOptions{Namespace: ns})
			if err != nil {
				all = nil
			}
			jobs := []model.Obj{}
			for i := range all {
				if model.JobOwnedByCronJob(&all[i], name) {
					jobs = append(jobs, all[i])
				}
			}
			sort.Slice(jobs, func(i, j int) bool {
				return creationMillis(&jobs[i]) > creationMillis(&jobs[j])
			})
			rows := make([][]string, 0, len(jobs))
			drill := make([]DrillRef, 0, len(jobs))
			for i := range jobs {
				j := &jobs[i]
				rows = append(rows, []string{j.GetName(), model.JobStatus(j),
					fmt.Sprintf("%d", nestedInt(j, "status", "succeeded")), model.Age(j)})
				drill = append(drill, DrillRef{Kind: "jobs", Name: j.GetName(), NS: j.GetNamespace()})
			}
			section = &SectionPayload{
				Title: sec.Title, Columns: []string{"NAME", "STATUS", "SUCCEEDED", "AGE"},
				Rows: rows, Tones: constTones(len(rows), 1), Drill: drill,
			}

		case "dataKeys":
			data := nestedStringMap(o, "data")
			keys := make([]string, 0, len(data))
			for k := range data {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			rows := make([][]string, 0, len(keys))
			for _, k := range keys {
				raw := data[k]
				bytes := len(raw)
				if sec.Decode {
					if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil {
						bytes = len(decoded)
					}
				}
				rows = append(rows, []string{k, fmt.Sprintf("%d B", bytes)})
			}
			section = &SectionPayload{
				Title: sec.Title, Columns: []string{"KEY", "SIZE"}, Rows: rows,
				DataKeys: &DataKeys{Keys: keys, Decode: sec.Decode},
			}

		case "ingressRules":
			// A routing table that says whether each route actually works.
			//
			// The rules alone are just intent — the useful question is whether
			// the backend Service exists and has endpoints behind it, because a
			// typo'd service name or a selector that matches nothing is the
			// ordinary way an Ingress breaks, and kubectl will not tell you.
			// Two list calls answer it for every row.
			services, err := cl.List("services", kube.ListOptions{Namespace: ns})
			if err != nil {
				services = nil
			}
			endpoints, err := cl.List("endpoints", kube.ListOptions{Namespace: ns})
			if err != nil {
				endpoints = nil
			}
			svcExists := map[string]bool{}
			for i := range services {
				svcExists[services[i].GetName()] = true
			}
			readyByName := map[string]int{}
			for i := range endpoints {
				e := &endpoints[i]
				ready := 0
				for _, sraw := range nestedSlice(e, "subsets") {
					if sub, ok := sraw.(map[string]any); ok {
						if addrs, ok := sub["addresses"].([]any); ok {
							ready += len(addrs)
						}
					}
				}
				readyByName[e.GetName()] = ready
			}

			routes := model.IngressRoutes(o)
			rows := make([][]string, 0, len(routes))
			drill := make([]DrillRef, 0, len(routes))
			for _, r := range routes {
				backend := "no such service"
				if svcExists[r.Service] {
					if ready := readyByName[r.Service]; ready > 0 {
						backend = fmt.Sprintf("%d endpoints", ready)
					} else {
						backend = "no endpoints"
					}
				}
				// The section's URL drops a bare "/" where the row's own link
				// keeps it; both are the same route.
				url := r.URL
				if url != "" && strings.HasSuffix(url, "/") && r.Path == "/" {
					url = strings.TrimSuffix(url, "/")
				}
				rows = append(rows, []string{r.Host, r.Path, r.Service + ":" + r.Port, backend, url})
				drill = append(drill, DrillRef{Kind: "services", Name: r.Service, NS: ns})
			}
			section = &SectionPayload{
				Title: sec.Title, Columns: []string{"HOST", "PATH", "BACKEND", "STATUS", "URL"},
				Rows: rows, Tones: constTones(len(rows), 3), Drill: drill,
			}
		}
	}

	// Rebuild the summary with live top metrics for pods/workloads.
	summary := model.DetailModelFor(kindName, o, isWorkload, top).Summary

	singular := o.GetKind()
	if k := model.FindKind(kindName); k != nil {
		singular = k.Kind
	}
	events, _ := cl.EventsFor(kube.ResourceRef{
		Kind: kindName, Name: name, Namespace: ns, Context: cl.Context}, singular)

	_, canLogs := model.LogSpecFor(kindName, o)
	return summary, section, events, canLogs
}

func constTones(n, tone int) []int {
	if n == 0 {
		return nil
	}
	out := make([]int, n)
	for i := range out {
		out[i] = tone
	}
	return out
}

// BuildDetailPayload assembles everything a detail page renders.
func BuildDetailPayload(cl *kube.Cluster, kind *model.KindDef, ref kube.ResourceRef) (*DetailPayload, error) {
	obj, err := cl.Get(ref)
	if err != nil {
		return nil, err
	}
	isWorkload := model.WorkloadKinds[kind.Name]
	// The rich view and the generic section are built together: kinds that have
	// a real page get one, everything else keeps the summary + table that every
	// kind is guaranteed.
	summary, section, events, canLogs := buildSection(
		cl, kind.Name, obj, isWorkload, model.RichKinds[kind.Name])
	view := buildDetailView(cl, kind.Name, obj)

	payload := &DetailPayload{
		Kind: kindMeta(kind), Name: obj.GetName(), NS: obj.GetNamespace(),
		Summary: summary, View: view, Events: events, CanLogs: canLogs,
	}
	// /api/detail returns view XOR section so the two never render together.
	if view == nil {
		payload.Section = section
	}
	if payload.Name == "" {
		payload.Name = ref.Name
	}
	return payload, nil
}

package model

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// The rich detail page model — Aptakube's shape, built server-side. Port of
// src/detail-view.ts.
//
// details.go gives every kind a key/value summary and one table, which is the
// right floor for four hundred kinds. The handful of kinds people actually
// stare at all day (pods and the workloads that own them) deserve more than a
// floor: the scheduling constraints that explain why a pod is Pending, the
// per-container usage against its own requests and limits, the restart reason
// that survived the last crash.
//
// Everything here is a pure function of objects the caller already fetched, so
// it is testable without a cluster.

// Tone colours a value by what it means.
type Tone string

const (
	ToneOK      Tone = "ok"
	ToneWarn    Tone = "warn"
	ToneBad     Tone = "bad"
	ToneNeutral Tone = "neutral"
)

// Ref is a link to another object.
type Ref struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
	NS   string `json:"ns,omitempty"`
	// Via says how the spec reaches it — `volume config`, `env DB_PASS`,
	// `envFrom in api`.
	Via string `json:"via,omitempty"`
}

// Chip is a small labelled value.
type Chip struct {
	K    string `json:"k,omitempty"`
	V    string `json:"v"`
	Tone Tone   `json:"tone,omitempty"`
}

// Fact is one label/value pair on a detail page. Exactly one carrier is filled.
type Fact struct {
	Label string   `json:"label"`
	Text  string   `json:"text,omitempty"`
	Tone  Tone     `json:"tone,omitempty"`
	Ref   *Ref     `json:"ref,omitempty"`
	Refs  []Ref    `json:"refs,omitempty"`
	Chips []Chip   `json:"chips,omitempty"`
	Items []string `json:"items,omitempty"`
	// Wide spans the full width of the group (labels, annotations, tolerations).
	Wide bool `json:"wide,omitempty"`
}

// FactGroup is a titled block of facts.
type FactGroup struct {
	Title string `json:"title,omitempty"`
	Facts []Fact `json:"facts"`
}

// ContainerView is one container card.
type ContainerView struct {
	Name          string   `json:"name"`
	Image         string   `json:"image"`
	Init          bool     `json:"init"`
	State         string   `json:"state,omitempty"`
	StateTone     Tone     `json:"stateTone,omitempty"`
	Started       *bool    `json:"started,omitempty"`
	Ready         *bool    `json:"ready,omitempty"`
	Restarts      int64    `json:"restarts"`
	LastRestart   string   `json:"lastRestart,omitempty"`
	RestartReason string   `json:"restartReason,omitempty"`
	CPU           Gauge    `json:"cpu"`
	Mem           Gauge    `json:"mem"`
	Ports         string   `json:"ports,omitempty"`
	Mounts        []string `json:"mounts,omitempty"`
}

// PodLine is one row of an embedded pod table.
type PodLine struct {
	Name              string `json:"name"`
	NS                string `json:"ns,omitempty"`
	Ready             string `json:"ready"`
	Status            string `json:"status"`
	Tone              Tone   `json:"tone"`
	Restarts          int64  `json:"restarts"`
	LastRestart       string `json:"lastRestart"`
	LastRestartReason string `json:"lastRestartReason"`
	Node              string `json:"node"`
	CPU               Gauge  `json:"cpu"`
	Mem               Gauge  `json:"mem"`
}

// PodsBlock is the counts plus the rows.
//
// Title and Counts exist for the kinds that embed a pod table but do not own
// the pods: a Service's pods are "selected" and "serving", never "updated" and
// "available", and labelling them with a workload's four rollout counters would
// be four wrong words under a correct table.
type PodsBlock struct {
	Desired   int64     `json:"desired"`
	Updated   int64     `json:"updated"`
	Ready     int64     `json:"ready"`
	Available int64     `json:"available"`
	Rows      []PodLine `json:"rows"`
	Title     string    `json:"title,omitempty"`
	Counts    []Chip    `json:"counts,omitempty"`
}

// DetailView is a full rich page.
type DetailView struct {
	// Header is the identity card at the top: age, namespace, owner, labels,
	// annotations.
	Header     FactGroup       `json:"header"`
	Groups     []FactGroup     `json:"groups"`
	Containers []ContainerView `json:"containers"`
	// ContainersNote is non-empty when container gauges are summed over more
	// than one pod.
	ContainersNote string     `json:"containersNote,omitempty"`
	Pods           *PodsBlock `json:"pods,omitempty"`
}

// RichKinds get the rich page. Everything else keeps summary + section.
var RichKinds = map[string]bool{
	"pods":         true,
	"deployments":  true,
	"statefulsets": true,
	"daemonsets":   true,
	"replicasets":  true,
	"jobs":         true,
	"nodes":        true,
	"services":     true,
}

const chipLimit = 40

func chipsFrom(m map[string]string) []Chip {
	if len(m) == 0 {
		return []Chip{}
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Go map order is randomised; sorting keeps the card stable between loads.
	sort.Strings(keys)
	if len(keys) > chipLimit {
		keys = keys[:chipLimit]
	}
	out := make([]Chip, 0, len(keys))
	for _, k := range keys {
		out = append(out, Chip{K: k, V: m[k]})
	}
	return out
}

func controllerRef(o *Obj) (kind, name string, ok bool) {
	refs := o.GetOwnerReferences()
	if len(refs) == 0 {
		return "", "", false
	}
	chosen := refs[0]
	for _, r := range refs {
		if r.Controller != nil && *r.Controller {
			chosen = r
			break
		}
	}
	if chosen.Kind == "" || chosen.Name == "" {
		return "", "", false
	}
	return chosen.Kind, chosen.Name, true
}

// headerGroup is the card every object shares: when, where, who made it, how it
// is labelled.
func headerGroup(o *Obj) FactGroup {
	ns := o.GetNamespace()
	facts := []Fact{{Label: "Age", Text: Age(o)}}
	nsFact := Fact{Label: "Namespace", Text: ns}
	if ns != "" {
		nsFact.Ref = &Ref{Kind: "namespaces", Name: ns}
	}
	facts = append(facts, nsFact)

	if kind, name, ok := controllerRef(o); ok {
		facts = append(facts, Fact{
			Label: "Owner",
			Text:  kind + ": " + name,
			Ref:   &Ref{Kind: strings.ToLower(kind) + "s", Name: name, NS: ns},
		})
	}
	facts = append(facts,
		Fact{Label: "Labels", Chips: chipsFrom(o.GetLabels()), Wide: true},
		Fact{Label: "Annotations", Chips: chipsFrom(annotationsForDisplay(o)), Wide: true})
	return FactGroup{Facts: facts}
}

// annotationsForDisplay drops the ones that are a serialised copy of the
// object. last-applied-configuration is a whole manifest on one line; showing
// it in full turns the identity card into a wall, so it is kept but truncated.
func annotationsForDisplay(o *Obj) map[string]string {
	out := map[string]string{}
	for k, v := range o.GetAnnotations() {
		if len(v) > 220 {
			v = v[:220] + "…"
		}
		out[k] = v
	}
	return out
}

func conditionChips(o *Obj) []Chip {
	out := []Chip{}
	for _, raw := range slice(o, "status", "conditions") {
		c := asMap(raw)
		typ, status, reason := mstr(c, "type"), mstr(c, "status"), mstr(c, "reason")
		switch status {
		case "True":
			out = append(out, Chip{V: typ, Tone: ToneOK})
		case "False":
			detail := reason
			if detail == "" {
				detail = status
			}
			out = append(out, Chip{V: typ + ": " + detail, Tone: ToneBad})
		default:
			detail := reason
			if detail == "" {
				detail = status
			}
			out = append(out, Chip{V: typ + ": " + detail, Tone: ToneWarn})
		}
	}
	return out
}

// TolerationLines renders a pod spec's tolerations.
func TolerationLines(spec map[string]any) []string {
	out := []string{}
	for _, raw := range mslice(spec, "tolerations") {
		t := asMap(raw)
		key := mstr(t, "key")
		if key == "" {
			key = "*"
		}
		value := ""
		if v := mstr(t, "value"); v != "" {
			value = "=" + v
		}
		effect := mstr(t, "effect")
		if effect == "" {
			effect = "all effects"
		}
		secs := ""
		if _, ok := t["tolerationSeconds"]; ok {
			secs = fmt.Sprintf(" for %ss", mstr(t, "tolerationSeconds"))
		}
		out = append(out, fmt.Sprintf("%s%s: %s%s", key, value, effect, secs))
	}
	return out
}

// NodeAffinityLines renders required and preferred node affinity.
func NodeAffinityLines(spec map[string]any) []string {
	na := mmap(mmap(spec, "affinity"), "nodeAffinity")
	if na == nil {
		return []string{}
	}
	expr := func(e map[string]any) string {
		values := []string{}
		for _, v := range mslice(e, "values") {
			values = append(values, valueString(v))
		}
		return strings.TrimSpace(fmt.Sprintf("%s %s %s",
			mstr(e, "key"), mstr(e, "operator"), strings.Join(values, ", ")))
	}
	lines := []string{}
	required := mmap(na, "requiredDuringSchedulingIgnoredDuringExecution")
	for _, traw := range mslice(required, "nodeSelectorTerms") {
		for _, eraw := range mslice(asMap(traw), "matchExpressions") {
			lines = append(lines, "required: "+expr(asMap(eraw)))
		}
	}
	for _, praw := range mslice(na, "preferredDuringSchedulingIgnoredDuringExecution") {
		p := asMap(praw)
		weight := mstr(p, "weight")
		if weight == "" {
			weight = "1"
		}
		for _, eraw := range mslice(mmap(p, "preference"), "matchExpressions") {
			lines = append(lines, fmt.Sprintf("preferred (%s): %s", weight, expr(asMap(eraw))))
		}
	}
	return lines
}

// TopologySpreadLines renders topology spread constraints.
func TopologySpreadLines(spec map[string]any) []string {
	out := []string{}
	for _, raw := range mslice(spec, "topologySpreadConstraints") {
		c := asMap(raw)
		key := mstr(c, "topologyKey")
		if key == "" {
			key = "?"
		}
		skew := mstr(c, "maxSkew")
		if skew == "" {
			skew = "1"
		}
		when := mstr(c, "whenUnsatisfiable")
		if when == "" {
			when = "DoNotSchedule"
		}
		out = append(out, fmt.Sprintf("%s · maxSkew %s · %s", key, skew, when))
	}
	return out
}

// schedulingGroup is the group that explains a Pending pod.
func schedulingGroup(spec map[string]any) FactGroup {
	selector := map[string]string{}
	for k, v := range mmap(spec, "nodeSelector") {
		selector[k] = valueString(v)
	}
	return FactGroup{
		Title: "Scheduling",
		Facts: []Fact{
			{Label: "Node Selector", Chips: chipsFrom(selector)},
			{Label: "Node Affinity", Items: NodeAffinityLines(spec)},
			{Label: "Topology Spread Constraints", Items: TopologySpreadLines(spec), Wide: true},
			{Label: "Tolerations", Items: TolerationLines(spec), Wide: true},
		},
	}
}

// ── references ──────────────────────────────────────────────────────────────

// The objects a pod spec names, turned into links.
//
// A workload's YAML is full of names that are really pointers — the ConfigMap a
// volume mounts, the Secret one env var reads a single key out of, the claim a
// StatefulSet writes to — and following one by hand means reading the manifest,
// holding a name in your head, and going to find it in another list.
//
// Every site the API server itself resolves is walked, not just the obvious
// two: `projected` sources hide ConfigMaps behind another level, `envFrom`
// names one without ever naming a key, and the CSI and in-tree drivers keep
// their credentials in a `secretRef` of their own. Missing one of those is
// worse than showing none, because a group that looks complete and is not
// teaches you to trust it.

const (
	kindConfigMaps = "configmaps"
	kindSecrets    = "secrets"
	kindPVCs       = "persistentvolumeclaims"
)

// secretRefDrivers are in-tree drivers that hang a plain secretRef off
// themselves.
var secretRefDrivers = []string{"cephfs", "iscsi", "rbd", "scaleIO", "storageos", "flexVolume"}

type refEntry struct {
	kind, name string
	vias       []string
	order      int
}

// RefSet collects named objects, remembering every place each was reached from.
type RefSet struct {
	found map[string]*refEntry
	next  int
}

func newRefSet() *RefSet { return &RefSet{found: map[string]*refEntry{}} }

func (r *RefSet) add(kind, name, via string) {
	if name == "" {
		return
	}
	key := kind + "/" + name
	e, ok := r.found[key]
	if !ok {
		r.found[key] = &refEntry{kind: kind, name: name, vias: []string{via}, order: r.next}
		r.next++
		return
	}
	for _, v := range e.vias {
		if v == via {
			return
		}
	}
	e.vias = append(e.vias, via)
}

// summarizeVia keeps the hint short: three reasons is a hint; ten is the wall
// of YAML the group replaces.
func summarizeVia(vias []string) string {
	if len(vias) <= 3 {
		return strings.Join(vias, ", ")
	}
	return fmt.Sprintf("%s +%d more", strings.Join(vias[:2], ", "), len(vias)-2)
}

// Of returns the refs of one kind, in the order they were first reached.
func (r *RefSet) Of(kind, ns string) []Ref {
	entries := []*refEntry{}
	for _, e := range r.found {
		if e.kind == kind {
			entries = append(entries, e)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].order < entries[j].order })
	out := make([]Ref, 0, len(entries))
	for _, e := range entries {
		out = append(out, Ref{Kind: e.kind, Name: e.name, NS: ns, Via: summarizeVia(e.vias)})
	}
	return out
}

// SpecRefs walks a pod spec and collects every object it names.
func SpecRefs(spec map[string]any) *RefSet {
	refs := newRefSet()

	for _, raw := range mslice(spec, "volumes") {
		v := asMap(raw)
		if v == nil {
			continue
		}
		vname := mstr(v, "name")
		if vname == "" {
			vname = "?"
		}
		where := "volume " + vname
		refs.add(kindConfigMaps, mstr(mmap(v, "configMap"), "name"), where)
		refs.add(kindSecrets, mstr(mmap(v, "secret"), "secretName"), where)
		refs.add(kindSecrets, mstr(mmap(v, "azureFile"), "secretName"), where)
		refs.add(kindSecrets, mstr(mmap(mmap(v, "csi"), "nodePublishSecretRef"), "name"), where)
		refs.add(kindPVCs, mstr(mmap(v, "persistentVolumeClaim"), "claimName"), where)

		for _, sraw := range mslice(mmap(v, "projected"), "sources") {
			s := asMap(sraw)
			refs.add(kindConfigMaps, mstr(mmap(s, "configMap"), "name"), "projected "+vname)
			refs.add(kindSecrets, mstr(mmap(s, "secret"), "name"), "projected "+vname)
		}
		for _, d := range secretRefDrivers {
			refs.add(kindSecrets, mstr(mmap(mmap(v, d), "secretRef"), "name"), where)
		}
	}

	for _, raw := range mslice(spec, "imagePullSecrets") {
		refs.add(kindSecrets, mstr(asMap(raw), "name"), "image pull")
	}

	containers := append(containerList(spec, "initContainers"), containerList(spec, "containers")...)
	for _, c := range containers {
		who := mstr(c, "name")
		if who == "" {
			who = "?"
		}
		for _, eraw := range mslice(c, "envFrom") {
			e := asMap(eraw)
			refs.add(kindConfigMaps, mstr(mmap(e, "configMapRef"), "name"), "envFrom in "+who)
			refs.add(kindSecrets, mstr(mmap(e, "secretRef"), "name"), "envFrom in "+who)
		}
		for _, eraw := range mslice(c, "env") {
			e := asMap(eraw)
			from := mmap(e, "valueFrom")
			if from == nil {
				continue
			}
			ename := mstr(e, "name")
			if ename == "" {
				ename = "?"
			}
			refs.add(kindConfigMaps, mstr(mmap(from, "configMapKeyRef"), "name"), "env "+ename)
			refs.add(kindSecrets, mstr(mmap(from, "secretKeyRef"), "name"), "env "+ename)
		}
	}
	return refs
}

var refLabels = []struct{ kind, label string }{
	{kindConfigMaps, "ConfigMaps"},
	{kindSecrets, "Secrets"},
	{kindPVCs, "Volume Claims"},
}

// ReferencesGroup is the References group, or nil when the spec names nothing —
// three empty dashes under a heading is worse than no heading.
//
// identity adds the service account and priority class, which a pod already
// shows in its own summary and a workload has nowhere else to put.
func ReferencesGroup(spec map[string]any, ns string, identity bool) *FactGroup {
	refs := SpecRefs(spec)
	facts := []Fact{}
	for _, rl := range refLabels {
		if list := refs.Of(rl.kind, ns); len(list) > 0 {
			facts = append(facts, Fact{Label: rl.label, Refs: list, Wide: true})
		}
	}
	if identity {
		sa := mstr(spec, "serviceAccountName")
		if sa == "" {
			sa = mstr(spec, "serviceAccount")
		}
		if sa != "" {
			facts = append(facts, Fact{Label: "Service Account", Text: sa,
				Ref: &Ref{Kind: "serviceaccounts", Name: sa, NS: ns}})
		}
		if pc := mstr(spec, "priorityClassName"); pc != "" {
			facts = append(facts, Fact{Label: "Priority Class", Text: pc,
				Ref: &Ref{Kind: "priorityclasses", Name: pc}})
		}
	}
	if len(facts) == 0 {
		return nil
	}
	return &FactGroup{Title: "References", Facts: facts}
}

// ── containers ──────────────────────────────────────────────────────────────

func portsText(c map[string]any) string {
	out := []string{}
	for _, raw := range mslice(c, "ports") {
		p := asMap(raw)
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
	return strings.Join(out, ", ")
}

func mountLines(c map[string]any) []string {
	out := []string{}
	for _, raw := range mslice(c, "volumeMounts") {
		m := asMap(raw)
		line := mstr(m, "mountPath")
		if ro, ok := m["readOnly"].(bool); ok && ro {
			line += " (ro)"
		}
		out = append(out, line)
	}
	return out
}

func stateOf(st map[string]any) (string, Tone) {
	state := mmap(st, "state")
	if state == nil {
		return "", ""
	}
	if mmap(state, "running") != nil {
		return "Running", ToneOK
	}
	if w := mmap(state, "waiting"); w != nil {
		reason := mstr(w, "reason")
		if reason == "" {
			reason = "Waiting"
		}
		return reason, ToneWarn
	}
	if t := mmap(state, "terminated"); t != nil {
		reason := mstr(t, "reason")
		ok := reason == "Completed" || mstr(t, "exitCode") == "0"
		if reason == "" {
			reason = "Terminated"
		}
		if ok {
			return reason, ToneNeutral
		}
		return reason, ToneBad
	}
	return "", ""
}

func statusFor(statuses []any, name string) map[string]any {
	for _, raw := range statuses {
		s := asMap(raw)
		if mstr(s, "name") == name {
			return s
		}
	}
	return nil
}

func boolPtr(m map[string]any, key string) *bool {
	if v, ok := m[key].(bool); ok {
		return &v
	}
	return nil
}

func withUsed(g Gauge, used *float64) Gauge {
	g.Used = used
	return g
}

// PodContainerViews builds container cards for a pod: spec plus live status
// plus this pod's metrics.
func PodContainerViews(pod *Obj, metrics *Metrics) []ContainerView {
	podName, ns := pod.GetName(), pod.GetNamespace()
	statuses := append(slice(pod, "status", "containerStatuses"),
		slice(pod, "status", "initContainerStatuses")...)

	build := func(c map[string]any, init bool) ContainerView {
		name := mstr(c, "name")
		st := statusFor(statuses, name)
		alloc := ContainerAllocation(c)
		state, tone := stateOf(st)

		var cpuUsed, memUsed *float64
		if s, ok := metrics.Container(podName, name, ns); ok {
			cpu, mem := s.CPU, s.Mem
			cpuUsed, memUsed = &cpu, &mem
		}
		last := mmap(mmap(st, "lastState"), "terminated")
		var restarts int64
		if st != nil {
			if v, ok := st["restartCount"]; ok {
				restarts = int64(toFloat(v))
			}
		}
		return ContainerView{
			Name: name, Image: mstr(c, "image"), Init: init,
			State: state, StateTone: tone,
			Started: boolPtr(st, "started"), Ready: boolPtr(st, "ready"),
			Restarts:      restarts,
			LastRestart:   mstr(last, "finishedAt"),
			RestartReason: mstr(last, "reason"),
			CPU:           withUsed(alloc.CPU, cpuUsed),
			Mem:           withUsed(alloc.Mem, memUsed),
			Ports:         portsText(c),
			Mounts:        mountLines(c),
		}
	}

	out := []ContainerView{}
	for _, c := range InitContainersOf(pod) {
		out = append(out, build(c, true))
	}
	for _, c := range ContainersOf(pod) {
		out = append(out, build(c, false))
	}
	return out
}

func toFloat(v any) float64 {
	switch n := v.(type) {
	case int64:
		return float64(n)
	case float64:
		return n
	case int32:
		return float64(n)
	}
	return 0
}

// WorkloadContainerViews builds container cards for a workload: the template's
// containers, with usage summed across every pod that template produced.
//
// One replica is the common case and reads exactly like the pod's own card; ten
// replicas read as the workload's total, which is the number you compare
// against the limits you set.
func WorkloadContainerViews(o *Obj, pods []Obj, metrics *Metrics) []ContainerView {
	build := func(c map[string]any, init bool) ContainerView {
		per := ContainerAllocation(c)
		name := mstr(c, "name")
		cpu, mem := Gauge{}, Gauge{}
		for i := range pods {
			p := &pods[i]
			var cpuUsed, memUsed *float64
			if s, ok := metrics.Container(p.GetName(), name, p.GetNamespace()); ok {
				a, b := s.CPU, s.Mem
				cpuUsed, memUsed = &a, &b
			}
			cpu = AddGauge(cpu, withUsed(per.CPU, cpuUsed))
			mem = AddGauge(mem, withUsed(per.Mem, memUsed))
		}
		if len(pods) == 0 {
			cpu, mem = per.CPU, per.Mem
		}
		return ContainerView{
			Name: name, Image: mstr(c, "image"), Init: init,
			CPU: cpu, Mem: mem, Ports: portsText(c), Mounts: mountLines(c),
		}
	}

	out := []ContainerView{}
	for _, c := range InitContainersOf(o) {
		out = append(out, build(c, true))
	}
	for _, c := range ContainersOf(o) {
		out = append(out, build(c, false))
	}
	return out
}

func lastRestartOf(pod *Obj) (at, reason string) {
	for _, raw := range slice(pod, "status", "containerStatuses") {
		t := mmap(mmap(asMap(raw), "lastState"), "terminated")
		finished := mstr(t, "finishedAt")
		if finished == "" {
			continue
		}
		if at == "" || after(finished, at) {
			at, reason = finished, mstr(t, "reason")
		}
	}
	return at, reason
}

func after(a, b string) bool {
	ta, errA := time.Parse(time.RFC3339, a)
	tb, errB := time.Parse(time.RFC3339, b)
	if errA != nil || errB != nil {
		return false
	}
	return ta.After(tb)
}

// PodLineFor builds one row of an embedded pod table.
func PodLineFor(pod *Obj, metrics *Metrics) PodLine {
	statuses := slice(pod, "status", "containerStatuses")
	ready, restarts := 0, int64(0)
	for _, raw := range statuses {
		s := asMap(raw)
		if b, ok := s["ready"].(bool); ok && b {
			ready++
		}
		if v, ok := s["restartCount"]; ok {
			restarts += int64(toFloat(v))
		}
	}
	total := len(statuses)
	if total == 0 {
		total = len(ContainersOf(pod))
	}

	status := PodPhase(pod)
	tone := ToneBad
	switch status {
	case "Running", "Succeeded":
		tone = ToneOK
	case "Pending":
		tone = ToneWarn
	}

	alloc := PodAllocation(pod)
	var cpuUsed, memUsed *float64
	if s, ok := metrics.Pod(pod.GetName(), pod.GetNamespace()); ok {
		a, b := s.CPU, s.Mem
		cpuUsed, memUsed = &a, &b
	}
	at, reason := lastRestartOf(pod)

	return PodLine{
		Name: pod.GetName(), NS: pod.GetNamespace(),
		Ready:  fmt.Sprintf("%d/%d", ready, total),
		Status: status, Tone: tone,
		Restarts: restarts, LastRestart: at, LastRestartReason: reason,
		Node: str(pod, "spec", "nodeName"),
		CPU:  withUsed(alloc.CPU, cpuUsed),
		Mem:  withUsed(alloc.Mem, memUsed),
	}
}

// strategyGroup is the rolling-update knobs and the conditions that say how the
// rollout is going.
func strategyGroup(o *Obj, kindName string) FactGroup {
	strategy := mapOf(o, "spec", "strategy")
	if strategy == nil {
		strategy = mapOf(o, "spec", "updateStrategy")
	}
	rolling := mmap(strategy, "rollingUpdate")

	typ := mstr(strategy, "type")
	if typ == "" {
		if kindName == "daemonsets" {
			typ = "RollingUpdate"
		} else {
			typ = "—"
		}
	}
	facts := []Fact{{Label: "Strategy", Text: typ}}
	if v, ok := rolling["maxSurge"]; ok && v != nil {
		facts = append(facts, Fact{Label: "Max Surge", Text: valueString(v)})
	}
	if v, ok := rolling["maxUnavailable"]; ok && v != nil {
		facts = append(facts, Fact{Label: "Max Unavailable", Text: valueString(v)})
	}
	if v, ok := rolling["partition"]; ok && v != nil {
		facts = append(facts, Fact{Label: "Partition", Text: valueString(v)})
	}
	if s := intOf(o, "spec", "minReadySeconds"); s != 0 {
		facts = append(facts, Fact{Label: "Min Ready", Text: fmt.Sprintf("%ds", s)})
	}
	facts = append(facts, Fact{Label: "Conditions", Chips: conditionChips(o), Wide: true})
	return FactGroup{Title: "Rollout", Facts: facts}
}

func workloadCounts(o *Obj) PodsBlock {
	pick := func(paths ...[]string) int64 {
		for _, p := range paths {
			if v, ok, _ := nestedRaw(o, p...); ok && v != nil {
				return int64(toFloat(v))
			}
		}
		return 0
	}
	return PodsBlock{
		Desired: pick([]string{"status", "desiredNumberScheduled"},
			[]string{"spec", "replicas"}, []string{"status", "replicas"}),
		Updated: pick([]string{"status", "updatedNumberScheduled"},
			[]string{"status", "updatedReplicas"}),
		Ready: pick([]string{"status", "numberReady"}, []string{"status", "readyReplicas"}),
		Available: pick([]string{"status", "numberAvailable"},
			[]string{"status", "availableReplicas"}),
		Rows: []PodLine{},
	}
}

// WorkloadView is the full page model for a workload.
func WorkloadView(o *Obj, kindName string, pods []Obj, metrics *Metrics) DetailView {
	spec := PodSpecOf(o)
	counts := workloadCounts(o)
	counts.Rows = make([]PodLine, 0, len(pods))
	for i := range pods {
		counts.Rows = append(counts.Rows, PodLineFor(&pods[i], metrics))
	}

	header := headerGroup(o)
	selector := map[string]string{}
	for k, v := range mapOf(o, "spec", "selector", "matchLabels") {
		selector[k] = valueString(v)
	}
	// Selector goes third, after Age and Namespace.
	selFact := Fact{Label: "Selector", Chips: chipsFrom(selector)}
	header.Facts = append(header.Facts[:2],
		append([]Fact{selFact}, header.Facts[2:]...)...)

	groups := []FactGroup{strategyGroup(o, kindName)}
	// References sit above Scheduling: what a workload mounts is asked about far
	// more often than the affinity rules that placed it.
	if refs := ReferencesGroup(spec, o.GetNamespace(), true); refs != nil {
		groups = append(groups, *refs)
	}
	groups = append(groups, schedulingGroup(spec))

	view := DetailView{
		Header:     header,
		Groups:     groups,
		Containers: WorkloadContainerViews(o, pods, metrics),
		Pods:       &counts,
	}
	if len(pods) > 1 {
		view.ContainersNote = fmt.Sprintf("summed over %d pods", len(pods))
	}
	return view
}

// PodView is the full page model for a Pod.
func PodView(pod *Obj, metrics *Metrics) DetailView {
	spec := PodSpecOf(pod)
	ns := pod.GetNamespace()
	phase := PodPhase(pod)

	tone := ToneBad
	switch phase {
	case "Running", "Succeeded":
		tone = ToneOK
	case "Pending":
		tone = ToneWarn
	}

	node := mstr(spec, "nodeName")
	sa := mstr(spec, "serviceAccountName")
	if sa == "" {
		sa = mstr(spec, "serviceAccount")
	}
	startTime := ""
	if t := str(pod, "status", "startTime"); t != "" {
		startTime = AgeFrom(t)
	}

	nodeFact := Fact{Label: "Node", Text: node}
	if node != "" {
		nodeFact.Ref = &Ref{Kind: "nodes", Name: node}
	}
	saFact := Fact{Label: "Service Account", Text: dash(sa)}
	if sa != "" {
		saFact.Ref = &Ref{Kind: "serviceaccounts", Name: sa, NS: ns}
	}
	pc := mstr(spec, "priorityClassName")
	pcFact := Fact{Label: "Priority Class", Text: dash(pc)}
	if pc != "" {
		pcFact.Ref = &Ref{Kind: "priorityclasses", Name: pc}
	}

	groups := []FactGroup{{Facts: []Fact{
		{Label: "Phase", Text: phase, Tone: tone},
		{Label: "Conditions", Chips: conditionChips(pod), Wide: true},
		{Label: "Start Time", Text: startTime},
		{Label: "Pod IP", Text: dash(str(pod, "status", "podIP"))},
		nodeFact,
		{Label: "Host IP", Text: dash(str(pod, "status", "hostIP"))},
		saFact,
		{Label: "Quality of Service", Text: dash(str(pod, "status", "qosClass"))},
		pcFact,
		{Label: "Restart Policy", Text: dash(mstr(spec, "restartPolicy"))},
	}}}

	// identity=false: the summary above already links the service account.
	if refs := ReferencesGroup(spec, ns, false); refs != nil {
		groups = append(groups, *refs)
	}
	groups = append(groups, schedulingGroup(spec))

	return DetailView{
		Header:     headerGroup(pod),
		Groups:     groups,
		Containers: PodContainerViews(pod, metrics),
	}
}

// NodeView is the full page model for a Node: capacity, allocation and its
// resident pods.
func NodeView(node *Obj, pods []Obj, metrics *Metrics) DetailView {
	addr := func(t string) string {
		for _, raw := range slice(node, "status", "addresses") {
			a := asMap(raw)
			if mstr(a, "type") == t {
				return mstr(a, "address")
			}
		}
		return ""
	}
	q := func(path ...string) string {
		if v := str(node, path...); v != "" {
			return v
		}
		return "?"
	}

	unschedulable := boolOf(node, "spec", "unschedulable")
	schedulable := Fact{Label: "Schedulable", Text: "Yes", Tone: ToneOK}
	if unschedulable {
		schedulable = Fact{Label: "Schedulable", Text: "Cordoned", Tone: ToneWarn}
	}

	cpu, mem := Gauge{}, Gauge{}
	running := int64(0)
	rows := make([]PodLine, 0, len(pods))
	for i := range pods {
		p := &pods[i]
		alloc := PodAllocation(p)
		var cpuUsed, memUsed *float64
		if s, ok := metrics.Pod(p.GetName(), p.GetNamespace()); ok {
			a, b := s.CPU, s.Mem
			cpuUsed, memUsed = &a, &b
		}
		cpu = AddGauge(cpu, withUsed(alloc.CPU, cpuUsed))
		mem = AddGauge(mem, withUsed(alloc.Mem, memUsed))
		if PodPhase(p) == "Running" {
			running++
		}
		rows = append(rows, PodLineFor(p, metrics))
	}

	podCapacity := str(node, "status", "allocatable", "pods")
	if podCapacity == "" {
		podCapacity = q("status", "capacity", "pods")
	}

	return DetailView{
		Header: headerGroup(node),
		Groups: []FactGroup{
			{Facts: []Fact{
				schedulable,
				{Label: "Conditions", Chips: conditionChips(node), Wide: true},
				{Label: "kubelet", Text: dash(str(node, "status", "nodeInfo", "kubeletVersion"))},
				{Label: "OS Image", Text: dash(str(node, "status", "nodeInfo", "osImage"))},
				{Label: "Kernel", Text: dash(str(node, "status", "nodeInfo", "kernelVersion"))},
				{Label: "Container Runtime", Text: dash(str(node, "status", "nodeInfo", "containerRuntimeVersion"))},
				{Label: "Architecture", Text: dash(str(node, "status", "nodeInfo", "architecture"))},
				{Label: "Internal IP", Text: dash(addr("InternalIP"))},
				{Label: "External IP", Text: dash(addr("ExternalIP"))},
				{Label: "Hostname", Text: dash(addr("Hostname"))},
			}},
			{Title: "Capacity", Facts: []Fact{
				{Label: "CPU", Text: fmt.Sprintf("%s allocatable of %s",
					q("status", "allocatable", "cpu"), q("status", "capacity", "cpu"))},
				{Label: "Memory", Text: fmt.Sprintf("%s allocatable of %s",
					q("status", "allocatable", "memory"), q("status", "capacity", "memory"))},
				{Label: "Pods", Text: fmt.Sprintf("%d of %s", len(pods), podCapacity)},
				{Label: "Requested", Text: fmt.Sprintf("%.2f cores · %dMi",
					cpu.Requests, int64(math.Round(mem.Requests/1024/1024)))},
			}},
		},
		Containers: []ContainerView{},
		Pods: &PodsBlock{
			Desired: int64(len(pods)), Ready: running, Rows: rows,
		},
	}
}

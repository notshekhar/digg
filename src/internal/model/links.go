package model

import (
	"fmt"
	"sort"
	"strings"
)

// The pure half of "what is this connected to".
//
// detailview.go already walks a pod spec forwards — the ConfigMaps it mounts,
// the Secrets its env reads. That is only one direction, and it is the easy
// one. The questions people actually arrive with point the other way: which
// Deployment is behind this Service, who mounts this ConfigMap, what is routing
// to it, what breaks if I delete it. Answering those means matching selectors
// against labels, climbing owner chains, and searching other objects' specs for
// this object's name.
//
// Everything here is a pure function of objects the caller already fetched; the
// fetching lives in server/links.go.

// LabelsMatch reports whether every entry of sel appears in labels.
//
// An empty selector matches NOTHING here, which is deliberate and the opposite
// of what an empty metav1.LabelSelector means. A Service with no selector does
// not select every pod in the namespace — it selects none, and its endpoints
// are managed by hand. Treating empty as "matches all" would put the whole
// namespace behind an ExternalName service.
func LabelsMatch(sel, labels map[string]string) bool {
	if len(sel) == 0 {
		return false
	}
	for k, v := range sel {
		if labels[k] != v {
			return false
		}
	}
	return true
}

// ServiceSelector is a Service's spec.selector — a bare label map, not the
// matchLabels shape workloads use.
func ServiceSelector(o *Obj) map[string]string {
	return stringMap(o, "spec", "selector")
}

// TemplateLabels are the labels a workload stamps on the pods it creates. This
// is what a Service selector has to match for the workload to be "behind" it,
// and it is checkable without listing a single pod — which is how a Service
// with zero endpoints can still name the Deployment that was meant to serve it.
func TemplateLabels(o *Obj) map[string]string {
	return stringMap(o, "spec", "template", "metadata", "labels")
}

// SelectorLabels flattens a metav1.LabelSelector at the given path to its
// matchLabels. matchExpressions are not resolved — a selector that uses them
// cannot be answered by a map comparison, and guessing is worse than a gap.
func SelectorLabels(o *Obj, path ...string) map[string]string {
	return stringMap(o, append(append([]string{}, path...), "matchLabels")...)
}

// Uses reports how a spec reaches the named object, and whether it does at all.
// This is SpecRefs read backwards: given a ConfigMap, ask every workload
// whether it names it.
func (r *RefSet) Uses(kind, name string) (string, bool) {
	e, ok := r.found[kind+"/"+name]
	if !ok {
		return "", false
	}
	return summarizeVia(e.vias), true
}

// ── owner chains ────────────────────────────────────────────────────────────

// OwnerRef is the controller that made an object, as a link.
func OwnerRef(o *Obj) (Ref, bool) {
	kind, name, ok := controllerRef(o)
	if !ok {
		return Ref{}, false
	}
	return Ref{Kind: KindPlural(kind), Name: name, NS: o.GetNamespace()}, true
}

// KindPlural maps a Kind to the resource name digg routes on.
//
// The lowercase-plus-s rule is right for nearly everything and wrong for the
// handful of kinds whose plural is irregular; those are listed. A kind that is
// missing here still produces a working link if the guess happens to match, and
// a dead one if it does not — which is why the ones the workload graph actually
// walks through are all spelled out.
func KindPlural(kind string) string {
	lower := strings.ToLower(kind)
	if p, ok := irregularPlurals[lower]; ok {
		return p
	}
	switch {
	case strings.HasSuffix(lower, "s"), strings.HasSuffix(lower, "x"),
		strings.HasSuffix(lower, "ch"), strings.HasSuffix(lower, "sh"):
		return lower + "es"
	case strings.HasSuffix(lower, "y"):
		return strings.TrimSuffix(lower, "y") + "ies"
	}
	return lower + "s"
}

var irregularPlurals = map[string]string{
	"endpoints":         "endpoints",
	"networkpolicy":     "networkpolicies",
	"podsecuritypolicy": "podsecuritypolicies",
	"priorityclass":     "priorityclasses",
	"storageclass":      "storageclasses",
	"ingressclass":      "ingressclasses",
	"runtimeclass":      "runtimeclasses",
	"clusterrole":       "clusterroles",
	"componentstatus":   "componentstatuses",
}

// ── endpoints ───────────────────────────────────────────────────────────────

// EndpointAddr is one address behind a Service.
type EndpointAddr struct {
	IP      string
	Node    string
	PodName string
	PodNS   string
	Ready   bool
}

// EndpointsInfo is a parsed Endpoints object.
type EndpointsInfo struct {
	Ready    []EndpointAddr
	NotReady []EndpointAddr
	Ports    []string
}

// ParseEndpoints reads an Endpoints object into ready and not-ready addresses.
//
// The not-ready half is the point. `kubectl get endpoints` prints only the
// addresses that are serving, so a Service whose pods all failed their
// readiness probe looks identical to a Service whose selector matches nothing —
// both show none — and those are completely different bugs.
func ParseEndpoints(ep *Obj) EndpointsInfo {
	out := EndpointsInfo{Ready: []EndpointAddr{}, NotReady: []EndpointAddr{}, Ports: []string{}}
	if ep == nil {
		return out
	}
	seenPort := map[string]bool{}
	read := func(raw any, ready bool) EndpointAddr {
		a := asMap(raw)
		target := mmap(a, "targetRef")
		return EndpointAddr{
			IP:      mstr(a, "ip"),
			Node:    mstr(a, "nodeName"),
			PodName: mstr(target, "name"),
			PodNS:   mstr(target, "namespace"),
			Ready:   ready,
		}
	}
	for _, sraw := range slice(ep, "subsets") {
		s := asMap(sraw)
		for _, raw := range mslice(s, "addresses") {
			out.Ready = append(out.Ready, read(raw, true))
		}
		for _, raw := range mslice(s, "notReadyAddresses") {
			out.NotReady = append(out.NotReady, read(raw, false))
		}
		for _, raw := range mslice(s, "ports") {
			p := asMap(raw)
			proto := mstr(p, "protocol")
			if proto == "" {
				proto = "TCP"
			}
			text := mstr(p, "port") + "/" + proto
			if n := mstr(p, "name"); n != "" {
				text = n + ":" + text
			}
			if !seenPort[text] {
				seenPort[text] = true
				out.Ports = append(out.Ports, text)
			}
		}
	}
	return out
}

// AddressLines renders addresses that have no pod behind them — a
// hand-maintained Endpoints object pointing at something outside the cluster,
// which has no page to link to and would otherwise vanish from the page.
func (e EndpointsInfo) AddressLines() []string {
	out := []string{}
	for _, a := range e.Ready {
		if a.PodName == "" && a.IP != "" {
			out = append(out, a.IP)
		}
	}
	for _, a := range e.NotReady {
		if a.PodName == "" && a.IP != "" {
			out = append(out, a.IP+" (not ready)")
		}
	}
	return out
}

// ── ingress ─────────────────────────────────────────────────────────────────

// IngressBackends are the Service names an Ingress routes to, in rule order.
func IngressBackends(o *Obj) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(name string) {
		if name == "" || name == "—" || seen[name] {
			return
		}
		seen[name] = true
		out = append(out, name)
	}
	if svc := mapOf(o, "spec", "defaultBackend", "service"); svc != nil {
		add(mstr(svc, "name"))
	}
	for _, r := range IngressRuleRows(o) {
		add(r[2])
	}
	return out
}

// IngressTLSSecrets are the Secrets an Ingress terminates TLS with.
func IngressTLSSecrets(o *Obj) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, raw := range slice(o, "spec", "tls") {
		name := mstr(asMap(raw), "secretName")
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

// ── scale targets and subjects ──────────────────────────────────────────────

// ScaleTargetRef is the workload an HPA (or any scaleTargetRef holder) drives.
func ScaleTargetRef(o *Obj, path ...string) (Ref, bool) {
	m := mapOf(o, path...)
	name := mstr(m, "name")
	kind := mstr(m, "kind")
	if name == "" || kind == "" {
		return Ref{}, false
	}
	return Ref{Kind: KindPlural(kind), Name: name, NS: o.GetNamespace()}, true
}

// RoleRefLink is a binding's roleRef as a link. ClusterRole and Role live at
// different routes, and a RoleBinding may point at either.
func RoleRefLink(o *Obj) (Ref, bool) {
	m := mapOf(o, "roleRef")
	name, kind := mstr(m, "name"), mstr(m, "kind")
	if name == "" || kind == "" {
		return Ref{}, false
	}
	ref := Ref{Kind: KindPlural(kind), Name: name, Via: kind}
	if kind == "Role" {
		ref.NS = o.GetNamespace()
	}
	return ref, true
}

// SubjectLinks are a binding's subjects. Users and Groups have no object to
// open, so they come back as text; ServiceAccounts get a link.
func SubjectLinks(o *Obj) (refs []Ref, plain []string) {
	refs, plain = []Ref{}, []string{}
	for _, raw := range slice(o, "subjects") {
		s := asMap(raw)
		kind, name := mstr(s, "kind"), mstr(s, "name")
		if name == "" {
			continue
		}
		if kind == "ServiceAccount" {
			ns := mstr(s, "namespace")
			if ns == "" {
				ns = o.GetNamespace()
			}
			refs = append(refs, Ref{Kind: "serviceaccounts", Name: name, NS: ns, Via: ns})
			continue
		}
		plain = append(plain, kind+": "+name)
	}
	return refs, plain
}

// ServiceAccountSecrets are the Secrets a ServiceAccount hands out, and the
// ones it pulls images with.
func ServiceAccountSecrets(o *Obj) []Ref {
	ns := o.GetNamespace()
	out := []Ref{}
	seen := map[string]bool{}
	add := func(name, via string) {
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		out = append(out, Ref{Kind: kindSecrets, Name: name, NS: ns, Via: via})
	}
	for _, raw := range slice(o, "secrets") {
		add(mstr(asMap(raw), "name"), "token")
	}
	for _, raw := range slice(o, "imagePullSecrets") {
		add(mstr(asMap(raw), "name"), "image pull")
	}
	return out
}

// ── assembling groups ───────────────────────────────────────────────────────

// RefFact is a fact holding a list of links, or nothing when the list is empty.
// Callers append the result and let empty ones fall away, so a group never
// carries a heading with a dash under it.
func RefFact(label string, refs []Ref) (Fact, bool) {
	if len(refs) == 0 {
		return Fact{}, false
	}
	return Fact{Label: label, Refs: refs, Wide: true}, true
}

// DedupeRefs keeps the first occurrence of each kind/name, merging the `via`
// hints of the ones it drops. The same Deployment can be reached through six
// pods and should appear once, hinted "6 pods", not six times.
func DedupeRefs(refs []Ref) []Ref {
	order := []string{}
	byKey := map[string]Ref{}
	vias := map[string][]string{}
	for _, r := range refs {
		key := r.Kind + "/" + r.NS + "/" + r.Name
		if _, ok := byKey[key]; !ok {
			order = append(order, key)
			byKey[key] = r
			if r.Via != "" {
				vias[key] = []string{r.Via}
			}
			continue
		}
		if r.Via == "" {
			continue
		}
		found := false
		for _, v := range vias[key] {
			if v == r.Via {
				found = true
				break
			}
		}
		if !found {
			vias[key] = append(vias[key], r.Via)
		}
	}
	out := make([]Ref, 0, len(order))
	for _, key := range order {
		r := byKey[key]
		r.Via = summarizeVia(vias[key])
		out = append(out, r)
	}
	return out
}

// SortRefsByName orders links by name, so a list of twelve pods behind a
// Service reads the same way twice running.
func SortRefsByName(refs []Ref) []Ref {
	sort.SliceStable(refs, func(i, j int) bool {
		if refs[i].Kind != refs[j].Kind {
			return refs[i].Kind < refs[j].Kind
		}
		return refs[i].Name < refs[j].Name
	})
	return refs
}

// CountVia renders "3 pods" / "1 pod" for a link reached through several
// objects.
func CountVia(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

package server

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/notshekhar/digg/src/internal/kube"
	"github.com/notshekhar/digg/src/internal/model"
)

// The cluster half of "what is this connected to".
//
// A Kubernetes object is mostly pointers, and half of them point at it rather
// than out of it. A ConfigMap's YAML does not mention the four Deployments that
// mount it; a Service's YAML does not mention the Deployment behind it or the
// Ingress in front of it; a PVC does not know which pod has it open. Those are
// exactly the facts you go looking for, and finding them by hand means grepping
// a namespace.
//
// So every detail page — not just the seven kinds with a rich view — gets a
// Related block, built here. The rules:
//
//   - Reads go through ListCached, so a warm informer answers for free.
//   - Independent lists run concurrently; a page must not grow a serial round
//     trip per relation.
//   - A relation that resolves to nothing is dropped rather than shown empty. A
//     heading with a dash under it teaches you the link does not exist, which is
//     a different claim from "digg did not look".
//   - Pods that a controller owns are never listed alongside their controller.
//     Twelve pods and the one Deployment that made them is eleven rows of noise
//     and one answer.

// linkResolver holds one page build's worth of lookups.
type linkResolver struct {
	cl *kube.Cluster

	mu     sync.Mutex
	listed map[string][]model.Obj
}

func newLinkResolver(cl *kube.Cluster) *linkResolver {
	return &linkResolver{cl: cl, listed: map[string][]model.Obj{}}
}

// list reads a kind, memoised per page build. Several relations want the same
// namespace's pods, and the memo keeps that at one read even when the informer
// is cold.
func (r *linkResolver) list(kind, ns string) []model.Obj {
	key := kind + "/" + ns
	r.mu.Lock()
	if cached, ok := r.listed[key]; ok {
		r.mu.Unlock()
		return cached
	}
	r.mu.Unlock()

	items, err := r.cl.ListCached(kind, kube.ListOptions{Namespace: ns, ClusterScoped: ns == ""})
	if err != nil {
		items = nil
	}
	r.mu.Lock()
	r.listed[key] = items
	r.mu.Unlock()
	return items
}

// listMany fetches several (kind, namespace) pairs concurrently.
func (r *linkResolver) listMany(ns string, kinds ...string) map[string][]model.Obj {
	out := make(map[string][]model.Obj, len(kinds))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, kind := range kinds {
		wg.Add(1)
		go func(kind string) {
			defer wg.Done()
			items := r.list(kind, ns)
			mu.Lock()
			out[kind] = items
			mu.Unlock()
		}(kind)
	}
	wg.Wait()
	return out
}

func (r *linkResolver) find(kind, ns, name string) *model.Obj {
	items := r.list(kind, ns)
	for i := range items {
		if items[i].GetName() == name {
			return &items[i]
		}
	}
	return nil
}

// rootOwner climbs to the object a human actually edits.
//
// A pod's owner is a ReplicaSet nobody named and nobody wants; the answer to
// "what is behind this Service" is the Deployment above it. Same for a Job
// under a CronJob. One extra hop, and only through the two kinds that have a
// meaningless middle layer.
func (r *linkResolver) rootOwner(ns string, o *model.Obj) (model.Ref, bool) {
	ref, ok := model.OwnerRef(o)
	if !ok {
		return model.Ref{}, false
	}
	switch ref.Kind {
	case "replicasets", "jobs":
		if mid := r.find(ref.Kind, ns, ref.Name); mid != nil {
			if up, ok := model.OwnerRef(mid); ok {
				return up, true
			}
		}
	}
	return ref, true
}

// workloadsBehind names the controllers of a set of pods, each hinted with how
// many of those pods it accounts for.
func (r *linkResolver) workloadsBehind(ns string, pods []model.Obj) []model.Ref {
	counts := map[string]int{}
	order := []string{}
	byKey := map[string]model.Ref{}
	standalone := []model.Ref{}
	for i := range pods {
		p := &pods[i]
		ref, ok := r.rootOwner(ns, p)
		if !ok {
			// A pod nobody owns is its own answer — a bare pod behind a Service
			// is unusual enough that hiding it would be the wrong call.
			standalone = append(standalone,
				model.Ref{Kind: "pods", Name: p.GetName(), NS: p.GetNamespace(), Via: "bare pod"})
			continue
		}
		key := ref.Kind + "/" + ref.Name
		if _, seen := byKey[key]; !seen {
			order = append(order, key)
			byKey[key] = ref
		}
		counts[key]++
	}
	out := make([]model.Ref, 0, len(order)+len(standalone))
	for _, key := range order {
		ref := byKey[key]
		ref.Via = model.CountVia(counts[key], "pod")
		out = append(out, ref)
	}
	return append(out, standalone...)
}

// templateMatches finds the workloads whose pod template carries the labels a
// selector is looking for.
//
// This is how a Service with zero endpoints still names the Deployment that was
// supposed to serve it: the pods are gone or unschedulable, but the template
// that would produce them is right there, and that is the object to go and fix.
func (r *linkResolver) templateMatches(ns string, selector map[string]string, via string) []model.Ref {
	if len(selector) == 0 {
		return nil
	}
	kinds := []string{"deployments", "statefulsets", "daemonsets"}
	lists := r.listMany(ns, kinds...)
	out := []model.Ref{}
	for _, kind := range kinds {
		items := lists[kind]
		for i := range items {
			if model.LabelsMatch(selector, model.TemplateLabels(&items[i])) {
				out = append(out, model.Ref{
					Kind: kind, Name: items[i].GetName(), NS: ns, Via: via})
			}
		}
	}
	return out
}

// selectedPods are the pods a bare label map matches.
func (r *linkResolver) selectedPods(ns string, selector map[string]string) []model.Obj {
	if len(selector) == 0 {
		return nil
	}
	all := r.list("pods", ns)
	out := []model.Obj{}
	for i := range all {
		if model.LabelsMatch(selector, all[i].GetLabels()) {
			out = append(out, all[i])
		}
	}
	return out
}

// podRefs turns pods into links, folding away the ones a controller owns so a
// list of twelve replicas becomes the one Deployment that made them.
func (r *linkResolver) podRefs(ns string, pods []model.Obj, limit int) []model.Ref {
	refs := r.workloadsBehind(ns, pods)
	if limit > 0 && len(refs) > limit {
		refs = refs[:limit]
	}
	return refs
}

// ── the per-kind resolvers ──────────────────────────────────────────────────

// BuildLinks resolves every relation a kind has, as fact groups the detail page
// renders under "Related".
func BuildLinks(cl *kube.Cluster, kindName string, o *model.Obj) []model.FactGroup {
	if o == nil {
		return nil
	}
	r := newLinkResolver(cl)
	ns := o.GetNamespace()
	facts := []model.Fact{}

	add := func(label string, refs []model.Ref) {
		refs = model.DedupeRefs(refs)
		if f, ok := model.RefFact(label, refs); ok {
			facts = append(facts, f)
		}
	}
	addText := func(label string, lines []string) {
		if len(lines) > 0 {
			facts = append(facts, model.Fact{Label: label, Items: lines, Wide: true})
		}
	}

	switch {
	case kindName == "services":
		serviceLinks(r, o, ns, add)
	case kindName == "pods":
		podLinks(r, o, ns, add)
	case model.WorkloadKinds[kindName]:
		workloadLinks(r, o, ns, add)
	case kindName == "cronjobs":
		cronjobLinks(r, o, ns, add)
	case kindName == "ingresses":
		ingressLinks(r, o, ns, add)
	case kindName == "configmaps", kindName == "secrets":
		dataLinks(r, o, kindName, ns, add)
	case kindName == "persistentvolumeclaims":
		pvcLinks(r, o, ns, add)
	case kindName == "persistentvolumes":
		pvLinks(r, o, add)
	case kindName == "serviceaccounts":
		serviceAccountLinks(r, o, ns, add)
	case kindName == "rolebindings", kindName == "clusterrolebindings":
		bindingLinks(o, add, addText)
	case kindName == "roles", kindName == "clusterroles":
		roleLinks(r, o, kindName, ns, add)
	case kindName == "horizontalpodautoscalers":
		scaleTargetLinks(o, add)
	case kindName == "poddisruptionbudgets", kindName == "networkpolicies":
		selectorLinks(r, o, kindName, ns, add)
	case kindName == "endpoints", kindName == "endpointslices":
		endpointLinks(r, o, kindName, ns, add)
	case kindName == "storageclasses":
		storageClassLinks(r, o, add)
	case kindName == "ingressclasses":
		ingressClassLinks(r, o, add)
	case kindName == "priorityclasses":
		priorityClassLinks(r, o, add)
	case kindName == "nodes":
		nodeLinks(r, o, add)
	case kindName == "namespaces":
		namespaceLinks(r, o, add)
	}

	// The owner is a link every namespaced object may have, and only the rich
	// pages show it in their header. Adding it here for the rest means a
	// ControllerRevision or an EndpointSlice you landed on from a search still
	// tells you what made it.
	if !model.RichKinds[kindName] {
		if ref, ok := model.OwnerRef(o); ok {
			facts = append(facts, model.Fact{
				Label: "Owned By", Refs: []model.Ref{ref}, Wide: true})
		}
	}

	if len(facts) == 0 {
		return nil
	}
	return []model.FactGroup{{Title: "Related", Facts: facts}}
}

type addFn func(label string, refs []model.Ref)

// serviceLinks answers the two questions a Service page exists for: what is
// serving this, and what is pointing at it.
func serviceLinks(r *linkResolver, o *model.Obj, ns string, add addFn) {
	name := o.GetName()
	selector := model.ServiceSelector(o)

	pods := r.selectedPods(ns, selector)
	behind := r.workloadsBehind(ns, pods)
	// No pods at all: fall back to the templates, which still name the workload
	// that is meant to be here.
	if len(behind) == 0 {
		behind = r.templateMatches(ns, selector, "template matches")
	}
	add("Backed By", behind)

	// Everything routing to this Service, by name.
	ingressRefs := []model.Ref{}
	for _, ing := range r.list("ingresses", ns) {
		for _, backend := range model.IngressBackends(&ing) {
			if backend == name {
				ingressRefs = append(ingressRefs, model.Ref{
					Kind: "ingresses", Name: ing.GetName(), NS: ns, Via: "backend"})
				break
			}
		}
	}
	add("Routed From", ingressRefs)

	// The Endpoints object itself, so the addresses can be read raw when the
	// parsed view is not enough.
	if ep := r.find("endpoints", ns, name); ep != nil {
		add("Endpoints", []model.Ref{{Kind: "endpoints", Name: name, NS: ns}})
	}

	// HPAs and PDBs do not name a Service, but they name the workload behind it,
	// and "will this scale / can I drain it" is a Service-level question.
	governing := []model.Ref{}
	for _, ref := range behind {
		governing = append(governing, r.governorsOf(ns, ref)...)
	}
	add("Governed By", governing)
}

// governorsOf finds the HPAs that scale a workload and the PDBs that protect
// its pods.
func (r *linkResolver) governorsOf(ns string, workload model.Ref) []model.Ref {
	out := []model.Ref{}
	for _, hpa := range r.list("horizontalpodautoscalers", ns) {
		target, ok := model.ScaleTargetRef(&hpa, "spec", "scaleTargetRef")
		if ok && target.Kind == workload.Kind && target.Name == workload.Name {
			out = append(out, model.Ref{Kind: "horizontalpodautoscalers",
				Name: hpa.GetName(), NS: ns, Via: "scales " + workload.Name})
		}
	}
	obj := r.find(workload.Kind, ns, workload.Name)
	if obj == nil {
		return out
	}
	labels := model.TemplateLabels(obj)
	for _, pdb := range r.list("poddisruptionbudgets", ns) {
		if model.LabelsMatch(model.SelectorLabels(&pdb, "spec", "selector"), labels) {
			out = append(out, model.Ref{Kind: "poddisruptionbudgets",
				Name: pdb.GetName(), NS: ns, Via: "protects " + workload.Name})
		}
	}
	return out
}

// podLinks point at everything that reaches this pod from outside its own spec.
func podLinks(r *linkResolver, o *model.Obj, ns string, add addFn) {
	labels := o.GetLabels()

	services := []model.Ref{}
	serving := map[string]bool{}
	for _, svc := range r.list("services", ns) {
		if model.LabelsMatch(model.ServiceSelector(&svc), labels) {
			services = append(services, model.Ref{
				Kind: "services", Name: svc.GetName(), NS: ns, Via: "selects this pod"})
			serving[svc.GetName()] = true
		}
	}
	add("Exposed By", services)

	// One hop further out: the Ingresses whose backend is one of those Services.
	// Two hops is what it takes to answer "is this pod reachable from outside",
	// and nothing in the pod's YAML hints at either of them.
	if len(serving) > 0 {
		ingressRefs := []model.Ref{}
		for _, ing := range r.list("ingresses", ns) {
			for _, backend := range model.IngressBackends(&ing) {
				if serving[backend] {
					ingressRefs = append(ingressRefs, model.Ref{
						Kind: "ingresses", Name: ing.GetName(), NS: ns, Via: "via " + backend})
					break
				}
			}
		}
		add("Reachable Through", ingressRefs)
	}

	// The controller two levels up: a pod's header names its ReplicaSet, and the
	// Deployment above it is the thing you scale, roll back, and edit.
	if direct, ok := model.OwnerRef(o); ok {
		if root, found := r.rootOwner(ns, o); found && root.Kind != direct.Kind {
			root.Via = "controller"
			add("Managed By", []model.Ref{root})
		}
	}

	add("Protected By", r.pdbsFor(ns, labels))
}

func (r *linkResolver) pdbsFor(ns string, labels map[string]string) []model.Ref {
	out := []model.Ref{}
	for _, pdb := range r.list("poddisruptionbudgets", ns) {
		if model.LabelsMatch(model.SelectorLabels(&pdb, "spec", "selector"), labels) {
			out = append(out, model.Ref{
				Kind: "poddisruptionbudgets", Name: pdb.GetName(), NS: ns})
		}
	}
	return out
}

// workloadLinks are a Deployment's outward relations — the ones its own spec
// does not carry.
func workloadLinks(r *linkResolver, o *model.Obj, ns string, add addFn) {
	labels := model.TemplateLabels(o)
	name := o.GetName()

	services := []model.Ref{}
	serving := map[string]bool{}
	for _, svc := range r.list("services", ns) {
		if model.LabelsMatch(model.ServiceSelector(&svc), labels) {
			services = append(services, model.Ref{
				Kind: "services", Name: svc.GetName(), NS: ns, Via: "selects these pods"})
			serving[svc.GetName()] = true
		}
	}
	add("Exposed By", services)

	if len(serving) > 0 {
		ingressRefs := []model.Ref{}
		for _, ing := range r.list("ingresses", ns) {
			for _, backend := range model.IngressBackends(&ing) {
				if serving[backend] {
					ingressRefs = append(ingressRefs, model.Ref{
						Kind: "ingresses", Name: ing.GetName(), NS: ns, Via: "via " + backend})
					break
				}
			}
		}
		add("Reachable Through", ingressRefs)
	}

	hpas := []model.Ref{}
	for _, hpa := range r.list("horizontalpodautoscalers", ns) {
		target, ok := model.ScaleTargetRef(&hpa, "spec", "scaleTargetRef")
		if ok && target.Name == name && target.Kind == pluralOfKind(o) {
			hpas = append(hpas, model.Ref{
				Kind: "horizontalpodautoscalers", Name: hpa.GetName(), NS: ns, Via: "scales this"})
		}
	}
	add("Scaled By", hpas)
	add("Protected By", r.pdbsFor(ns, labels))
}

func pluralOfKind(o *model.Obj) string { return model.KindPlural(o.GetKind()) }

func cronjobLinks(r *linkResolver, o *model.Obj, ns string, add addFn) {
	labels := model.TemplateLabels(o)
	if len(labels) == 0 {
		// A CronJob's template labels live one level deeper than a Deployment's.
		labels = nestedStringMap(o, "spec", "jobTemplate", "spec", "template", "metadata", "labels")
	}
	services := []model.Ref{}
	for _, svc := range r.list("services", ns) {
		if model.LabelsMatch(model.ServiceSelector(&svc), labels) {
			services = append(services, model.Ref{
				Kind: "services", Name: svc.GetName(), NS: ns, Via: "selects these pods"})
		}
	}
	add("Exposed By", services)
}

// ingressLinks follow every name in the routing table.
func ingressLinks(r *linkResolver, o *model.Obj, ns string, add addFn) {
	backends := model.IngressBackends(o)
	refs := make([]model.Ref, 0, len(backends))
	missing := []model.Ref{}
	for _, name := range backends {
		if r.find("services", ns, name) != nil {
			refs = append(refs, model.Ref{Kind: "services", Name: name, NS: ns, Via: "backend"})
			continue
		}
		// A backend that does not exist is the ordinary way an Ingress breaks,
		// and it stays a link: opening it and getting "not found" is a clearer
		// answer than a name that was never clickable.
		missing = append(missing, model.Ref{
			Kind: "services", Name: name, NS: ns, Via: "backend — no such Service"})
	}
	add("Routes To", append(refs, missing...))

	secrets := []model.Ref{}
	for _, name := range model.IngressTLSSecrets(o) {
		via := "TLS"
		if r.find("secrets", ns, name) == nil {
			via = "TLS — missing"
		}
		secrets = append(secrets, model.Ref{Kind: "secrets", Name: name, NS: ns, Via: via})
	}
	add("TLS Secrets", secrets)

	if class := nestedString(o, "spec", "ingressClassName"); class != "" {
		add("Ingress Class", []model.Ref{{Kind: "ingressclasses", Name: class}})
	}
}

// dataLinks are the reverse of the References group on a workload page: given a
// ConfigMap or Secret, who reaches for it.
func dataLinks(r *linkResolver, o *model.Obj, kindName, ns string, add addFn) {
	name := o.GetName()
	kinds := []string{"deployments", "statefulsets", "daemonsets", "cronjobs", "jobs", "pods"}
	lists := r.listMany(ns, kinds...)

	users := []model.Ref{}
	// A controlled pod is FOLDED into its controller, not dropped.
	//
	// Dropping it was wrong, and quietly: the kubelet injects references the
	// template never carries — every pod on a modern cluster projects
	// kube-root-ca.crt — so a ConfigMap that seven running pods mount reported
	// that nobody used it. Only the pod knows, and the answer is still the
	// Deployment above it.
	matched := []model.Obj{}
	for _, kind := range kinds {
		for i := range lists[kind] {
			obj := &lists[kind][i]
			refs := model.SpecRefs(model.PodSpecOf(obj))
			via, ok := refs.Uses(kindName, name)
			if !ok {
				continue
			}
			if kind == "pods" {
				if _, owned := model.OwnerRef(obj); owned {
					matched = append(matched, *obj)
					continue
				}
			}
			users = append(users, model.Ref{
				Kind: kind, Name: obj.GetName(), NS: ns, Via: via})
		}
	}
	// DedupeRefs merges the two hints when a workload is reached both ways —
	// "envFrom in api, 3 pods" — which is more informative than either alone.
	users = append(users, r.workloadsBehind(ns, matched)...)
	add("Used By", capRefs(model.DedupeRefs(users), 25))

	if kindName != "secrets" {
		return
	}
	// The two places a Secret is named by something that is not a pod spec.
	sas := []model.Ref{}
	for _, sa := range r.list("serviceaccounts", ns) {
		for _, ref := range model.ServiceAccountSecrets(&sa) {
			if ref.Name == name {
				sas = append(sas, model.Ref{Kind: "serviceaccounts",
					Name: sa.GetName(), NS: ns, Via: ref.Via})
			}
		}
	}
	add("Service Accounts", sas)

	ingresses := []model.Ref{}
	for _, ing := range r.list("ingresses", ns) {
		for _, secret := range model.IngressTLSSecrets(&ing) {
			if secret == name {
				ingresses = append(ingresses, model.Ref{
					Kind: "ingresses", Name: ing.GetName(), NS: ns, Via: "TLS"})
				break
			}
		}
	}
	add("TLS For", ingresses)
}

func pvcLinks(r *linkResolver, o *model.Obj, ns string, add addFn) {
	name := o.GetName()
	if volume := nestedString(o, "spec", "volumeName"); volume != "" {
		add("Bound Volume", []model.Ref{{Kind: "persistentvolumes", Name: volume}})
	}
	if class := nestedString(o, "spec", "storageClassName"); class != "" {
		add("Storage Class", []model.Ref{{Kind: "storageclasses", Name: class}})
	}

	mounting := []model.Obj{}
	for _, pod := range r.list("pods", ns) {
		if model.PodMountsPVC(&pod, name) {
			mounting = append(mounting, pod)
		}
	}
	// A PVC with a writer is a PVC you cannot delete, and the pod holding it is
	// the thing to look at — folded to its controller, same as everywhere else.
	add("Mounted By", r.podRefs(ns, mounting, 0))

	if src := nestedString(o, "spec", "dataSource", "name"); src != "" {
		kind := nestedString(o, "spec", "dataSource", "kind")
		add("Cloned From", []model.Ref{{
			Kind: model.KindPlural(kind), Name: src, NS: ns, Via: kind}})
	}
}

func pvLinks(r *linkResolver, o *model.Obj, add addFn) {
	claimName := nestedString(o, "spec", "claimRef", "name")
	claimNS := nestedString(o, "spec", "claimRef", "namespace")
	if claimName != "" {
		add("Claimed By", []model.Ref{{
			Kind: "persistentvolumeclaims", Name: claimName, NS: claimNS, Via: claimNS}})
	}
	if class := nestedString(o, "spec", "storageClassName"); class != "" {
		add("Storage Class", []model.Ref{{Kind: "storageclasses", Name: class}})
	}
	if secret := nestedString(o, "spec", "csi", "nodePublishSecretRef", "name"); secret != "" {
		secretNS := nestedString(o, "spec", "csi", "nodePublishSecretRef", "namespace")
		add("CSI Secret", []model.Ref{{Kind: "secrets", Name: secret, NS: secretNS}})
	}
}

func serviceAccountLinks(r *linkResolver, o *model.Obj, ns string, add addFn) {
	name := o.GetName()
	add("Secrets", model.ServiceAccountSecrets(o))

	pods := []model.Obj{}
	for _, pod := range r.list("pods", ns) {
		spec := model.PodSpecOf(&pod)
		sa := mapString(spec, "serviceAccountName")
		if sa == "" {
			sa = mapString(spec, "serviceAccount")
		}
		if sa == name || (sa == "" && name == "default") {
			pods = append(pods, pod)
		}
	}
	add("Used By", r.podRefs(ns, pods, 0))

	// Which permissions this identity actually has: every binding naming it as a
	// subject, namespaced and cluster-wide.
	bindings := []model.Ref{}
	for _, kind := range []string{"rolebindings", "clusterrolebindings"} {
		scope := ns
		if kind == "clusterrolebindings" {
			scope = ""
		}
		for _, b := range r.list(kind, scope) {
			refs, _ := model.SubjectLinks(&b)
			for _, s := range refs {
				if s.Name != name || (s.NS != "" && s.NS != ns) {
					continue
				}
				via := "subject"
				if role, ok := model.RoleRefLink(&b); ok {
					via = role.Kind + "/" + role.Name
				}
				bindings = append(bindings, model.Ref{
					Kind: kind, Name: b.GetName(), NS: b.GetNamespace(), Via: via})
				break
			}
		}
	}
	add("Bound By", bindings)
}

func bindingLinks(o *model.Obj, add addFn, addText func(string, []string)) {
	if role, ok := model.RoleRefLink(o); ok {
		add("Grants", []model.Ref{role})
	}
	refs, plain := model.SubjectLinks(o)
	add("Subjects", refs)
	addText("Other Subjects", plain)
}

func roleLinks(r *linkResolver, o *model.Obj, kindName, ns string, add addFn) {
	name := o.GetName()
	wantKind := "Role"
	if kindName == "clusterroles" {
		wantKind = "ClusterRole"
	}
	// A ClusterRole can be granted by a RoleBinding in any namespace, so this is
	// the one relation that has to look cluster-wide.
	bindingKinds := map[string]string{"rolebindings": ns, "clusterrolebindings": ""}
	if kindName == "clusterroles" {
		bindingKinds["rolebindings"] = ""
	}

	bindings := []model.Ref{}
	for kind, scope := range bindingKinds {
		for _, b := range r.list(kind, scope) {
			ref := nestedMap(&b, "roleRef")
			if mapString(ref, "kind") != wantKind || mapString(ref, "name") != name {
				continue
			}
			via := "grants this"
			if bns := b.GetNamespace(); bns != "" {
				via = "in " + bns
			}
			bindings = append(bindings, model.Ref{
				Kind: kind, Name: b.GetName(), NS: b.GetNamespace(), Via: via})
		}
	}
	sort.Slice(bindings, func(i, j int) bool { return bindings[i].Name < bindings[j].Name })
	add("Granted By", bindings)
}

func scaleTargetLinks(o *model.Obj, add addFn) {
	if ref, ok := model.ScaleTargetRef(o, "spec", "scaleTargetRef"); ok {
		ref.Via = "scale target"
		add("Scales", []model.Ref{ref})
	}
}

// selectorLinks cover the kinds whose whole job is a label selector — a PDB and
// a NetworkPolicy both say "these pods", and neither says which.
func selectorLinks(r *linkResolver, o *model.Obj, kindName, ns string, add addFn) {
	path := []string{"spec", "selector"}
	if kindName == "networkpolicies" {
		path = []string{"spec", "podSelector"}
	}
	selector := model.SelectorLabels(o, path...)
	pods := r.selectedPods(ns, selector)
	add("Applies To", r.podRefs(ns, pods, 0))
	if len(pods) == 0 {
		add("Would Apply To", r.templateMatches(ns, selector, "template matches"))
	}
}

func endpointLinks(r *linkResolver, o *model.Obj, kindName, ns string, add addFn) {
	name := o.GetName()
	if kindName == "endpointslices" {
		if svc := o.GetLabels()["kubernetes.io/service-name"]; svc != "" {
			name = svc
		}
	}
	if r.find("services", ns, name) != nil {
		add("Service", []model.Ref{{Kind: "services", Name: name, NS: ns}})
	}

	info := model.ParseEndpoints(o)
	refs := []model.Ref{}
	for _, a := range append(append([]model.EndpointAddr{}, info.Ready...), info.NotReady...) {
		if a.PodName == "" {
			continue
		}
		podNS := a.PodNS
		if podNS == "" {
			podNS = ns
		}
		via := a.IP
		if !a.Ready {
			via += " (not ready)"
		}
		refs = append(refs, model.Ref{Kind: "pods", Name: a.PodName, NS: podNS, Via: via})
	}
	// EndpointSlices keep their targets under `endpoints`, not `subsets`.
	for _, raw := range nestedSlice(o, "endpoints") {
		e, _ := raw.(map[string]any)
		target, _ := e["targetRef"].(map[string]any)
		podName := mapString(target, "name")
		if podName == "" {
			continue
		}
		podNS := mapString(target, "namespace")
		if podNS == "" {
			podNS = ns
		}
		refs = append(refs, model.Ref{Kind: "pods", Name: podName, NS: podNS})
	}
	add("Targets", refs)
}

func storageClassLinks(r *linkResolver, o *model.Obj, add addFn) {
	name := o.GetName()
	claims := []model.Ref{}
	for _, pvc := range r.list("persistentvolumeclaims", "") {
		if nestedString(&pvc, "spec", "storageClassName") == name {
			claims = append(claims, model.Ref{Kind: "persistentvolumeclaims",
				Name: pvc.GetName(), NS: pvc.GetNamespace(), Via: pvc.GetNamespace()})
		}
	}
	add("Claims", capRefs(claims, 25))
}

func ingressClassLinks(r *linkResolver, o *model.Obj, add addFn) {
	name := o.GetName()
	ingresses := []model.Ref{}
	for _, ing := range r.list("ingresses", "") {
		if nestedString(&ing, "spec", "ingressClassName") == name {
			ingresses = append(ingresses, model.Ref{Kind: "ingresses",
				Name: ing.GetName(), NS: ing.GetNamespace(), Via: ing.GetNamespace()})
		}
	}
	add("Ingresses", capRefs(ingresses, 25))
}

func priorityClassLinks(r *linkResolver, o *model.Obj, add addFn) {
	name := o.GetName()
	pods := []model.Obj{}
	for _, pod := range r.list("pods", "") {
		if nestedString(&pod, "spec", "priorityClassName") == name {
			pods = append(pods, pod)
		}
	}
	refs := []model.Ref{}
	for i := range pods {
		p := &pods[i]
		ref, ok := r.rootOwner(p.GetNamespace(), p)
		if !ok {
			ref = model.Ref{Kind: "pods", Name: p.GetName(), NS: p.GetNamespace()}
		}
		ref.Via = p.GetNamespace()
		refs = append(refs, ref)
	}
	add("Used By", capRefs(refs, 25))
}

func nodeLinks(r *linkResolver, o *model.Obj, add addFn) {
	// A node's pods are already its main table; what is missing is the volumes
	// physically attached to it, which is what a stuck detach looks like.
	attached := []model.Ref{}
	for _, raw := range nestedSlice(o, "status", "volumesAttached") {
		v, _ := raw.(map[string]any)
		name := mapString(v, "name")
		// "kubernetes.io/csi/ebs.csi.aws.com^vol-0abc" — the PV name is the tail.
		if idx := strings.LastIndex(name, "^"); idx >= 0 {
			name = name[idx+1:]
		} else if idx := strings.LastIndex(name, "/"); idx >= 0 {
			name = name[idx+1:]
		}
		if name != "" {
			attached = append(attached, model.Ref{Kind: "persistentvolumes", Name: name})
		}
	}
	add("Attached Volumes", capRefs(attached, 25))
}

func namespaceLinks(r *linkResolver, o *model.Obj, add addFn) {
	ns := o.GetName()
	refs := []model.Ref{}
	for _, kind := range []string{"resourcequotas", "limitranges"} {
		for _, item := range r.list(kind, ns) {
			refs = append(refs, model.Ref{Kind: kind, Name: item.GetName(), NS: ns})
		}
	}
	add("Governed By", refs)
}

// capRefs keeps a cluster-wide list readable. Twenty-five links is a list;
// three hundred is a wall, and the table for that kind is one click away.
//
// The overflow marker carries no kind, which is what tells the client to draw
// it as text rather than a link to nowhere.
func capRefs(refs []model.Ref, limit int) []model.Ref {
	if len(refs) <= limit {
		return refs
	}
	out := append([]model.Ref{}, refs[:limit]...)
	return append(out, model.Ref{Name: fmt.Sprintf("+%d more", len(refs)-limit)})
}

// mapString reads a string out of a decoded map, the way model's mstr does for
// its own package.
func mapString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	s, _ := v.(string)
	return s
}

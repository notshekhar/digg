package server

import (
	"sort"
	"strings"

	"github.com/notshekhar/digg/src/internal/kube"
	"github.com/notshekhar/digg/src/internal/model"
)

// The navigation catalog. Port of src/web/catalog.ts.
//
// Every kind the cluster exposes, arranged into the groups an operator already
// thinks in (Workloads, Config, Network, Storage, Access Control, …) instead of
// the flat alphabetical list `kubectl api-resources` returns.
//
// Two rules make this honest on any cluster:
//
//  1. NOTHING IS LISTED THAT ISN'T THERE. A curated kind only appears if
//     discovery saw it. A 1.20 cluster has no EndpointSlices and a bare kind
//     cluster has no HPAs; showing the row anyway just yields a 404 on click.
//  2. NOTHING THAT IS THERE IS HIDDEN. Anything discovered but not curated
//     lands under Custom Resources, bucketed by API group, so CRDs are
//     first-class rather than a search-only afterthought.

// CatalogKind is one row of the rail.
type CatalogKind struct {
	Name          string   `json:"name"`
	Title         string   `json:"title"`
	Kind          string   `json:"kind"`
	ClusterScoped bool     `json:"clusterScoped"`
	Generic       bool     `json:"generic"`
	Columns       []string `json:"columns"`
	// APIVersion as discovery reported it, e.g. "apps/v1" — "" when unknown.
	APIVersion string   `json:"apiVersion"`
	ShortNames []string `json:"shortNames"`
}

// CatalogGroup is one titled section of the rail.
type CatalogGroup struct {
	ID    string        `json:"id"`
	Title string        `json:"title"`
	Kinds []CatalogKind `json:"kinds"`
}

// groups is the curated layout. Order is deliberate: it is the rail, top to
// bottom.
var groups = []struct {
	id, title string
	kinds     []string
}{
	{"cluster", "Cluster", []string{"nodes", "namespaces", "events"}},
	{"workloads", "Workloads", []string{
		"pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs"}},
	{"config", "Config", []string{
		"configmaps", "secrets", "resourcequotas", "limitranges", "horizontalpodautoscalers",
		"poddisruptionbudgets", "priorityclasses", "runtimeclasses", "leases",
		"mutatingwebhookconfigurations", "validatingwebhookconfigurations"}},
	{"network", "Network", []string{
		"services", "endpoints", "endpointslices", "ingresses", "ingressclasses", "networkpolicies"}},
	{"storage", "Storage", []string{
		"persistentvolumeclaims", "persistentvolumes", "storageclasses"}},
	{"access", "Access Control", []string{
		"serviceaccounts", "roles", "rolebindings", "clusterroles", "clusterrolebindings"}},
	{"definitions", "Definitions", []string{"customresourcedefinitions"}},
}

// builtinGroups ship with Kubernetes — everything else is somebody's CRD.
var builtinGroups = map[string]bool{
	"":                             true,
	"v1":                           true,
	"apps":                         true,
	"batch":                        true,
	"autoscaling":                  true,
	"policy":                       true,
	"networking.k8s.io":            true,
	"storage.k8s.io":               true,
	"rbac.authorization.k8s.io":    true,
	"apiextensions.k8s.io":         true,
	"admissionregistration.k8s.io": true,
	"coordination.k8s.io":          true,
	"scheduling.k8s.io":            true,
	"node.k8s.io":                  true,
	"authentication.k8s.io":        true,
	"authorization.k8s.io":         true,
	"certificates.k8s.io":          true,
	"discovery.k8s.io":             true,
	"events.k8s.io":                true,
	"flowcontrol.apiserver.k8s.io": true,
	"apiregistration.k8s.io":       true,
	"metrics.k8s.io":               true,
	// Dynamic Resource Allocation, GA in 1.34 — a built-in group, not a CRD.
	"resource.k8s.io":           true,
	"storagemigration.k8s.io":   true,
	"internal.apiserver.k8s.io": true,
}

func apiGroupOf(apiVersion string) string {
	if i := strings.Index(apiVersion, "/"); i >= 0 {
		return apiVersion[:i]
	}
	return ""
}

func groupTitle(group string) string {
	if group == "" {
		return "core"
	}
	return group
}

func toCatalogKind(def *model.KindDef, found *kube.DiscoveredResource) CatalogKind {
	k := CatalogKind{
		Name:          def.Name,
		Title:         def.Title,
		Kind:          def.Kind,
		ClusterScoped: def.ClusterScoped,
		Generic:       def.Generic,
		Columns:       def.Columns,
		ShortNames:    []string{},
	}
	if found != nil {
		k.APIVersion = found.APIVersion
		if found.ShortNames != nil {
			k.ShortNames = found.ShortNames
		}
	}
	return k
}

// BuildCatalog builds the full navigation catalog.
//
// discovered may be empty (old cluster, RBAC-restricted user, discovery
// failed) — in that case we fall back to showing every curated kind, because an
// empty sidebar is worse than a sidebar with a few rows that 403.
func BuildCatalog(discovered []kube.DiscoveredResource) []CatalogGroup {
	byName := map[string]*kube.DiscoveredResource{}
	for i := range discovered {
		byName[discovered[i].Name] = &discovered[i]
	}
	trustDiscovery := len(discovered) > 0
	claimed := map[string]bool{}
	out := []CatalogGroup{}

	for _, g := range groups {
		kinds := []CatalogKind{}
		for _, name := range g.kinds {
			def := model.FindKind(name)
			if def == nil {
				continue
			}
			found := byName[name]
			if trustDiscovery && found == nil {
				continue
			}
			claimed[name] = true
			kinds = append(kinds, toCatalogKind(def, found))
		}
		if len(kinds) > 0 {
			out = append(out, CatalogGroup{ID: g.id, Title: g.title, Kinds: kinds})
		}
	}

	// Built-in kinds that exist on the cluster but no curated group claims —
	// CSIDrivers, APIServices, FlowSchemas and friends. They get a generic list
	// rather than disappearing.
	other := []CatalogKind{}
	custom := map[string][]CatalogKind{}

	for i := range discovered {
		d := &discovered[i]
		if claimed[d.Name] {
			continue
		}
		def := model.FindKind(d.Name)
		if def == nil {
			g := model.GenericKind(model.DiscoveredResource{
				Name: d.Name, Kind: d.Kind, Namespaced: d.Namespaced})
			def = &g
		}
		entry := toCatalogKind(def, d)
		group := apiGroupOf(d.APIVersion)
		if builtinGroups[group] {
			other = append(other, entry)
		} else {
			custom[group] = append(custom[group], entry)
		}
	}

	customGroups := make([]string, 0, len(custom))
	for g := range custom {
		customGroups = append(customGroups, g)
	}
	sort.Strings(customGroups)
	for _, g := range customGroups {
		kinds := custom[g]
		sort.Slice(kinds, func(i, j int) bool { return kinds[i].Title < kinds[j].Title })
		out = append(out, CatalogGroup{ID: "crd:" + g, Title: groupTitle(g), Kinds: kinds})
	}

	if len(other) > 0 {
		sort.Slice(other, func(i, j int) bool { return other[i].Title < other[j].Title })
		out = append(out, CatalogGroup{ID: "other", Title: "Other", Kinds: other})
	}
	return out
}

// CatalogKinds is a flat lookup over the catalog, for the command palette and
// deep links.
func CatalogKinds(groups []CatalogGroup) []CatalogKind {
	out := []CatalogKind{}
	for _, g := range groups {
		out = append(out, g.Kinds...)
	}
	return out
}

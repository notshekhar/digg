package kube

import (
	"context"
	"fmt"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func ctxBG() context.Context     { return context.Background() }
func getOpts() metav1.GetOptions { return metav1.GetOptions{} }
func listOpts(sel string) metav1.ListOptions {
	return metav1.ListOptions{LabelSelector: sel}
}

// labelsToSelector renders a label map as the "a=b,c=d" selector string the API
// takes. Sorted, so the same map always produces the same string.
func labelsToSelector(m map[string]string) string {
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
		parts = append(parts, k+"="+m[k])
	}
	return strings.Join(parts, ",")
}

// LabelSelectorOf renders a bare label map as the "a=b,c=d" selector the API
// takes. A Service's spec.selector is already that shape, unlike a workload's,
// so it needs no unwrapping — just the deterministic rendering.
func LabelSelectorOf(m map[string]string) string { return labelsToSelector(m) }

// SpecSelector builds a label selector from a workload's OWN spec.selector.
//
// Port of workloadSelector() in src/format.ts. Workload usage is computed from
// pods matched this way rather than via a ReplicaSet round trip, and
// matchExpressions has to be honoured or a workload using them silently matches
// nothing.
func SpecSelector(obj *unstructured.Unstructured) string {
	sel, found, err := unstructured.NestedMap(obj.Object, "spec", "selector")
	if err != nil || !found {
		return ""
	}

	parts := []string{}

	// A bare map (Service-style) is already matchLabels.
	if ml, ok, _ := unstructured.NestedStringMap(obj.Object, "spec", "selector", "matchLabels"); ok {
		if s := labelsToSelector(ml); s != "" {
			parts = append(parts, s)
		}
	} else if _, hasExpr := sel["matchExpressions"]; !hasExpr {
		if bare, ok, _ := unstructured.NestedStringMap(obj.Object, "spec", "selector"); ok {
			if s := labelsToSelector(bare); s != "" {
				parts = append(parts, s)
			}
		}
	}

	exprs, ok, _ := unstructured.NestedSlice(obj.Object, "spec", "selector", "matchExpressions")
	if ok {
		for _, raw := range exprs {
			e, isMap := raw.(map[string]any)
			if !isMap {
				continue
			}
			key, _ := e["key"].(string)
			op, _ := e["operator"].(string)
			if key == "" || op == "" {
				continue
			}
			values := []string{}
			if vs, isSlice := e["values"].([]any); isSlice {
				for _, v := range vs {
					if s, isStr := v.(string); isStr {
						values = append(values, s)
					}
				}
			}
			switch op {
			case "In":
				if len(values) > 0 {
					parts = append(parts, fmt.Sprintf("%s in (%s)", key, strings.Join(values, ",")))
				}
			case "NotIn":
				if len(values) > 0 {
					parts = append(parts, fmt.Sprintf("%s notin (%s)", key, strings.Join(values, ",")))
				}
			case "Exists":
				parts = append(parts, key)
			case "DoesNotExist":
				parts = append(parts, "!"+key)
			}
		}
	}

	return strings.Join(parts, ",")
}

// small unstructured accessors used by tests and the forward resolver.
func unstructuredString(o *unstructured.Unstructured, path ...string) (string, bool, error) {
	return unstructured.NestedString(o.Object, path...)
}

func unstructuredSlice(o *unstructured.Unstructured, path ...string) ([]any, bool, error) {
	return unstructured.NestedSlice(o.Object, path...)
}

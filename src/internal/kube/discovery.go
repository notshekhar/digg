package kube

import (
	"sort"
	"strings"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Resource discovery. Port of src/discovery.ts.
//
// The Bun build ran `kubectl api-resources -o wide` and parsed the output by
// locating the header's start offsets, because values with internal spaces
// (VERBS like "[get list ...]") shift a naive split. The API returns this as
// data, so the parser and its offset arithmetic are gone.
//
// Discovery answers nearly every request (a list needs it, a detail page needs
// it, an events query needs it) and it was a kubectl spawn each time. The
// five-minute memo is kept: kubectl itself caches the same answer on disk for
// ten.

// DiscoveredResource is one kind the cluster exposes.
type DiscoveredResource struct {
	// Name is the plural resource name (e.g. "horizontalpodautoscalers").
	Name string `json:"name"`
	// Kind is the PascalCase singular Kind (e.g. "HorizontalPodAutoscaler"),
	// used for event field selectors.
	Kind string `json:"kind"`
	// APIVersion is the group/version (e.g. "autoscaling/v2").
	APIVersion string   `json:"apiVersion"`
	Namespaced bool     `json:"namespaced"`
	ShortNames []string `json:"shortNames"`
}

const discoveryTTL = 5 * time.Minute

type discoveryCache struct {
	at    time.Time
	value []DiscoveredResource
}

var (
	discoveryMu sync.Mutex
	discovered  = map[string]discoveryCache{}
)

// APIResources lists every kind the cluster exposes that we could list.
func (c *Cluster) APIResources(refresh bool) []DiscoveredResource {
	discoveryMu.Lock()
	hit, ok := discovered[c.Context]
	discoveryMu.Unlock()
	if !refresh && ok && time.Since(hit.at) < discoveryTTL {
		return hit.value
	}

	if refresh {
		c.Discovery.Invalidate()
	}
	// Partial failures are normal: an aggregated API whose backend is down
	// makes ServerPreferredResources return both a list and an error. The list
	// is still worth having — that is exactly the case where hiding every kind
	// would be the wrong answer.
	lists, err := c.Discovery.ServerPreferredResources()
	if err != nil && len(lists) == 0 {
		// Do not cache a failure: the cluster may just have been unreachable.
		return hit.value
	}

	out := []DiscoveredResource{}
	seen := map[string]bool{}
	for _, list := range lists {
		if list == nil {
			continue
		}
		for _, r := range list.APIResources {
			// Subresources (pods/log, deployments/scale) are not listable kinds.
			if strings.Contains(r.Name, "/") {
				continue
			}
			if !verbSupported(r.Verbs, "get") || !verbSupported(r.Verbs, "list") {
				continue
			}
			if seen[r.Name] {
				continue
			}
			seen[r.Name] = true
			out = append(out, DiscoveredResource{
				Name:       r.Name,
				Kind:       r.Kind,
				APIVersion: list.GroupVersion,
				Namespaced: r.Namespaced,
				ShortNames: append([]string{}, r.ShortNames...),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })

	discoveryMu.Lock()
	discovered[c.Context] = discoveryCache{at: time.Now(), value: out}
	discoveryMu.Unlock()
	return out
}

func verbSupported(verbs metav1.Verbs, want string) bool {
	for _, v := range verbs {
		if v == want {
			return true
		}
	}
	return false
}

// FindResource resolves a kind name against discovery.
func (c *Cluster) FindResource(name string) (DiscoveredResource, bool) {
	for _, d := range c.APIResources(false) {
		if d.Name == name || d.Kind == name {
			return d, true
		}
	}
	return DiscoveredResource{}, false
}

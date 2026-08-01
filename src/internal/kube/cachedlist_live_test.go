package kube

import (
	"testing"
	"time"
)

// What a warm watch is worth, measured rather than asserted.
//
// These run against whatever cluster the kubeconfig points at and skip when
// there is none, like the rest of the live tests.

func TestLiveCachedListMatchesList(t *testing.T) {
	c := cluster(t)

	// Cold: nothing is watching pods, so there is nothing to serve from.
	if _, ok := c.CachedList("pods", ListOptions{}); ok {
		t.Log("a pods watch was already running from another test")
	}

	synced := make(chan struct{})
	stop, err := c.Subscribe("pods", "", func(e WatchEvent) {
		if e.Type == Synced {
			select {
			case <-synced:
			default:
				close(synced)
			}
		}
	})
	if err != nil {
		t.Skipf("cannot watch pods: %v", err)
	}
	defer stop()

	select {
	case <-synced:
	case <-time.After(20 * time.Second):
		t.Fatal("watch never synced")
	}

	cached, ok := c.CachedList("pods", ListOptions{})
	if !ok {
		t.Fatal("a synced watch did not answer CachedList")
	}
	listed, err := c.List("pods", ListOptions{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	// Both views are of a live cluster, so a pod may legitimately appear or go
	// between the two reads; what must hold is that the store is not a fragment.
	if len(cached) == 0 && len(listed) > 0 {
		t.Fatalf("store held nothing while the API listed %d pods", len(listed))
	}
	names := map[string]bool{}
	for i := range cached {
		names[cached[i].GetNamespace()+"/"+cached[i].GetName()] = true
	}
	missing := 0
	for i := range listed {
		if !names[listed[i].GetNamespace()+"/"+listed[i].GetName()] {
			missing++
		}
	}
	if missing > 1 {
		t.Errorf("%d of %d listed pods were absent from the store", missing, len(listed))
	}

	// A namespaced question answered by the all-namespaces store.
	if len(listed) > 0 {
		ns := listed[0].GetNamespace()
		scoped, ok := c.CachedList("pods", ListOptions{Namespace: ns})
		if !ok {
			t.Fatal("the all-namespaces store refused a namespaced question")
		}
		for i := range scoped {
			if scoped[i].GetNamespace() != ns {
				t.Fatalf("namespace filter leaked %s", scoped[i].GetNamespace())
			}
		}
	}

	// A label selector is a scan of the store, not a round trip.
	if len(listed) > 0 {
		for k, v := range listed[0].GetLabels() {
			sel := k + "=" + v
			hits, ok := c.CachedList("pods", ListOptions{LabelSelector: sel})
			if !ok {
				t.Fatalf("store refused label selector %q", sel)
			}
			if len(hits) == 0 {
				t.Errorf("selector %q matched nothing in the store", sel)
			}
			break
		}
	}

	// A field selector has no index here and must fall through to a real list.
	if _, ok := c.CachedList("pods", ListOptions{FieldSelector: "spec.nodeName=nowhere"}); ok {
		t.Error("a field selector was answered from the store, which cannot index it")
	}

	// Not an assertion — the number is the point of the whole change.
	start := time.Now()
	for i := 0; i < 20; i++ {
		c.CachedList("pods", ListOptions{})
	}
	cachedEach := time.Since(start) / 20
	start = time.Now()
	for i := 0; i < 5; i++ {
		if _, err := c.List("pods", ListOptions{}); err != nil {
			t.Fatalf("list: %v", err)
		}
	}
	listEach := time.Since(start) / 5
	t.Logf("%d pods: store %v per read, API %v per read", len(cached), cachedEach, listEach)
}

func TestLiveMetricsCacheIsSingleFlight(t *testing.T) {
	c := cluster(t)
	if !c.MetricsAvailable() {
		t.Skip("no metrics-server")
	}

	// First call populates; the next twenty must not go near the network.
	c.TopPods("", "")
	start := time.Now()
	for i := 0; i < 20; i++ {
		c.TopPods("", "")
	}
	each := time.Since(start) / 20
	if each > 2*time.Millisecond {
		t.Errorf("cached TopPods took %v per call — the TTL cache is not holding", each)
	}
	t.Logf("cached TopPods: %v per call", each)
}

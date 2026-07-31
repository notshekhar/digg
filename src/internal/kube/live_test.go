package kube

import (
	"strings"
	"testing"
	"time"
)

// These run against whatever cluster the kubeconfig points at and skip when
// there is none, so `go test ./...` stays green on a machine with no cluster.

func cluster(t *testing.T) *Cluster {
	t.Helper()
	if !Available() {
		t.Skip("no kubeconfig contexts")
	}
	ctxName, err := CurrentContext()
	if err != nil {
		t.Skip("no current context")
	}
	c, err := For(ctxName)
	if err != nil {
		t.Skipf("cannot connect: %v", err)
	}
	if _, err := c.Namespaces(); err != nil {
		t.Skipf("cluster unreachable: %v", err)
	}
	return c
}

func TestLiveResolveShortNames(t *testing.T) {
	c := cluster(t)
	cases := map[string]string{
		"po":     "pods",
		"deploy": "deployments",
		"ing":    "ingresses",
		"svc":    "services",
		"cm":     "configmaps",
		"no":     "nodes",
	}
	for in, want := range cases {
		gvr, _, err := c.Resolve(in)
		if err != nil {
			t.Errorf("Resolve(%q): %v", in, err)
			continue
		}
		if gvr.Resource != want {
			t.Errorf("Resolve(%q) = %q, want %q", in, gvr.Resource, want)
		}
	}
}

func TestLiveListAndGet(t *testing.T) {
	c := cluster(t)
	pods, err := c.List("pods", ListOptions{})
	if err != nil {
		t.Fatalf("list pods: %v", err)
	}
	if len(pods) == 0 {
		t.Skip("no pods to inspect")
	}
	ref := ResourceRef{Kind: "pods", Name: pods[0].GetName(), Namespace: pods[0].GetNamespace()}

	obj, err := c.Get(ref)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if obj.GetName() != ref.Name {
		t.Errorf("get returned %q, want %q", obj.GetName(), ref.Name)
	}

	y, err := c.YAML(ref)
	if err != nil {
		t.Fatalf("yaml: %v", err)
	}
	if !strings.Contains(y, "kind: Pod") {
		t.Errorf("yaml missing kind: %.120s", y)
	}
	// kubectl hides managedFields from `get -o yaml`; so must we, since this
	// text is what the editor round-trips.
	if strings.Contains(y, "managedFields") {
		t.Error("yaml leaked managedFields")
	}

	d, err := c.Describe(ref)
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	for _, want := range []string{"Name:", "Namespace:", "Status:"} {
		if !strings.Contains(d, want) {
			t.Errorf("describe missing %q", want)
		}
	}
}

func TestLiveSubscribeSharesOneStream(t *testing.T) {
	c := cluster(t)

	type counts struct{ added, synced int }
	got := make(chan counts, 2)

	for i := 0; i < 2; i++ {
		go func() {
			var n counts
			done := make(chan struct{})
			stop, err := c.Subscribe("pods", "", func(e WatchEvent) {
				switch e.Type {
				case Added:
					n.added++
				case Synced:
					n.synced++
					select {
					case <-done:
					default:
						close(done)
					}
				}
			})
			if err != nil {
				got <- counts{}
				return
			}
			select {
			case <-done:
			case <-time.After(15 * time.Second):
			}
			stop()
			got <- n
		}()
	}

	for i := 0; i < 2; i++ {
		select {
		case n := <-got:
			if n.synced != 1 {
				t.Errorf("subscriber %d saw %d synced events, want 1", i, n.synced)
			}
			if n.added == 0 {
				t.Errorf("subscriber %d saw no objects", i)
			}
		case <-time.After(20 * time.Second):
			t.Fatal("subscriber never synced")
		}
	}

	// Both subscribers are gone; the stream should still be parked for the idle
	// grace period rather than torn down immediately.
	c.mu.Lock()
	live := len(c.shared)
	c.mu.Unlock()
	if live != 1 {
		t.Errorf("expected 1 parked stream, got %d", live)
	}
}

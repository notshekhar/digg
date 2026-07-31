package model

import (
	"testing"
)

// src/detail-view.test.ts has no direct counterpart file in the Bun build (its
// coverage lived in src/detail-view.test.ts against the same helpers); these
// cover the behaviour the comments in detail-view.ts call out as load-bearing.

func factByLabel(g FactGroup, label string) *Fact {
	for i := range g.Facts {
		if g.Facts[i].Label == label {
			return &g.Facts[i]
		}
	}
	return nil
}

func groupByTitle(v DetailView, title string) *FactGroup {
	for i := range v.Groups {
		if v.Groups[i].Title == title {
			return &v.Groups[i]
		}
	}
	return nil
}

// Every site the API server resolves must be walked. A group that looks
// complete and is not teaches you to trust it.
func TestSpecRefsWalksEverySite(t *testing.T) {
	spec := map[string]any{
		"volumes": []any{
			map[string]any{"name": "cfg", "configMap": map[string]any{"name": "app-config"}},
			map[string]any{"name": "sec", "secret": map[string]any{"secretName": "app-secret"}},
			map[string]any{"name": "data", "persistentVolumeClaim": map[string]any{"claimName": "app-data"}},
			map[string]any{"name": "proj", "projected": map[string]any{"sources": []any{
				map[string]any{"configMap": map[string]any{"name": "proj-config"}},
				map[string]any{"secret": map[string]any{"name": "proj-secret"}},
			}}},
			map[string]any{"name": "csivol", "csi": map[string]any{
				"nodePublishSecretRef": map[string]any{"name": "csi-secret"}}},
			map[string]any{"name": "rbdvol", "rbd": map[string]any{
				"secretRef": map[string]any{"name": "rbd-secret"}}},
		},
		"imagePullSecrets": []any{map[string]any{"name": "regcred"}},
		"containers": []any{map[string]any{
			"name": "api",
			"envFrom": []any{
				map[string]any{"configMapRef": map[string]any{"name": "envfrom-config"}},
				map[string]any{"secretRef": map[string]any{"name": "envfrom-secret"}},
			},
			"env": []any{map[string]any{
				"name":      "DB_PASS",
				"valueFrom": map[string]any{"secretKeyRef": map[string]any{"name": "db-secret"}},
			}},
		}},
	}

	refs := SpecRefs(spec)
	got := map[string]string{}
	for _, r := range refs.Of(kindConfigMaps, "default") {
		got["cm/"+r.Name] = r.Via
	}
	for _, r := range refs.Of(kindSecrets, "default") {
		got["sec/"+r.Name] = r.Via
	}
	for _, r := range refs.Of(kindPVCs, "default") {
		got["pvc/"+r.Name] = r.Via
	}

	want := []string{
		"cm/app-config", "cm/proj-config", "cm/envfrom-config",
		"sec/app-secret", "sec/proj-secret", "sec/csi-secret", "sec/rbd-secret",
		"sec/regcred", "sec/envfrom-secret", "sec/db-secret",
		"pvc/app-data",
	}
	for _, key := range want {
		if _, ok := got[key]; !ok {
			t.Errorf("missing reference %s (found %v)", key, got)
		}
	}
	// The via carries WHERE it was reached from, which is the question the
	// group exists to answer.
	if got["cm/app-config"] != "volume cfg" {
		t.Errorf("via = %q, want %q", got["cm/app-config"], "volume cfg")
	}
	if got["sec/db-secret"] != "env DB_PASS" {
		t.Errorf("via = %q, want %q", got["sec/db-secret"], "env DB_PASS")
	}
}

// A name reached more than once appears once, carrying every route.
func TestSpecRefsDeduplicatesAndSummarizesVia(t *testing.T) {
	spec := map[string]any{
		"volumes": []any{
			map[string]any{"name": "a", "configMap": map[string]any{"name": "shared"}},
			map[string]any{"name": "b", "configMap": map[string]any{"name": "shared"}},
		},
		"containers": []any{map[string]any{
			"name":    "api",
			"envFrom": []any{map[string]any{"configMapRef": map[string]any{"name": "shared"}}},
		}},
	}
	list := SpecRefs(spec).Of(kindConfigMaps, "")
	if len(list) != 1 {
		t.Fatalf("expected 1 deduplicated ref, got %d", len(list))
	}
	if list[0].Via != "volume a, volume b, envFrom in api" {
		t.Errorf("via = %q", list[0].Via)
	}
}

func TestSpecRefsSummarizesBeyondThreeRoutes(t *testing.T) {
	vols := []any{}
	for _, n := range []string{"a", "b", "c", "d"} {
		vols = append(vols, map[string]any{"name": n, "configMap": map[string]any{"name": "shared"}})
	}
	list := SpecRefs(map[string]any{"volumes": vols}).Of(kindConfigMaps, "")
	if list[0].Via != "volume a, volume b +2 more" {
		t.Errorf("via = %q", list[0].Via)
	}
}

// Three empty dashes under a heading is worse than no heading.
func TestReferencesGroupIsNilWhenNothingIsNamed(t *testing.T) {
	if g := ReferencesGroup(map[string]any{"containers": []any{}}, "default", false); g != nil {
		t.Errorf("expected nil, got %+v", g)
	}
	// identity=true still produces a group when a service account is set.
	g := ReferencesGroup(map[string]any{"serviceAccountName": "api"}, "default", true)
	if g == nil || factByLabel(*g, "Service Account") == nil {
		t.Error("expected a References group carrying the service account")
	}
}

func TestPodViewSurfacesPendingAsWarn(t *testing.T) {
	pod := obj(t, `{"metadata":{"name":"web","namespace":"default"},
		"spec":{"containers":[{"name":"c","image":"nginx"}],
			"tolerations":[{"key":"node.kubernetes.io/not-ready","effect":"NoExecute","tolerationSeconds":300}]},
		"status":{"phase":"Pending"}}`)
	v := PodView(pod, NoMetrics)

	phase := factByLabel(v.Groups[0], "Phase")
	if phase == nil || phase.Text != "Pending" || phase.Tone != ToneWarn {
		t.Errorf("phase fact = %+v", phase)
	}
	sched := groupByTitle(v, "Scheduling")
	if sched == nil {
		t.Fatal("no Scheduling group")
	}
	tol := factByLabel(*sched, "Tolerations")
	if tol == nil || len(tol.Items) != 1 {
		t.Fatalf("tolerations = %+v", tol)
	}
	if tol.Items[0] != "node.kubernetes.io/not-ready: NoExecute for 300s" {
		t.Errorf("toleration line = %q", tol.Items[0])
	}
}

func TestPodContainerViewsCarryRestartReason(t *testing.T) {
	pod := obj(t, `{"metadata":{"name":"web","namespace":"default"},
		"spec":{"containers":[{"name":"api","image":"api:1",
			"resources":{"requests":{"cpu":"100m","memory":"64Mi"},
			             "limits":{"cpu":"500m","memory":"128Mi"}}}]},
		"status":{"containerStatuses":[{"name":"api","ready":true,"restartCount":3,
			"state":{"running":{"startedAt":"2026-01-01T00:00:00Z"}},
			"lastState":{"terminated":{"reason":"OOMKilled","exitCode":137,
				"finishedAt":"2026-01-01T00:00:00Z"}}}]}}`)

	views := PodContainerViews(pod, NoMetrics)
	if len(views) != 1 {
		t.Fatalf("expected 1 container, got %d", len(views))
	}
	c := views[0]
	if c.State != "Running" || c.StateTone != ToneOK {
		t.Errorf("state = %q/%q", c.State, c.StateTone)
	}
	if c.Restarts != 3 || c.RestartReason != "OOMKilled" {
		t.Errorf("restarts = %d, reason = %q", c.Restarts, c.RestartReason)
	}
	if c.CPU.Requests != 0.1 || c.CPU.Limits != 0.5 {
		t.Errorf("cpu gauge = %+v", c.CPU)
	}
	// No metrics-server means unknown, never a confident zero.
	if c.CPU.Used != nil {
		t.Errorf("cpu used = %v, want unknown", *c.CPU.Used)
	}
}

// Init containers are a MAX, not a sum: they never run alongside app containers.
func TestPodAllocationTreatsInitContainersAsMax(t *testing.T) {
	pod := obj(t, `{"spec":{
		"initContainers":[{"name":"init","resources":{"requests":{"cpu":"2","memory":"1Gi"}}}],
		"containers":[
			{"name":"a","resources":{"requests":{"cpu":"100m","memory":"64Mi"}}},
			{"name":"b","resources":{"requests":{"cpu":"200m","memory":"64Mi"}}}]}}`)
	a := PodAllocation(pod)
	// app containers sum to 300m, the init container wants 2 cores → 2 wins.
	if a.CPU.Requests != 2 {
		t.Errorf("cpu requests = %v, want 2", a.CPU.Requests)
	}
	if a.Mem.Requests != 1024*1024*1024 {
		t.Errorf("mem requests = %v, want 1Gi", a.Mem.Requests)
	}
}

func TestWorkloadViewSumsUsageAcrossPods(t *testing.T) {
	dep := obj(t, `{"kind":"Deployment","metadata":{"name":"api","namespace":"default"},
		"spec":{"replicas":2,"selector":{"matchLabels":{"app":"api"}},
			"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxSurge":1,"maxUnavailable":0}},
			"template":{"spec":{"containers":[{"name":"api","image":"api:1",
				"resources":{"requests":{"cpu":"100m"}}}]}}},
		"status":{"replicas":2,"readyReplicas":2,"updatedReplicas":2,"availableReplicas":2}}`)
	pods := []Obj{
		*obj(t, `{"metadata":{"name":"api-1","namespace":"default"},
			"spec":{"containers":[{"name":"api"}]},"status":{"phase":"Running"}}`),
		*obj(t, `{"metadata":{"name":"api-2","namespace":"default"},
			"spec":{"containers":[{"name":"api"}]},"status":{"phase":"Running"}}`),
	}
	metrics := MetricsView(nil, map[string]Usage{
		"default/api-1/api": {CPU: "50m", Memory: "10Mi"},
		"default/api-2/api": {CPU: "70m", Memory: "20Mi"},
	})

	v := WorkloadView(dep, "deployments", pods, metrics)

	if v.ContainersNote != "summed over 2 pods" {
		t.Errorf("note = %q", v.ContainersNote)
	}
	if len(v.Containers) != 1 {
		t.Fatalf("containers = %d", len(v.Containers))
	}
	used := v.Containers[0].CPU.Used
	if used == nil {
		t.Fatal("expected summed usage")
	}
	// 50m + 70m = 120m = 0.12 cores
	if *used < 0.1199 || *used > 0.1201 {
		t.Errorf("summed cpu = %v, want ~0.12", *used)
	}
	// requests are per-pod × 2
	if v.Containers[0].CPU.Requests < 0.1999 || v.Containers[0].CPU.Requests > 0.2001 {
		t.Errorf("summed requests = %v, want ~0.2", v.Containers[0].CPU.Requests)
	}
	if v.Pods == nil || v.Pods.Desired != 2 || v.Pods.Ready != 2 {
		t.Errorf("pods block = %+v", v.Pods)
	}
	// Selector sits third in the header, after Age and Namespace.
	if v.Header.Facts[2].Label != "Selector" {
		t.Errorf("header order = %q at index 2", v.Header.Facts[2].Label)
	}
	rollout := groupByTitle(v, "Rollout")
	if rollout == nil || factByLabel(*rollout, "Max Surge") == nil {
		t.Error("expected a Rollout group with Max Surge")
	}
}

func TestNodeViewReportsCordonAndCapacity(t *testing.T) {
	node := obj(t, `{"metadata":{"name":"node-1"},
		"spec":{"unschedulable":true},
		"status":{"nodeInfo":{"kubeletVersion":"v1.35.1","osImage":"Ubuntu"},
			"capacity":{"cpu":"4","memory":"8Gi","pods":"110"},
			"allocatable":{"cpu":"3800m","memory":"7Gi","pods":"110"},
			"addresses":[{"type":"InternalIP","address":"192.168.1.10"}]}}`)
	pods := []Obj{*obj(t, `{"metadata":{"name":"p1","namespace":"default"},
		"spec":{"containers":[{"name":"c","resources":{"requests":{"cpu":"500m","memory":"512Mi"}}}]},
		"status":{"phase":"Running"}}`)}

	v := NodeView(node, pods, NoMetrics)

	sched := factByLabel(v.Groups[0], "Schedulable")
	if sched == nil || sched.Text != "Cordoned" || sched.Tone != ToneWarn {
		t.Errorf("schedulable = %+v", sched)
	}
	cap := groupByTitle(v, "Capacity")
	if cap == nil {
		t.Fatal("no Capacity group")
	}
	if got := factByLabel(*cap, "CPU").Text; got != "3800m allocatable of 4" {
		t.Errorf("cpu = %q", got)
	}
	if got := factByLabel(*cap, "Pods").Text; got != "1 of 110" {
		t.Errorf("pods = %q", got)
	}
	if got := factByLabel(*cap, "Requested").Text; got != "0.50 cores · 512Mi" {
		t.Errorf("requested = %q", got)
	}
}

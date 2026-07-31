package model

import (
	"reflect"
	"testing"
)

// Ported from src/details.test.ts, case for case.

var noTop = map[string]Usage{}

func summaryValue(m DetailModel, key string) string {
	for _, r := range m.Summary {
		if r.Key == key {
			return r.Value
		}
	}
	return ""
}

func TestIngressRuleRowsFlattens(t *testing.T) {
	ing := obj(t, `{"spec":{"rules":[{"host":"app.example.com","http":{"paths":[
		{"path":"/","backend":{"service":{"name":"web","port":{"number":80}}}}]}}]}}`)
	got := IngressRuleRows(ing)
	want := [][]string{{"app.example.com", "/", "web", "80"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestIngressRuleRowsWildcardHost(t *testing.T) {
	ing := obj(t, `{"spec":{"rules":[{"http":{"paths":[{"path":"/api"}]}}]}}`)
	if got := IngressRuleRows(ing)[0][0]; got != "*" {
		t.Errorf("host = %q, want *", got)
	}
}

func TestPodMountsPVC(t *testing.T) {
	pod := obj(t, `{"spec":{"volumes":[
		{"persistentVolumeClaim":{"claimName":"data"}},{"emptyDir":{}}]}}`)
	if !PodMountsPVC(pod, "data") {
		t.Error("expected true for a mounted claim")
	}
	if PodMountsPVC(pod, "other") {
		t.Error("expected false for an unmounted claim")
	}
}

func TestJobOwnedByCronJob(t *testing.T) {
	job := obj(t, `{"metadata":{"ownerReferences":[
		{"apiVersion":"batch/v1","kind":"CronJob","name":"nightly","uid":"x"}]}}`)
	if !JobOwnedByCronJob(job, "nightly") {
		t.Error("expected true for the owning cronjob")
	}
	if JobOwnedByCronJob(job, "other") {
		t.Error("expected false for a different name")
	}
}

func TestDetailModelServiceBuildsEndpointPodsSection(t *testing.T) {
	svc := obj(t, `{"metadata":{"name":"api","namespace":"default"},
		"spec":{"type":"ClusterIP","clusterIP":"10.0.0.1","selector":{"app":"api"},
		"ports":[{"port":80,"targetPort":8080}]}}`)
	m := DetailModelFor("services", svc, false, noTop)
	if m.Section == nil || m.Section.Type != "endpointPods" {
		t.Fatalf("section = %+v", m.Section)
	}
	if got := summaryValue(m, "Selector"); got != "app=api" {
		t.Errorf("selector = %q", got)
	}
	if got := summaryValue(m, "Ports"); got != "80→8080/TCP" {
		t.Errorf("ports = %q", got)
	}
}

func TestDetailModelNodeBuildsNodePodsSection(t *testing.T) {
	node := obj(t, `{"metadata":{"name":"node-1"},
		"status":{"nodeInfo":{"kubeletVersion":"v1.29.0"}}}`)
	m := DetailModelFor("nodes", node, false, noTop)
	want := &Section{Type: "nodePods", Title: "Pods on node", Node: "node-1"}
	if !reflect.DeepEqual(m.Section, want) {
		t.Errorf("section = %+v, want %+v", m.Section, want)
	}
}

func TestDetailModelUnknownKindsStillGetASummary(t *testing.T) {
	crd := obj(t, `{"metadata":{"name":"x","namespace":"default"},"apiVersion":"example.com/v1"}`)
	m := DetailModelFor("widgets", crd, false, noTop)
	if len(m.Summary) == 0 {
		t.Error("unknown kind produced an empty summary — that is a dead end")
	}
	if m.Section != nil {
		t.Errorf("unknown kind should have no section, got %+v", m.Section)
	}
}

func TestDetailModelPodSummaryInjectsLiveMetrics(t *testing.T) {
	pod := obj(t, `{"metadata":{"name":"web"},"status":{"phase":"Running"}}`)
	top := map[string]Usage{"web": {CPU: "5m", Memory: "20Mi"}}
	m := DetailModelFor("pods", pod, false, top)
	if got := summaryValue(m, "CPU / Mem"); got != "5m / 20Mi" {
		t.Errorf("cpu/mem = %q", got)
	}
}

// Namespace-qualified metrics must win over the bare name: two namespaces may
// hold pods with the same name, and the bare map would show one pod's CPU on
// the other's row.
func TestDetailModelPodSummaryPrefersQualifiedMetrics(t *testing.T) {
	pod := obj(t, `{"metadata":{"name":"web","namespace":"prod"},"status":{"phase":"Running"}}`)
	top := map[string]Usage{
		"web":      {CPU: "1m", Memory: "1Mi"},
		"prod/web": {CPU: "9m", Memory: "9Mi"},
	}
	m := DetailModelFor("pods", pod, false, top)
	if got := summaryValue(m, "CPU / Mem"); got != "9m / 9Mi" {
		t.Errorf("cpu/mem = %q, want the namespace-qualified sample", got)
	}
}

func TestDetailModelWorkloadUsesItsSelector(t *testing.T) {
	dep := obj(t, `{"metadata":{"name":"api","namespace":"default"},
		"spec":{"replicas":3,"selector":{"matchLabels":{"app":"api","tier":"web"}}},
		"status":{"replicas":3,"readyReplicas":2}}`)
	m := DetailModelFor("deployments", dep, true, noTop)
	if m.Section == nil || m.Section.Type != "workloadPods" {
		t.Fatalf("section = %+v", m.Section)
	}
	if m.Section.Selector != "app=api,tier=web" {
		t.Errorf("selector = %q", m.Section.Selector)
	}
}

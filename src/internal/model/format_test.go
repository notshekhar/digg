package model

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

// Ported from src/format.test.ts, case for case.

// obj builds an Obj from a JSON literal, so the fixtures read like the TS ones
// and go through the same decoder the API client uses (numbers land as int64,
// which is exactly the shape the accessors must cope with).
func obj(t *testing.T, jsonText string) *Obj {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(jsonText), &m); err != nil {
		t.Fatalf("bad fixture: %v", err)
	}
	return &Obj{Object: m}
}

func TestPodPhaseSurfacesWaitingReasonOverPhase(t *testing.T) {
	pod := obj(t, `{"status":{"phase":"Pending","containerStatuses":[
		{"state":{"waiting":{"reason":"CrashLoopBackOff"}}}]}}`)
	if got := PodPhase(pod); got != "CrashLoopBackOff" {
		t.Errorf("got %q", got)
	}
}

func TestPodPhaseTerminating(t *testing.T) {
	pod := obj(t, `{"metadata":{"deletionTimestamp":"2020-01-01T00:00:00Z"},"status":{"phase":"Running"}}`)
	if got := PodPhase(pod); got != "Terminating" {
		t.Errorf("got %q", got)
	}
}

func TestPodPhaseFallsBackWhenContainersHealthy(t *testing.T) {
	pod := obj(t, `{"status":{"phase":"Running","containerStatuses":[
		{"state":{"terminated":{"reason":"Completed"}}}]}}`)
	if got := PodPhase(pod); got != "Running" {
		t.Errorf("got %q", got)
	}
}

func TestJobStatus(t *testing.T) {
	cases := []struct{ fixture, want string }{
		{`{"status":{"conditions":[{"type":"Complete","status":"True"}]}}`, "Complete"},
		{`{"status":{"conditions":[{"type":"Failed","status":"True"}]}}`, "Failed"},
		{`{"status":{"active":2}}`, "Running"},
	}
	for _, c := range cases {
		if got := JobStatus(obj(t, c.fixture)); got != c.want {
			t.Errorf("JobStatus(%s) = %q, want %q", c.fixture, got, c.want)
		}
	}
}

func TestNodeRoles(t *testing.T) {
	node := obj(t, `{"metadata":{"labels":{
		"node-role.kubernetes.io/control-plane":"","node-role.kubernetes.io/worker":""}}}`)
	if got := NodeRoles(node); got != "control-plane,worker" {
		t.Errorf("got %q", got)
	}
	plain := obj(t, `{"metadata":{"labels":{"foo":"bar"}}}`)
	if got := NodeRoles(plain); got != "<none>" {
		t.Errorf("got %q", got)
	}
}

func TestPVCAccessModesAbbreviates(t *testing.T) {
	pvc := obj(t, `{"status":{"accessModes":["ReadWriteOnce","ReadOnlyMany"]}}`)
	if got := PVCAccessModes(pvc); got != "RWO,ROX" {
		t.Errorf("got %q", got)
	}
}

func TestPodRowCarriesIPAndNode(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC3339)
	pod := obj(t, `{
		"metadata":{"name":"web","creationTimestamp":"`+now+`"},
		"spec":{"nodeName":"node-1","containers":[{"name":"c"}]},
		"status":{"phase":"Running","podIP":"10.0.0.5",
			"containerStatuses":[{"ready":true,"restartCount":0}]}}`)
	row := FindKind("pods").Row(pod)
	// [NAME, READY, STATUS, RESTARTS, IP, NODE, AGE]
	if row[0] != "web" {
		t.Errorf("name = %q", row[0])
	}
	if row[4] != "10.0.0.5" {
		t.Errorf("ip = %q", row[4])
	}
	if row[5] != "node-1" {
		t.Errorf("node = %q", row[5])
	}
	if row[1] != "1/1" {
		t.Errorf("ready = %q", row[1])
	}
}

func TestGenericKind(t *testing.T) {
	k := GenericKind(DiscoveredResource{Name: "widgets", Kind: "Widget", Namespaced: true})
	if k.Name != "widgets" || k.Kind != "Widget" || !k.Generic || k.ClusterScoped {
		t.Errorf("unexpected generic kind: %+v", k)
	}
	if !reflect.DeepEqual(k.Columns, []string{"NAME", "STATUS", "AGE"}) {
		t.Errorf("columns = %v", k.Columns)
	}
	c := GenericKind(DiscoveredResource{Name: "clusterthings", Kind: "ClusterThing", Namespaced: false})
	if !c.ClusterScoped {
		t.Error("expected cluster-scoped")
	}
}

const ingressFixture = `{"spec":{
	"tls":[{"hosts":["secure.example.com"],"secretName":"tls"}],
	"rules":[
		{"host":"secure.example.com","http":{"paths":[
			{"path":"/","backend":{"service":{"name":"web","port":{"number":8080}}}}]}},
		{"host":"plain.example.com","http":{"paths":[
			{"path":"/api","backend":{"service":{"name":"api","port":{"name":"http"}}}}]}}]}}`

func TestIngressRoutesTLSGetsHTTPS(t *testing.T) {
	routes := IngressRoutes(obj(t, ingressFixture))
	want := IngressRoute{
		URL: "https://secure.example.com/", Host: "secure.example.com",
		Path: "/", Service: "web", Port: "8080",
	}
	if routes[0] != want {
		t.Errorf("routes[0] = %+v, want %+v", routes[0], want)
	}
	if routes[1].URL != "http://plain.example.com/api" {
		t.Errorf("routes[1].URL = %q", routes[1].URL)
	}
	if routes[1].Port != "http" {
		t.Errorf("routes[1].Port = %q", routes[1].Port)
	}
}

func TestIngressWildcardHostHasNoURL(t *testing.T) {
	wild := obj(t, `{"spec":{"rules":[{"http":{"paths":[{"path":"/","backend":{}}]}}]}}`)
	r := IngressRoutes(wild)[0]
	if r.Host != "*" || r.URL != "" {
		t.Errorf("got %+v", r)
	}
}

func TestIngressRowListsEveryRoute(t *testing.T) {
	row := FindKind("ingresses").Row(obj(t, ingressFixture))
	if !contains(row[1], "https://secure.example.com/ → web:8080") {
		t.Errorf("rules cell missing secure route: %q", row[1])
	}
	if !contains(row[1], "http://plain.example.com/api → api:http") {
		t.Errorf("rules cell missing plain route: %q", row[1])
	}
	if row[3] != "Pending" {
		t.Errorf("load balancer = %q, want Pending", row[3])
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle ||
		len(needle) == 0 || indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}

// Every curated kind must produce exactly as many cells as it declares columns,
// or the table silently misaligns. The TS had no such test; a table-driven port
// makes it nearly free.
func TestEveryKindRowMatchesItsColumnCount(t *testing.T) {
	empty := &Obj{Object: map[string]any{}}
	for _, k := range Kinds {
		got := len(k.Row(empty))
		if got != len(k.Columns) {
			t.Errorf("%s: row has %d cells, columns declare %d", k.Name, got, len(k.Columns))
		}
	}
}

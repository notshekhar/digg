package model

import "testing"

// An empty selector matching nothing is the invariant the whole relation graph
// rests on. Get it backwards and an ExternalName Service claims every pod in
// the namespace, and every "used by" list becomes the namespace.
func TestLabelsMatchTreatsEmptySelectorAsNoMatch(t *testing.T) {
	labels := map[string]string{"app": "api", "tier": "web"}
	if LabelsMatch(map[string]string{}, labels) {
		t.Error("empty selector matched")
	}
	if LabelsMatch(nil, labels) {
		t.Error("nil selector matched")
	}
	if !LabelsMatch(map[string]string{"app": "api"}, labels) {
		t.Error("subset should match")
	}
	if LabelsMatch(map[string]string{"app": "api", "env": "prod"}, labels) {
		t.Error("superset should not match")
	}
	if LabelsMatch(map[string]string{"app": "web"}, labels) {
		t.Error("wrong value matched")
	}
}

func TestKindPluralHandlesTheKindsTheGraphWalks(t *testing.T) {
	cases := map[string]string{
		"Deployment":              "deployments",
		"ReplicaSet":              "replicasets",
		"StatefulSet":             "statefulsets",
		"CronJob":                 "cronjobs",
		"Ingress":                 "ingresses",
		"NetworkPolicy":           "networkpolicies",
		"PersistentVolumeClaim":   "persistentvolumeclaims",
		"StorageClass":            "storageclasses",
		"PriorityClass":           "priorityclasses",
		"ClusterRole":             "clusterroles",
		"Endpoints":               "endpoints",
		"HorizontalPodAutoscaler": "horizontalpodautoscalers",
	}
	for kind, want := range cases {
		if got := KindPlural(kind); got != want {
			t.Errorf("%s: got %q, want %q", kind, got, want)
		}
	}
}

// The whole point of parsing endpoints ourselves: kubectl prints only the ready
// addresses, so "readiness is failing" and "the selector is wrong" look the
// same. They are not the same bug.
func TestParseEndpointsKeepsNotReadyAddresses(t *testing.T) {
	ep := obj(t, `{"subsets":[{
		"addresses":[{"ip":"10.0.0.1","nodeName":"n1","targetRef":{"name":"api-1","namespace":"demo"}}],
		"notReadyAddresses":[{"ip":"10.0.0.2","targetRef":{"name":"api-2"}}],
		"ports":[{"name":"http","port":8080,"protocol":"TCP"}]}]}`)

	info := ParseEndpoints(ep)
	if len(info.Ready) != 1 || info.Ready[0].PodName != "api-1" || info.Ready[0].Node != "n1" {
		t.Fatalf("ready: %+v", info.Ready)
	}
	if len(info.NotReady) != 1 || info.NotReady[0].PodName != "api-2" {
		t.Fatalf("not ready: %+v", info.NotReady)
	}
	if len(info.Ports) != 1 || info.Ports[0] != "http:8080/TCP" {
		t.Fatalf("ports: %+v", info.Ports)
	}
}

// A hand-maintained Endpoints object points outside the cluster. Those
// addresses have no page to open and would otherwise disappear entirely.
func TestParseEndpointsSurfacesPodlessAddresses(t *testing.T) {
	ep := obj(t, `{"subsets":[{
		"addresses":[{"ip":"192.168.1.10"}],
		"notReadyAddresses":[{"ip":"192.168.1.11"}]}]}`)
	lines := ParseEndpoints(ep).AddressLines()
	if len(lines) != 2 || lines[0] != "192.168.1.10" || lines[1] != "192.168.1.11 (not ready)" {
		t.Fatalf("lines: %+v", lines)
	}
}

func TestParseEndpointsHandlesNil(t *testing.T) {
	info := ParseEndpoints(nil)
	if len(info.Ready) != 0 || len(info.NotReady) != 0 || len(info.Ports) != 0 {
		t.Fatalf("nil endpoints: %+v", info)
	}
}

// The default backend is a route too, and it is the one that catches every
// request no rule matched.
func TestIngressBackendsIncludesDefaultAndDedupes(t *testing.T) {
	ing := obj(t, `{"spec":{
		"defaultBackend":{"service":{"name":"fallback","port":{"number":80}}},
		"rules":[
			{"host":"a.example","http":{"paths":[
				{"path":"/","backend":{"service":{"name":"api","port":{"number":80}}}},
				{"path":"/v2","backend":{"service":{"name":"api","port":{"number":80}}}}]}},
			{"host":"b.example","http":{"paths":[
				{"path":"/","backend":{"service":{"name":"web","port":{"name":"http"}}}}]}}]}}`)

	got := IngressBackends(ing)
	want := []string{"fallback", "api", "web"}
	if len(got) != len(want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	}
}

func TestIngressTLSSecrets(t *testing.T) {
	ing := obj(t, `{"spec":{"tls":[
		{"secretName":"star-tls","hosts":["a.example"]},
		{"secretName":"star-tls","hosts":["b.example"]},
		{"hosts":["c.example"]}]}}`)
	got := IngressTLSSecrets(ing)
	if len(got) != 1 || got[0] != "star-tls" {
		t.Fatalf("got %+v", got)
	}
}

// A RoleBinding can point at a ClusterRole, which lives at a different route
// and has no namespace. Getting that wrong makes the link 404.
func TestRoleRefLinkRoutesClusterRolesWithoutANamespace(t *testing.T) {
	b := obj(t, `{"metadata":{"namespace":"demo"},
		"roleRef":{"kind":"ClusterRole","name":"view","apiGroup":"rbac.authorization.k8s.io"}}`)
	ref, ok := RoleRefLink(b)
	if !ok || ref.Kind != "clusterroles" || ref.Name != "view" || ref.NS != "" {
		t.Fatalf("cluster role: %+v ok=%v", ref, ok)
	}

	b = obj(t, `{"metadata":{"namespace":"demo"},"roleRef":{"kind":"Role","name":"editor"}}`)
	ref, ok = RoleRefLink(b)
	if !ok || ref.Kind != "roles" || ref.NS != "demo" {
		t.Fatalf("role: %+v ok=%v", ref, ok)
	}
}

// Users and Groups have no object to open; only ServiceAccounts do.
func TestSubjectLinksSplitsOpenableFromPlain(t *testing.T) {
	b := obj(t, `{"metadata":{"namespace":"demo"},"subjects":[
		{"kind":"ServiceAccount","name":"builder"},
		{"kind":"ServiceAccount","name":"remote","namespace":"other"},
		{"kind":"User","name":"alice@example.com"},
		{"kind":"Group","name":"system:masters"}]}`)

	refs, plain := SubjectLinks(b)
	if len(refs) != 2 || refs[0].NS != "demo" || refs[1].NS != "other" {
		t.Fatalf("refs: %+v", refs)
	}
	if len(plain) != 2 || plain[0] != "User: alice@example.com" {
		t.Fatalf("plain: %+v", plain)
	}
}

func TestServiceAccountSecretsSeparatesTokensFromPullSecrets(t *testing.T) {
	sa := obj(t, `{"metadata":{"namespace":"demo"},
		"secrets":[{"name":"builder-token"}],
		"imagePullSecrets":[{"name":"regcred"}]}`)
	refs := ServiceAccountSecrets(sa)
	if len(refs) != 2 || refs[0].Via != "token" || refs[1].Via != "image pull" {
		t.Fatalf("refs: %+v", refs)
	}
	if refs[0].NS != "demo" || refs[0].Kind != "secrets" {
		t.Fatalf("first ref: %+v", refs[0])
	}
}

// The same Deployment reached through six pods is one row hinted "6 pods", not
// six rows.
func TestDedupeRefsMergesVias(t *testing.T) {
	refs := DedupeRefs([]Ref{
		{Kind: "deployments", Name: "api", NS: "demo", Via: "3 pods"},
		{Kind: "deployments", Name: "api", NS: "demo", Via: "template matches"},
		{Kind: "deployments", Name: "api", NS: "demo", Via: "3 pods"},
		{Kind: "deployments", Name: "web", NS: "demo"},
	})
	if len(refs) != 2 {
		t.Fatalf("got %d refs: %+v", len(refs), refs)
	}
	if refs[0].Via != "3 pods, template matches" {
		t.Fatalf("via: %q", refs[0].Via)
	}
	if refs[1].Name != "web" || refs[1].Via != "" {
		t.Fatalf("second: %+v", refs[1])
	}
}

// Same name, different namespace, is a different object.
func TestDedupeRefsKeepsNamespacesApart(t *testing.T) {
	refs := DedupeRefs([]Ref{
		{Kind: "secrets", Name: "tls", NS: "a"},
		{Kind: "secrets", Name: "tls", NS: "b"},
	})
	if len(refs) != 2 {
		t.Fatalf("got %+v", refs)
	}
}

func TestCountVia(t *testing.T) {
	if got := CountVia(1, "pod"); got != "1 pod" {
		t.Errorf("got %q", got)
	}
	if got := CountVia(4, "pod"); got != "4 pods" {
		t.Errorf("got %q", got)
	}
}

// SpecRefs read backwards is what every "used by" list is built on.
func TestRefSetUses(t *testing.T) {
	spec := map[string]any{
		"volumes": []any{
			map[string]any{"name": "cfg", "configMap": map[string]any{"name": "app-config"}},
		},
		"containers": []any{map[string]any{
			"name": "api",
			"env": []any{map[string]any{
				"name":      "MODE",
				"valueFrom": map[string]any{"configMapKeyRef": map[string]any{"name": "app-config"}},
			}},
		}},
	}
	refs := SpecRefs(spec)
	via, ok := refs.Uses("configmaps", "app-config")
	if !ok || via != "volume cfg, env MODE" {
		t.Fatalf("via %q ok=%v", via, ok)
	}
	if _, ok := refs.Uses("configmaps", "other"); ok {
		t.Error("unrelated ConfigMap reported as used")
	}
}

// A `kubectl debug` container is something someone attached by hand and may
// have forgotten; a Secret reached only from one is worth surfacing, not
// omitting.
func TestSpecRefsWalksEphemeralContainers(t *testing.T) {
	spec := map[string]any{
		"containers": []any{map[string]any{"name": "app"}},
		"ephemeralContainers": []any{map[string]any{
			"name": "debugger",
			"env": []any{map[string]any{
				"name":      "TOKEN",
				"valueFrom": map[string]any{"secretKeyRef": map[string]any{"name": "debug-token"}},
			}},
		}},
	}
	refs := SpecRefs(spec)
	via, ok := refs.Uses("secrets", "debug-token")
	if !ok || via != "env TOKEN" {
		t.Fatalf("via %q ok=%v", via, ok)
	}
}

// A CronJob hides its pod template one level deeper. Without that case its
// mounts vanish, and a Secret only a CronJob uses reads as unused.
func TestPodSpecOfReachesIntoACronJobTemplate(t *testing.T) {
	cj := obj(t, `{"kind":"CronJob","spec":{"schedule":"* * * * *","jobTemplate":{"spec":{
		"template":{"spec":{"volumes":[{"name":"s","secret":{"secretName":"backup-creds"}}],
		"containers":[{"name":"backup","image":"busybox"}]}}}}}}`)
	refs := SpecRefs(PodSpecOf(cj))
	if _, ok := refs.Uses("secrets", "backup-creds"); !ok {
		t.Fatal("CronJob's secret not found")
	}
}

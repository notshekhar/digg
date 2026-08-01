package model

import "testing"

func TestServicePortsDefaultsTargetPortAndProtocol(t *testing.T) {
	svc := obj(t, `{"spec":{"ports":[
		{"name":"http","port":80,"targetPort":8080,"nodePort":31234,"protocol":"TCP"},
		{"port":9090}]}}`)
	ports := ServicePorts(svc)
	if len(ports) != 2 {
		t.Fatalf("got %d ports", len(ports))
	}
	if got := ports[0].Text(); got != "80 → 8080/TCP · node 31234" {
		t.Errorf("first: %q", got)
	}
	if ports[0].Label() != "http" {
		t.Errorf("label: %q", ports[0].Label())
	}
	// An unset targetPort means "same as port", and an unset protocol is TCP.
	if got := ports[1].Text(); got != "9090 → 9090/TCP" {
		t.Errorf("second: %q", got)
	}
	if ports[1].Label() != "port 9090" {
		t.Errorf("label: %q", ports[1].Label())
	}
}

// targetPort may be a NAME resolved against the container's own port names,
// not a number. Rendering it as one would be a lie.
func TestServicePortsKeepsNamedTargetPorts(t *testing.T) {
	svc := obj(t, `{"spec":{"ports":[{"port":80,"targetPort":"web"}]}}`)
	if got := ServicePorts(svc)[0].Text(); got != "80 → web/TCP" {
		t.Errorf("got %q", got)
	}
}

func TestServiceDNSNamesOnePerPort(t *testing.T) {
	svc := obj(t, `{"metadata":{"name":"api","namespace":"demo"},
		"spec":{"ports":[{"name":"http","port":80},{"port":9090}]}}`)
	names := ServiceDNSNames(svc)
	if len(names) != 2 || names[0] != "api.demo.svc:80  (http)" || names[1] != "api.demo.svc:9090" {
		t.Fatalf("names: %+v", names)
	}
}

func TestServiceViewNamesTheHeadlessCase(t *testing.T) {
	svc := obj(t, `{"metadata":{"name":"db","namespace":"demo"},
		"spec":{"clusterIP":"None","selector":{"app":"db"},"ports":[{"port":5432}]}}`)
	v := ServiceView(svc, nil, nil, NoMetrics)
	f := factByLabel(v.Groups[0], "Cluster IP")
	if f == nil || f.Text != "None (headless)" {
		t.Fatalf("cluster IP: %+v", f)
	}
}

// A LoadBalancer with no address never provisioned, and on a bare cluster it
// stays that way forever. That is the first thing to notice on the page.
func TestServiceViewFlagsAPendingLoadBalancer(t *testing.T) {
	svc := obj(t, `{"metadata":{"name":"web","namespace":"demo"},
		"spec":{"type":"LoadBalancer","clusterIP":"10.96.0.1","selector":{"app":"web"}}}`)
	v := ServiceView(svc, nil, nil, NoMetrics)
	f := factByLabel(v.Groups[0], "External")
	if f == nil || f.Text != "<pending>" || f.Tone != ToneWarn {
		t.Fatalf("external: %+v", f)
	}
}

func TestServiceViewReadsLoadBalancerIngress(t *testing.T) {
	svc := obj(t, `{"metadata":{"name":"web","namespace":"demo"},
		"spec":{"type":"LoadBalancer","selector":{"app":"web"},"externalIPs":["1.2.3.4"]},
		"status":{"loadBalancer":{"ingress":[{"hostname":"lb.example.com"}]}}}`)
	v := ServiceView(svc, nil, nil, NoMetrics)
	f := factByLabel(v.Groups[0], "External")
	if f == nil || f.Text != "1.2.3.4, lb.example.com" {
		t.Fatalf("external: %+v", f)
	}
}

// The three ways a Service serves nothing are three different bugs, and the
// endpoint count alone cannot tell them apart.
func TestServiceViewDistinguishesTheWaysAServiceServesNothing(t *testing.T) {
	pods := []Obj{*obj(t, `{"metadata":{"name":"api-1","namespace":"demo"}}`)}

	cases := []struct {
		name string
		svc  string
		ep   string
		pods []Obj
		want string
		tone Tone
	}{
		{
			name: "no selector at all",
			svc:  `{"metadata":{"name":"ext","namespace":"demo"},"spec":{"ports":[{"port":80}]}}`,
			want: "no selector — endpoints are managed by hand", tone: ToneWarn,
		},
		{
			name: "selector matches nothing",
			svc:  `{"metadata":{"name":"api","namespace":"demo"},"spec":{"selector":{"app":"api"}}}`,
			want: "selector matches no pods", tone: ToneBad,
		},
		{
			name: "matched pods, none serving",
			svc:  `{"metadata":{"name":"api","namespace":"demo"},"spec":{"selector":{"app":"api"}}}`,
			ep:   `{"subsets":[{"notReadyAddresses":[{"ip":"10.0.0.1"}]}]}`,
			pods: pods,
			want: "none ready · 1 not ready", tone: ToneBad,
		},
		{
			name: "some serving, some not",
			svc:  `{"metadata":{"name":"api","namespace":"demo"},"spec":{"selector":{"app":"api"}}}`,
			ep: `{"subsets":[{"addresses":[{"ip":"10.0.0.1"}],
				"notReadyAddresses":[{"ip":"10.0.0.2"}]}]}`,
			pods: pods,
			want: "1 ready · 1 not ready", tone: ToneWarn,
		},
		{
			name: "healthy",
			svc:  `{"metadata":{"name":"api","namespace":"demo"},"spec":{"selector":{"app":"api"}}}`,
			ep:   `{"subsets":[{"addresses":[{"ip":"10.0.0.1"}]}]}`,
			pods: pods,
			want: "1 ready", tone: ToneOK,
		},
		{
			name: "ExternalName does not use endpoints",
			svc: `{"metadata":{"name":"ext","namespace":"demo"},
				"spec":{"type":"ExternalName","externalName":"db.example.com"}}`,
			want: "not used by ExternalName", tone: ToneNeutral,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var ep *Obj
			if tc.ep != "" {
				ep = obj(t, tc.ep)
			}
			v := ServiceView(obj(t, tc.svc), ep, tc.pods, NoMetrics)
			g := groupByTitle(v, "Endpoints")
			if g == nil {
				t.Fatal("no Endpoints group")
			}
			f := factByLabel(*g, "Endpoints")
			if f == nil || f.Text != tc.want || f.Tone != tc.tone {
				t.Fatalf("got %+v, want %q/%s", f, tc.want, tc.tone)
			}
		})
	}
}

// "No Endpoints object at all" is its own failure: the controller never ran.
func TestServiceViewNoticesAMissingEndpointsObject(t *testing.T) {
	svc := obj(t, `{"metadata":{"name":"api","namespace":"demo"},"spec":{"selector":{"app":"api"}}}`)
	pods := []Obj{*obj(t, `{"metadata":{"name":"api-1","namespace":"demo"}}`)}
	v := ServiceView(svc, nil, pods, NoMetrics)
	f := factByLabel(*groupByTitle(v, "Endpoints"), "Endpoints")
	if f == nil || f.Text != "no Endpoints object" {
		t.Fatalf("got %+v", f)
	}
}

// A Service's pods are "selected" and "serving" — never a workload's four
// rollout counters, which would be four wrong words under a correct table.
func TestServiceViewCountsAreServiceWords(t *testing.T) {
	svc := obj(t, `{"metadata":{"name":"api","namespace":"demo"},"spec":{"selector":{"app":"api"}}}`)
	ep := obj(t, `{"subsets":[{"addresses":[{"ip":"10.0.0.1","targetRef":{"name":"api-1"}}],
		"notReadyAddresses":[{"ip":"10.0.0.2","targetRef":{"name":"api-2"}}]}]}`)
	pods := []Obj{
		*obj(t, `{"metadata":{"name":"api-1","namespace":"demo"},"status":{"phase":"Running"}}`),
		*obj(t, `{"metadata":{"name":"api-2","namespace":"demo"},"status":{"phase":"Running"}}`),
	}
	v := ServiceView(svc, ep, pods, NoMetrics)
	if v.Pods == nil {
		t.Fatal("no pods block")
	}
	if v.Pods.Title != "Pods behind this Service" {
		t.Errorf("title: %q", v.Pods.Title)
	}
	want := [][2]string{{"selected", "2"}, {"serving", "1"}, {"not serving", "1"}}
	if len(v.Pods.Counts) != len(want) {
		t.Fatalf("counts: %+v", v.Pods.Counts)
	}
	for i, w := range want {
		if v.Pods.Counts[i].K != w[0] || v.Pods.Counts[i].V != w[1] {
			t.Fatalf("count %d: %+v, want %v", i, v.Pods.Counts[i], w)
		}
	}
	if len(v.Pods.Rows) != 2 {
		t.Fatalf("rows: %d", len(v.Pods.Rows))
	}
}

// An ExternalName record has no pods to draw, and an empty table under it is
// noise.
func TestServiceViewOmitsThePodTableWithoutASelector(t *testing.T) {
	svc := obj(t, `{"metadata":{"name":"ext","namespace":"demo"},
		"spec":{"type":"ExternalName","externalName":"db.example.com"}}`)
	v := ServiceView(svc, nil, nil, NoMetrics)
	if v.Pods != nil {
		t.Fatalf("pods block: %+v", v.Pods)
	}
	if f := factByLabel(v.Groups[0], "External Name"); f == nil || f.Text != "db.example.com" {
		t.Fatalf("external name: %+v", f)
	}
}

// The selector belongs on the identity card, third, the way a workload's does —
// it is the field you read to understand every other fact on the page.
func TestServiceViewPutsTheSelectorInTheHeader(t *testing.T) {
	svc := obj(t, `{"metadata":{"name":"api","namespace":"demo"},
		"spec":{"selector":{"app":"api","tier":"web"}}}`)
	v := ServiceView(svc, nil, nil, NoMetrics)
	if v.Header.Facts[2].Label != "Selector" {
		t.Fatalf("header: %+v", v.Header.Facts[2].Label)
	}
	chips := v.Header.Facts[2].Chips
	if len(chips) != 2 || chips[0].K != "app" || chips[1].K != "tier" {
		t.Fatalf("chips: %+v", chips)
	}
}

// publishNotReadyAddresses changes what the Service does, so it only earns a
// row when it is on.
func TestServiceViewOnlyShowsPublishNotReadyWhenSet(t *testing.T) {
	off := ServiceView(obj(t, `{"metadata":{"name":"a","namespace":"d"},"spec":{"selector":{"a":"b"}}}`),
		nil, nil, NoMetrics)
	if factByLabel(off.Groups[0], "Publish Not Ready Addresses") != nil {
		t.Error("shown when unset")
	}
	on := ServiceView(obj(t, `{"metadata":{"name":"a","namespace":"d"},
		"spec":{"selector":{"a":"b"},"publishNotReadyAddresses":true}}`), nil, nil, NoMetrics)
	f := factByLabel(on.Groups[0], "Publish Not Ready Addresses")
	if f == nil || f.Tone != ToneWarn {
		t.Fatalf("got %+v", f)
	}
}

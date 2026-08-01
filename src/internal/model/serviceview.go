package model

import (
	"fmt"
	"strings"
)

// The rich Service page.
//
// A Service is almost entirely made of pointers: a selector pointing at pods, a
// targetPort pointing at a container port, an Endpoints object pointing back,
// and — one owner hop further — the Deployment that is actually serving the
// traffic. The old summary flattened all of that into six key/value rows and
// one table of pods, which meant the two questions people open a Service to ask
// ("is anything behind this?" and "what do I edit to change it?") both needed a
// second page.
//
// So the Service gets the same treatment pods and workloads got: every field
// parsed, every pointer followed. What needs the cluster (the workloads behind
// it, the Ingresses pointing at it) is resolved in server/links.go and appended
// as Related groups; everything here is a pure function of the Service, its
// Endpoints, and the pods it selects.

// ServicePort is one parsed entry of spec.ports.
type ServicePort struct {
	Name        string
	Port        string
	TargetPort  string
	NodePort    string
	Protocol    string
	AppProtocol string
}

// ServicePorts parses spec.ports.
//
// targetPort defaults to port when unset, and may be a NAME rather than a
// number — that name resolves against the container's own port names, which is
// why the container cards on the workload page matter for reading this one.
func ServicePorts(o *Obj) []ServicePort {
	out := []ServicePort{}
	for _, raw := range slice(o, "spec", "ports") {
		p := asMap(raw)
		port := mstr(p, "port")
		target := mstr(p, "targetPort")
		if target == "" {
			target = port
		}
		proto := mstr(p, "protocol")
		if proto == "" {
			proto = "TCP"
		}
		out = append(out, ServicePort{
			Name:        mstr(p, "name"),
			Port:        port,
			TargetPort:  target,
			NodePort:    mstr(p, "nodePort"),
			Protocol:    proto,
			AppProtocol: mstr(p, "appProtocol"),
		})
	}
	return out
}

// Text renders a port as "80 → 8080/TCP · node 31234".
func (p ServicePort) Text() string {
	text := fmt.Sprintf("%s → %s/%s", p.Port, p.TargetPort, p.Protocol)
	if p.NodePort != "" && p.NodePort != "0" {
		text += " · node " + p.NodePort
	}
	if p.AppProtocol != "" {
		text += " · " + p.AppProtocol
	}
	return text
}

// Label names a port row: its own name when it has one, else the port number.
// Named ports are what an Ingress backend and a probe refer to, so the name is
// the identifier and the number is the detail.
func (p ServicePort) Label() string {
	if p.Name != "" {
		return p.Name
	}
	return "port " + p.Port
}

// serviceAddresses collects the ways in, in the order they are worth trying.
func serviceAddresses(o *Obj) (cluster []string, external []string) {
	cluster, external = []string{}, []string{}
	for _, ip := range stringsAt(o, "spec", "clusterIPs") {
		cluster = append(cluster, ip)
	}
	if len(cluster) == 0 {
		if ip := str(o, "spec", "clusterIP"); ip != "" {
			cluster = append(cluster, ip)
		}
	}
	external = append(external, stringsAt(o, "spec", "externalIPs")...)
	for _, raw := range slice(o, "status", "loadBalancer", "ingress") {
		i := asMap(raw)
		v := mstr(i, "ip")
		if v == "" {
			v = mstr(i, "hostname")
		}
		if v != "" {
			external = append(external, v)
		}
	}
	return cluster, external
}

func stringsAt(o *Obj, path ...string) []string {
	out := []string{}
	for _, v := range slice(o, path...) {
		if s := valueString(v); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// ServiceDNSNames are the in-cluster names this Service answers on, one per
// port — the string you paste into another app's config, which is otherwise
// assembled from memory every single time.
func ServiceDNSNames(o *Obj) []string {
	ns := o.GetNamespace()
	if ns == "" {
		return []string{}
	}
	base := o.GetName() + "." + ns + ".svc"
	ports := ServicePorts(o)
	if len(ports) == 0 {
		return []string{base}
	}
	out := make([]string, 0, len(ports))
	for _, p := range ports {
		line := base + ":" + p.Port
		if p.Name != "" {
			line += "  (" + p.Name + ")"
		}
		out = append(out, line)
	}
	return out
}

// serviceFacts is the parsed spec: everything the API accepted, named the way
// the field is named, with the ones that are only meaningful for some Service
// types left out of the others.
func serviceFacts(o *Obj) []Fact {
	typ := str(o, "spec", "type")
	if typ == "" {
		typ = "ClusterIP"
	}
	cluster, external := serviceAddresses(o)

	facts := []Fact{{Label: "Type", Text: typ}}

	// A headless Service (clusterIP: None) resolves straight to pod IPs and has
	// no virtual IP at all; calling that field "Cluster IP: None" reads like an
	// error, so it is named for what it is.
	switch {
	case len(cluster) == 1 && cluster[0] == "None":
		facts = append(facts, Fact{Label: "Cluster IP", Text: "None (headless)"})
	case len(cluster) > 0:
		facts = append(facts, Fact{Label: "Cluster IP", Text: strings.Join(cluster, ", ")})
	default:
		facts = append(facts, Fact{Label: "Cluster IP", Text: "—"})
	}

	if name := str(o, "spec", "externalName"); name != "" {
		facts = append(facts, Fact{Label: "External Name", Text: name})
	}

	switch {
	case len(external) > 0:
		facts = append(facts, Fact{Label: "External", Text: strings.Join(external, ", ")})
	case typ == "LoadBalancer":
		// A LoadBalancer with no address is a LoadBalancer nothing provisioned —
		// on a bare cluster it stays this way forever, and it is the first thing
		// to notice.
		facts = append(facts, Fact{Label: "External", Text: "<pending>", Tone: ToneWarn})
	}

	affinity := str(o, "spec", "sessionAffinity")
	if affinity == "" {
		affinity = "None"
	}
	if secs := intOf(o, "spec", "sessionAffinityConfig", "clientIP", "timeoutSeconds"); secs > 0 {
		affinity = fmt.Sprintf("%s (%ds)", affinity, secs)
	}
	facts = append(facts, Fact{Label: "Session Affinity", Text: affinity})

	if p := str(o, "spec", "externalTrafficPolicy"); p != "" {
		facts = append(facts, Fact{Label: "External Traffic Policy", Text: p})
	}
	if p := str(o, "spec", "internalTrafficPolicy"); p != "" {
		facts = append(facts, Fact{Label: "Internal Traffic Policy", Text: p})
	}
	if fams := stringsAt(o, "spec", "ipFamilies"); len(fams) > 0 {
		text := strings.Join(fams, ", ")
		if policy := str(o, "spec", "ipFamilyPolicy"); policy != "" {
			text += " · " + policy
		}
		facts = append(facts, Fact{Label: "IP Families", Text: text})
	}
	if port := str(o, "spec", "healthCheckNodePort"); port != "" && port != "0" {
		facts = append(facts, Fact{Label: "Health Check Node Port", Text: port})
	}
	if class := str(o, "spec", "loadBalancerClass"); class != "" {
		facts = append(facts, Fact{Label: "Load Balancer Class", Text: class})
	}
	if ranges := stringsAt(o, "spec", "loadBalancerSourceRanges"); len(ranges) > 0 {
		facts = append(facts, Fact{Label: "Source Ranges", Items: ranges, Wide: true})
	}
	// Only worth a row when it is on: it changes what the Service does, sending
	// traffic to pods that have said they are not ready.
	if boolOf(o, "spec", "publishNotReadyAddresses") {
		facts = append(facts,
			Fact{Label: "Publish Not Ready Addresses", Text: "true", Tone: ToneWarn})
	}
	return facts
}

// portsGroup is one row per port, plus the DNS names those ports answer on.
func portsGroup(o *Obj) FactGroup {
	facts := []Fact{}
	for _, p := range ServicePorts(o) {
		facts = append(facts, Fact{Label: p.Label(), Text: p.Text()})
	}
	if len(facts) == 0 {
		facts = append(facts, Fact{Label: "Ports", Text: "—"})
	}
	if dns := ServiceDNSNames(o); len(dns) > 0 {
		facts = append(facts, Fact{Label: "In-cluster DNS", Items: dns, Wide: true})
	}
	return FactGroup{Title: "Ports", Facts: facts}
}

// endpointsGroup says whether anything is actually serving, and why not.
func endpointsGroup(svc *Obj, ep EndpointsInfo, epFound bool, selected int) FactGroup {
	selector := ServiceSelector(svc)
	ready, notReady := len(ep.Ready), len(ep.NotReady)

	// The three ways a Service serves nothing are different bugs with different
	// fixes, and the endpoint count alone cannot tell them apart: no selector at
	// all (someone is meant to maintain Endpoints by hand), a selector matching
	// no pods (wrong labels), or matched pods that are failing readiness.
	state := Fact{Label: "Endpoints", Text: fmt.Sprintf("%d ready", ready), Tone: ToneOK}
	switch {
	case str(svc, "spec", "type") == "ExternalName":
		state = Fact{Label: "Endpoints", Text: "not used by ExternalName", Tone: ToneNeutral}
	case ready > 0 && notReady > 0:
		state = Fact{Label: "Endpoints", Tone: ToneWarn,
			Text: fmt.Sprintf("%d ready · %d not ready", ready, notReady)}
	case ready > 0:
	case notReady > 0:
		state = Fact{Label: "Endpoints", Tone: ToneBad,
			Text: fmt.Sprintf("none ready · %d not ready", notReady)}
	case len(selector) == 0:
		state = Fact{Label: "Endpoints", Tone: ToneWarn,
			Text: "no selector — endpoints are managed by hand"}
	case selected == 0:
		state = Fact{Label: "Endpoints", Tone: ToneBad, Text: "selector matches no pods"}
	case !epFound:
		state = Fact{Label: "Endpoints", Tone: ToneBad, Text: "no Endpoints object"}
	default:
		state = Fact{Label: "Endpoints", Tone: ToneBad, Text: "no addresses"}
	}

	facts := []Fact{state}
	if len(ep.Ports) > 0 {
		facts = append(facts, Fact{Label: "Serving Ports", Text: strings.Join(ep.Ports, ", ")})
	}
	if lines := ep.AddressLines(); len(lines) > 0 {
		facts = append(facts, Fact{Label: "Addresses", Items: lines, Wide: true})
	}
	return FactGroup{Title: "Endpoints", Facts: facts}
}

// ServiceView is the full page model for a Service.
//
// pods are the pods its selector matched; ep is its Endpoints object, which may
// be absent — a Service that never got one is a different failure from one
// whose addresses are all unready, and the page has to be able to say which.
func ServiceView(svc *Obj, ep *Obj, pods []Obj, metrics *Metrics) DetailView {
	info := ParseEndpoints(ep)
	readyIP := map[string]bool{}
	for _, a := range info.Ready {
		if a.PodName != "" {
			readyIP[a.PodName] = true
		}
	}

	header := headerGroup(svc)
	selFact := Fact{Label: "Selector", Chips: chipsFrom(ServiceSelector(svc))}
	header.Facts = append(header.Facts[:2], append([]Fact{selFact}, header.Facts[2:]...)...)

	rows := make([]PodLine, 0, len(pods))
	for i := range pods {
		rows = append(rows, PodLineFor(&pods[i], metrics))
	}

	view := DetailView{
		Header: header,
		Groups: []FactGroup{
			{Facts: serviceFacts(svc)},
			portsGroup(svc),
			endpointsGroup(svc, info, ep != nil, len(pods)),
		},
		Containers: []ContainerView{},
	}
	// A Service with no selector has no pods to draw, and an empty "Pods" table
	// under an ExternalName record is noise.
	if len(ServiceSelector(svc)) > 0 || len(rows) > 0 {
		view.Pods = &PodsBlock{
			Title: "Pods behind this Service",
			Rows:  rows,
			Counts: []Chip{
				{K: "selected", V: fmt.Sprintf("%d", len(pods))},
				{K: "serving", V: fmt.Sprintf("%d", len(info.Ready)), Tone: toneForCount(len(info.Ready))},
				{K: "not serving", V: fmt.Sprintf("%d", len(info.NotReady)),
					Tone: toneForProblem(len(info.NotReady))},
			},
		}
	}
	return view
}

func toneForCount(n int) Tone {
	if n > 0 {
		return ToneOK
	}
	return ToneBad
}

func toneForProblem(n int) Tone {
	if n > 0 {
		return ToneWarn
	}
	return ToneNeutral
}

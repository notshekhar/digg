package model

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Port of src/format.ts — the curated kind table and its column helpers.
//
// Column choices follow `kubectl get`'s own output, because that is the table
// every operator has already memorised. Everything past the first dozen kinds
// exists so a cluster browser is never a dead end: RBAC, storage, policy and
// scheduling kinds all get real columns instead of the NAME/STATUS/AGE fallback
// in GenericKind.

// KindDef describes one listable kind.
type KindDef struct {
	// Name is the kubectl resource name (plural).
	Name string
	// Title is the short label shown in the UI.
	Title string
	// Kind is the PascalCase singular Kind (e.g. "Pod"), used for event field
	// selectors.
	Kind          string
	ClusterScoped bool
	Columns       []string
	// Row extracts cell values, excluding the leading NAMESPACE column.
	Row func(*Obj) []string
	// Generic is true for kinds discovered at runtime (CRDs etc.) rather than
	// curated.
	Generic bool
}

// ── pod helpers ─────────────────────────────────────────────────────────────

func podReady(o *Obj) string {
	statuses := slice(o, "status", "containerStatuses")
	ready := 0
	for _, raw := range statuses {
		if b, ok := asMap(raw)["ready"].(bool); ok && b {
			ready++
		}
	}
	total := len(statuses)
	if total == 0 {
		total = len(slice(o, "spec", "containers"))
	}
	return fmt.Sprintf("%d/%d", ready, total)
}

func podRestarts(o *Obj) string {
	sum := int64(0)
	for _, raw := range slice(o, "status", "containerStatuses") {
		if v, ok := asMap(raw)["restartCount"]; ok {
			if n, err := strconv.ParseInt(valueString(v), 10, 64); err == nil {
				sum += n
			}
		}
	}
	return strconv.FormatInt(sum, 10)
}

// PodPhase is the STATUS cell. A container's waiting/terminated reason beats
// the pod phase, because "Running" over a CrashLoopBackOff container is a lie.
func PodPhase(o *Obj) string {
	if str(o, "metadata", "deletionTimestamp") != "" {
		return "Terminating"
	}
	for _, raw := range slice(o, "status", "containerStatuses") {
		state := mmap(asMap(raw), "state")
		reason := mstr(mmap(state, "waiting"), "reason")
		if reason == "" {
			reason = mstr(mmap(state, "terminated"), "reason")
		}
		if reason != "" && reason != "Completed" {
			return reason
		}
	}
	if r := str(o, "status", "reason"); r != "" {
		return r
	}
	return str(o, "status", "phase")
}

func deployReady(o *Obj) string {
	return fmt.Sprintf("%d/%d", intOf(o, "status", "readyReplicas"), intOf(o, "status", "replicas"))
}

// ── service / ingress helpers ───────────────────────────────────────────────

func servicePorts(o *Obj) string {
	ports := slice(o, "spec", "ports")
	out := make([]string, 0, len(ports))
	for _, raw := range ports {
		p := asMap(raw)
		proto := mstr(p, "protocol")
		if proto == "" {
			proto = "TCP"
		}
		s := mstr(p, "port")
		if np := mstr(p, "nodePort"); np != "" && np != "0" {
			s += ":" + np
		}
		out = append(out, s+"/"+proto)
	}
	if len(out) == 0 {
		return "<none>"
	}
	return strings.Join(out, ",")
}

func serviceExternalIP(o *Obj) string {
	ingress := slice(o, "status", "loadBalancer", "ingress")
	if len(ingress) > 0 {
		parts := []string{}
		for _, raw := range ingress {
			i := asMap(raw)
			v := mstr(i, "ip")
			if v == "" {
				v = mstr(i, "hostname")
			}
			if v != "" {
				parts = append(parts, v)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, ",")
		}
		return "<pending>"
	}
	if ips := slice(o, "spec", "externalIPs"); len(ips) > 0 {
		parts := make([]string, 0, len(ips))
		for _, v := range ips {
			parts = append(parts, valueString(v))
		}
		return strings.Join(parts, ",")
	}
	if str(o, "spec", "type") == "LoadBalancer" {
		return "<pending>"
	}
	return "<none>"
}

// IngressRuleRows flattens an ingress's rules into [HOST, PATH, SERVICE, PORT].
func IngressRuleRows(o *Obj) [][]string {
	rows := [][]string{}
	for _, raw := range slice(o, "spec", "rules") {
		rule := asMap(raw)
		host := mstr(rule, "host")
		if host == "" {
			host = "*"
		}
		paths := mslice(mmap(rule, "http"), "paths")
		if len(paths) == 0 {
			rows = append(rows, []string{host, "/", "—", "—"})
			continue
		}
		for _, praw := range paths {
			p := asMap(praw)
			svc := mmap(mmap(p, "backend"), "service")
			port := ""
			if pm := mmap(svc, "port"); pm != nil {
				port = mstr(pm, "number")
				if port == "" {
					port = mstr(pm, "name")
				}
			}
			path := mstr(p, "path")
			if path == "" {
				path = "/"
			}
			name := mstr(svc, "name")
			if name == "" {
				name = "—"
			}
			rows = append(rows, []string{host, path, name, port})
		}
	}
	return rows
}

// IngressRoute is one openable route.
type IngressRoute struct {
	URL     string `json:"url"`
	Host    string `json:"host"`
	Path    string `json:"path"`
	Service string `json:"service"`
	Port    string `json:"port"`
}

// IngressRoutes are the same rules as openable routes: a real URL (https when
// the host is in a TLS block) plus the backend it lands on. The Ingress table
// renders these as links, which is the difference between reading a routing
// rule and using it.
func IngressRoutes(o *Obj) []IngressRoute {
	tlsHosts := map[string]bool{}
	for _, raw := range slice(o, "spec", "tls") {
		for _, h := range mslice(asMap(raw), "hosts") {
			tlsHosts[valueString(h)] = true
		}
	}
	rows := IngressRuleRows(o)
	out := make([]IngressRoute, 0, len(rows))
	for _, r := range rows {
		host, path, service, port := r[0], r[1], r[2], r[3]
		scheme := "http"
		if tlsHosts[host] {
			scheme = "https"
		}
		url := ""
		if host != "*" {
			url = scheme + "://" + host + path
		}
		out = append(out, IngressRoute{URL: url, Host: host, Path: path, Service: service, Port: port})
	}
	return out
}

func ingressRulesText(o *Obj) string {
	routes := IngressRoutes(o)
	if len(routes) == 0 {
		return "<none>"
	}
	parts := make([]string, 0, len(routes))
	for _, r := range routes {
		left := r.URL
		if left == "" {
			left = r.Host + r.Path
		}
		parts = append(parts, fmt.Sprintf("%s → %s:%s", left, r.Service, r.Port))
	}
	return strings.Join(parts, "  ")
}

func ingressAddress(o *Obj) string {
	parts := []string{}
	for _, raw := range slice(o, "status", "loadBalancer", "ingress") {
		i := asMap(raw)
		v := mstr(i, "ip")
		if v == "" {
			v = mstr(i, "hostname")
		}
		if v != "" {
			parts = append(parts, v)
		}
	}
	return strings.Join(parts, ",")
}

func ingressPorts(o *Obj) string {
	if len(slice(o, "spec", "tls")) > 0 {
		return "80, 443"
	}
	return "80"
}

// ── job helpers ─────────────────────────────────────────────────────────────

func jobCompletions(o *Obj) string {
	completions := intOf(o, "spec", "completions")
	if completions == 0 {
		completions = 1
	}
	return fmt.Sprintf("%d/%d", intOf(o, "status", "succeeded"), completions)
}

func jobDuration(o *Obj) string {
	startText := str(o, "status", "startTime")
	if startText == "" {
		return ""
	}
	start, err := time.Parse(time.RFC3339, startText)
	if err != nil {
		return ""
	}
	end := Now()
	if ct := str(o, "status", "completionTime"); ct != "" {
		if t, err := time.Parse(time.RFC3339, ct); err == nil {
			end = t
		}
	}
	seconds := end.Sub(start).Seconds()
	if seconds < 0 {
		seconds = 0
	}
	if seconds < 60 {
		return fmt.Sprintf("%ds", int64(seconds))
	}
	if seconds < 3600 {
		return fmt.Sprintf("%dm", int64(seconds/60))
	}
	return fmt.Sprintf("%dh", int64(seconds/3600))
}

// JobStatus is the STATUS cell for a Job.
func JobStatus(o *Obj) string {
	for _, raw := range slice(o, "status", "conditions") {
		c := asMap(raw)
		if mstr(c, "type") == "Complete" && mstr(c, "status") == "True" {
			return "Complete"
		}
	}
	for _, raw := range slice(o, "status", "conditions") {
		c := asMap(raw)
		if mstr(c, "type") == "Failed" && mstr(c, "status") == "True" {
			return "Failed"
		}
	}
	if intOf(o, "status", "active") > 0 {
		return "Running"
	}
	return "Pending"
}

func cronActive(o *Obj) string {
	return strconv.Itoa(len(slice(o, "status", "active")))
}

// ── node helpers ────────────────────────────────────────────────────────────

// NodeRoles reads the node-role.kubernetes.io/* labels.
func NodeRoles(o *Obj) string {
	roles := []string{}
	for k := range o.GetLabels() {
		const prefix = "node-role.kubernetes.io/"
		if strings.HasPrefix(k, prefix) {
			if r := k[len(prefix):]; r != "" {
				roles = append(roles, r)
			}
		}
	}
	if len(roles) == 0 {
		return "<none>"
	}
	sort.Strings(roles)
	return strings.Join(roles, ",")
}

func nodeInternalIP(o *Obj) string {
	for _, raw := range slice(o, "status", "addresses") {
		a := asMap(raw)
		if mstr(a, "type") == "InternalIP" {
			return mstr(a, "address")
		}
	}
	return ""
}

func nodeReady(o *Obj) string {
	for _, raw := range slice(o, "status", "conditions") {
		c := asMap(raw)
		if mstr(c, "type") != "Ready" {
			continue
		}
		if mstr(c, "status") != "True" {
			return "NotReady"
		}
		if boolOf(o, "spec", "unschedulable") {
			return "Ready,SchedulingDisabled"
		}
		return "Ready"
	}
	return "NotReady"
}

// ── storage helpers ─────────────────────────────────────────────────────────

var accessModeAbbr = map[string]string{
	"ReadWriteOnce":    "RWO",
	"ReadOnlyMany":     "ROX",
	"ReadWriteMany":    "RWX",
	"ReadWriteOncePod": "RWOP",
}

// PVCAccessModes abbreviates access modes the way kubectl does.
func PVCAccessModes(o *Obj) string {
	modes := slice(o, "status", "accessModes")
	if len(modes) == 0 {
		modes = slice(o, "spec", "accessModes")
	}
	out := make([]string, 0, len(modes))
	for _, m := range modes {
		s := valueString(m)
		if abbr, ok := accessModeAbbr[s]; ok {
			s = abbr
		}
		out = append(out, s)
	}
	return strings.Join(out, ",")
}

// ── shared cell helpers ─────────────────────────────────────────────────────

func endpointAddresses(o *Obj) string {
	out := []string{}
	for _, sraw := range slice(o, "subsets") {
		s := asMap(sraw)
		addrs := mslice(s, "addresses")
		ports := mslice(s, "ports")
		for _, araw := range addrs {
			a := asMap(araw)
			ip := mstr(a, "ip")
			for _, praw := range ports {
				out = append(out, ip+":"+mstr(asMap(praw), "port"))
			}
			if len(ports) == 0 && ip != "" {
				out = append(out, ip)
			}
		}
	}
	if len(out) == 0 {
		return "<none>"
	}
	// kubectl truncates the same way; a full endpoint list can be hundreds long.
	if len(out) > 3 {
		return fmt.Sprintf("%s +%d more", strings.Join(out[:3], ","), len(out)-3)
	}
	return strings.Join(out, ",")
}

func selectorText(sel map[string]any) string {
	labels := []string{}
	if ml := mmap(sel, "matchLabels"); ml != nil {
		keys := make([]string, 0, len(ml))
		for k := range ml {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			labels = append(labels, k+"="+valueString(ml[k]))
		}
	}
	if exprs := mslice(sel, "matchExpressions"); len(exprs) > 0 {
		labels = append(labels, fmt.Sprintf("+%d expr", len(exprs)))
	}
	if len(labels) == 0 {
		return "<none>"
	}
	return strings.Join(labels, ",")
}

func roleRefText(o *Obj) string {
	ref := mapOf(o, "roleRef")
	if ref == nil {
		return ""
	}
	return mstr(ref, "kind") + "/" + mstr(ref, "name")
}

func subjectsText(o *Obj) string {
	subjects := slice(o, "subjects")
	if len(subjects) == 0 {
		return "<none>"
	}
	parts := make([]string, 0, len(subjects))
	for _, raw := range subjects {
		s := asMap(raw)
		parts = append(parts, mstr(s, "kind")+":"+mstr(s, "name"))
	}
	if len(parts) > 2 {
		return fmt.Sprintf("%s +%d", strings.Join(parts[:2], ", "), len(parts)-2)
	}
	return strings.Join(parts, ", ")
}

func hpaTargets(o *Obj) string {
	specs := slice(o, "spec", "metrics")
	current := slice(o, "status", "currentMetrics")
	if len(specs) == 0 {
		return "<none>"
	}
	parts := make([]string, 0, len(specs))
	for i, raw := range specs {
		m := asMap(raw)
		res := mmap(m, "resource")
		name := mstr(res, "name")
		if name == "" {
			name = mstr(m, "type")
		}
		target := mmap(res, "target")
		want := "?"
		if v := mstr(target, "averageUtilization"); v != "" {
			want = v + "%"
		} else if v := mstr(target, "averageValue"); v != "" {
			want = v
		}
		have := "<unknown>"
		if i < len(current) {
			cur := mmap(mmap(asMap(current[i]), "resource"), "current")
			if v := mstr(cur, "averageUtilization"); v != "" {
				have = v + "%"
			} else if v := mstr(cur, "averageValue"); v != "" {
				have = v
			}
		}
		parts = append(parts, fmt.Sprintf("%s: %s/%s", name, have, want))
	}
	return strings.Join(parts, ", ")
}

func countKeys(o *Obj, path ...string) string {
	return strconv.Itoa(len(stringMap(o, path...)))
}

func countSlice(o *Obj, path ...string) string {
	return strconv.Itoa(len(slice(o, path...)))
}

// Kinds is the curated table.
var Kinds = []KindDef{
	{
		Name: "pods", Title: "Pods", Kind: "Pod",
		Columns: []string{"NAME", "READY", "STATUS", "RESTARTS", "IP", "NODE", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), podReady(o), PodPhase(o), podRestarts(o),
				none(str(o, "status", "podIP")), none(str(o, "spec", "nodeName")), Age(o)}
		},
	},
	{
		Name: "deployments", Title: "Deployments", Kind: "Deployment",
		Columns: []string{"NAME", "READY", "DESIRED", "UPDATED", "AVAILABLE", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), deployReady(o),
				numOr(o, 0, "spec", "replicas"), numOr(o, 0, "status", "updatedReplicas"),
				numOr(o, 0, "status", "availableReplicas"), Age(o)}
		},
	},
	{
		Name: "statefulsets", Title: "StatefulSets", Kind: "StatefulSet",
		Columns: []string{"NAME", "READY", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), deployReady(o), Age(o)} },
	},
	{
		Name: "daemonsets", Title: "DaemonSets", Kind: "DaemonSet",
		Columns: []string{"NAME", "DESIRED", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o),
				numOr(o, 0, "status", "desiredNumberScheduled"), numOr(o, 0, "status", "numberReady"),
				numOr(o, 0, "status", "updatedNumberScheduled"), numOr(o, 0, "status", "numberAvailable"), Age(o)}
		},
	},
	{
		Name: "services", Title: "Services", Kind: "Service",
		Columns: []string{"NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORTS", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), str(o, "spec", "type"), str(o, "spec", "clusterIP"),
				serviceExternalIP(o), servicePorts(o), Age(o)}
		},
	},
	{
		Name: "ingresses", Title: "Ingresses", Kind: "Ingress",
		Columns: []string{"NAME", "RULES", "CLASS", "LOAD BALANCER", "PORTS", "AGE"},
		Row: func(o *Obj) []string {
			addr := ingressAddress(o)
			if addr == "" {
				addr = "Pending"
			}
			return []string{Name(o), ingressRulesText(o), none(str(o, "spec", "ingressClassName")),
				addr, ingressPorts(o), Age(o)}
		},
	},
	{
		Name: "configmaps", Title: "ConfigMaps", Kind: "ConfigMap",
		Columns: []string{"NAME", "DATA", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), countKeys(o, "data"), Age(o)} },
	},
	{
		Name: "secrets", Title: "Secrets", Kind: "Secret",
		Columns: []string{"NAME", "TYPE", "DATA", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), str(o, "type"), countKeys(o, "data"), Age(o)}
		},
	},
	{
		Name: "jobs", Title: "Jobs", Kind: "Job",
		Columns: []string{"NAME", "STATUS", "COMPLETIONS", "DURATION", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), JobStatus(o), jobCompletions(o), jobDuration(o), Age(o)}
		},
	},
	{
		Name: "cronjobs", Title: "CronJobs", Kind: "CronJob",
		Columns: []string{"NAME", "SCHEDULE", "SUSPEND", "ACTIVE", "LAST SCHEDULE", "AGE"},
		Row: func(o *Obj) []string {
			last := AgeFrom(str(o, "status", "lastScheduleTime"))
			if last == "" {
				last = "<none>"
			}
			return []string{Name(o), str(o, "spec", "schedule"),
				strconv.FormatBool(boolOf(o, "spec", "suspend")), cronActive(o), last, Age(o)}
		},
	},
	{
		Name: "nodes", Title: "Nodes", Kind: "Node", ClusterScoped: true,
		Columns: []string{"NAME", "STATUS", "ROLES", "VERSION", "INTERNAL-IP", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), nodeReady(o), NodeRoles(o),
				str(o, "status", "nodeInfo", "kubeletVersion"), nodeInternalIP(o), Age(o)}
		},
	},
	{
		Name: "namespaces", Title: "Namespaces", Kind: "Namespace", ClusterScoped: true,
		Columns: []string{"NAME", "STATUS", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), str(o, "status", "phase"), Age(o)} },
	},
	{
		Name: "persistentvolumeclaims", Title: "PVCs", Kind: "PersistentVolumeClaim",
		Columns: []string{"NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS", "STORAGECLASS", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), str(o, "status", "phase"), none(str(o, "spec", "volumeName")),
				str(o, "status", "capacity", "storage"), PVCAccessModes(o),
				none(str(o, "spec", "storageClassName")), Age(o)}
		},
	},
	{
		// Events are the one kind whose NAME column is noise (a hash), so the
		// first column is the object the event is about.
		Name: "events", Title: "Events", Kind: "Event",
		Columns: []string{"TYPE", "REASON", "OBJECT", "MESSAGE", "COUNT", "LAST SEEN"},
		Row: func(o *Obj) []string {
			inv := mapOf(o, "involvedObject")
			object := ""
			if inv != nil {
				object = mstr(inv, "kind") + "/" + mstr(inv, "name")
			}
			last := str(o, "lastTimestamp")
			if last == "" {
				last = str(o, "eventTime")
			}
			if last == "" {
				last = str(o, "firstTimestamp")
			}
			seen := AgeFrom(last)
			if seen == "" {
				seen = "-"
			}
			typ := str(o, "type")
			if typ == "" {
				typ = "Normal"
			}
			return []string{typ, str(o, "reason"), object,
				collapseSpace(str(o, "message")), numOr(o, 1, "count"), seen}
		},
	},
	{
		Name: "replicasets", Title: "ReplicaSets", Kind: "ReplicaSet",
		Columns: []string{"NAME", "DESIRED", "CURRENT", "READY", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), numOr(o, 0, "spec", "replicas"),
				numOr(o, 0, "status", "replicas"), numOr(o, 0, "status", "readyReplicas"), Age(o)}
		},
	},
	{
		Name: "endpoints", Title: "Endpoints", Kind: "Endpoints",
		Columns: []string{"NAME", "ENDPOINTS", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), endpointAddresses(o), Age(o)} },
	},
	{
		Name: "endpointslices", Title: "EndpointSlices", Kind: "EndpointSlice",
		Columns: []string{"NAME", "ADDRESSTYPE", "PORTS", "ENDPOINTS", "AGE"},
		Row: func(o *Obj) []string {
			ports := []string{}
			for _, raw := range slice(o, "ports") {
				ports = append(ports, mstr(asMap(raw), "port"))
			}
			addrs := []string{}
			for _, raw := range slice(o, "endpoints") {
				for _, a := range mslice(asMap(raw), "addresses") {
					addrs = append(addrs, valueString(a))
				}
			}
			portText, addrText := strings.Join(ports, ","), strings.Join(addrs, ",")
			if portText == "" {
				portText = "<unset>"
			}
			if addrText == "" {
				addrText = "<unset>"
			}
			return []string{Name(o), str(o, "addressType"), portText, addrText, Age(o)}
		},
	},
	{
		Name: "networkpolicies", Title: "NetworkPolicies", Kind: "NetworkPolicy",
		Columns: []string{"NAME", "POD-SELECTOR", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), selectorText(mapOf(o, "spec", "podSelector")), Age(o)}
		},
	},
	{
		Name: "ingressclasses", Title: "IngressClasses", Kind: "IngressClass", ClusterScoped: true,
		Columns: []string{"NAME", "CONTROLLER", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), str(o, "spec", "controller"), Age(o)} },
	},
	{
		Name: "persistentvolumes", Title: "PersistentVolumes", Kind: "PersistentVolume", ClusterScoped: true,
		Columns: []string{"NAME", "CAPACITY", "ACCESS", "RECLAIM", "STATUS", "CLAIM", "STORAGECLASS", "AGE"},
		Row: func(o *Obj) []string {
			claim := ""
			if n := str(o, "spec", "claimRef", "name"); n != "" {
				claim = str(o, "spec", "claimRef", "namespace") + "/" + n
			}
			return []string{Name(o), str(o, "spec", "capacity", "storage"), PVCAccessModes(o),
				str(o, "spec", "persistentVolumeReclaimPolicy"), str(o, "status", "phase"),
				none(claim), none(str(o, "spec", "storageClassName")), Age(o)}
		},
	},
	{
		Name: "storageclasses", Title: "StorageClasses", Kind: "StorageClass", ClusterScoped: true,
		Columns: []string{"NAME", "PROVISIONER", "RECLAIM", "BINDING", "DEFAULT", "AGE"},
		Row: func(o *Obj) []string {
			ann := o.GetAnnotations()
			isDefault := ann["storageclass.kubernetes.io/is-default-class"] == "true" ||
				ann["storageclass.beta.kubernetes.io/is-default-class"] == "true"
			return []string{Name(o), str(o, "provisioner"), str(o, "reclaimPolicy"),
				str(o, "volumeBindingMode"), strconv.FormatBool(isDefault), Age(o)}
		},
	},
	{
		Name: "serviceaccounts", Title: "ServiceAccounts", Kind: "ServiceAccount",
		Columns: []string{"NAME", "SECRETS", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), countSlice(o, "secrets"), Age(o)} },
	},
	{
		Name: "roles", Title: "Roles", Kind: "Role",
		Columns: []string{"NAME", "RULES", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), countSlice(o, "rules"), Age(o)} },
	},
	{
		Name: "rolebindings", Title: "RoleBindings", Kind: "RoleBinding",
		Columns: []string{"NAME", "ROLE", "SUBJECTS", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), roleRefText(o), subjectsText(o), Age(o)}
		},
	},
	{
		Name: "clusterroles", Title: "ClusterRoles", Kind: "ClusterRole", ClusterScoped: true,
		Columns: []string{"NAME", "RULES", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), countSlice(o, "rules"), Age(o)} },
	},
	{
		Name: "clusterrolebindings", Title: "ClusterRoleBindings", Kind: "ClusterRoleBinding", ClusterScoped: true,
		Columns: []string{"NAME", "ROLE", "SUBJECTS", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), roleRefText(o), subjectsText(o), Age(o)}
		},
	},
	{
		Name: "horizontalpodautoscalers", Title: "HPAs", Kind: "HorizontalPodAutoscaler",
		Columns: []string{"NAME", "REFERENCE", "TARGETS", "MIN", "MAX", "REPLICAS", "AGE"},
		Row: func(o *Obj) []string {
			ref := mapOf(o, "spec", "scaleTargetRef")
			refText := ""
			if ref != nil {
				refText = strings.ToLower(mstr(ref, "kind")) + "/" + mstr(ref, "name")
			}
			return []string{Name(o), refText, hpaTargets(o),
				numOr(o, 1, "spec", "minReplicas"), numOr(o, 0, "spec", "maxReplicas"),
				numOr(o, 0, "status", "currentReplicas"), Age(o)}
		},
	},
	{
		Name: "poddisruptionbudgets", Title: "PodDisruptionBudgets", Kind: "PodDisruptionBudget",
		Columns: []string{"NAME", "MIN AVAILABLE", "MAX UNAVAILABLE", "ALLOWED", "AGE"},
		Row: func(o *Obj) []string {
			minA, maxU := "N/A", "N/A"
			if v := numStr(o, "spec", "minAvailable"); v != "" {
				minA = v
			}
			if v := numStr(o, "spec", "maxUnavailable"); v != "" {
				maxU = v
			}
			return []string{Name(o), minA, maxU, numOr(o, 0, "status", "disruptionsAllowed"), Age(o)}
		},
	},
	{
		Name: "resourcequotas", Title: "ResourceQuotas", Kind: "ResourceQuota",
		Columns: []string{"NAME", "USED", "HARD", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o),
				countKeys(o, "status", "used") + " keys",
				countKeys(o, "status", "hard") + " keys", Age(o)}
		},
	},
	{
		Name: "limitranges", Title: "LimitRanges", Kind: "LimitRange",
		Columns: []string{"NAME", "LIMITS", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), countSlice(o, "spec", "limits"), Age(o)} },
	},
	{
		Name: "priorityclasses", Title: "PriorityClasses", Kind: "PriorityClass", ClusterScoped: true,
		Columns: []string{"NAME", "VALUE", "GLOBAL-DEFAULT", "PREEMPTION", "AGE"},
		Row: func(o *Obj) []string {
			preemption := str(o, "preemptionPolicy")
			if preemption == "" {
				preemption = "PreemptLowerPriority"
			}
			return []string{Name(o), numStr(o, "value"),
				strconv.FormatBool(boolOf(o, "globalDefault")), preemption, Age(o)}
		},
	},
	{
		Name: "runtimeclasses", Title: "RuntimeClasses", Kind: "RuntimeClass", ClusterScoped: true,
		Columns: []string{"NAME", "HANDLER", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), str(o, "handler"), Age(o)} },
	},
	{
		Name: "leases", Title: "Leases", Kind: "Lease",
		Columns: []string{"NAME", "HOLDER", "AGE"},
		Row: func(o *Obj) []string {
			return []string{Name(o), none(str(o, "spec", "holderIdentity")), Age(o)}
		},
	},
	{
		Name: "mutatingwebhookconfigurations", Title: "Mutating Webhooks",
		Kind: "MutatingWebhookConfiguration", ClusterScoped: true,
		Columns: []string{"NAME", "WEBHOOKS", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), countSlice(o, "webhooks"), Age(o)} },
	},
	{
		Name: "validatingwebhookconfigurations", Title: "Validating Webhooks",
		Kind: "ValidatingWebhookConfiguration", ClusterScoped: true,
		Columns: []string{"NAME", "WEBHOOKS", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), countSlice(o, "webhooks"), Age(o)} },
	},
	{
		Name: "customresourcedefinitions", Title: "CRDs", Kind: "CustomResourceDefinition", ClusterScoped: true,
		Columns: []string{"NAME", "GROUP", "VERSION", "SCOPE", "AGE"},
		Row: func(o *Obj) []string {
			versions := slice(o, "spec", "versions")
			stored := map[string]any(nil)
			for _, raw := range versions {
				v := asMap(raw)
				if b, ok := v["storage"].(bool); ok && b {
					stored = v
					break
				}
			}
			if stored == nil && len(versions) > 0 {
				stored = asMap(versions[0])
			}
			return []string{Name(o), str(o, "spec", "group"), mstr(stored, "name"),
				str(o, "spec", "scope"), Age(o)}
		},
	},
}

// FindKind looks up a curated kind by resource name.
func FindKind(name string) *KindDef {
	for i := range Kinds {
		if Kinds[i].Name == name {
			return &Kinds[i]
		}
	}
	return nil
}

// DiscoveredResource is one kind the API server reported.
type DiscoveredResource struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Namespaced bool   `json:"namespaced"`
}

// GenericKind builds a KindDef for a discovered resource (CRD, RBAC, etc.) that
// is not in the curated set. Columns are minimal — NAME, optional STATUS phase,
// AGE — but yaml/describe/edit/delete/events still work, so it is never a dead
// end.
func GenericKind(d DiscoveredResource) KindDef {
	title := d.Kind
	if title == "" {
		title = d.Name
	}
	kind := d.Kind
	if kind == "" {
		kind = title
	}
	return KindDef{
		Name: d.Name, Title: title, Kind: kind,
		ClusterScoped: !d.Namespaced, Generic: true,
		Columns: []string{"NAME", "STATUS", "AGE"},
		Row:     func(o *Obj) []string { return []string{Name(o), genericStatus(o), Age(o)} },
	}
}

// genericStatus is a best-effort one-word status for an unknown kind.
func genericStatus(o *Obj) string {
	if p := str(o, "status", "phase"); p != "" {
		return p
	}
	for _, raw := range slice(o, "status", "conditions") {
		c := asMap(raw)
		t := mstr(c, "type")
		if t == "Ready" || t == "Available" {
			if mstr(c, "status") == "True" {
				return "Ready"
			}
			return "NotReady"
		}
	}
	return ""
}

// ── revisions and workloads ─────────────────────────────────────────────────

// RevisionOf reads the deployment revision annotation off a ReplicaSet.
func RevisionOf(rs *Obj) int {
	n, _ := strconv.Atoi(rs.GetAnnotations()["deployment.kubernetes.io/revision"])
	return n
}

// SortRevisions returns newest-first ReplicaSets for a deployment.
func SortRevisions(replicaSets []Obj) []Obj {
	out := make([]Obj, len(replicaSets))
	copy(out, replicaSets)
	sort.SliceStable(out, func(i, j int) bool { return RevisionOf(&out[i]) > RevisionOf(&out[j]) })
	return out
}

// RevisionLabel is a one-line summary of a revision for a selectable list.
func RevisionLabel(rs *Obj) string {
	replicas := fmt.Sprintf("%d/%d", intOf(rs, "status", "readyReplicas"), intOf(rs, "status", "replicas"))
	return fmt.Sprintf("rev %-4s %-6s %-5s %s",
		strconv.Itoa(RevisionOf(rs)), replicas, Age(rs), Images(rs))
}

// WorkloadKinds are the kinds that own a set of pods we can drill into.
var WorkloadKinds = map[string]bool{
	"deployments":  true,
	"statefulsets": true,
	"daemonsets":   true,
	"replicasets":  true,
	"jobs":         true,
}

// WorkloadSelector builds a `k=v,k=v` label selector from a workload's
// spec.selector.matchLabels. Empty when the workload has none.
func WorkloadSelector(o *Obj) string {
	match := stringMap(o, "spec", "selector", "matchLabels")
	if len(match) == 0 {
		return ""
	}
	keys := make([]string, 0, len(match))
	for k := range match {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+match[k])
	}
	return strings.Join(parts, ",")
}

// Images lists a workload's (or pod's) container images.
func Images(o *Obj) string {
	containers := slice(o, "spec", "template", "spec", "containers")
	if len(containers) == 0 {
		containers = slice(o, "spec", "containers")
	}
	out := []string{}
	for _, raw := range containers {
		if img := mstr(asMap(raw), "image"); img != "" {
			out = append(out, img)
		}
	}
	return strings.Join(out, ", ")
}

// WorkloadSummary is the key/value rows shown at the top of a workload detail
// dashboard.
func WorkloadSummary(o *Obj) [][2]string {
	rows := [][2]string{}
	ns := o.GetNamespace()
	if ns == "" {
		ns = "—"
	}
	rows = append(rows, [2]string{"Namespace", ns})

	if _, ok, _ := nestedRaw(o, "status", "desiredNumberScheduled"); ok {
		rows = append(rows, [2]string{"Ready", fmt.Sprintf("%d/%d",
			intOf(o, "status", "numberReady"), intOf(o, "status", "desiredNumberScheduled"))})
	} else {
		rows = append(rows,
			[2]string{"Replicas", fmt.Sprintf("%d ready / %d desired",
				intOf(o, "status", "readyReplicas"), intOf(o, "status", "replicas"))},
			[2]string{"Updated", numOr(o, 0, "status", "updatedReplicas")},
			[2]string{"Available", numOr(o, 0, "status", "availableReplicas")})
	}
	if s := str(o, "spec", "strategy", "type"); s != "" {
		rows = append(rows, [2]string{"Strategy", s})
	}
	images := Images(o)
	if images == "" {
		images = "—"
	}
	rows = append(rows, [2]string{"Images", images}, [2]string{"Age", Age(o)})
	return rows
}

// PodContainer is one row of a pod's container table.
type PodContainer struct {
	Name     string `json:"name"`
	Image    string `json:"image"`
	Ready    string `json:"ready"`
	Restarts string `json:"restarts"`
}

// PodContainers lists a pod's containers with their live status.
func PodContainers(o *Obj) []PodContainer {
	statuses := slice(o, "status", "containerStatuses")
	out := []PodContainer{}
	for _, raw := range slice(o, "spec", "containers") {
		c := asMap(raw)
		name := mstr(c, "name")
		ready, restarts := "false", "0"
		for _, sraw := range statuses {
			s := asMap(sraw)
			if mstr(s, "name") != name {
				continue
			}
			if b, ok := s["ready"].(bool); ok && b {
				ready = "true"
			}
			if v, ok := s["restartCount"]; ok {
				restarts = valueString(v)
			}
			break
		}
		out = append(out, PodContainer{Name: name, Image: mstr(c, "image"), Ready: ready, Restarts: restarts})
	}
	return out
}

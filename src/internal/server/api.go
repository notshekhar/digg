package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/notshekhar/digg/src/internal/kube"
	"github.com/notshekhar/digg/src/internal/model"
	"github.com/notshekhar/digg/src/internal/settings"
)

// HTTP API for `digg serve` — thin JSON wrappers around the kube layer and the
// format/details models. Port of src/web/api.ts.

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func bad(w http.ResponseWriter, message string, status int) {
	writeJSON(w, status, map[string]string{"error": message})
}

// fail maps an error to the status the Bun build used: something the cluster
// said no to is a 502 on a read (400 on a write), anything else is ours.
func fail(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if kube.IsClusterError(err) {
		status = http.StatusBadGateway
	}
	bad(w, err.Error(), status)
}

// nsParam normalises the namespace query parameter: "", missing and "*" all
// mean every namespace.
func nsParam(r *http.Request) string {
	ns := r.URL.Query().Get("ns")
	if ns == "*" {
		return ""
	}
	return ns
}

func clusterFor(w http.ResponseWriter, r *http.Request) (*kube.Cluster, bool) {
	context := strings.TrimSpace(r.URL.Query().Get("context"))
	if context == "" {
		bad(w, "context required", http.StatusBadRequest)
		return nil, false
	}
	cl, err := kube.For(context)
	if err != nil {
		fail(w, err)
		return nil, false
	}
	return cl, true
}

func refFromParams(r *http.Request) (kube.ResourceRef, bool) {
	q := r.URL.Query()
	context := strings.TrimSpace(q.Get("context"))
	kind := strings.TrimSpace(q.Get("kind"))
	name := strings.TrimSpace(q.Get("name"))
	if context == "" || kind == "" || name == "" {
		return kube.ResourceRef{}, false
	}
	return kube.ResourceRef{
		Context: context, Kind: kind, Name: name, Namespace: q.Get("ns"),
	}, true
}

// resolveKind prefers the curated definition, falling back to a generic one
// built from discovery so an unknown kind is still browsable.
func resolveKind(name string, discovered []kube.DiscoveredResource) *model.KindDef {
	if k := model.FindKind(name); k != nil {
		return k
	}
	for i := range discovered {
		d := &discovered[i]
		if d.Name == name || d.Kind == name {
			g := model.GenericKind(model.DiscoveredResource{
				Name: d.Name, Kind: d.Kind, Namespaced: d.Namespaced})
			return &g
		}
	}
	return nil
}

func allKinds(discovered []kube.DiscoveredResource) []KindMeta {
	curated := map[string]bool{}
	out := make([]KindMeta, 0, len(model.Kinds)+len(discovered))
	for i := range model.Kinds {
		curated[model.Kinds[i].Name] = true
		out = append(out, kindMeta(&model.Kinds[i]))
	}
	for i := range discovered {
		d := &discovered[i]
		if curated[d.Name] {
			continue
		}
		g := model.GenericKind(model.DiscoveredResource{
			Name: d.Name, Kind: d.Kind, Namespaced: d.Namespaced})
		out = append(out, kindMeta(&g))
	}
	return out
}

func curatedNames() []string {
	out := make([]string, 0, len(model.Kinds))
	for i := range model.Kinds {
		out = append(out, model.Kinds[i].Name)
	}
	return out
}

// ── boot ────────────────────────────────────────────────────────────────────

func (s *Server) handleBoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		bad(w, "not found", http.StatusNotFound)
		return
	}
	if !kube.Available() {
		bad(w, "no kubeconfig contexts found", http.StatusServiceUnavailable)
		return
	}

	contexts, _ := kube.Contexts()
	context := settings.LastContext()
	if context == "" || !contains(contexts, context) {
		context, _ = kube.CurrentContext()
	}
	if context == "" && len(contexts) > 0 {
		context = contexts[0]
	}

	payload := map[string]any{
		"contexts": contexts,
		"context":  context,
		"curated":  curatedNames(),
		"prefs":    settings.GetWebPrefs(),
		"version":  s.version,
		// The shell tab is hidden rather than broken where no pty exists.
		"canExec":  kube.PTYAvailable(),
		"forwards": kube.ListForwards(""),
	}

	if context == "" {
		payload["namespaces"] = []string{}
		payload["selectedNamespaces"] = []string{}
		payload["namespace"] = nil
		payload["kind"] = "pods"
		payload["kinds"] = allKinds(nil)
		payload["catalog"] = BuildCatalog(nil)
		payload["cluster"] = nil
		writeJSON(w, http.StatusOK, payload)
		return
	}

	prefs := settings.GetContextPrefs(context)
	cl, err := kube.For(context)
	if err != nil {
		fail(w, err)
		return
	}
	discovered := cl.APIResources(false)
	namespaces, _ := cl.Namespaces()

	kindName := "pods"
	if prefs.Kind != "" && resolveKind(prefs.Kind, discovered) != nil {
		kindName = prefs.Kind
	}

	payload["namespaces"] = namespaces
	payload["selectedNamespaces"] = intersect(prefs.Namespaces, namespaces)
	payload["namespace"] = prefs.Namespace
	payload["kind"] = kindName
	payload["kinds"] = allKinds(discovered)
	payload["catalog"] = BuildCatalog(discovered)
	payload["cluster"] = cl.Version(s.version)
	writeJSON(w, http.StatusOK, payload)
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// intersect keeps only what this cluster still has: a namespace deleted since
// the last visit must not come back as a filter for nothing.
func intersect(want, have []string) []string {
	out := []string{}
	for _, w := range want {
		if contains(have, w) {
			out = append(out, w)
		}
	}
	return out
}

// ── preferences ─────────────────────────────────────────────────────────────

func (s *Server) handlePrefs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		bad(w, "not found", http.StatusNotFound)
		return
	}
	var body struct {
		Theme      string   `json:"theme"`
		Context    string   `json:"context"`
		Namespace  *string  `json:"namespace"`
		Namespaces []string `json:"namespaces"`
		Kind       string   `json:"kind"`
	}
	raw, _ := readBody(r)
	if err := json.Unmarshal(raw, &body); err != nil {
		bad(w, "invalid json", http.StatusBadRequest)
		return
	}
	// Whether "namespace" was present at all is the difference between "clear
	// it" and "leave it alone", and a *string cannot say which.
	var probe map[string]json.RawMessage
	json.Unmarshal(raw, &probe)

	if body.Theme == "light" || body.Theme == "dark" {
		settings.SetWebPrefs(body.Theme)
	}
	if body.Context != "" {
		settings.SetLastContext(body.Context)
		patch := settings.Patch{Kind: body.Kind}
		if _, ok := probe["namespace"]; ok {
			patch.SetNamespace = true
			if body.Namespace != nil && *body.Namespace != "" {
				patch.Namespace = body.Namespace
			}
		}
		if body.Namespaces != nil {
			patch.Namespaces = body.Namespaces
			// Keep the single-value field in step for anything still reading it.
			patch.SetNamespace = true
			patch.Namespace = nil
			if len(body.Namespaces) == 1 {
				only := body.Namespaces[0]
				patch.Namespace = &only
			}
		}
		settings.SetContextPrefs(body.Context, patch)
	}
	s.invalidatePage()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "prefs": settings.GetWebPrefs()})
}

// handleUI takes the shape of the UI — folded rail groups, console height, log
// toggles, table sort. Sent as a patch, and by sendBeacon when the tab goes
// away, which is why a plain POST body (no JSON header) has to be accepted too.
func (s *Server) handleUI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		bad(w, "not found", http.StatusNotFound)
		return
	}
	raw, _ := readBody(r)
	var patch map[string]any
	if err := json.Unmarshal(raw, &patch); err != nil || patch == nil {
		bad(w, "invalid json", http.StatusBadRequest)
		return
	}
	next := settings.SetUIState(patch)
	s.invalidatePage()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ui": next})
}

// handleNamespaces answers a cluster switch; the saved selection rides along so
// the new cluster opens where it was left, not at "all namespaces".
func (s *Server) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	cl, ok := clusterFor(w, r)
	if !ok {
		return
	}
	namespaces, _ := cl.Namespaces()
	prefs := settings.GetContextPrefs(cl.Context)
	writeJSON(w, http.StatusOK, map[string]any{
		"namespaces": namespaces,
		"selected":   intersect(prefs.Namespaces, namespaces),
		"kind":       nullable(prefs.Kind),
	})
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *Server) handleKinds(w http.ResponseWriter, r *http.Request) {
	cl, ok := clusterFor(w, r)
	if !ok {
		return
	}
	discovered := cl.APIResources(false)
	writeJSON(w, http.StatusOK, map[string]any{
		"kinds": allKinds(discovered), "curated": curatedNames(),
	})
}

// ── list ────────────────────────────────────────────────────────────────────

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	cl, ok := clusterFor(w, r)
	if !ok {
		return
	}
	kindName := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kindName == "" {
		kindName = "pods"
	}
	namespace := nsParam(r)
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))

	discovered := cl.APIResources(false)
	kind := resolveKind(kindName, discovered)
	if kind == nil {
		bad(w, "unknown kind: "+kindName, http.StatusNotFound)
		return
	}

	listNS := namespace
	if kind.ClusterScoped {
		listNS = ""
	}
	items, err := cl.List(kind.Name, kube.ListOptions{
		Namespace: listNS, ClusterScoped: kind.ClusterScoped,
	})
	if err != nil {
		fail(w, err)
		return
	}

	usage := usageColumnsFor(cl, kind.Name, items, listNS)
	columns, insertAt := ColumnsFor(kind, usage)

	rows := make([]Row, 0, len(items))
	for i := range items {
		o := &items[i]
		if q != "" &&
			!strings.Contains(strings.ToLower(o.GetName()), q) &&
			!strings.Contains(strings.ToLower(o.GetNamespace()), q) {
			continue
		}
		rows = append(rows, BuildRow(o, kind, usage, insertAt))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"kind": kindMeta(kind), "columns": columns, "rows": rows, "count": len(rows),
	})
}

// ── one object ──────────────────────────────────────────────────────────────

func (s *Server) handleDetail(w http.ResponseWriter, r *http.Request) {
	ref, ok := refFromParams(r)
	if !ok {
		bad(w, "context, kind, name required", http.StatusBadRequest)
		return
	}
	cl, err := kube.For(ref.Context)
	if err != nil {
		fail(w, err)
		return
	}
	kind := resolveKind(ref.Kind, cl.APIResources(false))
	if kind == nil {
		bad(w, "unknown kind: "+ref.Kind, http.StatusNotFound)
		return
	}
	payload, err := BuildDetailPayload(cl, kind, ref)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) handleYAML(w http.ResponseWriter, r *http.Request) {
	ref, cl, ok := refAndCluster(w, r)
	if !ok {
		return
	}
	text, err := cl.YAML(ref)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

func (s *Server) handleDescribe(w http.ResponseWriter, r *http.Request) {
	ref, cl, ok := refAndCluster(w, r)
	if !ok {
		return
	}
	text, err := cl.Describe(ref)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": text})
}

func refAndCluster(w http.ResponseWriter, r *http.Request) (kube.ResourceRef, *kube.Cluster, bool) {
	ref, ok := refFromParams(r)
	if !ok {
		bad(w, "context, kind, name required", http.StatusBadRequest)
		return ref, nil, false
	}
	cl, err := kube.For(ref.Context)
	if err != nil {
		fail(w, err)
		return ref, nil, false
	}
	return ref, cl, true
}

func (s *Server) handleDataKey(w http.ResponseWriter, r *http.Request) {
	ref, cl, ok := refAndCluster(w, r)
	if !ok {
		return
	}
	key := strings.TrimSpace(r.URL.Query().Get("key"))
	if key == "" {
		bad(w, "context, kind, name, key required", http.StatusBadRequest)
		return
	}
	obj, err := cl.Get(ref)
	if err != nil {
		fail(w, err)
		return
	}
	data := nestedStringMap(obj, "data")
	raw, present := data[key]
	if !present {
		bad(w, "key not found", http.StatusNotFound)
		return
	}
	decode := r.URL.Query().Get("decode") == "1" || obj.GetKind() == "Secret"
	text := raw
	if decode {
		text = model.DecodeSecretValue(raw)
	}
	writeJSON(w, http.StatusOK, map[string]string{"key": key, "text": text})
}

func (s *Server) handleData(w http.ResponseWriter, r *http.Request) {
	ref, cl, ok := refAndCluster(w, r)
	if !ok {
		return
	}
	obj, err := cl.Get(ref)
	if err != nil {
		fail(w, err)
		return
	}
	encoded := obj.GetKind() == "Secret"
	entries := []model.DataEntry{}

	data := nestedStringMap(obj, "data")
	for k, v := range data {
		e := model.DecodeEntry(v, encoded)
		e.Key = k
		entries = append(entries, e)
	}
	// binaryData is ConfigMap's escape hatch for non-text values; it is always
	// base64 and always read-only here.
	for k, v := range nestedStringMap(obj, "binaryData") {
		e := model.DecodeEntry(v, true)
		e.Key = k
		e.Binary = true
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Key < entries[j].Key })

	writeJSON(w, http.StatusOK, map[string]any{
		"kind":      obj.GetKind(),
		"encoded":   encoded,
		"immutable": nestedBool(obj, "immutable"),
		"type":      nestedString(obj, "type"),
		"entries":   entries,
	})
}

// ── catalog, overview, metrics, events ──────────────────────────────────────

func (s *Server) handleCatalog(w http.ResponseWriter, r *http.Request) {
	cl, ok := clusterFor(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"catalog": BuildCatalog(cl.APIResources(false))})
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	cl, ok := clusterFor(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, BuildOverview(cl, s.version))
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	cl, ok := clusterFor(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	events, _ := cl.ListEvents(nsParam(r), limit)
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	cl, ok := clusterFor(w, r)
	if !ok {
		return
	}
	nodes := cl.TopNodes()
	pods := cl.TopPods(nsParam(r), "")
	writeJSON(w, http.StatusOK, map[string]any{
		"nodes":     nodes,
		"pods":      pods,
		"available": len(nodes) > 0 || len(pods) > 0,
	})
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	ref, cl, ok := refAndCluster(w, r)
	if !ok {
		return
	}
	revisions, err := cl.RolloutHistory(ref)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revisions": revisions})
}

func (s *Server) handleRevisions(w http.ResponseWriter, r *http.Request) {
	ref, cl, ok := refAndCluster(w, r)
	if !ok {
		return
	}
	obj, err := cl.Get(ref)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revisions": BuildRevisions(cl, ref.Kind, obj)})
}

// ── writes ──────────────────────────────────────────────────────────────────

func (s *Server) handleAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		bad(w, "not found", http.StatusNotFound)
		return
	}
	raw, _ := readBody(r)
	var body actionBody
	if err := json.Unmarshal(raw, &body); err != nil {
		bad(w, "invalid json", http.StatusBadRequest)
		return
	}
	result, err := RunAction(body)
	if err != nil {
		// A cluster failure here is the user's problem to read, not a server
		// fault: surface the exact message with a 400.
		status := http.StatusInternalServerError
		if kube.IsClusterError(err) {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]any{"ok": false, "message": err.Error()})
		return
	}
	status := http.StatusOK
	if !result.OK {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, result)
}

// ── port-forwards ───────────────────────────────────────────────────────────

func (s *Server) handleForwards(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		kube.PruneForwards()
		writeJSON(w, http.StatusOK, map[string]any{
			"forwards": kube.ListForwards(strings.TrimSpace(r.URL.Query().Get("context"))),
		})

	case http.MethodPost:
		raw, _ := readBody(r)
		var body struct {
			Context    string `json:"context"`
			Kind       string `json:"kind"`
			Name       string `json:"name"`
			NS         string `json:"ns"`
			RemotePort int32  `json:"remotePort"`
			LocalPort  int32  `json:"localPort"`
			Address    string `json:"address"`
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			bad(w, "invalid json", http.StatusBadRequest)
			return
		}
		if body.Context == "" || body.Kind == "" || body.Name == "" {
			bad(w, "context, kind, name required", http.StatusBadRequest)
			return
		}
		if body.RemotePort <= 0 {
			bad(w, "remotePort required", http.StatusBadRequest)
			return
		}
		cl, err := kube.For(body.Context)
		if err != nil {
			fail(w, err)
			return
		}
		view, err := cl.StartForward(kube.ForwardSpec{
			Context: body.Context, Kind: body.Kind, Name: body.Name, Namespace: body.NS,
			RemotePort: body.RemotePort, LocalPort: body.LocalPort, Address: body.Address,
		})
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"forward": view})

	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			bad(w, "id required", http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": kube.StopForward(id)})

	default:
		bad(w, "not found", http.StatusNotFound)
	}
}

// ── logs (SSE) ──────────────────────────────────────────────────────────────

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	ref, ok := refFromParams(r)
	if !ok {
		bad(w, "context, kind, name required", http.StatusBadRequest)
		return
	}
	cl, err := kube.For(ref.Context)
	if err != nil {
		fail(w, err)
		return
	}
	obj, err := cl.Get(ref)
	if err != nil {
		fail(w, err)
		return
	}
	mspec, ok := model.LogSpecFor(ref.Kind, obj)
	if !ok {
		bad(w, "logs not available for this resource", http.StatusBadRequest)
		return
	}

	q := r.URL.Query()
	tail, _ := strconv.ParseInt(q.Get("tail"), 10, 64)
	opts := kube.LogOptions{
		Container:  strings.TrimSpace(q.Get("container")),
		Tail:       tail,
		Timestamps: q.Get("timestamps") == "1",
		Previous:   q.Get("previous") == "1",
		Follow:     q.Get("follow") != "0",
	}

	flusher, canFlush := w.(http.Flusher)
	if !canFlush {
		bad(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	send := func(line string) {
		payload, err := json.Marshal(line)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "data: %s\n\n", payload)
		flusher.Flush()
	}
	send("── " + mspec.Title + " ──")

	// Serialising through one channel keeps the SSE frames from interleaving
	// when several pods stream at once.
	lines := make(chan string, 256)
	done := make(chan struct{})
	go func() {
		defer close(done)
		cl.StreamLogs(r.Context(), kube.LogSpec{
			Namespace: mspec.Namespace, PodName: mspec.PodName,
			Selector: mspec.Selector, Title: mspec.Title,
		}, opts, func(line string) {
			select {
			case lines <- line:
			case <-r.Context().Done():
			}
		})
	}()

	for {
		select {
		case line := <-lines:
			send(line)
		case <-done:
			// Drain whatever is still buffered before saying goodbye.
			for {
				select {
				case line := <-lines:
					send(line)
					continue
				default:
				}
				break
			}
			fmt.Fprint(w, "event: end\ndata: {}\n\n")
			flusher.Flush()
			return
		case <-r.Context().Done():
			return
		}
	}
}

func readBody(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for {
		n, err := r.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			return buf, nil
		}
		if len(buf) > 8<<20 {
			return buf, nil
		}
	}
}

var _ = base64.StdEncoding

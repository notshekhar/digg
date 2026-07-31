package server

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/notshekhar/digg/src/internal/kube"
	"github.com/notshekhar/digg/src/internal/model"
)

// The live layer: watches on the server, deltas on the wire. Port of
// src/web/live.ts.
//
// Objects are pushed, metrics are pulled on a timer. That split is not a
// compromise, it is the shape of Kubernetes: metrics.k8s.io implements only get
// and list — "watch is not supported on resources of kind pods.metrics.k8s.io"
// — and metrics-server samples on its own schedule (60s by default), so polling
// faster than that returns the same numbers with more requests.
//
// Three properties this file is built around, unchanged from the Bun build:
//
//	ONE WATCH PER (context, kind, namespace), refcounted across subscriptions
//	and browser tabs, kept alive briefly after the last unsubscribe so flicking
//	between kinds does not churn watches. That refcounting now lives in the
//	informer registry (internal/kube/watch.go) rather than here.
//
//	DELTAS THAT ARE ACTUALLY DELTAS. A row is only sent when its rendered form
//	changed, and events are coalesced into frames, so a rollout that emits
//	hundreds of events a second still renders at a readable rate.
//
//	NO SILENT DEGRADATION. If a kind cannot be watched (aggregated API, RBAC),
//	the client is told so it can fall back to polling — rather than showing a
//	table that quietly never updates.

const (
	// metricsInterval is how often usage bars are refreshed. metrics-server
	// samples every 60s.
	metricsInterval = 15 * time.Second
	// frameInterval is the event coalescing window.
	frameInterval = 100 * time.Millisecond
	// detailThrottle is the floor between two detail rebuilds, so a rollout
	// cannot stampede the API server.
	detailThrottle = 700 * time.Millisecond
)

// watchPodsFor are the kinds whose detail page must also react to pod churn.
// A pod going CrashLoopBackOff never touches the Deployment object at all.
var watchPodsFor = map[string]bool{
	"deployments": true, "statefulsets": true, "daemonsets": true,
	"replicasets": true, "jobs": true, "nodes": true,
}

type clientMessage struct {
	T   string `json:"t"`
	ID  string `json:"id"`
	Sub *struct {
		Type    string  `json:"type"`
		Context string  `json:"context"`
		Kind    string  `json:"kind"`
		NS      *string `json:"ns"`
		Name    string  `json:"name"`
	} `json:"sub"`
}

// subscription is one live view; exactly one of list/detail is populated.
type subscription struct {
	id      string
	kind    *model.KindDef
	cluster *kube.Cluster
	ns      string
	release []func()

	mu sync.Mutex

	// list state
	isList     bool
	usage      *UsageColumns
	columns    []string
	insertAt   int
	prints     map[string]string
	dirty      map[string]bool
	removed    map[string]bool
	frame      *time.Timer
	refreshing bool

	// detail state
	name      string
	lastRun   time.Time
	running   bool
	again     bool
	timer     *time.Timer
	lastPrint string

	stopMetrics chan struct{}
}

// liveSession is one WebSocket's worth of subscriptions. The socket is the
// lifetime: closing it releases every watch it held, so a closed tab cannot
// leak a stream.
type liveSession struct {
	mu     sync.Mutex
	subs   map[string]*subscription
	push   func(any)
	closed bool
}

func newLiveSession(push func(any)) *liveSession {
	return &liveSession{subs: map[string]*subscription{}, push: push}
}

func (l *liveSession) handle(raw []byte) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.mu.Unlock()

	var msg clientMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	switch {
	case msg.T == "ping":
		l.push(map[string]any{"t": "pong"})
		return
	case msg.T == "unsub" && msg.ID != "":
		l.drop(msg.ID)
		return
	case msg.T != "sub" || msg.ID == "" || msg.Sub == nil:
		return
	}

	// A re-subscribe on the same id replaces the old one; the client does this
	// when the namespace or kind changes.
	l.drop(msg.ID)

	context := strings.TrimSpace(msg.Sub.Context)
	if context == "" {
		l.fail(msg.ID, "context required", true)
		return
	}
	cl, err := kube.For(context)
	if err != nil {
		l.fail(msg.ID, err.Error(), true)
		return
	}

	kindName := strings.TrimSpace(msg.Sub.Kind)
	if kindName == "" && msg.Sub.Type != "detail" {
		kindName = "pods"
	}
	kind := resolveKind(kindName, cl.APIResources(false))
	if kind == nil {
		l.fail(msg.ID, "unknown kind: "+kindName, true)
		return
	}

	ns := ""
	if msg.Sub.NS != nil && *msg.Sub.NS != "*" {
		ns = *msg.Sub.NS
	}
	if kind.ClusterScoped {
		ns = ""
	}

	if msg.Sub.Type == "detail" {
		name := strings.TrimSpace(msg.Sub.Name)
		if name == "" {
			l.fail(msg.ID, "context and name required", true)
			return
		}
		l.subscribeDetail(msg.ID, cl, kind, ns, name)
		return
	}
	l.subscribeList(msg.ID, cl, kind, ns)
}

func (l *liveSession) fail(id, message string, fatal bool) {
	l.push(map[string]any{"t": "error", "id": id, "message": message, "fatal": fatal})
}

func (l *liveSession) get(id string) *subscription {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.subs[id]
}

func (l *liveSession) put(sub *subscription) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	l.subs[sub.id] = sub
	return true
}

func (l *liveSession) drop(id string) {
	l.mu.Lock()
	sub, ok := l.subs[id]
	delete(l.subs, id)
	l.mu.Unlock()
	if ok {
		sub.stop()
	}
}

func (s *subscription) stop() {
	s.mu.Lock()
	releases := s.release
	s.release = nil
	if s.frame != nil {
		s.frame.Stop()
		s.frame = nil
	}
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	stopMetrics := s.stopMetrics
	s.stopMetrics = nil
	s.mu.Unlock()

	if stopMetrics != nil {
		close(stopMetrics)
	}
	for _, r := range releases {
		r()
	}
}

func (l *liveSession) close() {
	l.mu.Lock()
	l.closed = true
	subs := make([]*subscription, 0, len(l.subs))
	for _, s := range l.subs {
		subs = append(subs, s)
	}
	l.subs = map[string]*subscription{}
	l.mu.Unlock()
	for _, s := range subs {
		s.stop()
	}
}

// every runs fn on an interval until stop is closed.
func every(d time.Duration, stop chan struct{}, fn func()) {
	go func() {
		t := time.NewTicker(d)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				fn()
			case <-stop:
				return
			}
		}
	}()
}

// ── list subscriptions ──────────────────────────────────────────────────────

func (l *liveSession) subscribeList(id string, cl *kube.Cluster, kind *model.KindDef, ns string) {
	columns, insertAt := ColumnsFor(kind, nil)
	sub := &subscription{
		id: id, kind: kind, cluster: cl, ns: ns, isList: true,
		columns: columns, insertAt: insertAt,
		prints:      map[string]string{},
		dirty:       map[string]bool{},
		removed:     map[string]bool{},
		stopMetrics: make(chan struct{}),
	}
	if !l.put(sub) {
		return
	}

	release, err := cl.Subscribe(kind.Name, ns, func(ev kube.WatchEvent) {
		if l.get(id) != sub {
			return
		}
		switch ev.Type {
		case kube.Synced:
			l.sendSnapshot(sub)
		case kube.Failed:
			l.push(map[string]any{"t": "error", "id": id, "message": ev.Err, "fatal": true})
		case kube.Deleted:
			key := RowKey(ev.Object.GetNamespace(), ev.Object.GetName())
			sub.mu.Lock()
			sub.removed[key] = true
			delete(sub.dirty, key)
			sub.mu.Unlock()
			l.scheduleFrame(sub)
		default:
			key := RowKey(ev.Object.GetNamespace(), ev.Object.GetName())
			sub.mu.Lock()
			sub.dirty[key] = true
			delete(sub.removed, key)
			sub.mu.Unlock()
			l.scheduleFrame(sub)
		}
	})
	if err != nil {
		l.fail(id, err.Error(), true)
		return
	}

	sub.mu.Lock()
	sub.release = append(sub.release, release)
	stop := sub.stopMetrics
	sub.mu.Unlock()

	every(metricsInterval, stop, func() { l.refreshUsage(sub, false) })
}

// sendSnapshot recomputes every row from scratch.
func (l *liveSession) sendSnapshot(sub *subscription) { l.refreshUsage(sub, true) }

func (l *liveSession) refreshUsage(sub *subscription, full bool) {
	if l.get(sub.id) != sub {
		return
	}
	sub.mu.Lock()
	if sub.refreshing {
		sub.mu.Unlock()
		return
	}
	sub.refreshing = true
	sub.mu.Unlock()
	defer func() {
		sub.mu.Lock()
		sub.refreshing = false
		sub.mu.Unlock()
	}()

	objects, err := sub.cluster.List(sub.kind.Name, kube.ListOptions{
		Namespace: sub.ns, ClusterScoped: sub.kind.ClusterScoped,
	})
	if err != nil {
		// A failed pass must not disturb a working table.
		return
	}

	usage := usageColumnsFor(sub.cluster, sub.kind.Name, objects, sub.ns)
	columns, insertAt := ColumnsFor(sub.kind, usage)

	sub.mu.Lock()
	columnsChanged := strings.Join(columns, " ") != strings.Join(sub.columns, " ")
	sub.usage, sub.columns, sub.insertAt = usage, columns, insertAt
	sub.mu.Unlock()

	rows := make([]Row, 0, len(objects))
	for i := range objects {
		rows = append(rows, BuildRow(&objects[i], sub.kind, usage, insertAt))
	}

	if full || columnsChanged {
		prints := make(map[string]string, len(rows))
		for _, r := range rows {
			prints[RowKey(r.NS, r.Name)] = RowFingerprint(r)
		}
		sub.mu.Lock()
		sub.prints = prints
		sub.dirty = map[string]bool{}
		sub.removed = map[string]bool{}
		sub.mu.Unlock()
		l.push(map[string]any{
			"t": "snapshot", "id": sub.id, "columns": columns,
			"rows": rows, "kind": kindMeta(sub.kind),
		})
		return
	}

	// A metrics pass touches every row, but usually only a few actually
	// changed — send those, and let the rest stay put.
	upsert := []Row{}
	seen := map[string]bool{}
	sub.mu.Lock()
	for _, row := range rows {
		key := RowKey(row.NS, row.Name)
		seen[key] = true
		print := RowFingerprint(row)
		if sub.prints[key] != print {
			sub.prints[key] = print
			upsert = append(upsert, row)
		}
	}
	remove := []string{}
	for key := range sub.prints {
		if !seen[key] {
			remove = append(remove, key)
			delete(sub.prints, key)
		}
	}
	sub.mu.Unlock()

	if len(upsert) > 0 || len(remove) > 0 {
		l.push(map[string]any{"t": "delta", "id": sub.id, "upsert": upsert, "remove": remove})
	}
}

func (l *liveSession) scheduleFrame(sub *subscription) {
	sub.mu.Lock()
	if sub.frame != nil {
		sub.mu.Unlock()
		return
	}
	sub.frame = time.AfterFunc(frameInterval, func() {
		sub.mu.Lock()
		sub.frame = nil
		sub.mu.Unlock()
		l.flush(sub)
	})
	sub.mu.Unlock()
}

func (l *liveSession) flush(sub *subscription) {
	if l.get(sub.id) != sub {
		return
	}

	objects, err := sub.cluster.List(sub.kind.Name, kube.ListOptions{
		Namespace: sub.ns, ClusterScoped: sub.kind.ClusterScoped,
	})
	if err != nil {
		return
	}
	byKey := make(map[string]*model.Obj, len(objects))
	for i := range objects {
		byKey[RowKey(objects[i].GetNamespace(), objects[i].GetName())] = &objects[i]
	}

	sub.mu.Lock()
	usage, insertAt := sub.usage, sub.insertAt
	dirty := sub.dirty
	removed := sub.removed
	sub.dirty = map[string]bool{}
	sub.removed = map[string]bool{}

	upsert := []Row{}
	for key := range dirty {
		obj, ok := byKey[key]
		if !ok {
			continue // added and deleted inside one frame
		}
		row := BuildRow(obj, sub.kind, usage, insertAt)
		print := RowFingerprint(row)
		if sub.prints[key] == print {
			continue
		}
		sub.prints[key] = print
		upsert = append(upsert, row)
	}
	remove := make([]string, 0, len(removed))
	for key := range removed {
		remove = append(remove, key)
		delete(sub.prints, key)
	}
	sub.mu.Unlock()

	if len(upsert) > 0 || len(remove) > 0 {
		l.push(map[string]any{"t": "delta", "id": sub.id, "upsert": upsert, "remove": remove})
	}
}

// ── detail subscriptions ────────────────────────────────────────────────────

func (l *liveSession) subscribeDetail(id string, cl *kube.Cluster, kind *model.KindDef, ns, name string) {
	sub := &subscription{
		id: id, kind: kind, cluster: cl, ns: ns, name: name,
		stopMetrics: make(chan struct{}),
	}
	if !l.put(sub) {
		return
	}

	watched := RowKey(ns, name)
	release, err := cl.Subscribe(kind.Name, ns, func(ev kube.WatchEvent) {
		if l.get(id) != sub {
			return
		}
		switch ev.Type {
		case kube.Failed:
			l.push(map[string]any{"t": "error", "id": id, "message": ev.Err, "fatal": true})
		case kube.Synced:
			l.scheduleDetail(sub, false)
		default:
			if RowKey(ev.Object.GetNamespace(), ev.Object.GetName()) == watched {
				l.scheduleDetail(sub, false)
			}
		}
	})
	if err != nil {
		l.fail(id, err.Error(), true)
		return
	}
	sub.mu.Lock()
	sub.release = append(sub.release, release)
	sub.mu.Unlock()

	// A workload's page is mostly about its pods, so their events have to wake
	// it too.
	if watchPodsFor[kind.Name] {
		podNS := ns
		if kind.Name == "nodes" {
			podNS = ""
		}
		if podRelease, err := cl.Subscribe("pods", podNS, func(ev kube.WatchEvent) {
			if l.get(id) != sub {
				return
			}
			if ev.Type == kube.Added || ev.Type == kube.Modified || ev.Type == kube.Deleted {
				l.scheduleDetail(sub, false)
			}
		}); err == nil {
			sub.mu.Lock()
			sub.release = append(sub.release, podRelease)
			sub.mu.Unlock()
		}
	}

	sub.mu.Lock()
	stop := sub.stopMetrics
	sub.mu.Unlock()
	every(metricsInterval, stop, func() { l.scheduleDetail(sub, true) })

	l.scheduleDetail(sub, true)
}

// scheduleDetail coalesces rebuilds and never runs two at once.
func (l *liveSession) scheduleDetail(sub *subscription, immediate bool) {
	if l.get(sub.id) != sub {
		return
	}
	sub.mu.Lock()
	if sub.running {
		sub.again = true
		sub.mu.Unlock()
		return
	}
	if sub.timer != nil {
		sub.mu.Unlock()
		return
	}
	wait := time.Duration(0)
	if !immediate {
		if elapsed := time.Since(sub.lastRun); elapsed < detailThrottle {
			wait = detailThrottle - elapsed
		}
	}
	sub.timer = time.AfterFunc(wait, func() {
		sub.mu.Lock()
		sub.timer = nil
		sub.mu.Unlock()
		l.rebuildDetail(sub)
	})
	sub.mu.Unlock()
}

func (l *liveSession) rebuildDetail(sub *subscription) {
	if l.get(sub.id) != sub {
		return
	}
	sub.mu.Lock()
	sub.running = true
	sub.lastRun = time.Now()
	sub.mu.Unlock()

	defer func() {
		sub.mu.Lock()
		sub.running = false
		again := sub.again
		sub.again = false
		sub.mu.Unlock()
		if again {
			l.scheduleDetail(sub, false)
		}
	}()

	payload, err := BuildDetailPayload(sub.cluster, sub.kind, kube.ResourceRef{
		Context: sub.cluster.Context, Kind: sub.kind.Name, Name: sub.name, Namespace: sub.ns,
	})
	if err != nil {
		message := err.Error()
		// A deleted object is the ordinary end of a detail page, not a failure
		// worth a red box — the client navigates away on `gone`.
		gone := strings.Contains(strings.ToLower(message), "not found") ||
			strings.Contains(strings.ToLower(message), "notfound")
		l.push(map[string]any{
			"t": "error", "id": sub.id, "message": message, "fatal": false, "gone": gone,
		})
		return
	}
	if l.get(sub.id) != sub {
		return
	}

	// Coalescing means a burst of events can produce two rebuilds that land on
	// the same answer (the second event only bumped a resourceVersion). Sending
	// it again would re-render the page for nothing, so identical payloads are
	// dropped.
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	print := string(raw)
	sub.mu.Lock()
	same := print == sub.lastPrint
	sub.lastPrint = print
	sub.mu.Unlock()
	if same {
		return
	}
	l.push(map[string]any{"t": "detail", "id": sub.id, "data": payload})
}

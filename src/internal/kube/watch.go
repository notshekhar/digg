package kube

import (
	"context"
	"fmt"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/tools/cache"
)

// This file replaces src/watch.ts + src/api-watch.ts + src/watch-source.ts and
// the refcounted registry half of src/web/live.ts — about 1.4k lines of
// hand-rolled machinery, because kubectl --watch gave the Bun build no
// resourceVersion to resume from and no marker for "the initial list is done".
//
// A SharedIndexInformer has both. Measured on minikube during the spike:
// 0 LIST calls (client-go streams the initial sync via sendInitialEvents),
// every forced reconnect resumed from a resourceVersion, and three subscribers
// shared one upstream stream. The 250ms "settle" heuristic and the quick-exit
// backoff that watch.ts needed have no equivalent here because the conditions
// they papered over do not arise.

// EventType is what happened to an object.
type EventType string

const (
	Added    EventType = "added"
	Modified EventType = "modified"
	Deleted  EventType = "deleted"
	// Synced is emitted once when the initial list has completed — the marker
	// kubectl --watch could not provide.
	Synced EventType = "synced"
	// Failed is emitted when the watch cannot be established at all.
	Failed EventType = "failed"
)

// WatchEvent is one change on a watched collection.
type WatchEvent struct {
	Type   EventType
	Object *unstructured.Unstructured
	Err    string
}

// Handler receives events for one subscription.
type Handler func(WatchEvent)

// idleGrace is how long a stream outlives its last reader.
//
// The Bun build kept it at 10s, which covered flicking between two kinds and
// nothing else — walk away for a minute and coming back re-listed the whole
// collection. This is the store-lifetime question Lens answers by keeping its
// KubeObjectStores alive for the whole cluster session, and it is most of why
// Lens revisits feel instant. Five minutes is that behaviour without the
// unbounded memory: a stream that nobody has looked at for five minutes is
// worth its re-list, and one you keep coming back to costs nothing.
const idleGrace = 5 * time.Minute

type sharedWatch struct {
	key      string
	cluster  *Cluster
	informer cache.SharedIndexInformer
	cancel   context.CancelFunc

	mu       sync.Mutex
	subs     map[int]Handler
	nextID   int
	synced   bool
	failed   string
	idleStop *time.Timer
}

// Subscribe attaches a handler to the (kind, namespace) stream, creating it if
// this is the first reader. The returned function detaches; the stream itself
// is torn down idleGrace after its last reader leaves.
//
// Port of the registry in src/web/live.ts, whose refcounting this replaces.
func (c *Cluster) Subscribe(kind, namespace string, h Handler) (func(), error) {
	gvr, namespaced, err := c.Resolve(kind)
	if err != nil {
		return nil, err
	}
	ns := namespace
	if !namespaced {
		ns = ""
	}
	key := watchKey(gvr, ns, namespaced)

	c.mu.Lock()
	sw, ok := c.shared[key]
	if !ok {
		sw = c.newSharedWatch(key, gvr, ns)
		c.shared[key] = sw
	}
	c.mu.Unlock()

	return sw.add(h), nil
}

func watchKey(gvr schema.GroupVersionResource, ns string, namespaced bool) string {
	scope := "cluster"
	if namespaced {
		scope = "ns"
	}
	return fmt.Sprintf("%s/%s/%s", gvr.String(), ns, scope)
}

// CachedList answers a list out of a running informer's store, if one is
// already watching this collection and has finished its initial sync.
//
// This is the other half of the argument for keeping streams alive past their
// last reader: a table you opened a minute ago is still in memory, complete and
// continuously updated by its watch, so re-asking the apiserver for it is a
// round trip for an answer we hold. It is also *fresher* than a list would be —
// the store is fed by the watch, while a list can be served from a lagging
// cache.
//
// A watch on every namespace can answer a single-namespace question by
// filtering; the reverse is not true, and neither is a store that is still
// syncing, so both say no and the caller lists.
func (c *Cluster) CachedList(kind string, opts ListOptions) ([]Obj, bool) {
	gvr, namespaced, err := c.Resolve(kind)
	if err != nil {
		return nil, false
	}
	// A field selector needs an index the store does not keep, and a caller who
	// asked for a quorum read asked not to be given a cache.
	if opts.FieldSelector != "" || opts.Quorum {
		return nil, false
	}
	// A label selector, on the other hand, is a scan of a few thousand objects
	// already in memory — cheaper than the round trip it replaces. This is what
	// makes a workload's detail page free once its pods are being watched.
	var selector labels.Selector
	if opts.LabelSelector != "" {
		sel, err := labels.Parse(opts.LabelSelector)
		if err != nil {
			return nil, false
		}
		selector = sel
	}
	ns := opts.Namespace
	if !namespaced || opts.ClusterScoped {
		ns = ""
	}

	c.mu.Lock()
	sw, ok := c.shared[watchKey(gvr, ns, namespaced)]
	filter := ""
	if !ok && ns != "" {
		sw, ok = c.shared[watchKey(gvr, "", namespaced)]
		filter = ns
	}
	c.mu.Unlock()
	if !ok {
		return nil, false
	}

	sw.mu.Lock()
	synced, failed := sw.synced, sw.failed
	sw.mu.Unlock()
	if !synced || failed != "" {
		return nil, false
	}

	raw := sw.informer.GetStore().List()
	out := make([]Obj, 0, len(raw))
	for _, o := range raw {
		u, ok := o.(*unstructured.Unstructured)
		if !ok {
			continue
		}
		if filter != "" && u.GetNamespace() != filter {
			continue
		}
		if selector != nil && !selector.Matches(labels.Set(u.GetLabels())) {
			continue
		}
		out = append(out, *u)
	}
	return out, true
}

// ListCached is List, answered from a running watch's store when there is one.
// Every read-only caller that does not need read-your-writes should use it.
func (c *Cluster) ListCached(kind string, opts ListOptions) ([]Obj, error) {
	if items, ok := c.CachedList(kind, opts); ok {
		return items, nil
	}
	return c.List(kind, opts)
}

func (c *Cluster) newSharedWatch(key string, gvr schema.GroupVersionResource, ns string) *sharedWatch {
	ctx, cancel := context.WithCancel(context.Background())
	sw := &sharedWatch{
		key:     key,
		cluster: c,
		cancel:  cancel,
		subs:    map[int]Handler{},
	}

	ri := c.Dynamic.Resource(gvr)
	lw := &cache.ListWatch{
		ListFunc: func(opts metav1.ListOptions) (runtime.Object, error) {
			if ns != "" {
				return ri.Namespace(ns).List(ctx, opts)
			}
			return ri.List(ctx, opts)
		},
		WatchFunc: func(opts metav1.ListOptions) (watch.Interface, error) {
			if ns != "" {
				return ri.Namespace(ns).Watch(ctx, opts)
			}
			return ri.Watch(ctx, opts)
		},
	}

	inf := cache.NewSharedIndexInformer(lw, &unstructured.Unstructured{}, 0, cache.Indexers{})
	// A watch that can never work (no permission, no such resource) has to reach
	// the client as a message rather than a silent empty table. src/watch.ts
	// learned this the hard way with componentstatuses, which lists fine and
	// then fails the watch.
	inf.SetWatchErrorHandler(func(_ *cache.Reflector, err error) {
		sw.fail(err.Error())
	})
	inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(o any) { sw.emit(Added, o) },
		UpdateFunc: func(_, o any) { sw.emit(Modified, o) },
		DeleteFunc: func(o any) { sw.emit(Deleted, o) },
	})
	sw.informer = inf

	go inf.Run(ctx.Done())
	go func() {
		if cache.WaitForCacheSync(ctx.Done(), inf.HasSynced) {
			sw.markSynced()
		}
	}()
	return sw
}

func (sw *sharedWatch) emit(t EventType, o any) {
	u, ok := o.(*unstructured.Unstructured)
	if !ok {
		// A delete can arrive wrapped when the informer missed the event.
		if tomb, isTomb := o.(cache.DeletedFinalStateUnknown); isTomb {
			u, ok = tomb.Obj.(*unstructured.Unstructured)
		}
		if !ok {
			return
		}
	}
	sw.mu.Lock()
	hs := make([]Handler, 0, len(sw.subs))
	for _, h := range sw.subs {
		hs = append(hs, h)
	}
	sw.mu.Unlock()
	ev := WatchEvent{Type: t, Object: u}
	for _, h := range hs {
		h(ev)
	}
}

func (sw *sharedWatch) markSynced() {
	sw.mu.Lock()
	if sw.synced {
		sw.mu.Unlock()
		return
	}
	sw.synced = true
	hs := make([]Handler, 0, len(sw.subs))
	for _, h := range sw.subs {
		hs = append(hs, h)
	}
	sw.mu.Unlock()
	for _, h := range hs {
		h(WatchEvent{Type: Synced})
	}
}

func (sw *sharedWatch) fail(msg string) {
	sw.mu.Lock()
	sw.failed = msg
	hs := make([]Handler, 0, len(sw.subs))
	for _, h := range sw.subs {
		hs = append(hs, h)
	}
	sw.mu.Unlock()
	for _, h := range hs {
		h(WatchEvent{Type: Failed, Err: msg})
	}
}

func (sw *sharedWatch) add(h Handler) func() {
	sw.mu.Lock()
	if sw.idleStop != nil {
		sw.idleStop.Stop()
		sw.idleStop = nil
	}
	id := sw.nextID
	sw.nextID++
	sw.subs[id] = h
	synced, failed := sw.synced, sw.failed
	// A late subscriber gets the cache it missed, so a second tab does not sit
	// empty waiting for the next change.
	var backlog []*unstructured.Unstructured
	if synced {
		for _, o := range sw.informer.GetStore().List() {
			if u, ok := o.(*unstructured.Unstructured); ok {
				backlog = append(backlog, u)
			}
		}
	}
	sw.mu.Unlock()

	for _, u := range backlog {
		h(WatchEvent{Type: Added, Object: u})
	}
	if synced {
		h(WatchEvent{Type: Synced})
	}
	if failed != "" {
		h(WatchEvent{Type: Failed, Err: failed})
	}

	var once sync.Once
	return func() { once.Do(func() { sw.remove(id) }) }
}

func (sw *sharedWatch) remove(id int) {
	sw.mu.Lock()
	delete(sw.subs, id)
	empty := len(sw.subs) == 0
	if empty && sw.idleStop == nil {
		sw.idleStop = time.AfterFunc(idleGrace, func() { sw.shutdownIfIdle() })
	}
	sw.mu.Unlock()
}

func (sw *sharedWatch) shutdownIfIdle() {
	c := sw.cluster
	c.mu.Lock()
	sw.mu.Lock()
	if len(sw.subs) > 0 {
		sw.mu.Unlock()
		c.mu.Unlock()
		return
	}
	sw.idleStop = nil
	sw.mu.Unlock()
	delete(c.shared, sw.key)
	c.mu.Unlock()
	sw.cancel()
}

// StopAllWatches tears every stream down. The socket is the lifetime of its
// subscriptions, and a closed tab must not leave a stream running.
func StopAllWatches() {
	clustersMu.Lock()
	defer clustersMu.Unlock()
	for _, c := range clusters {
		c.mu.Lock()
		for key, sw := range c.shared {
			sw.cancel()
			delete(c.shared, key)
		}
		c.mu.Unlock()
	}
}

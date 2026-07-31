package kube

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

// Port-forward manager. Port of src/web/forwards.ts.
//
// State lives in the server process, not the page: a forward you started should
// survive a browser reload, exactly like `kubectl port-forward` in a spare
// terminal survives closing the tab you launched it from.
//
// The Bun build spawned a kubectl per forward and REGEX-SCRAPED ITS STDOUT for
// the line "Forwarding from 127.0.0.1:54321 -> 80" to learn which port the
// kernel had picked. client-go's ForwardPorts reports the bound ports as data
// (GetPorts), so the parse, the 350ms sleep the API route needed before it
// could answer, and the "starting" status that sleep existed to avoid are all
// gone — a forward is active or it failed.

// ForwardSpec is a request to open one forward.
type ForwardSpec struct {
	Context    string
	Kind       string // pods | services | deployments …
	Name       string
	Namespace  string
	RemotePort int32
	// LocalPort 0 means let the kernel pick and report back, which is the only
	// way to never collide with something already listening.
	LocalPort int32
	Address   string
}

// ForwardView is the row the UI renders.
type ForwardView struct {
	ID         string  `json:"id"`
	Context    string  `json:"context"`
	Kind       string  `json:"kind"`
	Name       string  `json:"name"`
	Namespace  string  `json:"namespace"`
	RemotePort int32   `json:"remotePort"`
	LocalPort  *int32  `json:"localPort"`
	Status     string  `json:"status"` // starting | active | failed | stopped
	Error      string  `json:"error"`
	URL        *string `json:"url"`
	StartedAt  int64   `json:"startedAt"`
}

type forward struct {
	id        string
	spec      ForwardSpec
	localPort *int32
	status    string
	err       string
	startedAt int64
	stop      chan struct{}
	once      sync.Once
}

var (
	forwardsMu sync.Mutex
	forwards   = map[string]*forward{}
	forwardSeq atomic.Int64
)

func (f *forward) view() ForwardView {
	v := ForwardView{
		ID:         f.id,
		Context:    f.spec.Context,
		Kind:       f.spec.Kind,
		Name:       f.spec.Name,
		Namespace:  f.spec.Namespace,
		RemotePort: f.spec.RemotePort,
		LocalPort:  f.localPort,
		Status:     f.status,
		Error:      f.err,
		StartedAt:  f.startedAt,
	}
	if f.localPort != nil {
		u := fmt.Sprintf("http://127.0.0.1:%d", *f.localPort)
		v.URL = &u
	}
	return v
}

// podForSpec resolves a forward target to a concrete pod. `kubectl
// port-forward svc/foo` picks a backing pod behind the scenes; with client-go
// that resolution is ours to do.
func (c *Cluster) podForSpec(spec ForwardSpec) (string, int32, error) {
	kind := strings.ToLower(spec.Kind)
	port := spec.RemotePort

	switch kind {
	case "pods", "pod", "po":
		return spec.Name, port, nil

	case "services", "service", "svc":
		svc, err := c.Typed.CoreV1().Services(spec.Namespace).Get(ctxBG(), spec.Name, getOpts())
		if err != nil {
			return "", 0, wrap(err)
		}
		// A service port may name a different container port; forwarding to the
		// service's own number would hit nothing.
		for _, p := range svc.Spec.Ports {
			if p.Port == port {
				if p.TargetPort.IntValue() != 0 {
					port = int32(p.TargetPort.IntValue())
				}
				break
			}
		}
		sel := labelsToSelector(svc.Spec.Selector)
		if sel == "" {
			return "", 0, errf("service %s has no selector to forward to", spec.Name)
		}
		pod, err := c.firstRunningPod(spec.Namespace, sel)
		return pod, port, err

	default:
		// Workloads: forward to one of the pods the workload owns.
		obj, err := c.Get(ResourceRef{Kind: spec.Kind, Name: spec.Name, Namespace: spec.Namespace})
		if err != nil {
			return "", 0, err
		}
		sel := SpecSelector(obj)
		if sel == "" {
			return "", 0, errf("%s %s has no selector to forward to", spec.Kind, spec.Name)
		}
		pod, err := c.firstRunningPod(spec.Namespace, sel)
		return pod, port, err
	}
}

func (c *Cluster) firstRunningPod(ns, selector string) (string, error) {
	list, err := c.Typed.CoreV1().Pods(ns).List(ctxBG(), listOpts(selector))
	if err != nil {
		return "", wrap(err)
	}
	for i := range list.Items {
		if list.Items[i].Status.Phase == "Running" {
			return list.Items[i].Name, nil
		}
	}
	if len(list.Items) > 0 {
		return list.Items[0].Name, nil
	}
	return "", errf("no pods match %s", selector)
}

// StartForward opens a forward and blocks only until it is ready or fails, so
// the API route can answer with a real port instead of guessing after a sleep.
func (c *Cluster) StartForward(spec ForwardSpec) (ForwardView, error) {
	pod, remotePort, err := c.podForSpec(spec)
	if err != nil {
		return ForwardView{}, err
	}

	req := c.Typed.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(spec.Namespace).Name(pod).SubResource("portforward")

	transport, upgrader, err := spdy.RoundTripperFor(c.Rest)
	if err != nil {
		return ForwardView{}, err
	}
	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport}, "POST", req.URL())

	f := &forward{
		id:        fmt.Sprintf("pf%d", forwardSeq.Add(1)),
		spec:      spec,
		status:    "starting",
		startedAt: time.Now().UnixMilli(),
		stop:      make(chan struct{}),
	}

	ready := make(chan struct{})
	ports := []string{fmt.Sprintf("%d:%d", spec.LocalPort, remotePort)}
	addresses := []string{"127.0.0.1"}
	if spec.Address != "" {
		addresses = []string{spec.Address}
	}

	fw, err := portforward.NewOnAddresses(dialer, addresses, ports, f.stop, ready,
		discard{}, errCollector{f: f})
	if err != nil {
		return ForwardView{}, err
	}

	forwardsMu.Lock()
	forwards[f.id] = f
	forwardsMu.Unlock()

	done := make(chan error, 1)
	go func() { done <- fw.ForwardPorts() }()

	select {
	case <-ready:
		if bound, err := fw.GetPorts(); err == nil && len(bound) > 0 {
			p := int32(bound[0].Local)
			forwardsMu.Lock()
			f.localPort = &p
			f.status = "active"
			forwardsMu.Unlock()
		}
	case err := <-done:
		forwardsMu.Lock()
		f.status = "failed"
		if err != nil {
			f.err = err.Error()
		}
		forwardsMu.Unlock()
		forwardsMu.Lock()
		v := f.view()
		forwardsMu.Unlock()
		return v, nil
	case <-time.After(10 * time.Second):
		forwardsMu.Lock()
		f.status = "failed"
		f.err = "port-forward did not become ready within 10s"
		forwardsMu.Unlock()
	}

	// Once running, watch for the forward dying on its own.
	go func() {
		err := <-done
		forwardsMu.Lock()
		defer forwardsMu.Unlock()
		if f.status == "stopped" {
			return
		}
		if err != nil {
			f.status = "failed"
			f.err = err.Error()
		} else {
			f.status = "stopped"
		}
	}()

	forwardsMu.Lock()
	v := f.view()
	forwardsMu.Unlock()
	return v, nil
}

// errCollector records the transient messages the forwarder writes. kubectl
// reports "lost connection to pod" while staying alive, so a message alone is
// not a failure — only a dead forwarder is.
type errCollector struct{ f *forward }

func (e errCollector) Write(p []byte) (int, error) {
	line := strings.TrimSpace(string(p))
	if line != "" {
		forwardsMu.Lock()
		e.f.err = line
		forwardsMu.Unlock()
	}
	return len(p), nil
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// ListForwards is the port of listForwards(), oldest first.
func ListForwards(context string) []ForwardView {
	forwardsMu.Lock()
	defer forwardsMu.Unlock()
	out := make([]ForwardView, 0, len(forwards))
	for _, f := range forwards {
		if context != "" && f.spec.Context != context {
			continue
		}
		out = append(out, f.view())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt < out[j].StartedAt })
	return out
}

// StopForward is the port of stopForward().
func StopForward(id string) bool {
	forwardsMu.Lock()
	f, ok := forwards[id]
	if ok {
		delete(forwards, id)
	}
	forwardsMu.Unlock()
	if !ok {
		return false
	}
	f.once.Do(func() { close(f.stop) })
	return true
}

// StopAllForwards is the port of stopAllForwards(). Forwards are children of
// this process; leaving them running after ctrl+c would strand listening ports
// with no way to find them from the UI again.
func StopAllForwards() {
	forwardsMu.Lock()
	ids := make([]string, 0, len(forwards))
	for id := range forwards {
		ids = append(ids, id)
	}
	forwardsMu.Unlock()
	for _, id := range ids {
		StopForward(id)
	}
}

// PruneForwards drops finished rows so the panel does not accumulate dead
// entries forever. Port of pruneForwards().
func PruneForwards() {
	forwardsMu.Lock()
	defer forwardsMu.Unlock()
	for id, f := range forwards {
		if f.status == "stopped" {
			delete(forwards, id)
		}
	}
}

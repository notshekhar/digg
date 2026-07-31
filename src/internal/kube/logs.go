package kube

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Port of the log paths in src/web/api.ts and src/log-stream.ts.
//
// The Bun build shelled out to `kubectl logs -f`, which is why it needed the
// --prefix / --max-log-requests=20 flags for a multi-pod workload and a pair of
// pipe pumps to interleave stdout and stderr. client-go's GetLogs streams one
// pod at a time, so fan-out across a workload's pods happens here instead —
// which is also what kubectl is doing behind those flags.

// LogOptions mirrors the query parameters /api/logs accepts.
type LogOptions struct {
	Container  string
	Tail       int64
	Timestamps bool
	Previous   bool
	Follow     bool
}

// LogSpec says which pods to read and what to call the stream. Port of
// logSpecFor(): a pod's own logs, or all pods of a workload via its label
// selector.
type LogSpec struct {
	Namespace string
	PodName   string
	Selector  string
	Title     string
}

// LogSpecFor is the port of logSpecFor(). It returns ok=false when logs do not
// apply to this kind. The workload predicate and selector are injected so this
// package does not depend on the model layer.
func LogSpecFor(kindName string, obj *Obj, workloadKinds map[string]bool, selectorFor func(*Obj) string) (LogSpec, bool) {
	name := obj.GetName()
	if name == "" {
		return LogSpec{}, false
	}
	ns := obj.GetNamespace()
	if kindName == "pods" {
		return LogSpec{Namespace: ns, PodName: name, Title: name + " · logs (live)"}, true
	}
	if !workloadKinds[kindName] {
		return LogSpec{}, false
	}
	sel := selectorFor(obj)
	if sel == "" {
		return LogSpec{}, false
	}
	return LogSpec{Namespace: ns, Selector: sel, Title: name + " · logs (all pods)"}, true
}

// maxLogRequests caps the fan-out for a workload, matching the Bun build's
// --max-log-requests=20.
const maxLogRequests = 20

// StreamLogs writes each log line to emit until ctx is cancelled or the stream
// ends. Lines from a multi-pod workload are prefixed with the pod name, as
// kubectl --prefix does.
func (c *Cluster) StreamLogs(ctx context.Context, spec LogSpec, opts LogOptions, emit func(string)) error {
	pods := []string{}
	prefix := false

	switch {
	case spec.PodName != "":
		pods = append(pods, spec.PodName)
	case spec.Selector != "":
		list, err := c.Typed.CoreV1().Pods(spec.Namespace).
			List(ctx, metav1.ListOptions{LabelSelector: spec.Selector})
		if err != nil {
			return wrap(err)
		}
		for i := range list.Items {
			if len(pods) >= maxLogRequests {
				break
			}
			pods = append(pods, list.Items[i].Name)
		}
		prefix = true
	default:
		return errf("logs not available for this resource")
	}

	if len(pods) == 0 {
		emit("no pods match this workload")
		return nil
	}

	tail := opts.Tail
	if tail < 1 {
		tail = 500
	}
	if tail > 20000 {
		tail = 20000
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	send := func(line string) {
		mu.Lock()
		defer mu.Unlock()
		emit(line)
	}

	for _, pod := range pods {
		wg.Add(1)
		go func(pod string) {
			defer wg.Done()
			o := &corev1.PodLogOptions{
				Container:  opts.Container,
				TailLines:  &tail,
				Timestamps: opts.Timestamps,
				Previous:   opts.Previous,
				// --previous and -f are mutually exclusive, as they are in kubectl.
				Follow: opts.Follow && !opts.Previous,
			}
			// No container named means every container, which is what
			// --all-containers=true asked kubectl for.
			stream, err := c.Typed.CoreV1().Pods(spec.Namespace).
				GetLogs(pod, o).Stream(ctx)
			if err != nil {
				send(fmt.Sprintf("[stderr] %s: %v", pod, err))
				return
			}
			defer stream.Close()

			sc := bufio.NewScanner(stream)
			sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
			for sc.Scan() {
				line := sc.Text()
				if prefix {
					line = "[" + pod + "] " + line
				}
				send(line)
			}
			if err := sc.Err(); err != nil && err != io.EOF && ctx.Err() == nil {
				send(fmt.Sprintf("[stderr] %s: %v", pod, err))
			}
		}(pod)
	}

	wg.Wait()
	return nil
}

// Logs is the port of getLogs(): a one-shot read, used where a stream is not
// wanted.
func (c *Cluster) Logs(ref ResourceRef, tail int64) (string, error) {
	if tail <= 0 {
		tail = 1000
	}
	stream, err := c.Typed.CoreV1().Pods(ref.Namespace).
		GetLogs(ref.Name, &corev1.PodLogOptions{TailLines: &tail}).Stream(context.Background())
	if err != nil {
		// kubectl logs can exit non-zero (e.g. container not started) but still
		// print something useful; surface whatever we got rather than failing.
		return err.Error(), nil
	}
	defer stream.Close()
	raw, err := io.ReadAll(stream)
	if err != nil {
		return string(raw), nil
	}
	return string(raw), nil
}

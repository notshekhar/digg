package kube

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// findShellPod returns a pod that has a shell, so the exec test is testing exec
// rather than rediscovering that distroless images have no /bin/sh.
func findShellPod(t *testing.T, c *Cluster) (ns, name string) {
	t.Helper()
	pods, err := c.List("pods", ListOptions{})
	if err != nil {
		t.Skipf("cannot list pods: %v", err)
	}
	for i := range pods {
		p := &pods[i]
		phase, _, _ := unstructuredString(p, "status", "phase")
		if phase != "Running" {
			continue
		}
		// The demo namespace images are ordinary busybox/node images with shells.
		if p.GetNamespace() == "demo" {
			return p.GetNamespace(), p.GetName()
		}
	}
	t.Skip("no running pod in the demo namespace to exec into")
	return "", ""
}

func TestLiveExecIntoContainer(t *testing.T) {
	c := cluster(t)
	ns, pod := findShellPod(t, c)

	var mu sync.Mutex
	var out strings.Builder
	ready := make(chan struct{})
	exited := make(chan int, 1)
	var readyOnce sync.Once

	sess, err := c.StartExec(
		ExecTarget{Kind: "container", Context: c.Context, Namespace: ns, Pod: pod, Cols: 80, Rows: 24},
		func(b []byte) { mu.Lock(); out.Write(b); mu.Unlock() },
		func(msg any) {
			m, _ := msg.(map[string]any)
			switch m["t"] {
			case "ready":
				readyOnce.Do(func() { close(ready) })
			case "exit":
				code, _ := m["code"].(int)
				select {
				case exited <- code:
				default:
				}
			}
		},
		func(int) {},
	)
	if err != nil {
		t.Fatalf("StartExec: %v", err)
	}
	defer sess.Close()

	select {
	case <-ready:
	case <-time.After(20 * time.Second):
		t.Fatal("exec never reported ready")
	}

	// A TTY echoes what we type, so look for a marker the shell PRINTS, not one
	// we merely sent.
	marker := "digg-exec-ok-4711"
	if err := sess.Write([]byte("echo " + marker + "\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	deadline := time.After(20 * time.Second)
	for {
		mu.Lock()
		got := out.String()
		mu.Unlock()
		// Two occurrences: the echo of our keystrokes plus the command's output.
		if strings.Count(got, marker) >= 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("marker never came back; got %q", got)
		case <-time.After(200 * time.Millisecond):
		}
	}

	// Resize must not kill the stream.
	sess.Resize(120, 40)
	if err := sess.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	select {
	case <-exited:
	case <-time.After(15 * time.Second):
		t.Error("session never reported exit after `exit`")
	}
}

func TestLivePortForward(t *testing.T) {
	c := cluster(t)

	svcs, err := c.List("services", ListOptions{Namespace: "demo"})
	if err != nil || len(svcs) == 0 {
		t.Skip("no services in the demo namespace")
	}

	var spec ForwardSpec
	found := false
	for i := range svcs {
		s := &svcs[i]
		ports, ok, _ := unstructuredSlice(s, "spec", "ports")
		if !ok || len(ports) == 0 {
			continue
		}
		p, isMap := ports[0].(map[string]any)
		if !isMap {
			continue
		}
		portNum, isNum := p["port"].(int64)
		if !isNum {
			continue
		}
		spec = ForwardSpec{
			Context:    c.Context,
			Kind:       "services",
			Name:       s.GetName(),
			Namespace:  s.GetNamespace(),
			RemotePort: int32(portNum),
		}
		found = true
		break
	}
	if !found {
		t.Skip("no service with a port to forward")
	}

	view, err := c.StartForward(spec)
	if err != nil {
		t.Fatalf("StartForward: %v", err)
	}
	defer StopForward(view.ID)

	if view.Status != "active" {
		t.Fatalf("forward status %q, error %q", view.Status, view.Error)
	}
	if view.LocalPort == nil || *view.LocalPort == 0 {
		t.Fatal("forward reported no local port")
	}
	// The kernel picked the port and client-go reported it as data — the Bun
	// build had to regex it out of kubectl's stdout.
	if spec.LocalPort == 0 && *view.LocalPort < 1024 {
		t.Errorf("expected an ephemeral local port, got %d", *view.LocalPort)
	}

	url := fmt.Sprintf("http://127.0.0.1:%d/", *view.LocalPort)
	var lastErr error
	for i := 0; i < 20; i++ {
		resp, err := http.Get(url)
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			t.Logf("forward %s → %s answered %d", view.Name, url, resp.StatusCode)
			lastErr = nil
			break
		}
		lastErr = err
		time.Sleep(250 * time.Millisecond)
	}
	if lastErr != nil {
		t.Fatalf("nothing answered on the forwarded port: %v", lastErr)
	}

	if !StopForward(view.ID) {
		t.Error("StopForward reported the forward was unknown")
	}
	if got := ListForwards(""); len(got) != 0 {
		t.Errorf("forward still listed after stop: %+v", got)
	}
}

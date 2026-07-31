package kube

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

// Terminal sessions. Port of src/web/exec.ts.
//
// The Bun build ran `kubectl exec -it` / `kubectl debug` inside a local pty and
// piped the bytes to the socket — a pty per remote shell, purely because it had
// no other way to speak the exec protocol. client-go has remotecommand, which
// IS that protocol, so three of the four kinds need no pty at all:
//
//	container  → remotecommand into the pod
//	debug      → attach an ephemeral container, then remotecommand into it
//	node       → create a privileged debug pod, then remotecommand into it
//	local      → a real local pty (creack/pty), the only one that still needs one
//
// Wire protocol is unchanged, because the React client already speaks it:
//
//	server → client   binary frame   raw terminal bytes
//	                  text frame     JSON status: {t:"ready"|"exit"|"error"}
//	client → server   text frame     JSON: {t:"in",d} | {t:"resize",cols,rows}
//
// Output stays binary: a UTF-8 multi-byte sequence split across two reads must
// reach xterm.js unmangled, and decoding it here would corrupt the split rune.

// ExecTarget is what to open a terminal onto.
type ExecTarget struct {
	Kind      string // container | node | local | debug
	Context   string
	Namespace string
	Pod       string
	Container string
	Node      string
	Shell     string // shell to run inside a container; ignored for local
	Cols      uint16
	Rows      uint16
}

// Session is a running terminal.
type Session interface {
	Write(p []byte) error
	Resize(cols, rows uint16)
	Close() error
}

// ExecTitle is the human label for the session tab. Port of execTitle().
func ExecTitle(t ExecTarget) string {
	switch t.Kind {
	case "local":
		return "shell · " + t.Context
	case "node":
		return "node · " + t.Node
	case "debug":
		return "debug · " + t.Pod
	}
	if t.Container != "" {
		return t.Pod + " · " + t.Container
	}
	if t.Pod != "" {
		return t.Pod
	}
	return "shell"
}

// shellCommand probes for bash and execs it, else falls back to sh — one round
// trip instead of a failed exec followed by a retry, which would leave a dead
// pane on screen. Port of shellCommand().
func shellCommand(preferred string) string {
	if preferred != "" && preferred != "auto" {
		return "exec " + preferred
	}
	return "command -v bash >/dev/null 2>&1 && exec bash || exec sh"
}

func clampSize(cols, rows uint16) (uint16, uint16) {
	if cols < 20 {
		cols = 80
	}
	if cols > 500 {
		cols = 500
	}
	if rows < 5 {
		rows = 24
	}
	if rows > 200 {
		rows = 200
	}
	return cols, rows
}

// StartExec opens a session. send receives raw terminal bytes, status receives
// the JSON control frames, and onExit fires once when the session ends.
func (c *Cluster) StartExec(t ExecTarget, send func([]byte), status func(any), onExit func(int)) (Session, error) {
	t.Cols, t.Rows = clampSize(t.Cols, t.Rows)

	switch t.Kind {
	case "local":
		return c.startLocal(t, send, status, onExit)
	case "container":
		return c.startRemote(t, t.Pod, t.Container, []string{"/bin/sh", "-c", shellCommand(t.Shell)}, send, status, onExit)
	case "debug":
		return c.startPodDebug(t, send, status, onExit)
	case "node":
		return c.startNodeDebug(t, send, status, onExit)
	}
	return nil, errf("unknown exec kind %q", t.Kind)
}

// ── local ───────────────────────────────────────────────────────────────────

// startLocal is a local shell with the cluster pre-selected — the same thing
// Lens's terminal gives you.
func (c *Cluster) startLocal(t ExecTarget, send func([]byte), status func(any), onExit func(int)) (Session, error) {
	if !PTYAvailable() {
		status(map[string]any{
			"t": "error",
			"message": "digg: this platform has no pty support, so an interactive shell is not " +
				"available. Use `digg` in a terminal instead.",
		})
		return nil, errf("no pty support")
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	env := os.Environ()
	// The prompt should say which cluster you are about to break.
	env = append(env, "DIGG_CONTEXT="+t.Context, "KUBECTL_CONTEXT="+t.Context)

	p, err := StartPTY(shell, []string{"-l"}, env, t.Cols, t.Rows)
	if err != nil {
		status(map[string]any{"t": "error", "message": err.Error()})
		return nil, err
	}
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := p.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				send(chunk)
			}
			if err != nil {
				break
			}
		}
		code := p.Wait()
		status(map[string]any{"t": "exit", "code": code})
		onExit(code)
	}()
	status(map[string]any{"t": "ready", "title": ExecTitle(t)})
	return &ptySession{p: p}, nil
}

type ptySession struct{ p *PTY }

func (s *ptySession) Write(b []byte) error     { _, err := s.p.Write(b); return err }
func (s *ptySession) Resize(cols, rows uint16) { s.p.Resize(cols, rows) }
func (s *ptySession) Close() error             { return s.p.Close() }

// ── remote (exec into a running container) ──────────────────────────────────

type remoteSession struct {
	stdin  *io.PipeWriter
	sizes  chan remotecommand.TerminalSize
	cancel context.CancelFunc
	once   sync.Once
}

func (s *remoteSession) Write(b []byte) error { _, err := s.stdin.Write(b); return err }

func (s *remoteSession) Resize(cols, rows uint16) {
	select {
	case s.sizes <- remotecommand.TerminalSize{Width: cols, Height: rows}:
	default: // a resize we cannot deliver now is not worth blocking the socket for
	}
}

func (s *remoteSession) Close() error {
	s.once.Do(func() {
		s.cancel()
		s.stdin.Close()
	})
	return nil
}

// startRemote runs command in pod/container over the exec subresource.
func (c *Cluster) startRemote(
	t ExecTarget, pod, container string, command []string,
	send func([]byte), status func(any), onExit func(int),
) (Session, error) {
	req := c.Typed.CoreV1().RESTClient().Post().
		Resource("pods").Name(pod).Namespace(t.Namespace).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: container,
			Command:   command,
			Stdin:     true,
			Stdout:    true,
			Stderr:    false, // with a TTY, stderr is folded into stdout
			TTY:       true,
		}, scheme.ParameterCodec)

	exec, err := remotecommand.NewSPDYExecutor(c.Rest, "POST", req.URL())
	if err != nil {
		status(map[string]any{"t": "error", "message": err.Error()})
		return nil, err
	}

	pr, pw := io.Pipe()
	sizes := make(chan remotecommand.TerminalSize, 4)
	sizes <- remotecommand.TerminalSize{Width: t.Cols, Height: t.Rows}
	ctx, cancel := context.WithCancel(context.Background())

	status(map[string]any{"t": "ready", "title": ExecTitle(t)})

	go func() {
		err := exec.StreamWithContext(ctx, remotecommand.StreamOptions{
			Stdin:             pr,
			Stdout:            writerFunc(send),
			Tty:               true,
			TerminalSizeQueue: sizeQueue(sizes),
		})
		code := 0
		if err != nil && ctx.Err() == nil {
			// A shell-less image (distroless, scratch) can only fail with 127.
			// That is not a digg bug, and the pane explains it — so the message
			// has to survive rather than be swallowed.
			send([]byte("\r\n" + err.Error() + "\r\n"))
			code = 1
		}
		status(map[string]any{"t": "exit", "code": code})
		onExit(code)
		cancel()
	}()

	return &remoteSession{stdin: pw, sizes: sizes, cancel: cancel}, nil
}

type writerFunc func([]byte)

func (w writerFunc) Write(p []byte) (int, error) {
	chunk := make([]byte, len(p))
	copy(chunk, p)
	w(chunk)
	return len(p), nil
}

type sizeQueue chan remotecommand.TerminalSize

func (q sizeQueue) Next() *remotecommand.TerminalSize {
	s, ok := <-q
	if !ok {
		return nil
	}
	return &s
}

// ── debug (ephemeral container in a pod) ────────────────────────────────────

// startPodDebug is the port of the `debug` target.
//
// Distroless and scratch images have no shell, so exec can only fail. An
// ephemeral container shares the target's process namespace and brings its own
// busybox — the only way into those pods.
//
// This MUTATES the pod: the ephemeral container is recorded in its spec and
// cannot be removed until the pod is. It is only ever started when the user
// explicitly asks for it.
func (c *Cluster) startPodDebug(t ExecTarget, send func([]byte), status func(any), onExit func(int)) (Session, error) {
	name := fmt.Sprintf("digg-debug-%d", time.Now().UnixNano()%1e6)
	pods := c.Typed.CoreV1().Pods(t.Namespace)

	pod, err := pods.Get(context.Background(), t.Pod, metav1.GetOptions{})
	if err != nil {
		status(map[string]any{"t": "error", "message": err.Error()})
		return nil, wrap(err)
	}

	ec := corev1.EphemeralContainer{
		EphemeralContainerCommon: corev1.EphemeralContainerCommon{
			Name:                     name,
			Image:                    "busybox",
			Command:                  []string{"sh"},
			Stdin:                    true,
			TTY:                      true,
			TerminationMessagePolicy: corev1.TerminationMessageReadFile,
		},
	}
	if t.Container != "" {
		ec.TargetContainerName = t.Container
	}
	pod.Spec.EphemeralContainers = append(pod.Spec.EphemeralContainers, ec)

	if _, err := pods.UpdateEphemeralContainers(context.Background(), t.Pod, pod, metav1.UpdateOptions{}); err != nil {
		status(map[string]any{"t": "error", "message": err.Error()})
		return nil, wrap(err)
	}

	send([]byte("starting ephemeral debug container " + name + "…\r\n"))
	if err := c.waitForEphemeral(t.Namespace, t.Pod, name); err != nil {
		status(map[string]any{"t": "error", "message": err.Error()})
		return nil, err
	}
	return c.startRemote(t, t.Pod, name, []string{"sh"}, send, status, onExit)
}

func (c *Cluster) waitForEphemeral(ns, pod, container string) error {
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		p, err := c.Typed.CoreV1().Pods(ns).Get(context.Background(), pod, metav1.GetOptions{})
		if err != nil {
			return wrap(err)
		}
		for _, s := range p.Status.EphemeralContainerStatuses {
			if s.Name != container {
				continue
			}
			if s.State.Running != nil {
				return nil
			}
			if s.State.Terminated != nil {
				return errf("debug container exited: %s", s.State.Terminated.Reason)
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return errf("debug container did not start within 60s")
}

// ── node ────────────────────────────────────────────────────────────────────

// startNodeDebug creates a privileged pod on the node with the host filesystem
// under /host — the standard way to get a node shell, and what
// `kubectl debug node/x` does.
func (c *Cluster) startNodeDebug(t ExecTarget, send func([]byte), status func(any), onExit func(int)) (Session, error) {
	ns := "default"
	name := fmt.Sprintf("digg-node-debug-%d", time.Now().UnixNano()%1e6)
	yes := true

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: corev1.PodSpec{
			NodeName:      t.Node,
			HostNetwork:   true,
			HostPID:       true,
			HostIPC:       true,
			RestartPolicy: corev1.RestartPolicyNever,
			Tolerations:   []corev1.Toleration{{Operator: corev1.TolerationOpExists}},
			Containers: []corev1.Container{{
				Name:            "debug",
				Image:           "busybox",
				Command:         []string{"sh"},
				Stdin:           true,
				TTY:             true,
				SecurityContext: &corev1.SecurityContext{Privileged: &yes},
				VolumeMounts:    []corev1.VolumeMount{{Name: "host", MountPath: "/host"}},
			}},
			Volumes: []corev1.Volume{{
				Name:         "host",
				VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/"}},
			}},
		},
	}

	if _, err := c.Typed.CoreV1().Pods(ns).Create(context.Background(), pod, metav1.CreateOptions{}); err != nil {
		status(map[string]any{"t": "error", "message": err.Error()})
		return nil, wrap(err)
	}
	send([]byte("starting node debug pod " + name + " on " + t.Node + "…\r\n"))

	if err := c.waitForPodRunning(ns, name); err != nil {
		status(map[string]any{"t": "error", "message": err.Error()})
		return nil, err
	}

	target := t
	target.Namespace = ns
	sess, err := c.startRemote(target, name, "debug", []string{"sh"}, send, status, func(code int) {
		// The debug pod is ours; it must not outlive the tab that opened it.
		bg := metav1.DeletePropagationBackground
		grace := int64(0)
		_ = c.Typed.CoreV1().Pods(ns).Delete(context.Background(), name,
			metav1.DeleteOptions{PropagationPolicy: &bg, GracePeriodSeconds: &grace})
		onExit(code)
	})
	return sess, err
}

func (c *Cluster) waitForPodRunning(ns, name string) error {
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		p, err := c.Typed.CoreV1().Pods(ns).Get(context.Background(), name, metav1.GetOptions{})
		if err != nil {
			return wrap(err)
		}
		switch p.Status.Phase {
		case corev1.PodRunning:
			return nil
		case corev1.PodFailed, corev1.PodSucceeded:
			return errf("debug pod %s", strings.ToLower(string(p.Status.Phase)))
		}
		time.Sleep(500 * time.Millisecond)
	}
	return errf("debug pod did not start within 90s")
}

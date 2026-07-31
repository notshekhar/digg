package kube

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"k8s.io/kubectl/pkg/drain"
)

// Drain is the port of drainNode(): the same flags the Bun build passed to
// `kubectl drain` — --ignore-daemonsets --delete-emptydir-data --force
// --timeout=60s — expressed as kubectl's own drain.Helper, which is the code
// behind that command.
func (c *Cluster) Drain(node string) (string, error) {
	var out strings.Builder
	helper := &drain.Helper{
		Ctx:                 context.Background(),
		Client:              c.Typed,
		Force:               true,
		IgnoreAllDaemonSets: true,
		DeleteEmptyDirData:  true,
		Timeout:             60 * time.Second,
		GracePeriodSeconds:  -1,
		Out:                 io.Discard,
		ErrOut:              io.Discard,
	}

	n, err := c.Typed.CoreV1().Nodes().Get(helper.Ctx, node, getOpts())
	if err != nil {
		return "", wrap(err)
	}
	// Cordon first: draining a schedulable node just lets the pods come back.
	if err := drain.RunCordonOrUncordon(helper, n, true); err != nil {
		return "", wrap(err)
	}
	fmt.Fprintf(&out, "node/%s cordoned\n", node)

	if err := drain.RunNodeDrain(helper, node); err != nil {
		return out.String(), wrap(err)
	}
	fmt.Fprintf(&out, "node/%s drained", node)
	return out.String(), nil
}

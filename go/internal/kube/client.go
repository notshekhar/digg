// Package kube is digg's cluster access layer.
//
// This is the port of src/kubectl.ts + src/proxy.ts + src/apipath.ts +
// src/discovery.ts. Those four files existed because the Bun build shelled out
// to kubectl: proxy.ts ran one `kubectl proxy --unix-socket` per context so that
// reads would stop re-running the exec credential plugin, apipath.ts built the
// REST paths that proxy needed by hand, and discovery.ts memoised the API
// resource list that a kubectl spawn would otherwise re-fetch every request.
//
// client-go does all four jobs: one rest.Config authenticates once for the
// process lifetime, the typed/dynamic clients build their own paths, and
// discovery is cached. So this package is the four of them collapsed into one.
//
// Writes still go through kubectl's OWN libraries (k8s.io/kubectl/pkg/...)
// rather than reimplemented REST calls, for the same reason src/kubectl.ts kept
// every mutation on its own kubectl process: `apply` should stay the thing that
// applies, with its field manager, its conflict handling and its error text.
package kube

import (
	"errors"
	"fmt"
	"sort"
	"sync"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/discovery"
	memory "k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

// Error is something the cluster said no to, rather than something digg got
// wrong. It carries a message worth showing the user as-is.
//
// Port of KubectlError + ApiError, which src/web/api.ts had to check for
// separately (isClusterError) because reads and writes took different routes.
type Error struct{ msg string }

func (e *Error) Error() string { return e.msg }

func errf(format string, args ...any) *Error {
	return &Error{msg: fmt.Sprintf(format, args...)}
}

// IsClusterError reports whether err came from the cluster refusing, so callers
// can answer 400/502 rather than 500.
func IsClusterError(err error) bool {
	if err == nil {
		return false
	}
	var e *Error
	if errors.As(err, &e) {
		return true
	}
	// A 4xx/5xx from the apiserver is equally the cluster's answer, not our bug.
	return apierrors.IsNotFound(err) || apierrors.IsForbidden(err) ||
		apierrors.IsUnauthorized(err) || apierrors.IsBadRequest(err) ||
		apierrors.IsConflict(err) || apierrors.IsInvalid(err) ||
		apierrors.IsMethodNotSupported(err) || apierrors.IsServiceUnavailable(err)
}

// Cluster is everything digg needs to talk to one context.
type Cluster struct {
	Context   string
	Rest      *rest.Config
	Typed     *kubernetes.Clientset
	Dynamic   *dynamic.DynamicClient
	Metrics   *metricsclient.Clientset
	Discovery discovery.CachedDiscoveryInterface
	Mapper    meta.RESTMapper

	// informers are lazily created per (gvr, namespace); see watch.go.
	mu     sync.Mutex
	shared map[string]*sharedWatch
}

var (
	clustersMu sync.Mutex
	clusters   = map[string]*Cluster{}
)

// For returns the (cached) Cluster for a context name. One process keeps one
// client per context forever — which is the entire performance argument
// src/proxy.ts was making with its long-lived kubectl proxy, minus the proxy.
func For(context string) (*Cluster, error) {
	clustersMu.Lock()
	defer clustersMu.Unlock()
	if c, ok := clusters[context]; ok {
		return c, nil
	}
	c, err := connect(context)
	if err != nil {
		return nil, err
	}
	clusters[context] = c
	return c, nil
}

func loader(context string) clientcmd.ClientConfig {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	overrides := &clientcmd.ConfigOverrides{}
	if context != "" {
		overrides.CurrentContext = context
	}
	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)
}

func connect(context string) (*Cluster, error) {
	cfg, err := loader(context).ClientConfig()
	if err != nil {
		return nil, errf("kubeconfig: %v", err)
	}
	// digg's UI is chatty on navigation; client-go's default 5 QPS throttles
	// hard enough to look like a hang.
	cfg.QPS = 100
	cfg.Burst = 200
	cfg.UserAgent = "digg"

	typed, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	mc, err := metricsclient.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}

	cached := memory.NewMemCacheClient(typed.Discovery())
	// ShortcutExpander is what gives "deploy"/"po"/"ing" their meaning. The short
	// names come from discovery, so CRDs get theirs for free.
	mapper := restmapper.NewShortcutExpander(
		restmapper.NewDeferredDiscoveryRESTMapper(cached), cached, func(string) {})

	return &Cluster{
		Context:   context,
		Rest:      cfg,
		Typed:     typed,
		Dynamic:   dyn,
		Metrics:   mc,
		Discovery: cached,
		Mapper:    mapper,
		shared:    map[string]*sharedWatch{},
	}, nil
}

// Contexts lists every context in the merged kubeconfig, sorted.
// Port of getContexts() — `kubectl config get-contexts -o name`, sorted.
func Contexts() ([]string, error) {
	raw, err := rawConfig()
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(raw.Contexts))
	for name := range raw.Contexts {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

// CurrentContext is the kubeconfig's current-context.
func CurrentContext() (string, error) {
	raw, err := rawConfig()
	if err != nil {
		return "", err
	}
	return raw.CurrentContext, nil
}

func rawConfig() (*clientcmdapi.Config, error) {
	raw, err := loader("").RawConfig()
	if err != nil {
		return nil, errf("kubeconfig: %v", err)
	}
	return &raw, nil
}

// Available reports whether we can reach a kubeconfig at all. Port of
// isKubectlAvailable(), which gated startup on kubectl being on PATH; the Go
// build has no kubectl to find, so the equivalent precondition is a readable
// kubeconfig with at least one context.
func Available() bool {
	raw, err := rawConfig()
	return err == nil && len(raw.Contexts) > 0
}

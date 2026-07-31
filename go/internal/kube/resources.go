package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes/scheme"
	cmdutil "k8s.io/kubectl/pkg/cmd/util"
	"k8s.io/kubectl/pkg/describe"
	"k8s.io/kubectl/pkg/polymorphichelpers"
	"sigs.k8s.io/yaml"
)

// Obj is one API object. The Bun build called this K8sObject and treated it as
// a bag of `unknown`; unstructured.Unstructured is the same bag with accessors.
type Obj = unstructured.Unstructured

// ResourceRef identifies one object. Port of the TS interface of the same name.
type ResourceRef struct {
	Kind      string
	Name      string
	Namespace string
	Context   string
}

// ListOptions mirrors src/kubectl.ts ListOptions. An empty Namespace means all
// namespaces, exactly as `-A` did.
type ListOptions struct {
	Namespace     string
	ClusterScoped bool
	LabelSelector string
	FieldSelector string
}

func ctxWithTimeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 30*time.Second)
}

// Resolve maps a kind name ("pods", "po", "Pod", "deployments.apps") to its GVR
// and whether it is namespaced. Port of discovery.ts findResource, but backed by
// the RESTMapper so short names and CRDs resolve without a hand-written table.
func (c *Cluster) Resolve(kind string) (schema.GroupVersionResource, bool, error) {
	gvr, err := c.Mapper.ResourceFor(schema.GroupVersionResource{Resource: kind})
	if err != nil {
		return schema.GroupVersionResource{}, false, errf("unknown kind %q: %v", kind, err)
	}
	gvk, err := c.Mapper.KindFor(schema.GroupVersionResource{Resource: kind})
	if err != nil {
		return gvr, true, nil
	}
	mapping, err := c.Mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return gvr, true, nil
	}
	return gvr, mapping.Scope.Name() == meta.RESTScopeNameNamespace, nil
}

// GroupKind resolves a kind name to its GroupKind — what describe and the
// rollout helpers key off.
func (c *Cluster) GroupKind(kind string) (schema.GroupKind, error) {
	gvk, err := c.Mapper.KindFor(schema.GroupVersionResource{Resource: kind})
	if err != nil {
		return schema.GroupKind{}, errf("unknown kind %q: %v", kind, err)
	}
	return gvk.GroupKind(), nil
}

func (c *Cluster) resourceFor(kind, namespace string, clusterScoped bool) (dynamic.ResourceInterface, error) {
	gvr, namespaced, err := c.Resolve(kind)
	if err != nil {
		return nil, err
	}
	ri := c.Dynamic.Resource(gvr)
	if !namespaced || clusterScoped {
		return ri, nil
	}
	// An empty namespace means all namespaces, exactly as `-A` did.
	return ri.Namespace(namespace), nil
}

// List is the port of listResources().
func (c *Cluster) List(kind string, opts ListOptions) ([]Obj, error) {
	res, err := c.resourceFor(kind, opts.Namespace, opts.ClusterScoped)
	if err != nil {
		return nil, err
	}
	ctx, cancel := ctxWithTimeout()
	defer cancel()
	list, err := res.List(ctx, metav1.ListOptions{
		LabelSelector: opts.LabelSelector,
		FieldSelector: opts.FieldSelector,
	})
	if err != nil {
		return nil, wrap(err)
	}
	return list.Items, nil
}

// Namespaces is the port of getNamespaces().
func (c *Cluster) Namespaces() ([]string, error) {
	items, err := c.List("namespaces", ListOptions{ClusterScoped: true})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(items))
	for i := range items {
		if n := items[i].GetName(); n != "" {
			out = append(out, n)
		}
	}
	return out, nil
}

// Get is the port of getJson() — the live object, as the editor's source.
func (c *Cluster) Get(ref ResourceRef) (*Obj, error) {
	res, err := c.resourceFor(ref.Kind, ref.Namespace, false)
	if err != nil {
		return nil, err
	}
	ctx, cancel := ctxWithTimeout()
	defer cancel()
	obj, err := res.Get(ctx, ref.Name, metav1.GetOptions{})
	if err != nil {
		return nil, wrap(err)
	}
	return obj, nil
}

// YAML is the port of getYaml(). kubectl hides managedFields from `get -o yaml`
// by default (since 1.21) and this text is editable and re-applied, so the noise
// stays out here too.
func (c *Cluster) YAML(ref ResourceRef) (string, error) {
	obj, err := c.Get(ref)
	if err != nil {
		return "", err
	}
	clean := obj.DeepCopy()
	unstructured.RemoveNestedField(clean.Object, "metadata", "managedFields")
	raw, err := json.Marshal(clean.Object)
	if err != nil {
		return "", err
	}
	out, err := yaml.JSONToYAML(raw)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// Describe is the port of describe(). This is kubectl's own describer package,
// so the output is the text `kubectl describe` prints, not a lookalike.
func (c *Cluster) Describe(ref ResourceRef) (string, error) {
	gk, err := c.GroupKind(ref.Kind)
	if err != nil {
		return "", err
	}
	d, ok := describe.DescriberFor(gk, c.Rest)
	if !ok {
		mapping, mErr := c.Mapper.RESTMapping(gk)
		if mErr != nil {
			return "", errf("no describer for %s", gk.String())
		}
		d, ok = describe.GenericDescriberFor(mapping, c.Rest)
		if !ok {
			return "", errf("no describer for %s", gk.String())
		}
	}
	ns := ref.Namespace
	out, err := d.Describe(ns, ref.Name, describe.DescriberSettings{ShowEvents: true})
	if err != nil {
		return "", wrap(err)
	}
	return out, nil
}

// Apply is the port of applyManifest(). The Bun build piped the manifest to
// `kubectl apply -f -` so that apply's own field manager and error text stayed
// authoritative; this uses server-side apply for the same reason, which is the
// API the CLI itself is built on.
func (c *Cluster) Apply(manifest string) (string, error) {
	raw, err := yaml.YAMLToJSON([]byte(manifest))
	if err != nil {
		return "", errf("manifest is not valid YAML: %v", err)
	}
	var obj unstructured.Unstructured
	if err := json.Unmarshal(raw, &obj.Object); err != nil {
		return "", errf("manifest is not a Kubernetes object: %v", err)
	}
	if obj.GetKind() == "" || obj.GetName() == "" {
		return "", errf("manifest needs a kind and a metadata.name")
	}
	gvk := obj.GroupVersionKind()
	mapping, err := c.Mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return "", errf("unknown kind %q: %v", gvk.Kind, err)
	}
	ri := c.Dynamic.Resource(mapping.Resource)
	ctx, cancel := ctxWithTimeout()
	defer cancel()

	var applied *unstructured.Unstructured
	if mapping.Scope.Name() == meta.RESTScopeNameNamespace {
		ns := obj.GetNamespace()
		if ns == "" {
			ns = "default"
		}
		applied, err = ri.Namespace(ns).Apply(ctx, obj.GetName(), &obj,
			metav1.ApplyOptions{FieldManager: "digg", Force: true})
	} else {
		applied, err = ri.Apply(ctx, obj.GetName(), &obj,
			metav1.ApplyOptions{FieldManager: "digg", Force: true})
	}
	if err != nil {
		return "", wrap(err)
	}
	return fmt.Sprintf("%s/%s configured", strings.ToLower(applied.GetKind()), applied.GetName()), nil
}

// Delete is the port of deleteResource().
func (c *Cluster) Delete(ref ResourceRef) (string, error) {
	return c.DeleteWith(ref, DeleteOptions{})
}

// DeleteOptions carries the knobs the web UI exposes.
type DeleteOptions struct {
	Force       bool
	GracePeriod *int64
}

// DeleteWith is the port of deleteResourceWith().
func (c *Cluster) DeleteWith(ref ResourceRef, opts DeleteOptions) (string, error) {
	res, err := c.resourceFor(ref.Kind, ref.Namespace, false)
	if err != nil {
		return "", err
	}
	del := metav1.DeleteOptions{}
	if opts.GracePeriod != nil {
		del.GracePeriodSeconds = opts.GracePeriod
	}
	if opts.Force {
		// --force without an explicit grace period is rejected by kubectl; the
		// API equivalent is grace 0 plus no preconditions.
		if del.GracePeriodSeconds == nil {
			zero := int64(0)
			del.GracePeriodSeconds = &zero
		}
	}
	ctx, cancel := ctxWithTimeout()
	defer cancel()
	if err := res.Delete(ctx, ref.Name, del); err != nil {
		return "", wrap(err)
	}
	return fmt.Sprintf("%s \"%s\" deleted", singular(ref.Kind), ref.Name), nil
}

// Patch is the port of patchResource(): a JSON merge patch, where a null value
// deletes that key — how the data editor removes a ConfigMap/Secret entry
// without rewriting the whole object.
func (c *Cluster) Patch(ref ResourceRef, patch any) (string, error) {
	body, err := json.Marshal(patch)
	if err != nil {
		return "", err
	}
	res, err := c.resourceFor(ref.Kind, ref.Namespace, false)
	if err != nil {
		return "", err
	}
	ctx, cancel := ctxWithTimeout()
	defer cancel()
	out, err := res.Patch(ctx, ref.Name, types.MergePatchType, body, metav1.PatchOptions{})
	if err != nil {
		return "", wrap(err)
	}
	return fmt.Sprintf("%s/%s patched", strings.ToLower(out.GetKind()), out.GetName()), nil
}

// SetSuspend is the port of setSuspend() — a merge patch on spec.suspend.
func (c *Cluster) SetSuspend(ref ResourceRef, suspend bool) (string, error) {
	return c.Patch(ref, map[string]any{"spec": map[string]any{"suspend": suspend}})
}

// Scale is the port of scaleResource().
func (c *Cluster) Scale(ref ResourceRef, replicas int32) (string, error) {
	return c.Patch(ref, map[string]any{"spec": map[string]any{"replicas": replicas}})
}

// RolloutRestart is the port of rolloutRestart(). kubectl implements this by
// stamping a restartedAt annotation on the pod template — same patch here, so
// the effect and the resulting rollout history entry are identical.
func (c *Cluster) RolloutRestart(ref ResourceRef) (string, error) {
	stamp := time.Now().Format(time.RFC3339)
	patch := map[string]any{
		"spec": map[string]any{
			"template": map[string]any{
				"metadata": map[string]any{
					"annotations": map[string]any{
						"kubectl.kubernetes.io/restartedAt": stamp,
					},
				},
			},
		},
	}
	if _, err := c.Patch(ref, patch); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s/%s restarted", strings.ToLower(singular(ref.Kind)), ref.Name), nil
}

// historyRowRe matches one row of a rollout history table.
var historyRowRe = regexp.MustCompile(`^(\d+)\s+(.*)$`)

// Revision is one row of `kubectl rollout history`.
type Revision struct {
	Revision string `json:"revision"`
	Change   string `json:"change"`
}

// RolloutHistory is the port of rolloutHistory(), newest first. Backed by
// kubectl's own HistoryViewer, so the CHANGE-CAUSE column matches.
func (c *Cluster) RolloutHistory(ref ResourceRef) ([]Revision, error) {
	gk, err := c.GroupKind(ref.Kind)
	if err != nil {
		return []Revision{}, nil
	}
	hv, err := polymorphichelpers.HistoryViewerFor(gk, c.Typed)
	if err != nil {
		return []Revision{}, nil
	}
	out, err := hv.ViewHistory(ref.Namespace, ref.Name, 0)
	if err != nil {
		return []Revision{}, nil
	}
	// The viewer aligns its columns with SPACES, not tabs — so this is the same
	// `^(\d+)\s+(.*)$` the Bun build matched against `kubectl rollout history`,
	// because it is literally the same formatter. Splitting on "\t" silently
	// matched nothing and returned an empty history.
	rows := []Revision{}
	for _, line := range strings.Split(out, "\n") {
		m := historyRowRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue // the REVISION/CHANGE-CAUSE header, or a blank line
		}
		rows = append(rows, Revision{Revision: m[1], Change: strings.TrimSpace(m[2])})
	}
	// The TS reversed kubectl's ascending output; keep newest first.
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows, nil
}

// RolloutUndo is the port of rolloutUndo().
func (c *Cluster) RolloutUndo(ref ResourceRef, revision string) (string, error) {
	gk, err := c.GroupKind(ref.Kind)
	if err != nil {
		return "", err
	}
	r, err := polymorphichelpers.RollbackerFor(gk, c.Typed)
	if err != nil {
		return "", errf("rollback is not supported for %s", ref.Kind)
	}
	obj, err := c.Get(ref)
	if err != nil {
		return "", err
	}
	var toRevision int64
	if revision != "" {
		if n, err := strconv.ParseInt(revision, 10, 64); err == nil {
			toRevision = n
		}
	}
	typed, err := toTyped(obj)
	if err != nil {
		return "", err
	}
	out, err := r.Rollback(typed, nil, toRevision, cmdutil.DryRunNone)
	if err != nil {
		return "", wrap(err)
	}
	return out, nil
}

// RolloutStatus is the port of rolloutStatus(): one shot, no --watch, for a
// status pill.
func (c *Cluster) RolloutStatus(ref ResourceRef) (string, error) {
	gk, err := c.GroupKind(ref.Kind)
	if err != nil {
		return "", err
	}
	sv, err := polymorphichelpers.StatusViewerFor(gk)
	if err != nil {
		return "", errf("rollout status is not supported for %s", ref.Kind)
	}
	obj, err := c.Get(ref)
	if err != nil {
		return "", err
	}
	msg, _, err := sv.Status(obj, 0)
	if err != nil {
		return "", wrap(err)
	}
	return strings.TrimSpace(msg), nil
}

// TriggerCronJob manually creates a one-off Job from a CronJob. Port of
// triggerCronJob(), including the 63-character name clamp.
func (c *Cluster) TriggerCronJob(ref ResourceRef) (string, error) {
	cj, err := c.Typed.BatchV1().CronJobs(ref.Namespace).Get(context.Background(), ref.Name, metav1.GetOptions{})
	if err != nil {
		return "", wrap(err)
	}
	name := fmt.Sprintf("%s-manual-%s", ref.Name, strconv.FormatInt(time.Now().UnixMilli(), 36))
	if len(name) > 63 {
		name = name[:63]
	}
	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   ref.Namespace,
			Annotations: map[string]string{"cronjob.kubernetes.io/instantiate": "manual"},
			Labels:      cj.Spec.JobTemplate.Labels,
		},
		Spec: cj.Spec.JobTemplate.Spec,
	}
	created, err := c.Typed.BatchV1().Jobs(ref.Namespace).Create(context.Background(), job, metav1.CreateOptions{})
	if err != nil {
		return "", wrap(err)
	}
	return fmt.Sprintf("job.batch/%s created", created.Name), nil
}

// Cordon is the port of setNodeSchedulable().
func (c *Cluster) Cordon(node string, schedulable bool) (string, error) {
	patch := map[string]any{"spec": map[string]any{"unschedulable": !schedulable}}
	body, _ := json.Marshal(patch)
	_, err := c.Typed.CoreV1().Nodes().Patch(context.Background(), node,
		types.MergePatchType, body, metav1.PatchOptions{})
	if err != nil {
		return "", wrap(err)
	}
	if schedulable {
		return fmt.Sprintf("node/%s uncordoned", node), nil
	}
	return fmt.Sprintf("node/%s cordoned", node), nil
}

// ClusterVersion is the port of clusterVersion(). There is no client version to
// report any more — the Bun build printed kubectl's — so Client carries digg's
// own build, which is what the footer was really telling you.
type ClusterVersion struct {
	Client   string `json:"client"`
	Server   string `json:"server"`
	Platform string `json:"platform"`
}

func (c *Cluster) Version(clientVersion string) ClusterVersion {
	out := ClusterVersion{Client: clientVersion}
	v, err := c.Discovery.ServerVersion()
	if err != nil {
		return out
	}
	out.Server = v.GitVersion
	out.Platform = v.Platform
	return out
}

func singular(kind string) string {
	return strings.TrimSuffix(kind, "s")
}

// wrap turns an apimachinery error into the message the UI should show. kubectl
// prints err.Error() for API failures and so did the Bun build via stderr.
func wrap(err error) error {
	if err == nil {
		return nil
	}
	return &Error{msg: err.Error()}
}

// toTyped converts an unstructured object into its typed counterpart. The
// rollout helpers take a runtime.Object of the real API type, not a bag.
func toTyped(obj *unstructured.Unstructured) (runtime.Object, error) {
	gvk := obj.GroupVersionKind()
	typed, err := scheme.Scheme.New(gvk)
	if err != nil {
		return nil, errf("no typed schema for %s", gvk.String())
	}
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, typed); err != nil {
		return nil, errf("could not decode %s: %v", gvk.Kind, err)
	}
	return typed, nil
}

package server

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/notshekhar/digg/internal/kube"
)

// Every write the browser can perform, behind one dispatcher. Port of
// src/web/actions.ts.
//
// One endpoint instead of a dozen is deliberate: mutations are the part of this
// product that can page someone at 3am, so they get exactly one door with the
// confirmation contract stated in one place. The client sends a discriminated
// union; anything not in this switch cannot happen.
//
// Nothing here decides whether an action is safe — the UI is responsible for
// asking. What this file guarantees is that a mistyped kind or a missing
// namespace turns into a 400 rather than a delete against the wrong object.

// ActionResult is what one write reports back.
type ActionResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
	// Results carries per-target outcomes, for bulk deletes where some succeed
	// and some do not.
	Results []TargetResult `json:"results,omitempty"`
}

// TargetResult is one object's outcome inside a bulk action.
type TargetResult struct {
	Target  string `json:"target"`
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

type refInput struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	NS        string `json:"ns"`
	Namespace string `json:"namespace"`
}

type actionBody struct {
	Action      string            `json:"action"`
	Context     string            `json:"context"`
	YAML        string            `json:"yaml"`
	Ref         *refInput         `json:"ref"`
	Refs        []refInput        `json:"refs"`
	Force       bool              `json:"force"`
	GracePeriod *int64            `json:"gracePeriod"`
	Replicas    *int32            `json:"replicas"`
	Revision    any               `json:"revision"`
	Node        string            `json:"node"`
	Set         map[string]string `json:"set"`
	Remove      []string          `json:"remove"`
}

func (r *refInput) toRef(context string) (kube.ResourceRef, bool) {
	if r == nil || r.Kind == "" || r.Name == "" {
		return kube.ResourceRef{}, false
	}
	ns := r.NS
	if ns == "" {
		ns = r.Namespace
	}
	return kube.ResourceRef{Context: context, Kind: r.Kind, Name: r.Name, Namespace: ns}, true
}

func label(ref kube.ResourceRef) string {
	if ref.Namespace != "" {
		return fmt.Sprintf("%s/%s/%s", ref.Namespace, ref.Kind, ref.Name)
	}
	return fmt.Sprintf("%s/%s", ref.Kind, ref.Name)
}

func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

var dataKeyRe = regexp.MustCompile(`^[-._a-zA-Z0-9]+$`)

// RunAction dispatches one write.
func RunAction(body actionBody) (ActionResult, error) {
	if body.Context == "" {
		return ActionResult{Message: "context required"}, nil
	}
	cl, err := kube.For(body.Context)
	if err != nil {
		return ActionResult{}, err
	}

	switch body.Action {
	case "apply":
		if strings.TrimSpace(body.YAML) == "" {
			return ActionResult{Message: "empty manifest"}, nil
		}
		out, err := cl.Apply(body.YAML)
		if err != nil {
			return ActionResult{}, err
		}
		if out == "" {
			out = "applied"
		}
		return ActionResult{OK: true, Message: out}, nil

	case "delete":
		inputs := body.Refs
		if len(inputs) == 0 && body.Ref != nil {
			inputs = []refInput{*body.Ref}
		}
		refs := []kube.ResourceRef{}
		for i := range inputs {
			if ref, ok := inputs[i].toRef(body.Context); ok {
				refs = append(refs, ref)
			}
		}
		if len(refs) == 0 {
			return ActionResult{Message: "no valid targets"}, nil
		}
		opts := kube.DeleteOptions{Force: body.Force, GracePeriod: body.GracePeriod}
		results := make([]TargetResult, 0, len(refs))
		failed := 0
		for _, ref := range refs {
			if _, err := cl.DeleteWith(ref, opts); err != nil {
				failed++
				results = append(results, TargetResult{Target: label(ref), Message: err.Error()})
				continue
			}
			results = append(results, TargetResult{Target: label(ref), OK: true, Message: "deleted"})
		}
		msg := fmt.Sprintf("deleted %s", plural(len(results), "object"))
		if failed > 0 {
			msg = fmt.Sprintf("%d of %d failed", failed, len(results))
		}
		return ActionResult{OK: failed == 0, Message: msg, Results: results}, nil

	case "scale":
		ref, ok := body.Ref.toRef(body.Context)
		if !ok {
			return ActionResult{Message: "ref required"}, nil
		}
		if body.Replicas == nil || *body.Replicas < 0 {
			return ActionResult{Message: "replicas must be >= 0"}, nil
		}
		if _, err := cl.Scale(ref, *body.Replicas); err != nil {
			return ActionResult{}, err
		}
		return ActionResult{OK: true,
			Message: fmt.Sprintf("scaled %s to %d", label(ref), *body.Replicas)}, nil

	case "restart":
		ref, ok := body.Ref.toRef(body.Context)
		if !ok {
			return ActionResult{Message: "ref required"}, nil
		}
		if _, err := cl.RolloutRestart(ref); err != nil {
			return ActionResult{}, err
		}
		return ActionResult{OK: true, Message: "restart triggered for " + label(ref)}, nil

	case "rollback":
		ref, ok := body.Ref.toRef(body.Context)
		if !ok {
			return ActionResult{Message: "ref required"}, nil
		}
		revision := ""
		if body.Revision != nil {
			revision = fmt.Sprintf("%v", body.Revision)
		}
		if _, err := cl.RolloutUndo(ref, revision); err != nil {
			return ActionResult{}, err
		}
		msg := "rolled back " + label(ref)
		if revision != "" {
			msg += " to revision " + revision
		}
		return ActionResult{OK: true, Message: msg}, nil

	case "cordon", "uncordon":
		if body.Node == "" {
			return ActionResult{Message: "node required"}, nil
		}
		if _, err := cl.Cordon(body.Node, body.Action == "uncordon"); err != nil {
			return ActionResult{}, err
		}
		verb := "cordoned"
		if body.Action == "uncordon" {
			verb = "uncordoned"
		}
		return ActionResult{OK: true, Message: body.Node + " " + verb}, nil

	case "drain":
		if body.Node == "" {
			return ActionResult{Message: "node required"}, nil
		}
		out, err := cl.Drain(body.Node)
		if err != nil {
			return ActionResult{}, err
		}
		if strings.TrimSpace(out) == "" {
			out = body.Node + " drained"
		}
		return ActionResult{OK: true, Message: strings.TrimSpace(out)}, nil

	case "suspend", "resume":
		ref, ok := body.Ref.toRef(body.Context)
		if !ok {
			return ActionResult{Message: "ref required"}, nil
		}
		if _, err := cl.SetSuspend(ref, body.Action == "suspend"); err != nil {
			return ActionResult{}, err
		}
		verb := "suspended"
		if body.Action == "resume" {
			verb = "resumed"
		}
		return ActionResult{OK: true, Message: label(ref) + " " + verb}, nil

	case "trigger":
		ref, ok := body.Ref.toRef(body.Context)
		if !ok {
			return ActionResult{Message: "ref required"}, nil
		}
		out, err := cl.TriggerCronJob(ref)
		if err != nil {
			return ActionResult{}, err
		}
		if strings.TrimSpace(out) == "" {
			out = "triggered " + label(ref)
		}
		return ActionResult{OK: true, Message: strings.TrimSpace(out)}, nil

	case "setData":
		ref, ok := body.Ref.toRef(body.Context)
		if !ok {
			return ActionResult{Message: "ref required"}, nil
		}
		if len(body.Set) == 0 && len(body.Remove) == 0 {
			return ActionResult{Message: "nothing to change"}, nil
		}
		// The API server rejects bad keys with a wall of validation text;
		// saying it here means the editor can point at the offending key.
		for k := range body.Set {
			if !dataKeyRe.MatchString(k) {
				return ActionResult{Message: fmt.Sprintf(
					"invalid key %q — use letters, digits, - . _", k)}, nil
			}
		}
		for _, k := range body.Remove {
			if !dataKeyRe.MatchString(k) {
				return ActionResult{Message: fmt.Sprintf(
					"invalid key %q — use letters, digits, - . _", k)}, nil
			}
		}

		// Secrets are written through `stringData`, so the API server does the
		// base64 for us. Encoding here would mean trusting the browser to get
		// padding and UTF-8 right on every value, and a wrong encoding is a
		// secret that silently no longer works.
		//
		// Deletion is a null in `data` for both kinds — a JSON merge patch
		// removes exactly the named keys and leaves the rest alone.
		isSecret := ref.Kind == "secrets" || ref.Kind == "secret"
		patch := map[string]map[string]any{}
		if len(body.Set) > 0 {
			field := "data"
			if isSecret {
				field = "stringData"
			}
			values := map[string]any{}
			for k, v := range body.Set {
				values[k] = v
			}
			patch[field] = values
		}
		if len(body.Remove) > 0 {
			if patch["data"] == nil {
				patch["data"] = map[string]any{}
			}
			for _, k := range body.Remove {
				patch["data"][k] = nil
			}
		}
		if _, err := cl.Patch(ref, patch); err != nil {
			return ActionResult{}, err
		}

		parts := []string{}
		if n := len(body.Set); n > 0 {
			parts = append(parts, plural(n, "key")+" saved")
		}
		if n := len(body.Remove); n > 0 {
			parts = append(parts, fmt.Sprintf("%d removed", n))
		}
		return ActionResult{OK: true,
			Message: fmt.Sprintf("%s: %s", label(ref), strings.Join(parts, ", "))}, nil
	}

	name := body.Action
	if name == "" {
		name = "(none)"
	}
	return ActionResult{Message: "unknown action: " + name}, nil
}

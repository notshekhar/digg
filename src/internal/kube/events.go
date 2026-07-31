package kube

import (
	"context"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
)

// Port of the events half of src/kubectl.ts.
//
// Core events specifically: events.k8s.io/v1 renames involvedObject to
// `regarding`, and the field selectors below are written against the core shape.

// Event is one normalized event row.
type Event struct {
	Type     string `json:"type"` // Normal | Warning
	Reason   string `json:"reason"`
	Message  string `json:"message"`
	Count    int32  `json:"count"`
	Source   string `json:"source"`
	LastSeen string `json:"lastSeen"` // ISO timestamp (lastTimestamp or eventTime)
}

// ObjectEvent adds the columns a cluster-wide list needs.
type ObjectEvent struct {
	Event
	Object    string `json:"object"`
	Namespace string `json:"namespace"`
}

var whitespace = strings.NewReplacer("\n", " ", "\t", " ", "\r", " ")

func normalize(e *corev1.Event) Event {
	typ := e.Type
	if typ == "" {
		typ = "Normal"
	}
	msg := strings.Join(strings.Fields(whitespace.Replace(e.Message)), " ")
	count := e.Count
	if count == 0 {
		count = 1
	}
	source := e.Source.Component
	if source == "" {
		source = e.ReportingController
	}
	last := ""
	switch {
	case !e.LastTimestamp.IsZero():
		last = e.LastTimestamp.UTC().Format(time.RFC3339)
	case !e.EventTime.IsZero():
		last = e.EventTime.UTC().Format(time.RFC3339)
	case !e.FirstTimestamp.IsZero():
		last = e.FirstTimestamp.UTC().Format(time.RFC3339)
	}
	return Event{Type: typ, Reason: e.Reason, Message: msg, Count: count, Source: source, LastSeen: last}
}

// newestFirst is the only order an event list is ever read in.
func newestFirst[T any](items []T, at func(T) string) {
	sort.SliceStable(items, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339, at(items[i]))
		tj, _ := time.Parse(time.RFC3339, at(items[j]))
		return ti.After(tj)
	})
}

// EventsFor is the port of getEvents(): events for one object, newest first.
//
// The field selector filters on the involved object's KIND (PascalCase
// singular, e.g. "Pod") — not the plural resource name — and on its name.
func (c *Cluster) EventsFor(ref ResourceRef, involvedKind string) ([]Event, error) {
	sel := fields.Set{
		"involvedObject.kind": involvedKind,
		"involvedObject.name": ref.Name,
	}.AsSelector().String()

	list, err := c.Typed.CoreV1().Events(ref.Namespace).
		List(context.Background(), metav1.ListOptions{FieldSelector: sel})
	if err != nil {
		return []Event{}, nil // an object with no readable events is not an error
	}
	out := make([]Event, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, normalize(&list.Items[i]))
	}
	newestFirst(out, func(e Event) string { return e.LastSeen })
	return out, nil
}

// ListEvents is the port of listEvents(): cluster-wide or namespaced, newest
// first, capped at limit.
func (c *Cluster) ListEvents(namespace string, limit int) ([]ObjectEvent, error) {
	if limit <= 0 {
		limit = 500
	}
	list, err := c.Typed.CoreV1().Events(namespace).
		List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return []ObjectEvent{}, nil
	}
	out := make([]ObjectEvent, 0, len(list.Items))
	for i := range list.Items {
		e := &list.Items[i]
		out = append(out, ObjectEvent{
			Event:     normalize(e),
			Object:    e.InvolvedObject.Kind + "/" + e.InvolvedObject.Name,
			Namespace: e.Namespace,
		})
	}
	newestFirst(out, func(e ObjectEvent) string { return e.LastSeen })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

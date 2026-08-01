package kube

import (
	"sync"
	"time"
)

// A tiny TTL cache with single-flight, for reads whose upstream refuses to be
// asked more often than it changes.
//
// The metrics API is the whole reason it exists. metrics-server samples on its
// own schedule — 60s by default, and every PodMetrics it returns carries
// `window: 1m` — so two requests a second apart get byte-identical numbers.
// Building one detail page asks for pod metrics twice (the summary and the
// container cards), and a table asks again on the next poll, so without this a
// single navigation could run four metrics lists for one answer.
//
// Single-flight matters as much as the TTL: the browser opens a list, a detail
// page and the metrics poll within the same tick, and three concurrent misses
// on a cold key should still make one upstream call, not three.
type ttlCache struct {
	ttl time.Duration

	mu sync.Mutex
	m  map[string]*cacheEntry
}

type cacheEntry struct {
	ready chan struct{} // closed once value is set
	at    time.Time
	value any
}

func newTTLCache(ttl time.Duration) *ttlCache {
	return &ttlCache{ttl: ttl, m: map[string]*cacheEntry{}}
}

// do returns the cached value for key, calling fn at most once per TTL and at
// most once concurrently.
func (c *ttlCache) do(key string, fn func() any) any {
	now := time.Now()

	c.mu.Lock()
	if e, ok := c.m[key]; ok {
		select {
		case <-e.ready:
			// A finished entry is reusable until it expires.
			if now.Sub(e.at) < c.ttl {
				v := e.value
				c.mu.Unlock()
				return v
			}
		default:
			// Still in flight: wait for it rather than starting a second call.
			c.mu.Unlock()
			<-e.ready
			c.mu.Lock()
			v := e.value
			c.mu.Unlock()
			return v
		}
	}
	e := &cacheEntry{ready: make(chan struct{})}
	c.m[key] = e
	c.mu.Unlock()

	value := fn()

	c.mu.Lock()
	e.value = value
	e.at = time.Now()
	c.mu.Unlock()
	close(e.ready)
	return value
}

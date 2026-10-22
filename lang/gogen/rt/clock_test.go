package rt

import (
	"fmt"
	"sync/atomic"
	"testing"
)

// A full fragment cache keeps the entry that is read and evicts the others, a little at a time,
// within its budget; invalidated entries don't pile up in the ring.
func TestFragCacheClock(t *testing.T) {
	keep := fragCacheBytes
	fragCacheBytes = 1000
	defer func() { fragCacheBytes = keep }()
	var c FragCache
	var v atomic.Int64
	entry := func(i int) *cacheEntry {
		return &cacheEntry{key: fmt.Sprint("k", i), html: make([]byte, 100), all: IDs{uint64(i): {}}}
	}
	for i := 0; i < 10; i++ {
		c.put(entry(i), 0, &v)
	}
	if c.bytes != 1000 || len(c.entries) != 10 {
		t.Fatalf("full: %d bytes, %d entries", c.bytes, len(c.entries))
	}
	// k3 is read before each new entry; the others aren't
	for i := 10; i < 40; i++ {
		if c.get("k3") == nil {
			t.Fatalf("k3 was evicted at entry %d", i)
		}
		c.put(entry(i), 0, &v)
		if c.bytes > 1000 {
			t.Fatalf("over budget: %d bytes", c.bytes)
		}
	}
	if len(c.entries) != 10 || c.Evicted != 30 {
		t.Fatalf("after: %d entries, %d evicted", len(c.entries), c.Evicted)
	}
	// invalidated entries leave the ring when it is tidied
	for i := 40; i < 400; i++ {
		c.put(entry(i), 0, &v)
		c.invalidateLocked(Deps{uint64(i): LK{}})
	}
	if len(c.clock.ring) > 2*len(c.entries)+65 {
		t.Fatalf("the ring holds %d for %d entries", len(c.clock.ring), len(c.entries))
	}
}

// The page cache likewise, within one data version; a newer version starts it again.
func TestPageCacheClock(t *testing.T) {
	keep := pageCacheMax
	pageCacheMax = 1000
	defer func() { pageCacheMax = keep }()
	var c PageCache
	for i := 0; i < 30; i++ {
		if i >= 10 && c.get("p3", 1) == nil {
			t.Fatalf("p3 was evicted at page %d", i)
		}
		c.put(fmt.Sprint("p", i), 1, make([]byte, 100), false, nil, nil)
		if c.bytes > 1000 {
			t.Fatalf("over budget: %d bytes", c.bytes)
		}
	}
	c.put("new", 2, make([]byte, 100), false, nil, nil)
	if len(c.m) != 1 || c.get("p3", 1) != nil {
		t.Fatalf("a newer version keeps %d pages", len(c.m))
	}
}

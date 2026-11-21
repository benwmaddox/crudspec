package rt

import (
	"runtime/debug"
	"testing"
)

// Under memory pressure (the heap past 85% of the limit), both caches go down to half their
// budget, giving up what wasn't used lately; without it, nothing is evicted.
func TestRelieve(t *testing.T) {
	old := debug.SetMemoryLimit(-1)
	defer debug.SetMemoryLimit(old)
	savedPage, savedFrag := pageCacheMax, fragCacheBytes
	defer func() { pageCacheMax, fragCacheBytes = savedPage, savedFrag }()
	pageCacheMax, fragCacheBytes = 1<<20, 1<<20

	db := &DB{}
	pages := &PageCache{}
	fill := func() {
		for i := 0; i < 100; i++ {
			body := make([]byte, 8<<10)
			pages.mu.Lock()
			pages.putKeyedForTest(string(rune('a'+i%26))+string(rune(i)), body)
			pages.mu.Unlock()
			db.Cache.mu.Lock()
			db.Cache.putForTest(&cacheEntry{key: string(rune(i)), html: body})
			db.Cache.mu.Unlock()
		}
	}
	fill()
	pb, _ := pages.Size()
	fb, _ := db.Cache.Size()
	if pb < 700<<10 || fb < 700<<10 {
		t.Fatalf("filled: pages %d, fragments %d bytes", pb, fb)
	}
	debug.SetMemoryLimit(1 << 62) // far above the heap: no pressure
	if relieve(db, pages) {
		t.Fatal("relieved without pressure")
	}
	debug.SetMemoryLimit(heapNow()) // the heap at the limit: pressure
	if !relieve(db, pages) {
		t.Fatal("no relief under pressure")
	}
	pb, _ = pages.Size()
	fb, _ = db.Cache.Size()
	if pb > pageCacheMax/2 || fb > fragCacheBytes/2 {
		t.Fatalf("after relief: pages %d, fragments %d bytes; want at most %d", pb, fb, pageCacheMax/2)
	}
}

// putKeyedForTest and putForTest keep an entry as put does, without a request
func (c *PageCache) putKeyedForTest(key string, body []byte) {
	if c.m == nil {
		c.m, c.index = map[string]*pageEntry{}, map[uint64]map[*pageEntry]struct{}{}
	}
	e := &pageEntry{at: nowMS(), key: key, body: body}
	c.m[key] = e
	c.bytes += len(body)
	c.clock.add(e, func(x *pageEntry) bool { return c.m[x.key] == x }, len(c.m))
}
func (c *FragCache) putForTest(e *cacheEntry) {
	if c.entries == nil {
		c.entries, c.index = map[string]*cacheEntry{}, map[uint64]map[*cacheEntry]struct{}{}
	}
	e.at = nowMS()
	c.entries[e.key] = e
	c.bytes += len(e.html)
	c.clock.add(e, func(x *cacheEntry) bool { return c.entries[x.key] == x }, len(c.entries))
}

// Memory goes back only in a quiet window (under one request a second) with more than the slack
// held past what's live.
func TestShouldReturn(t *testing.T) {
	cases := []struct {
		requests int64
		held     int64
		want     bool
	}{
		{0, 200 << 20, true},     // silent, a burst's garbage held
		{29, 200 << 20, true},    // a crawler's trickle is still quiet
		{30, 200 << 20, false},   // one a second is busy enough to keep it
		{0, quietSlack, false},   // nothing much held: nothing to do
		{5000, 200 << 20, false}, // under load
	}
	for _, c := range cases {
		if got := shouldReturn(c.requests, quietWindow, c.held); got != c.want {
			t.Errorf("shouldReturn(%d, %v, %d) = %v, want %v", c.requests, quietWindow, c.held, got, c.want)
		}
	}
	if heldPastLive() < 0 {
		t.Errorf("heldPastLive read a negative size")
	}
}

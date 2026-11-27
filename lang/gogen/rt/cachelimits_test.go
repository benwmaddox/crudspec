package rt

import (
	"runtime"
	"runtime/debug"
	"testing"
	"time"
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
	// pressure: the limit half the heap that's live (collected first, so what's left is the caches
	// this test holds, which no collection frees). At the heap as it stood, a collection between
	// here and relieve could drop it under the 85% that is pressure, and the test failed now and then
	runtime.GC()
	debug.SetMemoryLimit(heapNow() / 2)
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
	now := nowMS()
	e := &pageEntry{at: now, last: now, key: key, body: body}
	c.m[key] = e
	c.bytes += len(body)
	c.clock.add(e, func(x *pageEntry) bool { return c.m[x.key] == x }, len(c.m))
}
func (c *FragCache) putForTest(e *cacheEntry) {
	if c.entries == nil {
		c.entries, c.index = map[string]*cacheEntry{}, map[uint64]map[*cacheEntry]struct{}{}
	}
	e.at = nowMS()
	e.last = e.at
	c.entries[e.key] = e
	c.bytes += len(e.html)
	c.clock.add(e, func(x *cacheEntry) bool { return c.entries[x.key] == x }, len(c.entries))
}

// Memory goes back only in a quiet window (under one request a second), with more than the slack
// held past what's live or with something owed: requests served or entries swept since last time.
func TestShouldReturn(t *testing.T) {
	cases := []struct {
		requests, held int64
		owed           bool
		want           bool
	}{
		{0, 200 << 20, false, true},    // silent, a burst's garbage held
		{29, 200 << 20, false, true},   // a crawler's trickle is still quiet
		{30, 200 << 20, false, false},  // one a second is busy enough to keep it
		{0, quietSlack, false, false},  // nothing much held and nothing owed: nothing to do
		{0, quietSlack, true, true},    // served or swept since: SQLite's, C's or swept memory may be held
		{5000, 200 << 20, true, false}, // under load
	}
	for _, c := range cases {
		if got := shouldReturn(c.requests, quietWindow, c.held, c.owed); got != c.want {
			t.Errorf("shouldReturn(%d, %v, %d, %v) = %v, want %v", c.requests, quietWindow, c.held, c.owed, got, c.want)
		}
	}
	if heldPastLive() < 0 {
		t.Errorf("heldPastLive read a negative size")
	}
}

// A sweep drops what's past the max age and what nobody used for cacheIdle, keeps the rest, and
// takes the dropped entries out of the clock's ring too, so their memory can go.
func TestSweep(t *testing.T) {
	savedAge := CacheMaxAge
	defer func() { CacheMaxAge = savedAge }()
	CacheMaxAge = time.Hour
	now := nowMS()
	pages := &PageCache{}
	pages.mu.Lock()
	for _, k := range []string{"fresh", "old", "idle"} {
		pages.putKeyedForTest(k, make([]byte, 1000))
	}
	pages.m["old"].at = now - 2*time.Hour.Milliseconds()                 // past the max age, though used
	pages.m["idle"].last = now - (cacheIdle + time.Minute).Milliseconds() // unused too long
	pages.mu.Unlock()
	db := &DB{}
	db.Cache.mu.Lock()
	db.Cache.putForTest(&cacheEntry{key: "frag-fresh", html: make([]byte, 500)})
	db.Cache.putForTest(&cacheEntry{key: "frag-idle", html: make([]byte, 500)})
	db.Cache.entries["frag-idle"].last = now - (cacheIdle + time.Minute).Milliseconds()
	db.Cache.mu.Unlock()

	if freed := sweepCaches(db, pages); freed != 2500 {
		t.Errorf("freed %d bytes, want 2500", freed)
	}
	if _, ok := pages.m["fresh"]; !ok || len(pages.m) != 1 || len(pages.clock.ring) != 1 {
		t.Errorf("pages after the sweep: %d kept, %d in the ring; want fresh alone", len(pages.m), len(pages.clock.ring))
	}
	if _, ok := db.Cache.entries["frag-fresh"]; !ok || len(db.Cache.entries) != 1 || len(db.Cache.clock.ring) != 1 {
		t.Errorf("fragments after the sweep: %d kept, %d in the ring; want frag-fresh alone", len(db.Cache.entries), len(db.Cache.clock.ring))
	}
	if sweepCaches(db, pages) != 0 {
		t.Error("a second sweep found more")
	}
}

// Giving memory back with idle readers in the pool leaves them all there, and usable.
func TestGiveBack(t *testing.T) {
	path := t.TempDir() + "/give.db"
	w, err := OpenConn(path, true)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if err := w.Exec("CREATE TABLE t (x INTEGER)"); err != nil {
		t.Fatal(err)
	}
	r, err := NewPool(path, 3)
	if err != nil {
		t.Fatal(err)
	}
	var n int64
	if err := r.QueryRow("SELECT count(*) FROM t").Scan(&n); err != nil { // a statement prepared
		t.Fatal(err)
	}
	giveBack(&DB{R: r})
	if len(r.ch) != 3 {
		t.Fatalf("readers after giving back: %d, want 3", len(r.ch))
	}
	for i := 0; i < 3; i++ {
		c := r.Get()
		if len(c.stmts) != 0 {
			t.Errorf("an idle reader kept %d prepared statements", len(c.stmts))
		}
		r.Put(c)
	}
	if err := r.QueryRow("SELECT count(*) FROM t").Scan(&n); err != nil { // prepared again
		t.Fatalf("a reader after giving back: %v", err)
	}
}

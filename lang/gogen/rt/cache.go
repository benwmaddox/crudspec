package rt

import (
	"bytes"
	"fmt"
	"hash/maphash"
	"os"
	"strconv"
	"sync"
)

// The fragment cache: a fragment's HTML, kept by what makes it what it is (its id: the
// fragments around it, its component or list, its variables; and the viewer, the page's
// address and the ambient values), and dropped by the first commit whose keys meet what it
// read. The generator marks which fragments may be kept: none that set the page's title,
// open a channel, write to a slot or read the clock or a random token; and one that reads
// the clock while it renders (now(), signed links) isn't kept either.
//
// An entry is kept only if no commit happened while it rendered, so it never holds data older
// than the commits that would have dropped it.

type cacheEntry struct {
	key  string
	html []byte
	h    uint64 // its hash, for the fragment around it
	all  IDs    // everything it read, its fragments' too
	allK Deps   // the same as keys, in test mode
	// its HTML compressed, as a piece of a gzip page (gzip.go), made on first use
	gz     []byte
	gzOnce sync.Once
	used   bool // read since the clock's hand last passed it (clock.go)
}

type FragCache struct {
	mu      sync.Mutex
	entries map[string]*cacheEntry
	index   map[uint64]map[*cacheEntry]struct{}
	bytes   int
	clock   clock[cacheEntry] // which to evict when it is full (clock.go)
	Hits    int64
	Misses  int64
	Evicted int64
}

// the cache's budget, in bytes of HTML; past it, entries not read lately are evicted (clock.go)
var fragCacheBytes = 64 << 20

// NoFragCache turns the cache off (CRUDSPEC_NO_CACHE=1, or X-No-Cache in --test mode).
var NoFragCache = false

// NoPageCache turns off the whole-page cache alone (CRUDSPEC_NO_PAGE_CACHE=1): pages are put together
// from cached fragments, as a fragment-caching server does, for a like-for-like benchmark.
var NoPageCache = false

// CheckFragCache (--check-cache) renders every fragment the cache has afresh and compares the
// two: a cached fragment that differs from a fresh render is a cache bug, counted and logged.
var CheckFragCache = false

// CacheChecks counts the comparisons, and keeps the first mismatches (/_test/cache-check).
var CacheChecks = &cacheChecks{}

type cacheChecks struct {
	mu         sync.Mutex
	Checked    int64    `json:"checked"`
	Mismatched int64    `json:"mismatched"`
	Examples   []string `json:"examples"`
}

func (c *cacheChecks) compare(e *cacheEntry, fresh []byte, id, path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Checked++
	if bytes.Equal(e.html, fresh) {
		return
	}
	c.Mismatched++
	msg := fmt.Sprintf("fragment %s on %s: cached %d bytes, fresh %d bytes", id, path, len(e.html), len(fresh))
	fmt.Fprintln(os.Stderr, "cache check:", msg)
	if len(c.Examples) < 20 {
		c.Examples = append(c.Examples, msg)
	}
}

func (c *FragCache) get(key string) *cacheEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entries[key]
	if e != nil {
		c.Hits++
		e.used = true
	} else {
		c.Misses++
	}
	return e
}

func (c *FragCache) put(e *cacheEntry, version int64, now interface{ Load() int64 }) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if now.Load() != version { // a commit came while it rendered
		return
	}
	if len(e.html) > fragCacheBytes/4 { // one this large isn't kept
		return
	}
	if c.entries == nil {
		c.entries, c.index, c.bytes = map[string]*cacheEntry{}, map[uint64]map[*cacheEntry]struct{}{}, 0
		c.clock.reset()
	}
	if old := c.entries[e.key]; old != nil {
		c.dropLocked(old)
	}
	// full: the entries not read lately go, until it fits
	live := func(x *cacheEntry) bool { return c.entries[x.key] == x }
	used := func(x *cacheEntry) bool { u := x.used; x.used = false; return u }
	for c.bytes+len(e.html) > fragCacheBytes {
		v := c.clock.victim(live, used)
		if v == nil {
			break
		}
		c.dropLocked(v)
		c.Evicted++
	}
	c.clock.add(e, live, len(c.entries))
	c.entries[e.key] = e
	c.bytes += len(e.html)
	for k := range e.all {
		m := c.index[k]
		if m == nil {
			m = map[*cacheEntry]struct{}{}
			c.index[k] = m
		}
		m[e] = struct{}{}
	}
}

func (c *FragCache) dropLocked(e *cacheEntry) {
	if c.entries[e.key] != e {
		return
	}
	delete(c.entries, e.key)
	c.bytes -= len(e.html)
	for k := range e.all {
		if m := c.index[k]; m != nil {
			delete(m, e)
			if len(m) == 0 {
				delete(c.index, k)
			}
		}
	}
}

// invalidateLocked drops every entry that read one of these keys (nil: every entry).
func (c *FragCache) invalidateLocked(keys Deps) {
	if keys == nil {
		c.entries, c.index, c.bytes = nil, nil, 0
		c.clock.reset()
		return
	}
	for k := range keys {
		for e := range c.index[k] {
			c.dropLocked(e)
		}
	}
}

// cacheKey is what a fragment's HTML depends on besides its reads.
func (rc *RCtx) cacheKey(id string, vars map[string]Val) string {
	var h maphash.Hash
	h.SetSeed(fragSeed)
	h.WriteString(id)
	h.WriteByte(0)
	h.WriteString(rc.Who.Identity)
	h.WriteByte(0)
	h.WriteString(rc.Who.Session)
	h.WriteByte(0)
	if r, ok := rc.Who.Actor.(Ref); ok {
		h.WriteString(r.E + "#" + strconv.FormatInt(r.ID, 10))
	}
	h.WriteByte(0)
	h.WriteString(rc.Req.Path + "?" + rc.Req.RawQuery)
	h.WriteByte(0)
	h.WriteString(JSString(rc.Req.amb(rc.sv)))
	h.WriteByte(0)
	if vars != nil {
		h.WriteString(JSString(rc.sv.varsJSON(vars)))
	}
	return strconv.FormatUint(h.Sum64(), 36)
}

// ForgetAll is for writes made around the commits (the test endpoints' loads and fixtures):
// the cache starts again, and every live page refreshes.
func (db *DB) ForgetAll() {
	db.Cache.mu.Lock()
	db.Live.publish(&db.Version, nil)
	db.Cache.invalidateLocked(nil)
	db.Cache.mu.Unlock()
	db.IDs.Changed(nil)
}

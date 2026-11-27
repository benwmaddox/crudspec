package rt

import (
	"bytes"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// The page cache: a screen's whole response, as sent (gzipped or not), kept under the data
// version its snapshot read and everything about the request a page can depend on (path and
// query, host, address, user agent, cookies, the test actor; a page that read the clock isn't
// kept at all). The same request at the
// same version is the same page, so it is sent as it was, without looking up the session,
// checking the gates or rendering. Any commit moves the version, and the cache starts again.
// Not kept: a page that read the clock, showed a flash, or was a live refresh. The cookie a
// screen sets to remember a parameter is kept with it.

//
// With PageKeys (CRUDSPEC_PAGE_KEYS=1), a page is kept with everything its request read (the
// session lookup, the gates, the page and its fragments, cached or not), and a commit drops only
// the pages that read what it wrote, as the fragment cache does; a page stays across commits that
// don't touch it. The version it was rendered at still decides whether it is kept at all: one a
// commit came during is not.

// PageCacheSignedIn keeps whole pages for signed-in people too, each session's its own
// (CRUDSPEC_PAGE_CACHE=all). Without it, only signed-out pages are kept: they're one for every
// reader, while a signed-in page is one person's, seldom asked for again before it changes, and
// still put together from cached fragments.
var PageCacheSignedIn = false

// sessionCookie is the cookie a signed-in person's requests carry (the app's cookie identity)
var sessionCookie string

// PageKeys keeps pages across commits that don't touch what they read: on unless
// CRUDSPEC_PAGE_KEYS=0, which makes any commit drop every page.
var PageKeys = true

type pageEntry struct {
	at      int64 // when it was kept, unix ms (CacheMaxAge)
	last    int64 // when it was last sent, unix ms (cacheIdle)
	key     string
	v       int64
	body    []byte
	gz      bool
	cookies []string // the Set-Cookie headers it is sent with
	used    bool     // sent since the clock's hand last passed it (clock.go)
	all     IDs      // what its request read (PageKeys)
}

type PageCache struct {
	mu      sync.Mutex
	v       int64
	m       map[string]*pageEntry
	index   map[uint64]map[*pageEntry]struct{} // PageKeys: the pages that read each key
	bytes   int
	clock   clock[pageEntry] // which to evict when it is full (clock.go)
	Hits    int64            // pages sent from it (/_test/cache-check)
	Dropped int64            // pages a commit dropped (PageKeys)
	Now     interface{ Load() int64 } // the data's version (PageKeys: a page a commit came during isn't kept)
}

// the bytes kept, at most; past it, the pages not sent lately are evicted (clock.go)
var pageCacheMax = 64 << 20

// pageKey is what a request's page depends on besides the data, or "" for one never cached.
func pageKey(r *HTTPReq) string {
	if r.Method != "GET" || r.Live != "" || r.NoCache || NoFragCache || NoPageCache || r.Cookies["flash"] != "" {
		return ""
	}
	if !PageCacheSignedIn && sessionCookie != "" && r.Cookies[sessionCookie] != "" {
		return "" // signed in: not kept whole (its fragments are)
	}
	var b strings.Builder
	// not the visitor's address or browser: a page that reads them isn't kept (visitorRead), so a
	// page is one for every signed-out reader of the address
	for _, s := range []string{r.Prefix, r.Path, r.RawQuery, r.Host, r.Base, r.TestActor} {
		b.WriteString(s)
		b.WriteByte(0)
	}
	if r.Gzip {
		b.WriteByte('z')
	}
	b.WriteByte(0)
	names := make([]string, 0, len(r.Cookies))
	for k := range r.Cookies {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		b.WriteByte(0)
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(r.Cookies[k])
	}
	return b.String()
}

func (c *PageCache) get(key string, v int64) *pageEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e := c.m[key]; e != nil && (e.v == v || PageKeys) {
		if expired(e.at) {
			c.dropAny(e)
			return nil
		}
		c.Hits++
		e.used = true
		e.last = nowMS()
		return e
	}
	return nil
}

func (c *PageCache) put(key string, v int64, body []byte, gz bool, cookies []string, all IDs) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if PageKeys {
		c.putKeyed(key, v, body, gz, cookies, all)
		return
	}
	if v < c.v {
		return // rendered from an older snapshot than what is kept: the newer stays
	}
	if len(body) > pageCacheMax/4 { // one this large isn't kept
		return
	}
	// a newer version: every page kept is older, and goes
	if v > c.v || c.m == nil {
		c.m, c.v, c.bytes = map[string]*pageEntry{}, v, 0
		c.clock.reset()
	}
	if old := c.m[key]; old != nil {
		delete(c.m, key)
		c.bytes -= len(old.body)
	}
	// full: the pages not sent lately go, until it fits
	live := func(x *pageEntry) bool { return c.m[x.key] == x }
	used := func(x *pageEntry) bool { u := x.used; x.used = false; return u }
	for c.bytes+len(body) > pageCacheMax {
		x := c.clock.victim(live, used)
		if x == nil {
			break
		}
		delete(c.m, x.key)
		c.bytes -= len(x.body)
	}
	now := nowMS()
	e := &pageEntry{at: now, last: now, key: key, v: v, body: bytes.Clone(body), gz: gz, cookies: cookies}
	c.m[key] = e
	c.bytes += len(body)
	c.clock.add(e, live, len(c.m))
}

// putKeyed keeps a page with what its request read (PageKeys), unless a commit came since its
// snapshot (it might have changed what the page shows, after the commit's keys were dropped).
func (c *PageCache) putKeyed(key string, v int64, body []byte, gz bool, cookies []string, all IDs) {
	if all == nil || c.Now == nil || c.Now.Load() != v || len(body) > pageCacheMax/4 {
		return
	}
	if c.m == nil {
		c.m, c.index, c.bytes = map[string]*pageEntry{}, map[uint64]map[*pageEntry]struct{}{}, 0
		c.clock.reset()
	}
	if old := c.m[key]; old != nil {
		c.dropLocked(old)
	}
	live := func(x *pageEntry) bool { return c.m[x.key] == x }
	used := func(x *pageEntry) bool { u := x.used; x.used = false; return u }
	for c.bytes+len(body) > pageCacheMax {
		x := c.clock.victim(live, used)
		if x == nil {
			break
		}
		c.dropLocked(x)
	}
	now := nowMS()
	e := &pageEntry{at: now, last: now, key: key, v: v, body: bytes.Clone(body), gz: gz, cookies: cookies, all: all}
	c.m[key] = e
	c.bytes += len(body)
	for k := range all {
		m := c.index[k]
		if m == nil {
			m = map[*pageEntry]struct{}{}
			c.index[k] = m
		}
		m[e] = struct{}{}
	}
	c.clock.add(e, live, len(c.m))
}

// dropAny drops one page, kept by key or by version
func (c *PageCache) dropAny(e *pageEntry) {
	if PageKeys {
		c.dropLocked(e)
		return
	}
	if c.m[e.key] == e {
		delete(c.m, e.key)
		c.bytes -= len(e.body)
	}
}

// shrink evicts the pages not sent lately until at most target bytes are kept (memory pressure)
func (c *PageCache) shrink(target int) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	live := func(x *pageEntry) bool { return c.m[x.key] == x }
	used := func(x *pageEntry) bool { u := x.used; x.used = false; return u }
	n := 0
	for c.bytes > target {
		x := c.clock.victim(live, used)
		if x == nil {
			break
		}
		c.dropAny(x)
		n++
	}
	return n
}

// Size is the bytes kept and the pages, for /_metrics
func (c *PageCache) Size() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bytes, len(c.m)
}

func (c *PageCache) dropLocked(e *pageEntry) {
	if c.m[e.key] != e {
		return
	}
	delete(c.m, e.key)
	c.bytes -= len(e.body)
	for k := range e.all {
		if m := c.index[k]; m != nil {
			delete(m, e)
			if len(m) == 0 {
				delete(c.index, k)
			}
		}
	}
}

// drop is told of each commit's keys (nil: anything may have changed): with PageKeys, the pages
// that read one of them go. Without, the version the pages are kept under has moved already.
func (c *PageCache) drop(keys Deps) {
	if c == nil || !PageKeys {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if keys == nil {
		c.Dropped += int64(len(c.m))
		c.m, c.index, c.bytes = nil, nil, 0
		c.clock.reset()
		return
	}
	for k := range keys {
		for e := range c.index[k] {
			c.dropLocked(e)
			c.Dropped++
		}
	}
}

// checkPage (--check-cache) compares a page the cache has with the same page rendered afresh.
func checkPage(e *pageEntry, fresh []byte, path string) {
	if PageKeys && !e.gz {
		CacheChecks.compare(&cacheEntry{html: pageVersionRe.ReplaceAll(e.body, []byte(`"v":0`))}, pageVersionRe.ReplaceAll(fresh, []byte(`"v":0`)), "page", path)
		return
	}
	CacheChecks.compare(&cacheEntry{html: e.body}, fresh, "page", path)
}

// the version in a page's data (PageKeys: a kept page's is older than a fresh render's)
var pageVersionRe = regexp.MustCompile(`"v":[0-9]+`)

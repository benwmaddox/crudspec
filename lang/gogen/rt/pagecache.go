package rt

import (
	"bytes"
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

type pageEntry struct {
	v       int64
	body    []byte
	gz      bool
	cookies []string // the Set-Cookie headers it is sent with
}

type PageCache struct {
	mu    sync.Mutex
	v     int64
	m     map[string]*pageEntry
	bytes int
	Hits  int64 // pages sent from it (/_test/cache-check)
}

const pageCacheMax = 64 << 20 // the bytes kept, at most: then it starts again

// pageKey is what a request's page depends on besides the data, or "" for one never cached.
func pageKey(r *HTTPReq) string {
	if r.Method != "GET" || r.Live != "" || r.NoCache || NoFragCache || r.Cookies["flash"] != "" {
		return ""
	}
	var b strings.Builder
	for _, s := range []string{r.Path, r.RawQuery, r.Host, r.Base, r.IP, r.UA, r.TestActor} {
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
	if e := c.m[key]; e != nil && e.v == v {
		c.Hits++
		return e
	}
	return nil
}

func (c *PageCache) put(key string, v int64, body []byte, gz bool, cookies []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v < c.v {
		return // rendered from an older snapshot than what is kept: the newer stays
	}
	if v > c.v || c.m == nil || c.bytes+len(body) > pageCacheMax {
		c.m, c.v, c.bytes = map[string]*pageEntry{}, v, 0
	}
	c.m[key] = &pageEntry{v: v, body: bytes.Clone(body), gz: gz, cookies: cookies}
	c.bytes += len(body)
}

// checkPage (--check-cache) compares a page the cache has with the same page rendered afresh.
func checkPage(e *pageEntry, fresh []byte, path string) {
	CacheChecks.compare(&cacheEntry{html: e.body}, fresh, "page", path)
}

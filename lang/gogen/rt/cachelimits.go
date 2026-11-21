package rt

import (
	"runtime/debug"
	"runtime/metrics"
	"sync/atomic"
	"time"
)

// How long the caches keep things, and how much. A commit drops what it touched (by key); these
// are the rest:
// - an age: an entry older than CacheMaxAge (--cache-max-age, a day unless said) isn't used and
//   goes, a safety net for a read no key followed, and for what's gone cold;
// - a budget each, a share of the process's memory limit (GOMEMLIMIT, or the default the app
//   sets): past it, what wasn't used lately is evicted (clock.go);
// - memory pressure: when the heap nears the limit, both give up what wasn't used lately until
//   they're at half their budget, so the caches yield before the process struggles.

// CacheMaxAge is how long a page or fragment is kept at most; 0: no limit.
var CacheMaxAge = 24 * time.Hour

func nowMS() int64 { return time.Now().UnixMilli() }

// expired: an entry kept at this time is past CacheMaxAge
func expired(at int64) bool {
	return CacheMaxAge > 0 && nowMS()-at > CacheMaxAge.Milliseconds()
}

// cacheShare: each cache's budget, as a share of the memory limit
const cacheShare = 4

// SizeCaches sets each cache's budget from the memory limit: a quarter each, between 16 MB and
// 2 GB. Without a limit (math.MaxInt64), they keep their defaults.
func SizeCaches() {
	limit := debug.SetMemoryLimit(-1)
	if limit <= 0 || limit >= 1<<62 {
		return
	}
	b := int(limit / cacheShare)
	if b < 16<<20 {
		b = 16 << 20
	}
	if b > 2<<30 {
		b = 2 << 30
	}
	pageCacheMax, fragCacheBytes = b, b
}

// heapNow is the heap's size (live and not yet swept), from the runtime's metrics
var heapSample = []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}

func heapNow() int64 {
	metrics.Read(heapSample)
	if heapSample[0].Value.Kind() != metrics.KindUint64 {
		return 0
	}
	return int64(heapSample[0].Value.Uint64())
}

// Pressure is what the watcher did, for /_metrics: relieved the caches, returned memory when quiet
var Pressure struct{ Times, Evicted, Returned int64 }

// served counts requests, for the watcher to tell a quiet spell (server.go adds each)
var served atomic.Int64

// When it's quiet, memory goes back to the system. A burst leaves the heap far past what's live
// (garbage the collector hasn't reached, freed pages it keeps for reuse), and an idle process
// collects only every two minutes and hands pages back slowly: on a shard of small wikis, minutes
// at several times its working size. Quiet is under one request a second over the last quiet
// window (crawlers keep a small wiki from ever being silent); then, if more than slack is held
// past what's live or anything was served since the last time, the idle readers drop SQLite's
// cached pages, one full collection returns the Go heap's (debug.FreeOSMemory), and glibc hands
// back the C heap's (malloc_trim). At most once a window.
const (
	quietWindow = 30 * time.Second
	quietSlack  = 16 << 20
)

var memSample = []metrics.Sample{
	{Name: "/memory/classes/heap/objects:bytes"}, // live, and garbage not yet collected
	{Name: "/memory/classes/heap/free:bytes"},    // free, not yet given back
	{Name: "/gc/heap/live:bytes"},                // live at the last collection
}

// heldPastLive: how much the heap keeps beyond what was live at the last collection
func heldPastLive() int64 {
	metrics.Read(memSample)
	v := func(i int) int64 {
		if memSample[i].Value.Kind() != metrics.KindUint64 {
			return 0
		}
		return int64(memSample[i].Value.Uint64())
	}
	return v(0) + v(1) - v(2)
}

// shouldReturn: a quiet window (fewer requests than seconds in it) with more than slack held past
// what's live, or with requests since memory last went back (SQLite's caches and freed C memory, which the Go
// heap's figures don't show)
func shouldReturn(requests int64, window time.Duration, held int64, sinceLast int64) bool {
	return requests < int64(window/time.Second) && (held > quietSlack || sinceLast > 0)
}

// giveBack: the readers' idle connections drop their cached pages, the Go heap is collected and
// its free pages returned, then the C heap's (glibc's) freed memory
func giveBack(db *DB) {
	if db != nil {
		for _, p := range []*Pool{db.R, db.A} {
			if p != nil {
				p.ReleaseIdle()
			}
		}
	}
	debug.FreeOSMemory()
	trimCHeap()
}

// relieve: past 85% of the memory limit, both caches go down to half their budget
func relieve(db *DB, pages *PageCache) bool {
	limit := debug.SetMemoryLimit(-1)
	if limit <= 0 || limit >= 1<<62 || heapNow() < limit*85/100 {
		return false
	}
	n := 0
	if pages != nil {
		n += pages.shrink(pageCacheMax / 2)
	}
	n += db.Cache.shrink(fragCacheBytes / 2)
	Pressure.Times++
	Pressure.Evicted += int64(n)
	return true
}

// watchMemory checks the heap every few seconds while the server runs, and gives memory back
// after a quiet window
func watchMemory(db *DB, pages *PageCache) {
	const tick = 3 * time.Second
	go func() {
		ring := make([]int64, int(quietWindow/tick)) // the request count at each of the window's ticks
		at, filled := 0, 0
		var lastReturn int64 // the request count when memory last went back
		for range time.Tick(tick) {
			relieve(db, pages)
			now := served.Load()
			then := ring[at]
			ring[at] = now
			at = (at + 1) % len(ring)
			if filled < len(ring) {
				filled++
				continue
			}
			if shouldReturn(now-then, quietWindow, heldPastLive(), now-lastReturn) {
				giveBack(db)
				lastReturn = now
				Pressure.Returned++
				filled = 0 // the next check is a whole window later
			}
		}
	}()
}

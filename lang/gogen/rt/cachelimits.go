package rt

import (
	"runtime/debug"
	"runtime/metrics"
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

// Pressure is what the watcher did, for /_metrics
var Pressure struct{ Times, Evicted int64 }

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

// watchMemory checks the heap every few seconds while the server runs
func watchMemory(db *DB, pages *PageCache) {
	go func() {
		for range time.Tick(3 * time.Second) {
			relieve(db, pages)
		}
	}()
}

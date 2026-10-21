package rt

import (
	"sync"
	"sync/atomic"
)

// Live streams (/_events) are bounded: each holds a goroutine and a timer for as long as its page
// is open, so the server keeps at most MaxStreams of them, and at most MaxStreamsEach for one
// person (their session, or their address when signed out). Past either it refuses (503, with
// Retry-After); the page stays as it is, and its stream tries again later.
var (
	MaxStreams     = 10_000
	MaxStreamsEach = 16
)

type streamCount struct {
	all  atomic.Int64
	mu   sync.Mutex
	each map[string]int
}

// open takes a place for a stream of who's: false when there is none (it is refused)
func (c *streamCount) open(who string) bool {
	if c.all.Add(1) > int64(MaxStreams) {
		c.all.Add(-1)
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.each == nil {
		c.each = map[string]int{}
	}
	if c.each[who] >= MaxStreamsEach {
		c.all.Add(-1)
		return false
	}
	c.each[who]++
	return true
}

// close gives back the place open took
func (c *streamCount) close(who string) {
	c.all.Add(-1)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.each[who]--; c.each[who] <= 0 {
		delete(c.each, who)
	}
}

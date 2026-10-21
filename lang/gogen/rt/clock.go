package rt

// clock is CLOCK eviction (second chance) for a cache kept to a fixed budget: its entries in a
// ring, and a hand that goes round it. An entry used since the hand last passed is passed over
// (its use forgotten); the first one that wasn't is evicted. A full cache so keeps what is read
// often and lets go of the rest, a little at a time, rather than starting again empty.
//
// The cache holds its lock around every call. Entries it has dropped (invalidated) leave the
// ring when the hand meets them, or when the ring is tidied (add).
type clock[E any] struct {
	ring []*E
	hand int
}

// add puts e in the ring; live says whether an entry is still the cache's (for tidying)
func (c *clock[E]) add(e *E, live func(*E) bool, entries int) {
	if len(c.ring) > 2*entries+64 {
		kept := c.ring[:0]
		for _, x := range c.ring {
			if live(x) {
				kept = append(kept, x)
			}
		}
		clear(c.ring[len(kept):])
		c.ring, c.hand = kept, 0
	}
	c.ring = append(c.ring, e)
}

// victim is the entry to evict, taken out of the ring (nil when there is none): used reports
// and forgets an entry's use since the hand last passed it
func (c *clock[E]) victim(live func(*E) bool, used func(*E) bool) *E {
	for n := 0; len(c.ring) > 0 && n < 2*len(c.ring)+2; n++ {
		if c.hand >= len(c.ring) {
			c.hand = 0
		}
		e := c.ring[c.hand]
		if live(e) && used(e) {
			c.hand++
			continue
		}
		last := len(c.ring) - 1
		c.ring[c.hand] = c.ring[last]
		c.ring[last] = nil
		c.ring = c.ring[:last]
		if live(e) {
			return e
		}
	}
	return nil
}

func (c *clock[E]) reset() { c.ring, c.hand = nil, 0 }

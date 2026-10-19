package rt

import "sync"

// IDCache keeps the session lookup's answers (token -> actor) until a commit changes what the
// lookup reads: the generator says which entities that is (UI.SessionReads; "*" for anything). A
// lookup that began before such a commit can't store its answer after it (the generation moved).
type IDCache struct {
	mu    sync.Mutex
	gen   int64
	on    bool
	all   bool
	reads map[string]bool
	m     map[string]Val
}

const idCacheMax = 100_000

func (c *IDCache) Configure(reads []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.on, c.reads, c.m = len(reads) > 0, map[string]bool{}, map[string]Val{}
	for _, e := range reads {
		if e == "*" {
			c.all = true
		}
		c.reads[e] = true
	}
}

// Get is the cached answer, if there is one, and the generation to Put a new one under.
func (c *IDCache) Get(token string) (Val, bool, int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.on {
		return nil, false, -1
	}
	v, ok := c.m[token]
	return v, ok, c.gen
}

func (c *IDCache) Put(token string, v Val, gen int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.on || gen != c.gen {
		return
	}
	if len(c.m) >= idCacheMax {
		c.m = map[string]Val{}
	}
	c.m[token] = v
}

// Changed is told of each commit's keys (nil: anything may have changed).
func (c *IDCache) Changed(keys Deps) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.on || len(c.m) == 0 && keys != nil {
		c.gen++
		return
	}
	hit := keys == nil || c.all
	for k := range keys {
		if hit {
			break
		}
		hit = c.reads[k.E]
	}
	if hit {
		c.m = map[string]Val{}
	}
	c.gen++
}

package rt

import (
	"sync"
	"sync/atomic"
)

// Test doubles (docs/testing.md): while a spec test runs (/_test/spec), no extern reaches outside
// the app. A pure one runs as it is; any other gives what the test's `fake <extern> returns <value>`
// said, or none. Every call is counted, for `calls("name")` in the test's expects.
type specDoubles struct {
	mu    sync.Mutex
	fakes map[string]Val
	calls map[string]int64
}

// the spec test running now, if any (one at a time: /_test/spec holds the writer)
type doublesSlot struct{ p atomic.Pointer[specDoubles] }

func (a *App) beginDoubles() func() {
	a.doubles.p.Store(&specDoubles{fakes: map[string]Val{}, calls: map[string]int64{}})
	return func() { a.doubles.p.Store(nil) }
}

// fake sets what the extern gives for the rest of the test
func (a *App) fake(name string, v Val) {
	if d := a.doubles.p.Load(); d != nil {
		d.mu.Lock()
		d.fakes[name] = v
		d.mu.Unlock()
	}
}

// doubled is what an extern call gives while a spec test runs: ok is false when no test is running
// (the extern runs as it is) or the extern is pure and not faked (it runs as it is too)
func (a *App) doubled(name string) (v Val, ok bool) {
	d := a.doubles.p.Load()
	if d == nil {
		return nil, false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls[name]++
	if v, faked := d.fakes[name]; faked {
		return v, true
	}
	if a.Pure[name] != nil {
		return nil, false
	}
	return nil, true
}

// B_calls is calls("name"): how many times this test has called the extern
func B_calls(c *Ctx, a ...Val) Val {
	d := c.App.doubles.p.Load()
	if d == nil {
		return int64(0)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls[Plain(arg(a, 0))]
}

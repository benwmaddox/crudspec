package rt

import (
	"sync"
	"bytes"
	"encoding/binary"
	"hash/maphash"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// Fragments: each component instance and each list on a page is a fragment, marked with
// comments (which leave layout and CSS selectors alone):
//
//	<!--f:ID-->…<!--/f:ID HASH KEY KEY …-->
//
// ID is stable from render to render (the enclosing fragment, the component or list, and its
// variables); HASH is the content's; the keys are what the fragment itself read (hashed, as
// live.go's). When a commit's keys meet a fragment's, the page asks for just that fragment
// (X-Live: frags), saying which fragments it has and their hashes; the answer leaves out each
// nested fragment it already has unchanged (<!--keep:ID-->). A page whose own keys (read
// outside any fragment) meet is refreshed whole, as before.

type fragState struct {
	id    string
	buf   *bytes.Buffer // the buffer it is written to
	open  int           // where its start marker is in it
	start int           // where its content starts
	own   Deps
	kids  []fragSpan // fragments nested in it, in the same buffer, in order
	all     IDs    // everything read while it rendered, nested fragments' too (for the cache)
	allK    Deps   // the same as keys, in test mode (the test endpoints show them)
	key     string // its cache key, when it may be kept
	version int64  // the data's version when it started
	clock   bool   // it read the clock: not kept
	hit     bool   // written from the cache
	verify  *cacheEntry // --check-cache: the cached entry this fresh render must equal
}

// Hit is whether the fragment came from the cache (its content is written: skip rendering it).
func (f *fragState) Hit() bool { return f != nil && f.hit }

// a finished fragment inside another: where it lies, and its hash
type fragSpan struct {
	open, stop int
	h          uint64
}

// the fragments' hashes: stable for the process (a page keeps its fragments only while the
// app that rendered them runs; after a restart they are sent again)
var fragSeed = maphash.MakeSeed()

// Frag starts a fragment named name with these variables, written to w.
func (rc *RCtx) Frag(w *bytes.Buffer, name string, vars map[string]Val, cache bool, cacheVars map[string]Val) *fragState {
	s := rc.Req.Sess
	if s.Reads == nil { // not a page render (a fragment's own refresh renders the page)
		return nil
	}
	parent := ""
	if n := len(s.frags); n > 0 {
		parent = s.frags[n-1].id
	}
	// FNV-1a, as hash/fnv's, without making a hasher: ids are short, and the same from process
	// to process
	h := fnvAdd(fnvAdd(fnvAdd(fnvAdd(fnvOffset, parent), "\x00"), name), "\x00")
	if len(vars) > 0 {
		// the variables, sorted: refs and plain values as text, anything else as JSON (in the
		// page's scratch bytes)
		var keep [8]string
		names := keep[:0]
		for k := range vars {
			names = append(names, k)
		}
		sort.Strings(names)
		var b []byte
		if rc.P != nil {
			b = rc.P.scratch[:0]
		}
		for _, k := range names {
			b = append(b, k...)
			b = append(b, '=')
			switch x := vars[k].(type) {
			case Ref:
				b = strconv.AppendInt(append(append(b, x.E...), '#'), x.ID, 10)
			case string:
				b = append(b, x...)
			case int64:
				b = strconv.AppendInt(b, x, 10)
			case bool:
				b = strconv.AppendBool(b, x)
			case nil:
				b = append(b, '~')
			default:
				b = append(b, JSString(x)...)
			}
			b = append(b, 0)
		}
		h = fnvAddBytes(h, b)
		if rc.P != nil {
			rc.P.scratch = b[:0]
		}
	}
	id := hex16(h) // hex, fixed width: no "-" to confuse the markers
	f := rc.P.newFrag()
	*f = fragState{id: id, buf: w, open: w.Len(), own: depsPool.Get().(Deps), all: idsPool.Get().(IDs)}
	if s.AllReads != nil {
		f.allK = Deps{}
	}
	if cache && !NoFragCache && !rc.Req.NoCache {
		db := rc.sv.App.DB
		f.key = rc.cacheKey(id, cacheVars)
		if e := db.Cache.get(f.key); e != nil && CheckFragCache {
			f.verify = e // rendered afresh, and compared at its end
		} else if e != nil {
			// from the cache: its HTML, and what it read for the fragments around it
			if rc.P != nil {
				rc.P.segs = append(rc.P.segs, pageSeg{buf: w, off: w.Len(), e: e})
			}
			w.Write(e.html)
			// what it read, for the fragment around it (which passes it on when it ends)
			if n := len(s.frags); n > 0 {
				p := s.frags[n-1]
				p.all.Merge(e.all)
				if p.allK != nil {
					p.allK.Merge(e.allK)
				}
			}
			if s.AllReads != nil {
				s.AllReads.Merge(e.allK)
			}
			if n := len(s.frags); n > 0 && s.frags[n-1].buf == w {
				p := s.frags[n-1]
				p.kids = append(p.kids, fragSpan{open: f.open, stop: w.Len(), h: e.h})
			}
			f.hit = true
			f.release()
			return f
		}
		f.version = s.ReadVersion()
	}
	w.WriteString("<!--f:")
	w.WriteString(id)
	w.WriteString("-->")
	f.start = w.Len()
	s.frags = append(s.frags, f)
	s.lastOK = false
	return f
}

// LoopVars is the variables of the loops around a fragment: what tells its instances apart.
func (rc *RCtx) LoopVars(names ...string) map[string]Val {
	if len(names) == 0 {
		return nil
	}
	m := make(map[string]Val, len(names))
	for _, n := range names {
		m[n] = rc.Vars[n]
	}
	return m
}

// EndFrag ends the fragment Frag started, in the same buffer.
func (rc *RCtx) EndFrag(w *bytes.Buffer, f *fragState) {
	if f == nil || f.hit {
		return
	}
	s := rc.Req.Sess
	s.frags = s.frags[:len(s.frags)-1]
	s.lastOK = false
	// what it read is read by the fragment around it too
	if n := len(s.frags); n > 0 {
		p := s.frags[n-1]
		p.all.Merge(f.all)
		if p.allK != nil {
			p.allK.Merge(f.allK)
		}
	}
	// the hash is of the fragment's own bytes, the hashes of the fragments in it (so each byte
	// is hashed once), and its keys: a fragment that reads differently but looks the same is
	// sent again, so the page doesn't keep keys that no longer say what it shows
	keys := rc.sv.App.DB.Live.HashDeps(f.own)
	clear(f.own)
	depsPool.Put(f.own)
	f.own = nil
	sort.Strings(keys)
	var h maphash.Hash
	h.SetSeed(fragSeed)
	data := w.Bytes()
	at := f.start
	if f.start > len(data) || w != f.buf {
		at = len(data)
	}
	for _, k := range f.kids {
		if k.open < at || k.stop > len(data) {
			continue
		}
		h.Write(data[at:k.open])
		var b [8]byte
		binary.LittleEndian.PutUint64(b[:], k.h)
		h.Write(b[:])
		at = k.stop
	}
	h.Write(data[at:])
	for _, k := range keys {
		h.WriteString(" " + k)
	}
	sum := h.Sum64()
	w.WriteString("<!--/f:")
	w.WriteString(f.id)
	w.WriteByte(' ')
	b36 := strconv.FormatUint(sum, 36) // fixed width: padded with zeros to 13 (as %013s)
	for i := len(b36); i < 13; i++ {
		w.WriteByte('0')
	}
	w.WriteString(b36)
	for _, k := range keys {
		w.WriteString(" " + k)
	}
	w.WriteString("-->")
	if n := len(s.frags); n > 0 && s.frags[n-1].buf == w {
		p := s.frags[n-1]
		p.kids = append(p.kids, fragSpan{open: f.open, stop: w.Len(), h: sum})
	}
	if f.verify != nil && f.open <= w.Len() && w == f.buf {
		CacheChecks.compare(f.verify, w.Bytes()[f.open:], f.id, rc.Req.Path)
	}
	// kept, unless it read the clock or a commit came while it rendered
	if f.key != "" && !f.clock && f.open <= w.Len() && w == f.buf {
		rc.sv.App.DB.Cache.put(&cacheEntry{key: f.key, html: append([]byte(nil), w.Bytes()[f.open:]...), h: sum, all: f.all, allK: f.allK}, f.version, &rc.sv.App.DB.Version)
		return // its reads are the cache entry's now
	}
	f.release()
}

// A fragment's sets of keys are used again by the next fragments (cleared, they keep their
// room): a page makes hundreds, so growing new ones each time was much of its garbage.
var depsPool = sync.Pool{New: func() any { return Deps{} }}
var idsPool = sync.Pool{New: func() any { return IDs{} }}

// release gives back the fragment's sets it still has.
func (f *fragState) release() {
	if f.own != nil {
		clear(f.own)
		depsPool.Put(f.own)
		f.own = nil
	}
	if f.all != nil {
		clear(f.all)
		idsPool.Put(f.all)
		f.all = nil
	}
}

// ---- answering a fragment refresh

type fragNode struct {
	id, h                     string
	open, body, bodyEnd, stop int // the start marker, the content, the end marker's end
	kids                      []*fragNode
}

// parseFrags finds a page's fragments, nested as they are.
func parseFrags(page []byte) map[string]*fragNode {
	all := map[string]*fragNode{}
	var stack []*fragNode
	root := &fragNode{}
	for i := 0; i < len(page); {
		j := bytes.Index(page[i:], []byte("<!--"))
		if j < 0 {
			break
		}
		i += j
		end := bytes.Index(page[i:], []byte("-->"))
		if end < 0 {
			break
		}
		text := string(page[i+4 : i+end])
		stop := i + end + 3
		switch {
		case strings.HasPrefix(text, "f:"):
			n := &fragNode{id: text[2:], open: i, body: stop}
			parent := root
			if len(stack) > 0 {
				parent = stack[len(stack)-1]
			}
			parent.kids = append(parent.kids, n)
			stack = append(stack, n)
		case strings.HasPrefix(text, "/f:"):
			parts := strings.Fields(text[3:])
			if len(stack) > 0 && len(parts) >= 2 && stack[len(stack)-1].id == parts[0] {
				n := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				n.h, n.bodyEnd, n.stop = parts[1], i, stop
				all[n.id] = n
			}
		}
		i = stop
	}
	return all
}

// fragHTML is a fragment as the page has it now, with each nested fragment the client has
// unchanged left out.
func fragHTML(page []byte, n *fragNode, known map[string]string) string {
	var b strings.Builder
	b.Write(page[n.open:n.body])
	at := n.body
	for _, k := range n.kids {
		if k.stop == 0 {
			continue
		}
		b.Write(page[at:k.open])
		if known[k.id] == k.h {
			b.WriteString("<!--keep:" + k.id + "-->")
		} else {
			b.WriteString(fragHTML(page, k, known))
		}
		at = k.stop
	}
	b.Write(page[at:n.stop])
	return b.String()
}

// liveFrags answers X-Live: frags from the page as rendered now: its data (version, keys) and
// each fragment asked for (null when the page no longer has it: the client refreshes whole).
func liveFrags(page []byte, want, known string) map[string]any {
	nodes := parseFrags(page)
	kn := map[string]string{}
	for _, p := range strings.Split(known, ",") {
		if i := strings.IndexByte(p, ':'); i > 0 {
			kn[p[:i]] = p[i+1:]
		}
	}
	frags := map[string]any{}
	for _, id := range strings.Split(want, ",") {
		if id == "" {
			continue
		}
		if n := nodes[id]; n != nil {
			frags[id] = fragHTML(page, n, kn)
		} else {
			frags[id] = nil
		}
	}
	out := map[string]any{"frags": frags}
	const open = `<script id="crudspec-page" type="application/json">`
	if i := bytes.Index(page, []byte(open)); i >= 0 {
		if j := bytes.Index(page[i:], []byte("</script>")); j >= 0 {
			var data any
			json.Unmarshal([]byte(strings.ReplaceAll(string(page[i+len(open):i+j]), `<\/`, "</")), &data)
			out["page"] = data
		}
	}
	return out
}

// hex16 is n as 16 hex digits.
const fnvOffset, fnvPrime uint64 = 14695981039346656037, 1099511628211

func fnvAdd(h uint64, s string) uint64 {
	for i := 0; i < len(s); i++ {
		h = (h ^ uint64(s[i])) * fnvPrime
	}
	return h
}
func fnvAddBytes(h uint64, b []byte) uint64 {
	for _, c := range b {
		h = (h ^ uint64(c)) * fnvPrime
	}
	return h
}

func hex16(n uint64) string {
	const digits = "0123456789abcdef"
	var b [16]byte
	for i := 15; i >= 0; i-- {
		b[i] = digits[n&15]
		n >>= 4
	}
	return string(b[:])
}

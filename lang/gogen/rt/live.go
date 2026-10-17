package rt

import (
	"runtime/debug"
	"encoding/json"
	"os"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
)

// Live pages refresh only when a commit changed something they read.
//
// While a page renders, its session records what it reads as keys: "E" for a whole table,
// "E#id" for a row, "E.col=v" for the rows whose column holds v (a query's equality on a
// parameter, at the top of its conditions or of a subquery's), and "E!any" beside each of those
// (see below). A commit publishes the keys of every row it created, changed or deleted: "E",
// "E#id", and "E.col=v" for each column's old and new value; or "E!any" when it can't say which
// values a row had. A page refreshes when the two meet.
//
// Keys travel hashed with the app's secret, so the stream tells a page nothing about rows it
// didn't read.

type Deps map[string]struct{}

func (s *Sess) read(k string) {
	if s.Reads != nil {
		if s.AllReads != nil {
			s.AllReads[k] = struct{}{}
		}
		if n := len(s.frags); n > 0 { // the innermost fragment's own
			s.frags[n-1].own[k] = struct{}{}
			return
		}
		if t := os.Getenv("CRUDSPEC_LIVE_TRACE_KEY"); t != "" && t == k {
			fmt.Fprintf(os.Stderr, "live: read %s at %s\n%s\n", k, SpecWhere(), debug.Stack())
		}
		s.Reads[k] = struct{}{}
	}
}

// readWhere records what a query over e reads: its equalities, or the whole table.
func (s *Sess) readWhere(e *Entity, where string, args []any) {
	if s.Reads == nil || !e.Stored {
		return
	}
	for _, r := range whereKeys(e.Name, where) {
		if r.col == "" {
			if os.Getenv("CRUDSPEC_LIVE_TRACE") != "" {
				fmt.Fprintf(os.Stderr, "live: whole %s %v from %s: %s\n", r.table, r.cols, e.Name, where)
			}
			if len(r.cols) == 0 {
				s.read(r.table)
			}
			for _, c := range r.cols {
				s.read(r.table + ":" + c)
			}
			continue
		}
		var v any
		if r.arg < len(args) {
			v = args[r.arg]
		}
		if r.col == "id[]" { // a JSON list of ids
			var ids []int64
			json.Unmarshal([]byte(keyVal(v)), &ids)
			for _, id := range ids {
				s.read(r.table + "#" + keyVal(id))
			}
			continue
		}
		if r.col == "id" {
			s.read(r.table + "#" + keyVal(v))
		} else {
			s.read(r.table + "." + r.col + "=" + keyVal(v))
		}
		s.read(r.table + "!any")
	}
}

func keyVal(v any) string {
	switch x := v.(type) {
	case nil:
		return "~"
	case string:
		return x
	case []byte:
		return string(x)
	}
	return fmt.Sprint(v)
}

// readRows records the rows a query returned: a touch (which changes only a row's time) reaches
// just the pages that showed the row.
func (s *Sess) readRows(e *Entity, rows []*Row, byTime bool) {
	if s.Reads == nil || !e.Stored || len(rows) > 1000 {
		return
	}
	for _, r := range rows {
		s.read(e.Name + "#" + keyVal(r.ID))
		if byTime {
			s.read(e.Name + "#" + keyVal(r.ID) + "@t")
		}
	}
}

// touched records a write that changed only a row's time.
func (s *Sess) touched(e *Entity, id int64) {
	if s.wkeys == nil {
		s.wkeys = Deps{}
	}
	s.wkeys[e.Name+"#"+fmt.Sprint(id)+"@t"] = struct{}{}
	s.wkeys[e.Name+":updated"] = struct{}{}
}

// readTime records that something looked at a row's time (its updated), which a touch changes.
func (s *Sess) readTime(e string, id int64) {
	if s != nil && s.Reads != nil {
		s.read(e + "#" + keyVal(id) + "@t")
	}
}

// ---- writes

// wrote records the keys of a row as it was (old: its encoded columns, or nil) and as it is
// now (now: the same, or nil for a delete).
func (s *Sess) wrote(e *Entity, id int64, old, now []any) {
	if s.wkeys == nil {
		s.wkeys = Deps{}
	}
	s.wkeys[e.Name] = struct{}{}
	s.wkeys[e.Name+"#"+fmt.Sprint(id)] = struct{}{}
	s.wkeys[e.Name+"#"+fmt.Sprint(id)+"@t"] = struct{}{}
	// the columns it changed: all, for a row made or deleted (or one whose old values aren't known)
	for i, f := range e.Fields {
		if old == nil || now == nil || i >= len(old) || i >= len(now) || keyVal(old[i]) != keyVal(now[i]) {
			s.wkeys[e.Name+":"+f.Name] = struct{}{}
		}
	}
	s.wkeys[e.Name+":id"] = struct{}{}
	s.wkeys[e.Name+":updated"] = struct{}{}
	if old == nil || now == nil {
		s.wkeys[e.Name+":seq"], s.wkeys[e.Name+":created"] = struct{}{}, struct{}{}
	}
	if old == nil && now == nil {
		s.wkeys[e.Name+"!any"] = struct{}{}
		return
	}
	for _, vals := range [][]any{old, now} {
		for i, v := range vals {
			if i < len(e.Fields) && keyable(v) {
				s.wkeys[e.Name+"."+e.Fields[i].Name+"="+keyVal(v)] = struct{}{}
			}
		}
	}
}

func keyable(v any) bool {
	switch x := v.(type) {
	case nil, int64, int, bool, float64:
		return true
	case string:
		return len(x) <= 200
	}
	return false
}

// publish makes the session's writes visible to live pages, as one commit (all: what it
// changed isn't known, so every page refreshes).
func (s *Sess) publish(all bool) {
	keys := s.wkeys
	s.wkeys = nil
	if keys == nil && !all {
		keys = Deps{}
	}
	s.DB.Live.publish(&s.DB.Version, keys)
}

// ---- the commits live pages are told of

type commit struct {
	v    int64
	keys []string // hashed
	plain []string // the same, as they are (the test endpoints show them)
	all  bool     // what changed isn't known: every page refreshes
}

type Live struct {
	mu      sync.Mutex
	commits []commit // the most recent, oldest first
	secret  []byte
	hashes  sync.Map
}

const liveHistory = 512

func (l *Live) publish(version interface{ Add(int64) int64 }, keys Deps) {
	hashed, plain := make([]string, 0, len(keys)), make([]string, 0, len(keys))
	for k := range keys {
		hashed = append(hashed, l.Hash(k))
		plain = append(plain, k)
	}
	l.mu.Lock()
	v := version.Add(1)
	l.commits = append(l.commits, commit{v: v, keys: hashed, plain: plain, all: keys == nil})
	if len(l.commits) > liveHistory {
		l.commits = append([]commit(nil), l.commits[len(l.commits)-liveHistory/2:]...)
	}
	l.mu.Unlock()
}

// Since is what changed after version v: the hashed keys, or all when the history doesn't
// reach back that far (or a commit didn't say).
func (l *Live) Since(v int64) (last int64, keys []string, all bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	last = v
	if len(l.commits) == 0 {
		return
	}
	if l.commits[0].v > v+1 {
		all = true
	}
	for _, c := range l.commits {
		if c.v <= v {
			continue
		}
		last = c.v
		all = all || c.all
		keys = append(keys, c.keys...)
	}
	return
}

// Hash is a key as pages and the stream carry it.
func (l *Live) Hash(k string) string {
	if h, ok := l.hashes.Load(k); ok {
		return h.(string)
	}
	m := hmac.New(sha256.New, l.secret)
	m.Write([]byte("live\x00" + k))
	h := base64.RawURLEncoding.EncodeToString(m.Sum(nil)[:6])
	l.hashes.Store(k, h)
	return h
}

// HashDeps is a page's keys, hashed, for its page data.
func (l *Live) HashDeps(d Deps) []string {
	out := make([]string, 0, len(d))
	for k := range d {
		out = append(out, l.Hash(k))
	}
	return out
}

// ---- what a query's SQL reads, worked out once per SQL text

type readKey struct {
	table string
	col   string   // "" for the whole table
	arg   int      // which ? holds the value
	cols  []string // a whole-table read: the columns it looks at (none: any)
}

var whereCache sync.Map // entity + "\x00" + where -> []readKey

func whereKeys(table, where string) []readKey {
	ck := table + "\x00" + where
	if v, ok := whereCache.Load(ck); ok {
		return v.([]readKey)
	}
	keys := parseWhere(table, where)
	whereCache.Store(ck, keys)
	return keys
}

// parseWhere reads the query `SELECT … FROM table t0 WHERE <where>`. For t0 and for every
// table a subquery reads (FROM "X" tN), it finds what constrains the rows that matter:
//   - an equality `tN."col" = ?` (or IS ?, or tN.id = ?) joined to that query's conditions
//     by AND only, through any grouping parentheses: col=v;
//   - `tN.id IN (SELECT value FROM json_each(?))`: those rows, by id;
//   - a lookup of one column compared with a parameter, `(SELECT "col" FROM "X" x WHERE
//     x.id = …) IS ?`: col=v;
//   - a lookup of the same row (`x.id = t0.id` on t0's table) reads nothing more.
// A table with none of these is read whole.
func parseWhere(table, where string) []readKey {
	type group struct {
		parent *group
		or     bool
	}
	type cand struct {
		key readKey
		g   *group
	}
	type frame struct {
		alias, table string
		base         *group // the group the query's conditions are in
		cands        []cand
		col          string // a one-column lookup: its column
		lookup       *readKey
		self         bool
		cols         []string
	}
	root := &group{}
	frames := []*frame{{alias: "t0", table: table, base: root}}
	g := root
	arg := 0
	src := where
	byAlias := func(alias string) *frame {
		for i := len(frames) - 1; i >= 0; i-- {
			if frames[i].alias == alias {
				return frames[i]
			}
		}
		return nil
	}
	for i := 0; i < len(src); i++ {
		ch := src[i]
		switch {
		case ch == '\'':
			for i++; i < len(src); i++ {
				if src[i] == '\'' {
					if i+1 < len(src) && src[i+1] == '\'' {
						i++
						continue
					}
					break
				}
			}
		case ch == '(':
			g = &group{parent: g}
		case ch == ')':
			// a one-column lookup's group closing, compared with a parameter
			for _, f := range frames {
				if f.base == g && f.col != "" && (strings.HasPrefix(src[i+1:], " IS ?") || strings.HasPrefix(src[i+1:], " = ?")) {
					f.lookup = &readKey{table: f.table, col: f.col, arg: arg}
				}
			}
			if g.parent != nil {
				g = g.parent
			}
		case ch == '?':
			arg++
		case strings.HasPrefix(src[i:], "FROM \""):
			j := strings.IndexByte(src[i+6:], '"')
			if j < 0 {
				break
			}
			name := src[i+6 : i+6+j]
			rest := strings.TrimLeft(src[i+6+j+1:], " ")
			alias := rest
			if k := strings.IndexAny(rest, " )"); k >= 0 {
				alias = rest[:k]
			}
			f := &frame{alias: alias, table: name, base: g}
			// SELECT "col" FROM: a one-column lookup
			if k := strings.LastIndex(src[:i], "(SELECT \""); k >= 0 && strings.HasSuffix(src[:i], "\" ") {
				if c := src[k+9 : i-2]; !strings.ContainsAny(c, "\" (),") {
					f.col = c
				}
			}
			frames = append(frames, f)
			i += 6 + j
		case strings.HasPrefix(src[i:], " OR "):
			g.or = true
			i += 3
		case isWordStart(src, i):
			// alias."col" = ? / IS ?, alias.id = ?, alias.id IN (… json_each(?)), x.id = t0.id
			j := i
			for j < len(src) && (src[j] == '_' || src[j] >= 'a' && src[j] <= 'z' || src[j] >= 'A' && src[j] <= 'Z' || src[j] >= '0' && src[j] <= '9') {
				j++
			}
			alias := src[i:j]
			var col string
			end := j
			switch {
			case strings.HasPrefix(src[j:], ".\""):
				k := strings.IndexByte(src[j+2:], '"')
				if k < 0 {
					i = j - 1
					continue
				}
				col, end = src[j+2:j+2+k], j+2+k+1
			case strings.HasPrefix(src[j:], ".id") && (j+3 == len(src) || !isWord(src[j+3])):
				col, end = "id", j+3
			case metaCol(src[j:]) != "":
				col = metaCol(src[j:])
				end = j + 1 + len(col)
			default:
				i = j - 1
				continue
			}
			f := byAlias(alias)
			if f != nil && !contains(f.cols, col) {
				f.cols = append(f.cols, col)
			}
			after := src[end:]
			switch {
			case f == nil:
			case strings.HasPrefix(after, " = ?") || strings.HasPrefix(after, " IS ?"):
				f.cands = append(f.cands, cand{readKey{table: f.table, col: col, arg: arg}, g})
			case col == "id" && strings.HasPrefix(after, " IN (SELECT value FROM json_each(?))"):
				f.cands = append(f.cands, cand{readKey{table: f.table, col: "id[]", arg: arg}, g})
			case col == "id" && (strings.HasPrefix(after, " = ") || strings.HasPrefix(after, " IS ")):
				// x.id = t0.id: the same row as an outer query's
				rhs := strings.TrimPrefix(strings.TrimPrefix(after, " = "), " IS ")
				if k := strings.Index(rhs, ".id"); k > 0 && (k+3 == len(rhs) || !isWord(rhs[k+3])) {
					if o := byAlias(rhs[:k]); o != nil && o != f && o.table == f.table && !strings.ContainsAny(rhs[:k], " ()") {
						f.self = true
						if f.col != "" && !contains(o.cols, f.col) {
							o.cols = append(o.cols, f.col) // a column of the outer row
						}
					}
				}
			}
			i = end - 1
		}
	}
	out := []readKey{}
	for _, f := range frames {
		if f.self {
			continue
		}
		if f.lookup != nil {
			out = append(out, *f.lookup)
			continue
		}
		var found *readKey
		for _, c := range f.cands {
			ok := true
			for x := c.g; ; x = x.parent {
				if x.or {
					ok = false
					break
				}
				if x == f.base || x.parent == nil {
					break
				}
			}
			if ok {
				k := c.key
				found = &k
				break
			}
		}
		if found == nil {
			// the whole table, as far as the columns it looks at; with no conditions at all (t0, or
			// a lookup's own), any column
			cols := f.cols
			if f == frames[0] && where == "" || f.col != "" {
				cols = nil
			}
			if f.col != "" {
				cols = append(append([]string{}, f.cols...), f.col)
			}
			out = append(out, readKey{table: f.table, cols: cols})
		} else {
			out = append(out, *found)
		}
	}
	return out
}

// metaCol is a row's own column named unquoted after an alias: .seq, .created, .updated.
func metaCol(s string) string {
	for _, c := range []string{"seq", "created", "updated"} {
		if strings.HasPrefix(s, "."+c) && (len(s) == len(c)+1 || !isWord(s[len(c)+1])) {
			return c
		}
	}
	return ""
}

func isWordStart(s string, i int) bool {
	c := s[i]
	if !(c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
		return false
	}
	return i == 0 || !isWord(s[i-1])
}

func isWord(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '"' || c == '.'
}

// PlainSince is the keys of the commits after v, as they are (the test endpoints).
func (l *Live) PlainSince(v int64) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []string{}
	for _, c := range l.commits {
		if c.v > v {
			out = append(out, c.plain...)
		}
	}
	return out
}

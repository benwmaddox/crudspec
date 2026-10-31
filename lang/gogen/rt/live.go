package rt

import (
	"hash/maphash"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// Live pages refresh only when a commit changed something they read.
//
// While a page renders, its session records what it reads as keys: "E" for a whole table,
// "E:col" for a whole table as far as one column goes, "E#id" for a row ("E#id@t" for its
// time), "E.col=v" for the rows whose column holds v (a query's equality on a parameter, at the
// top of its conditions or of a subquery's), and "E!any" beside each of those (see below). A
// commit publishes the keys of every row it created, changed or deleted: "E", "E#id",
// "E#id@t", "E:col" for each column it changed, and "E.col=v" for each column's old and new
// value; or "E!any" when it can't say which values a row had. A touch publishes only the row's
// time. A page refreshes when the two meet.
//
// Keys travel hashed with the app's secret, so the stream tells a page nothing about rows it
// didn't read.

// LK is a key, as a struct, so recording one builds no string.
type LK struct {
	K        byte // 't' table, ':' column, 'r' row, '@' row time, '=' value, '!' any
	E        string
	Col, Val string
	ID       int64
}

func (k LK) String() string {
	switch k.K {
	case 't':
		return k.E
	case ':':
		return k.E + ":" + k.Col
	case 'r':
		return k.E + "#" + strconv.FormatInt(k.ID, 10)
	case '@':
		return k.E + "#" + strconv.FormatInt(k.ID, 10) + "@t"
	case '=':
		if k.Val == numMark {
			return k.E + "." + k.Col + "=" + strconv.FormatInt(k.ID, 10)
		}
		return k.E + "." + k.Col + "=" + k.Val
	}
	return k.E + "!any"
}

func tableKey(e string) LK             { return LK{K: 't', E: e} }
func colKey(e, col string) LK          { return LK{K: ':', E: e, Col: col} }
func rowLK(e string, id int64) LK      { return LK{K: 'r', E: e, ID: id} }
func timeKey(e string, id int64) LK    { return LK{K: '@', E: e, ID: id} }
func valKey(e, col string, v any) LK   { return ValLK(e, col, kvOf(v)) }

// KV is a value in a key: a number as itself (S is numMark, the number N), anything else as
// text (S; none is "~"). A number is never made into text to be a key, only to be shown
// (String); the reader's and the writer's keys of the same value are the same either way.
type KV struct {
	S string
	N int64
}

const numMark = "\x00#"

var KNone = KV{S: "~"}

// ValLK is the key of rows of e whose col holds k
func ValLK(e, col string, k KV) LK { return LK{K: '=', E: e, Col: col, Val: k.S, ID: k.N} }

// kvOf is a stored or given value as a key's value
func kvOf(v any) KV {
	switch x := v.(type) {
	case nil:
		return KNone
	case string:
		return KV{S: x}
	case []byte:
		return KV{S: string(x)}
	case int64:
		return KV{S: numMark, N: x}
	case int:
		return KV{S: numMark, N: int64(x)}
	case bool:
		return KBool(x)
	}
	return KV{S: fmt.Sprint(v)}
}
func anyKey(e string) LK               { return LK{K: '!', E: e} }

// Deps is a set of keys, each under its 64-bit hash (worked out once, when it is added): adding,
// merging and looking up are by an integer, not a struct of strings. Two keys with the same hash
// would only refresh a page or drop a cache entry that needn't be.
type Deps map[uint64]LK

var lkSeed = maphash.MakeSeed()

// Key is k's hash, its place in a Deps.
func (k LK) Key() uint64 { return maphash.Comparable(lkSeed, k) }

func (d Deps) Add(k LK) { d[k.Key()] = k }

// IDs is a set of keys by their places only (what a fragment read, for the cache's index and the
// fragments around it): eight bytes a key.
type IDs map[uint64]struct{}

// Merge adds o's keys to d.
func (d Deps) Merge(o Deps) {
	for id, k := range o {
		d[id] = k
	}
}
func (d IDs) Merge(o IDs) {
	for id := range o {
		d[id] = struct{}{}
	}
}

// tracing what pages read (CRUDSPEC_LIVE_TRACE, CRUDSPEC_LIVE_TRACE_KEY), read once
var liveTrace, liveTraceKey = os.Getenv("CRUDSPEC_LIVE_TRACE") != "", os.Getenv("CRUDSPEC_LIVE_TRACE_KEY")

func (s *Sess) read(k LK) {
	if s.Reads == nil {
		return
	}
	// the key just recorded, again (a button per message asks the same question): already there
	// (forgotten when the reads start going elsewhere: a fragment begins or ends, a capture)
	if s.lastOK && k == s.last {
		return
	}
	s.last, s.lastOK = k, true
	s.readID(k.Key(), k)
}

// readID records k, whose place (Key) is id.
func (s *Sess) readID(id uint64, k LK) {
	if s.PageReads != nil {
		s.PageReads[id] = struct{}{}
	}
	if s.AllReads != nil {
		s.AllReads[id] = k
	}
	if s.capture != nil {
		s.capture[id] = k
	}
	if liveTraceKey != "" && liveTraceKey == k.String() {
		fmt.Fprintf(os.Stderr, "live: read %s at %s\n%s\n", k, SpecWhere(), debug.Stack())
	}
	if n := len(s.frags); n > 0 { // the innermost fragment's own and all (EndFrag adds its all to the one around it)
		f := s.frags[n-1]
		f.own[id] = k
		f.all[id] = struct{}{}
		if f.allK != nil {
			f.allK[id] = k
		}
		return
	}
	s.Reads[id] = k
}

// readWhere records what a query over e reads: its equalities, or the whole table.
func (s *Sess) readWhere(e *Entity, where string, args []any) {
	if s.Reads == nil || !e.Stored {
		return
	}
	for _, r := range whereKeys(e.Name, where) {
		if r.col == "" {
			if liveTrace {
				fmt.Fprintf(os.Stderr, "live: whole %s %v from %s: %s\n", r.table, r.cols, e.Name, where)
			}
			if len(r.cols) == 0 {
				s.read(tableKey(r.table))
			}
			for _, c := range r.cols {
				s.read(colKey(r.table, strings.TrimSuffix(c, "__seq"))) // a time's order column is its field
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
				s.read(rowLK(r.table, id))
			}
			continue
		}
		if r.col == "id" {
			id, _ := strconv.ParseInt(keyVal(v), 10, 64)
			s.read(rowLK(r.table, id))
		} else {
			s.read(valKey(r.table, r.col, v))
		}
		s.read(anyKey(r.table))
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
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
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
		s.read(rowLK(e.Name, r.ID))
		if byTime {
			s.read(timeKey(e.Name, r.ID))
		}
	}
}

// touched records a write that changed only a row's time.
func (s *Sess) touched(e *Entity, id int64) {
	if s.wkeys == nil {
		s.wkeys = Deps{}
	}
	s.wkeys.Add(timeKey(e.Name, id))
	s.wkeys.Add(colKey(e.Name, "updated"))
}

// readTime records that something looked at a row's time (its updated), which a touch changes.
func (s *Sess) readTime(e string, id int64) {
	if s != nil && s.Reads != nil {
		s.read(timeKey(e, id))
	}
}

// ---- writes

// wrote records the keys of a row as it was (old: its encoded columns, or nil) and as it is
// now (now: the same, or nil for a delete).
func (s *Sess) wrote(e *Entity, id int64, old, now []any) {
	if s.wkeys == nil {
		s.wkeys = Deps{}
	}
	s.wkeys.Add(tableKey(e.Name))
	s.wkeys.Add(rowLK(e.Name, id))
	s.wkeys.Add(timeKey(e.Name, id))
	// the columns it changed: all, for a row made or deleted (or one whose old values aren't known)
	for i, f := range e.Fields {
		if old == nil || now == nil || i >= len(old) || i >= len(now) || keyVal(old[i]) != keyVal(now[i]) {
			s.wkeys.Add(colKey(e.Name, f.Name))
		}
	}
	s.wkeys.Add(colKey(e.Name, "id"))
	s.wkeys.Add(colKey(e.Name, "updated"))
	if old == nil || now == nil {
		s.wkeys.Add(colKey(e.Name, "seq"))
		s.wkeys.Add(colKey(e.Name, "created"))
	}
	if old == nil && now == nil {
		s.wkeys.Add(anyKey(e.Name))
		return
	}
	for _, vals := range [][]any{old, now} {
		for i, v := range vals {
			if i < len(e.Fields) && keyable(v) {
				s.wkeys.Add(valKey(e.Name, e.Fields[i].Name, v))
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
	// the version moves and the cache drops what the commit changed together, under the cache's
	// lock: no render keeps or is given an entry from before it after it
	s.DB.Cache.mu.Lock()
	s.DB.Live.publish(&s.DB.Version, keys)
	s.DB.Cache.invalidateLocked(keys)
	s.DB.Pages.drop(keys)
	s.DB.Cache.mu.Unlock()
	s.DB.IDs.Changed(keys)
}

// ---- the commits live pages are told of

type commit struct {
	v     int64
	keys  []string // hashed
	plain []string // the same, as they are (the test endpoints show them)
	all   bool     // what changed isn't known: every page refreshes
}

type Live struct {
	mu      sync.Mutex
	byID    sync.Map // a key's hash (Deps' place) -> its Hash
	commits []commit // the most recent, oldest first
	secret  []byte
	hashes  sync.Map // LK -> hashed
	// how many keys were hashed since the two maps were last emptied (neither holds more): past
	// liveHashMax they start again empty, so a server that runs for months doesn't keep every
	// row it ever showed (a hash is cheap to make again)
	nHashed atomic.Int64
}

const liveHashMax = 1 << 17

const liveHistory = 512

func (l *Live) publish(version interface{ Add(int64) int64 }, keys Deps) {
	hashed, plain := make([]string, 0, len(keys)), make([]string, 0, len(keys))
	for id, k := range keys {
		hashed = append(hashed, l.hashOf(id, k))
		plain = append(plain, k.String())
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
func (l *Live) Hash(k LK) string {
	if h, ok := l.hashes.Load(k); ok {
		return h.(string)
	}
	m := hmac.New(sha256.New, l.secret)
	m.Write([]byte("live\x00" + k.String()))
	h := base64.RawURLEncoding.EncodeToString(m.Sum(nil)[:6])
	l.remember()
	l.hashes.Store(k, h)
	return h
}

// remember counts a key about to be kept, and empties both maps when they hold too many.
func (l *Live) remember() {
	if l.nHashed.Add(1) > liveHashMax {
		l.nHashed.Store(0)
		l.hashes.Clear()
		l.byID.Clear()
	}
}

// hashOf is Hash, found by the key's place in a Deps
func (l *Live) hashOf(id uint64, k LK) string {
	if h, ok := l.byID.Load(id); ok {
		return h.(string)
	}
	h := l.Hash(k) // (counted there: byID gets a key only after Hash, since both were last emptied)
	l.byID.Store(id, h)
	return h
}

// HashString is Hash of a key given as text (the test endpoints).
func (l *Live) HashString(k string) string {
	m := hmac.New(sha256.New, l.secret)
	m.Write([]byte("live\x00" + k))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil)[:6])
}

// HashDeps is a page's keys, hashed, for its page data.
func (l *Live) HashDeps(d Deps) []string {
	out := make([]string, 0, len(d))
	for id, k := range d {
		out = append(out, l.hashOf(id, k))
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

var whereCache sync.Map // whereKey -> []readKey

type whereKey struct{ table, where string }

func whereKeys(table, where string) []readKey {
	ck := whereKey{table, where}
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
		or     bool // an OR at its level
		neg    bool // it follows NOT
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
			// a group under NOT doesn't constrain the query: its equalities are negated
			g = &group{parent: g, neg: negated(src, i)}
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
				// an OR, or a NOT between the equality and its query (a subquery under NOT reads the same rows)
				if x.or || (x.neg && x != f.base) {
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

// negated is whether the parenthesis at i follows NOT.
func negated(src string, i int) bool {
	j := i
	for j > 0 && src[j-1] == ' ' {
		j--
	}
	return j >= 3 && strings.EqualFold(src[j-3:j], "NOT") && (j == 3 || !isWord(src[j-4]))
}

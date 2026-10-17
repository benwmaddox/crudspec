package rt

import (
	"net/url"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"hash"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/scrypt"
)

// An Outcome ends an action: ok, or a refusal the spec names (invalid, forbidden, …).
type Outcome struct {
	O, Msg, Cause string
}

func (o *Outcome) Error() string { return o.O + ": " + o.Msg }
func Refuse(o, msg, cause string) { panic(&Outcome{O: o, Msg: msg, Cause: cause}) }

type Request struct {
	IP, Method, Identity, UserAgent, SessionToken, Text string
	Base                                                string // scheme and host, for absolute URLs
	Now                                                 int64  // the clock, fixed for a request as the interpreter fixes it
	Cookies                                             map[string]string
}

type Event struct {
	Name string
	Args []Val
}

// Ctx is the context an expression or statement runs in, as the interpreter's Ctx.
type Ctx struct {
	App        *App
	S          *Sess
	Vars       map[string]Val
	Actor      Val
	Req        *Request
	Row        *Row
	RowE       *Entity
	Events     *[]Event
	Result     *Val
	InWorkflow bool
	Amb        map[string]Val // the ambient values screens see
	Externs    map[string]func([]Val) Val
	NoTriggers bool
}

func (c *Ctx) Child() *Ctx {
	n := *c
	res := *c.Result
	n.Result = &res
	n.Vars = make(map[string]Val, len(c.Vars)+2)
	for k, v := range c.Vars {
		n.Vars[k] = v
	}
	return &n
}
func (c *Ctx) Fresh() *Ctx {
	n := *c
	res := *c.Result
	n.Result = &res
	n.Vars = map[string]Val{}
	n.Row, n.RowE = nil, nil
	return &n
}

// NoRow is the context without its row (a function body, a value outside a where)
func (c *Ctx) NoRow() *Ctx {
	if c.Row == nil {
		return c
	}
	n := *c
	n.Row, n.RowE = nil, nil
	return &n
}
func (c *Ctx) OnRow(e *Entity, r *Row) *Ctx { n := *c; n.Row, n.RowE = r, e; return &n }
func (c *Ctx) Now() int64 {
	if c.S != nil { // a fragment that reads the clock isn't kept in the cache
		for _, f := range c.S.frags {
			f.clock = true
		}
	}
	if c.Req != nil && c.Req.Now != 0 {
		return c.Req.Now
	}
	return c.App.Clock()
}

func (c *Ctx) Var(name string) Val {
	v, ok := c.Vars[name]
	if !ok {
		if a, ok := c.Amb[name]; ok {
			return a
		}
		return nil
	}
	return c.Resolve(v)
}
func (c *Ctx) Has(name string) bool {
	if _, ok := c.Vars[name]; ok {
		return true
	}
	_, ok := c.Amb[name]
	return ok
}

func (c *Ctx) Resolve(v Val) Val {
	switch l := v.(type) {
	case Lazy:
		if l.E == "" { // an enum value
			return v
		}
		if l.Null {
			if l.Optional {
				return nil
			}
			Refuse("not_found", "missing "+l.E, "param")
		}
		if c.S.Find(c.App.Ents[l.E], l.ID) == nil {
			Refuse("not_found", fmt.Sprintf("%s %d does not exist", l.E, l.ID), "param")
		}
		return Ref{E: l.E, ID: l.ID}
	case LazyEnum:
		for _, x := range c.App.Enums[l.Enum] {
			if x == l.Value {
				return l.Value
			}
		}
		Refuse("invalid", fmt.Sprintf("'%s' is not a %s", l.Value, l.Enum), "param")
	}
	return v
}

type LazyEnum struct{ Enum, Value string }

func (c *Ctx) It() Val {
	if c.Row == nil {
		panic(fmt.Errorf("'it' outside a where"))
	}
	return Ref{E: c.RowE.Name, ID: c.Row.ID}
}
func (c *Ctx) RowField(name string) Val {
	if c.Row == nil {
		panic(fmt.Errorf(".%s outside a where", name))
	}
	return RowField(c.RowE, c.Row, name)
}

func RowField(e *Entity, r *Row, name string) Val {
	switch name {
	case "id":
		return r.ID
	case "created":
		return Time{r.Created, r.Seq}
	case "updated":
		return Time{r.Updated, r.Seq}
	}
	if i, ok := e.Index[name]; ok {
		return r.Get(i)
	}
	return nil
}

// Field is `x.name`: a row's field (read from the store), or a value's.
func (c *Ctx) Field(t Val, name string) Val {
	switch x := t.(type) {
	case nil:
		return nil
	case Singleton:
		r := c.S.First(c.App.Ents[x.E])
		if r == nil {
			return nil
		}
		return RowField(c.App.Ents[x.E], r, name)
	case Ref:
		e := c.App.Ents[x.E]
		if e == nil {
			return nil
		}
		r := c.S.Find(e, x.ID)
		if r == nil {
			Refuse("not_found", fmt.Sprintf("%s %d was deleted", x.E, x.ID), "missing")
		}
		return RowField(e, r, name)
	}
	return ValueField(t, name)
}

// RowOf is the row a reference or singleton points at, or nil.
func (c *Ctx) RowOf(t Val) (*Entity, *Row) {
	switch x := t.(type) {
	case Singleton:
		e := c.App.Ents[x.E]
		return e, c.S.First(e)
	case Ref:
		e := c.App.Ents[x.E]
		if e == nil {
			return nil, nil
		}
		return e, c.S.Find(e, x.ID)
	}
	return nil, nil
}

// ---- the app's declarations, generated

type Action struct {
	Name     string
	Skips    []string
	Bind     func(raw map[string]Val, s *Sess) map[string]Val // generated, by parameter type
	Form     func(sv *Server, r *HTTPReq) map[string]Val    // the arguments a form posts
	Internal bool
	Body     func(c *Ctx)
	Guards   func(c *Ctx) (string, string) // the leading lets and requires
}
type View struct {
	Name     string
	Bind     func(raw map[string]Val, s *Sess) map[string]Val
	Query    func(q url.Values) map[string]Val // arguments from /_view's query
	Entity   string
	Rows     func(c *Ctx) []*Row
	Value    func(c *Ctx) Val
	Requires func(c *Ctx) string // the outcome of the first require that fails, or ""
	Extern   bool              // a value view that reads from outside
}
type Gate struct {
	Name, Outcome string
	Cond          func(c *Ctx) bool
}

type App struct {
	Name        string
	ActorEntity string
	Ents        map[string]*Entity
	Enums       map[string][]string
	Actions     map[string]*Action
	Views       map[string]*View
	Fns         map[string]func(c *Ctx, args []Val) Val
	FnArity     map[string]int
	Gates       []Gate
	Workflows   map[string][]func(c *Ctx, arg Val)
	Secret      []byte
	DB          *DB

	clockMu     sync.Mutex
	offset      int64
	frozen      *int64
	FixedTokens atomic.Int64

	macs     sync.Pool // HMAC hashers, reused
	countMu  sync.Mutex
	Counters map[string][]int64

	Invariants  func(c *Ctx, log []Change) // generated: the invariants of the rows an action touched
	Migrate     *Migrate                  // generated: what an upgrade runs (migrate.go)
	EntityOrder []string // the spec's order, which deletes and invariants follow
	ScreenURLs  map[string]func(args List, named map[string]Val) string // each screen's link, generated
	URLsOf      map[string]func(base string, args List) string         // url_of(screen or API route)
	FilesDir    string
}


func (a *App) Clock() int64 {
	a.clockMu.Lock()
	defer a.clockMu.Unlock()
	if a.frozen != nil {
		return *a.frozen
	}
	return time.Now().UnixMilli() + a.offset
}
func (a *App) SetClock(t int64) {
	a.clockMu.Lock()
	defer a.clockMu.Unlock()
	a.offset = t - time.Now().UnixMilli()
	a.frozen = nil
}
func (a *App) Freeze(t int64) { a.clockMu.Lock(); a.frozen = &t; a.clockMu.Unlock() }
func (a *App) Advance(ms int64) {
	a.clockMu.Lock()
	defer a.clockMu.Unlock()
	a.offset += ms
	if a.frozen != nil {
		f := *a.frozen + ms
		a.frozen = &f
	}
}

// ---- binding a call's raw arguments (form values, JSON, ids) to its parameters: each
// action's and view's Bind is generated, from these, by parameter type

func BindSet(s *Sess, e *Entity, v Val) Val {
	ids := []int64{}
	if l, ok := v.(List); ok {
		for _, x := range l {
			ids = append(ids, Num(x))
		}
	} else if st, ok := v.(Set); ok {
		ids = st.IDs
	}
	kept := []int64{}
	for _, id := range ids { // unknown set members are dropped
		if s.Find(e, id) != nil {
			kept = append(kept, id)
		}
	}
	return Set{E: e.Name, IDs: kept}
}
func BindRef(entity string, optional bool, v Val, present bool) Val {
	if v == nil || !present {
		return Lazy{E: entity, Null: true, Optional: optional}
	}
	id := Num(v)
	if r, ok := v.(Ref); ok {
		id = r.ID
	}
	return Lazy{E: entity, ID: id, Optional: optional}
}
func BindEnum(enum string, v Val) Val {
	if v == nil {
		return nil
	}
	return LazyEnum{Enum: enum, Value: Plain(v)}
}
func BindRich(v Val) Val {
	if s, ok := v.(string); ok {
		return Rich{Text: s, Mentions: []int64{}}
	}
	return v
}
func BindInt(v Val) Val {
	if v != nil {
		return Num(v)
	}
	return v
}
func Raw(raw map[string]Val, name string) (Val, bool) { v, ok := raw[name]; return v, ok }

type Result struct {
	Outcome, Detail, Cause string
	Result                 Val
	Rows                   []Ref
	Events                 []Event
}

func (a *App) ctx(s *Sess, vars map[string]Val, actor Val, req *Request) *Ctx {
	ev := []Event{}
	var res Val
	return &Ctx{App: a, S: s, Vars: vars, Actor: actor, Req: req, Events: &ev, Result: &res}
}

func (a *App) gates(c *Ctx, skips []string) {
	for _, g := range a.Gates {
		skip := false
		for _, s := range skips {
			if s == g.Name {
				skip = true
			}
		}
		if !skip && g.Cond(c) {
			Refuse(g.Outcome, "gate "+g.Name, "gate")
		}
	}
}

// Run is the interpreter's run(): an action in a transaction, or a view.
func (a *App) Run(s *Sess, name string, raw map[string]Val, actor Val, req *Request, skipGates []string) (res Result) {
	act, view := a.Actions[name], a.Views[name]
	if act == nil && view == nil {
		panic(fmt.Errorf("unknown action %s", name))
	}
	skips := append([]string{}, skipGates...)
	if act != nil {
		skips = append(skips, act.Skips...)
	}
	c := a.ctx(s, nil, actor, req)
	began := false
	defer func() {
		if r := recover(); r != nil {
			if began {
				s.Rollback()
			}
			if o, ok := r.(*Outcome); ok {
				res = Result{Outcome: o.O, Detail: o.Msg, Cause: o.Cause}
				return
			}
			panic(r)
		}
	}()
	if act != nil {
		s.Begin()
		began = true
	}
	if act != nil {
		c.Vars = act.Bind(raw, s)
	} else {
		c.Vars = view.Bind(raw, s)
	}
	a.gates(c, skips)
	if act != nil {
		mark := len(s.Log)
		act.Body(c)
		if a.Invariants != nil {
			a.Invariants(c, s.Log[mark:])
		}
		s.Commit()
		began = false
		return Result{Outcome: "ok", Result: *c.Result, Events: *c.Events}
	}
	if view.Requires != nil {
		if o := view.Requires(c); o != "" {
			Refuse(o, "require failed", "require")
		}
	}
	if view.Value != nil {
		return Result{Outcome: "ok", Result: view.Value(c)}
	}
	rows := view.Rows(c)
	refs := make([]Ref, len(rows))
	for i, r := range rows {
		refs[i] = Ref{E: view.Entity, ID: r.ID}
	}
	return Result{Outcome: "ok", Rows: refs}
}

// Guards is whether an action would get past its gates and leading requires, without running it.
func (a *App) Guards(s *Sess, name string, raw map[string]Val, actor Val, req *Request) (outcome, cause string) {
	act := a.Actions[name]
	c := a.ctx(s, nil, actor, req)
	defer func() {
		if r := recover(); r != nil {
			if o, ok := r.(*Outcome); ok {
				outcome, cause = o.O, o.Cause
				return
			}
			outcome, cause = "ok", "" // a guard that can't be evaluated here doesn't hide the button
		}
	}()
	c.Vars = act.Bind(raw, s)
	a.gates(c, act.Skips)
	if act.Guards != nil {
		return act.Guards(c)
	}
	return "ok", ""
}

// RateLimit counts a call against a key (an action's rate_limit statement).
func (c *Ctx) RateLimit(line int, by Val, n int64, perMS int64, outcome string) {
	a := c.App
	k := fmt.Sprintf("%d:%s", line, Plain(by))
	now := c.Now()
	a.countMu.Lock()
	hits := []int64{}
	for _, t := range a.Counters[k] {
		if t > now-perMS {
			hits = append(hits, t)
		}
	}
	hits = append(hits, now)
	a.Counters[k] = hits
	a.countMu.Unlock()
	if int64(len(hits)) > n {
		Refuse(outcome, "rate limited", "require")
	}
}

// ---- hooks: tokens, signed links, passwords

const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func (a *App) Token(n int) string {
	if f := a.FixedTokens.Load(); f > 0 { // test fixtures: deterministic tokens
		a.FixedTokens.Add(1)
		s := fmt.Sprintf("fx%0*d", max(1, n-2), f)
		if len(s) > max(n, 4) {
			s = s[:max(n, 4)]
		}
		return s
	}
	b := make([]byte, n)
	rand.Read(b)
	out := make([]byte, n)
	for i, x := range b {
		out[i] = alnum[int(x)%len(alnum)]
	}
	return string(out)
}

func (a *App) mac(body string) string {
	m, _ := a.macs.Get().(hash.Hash)
	if m == nil {
		m = hmac.New(sha256.New, a.Secret)
	}
	m.Reset()
	m.Write([]byte(body))
	var sum [sha256.Size]byte
	out := base64.RawURLEncoding.EncodeToString(m.Sum(sum[:0]))
	a.macs.Put(m)
	return out
}
func (a *App) Mac(body string) string { return a.mac(body) }
func (a *App) Sign(r Ref, purpose string, expiresAt int64) string {
	body := fmt.Sprintf("%s.%s.%d.%d", purpose, r.E, r.ID, expiresAt)
	return base64.RawURLEncoding.EncodeToString([]byte(body)) + "." + a.mac(body)
}
func (a *App) Unsign(text string) (purpose, ref string, id, exp int64, ok bool) {
	parts := strings.SplitN(text, ".", 2)
	if len(parts) != 2 {
		return
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return
	}
	body := string(b)
	if subtle.ConstantTimeCompare([]byte(a.mac(body)), []byte(parts[1])) != 1 {
		return
	}
	f := strings.Split(body, ".")
	if len(f) != 4 {
		return
	}
	id, _ = strconv.ParseInt(f[2], 10, 64)
	exp, _ = strconv.ParseInt(f[3], 10, 64)
	return f[0], f[1], id, exp, true
}

// scrypt, as the TypeScript runtime stores it: {"scrypt": "<hex salt>:<hex key>"}, N=16384 r=8 p=1
func Hash(pw string) Val {
	salt := make([]byte, 16)
	rand.Read(salt)
	hs := hex.EncodeToString(salt)
	k, _ := scrypt.Key([]byte(pw), []byte(hs), 16384, 8, 1, 32)
	return Obj{"scrypt": hs + ":" + hex.EncodeToString(k)}
}
func CheckPassword(stored Val, given string) bool {
	o, ok := stored.(Obj)
	if !ok {
		return false
	}
	s, _ := o["scrypt"].(string)
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return false
	}
	want, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}
	k, _ := scrypt.Key([]byte(given), []byte(parts[0]), 16384, 8, 1, 32)
	return subtle.ConstantTimeCompare(k, want) == 1
}

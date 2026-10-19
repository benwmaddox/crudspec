package rt

import (
	"fmt"
	"strconv"
	"strings"
)

// Small helpers the generated code calls, so it stays short.

func Not(v Val) Val { return !Truthy(v) }
func B01(b bool) any {
	if b {
		return int64(1)
	}
	return int64(0)
}
func DurMS(v Val) int64 {
	if d, ok := v.(Dur); ok {
		return d.MS
	}
	return 0
}

// time ordering parameters, as the planner's: (is it a time?, its time, its seq)
func TimeNull(v Val) any {
	if _, ok := v.(Time); ok {
		return int64(0)
	}
	return nil
}
func TimeT(v Val) any {
	if t, ok := v.(Time); ok {
		return t.T
	}
	return nil
}
func TimeSeq(v Val) any {
	if t, ok := v.(Time); ok {
		return t.Seq
	}
	return int64(0)
}

func (c *Ctx) Res() Val { return *c.Result }
func (c *Ctx) SetResult(v Val) { *c.Result = v }

func (c *Ctx) ReqObj() Val {
	r := c.Req
	o := Obj{"ip": r.IP, "method": r.Method, "identity": r.Identity}
	if r.UserAgent != "" {
		o["user_agent"] = r.UserAgent
	}
	if r.SessionToken != "" {
		o["session_token"] = r.SessionToken
	}
	if r.Text != "" {
		o["text"] = r.Text
	}
	if r.Cookies != nil {
		cs := Obj{}
		for k, v := range r.Cookies {
			cs[k] = v
		}
		o["cookies"] = cs
	}
	return o
}

func (c *Ctx) ReqField(name string) Val {
	r := c.Req
	switch name {
	case "ip":
		return r.IP
	case "method":
		return r.Method
	case "identity":
		return r.Identity
	case "user_agent":
		if r.UserAgent == "" {
			return nil
		}
		return r.UserAgent
	case "session_token":
		if r.SessionToken == "" {
			return nil
		}
		return r.SessionToken
	case "text":
		if r.Text == "" {
			return nil
		}
		return r.Text
	}
	return ValueField(c.ReqObj(), name)
}

func (c *Ctx) The(e *Entity, rows []*Row) Val {
	if len(rows) != 1 {
		Refuse("invalid", fmt.Sprintf("the(%s …) matched %d rows", e.Name, len(rows)), "the")
	}
	return Ref{E: e.Name, ID: rows[0].ID}
}
func TheOrNone(e *Entity, rows []*Row) Val {
	if len(rows) == 1 {
		return Ref{E: e.Name, ID: rows[0].ID}
	}
	return nil
}
func FirstOrNone(e *Entity, rows []*Row) Val {
	if len(rows) > 0 {
		return Ref{E: e.Name, ID: rows[0].ID}
	}
	return nil
}

func (c *Ctx) MapRows(e *Entity, rows []*Row, f func(c *Ctx) Val) Val {
	out := make(List, len(rows))
	for i, r := range rows {
		out[i] = f(c.OnRow(e, r))
	}
	return out
}
func (c *Ctx) AllRows(e *Entity, rows []*Row, f func(c *Ctx) bool) bool {
	for _, r := range rows {
		if !f(c.OnRow(e, r)) {
			return false
		}
	}
	return true
}

func (c *Ctx) Exists(r Ref) bool {
	e := c.App.Ents[r.E]
	return e != nil && c.S.Find(e, r.ID) != nil
}

// for each x in E where …: the rows are chosen first; a row deleted meanwhile is skipped
func (c *Ctx) ForEach(e *Entity, rows []*Row, bind string, body func(c *Ctx)) {
	refs := RefsOf(e, rows)
	for _, ref := range refs {
		r := ref.(Ref)
		if !c.Exists(r) {
			continue
		}
		cc := c.Child()
		cc.Row, cc.RowE = nil, nil
		cc.Vars[bind] = r
		body(cc)
	}
}

func (c *Ctx) ForList(over Val, bind string, body func(c *Ctx)) {
	var items []Val
	switch x := over.(type) {
	case Set:
		for _, id := range x.IDs {
			items = append(items, Ref{E: x.E, ID: id})
		}
	case List:
		items = x
	}
	for _, x := range items {
		cc := c.Child()
		cc.Row, cc.RowE = nil, nil
		cc.Vars[bind] = x
		body(cc)
	}
}

func (c *Ctx) DeleteRows(e *Entity, rows []*Row) {
	for _, r := range rows {
		ref := Ref{E: e.Name, ID: r.ID}
		if c.Exists(ref) {
			c.Delete(ref)
		}
	}
}

// a trigger's context: only its bindings, no row
func (c *Ctx) Trigger(bind string, subject, old Val, kind string) *Ctx {
	t := c.Fresh()
	t.Vars[bind] = subject
	if old != nil {
		t.Vars["old"] = old
		if kind == "delete" {
			t.Vars[bind] = old
		}
	}
	return t
}

func Filter(rows []*Row, keep func(r *Row) bool) []*Row {
	out := rows[:0:0]
	for _, r := range rows {
		if keep(r) {
			out = append(out, r)
		}
	}
	return out
}

func (c *Ctx) VarOr(name string, f func() Val) Val {
	if c.Has(name) {
		return c.Var(name)
	}
	return f()
}

func Arg(a []Val, i int) Val { return arg(a, i) }

// InitCtx is a context for values computed at start (reference data)
func (a *App) InitCtx() *Ctx {
	ev := []Event{}
	var res Val
	return &Ctx{App: a, Vars: map[string]Val{}, Req: &Request{Method: "get"}, Events: &ev, Result: &res}
}

func IfStr(b bool, a, z string) string {
	if b {
		return a
	}
	return z
}

// Memo is a value computed at most once, when first needed: a query's row-independent
// subexpressions, hoisted out of its per-row filter.
func Memo(f func() Val) func() Val {
	var v Val
	done := false
	return func() Val {
		if !done {
			v, done = f(), true
		}
		return v
	}
}

func StorePassword(v Val) Val {
	if s, ok := v.(string); ok {
		return Hash(s)
	}
	return v
}
func ParseID(s string) (int64, bool) {
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil
}
func JSString2(v Val) string    { return jsString(v) }
func FlashCookie(m string) string { return flashCookie(m) }

// ---- field access the compiler resolved: a row's field by its slot

func (c *Ctx) FieldOf(t Val, e *Entity, i int, name string) Val {
	switch x := t.(type) {
	case Ref:
		if x.E == e.Name {
			r := c.S.Find(e, x.ID)
			if r == nil {
				Refuse("not_found", fmt.Sprintf("%s %d was deleted", x.E, x.ID), "missing")
			}
			return r.Get(i)
		}
	case Singleton:
		if x.E == e.Name {
			r := c.S.First(e)
			if r == nil {
				return nil
			}
			return r.Get(i)
		}
	}
	return c.Field(t, name) // another shape at run time (a variable reused): as the interpreter reads it
}
func (c *Ctx) metaOf(t Val, e *Entity, name string) Val {
	if x, ok := t.(Ref); ok && x.E == e.Name {
		r := c.S.Find(e, x.ID)
		if r == nil {
			Refuse("not_found", fmt.Sprintf("%s %d was deleted", x.E, x.ID), "missing")
		}
		switch name {
		case "id":
			return r.ID
		case "created":
			return Time{r.Created, r.Seq}
		}
		c.S.readTime(e.Name, r.ID)
		return Time{r.Updated, r.Seq}
	}
	return c.Field(t, name)
}
func (c *Ctx) MetaID(t Val, e *Entity) Val      { return c.metaOf(t, e, "id") }
func (c *Ctx) MetaCreated(t Val, e *Entity) Val { return c.metaOf(t, e, "created") }
func (c *Ctx) MetaUpdated(t Val, e *Entity) Val { return c.metaOf(t, e, "updated") }

func (c *Ctx) RowAt(i int) Val {
	if c.Row == nil {
		panic(fmt.Errorf("a row field outside a where"))
	}
	return c.Row.Get(i)
}
func (c *Ctx) RowMetaID() Val      { return c.Row.ID }
func (c *Ctx) RowMetaCreated() Val { return Time{c.Row.Created, c.Row.Seq} }
func (c *Ctx) RowMetaUpdated() Val {
	if c.RowE != nil {
		c.S.readTime(c.RowE.Name, c.Row.ID)
	}
	return Time{c.Row.Updated, c.Row.Seq}
}

// SetWhere is `for each x in E where p { set x.f = v … }` as one write: the rows the condition
// picks whose fields differ from the values, read in one query, then updated in one statement.
// Each row is recorded as a set of it would be (its change, what live pages and the cache are
// told, the row as the session holds it). The generator uses it only where that is exact: the
// condition is all SQL and reads none of the fields set, the values don't depend on the row, and
// no trigger, touch or rich text is involved.
func (c *Ctx) SetWhere(e *Entity, where string, args []any, fields []int, vals []Val) {
	s := c.S
	s.mustWrite()
	probe := make([]Val, len(e.Fields))
	for k, i := range fields {
		probe[i] = vals[k]
	}
	enc := e.NewRec(probe).Enc()
	// a row needs writing when any of the fields differs
	var differ strings.Builder
	var dargs []any
	for k, i := range fields {
		if k > 0 {
			differ.WriteString(" OR ")
		}
		differ.WriteString("NOT (")
		flat := Flat(enc[i : i+1])
		for j, col := range e.FieldCols[i] {
			if j > 0 {
				differ.WriteString(" AND ")
			}
			differ.WriteString("t0." + col + " IS ?")
		}
		differ.WriteString(")")
		dargs = append(dargs, flat...)
	}
	cond := "(" + differ.String() + ")"
	if where != "" {
		cond = where + " AND " + cond
	}
	rows := s.Select(e, cond, append(append([]any{}, args...), dargs...)...)
	if len(rows) == 0 {
		return
	}
	now := c.Now()
	var set strings.Builder
	set.WriteString("UPDATE " + Q(e.Name) + " SET updated = ?")
	uargs := []any{now}
	names := make([]string, 0, len(fields))
	for _, i := range fields {
		for _, col := range e.FieldCols[i] {
			set.WriteString(", " + col + " = ?")
		}
		uargs = append(uargs, Flat(enc[i:i+1])...)
		names = append(names, e.Fields[i].Name)
	}
	ids := make([]string, len(rows))
	for k, r := range rows {
		ids[k] = strconv.FormatInt(r.ID, 10)
	}
	set.WriteString(" WHERE id IN (SELECT value FROM json_each(?))")
	s.constraint(s.exec(set.String(), append(uargs, "["+strings.Join(ids, ",")+"]")...), e.Name)
	for _, r := range rows {
		old := r.R.Enc()
		for k, i := range fields {
			r.R.Set(i, vals[k])
		}
		r.Updated = now
		nowEnc := r.R.Enc()
		k := key(e.Name, r.ID)
		s.wrote(e, r.ID, old, nowEnc)
		if s.orig != nil {
			s.orig[k] = nowEnc
		}
		s.Log = append(s.Log, Change{E: e.Name, ID: r.ID, Op: "update", Fields: names})
	}
}

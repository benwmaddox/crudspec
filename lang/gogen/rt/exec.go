package rt

import (
	"fmt"
	"sort"
)

// ---- writes. Each entity's create, set, delete and parent-touch are generated functions
// (gen.ts); these only dispatch on a value's entity when the compiler couldn't know it.

// Set is `set target.field = value` on a target whose entity is known only at run time.
func (c *Ctx) Set(target Val, field string, value Val) {
	var e *Entity
	switch x := target.(type) {
	case Ref:
		e = c.App.Ents[x.E]
	case Singleton:
		e = c.App.Ents[x.E]
	}
	if e == nil {
		panic(fmt.Errorf("set target is not a row"))
	}
	e.Setters[field](c, target, value)
}

// RowFor is the row a set changes: a reference's, or a singleton's.
func (c *Ctx) RowFor(e *Entity, target Val) *Row {
	switch x := target.(type) {
	case Ref:
		if r := c.S.Find(e, x.ID); r != nil {
			return r
		}
		Refuse("not_found", "set on a deleted row", "missing")
	case Singleton:
		if r := c.S.First(e); r != nil {
			return r
		}
	}
	panic(fmt.Errorf("set target is not a row"))
}

func (c *Ctx) Draft(f []Val) *Row {
	return &Row{ID: 0, Seq: c.S.DB.seq, Created: c.Now(), Updated: c.Now(), F: f}
}

// Clash is a row other than except with the same unique key (the generated code skips keys
// with an empty value: they never clash).
func (c *Ctx) Clash(e *Entity, where string, except int64, args ...any) *Row {
	rows := c.S.Select(e, where+" AND t0.id != ?", append(args, except)...)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}

func (c *Ctx) Touch(target Val) {
	ref, ok := target.(Ref)
	if !ok {
		return
	}
	e := c.App.Ents[ref.E]
	row := c.S.Find(e, ref.ID)
	if row == nil {
		return
	}
	row.Updated = c.Now()
	c.S.Save(e, row, nil)
	e.TouchParents(c, row)
}

// TouchRef touches the parent row a `touches` field refers to.
func (c *Ctx) TouchRef(e *Entity, v Val) {
	ref, ok := v.(Ref)
	if !ok {
		return
	}
	if p := c.S.Find(e, ref.ID); p != nil {
		p.Updated = c.Now()
		c.S.Save(e, p, nil)
		e.TouchParents(c, p)
	}
}

func (c *Ctx) Delete(target Val) {
	ref, ok := target.(Ref)
	if !ok {
		return
	}
	c.App.Ents[ref.E].Delete(c, ref)
}

// Emit records an event for the workflows (the generated code calls its triggers).
func (c *Ctx) Emit(name string, args ...Val) {
	*c.Events = append(*c.Events, Event{Name: name, Args: args})
}

// ---- invariants: the generated check is given the rows an action touched

type Touched map[string]map[int64]bool // entity -> id -> still there

func TouchedBy(log []Change) Touched {
	t := Touched{}
	for _, ch := range log {
		if t[ch.E] == nil {
			t[ch.E] = map[int64]bool{}
		}
		t[ch.E][ch.ID] = ch.Op != "delete"
	}
	return t
}

// Live are the touched rows of an entity that still exist.
func (t Touched) Live(e string) map[int64]bool {
	out := map[int64]bool{}
	for id, live := range t[e] {
		if live {
			out[id] = true
		}
	}
	return out
}

// InvariantRows are the rows to check: the given ids, or every row when all is set.
func (c *Ctx) InvariantRows(e *Entity, ids map[int64]bool, all bool) []*Row {
	if all {
		return c.S.Select(e, "")
	}
	list := make([]int64, 0, len(ids))
	for id := range ids {
		list = append(list, id)
	}
	sort.Slice(list, func(i, j int) bool { return list[i] < list[j] })
	rows := []*Row{}
	for _, id := range list {
		if r := c.S.Find(e, id); r != nil {
			rows = append(rows, r)
		}
	}
	return rows
}
func (c *Ctx) InvariantCtx(e *Entity, r *Row) *Ctx {
	ic := c.OnRow(e, r)
	ic.Vars = map[string]Val{"self": Ref{E: e.Name, ID: r.ID}}
	return ic
}

// ---- queries: the rows a planned query returns, then ordered and limited as the interpreter does

type Query struct {
	E        *Entity
	SQL      string
	Residual func(c *Ctx) bool // the conditions not in the SQL (nil: none)
	Order    func(c *Ctx) Val
	Desc     bool
	Limit    func(c *Ctx) Val
	ByUpdated bool // ordered by updated: a row's touch can move it into the window
	// the order as SQL columns ("t0.created,t0.seq"), when the SQL can order and limit the rows
	// itself: the whole condition is in SQL and the order is one no write changes. Then the
	// database returns only the rows kept, in order, instead of all of them for Go to sort.
	SQLOrder string
}

func (c *Ctx) Rows(q *Query, args ...any) []*Row {
	if q.E.Stored && q.Residual == nil && q.SQLOrder != "" && !q.ByUpdated {
		limit := -1
		if q.Limit != nil {
			if limit = int(Num(q.Limit(c))); limit < 0 {
				limit = 0
			}
		}
		rows := c.S.SelectOrdered(q.E, q.SQL, q.SQLOrder, q.Desc, limit, args...)
		c.S.readRows(q.E, rows, false) // the rows it keeps, as below
		return rows
	}
	var rows []*Row
	if q.E.Stored {
		rows = c.S.Select(q.E, q.SQL, args...)
	} else {
		rows = append([]*Row{}, q.E.Data...)
	}
	// one row context for the query, moved from row to row
	var rowc *Ctx
	on := func(r *Row) *Ctx {
		if rowc == nil {
			rowc = c.OnRow(q.E, r)
		}
		rowc.Row = r
		return rowc
	}
	if q.Residual != nil {
		c.S.read(tableKey(q.E.Name)) // conditions in Go may look at any column
		kept := rows[:0:0]
		for _, r := range rows {
			if q.Residual(on(r)) {
				kept = append(kept, r)
			}
		}
		rows = kept
	}
	if q.ByUpdated || q.Limit == nil {
		c.S.readRows(q.E, rows, q.ByUpdated) // the rows the query keeps, for live pages
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Seq < rows[j].Seq })
	if q.Order != nil {
		keys := make(map[*Row]Val, len(rows))
		for _, r := range rows {
			keys[r] = q.Order(on(r))
		}
		sort.SliceStable(rows, func(i, j int) bool {
			k := Compare(keys[rows[i]], keys[rows[j]])
			if k != 0 {
				return k < 0
			}
			return rows[i].Seq < rows[j].Seq
		})
		if q.Desc {
			for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
				rows[i], rows[j] = rows[j], rows[i]
			}
		}
	}
	if q.Limit != nil {
		n := int(Num(q.Limit(c)))
		if n < 0 {
			n = 0
		}
		if n < len(rows) {
			rows = rows[:n]
		}
		if !q.ByUpdated {
			c.S.readRows(q.E, rows, false) // the window it keeps
		}
	}
	return rows
}

// Count is count(…) / exists(…) when the whole condition is in the SQL.
func (c *Ctx) Count(q *Query, args ...any) int64 {
	if q.E.Stored && q.Residual == nil {
		return c.S.Count(q.E, q.SQL, args...)
	}
	return int64(len(c.Rows(q, args...)))
}

func RefsOf(e *Entity, rows []*Row) List {
	out := make(List, len(rows))
	for i, r := range rows {
		out[i] = Ref{E: e.Name, ID: r.ID}
	}
	return out
}
func SetOf(e *Entity, rows []*Row) Set {
	ids := make([]int64, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	return Set{E: e.Name, IDs: ids}
}

// ViewWindow applies a view's around/window/limit/page, as interp.viewRows does.
type Window struct {
	AroundAt   func(c *Ctx) Val
	AroundSize int
	Size       int
	End        string // first or last
	Unless     func(c *Ctx) bool
	Limit      func(c *Ctx) Val
	Page       int
}

// WindowRows is a view's rows through its window. When the query can order in SQL, only the
// window's rows are read (the last 40 of a room's messages, not all of them); a window around a
// row, or a query that can't, reads them all and windows them in Go, as ViewWindow does.
func (c *Ctx) WindowRows(q *Query, w *Window, args ...any) []*Row {
	pushed := q.E.Stored && q.Residual == nil && q.SQLOrder != "" && !q.ByUpdated
	if pushed && w.AroundAt != nil {
		if _, ok := w.AroundAt(c).(Ref); ok {
			pushed = false
		}
	}
	if !pushed {
		return c.ViewWindow(c.Rows(q, args...), w)
	}
	// the most rows the window keeps, and from which end
	limit, last := -1, false
	if w.Size > 0 {
		limit = w.Size
		last = w.End == "last"
		if w.Unless != nil && w.Unless(c) {
			last = !last
		}
	}
	take := func(n int) {
		if n < 0 {
			n = 0
		}
		if limit < 0 || n < limit {
			if last {
				return // the end of the last rows: Limit and Page apply to them, below
			}
			limit = n
		}
	}
	if w.Limit != nil {
		take(int(Num(w.Limit(c))))
	}
	if w.Page > 0 {
		take(w.Page)
	}
	desc := q.Desc
	if last {
		desc = !desc
	}
	rows := c.S.SelectOrdered(q.E, q.SQL, q.SQLOrder, desc, limit, args...)
	if last {
		for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
			rows[i], rows[j] = rows[j], rows[i]
		}
	}
	c.S.readRows(q.E, rows, false)
	return c.ViewWindow(rows, &Window{Limit: w.Limit, Page: w.Page})
}

func (c *Ctx) ViewWindow(rows []*Row, w *Window) []*Row {
	if w == nil {
		return rows
	}
	if w.AroundAt != nil {
		if at, ok := w.AroundAt(c).(Ref); ok {
			for i, r := range rows {
				if r.ID == at.ID {
					lo := i - w.AroundSize
					if lo < 0 {
						lo = 0
					}
					hi := i + 1 + w.AroundSize
					if hi > len(rows) {
						hi = len(rows)
					}
					return rows[lo:hi]
				}
			}
		}
	}
	if w.Size > 0 {
		end := w.End
		if w.Unless != nil && w.Unless(c) {
			if end == "last" {
				end = "first"
			} else {
				end = "last"
			}
		}
		if end == "last" {
			if len(rows) > w.Size {
				rows = rows[len(rows)-w.Size:]
			}
		} else if len(rows) > w.Size {
			rows = rows[:w.Size]
		}
	}
	if w.Limit != nil {
		n := int(Num(w.Limit(c)))
		if n < 0 {
			n = 0
		}
		if n < len(rows) {
			rows = rows[:n]
		}
	}
	if w.Page > 0 && len(rows) > w.Page {
		rows = rows[:w.Page]
	}
	return rows
}

// View rows as a value (a view called in an expression): its requires, then its rows.
func (c *Ctx) ViewRefs(name string, args map[string]Val) Val {
	v := c.App.Views[name]
	vc := c.Fresh()
	vc.Vars = args
	if v.Requires != nil && v.Requires(vc) != "" {
		return List{}
	}
	return RefsOf(c.App.Ents[v.Entity], v.Rows(vc))
}

// ---- externs and workflows

// Extern is `call name(…)`. Inside a workflow (or a view that fetches) it runs, with the
// writer released while it waits; elsewhere it is recorded as an effect and returns none, as
// in the interpreter.
func (c *Ctx) Extern(name string, args ...Val) Val {
	f := c.Externs[name]
	if f == nil {
		f = c.App.Pure[name]
	}
	if f == nil {
		return nil
	}
	// a workflow step's writes are committed before an effect (pure ones need not wait)
	if c.InWorkflow && c.S.depth == 0 && c.App.Pure[name] == nil {
		c.S.Done()
	}
	return f(args)
}

// RunWorkflows runs the workflows for these events, each step on its own: its writes apply
// directly, outside any transaction, as a background job's do.
func (a *App) RunWorkflows(events []Event, req *Request, externs map[string]func([]Val) Val) {
	for _, ev := range events {
		for _, step := range a.Workflows[ev.Name] {
			var arg Val
			if len(ev.Args) > 0 {
				arg = ev.Args[0]
			}
			func() {
				s := a.DB.Session(a.Ents)
				s.Auto = true
				defer s.Done()
				c := a.ctx(s, map[string]Val{}, nil, req)
				c.InWorkflow = true
				c.Externs = externs
				defer func() {
					if r := recover(); r != nil {
						if _, ok := r.(*Outcome); !ok {
							panic(r)
						}
					}
				}()
				step(c, arg)
			}()
		}
	}
}

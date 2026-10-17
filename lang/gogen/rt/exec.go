package rt

import (
	"fmt"
	"sort"
	"strings"
)

// Field details the statements need, filled in by generated code.
type FieldRules struct {
	OnDelete string // restrict (the default) or cascade
	Touches  bool
	Default  func(c *Ctx) Val
}

// Rules per entity: field rules by index, and invariants with what they depend on.
type Invariant struct {
	Line int
	Cond func(c *Ctx) bool
	// entities the invariant reads besides its own, and the reference field from this entity
	// that reaches each one directly ("" when it's reached some other way: then every row is checked)
	Deps map[string]string
}
type Rules struct {
	Fields     []FieldRules
	Invariants []Invariant
}

// ---- writes

func (c *Ctx) StoreValue(e *Entity, i int, v Val) Val {
	f := e.Fields[i]
	if f.Type == "Password" {
		if s, ok := v.(string); ok {
			return Hash(s)
		}
	}
	if f.Type == "RichText" {
		if s, ok := v.(string); ok {
			return Rich{Text: s, Mentions: []int64{}}
		}
	}
	return v
}

// Create is the create statement. given holds the fields the statement sets (nil = not set).
// It returns the new row's reference, and whether a row was created (ensure may find one).
func (c *Ctx) Create(e *Entity, given map[int]Val, ensure bool) (Ref, bool) {
	rules := c.App.Rules[e.Name]
	fields := make([]Val, len(e.Fields))
	set := make([]bool, len(e.Fields))
	for i, v := range given {
		fields[i] = c.StoreValue(e, i, v)
		set[i] = true
	}
	draft := &Row{ID: 0, Seq: c.S.DB.seq, Created: c.Now(), Updated: c.Now(), F: fields}
	for i, f := range e.Fields {
		if set[i] {
			continue
		}
		if rules != nil && rules.Fields[i].Default != nil {
			fields[i] = rules.Fields[i].Default(c.OnRow(e, draft))
		} else if f.Optional {
			fields[i] = nil
		} else if f.Type == "Int" {
			fields[i] = int64(0)
		} else {
			Refuse("invalid", e.Name+"."+f.Name+" is required", "required")
		}
	}
	for _, cols := range e.Uniques {
		if clash := c.S.Clash(e, cols, fields, 0); clash != nil {
			if ensure {
				return Ref{E: e.Name, ID: clash.ID}, false
			}
			Refuse("invalid", fmt.Sprintf("unique (%s: %s)", e.Name, strings.Join(cols, ", ")), "unique")
		}
	}
	if e.Singleton && c.S.First(e) != nil {
		Refuse("invalid", e.Name+" exists", "unique")
	}
	row := c.S.Insert(e, fields, c.Now())
	ref := Ref{E: e.Name, ID: row.ID}
	c.touchParents(e, row)
	c.fire("create", e.Name, "", ref, nil)
	return ref, true
}

// Set is `set target.field = value`.
func (c *Ctx) Set(target Val, field string, value Val) {
	e, row := c.RowOf(target)
	if row == nil {
		if _, ok := target.(Ref); ok {
			Refuse("not_found", "set on a deleted row", "missing")
		}
		panic(fmt.Errorf("set target is not a row"))
	}
	i := e.Index[field]
	value = c.StoreValue(e, i, value)
	before := row.F[i]
	old := make(map[string]Val, len(e.Fields))
	for j, f := range e.Fields {
		old[f.Name] = row.F[j]
	}
	row.F[i] = value
	for _, cols := range e.Uniques {
		for _, col := range cols {
			if col == field {
				if c.S.Clash(e, cols, row.F, row.ID) != nil {
					Refuse("invalid", fmt.Sprintf("unique (%s: %s)", e.Name, strings.Join(cols, ", ")), "unique")
				}
			}
		}
	}
	if !Equal(before, value) {
		row.Updated = c.Now()
		c.S.Save(e, row, []string{field})
		c.touchParents(e, row)
		c.fire("update", e.Name, field, Ref{E: e.Name, ID: row.ID}, OldRow{F: old})
	}
}

func (c *Ctx) Touch(target Val) {
	if _, ok := target.(Ref); !ok {
		return
	}
	e, row := c.RowOf(target)
	if row == nil {
		return
	}
	row.Updated = c.Now()
	c.S.Save(e, row, nil)
	c.touchParents(e, row)
}

func (c *Ctx) touchParents(e *Entity, row *Row) {
	rules := c.App.Rules[e.Name]
	if rules == nil {
		return
	}
	for i, f := range e.Fields {
		if !rules.Fields[i].Touches {
			continue
		}
		ref, ok := row.F[i].(Ref)
		if !ok {
			continue
		}
		pe := c.App.Ents[f.Type]
		if p := c.S.Find(pe, ref.ID); p != nil {
			p.Updated = c.Now()
			c.S.Save(pe, p, nil)
			c.touchParents(pe, p)
		}
	}
}

func (c *Ctx) Delete(target Val) {
	ref, ok := target.(Ref)
	if !ok {
		return
	}
	c.deleteRow(ref)
}

func (c *Ctx) deleteRow(target Ref) {
	e := c.App.Ents[target.E]
	row := c.S.Find(e, target.ID)
	if row == nil {
		return
	}
	for _, name := range c.App.EntityOrder {
		de := c.App.Ents[name]
		rules := c.App.Rules[name]
		for i, f := range de.Fields {
			if f.Type != target.E {
				continue
			}
			deps := c.S.Where(de, f.Name, target)
			if len(deps) == 0 {
				continue
			}
			if rules == nil || rules.Fields[i].OnDelete == "restrict" || rules.Fields[i].OnDelete == "" {
				Refuse("invalid", fmt.Sprintf("%s.%s restricts deleting %s", name, f.Name, target.E), "restrict")
			}
			for _, d := range deps {
				c.deleteRow(Ref{E: name, ID: d.ID})
			}
		}
	}
	old := make(map[string]Val, len(e.Fields))
	for j, f := range e.Fields {
		old[f.Name] = row.F[j]
	}
	c.S.Remove(e, target.ID)
	c.touchParents(e, &Row{ID: row.ID, Seq: row.Seq, Created: row.Created, Updated: row.Updated, F: row.F})
	c.fire("delete", e.Name, "", target, OldRow{F: old})
}

func (c *Ctx) fire(kind, entity, field string, subject Val, old Val) {
	if c.NoTriggers || c.App.Fire == nil {
		return
	}
	c.App.Fire(c, kind, entity, field, subject, old)
}

// Emit is the emit statement: an event for workflows, and event triggers.
func (c *Ctx) Emit(name string, args ...Val) {
	*c.Events = append(*c.Events, Event{Name: name, Args: args})
	var first Val
	if len(args) > 0 {
		first = args[0]
	}
	if !c.NoTriggers && c.App.Fire != nil {
		c.App.Fire(c, "event", name, "", first, nil)
	}
}

// ---- invariants, checked for the rows an action touched

func (a *App) CheckInvariants(c *Ctx, log []Change) {
	touched := map[string]map[int64]bool{}
	for _, ch := range log {
		if touched[ch.E] == nil {
			touched[ch.E] = map[int64]bool{}
		}
		touched[ch.E][ch.ID] = ch.Op != "delete"
	}
	for _, name := range a.EntityOrder {
		rules := a.Rules[name]
		if rules == nil || len(rules.Invariants) == 0 {
			continue
		}
		e := a.Ents[name]
		check := map[int64]bool{}
		all := false
		for id, live := range touched[name] {
			if live {
				check[id] = true
			}
		}
		for _, inv := range rules.Invariants {
			for dep, via := range inv.Deps {
				ids := touched[dep]
				if len(ids) == 0 {
					continue
				}
				if via == "" {
					all = true
					continue
				}
				for id := range ids {
					for _, r := range c.S.Where(e, via, Ref{E: dep, ID: id}) {
						check[r.ID] = true
					}
				}
			}
		}
		var rows []*Row
		if all {
			rows = c.S.Select(e, "")
		} else {
			ids := make([]int64, 0, len(check))
			for id := range check {
				ids = append(ids, id)
			}
			sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
			for _, id := range ids {
				if r := c.S.Find(e, id); r != nil {
					rows = append(rows, r)
				}
			}
		}
		for _, row := range rows {
			ic := c.OnRow(e, row)
			ic.Vars = map[string]Val{"self": Ref{E: name, ID: row.ID}}
			for _, inv := range rules.Invariants {
				if !inv.Cond(ic) {
					Refuse("invalid", fmt.Sprintf("invariant of %s at %d", name, inv.Line), "invariant")
				}
			}
		}
	}
}

// ---- queries: the rows a planned query returns, then ordered and limited as the interpreter does

type Query struct {
	E        *Entity
	SQL      string
	Residual func(c *Ctx) bool // the conditions not in the SQL (nil: none)
	Order    func(c *Ctx) Val
	Desc     bool
	Limit    func(c *Ctx) Val
}

func (c *Ctx) Rows(q *Query, args ...any) []*Row {
	var rows []*Row
	if q.E.Stored {
		rows = c.S.Select(q.E, q.SQL, args...)
	} else {
		rows = append([]*Row{}, q.E.Data...)
	}
	if q.Residual != nil {
		kept := rows[:0:0]
		for _, r := range rows {
			if q.Residual(c.OnRow(q.E, r)) {
				kept = append(kept, r)
			}
		}
		rows = kept
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Seq < rows[j].Seq })
	if q.Order != nil {
		keys := make(map[*Row]Val, len(rows))
		for _, r := range rows {
			keys[r] = q.Order(c.OnRow(q.E, r))
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
		return nil
	}
	if c.InWorkflow && c.S.depth == 0 {
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

package rt

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// The test endpoints (--test only), as server.ts: the generic protocol (load rows as they
// are, dump every row), fixtures through the spec's own rules, the clock, max ids, functions.

func decodeJSON(s string) map[string]any {
	out := map[string]any{}
	d := json.NewDecoder(strings.NewReader(s))
	d.UseNumber()
	d.Decode(&out)
	return out
}

func rowJSON(e *Entity, r *Row) map[string]any {
	fields := map[string]any{}
	for i, f := range e.Fields {
		fields[f.Name] = r.Get(i)
	}
	return map[string]any{"id": r.ID, "seq": r.Seq, "created": r.Created, "updated": r.Updated, "fields": fields}
}

func (sv *Server) testEndpoint(w http.ResponseWriter, r *HTTPReq) {
	a := sv.App
	s := r.Sess
	body := decodeJSON(r.Text)
	if r.Text == "" {
		body = map[string]any{}
	}
	ok := func(v any) { writeJSON(w, 200, v, nil) }
	switch r.Path {
	case "/_test/load":
		a.LoadRows(s, body)
		ok(map[string]any{"ok": true})
	case "/_test/dump":
		rows := map[string]any{}
		for _, name := range a.EntityOrder {
			e := a.Ents[name]
			if !e.Stored && len(e.Data) == 0 {   // data entities: their rows, from the spec
				continue
			}
			list := []any{}
			for _, row := range s.Select(e, "") {
				list = append(list, rowJSON(e, row))
			}
			rows[name] = list
		}
		a.countMu.Lock()
		counters := [][]any{}
		for k, v := range a.Counters {
			counters = append(counters, []any{k, v})
		}
		a.countMu.Unlock()
		ok(map[string]any{"rows": rows, "seq": s.DB.seq, "now": a.Clock(), "counters": counters})
	case "/_test/clock":
		a.Advance(Num(Lift(body["advance_ms"])))
		ok(map[string]any{"offset": a.offset})
	case "/_test/maxid":
		e := a.Ents[Plain(body["entity"])]
		var max int64
		if e != nil {
			for _, row := range s.Select(e, "") {
				if row.ID > max {
					max = row.ID
				}
			}
		}
		ok(map[string]any{"id": max})
	case "/_test/fn":
		f := a.Fns[Plain(body["name"])]
		if f == nil {
			writeJSON(w, 404, map[string]any{"error": "unknown fn"}, nil)
			return
		}
		args := []Val{}
		refs, _ := body["refs"].([]any)
		vals, _ := body["args"].([]any)
		n := len(refs)
		if len(vals) > n {
			n = len(vals)
		}
		for i := 0; i < a.FnArity[Plain(body["name"])]; i++ {
			var v Val
			if i < len(refs) {
				if p, ok := refs[i].([]any); ok && len(p) == 2 {
					v = Ref{E: Plain(p[0]), ID: Num(Lift(p[1]))}
				}
			}
			if v == nil && i < len(vals) {
				v = Lift(vals[i])
			}
			args = append(args, v)
		}
		_ = n
		ok(map[string]any{"value": f(sv.plainCtx(s), args)})
	case "/_test/agent_token": // a token for an agent acting for {entity, id}, as /_agents would issue
		if sv.Agents == nil || sv.Agents.ident == nil {
			writeJSON(w, 404, map[string]any{"error": "agents are off"}, nil)
			return
		}
		scope := "full"
		if Plain(body["scope"]) == "read" {
			scope = "read"
		}
		ok(map[string]any{"token": sv.Agents.issue(s, Ref{E: Plain(body["entity"]), ID: Num(Lift(body["id"]))}, "test", scope)})
	case "/_test/live":
		ok(map[string]any{"keys": a.DB.Live.PlainSince(Num(Lift(body["since"])))})
	case "/_test/fixture":
		sv.fixture(w, r, body)
	default:
		w.WriteHeader(404)
	}
}

// A fixture for any app, through its own rules: rows created as `create` would (defaults,
// keys, triggers), then actions run as named actors. "$name" refers to a saved row.
func (sv *Server) fixture(w http.ResponseWriter, r *HTTPReq, body map[string]any) {
	a := sv.App
	s := r.Sess
	s.Write()
	s.Clear()
	a.countMu.Lock()
	a.Counters = map[string][]int64{}
	a.countMu.Unlock()
	a.FixedTokens.Store(1)
	defer a.FixedTokens.Store(0)
	clock := time.Date(2026, 1, 15, 15, 0, 0, 0, time.UTC).UnixMilli()
	if c, ok := body["clock"]; ok && c != nil {
		clock = Num(Lift(c))
	}
	a.Freeze(clock)
	keys := map[string]Val{}
	var resolve func(v Val) (Val, error)
	resolve = func(v Val) (Val, error) {
		switch x := v.(type) {
		case string:
			if strings.HasPrefix(x, "$") {
				k, ok := keys[x[1:]]
				if !ok {
					return nil, fmt.Errorf("unknown fixture name %s", x)
				}
				return k, nil
			}
		case List:
			out := List{}
			for _, e := range x {
				r, err := resolve(e)
				if err != nil {
					return nil, err
				}
				out = append(out, r)
			}
			return out, nil
		}
		return v, nil
	}
	var idOf func(v Val) Val
	idOf = func(v Val) Val {
		switch x := v.(type) {
		case Ref:
			return x.ID
		case List:
			out := List{}
			for _, e := range x {
				out = append(out, idOf(e))
			}
			return out
		}
		return v
	}
	fail := func(err error) { writeJSON(w, 422, map[string]any{"error": err.Error()}, nil) }
	req := &Request{IP: "203.0.113.1", Method: "write", Base: r.Base}
	err := func() (err error) {
		defer func() {
			if x := recover(); x != nil {
				if o, ok := x.(*Outcome); ok {
					err = fmt.Errorf("%s: %s", o.O, o.Msg)
					return
				}
				err = fmt.Errorf("%v", x)
			}
		}()
		rows, _ := body["rows"].([]any)
		for _, x := range rows {
			m, _ := x.(map[string]any)
			e := a.Ents[Plain(m["entity"])]
			if e == nil {
				return fmt.Errorf("unknown entity %s", Plain(m["entity"]))
			}
			given := map[int]Val{}
			fm, _ := m["fields"].(map[string]any)
			for name, raw := range fm {
				i, ok := e.Index[name]
				if !ok {
					continue
				}
				v, err := resolve(Lift(raw))
				if err != nil {
					return err
				}
				given[i] = v
			}
			c := a.ctx(s, map[string]Val{}, nil, req)
			s.Begin()
			f := make([]Val, len(e.Fields))
			var set uint64
			for i, v := range given {
				f[i] = v
				set |= 1 << uint(i)
			}
			ref, _ := e.Create(c, f, set, false)
			s.Commit()
			if sv, ok := m["save"].(string); ok && sv != "" {
				keys[sv] = ref
			}
			a.Advance(1000)
		}
		steps, _ := body["steps"].([]any)
		for i, x := range steps {
			st, _ := x.(map[string]any)
			var actor Val
			if as, ok := st["as"].(string); ok && as != "" {
				actor = keys[as]
				if actor == nil {
					return fmt.Errorf("step %d: unknown actor %s", i+1, as)
				}
			}
			args := map[string]Val{}
			am, _ := st["args"].(map[string]any)
			for k, raw := range am {
				v, err := resolve(Lift(raw))
				if err != nil {
					return err
				}
				args[k] = idOf(v)
			}
			entity, _ := st["entity"].(string)
			var before int64
			if entity != "" {
				for _, row := range s.Select(a.Ents[entity], "") {
					if row.ID > before {
						before = row.ID
					}
				}
			}
			ident := ""
			if sv.session != nil {
				ident = sv.session.Name
			}
			call := Plain(st["call"])
			out := a.Run(s, call, args, actor, &Request{IP: "203.0.113.1", Method: "write", Identity: ident, Base: r.Base}, nil)
			if out.Outcome != "ok" {
				as := Plain(st["as"])
				if as == "" {
					as = "anonymous"
				}
				return fmt.Errorf("step %d (%s as %s): %s %s", i+1, call, as, out.Outcome, out.Detail)
			}
			if save, ok := st["save"].(string); ok && save != "" {
				var made Val
				if entity != "" {
					for _, row := range s.Select(a.Ents[entity], "") {
						if row.ID > before {
							made = Ref{E: entity, ID: row.ID}
						}
					}
				} else {
					made = out.Result
				}
				if made == nil {
					return fmt.Errorf("step %d: nothing to save as %s; give \"entity\"", i+1, save)
				}
				keys[save] = made
			}
			a.Advance(60_000)
		}
		return nil
	}()
	if err != nil {
		fail(err)
		return
	}
	writeJSON(w, 200, map[string]any{"keys": keys}, nil)
}

// LoadRows replaces every stored row with the given ones, as they are (ids, sequence numbers,
// times), and sets the clock and the rate-limit counters: the replay driver's setups (/_test/load)
// and the change report's probe states (app probe).
func (a *App) LoadRows(s *Sess, body map[string]any) {
	s.Write()
	s.Clear()
	a.countMu.Lock()
	a.Counters = map[string][]int64{}
	a.countMu.Unlock()
	clock := time.Now().UnixMilli()
	if c, ok := body["clock"]; ok {
		clock = Num(Lift(c))
	}
	a.SetClock(clock + 1)
	rows, _ := body["rows"].(map[string]any)
	for _, name := range a.EntityOrder {
		list, _ := rows[name].([]any)
		e := a.Ents[name]
		if e == nil || !e.Stored {
			continue
		}
		for _, x := range list {
			m, _ := x.(map[string]any)
			fm, _ := m["fields"].(map[string]any)
			row := &Row{ID: Num(Lift(m["id"])), Seq: Num(Lift(m["seq"])), Created: Num(Lift(m["created"])), Updated: Num(Lift(m["updated"])), F: make([]Val, len(e.Fields))}
			for i, f := range e.Fields {
				v := Lift(fm[f.Name])
				if f.Type == "Password" {
					if o, ok := v.(Obj); ok {
						if pw, ok := o["password"]; ok {
							v = Hash(Plain(pw))
						}
					}
				}
				row.F[i] = v
			}
			s.Load(e, row)
		}
	}
	if q := Num(Lift(body["seq"])); q > s.DB.seq {
		s.DB.seq = q
	}
	a.countMu.Lock()
	if cs, ok := body["counters"].([]any); ok {
		for _, kv := range cs {
			p, _ := kv.([]any)
			if len(p) != 2 {
				continue
			}
			hits := []int64{}
			l, _ := p[1].([]any)
			for _, t := range l {
				hits = append(hits, Num(Lift(t)))
			}
			a.Counters[Plain(p[0])] = hits
		}
	}
	a.countMu.Unlock()
}

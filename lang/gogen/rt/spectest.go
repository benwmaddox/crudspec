package rt

import (
	"fmt"
	"net/http"
	"time"
)

// /_test/spec (--test only): one of the spec's tests (docs/testing.md), run in this process
// against an empty database. lang/spectest.ts sends its steps, as the parser read them:
//
//	{"kind": "create", "entity": "User", "fields": {"name": "Ann"}, "save": "ann"}
//	{"kind": "run", "call": "create_wiki", "args": {"slug": "x"}, "by": "ann", "host": "…", "expect": "ok", "rows": 2, "save": "w"}
//	{"kind": "expect", "fn": "__test_0_4", "refs": ["w", "ann"], "host": "…"}
//	{"kind": "wait", "fn": "__test_0_5", "refs": []}
//	{"kind": "fake", "extern": "send_sms", "fn": "__test_0_6", "refs": []}
//
// A value {"$": "ann"} is a row the test made. The clock starts frozen at 2026-01-15 15:00 UTC
// and moves a second a step; tokens are deterministic. The steps stop at the first that fails,
// as the ones after it build on it.
func (sv *Server) specTest(w http.ResponseWriter, r *HTTPReq, body map[string]any) {
	a := sv.App
	s := r.Sess
	defer HoldSchedules()() // before the writer: the ticker takes them in that order too
	s.ClearAll()
	a.countMu.Lock()
	a.Counters = map[string][]int64{}
	a.countMu.Unlock()
	a.FixedTokens.Store(1)
	defer a.FixedTokens.Store(0)
	a.Freeze(time.Date(2026, 1, 15, 15, 0, 0, 0, time.UTC).UnixMilli())
	a.ResetSchedules(s) // no runs from another test; deployed at the frozen time
	defer a.DB.ForgetAll() // it cleared the tables without a commit
	defer a.beginDoubles()() // no extern reaches outside while it runs; its calls are counted
	saved := map[string]Val{}
	ident := ""
	if sv.session != nil {
		ident = sv.session.Name
	}
	req := func(host string) *Request {
		return &Request{IP: "203.0.113.1", Method: "write", Identity: ident, Base: r.Base, Host: HostName(host)}
	}
	var value func(raw any) (Val, error)
	value = func(raw any) (Val, error) {
		if m, ok := raw.(map[string]any); ok {
			if n, ok := m["$"].(string); ok {
				v, ok := saved[n]
				if !ok {
					return nil, fmt.Errorf("%s isn't made yet", n)
				}
				return v, nil
			}
		}
		return Lift(raw), nil
	}
	results := []any{}
	failed := -1
	message := ""
	steps, _ := body["steps"].([]any)
	for i, x := range steps {
		st, _ := x.(map[string]any)
		res := map[string]any{}
		err := func() (err error) {
			defer func() {
				if p := recover(); p != nil {
					if o, ok := p.(*Outcome); ok {
						err = fmt.Errorf("%s: %s", o.O, o.Msg)
						return
					}
					err = fmt.Errorf("%v", p)
				}
			}()
			host, _ := st["host"].(string)
			switch Plain(st["kind"]) {
			case "create":
				e := a.Ents[Plain(st["entity"])]
				if e == nil {
					return fmt.Errorf("no entity %s", Plain(st["entity"]))
				}
				f := make([]Val, len(e.Fields))
				var set uint64
				fm, _ := st["fields"].(map[string]any)
				for name, raw := range fm {
					i, ok := e.Index[name]
					if !ok {
						return fmt.Errorf("%s has no field %s", e.Name, name)
					}
					v, err := value(raw)
					if err != nil {
						return err
					}
					f[i] = v
					set |= 1 << uint(i)
				}
				c := a.ctx(s, map[string]Val{}, nil, req(host))
				s.Begin()
				ref, _ := e.Create(c, f, set, false)
				if a.Invariants != nil {
					a.Invariants(c, s.Log)
				}
				s.Commit()
				saved[Plain(st["save"])] = ref
			case "run":
				var actor Val
				if by, ok := st["by"].(string); ok && by != "" {
					actor = saved[by]
				}
				args := map[string]Val{}
				am, _ := st["args"].(map[string]any)
				for k, raw := range am {
					v, err := value(raw)
					if err != nil {
						return err
					}
					if ref, ok := v.(Ref); ok {
						args[k] = ref.ID // as a form or an agent gives a row
					} else {
						args[k] = v
					}
				}
				call := Plain(st["call"])
				method := "write"
				if a.Views[call] != nil {
					method = "get"
				}
				rq := req(host)
				rq.Method = method
				out := a.Run(s, call, args, actor, rq, nil)
				res["outcome"], res["detail"] = out.Outcome, out.Detail
				want := Plain(st["expect"])
				if want == "" {
					want = "ok"
				}
				if out.Outcome != want {
					detail := ""
					if out.Detail != "" {
						detail = " (" + out.Detail + ")"
					}
					return fmt.Errorf("expected %s, got %s%s", want, out.Outcome, detail)
				}
				if n, ok := st["rows"]; ok && n != nil {
					res["rows"] = len(out.Rows)
					if int64(len(out.Rows)) != Num(Lift(n)) {
						return fmt.Errorf("expected %d rows, got %d", Num(Lift(n)), len(out.Rows))
					}
				}
				// what the action set going runs now, in the test, before the next step: its workflows
				// (whose externs are the test's doubles)
				if len(out.Events) > 0 {
					a.RunWorkflowsIn(s, out.Events, rq, sv.Externs)
				}
				if save := Plain(st["save"]); save != "" {
					if _, ok := out.Result.(Ref); !ok {
						return fmt.Errorf("%s gave no row to save as %s", call, save)
					}
					saved[save] = out.Result
				}
			case "expect", "wait", "fake":
				fn := a.Fns[Plain(st["fn"])]
				if fn == nil {
					return fmt.Errorf("no function %s (rebuild the app)", Plain(st["fn"]))
				}
				vals := []Val{}
				refs, _ := st["refs"].([]any)
				for _, n := range refs {
					v, ok := saved[Plain(n)]
					if !ok {
						return fmt.Errorf("%s isn't made yet", Plain(n))
					}
					s.Inbound(v) // given to it, as an action's parameter is, with the rows it refers to
					if ref, ok := v.(Ref); ok {
						if e := a.Ents[ref.E]; e != nil {
							if row := s.Find(e, ref.ID); row != nil {
								for i := range e.Fields {
									if r, ok := row.Get(i).(Ref); ok {
										s.Inbound(r)
									}
								}
							}
						}
					}
					vals = append(vals, v)
				}
				c := a.ctx(s, map[string]Val{}, nil, req(host))
				v := fn(c, vals)
				if Plain(st["kind"]) == "fake" {
					a.fake(Plain(st["extern"]), v)
					return nil
				}
				if Plain(st["kind"]) == "wait" {
					d, ok := v.(Dur)
					if !ok {
						return fmt.Errorf("wait takes a Duration")
					}
					ms := d.MS
					a.Advance(ms)
					// what the new time makes due runs, in the test's session, as the server's
					// ticker would run it
					a.RunWorkflowsIn(s, a.RunDueIn(s, req(host)), req(host), sv.Externs)
					return nil
				}
				if !Truthy(v) {
					return fmt.Errorf("it doesn't hold")
				}
			default:
				return fmt.Errorf("unknown step %v", st["kind"])
			}
			return nil
		}()
		if err != nil {
			res["error"] = err.Error()
			results = append(results, res)
			failed, message = i, err.Error()
			break
		}
		results = append(results, res)
		a.Advance(1000)
	}
	writeJSON(w, 200, map[string]any{"steps": results, "failed": failed, "message": message}, nil)
}

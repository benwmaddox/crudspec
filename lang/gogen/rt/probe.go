package rt

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// probe: app probe < {"states": [...], "calls": [...], "reads": [...]}
// The change report's behaviour runs (lang/review.ts), on this build of the spec: each state is
// loaded into a scratch database (with the defaults of fields it predates), then each call is
// run and rolled back, and each read permission is evaluated for each actor. A call or read
// that fails to evaluate is null: the report counts it as incomparable.
func probe(app *App, ui *UI, b *Build) int {
	var in struct {
		Secret string `json:"secret"` // the secret the states' signed links were made with
		States []struct {
			Clock    int64          `json:"clock"`
			Seq      int64          `json:"seq"`
			Rows     map[string]any `json:"rows"`
			Defaults [][]string     `json:"defaults"`
			Counters []any          `json:"counters"` // the rate-limit counters, each call starting from them (none: empty)
		} `json:"states"`
		Calls []struct {
			State   int            `json:"state"`
			Name    string         `json:"name"`
			Args    map[string]any `json:"args"`
			Actor   map[string]any `json:"actor"`
			Request map[string]any `json:"request"`
			Skips   []string       `json:"skips"`
			Changes bool           `json:"changes"` // report what the call changed
			Again   int64          `json:"again"`   // and then run it again this many ms later
		} `json:"calls"`
		Reads []struct {
			State   int              `json:"state"`
			Entity  string           `json:"entity"`
			Actors  []map[string]any `json:"actors"`
			Request map[string]any   `json:"request"`
		} `json:"reads"`
	}
	raw, _ := io.ReadAll(os.Stdin)
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(&in); err != nil {
		fmt.Fprintln(os.Stderr, "probe: the input:", err)
		return 64
	}
	dir, err := os.MkdirTemp("", "crudspec-probe-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "app.sqlite")
	if err := prepareDB(path, b); err != nil {
		fmt.Fprintln(os.Stderr, "storage:", err)
		return 1
	}
	db, err := Open(path, app.Ents)
	if err != nil {
		fmt.Fprintln(os.Stderr, "storage:", err)
		return 1
	}
	app.DB = db
	app.Secret = []byte("probe")
	if in.Secret != "" {
		app.Secret = []byte(in.Secret)
	}
	s := db.Session(app.Ents)
	defer s.Done()
	actorOf := func(m map[string]any) Val {
		if m == nil {
			return nil
		}
		return Ref{E: Plain(m["ref"]), ID: Num(Lift(m["id"]))}
	}
	reqOf := func(m map[string]any, now int64) *Request {
		return &Request{IP: Plain(m["ip"]), Method: Plain(m["method"]), Identity: Plain(m["identity"]), UserAgent: Plain(m["user_agent"]), SessionToken: Plain(m["session_token"]), Now: now}
	}
	calls := make([]any, len(in.Calls))
	reads := make([]any, len(in.Reads))
	for si, st := range in.States {
		app.LoadRows(s, map[string]any{"clock": json.Number(fmt.Sprint(st.Clock - 1)), "seq": json.Number(fmt.Sprint(st.Seq)), "rows": st.Rows})
		app.SetClock(st.Clock)
		c := app.ctx(s, map[string]Val{}, nil, &Request{Method: "write", Now: st.Clock})
		c.NoTriggers = true
		for _, df := range st.Defaults {
			e := app.Ents[df[0]]
			if e == nil || e.FieldIndex(df[1]) < 0 {
				continue
			}
			i, def := e.FieldIndex(df[1]), app.Migrate.Defaults[df[0]+"."+df[1]]
			for _, row := range s.Select(e, "") {
				var v Val
				if def != nil {
					func() {
						defer func() { recover() }()
						v = def(c.InvariantCtx(e, row), row)
					}()
				} else if e.Fields[i].Type == "Int" && !e.Fields[i].Optional {
					v = int64(0)
				}
				row.R.Set(i, v)
				s.Save(e, row, nil)
			}
		}
		for ci, call := range in.Calls {
			if call.State != si {
				continue
			}
			args := map[string]Val{}
			for k, v := range call.Args {
				args[k] = Lift(v)
			}
			app.countMu.Lock()
			app.Counters = countersFrom(st.Counters)
			app.countMu.Unlock()
			app.SetClock(st.Clock)
			calls[ci] = func() (out any) {
				s.Begin()
				defer func() {
					if r := recover(); r != nil {
						out = nil
					}
					s.Rollback()
				}()
				var before map[string]map[int64][]string
				if call.Changes {
					before = rowValues(app, s)
				}
				res := app.Run(s, call.Name, args, actorOf(call.Actor), reqOf(call.Request, st.Clock), call.Skips)
				o := map[string]any{"outcome": res.Outcome, "cause": res.Cause, "detail": res.Detail}
				if res.Rows != nil {
					rows := []map[string]any{}
					for _, r := range res.Rows {
						rows = append(rows, map[string]any{"ref": r.E, "id": r.ID})
					}
					o["rows"] = rows
				}
				if call.Changes && res.Outcome == "ok" {
					after := rowValues(app, s)
					o["changes"] = changesBetween(app, before, after, false)
					// the same call again, later: what a repeat changes (idempotence)
					if call.Again > 0 {
						t := st.Clock + call.Again
						app.SetClock(t)
						r2 := app.Run(s, call.Name, args, actorOf(call.Actor), reqOf(call.Request, t), call.Skips)
						again := changesBetween(app, after, rowValues(app, s), true)
						again["outcome"] = r2.Outcome
						o["again"] = again
					}
				}
				return o
			}()
		}
		for ri, rd := range in.Reads {
			if rd.State != si {
				continue
			}
			perm, e := ui.Permissions[rd.Entity], app.Ents[rd.Entity]
			if e == nil {
				continue
			}
			ids, allowed := []int64{}, [][]any{}
			for _, row := range s.Select(e, "") {
				ids = append(ids, row.ID)
				line := []any{}
				for _, a := range rd.Actors {
					if perm == nil {
						line = append(line, true)
						continue
					}
					pc := app.ctx(s, map[string]Val{}, actorOf(a), reqOf(rd.Request, st.Clock))
					line = append(line, func() (ok any) {
						defer func() {
							if r := recover(); r != nil {
								ok = nil
							}
						}()
						return perm(pc, Ref{E: rd.Entity, ID: row.ID})
					}())
				}
				allowed = append(allowed, line)
			}
			reads[ri] = map[string]any{"ids": ids, "allowed": allowed}
		}
	}
	out, _ := json.Marshal(map[string]any{"calls": calls, "reads": reads})
	os.Stdout.Write(out)
	return 0
}

// rowValues is every stored row's field values, encoded, by entity and id.
func rowValues(app *App, s *Sess) map[string]map[int64][]string {
	out := map[string]map[int64][]string{}
	for _, name := range app.EntityOrder {
		e := app.Ents[name]
		if !e.Stored {
			continue
		}
		m := map[int64][]string{}
		for _, r := range s.Select(e, "") {
			vs := make([]string, len(e.Fields))
			for i := range e.Fields {
				b, _ := json.Marshal(r.Get(i))
				vs[i] = string(b)
			}
			m[r.ID] = vs
		}
		out[name] = m
	}
	return out
}

// changesBetween is what changed from one set of rows to the next: the entities with new rows,
// the fields of existing rows that changed, the entities with rows deleted, and whether any
// existing row was changed or deleted.
// With samePasswords, a password field counts as changed only if it is set or cleared: a
// hash is salted, so the same password stored again is a different value.
func changesBetween(app *App, a, b map[string]map[int64][]string, samePasswords bool) map[string]any {
	created, deleted := []string{}, []string{}
	updated := map[string][]string{}
	existing := false
	for _, name := range app.EntityOrder {
		before, after := a[name], b[name]
		if after == nil {
			continue
		}
		e := app.Ents[name]
		isNew, gone, fields := false, false, map[int]bool{}
		for id, vs := range after {
			o, ok := before[id]
			if !ok {
				isNew = true
				continue
			}
			for i := range vs {
				if vs[i] != o[i] && !(samePasswords && e.Fields[i].Type == "Password" && (vs[i] == "null") == (o[i] == "null")) {
					fields[i] = true
					existing = true
				}
			}
		}
		for id := range before {
			if _, ok := after[id]; !ok {
				gone = true
				existing = true
			}
		}
		if isNew {
			created = append(created, name)
		}
		if gone {
			deleted = append(deleted, name)
		}
		for i := range e.Fields {
			if fields[i] {
				updated[name] = append(updated[name], e.Fields[i].Name)
			}
		}
	}
	return map[string]any{"created": created, "updated": updated, "deleted": deleted, "existing": existing}
}

// countersFrom is the rate-limit counters in the replay's form: [[key, [times]]].
func countersFrom(list []any) map[string][]int64 {
	out := map[string][]int64{}
	for _, kv := range list {
		p, _ := kv.([]any)
		if len(p) != 2 {
			continue
		}
		hits := []int64{}
		l, _ := p[1].([]any)
		for _, t := range l {
			hits = append(hits, Num(Lift(t)))
		}
		out[Plain(p[0])] = hits
	}
	return out
}

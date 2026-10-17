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
		States []struct {
			Clock    int64          `json:"clock"`
			Seq      int64          `json:"seq"`
			Rows     map[string]any `json:"rows"`
			Defaults [][]string     `json:"defaults"`
		} `json:"states"`
		Calls []struct {
			State   int            `json:"state"`
			Name    string         `json:"name"`
			Args    map[string]any `json:"args"`
			Actor   map[string]any `json:"actor"`
			Request map[string]any `json:"request"`
			Skips   []string       `json:"skips"`
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
				row.F[i] = v
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
			app.Counters = map[string][]int64{}
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
				res := app.Run(s, call.Name, args, actorOf(call.Actor), reqOf(call.Request, st.Clock), call.Skips)
				rows := []map[string]any{}
				for _, r := range res.Rows {
					rows = append(rows, map[string]any{"ref": r.E, "id": r.ID})
				}
				if res.Rows == nil {
					return map[string]any{"outcome": res.Outcome}
				}
				return map[string]any{"outcome": res.Outcome, "rows": rows}
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

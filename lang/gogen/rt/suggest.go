package rt

// suggest-invariants: facts the data holds that the spec doesn't state, as candidate invariants.
// It reads every row (it is offline: run it on a copy), tries a few kinds of fact on each entity,
// and prints those that hold on enough rows to mean something, as JSON. What is put forward is
// only what the data shows; node lang/cli.ts suggest-invariants then proves each one against the
// spec's actions and keeps those no action can break.
//   app suggest-invariants --db <app.sqlite> [--min 5]
// The kinds of fact:
//   never none:      all(.f != none for E where true)                an optional field always set
//   none when:       all(.f != none / == none for E where .g == v)  set (or empty) whenever g is v
//   implies:         all(.h == w for E where .g == v)                one enum value fixes another
//   parent holds:    all(.r.s == w for E where true)                 the row a reference names is always so
//   has children:    all(has_F_r(it) for E where …)                  every row has a row of F that refers to it

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
)

type Suggestion struct {
	Kind      string   `json:"kind"`
	Entity    string   `json:"entity"`
	Invariant string   `json:"invariant"`       // the condition, as the spec writes it
	Needs     []string `json:"needs,omitempty"` // declarations it uses (a predicate)
	Rows      int      `json:"rows"`            // the rows it is about, all of which keep it
}

func suggestInvariants(app *App, args []string) int {
	fs := flag.NewFlagSet("suggest-invariants", flag.ExitOnError)
	dbPath := fs.String("db", "", "the database (a copy: it is only read)")
	min := fs.Int("min", 5, "the fewest rows a fact must be about")
	fs.Parse(args)
	db, err := Open(*dbPath, app.Ents)
	if err != nil {
		fmt.Fprintln(os.Stderr, "storage:", err)
		return 1
	}
	s := db.Session(app.Ents)
	defer s.Done()
	out := Suggest(app, s, *min)
	b, _ := json.MarshalIndent(out, "", "  ")
	os.Stdout.Write(b)
	return 0
}

// the values a field can be split by: an enum's or a Bool's
func (a *App) splitter(f Field) bool { _, isEnum := a.Enums[f.Type]; return isEnum || f.Kind == 'b' }

func lit(v Val) string {
	switch x := v.(type) {
	case bool:
		if x {
			return "true"
		}
		return "false"
	case string:
		return x // an enum value, written bare
	}
	return fmt.Sprint(v)
}
func cond(f Field, v Val) string {
	if b, ok := v.(bool); ok {
		if b {
			return "." + f.Name
		}
		return "not ." + f.Name
	}
	return "." + f.Name + " == " + lit(v)
}

func Suggest(a *App, s *Sess, min int) []Suggestion {
	out := []Suggestion{}
	add := func(kind, e, inv string, rows int, needs ...string) {
		out = append(out, Suggestion{Kind: kind, Entity: e, Invariant: inv, Rows: rows, Needs: needs})
	}
	names := make([]string, 0, len(a.Ents))
	for n, e := range a.Ents {
		if e.Stored && !e.Singleton {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	rows := map[string][]*Row{}
	byID := map[string]map[int64]*Row{}
	for _, n := range names {
		rows[n] = s.Select(a.Ents[n], "")
		byID[n] = map[int64]*Row{}
		for _, r := range rows[n] {
			byID[n][r.ID] = r
		}
	}
	isNone := func(v Val) bool { return v == nil }
	for _, n := range names {
		e, rs := a.Ents[n], rows[n]
		if len(rs) < min {
			continue
		}
		// the values each splitting field takes, and the rows with each
		groups := map[int]map[string][]*Row{}
		vals := map[int]map[string]Val{}
		for i, f := range e.Fields {
			if !a.splitter(f) {
				continue
			}
			groups[i], vals[i] = map[string][]*Row{}, map[string]Val{}
			for _, r := range rs {
				v := r.Get(i)
				if v == nil {
					continue
				}
				k := lit(v)
				groups[i][k] = append(groups[i][k], r)
				vals[i][k] = v
			}
		}
		splits := make([]int, 0, len(groups))
		for i := range groups {
			splits = append(splits, i)
		}
		sort.Ints(splits)
		keys := func(i int) []string {
			ks := make([]string, 0, len(groups[i]))
			for k := range groups[i] {
				ks = append(ks, k)
			}
			sort.Strings(ks)
			return ks
		}
		for i, f := range e.Fields {
			// never none, or none / set whenever a splitting field has a value
			if f.Optional {
				nones := 0
				for _, r := range rs {
					if isNone(r.Get(i)) {
						nones++
					}
				}
				if nones == 0 {
					add("never none", n, fmt.Sprintf("all(.%s != none for %s where true)", f.Name, n), len(rs))
				} else if nones < len(rs) {
					for _, g := range splits {
						if g == i || len(groups[g]) < 2 {
							continue
						}
						for _, k := range keys(g) {
							grp := groups[g][k]
							if len(grp) < min {
								continue
							}
							set, empty := 0, 0
							for _, r := range grp {
								if isNone(r.Get(i)) {
									empty++
								} else {
									set++
								}
							}
							if empty == 0 {
								add("none when", n, fmt.Sprintf("all(.%s != none for %s where %s)", f.Name, n, cond(e.Fields[g], vals[g][k])), len(grp))
							} else if set == 0 {
								add("none when", n, fmt.Sprintf("all(.%s == none for %s where %s)", f.Name, n, cond(e.Fields[g], vals[g][k])), len(grp))
							}
						}
					}
				}
			}
			// one splitting value fixes another (that takes more than one value overall)
			if a.splitter(f) && len(groups[i]) >= 2 {
				for _, g := range splits {
					if g == i || len(groups[g]) < 2 {
						continue
					}
					for _, k := range keys(g) {
						grp := groups[g][k]
						if len(grp) < min {
							continue
						}
						one, same := "", true
						for _, r := range grp {
							v := r.Get(i)
							if v == nil {
								same = false
								break
							}
							if one == "" {
								one = lit(v)
							} else if lit(v) != one {
								same = false
								break
							}
						}
						if same && one != "" {
							add("implies", n, fmt.Sprintf("all(%s for %s where %s)", cond(f, vals[i][one]), n, cond(e.Fields[g], vals[g][k])), len(grp))
						}
					}
				}
			}
			// the row a reference names always holds one value of a splitting field (which the
			// referred-to entity's rows vary in)
			if f.Kind == 'r' && byID[f.Ref] != nil {
				t := a.Ents[f.Ref]
				for j, tf := range t.Fields {
					if !a.splitter(tf) {
						continue
					}
					seen := map[string]bool{}
					for _, r := range rows[f.Ref] {
						if v := r.Get(j); v != nil {
							seen[lit(v)] = true
						}
					}
					if len(seen) < 2 {
						continue
					}
					one, same, count := "", true, 0
					var oneV Val
					for _, r := range rs {
						ref, ok := r.Get(i).(Ref)
						if !ok {
							continue
						}
						p := byID[f.Ref][ref.ID]
						if p == nil || p.Get(j) == nil {
							same = false
							break
						}
						count++
						if one == "" {
							one, oneV = lit(p.Get(j)), p.Get(j)
						} else if lit(p.Get(j)) != one {
							same = false
							break
						}
					}
					if same && count >= min {
						c := "." + f.Name + "." + tf.Name + " == " + lit(oneV)
						if b, ok := oneV.(bool); ok {
							c = "." + f.Name + "." + tf.Name
							if !b {
								c = "not " + c
							}
						}
						add("parent holds", n, fmt.Sprintf("all(%s for %s where true)", c, n), count)
					}
				}
			}
		}
	}
	// every row (or every row with a splitting value) has a child row of another entity
	for _, fn := range names {
		fe := a.Ents[fn]
		for _, f := range fe.Fields {
			if f.Kind != 'r' || rows[f.Ref] == nil {
				continue
			}
			has := map[int64]bool{}
			for _, r := range rows[fn] {
				if ref, ok := r.Get(fe.Index[f.Name]).(Ref); ok {
					has[ref.ID] = true
				}
			}
			pred := fmt.Sprintf("has_%s_%s", fn, f.Name)
			need := fmt.Sprintf("predicate %s(x: %s) = exists(%s where .%s == x)", pred, f.Ref, fn, f.Name)
			parents := rows[f.Ref]
			if len(parents) < min {
				continue
			}
			all := true
			for _, p := range parents {
				if !has[p.ID] {
					all = false
					break
				}
			}
			if all {
				add("has children", f.Ref, fmt.Sprintf("all(%s(it) for %s where true)", pred, f.Ref), len(parents), need)
				continue
			}
			t := a.Ents[f.Ref]
			for j, tf := range t.Fields {
				if !a.splitter(tf) {
					continue
				}
				grp := map[string][]*Row{}
				gv := map[string]Val{}
				for _, p := range parents {
					if v := p.Get(j); v != nil {
						grp[lit(v)] = append(grp[lit(v)], p)
						gv[lit(v)] = v
					}
				}
				if len(grp) < 2 {
					continue
				}
				ks := make([]string, 0, len(grp))
				for k := range grp {
					ks = append(ks, k)
				}
				sort.Strings(ks)
				for _, k := range ks {
					if len(grp[k]) < min {
						continue
					}
					ok := true
					for _, p := range grp[k] {
						if !has[p.ID] {
							ok = false
							break
						}
					}
					if ok {
						add("has children", f.Ref, fmt.Sprintf("all(%s(it) for %s where %s)", pred, f.Ref, cond(tf, gv[k])), len(grp[k]), need)
					}
				}
			}
		}
	}
	return out
}

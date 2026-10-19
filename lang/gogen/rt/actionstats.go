package rt

// Per-action statistics, for finding what an action costs (CRUDSPEC_ACTION_STATS=1): calls, time,
// the SQL statements each call runs, and the statements a single call runs more than once. Shown
// at /_test/action-stats (with --test). Off, it costs one boolean test per statement.

import (
	"os"
	"sort"
	"sync"
	"time"
)

var ActionStatsOn = os.Getenv("CRUDSPEC_ACTION_STATS") != ""

type actionStat struct {
	Calls   int            `json:"calls"`
	Nanos   int64          `json:"ns"`
	Stmts   int            `json:"stmts"`
	Repeats map[string]int `json:"repeats"` // SQL -> the times calls ran it beyond once
	Max     int            `json:"max_stmts"`
	Last    []string       `json:"last"` // the most recent call's statements, in order
	MinNs   int64          `json:"min_ns"`
	MaxNs   int64          `json:"max_ns"`
}

var actionStats = struct {
	sync.Mutex
	m map[string]*actionStat
}{m: map[string]*actionStat{}}

func (s *Sess) countStmt(q string) {
	if s.stmtLog != nil {
		*s.stmtLog = append(*s.stmtLog, q)
	}
}

// trackAction starts counting a call's statements; the returned func records them
func trackAction(s *Sess, name string) func() {
	if !ActionStatsOn {
		return func() {}
	}
	log := []string{}
	s.stmtLog = &log
	t0 := time.Now()
	return func() {
		s.stmtLog = nil
		actionStats.Lock()
		defer actionStats.Unlock()
		st := actionStats.m[name]
		if st == nil {
			st = &actionStat{Repeats: map[string]int{}}
			actionStats.m[name] = st
		}
		st.Calls++
		st.Last = log
		d := time.Since(t0).Nanoseconds()
		st.Nanos += d
		if st.MinNs == 0 || d < st.MinNs {
			st.MinNs = d
		}
		if d > st.MaxNs {
			st.MaxNs = d
		}
		st.Stmts += len(log)
		if len(log) > st.Max {
			st.Max = len(log)
		}
		seen := map[string]int{}
		for _, q := range log {
			seen[q]++
		}
		for q, n := range seen {
			if n > 1 {
				st.Repeats[q] += n - 1
			}
		}
	}
}

// ActionStats is the table, actions by total time
func ActionStats() []map[string]any {
	actionStats.Lock()
	defer actionStats.Unlock()
	out := []map[string]any{}
	for n, st := range actionStats.m {
		type rep struct {
			SQL string `json:"sql"`
			N   int    `json:"extra"`
		}
		reps := []rep{}
		for q, k := range st.Repeats {
			reps = append(reps, rep{q, k})
		}
		sort.Slice(reps, func(i, j int) bool { return reps[i].N > reps[j].N })
		out = append(out, map[string]any{"action": n, "calls": st.Calls, "us_per_call": st.Nanos / int64(st.Calls) / 1000, "stmts_per_call": float64(st.Stmts) / float64(st.Calls), "max_stmts": st.Max, "repeats": reps, "last": st.Last, "min_us": st.MinNs / 1000, "max_us": st.MaxNs / 1000})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["stmts_per_call"].(float64) > out[j]["stmts_per_call"].(float64) })
	return out
}

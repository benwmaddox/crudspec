package rt

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // named zones, whatever the host has
)

// Schedules: a spec's `schedule` declarations, run by the server when their time comes.
//
// A schedule for rows (`for x in E where c at x.f + d past_due fire|skip`) runs its action once
// for each row and each time value: a marker keeps (schedule, row, the time it ran for), so when
// the row's time moves (a new message, an edited send time) the row is due again, and a deleted
// row never runs. The where is read when the time comes; if it doesn't hold, that time passes.
// A period schedule (`every day at "08:00" in "Zone"`, `every 15 min`) runs once per period;
// when periods were missed (the server was down), only the latest runs.
//
// Each run is one transaction: the action's writes and its marker commit together, through the
// normal commit (live pages and the cache see it), and its events go to the workflows after it.
// A run refused by a require is logged and marked, so it isn't tried again for that time.

type Schedule struct {
	Name, Action         string
	Entity, Bind, Column string            // rows: the entity, the action's parameter, the Time field (or created/updated)
	OffsetMS             int64             // at x.f + this
	PastDueFire          bool              // rows already past due when the schedule is first deployed run (else only later times)
	At                   func(c *Ctx) Val  // the row's time, offset included (at x.f + d), read in the run's transaction
	Where                func(c *Ctx) bool // the row's condition, read then too
	Daily, Zone          string            // every day at Daily ("08:00") in Zone (none: the server's zone)
	PeriodMS             int64             // every PeriodMS
	since                int64             // when it was first deployed (crudspec_schedules)
	ready                bool              // it has looked at every row since the server started: next, only what's new
	checked              int64             // the time it last looked up to
	pending              map[int64]bool    // the rows written since it last looked
}

const scheduleBatch = 100 // rows per schedule per tick: a long fan-out doesn't hold the writer

var schedTables = []string{
	`CREATE TABLE IF NOT EXISTS crudspec_schedules (name TEXT PRIMARY KEY, since INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS crudspec_schedule_runs (schedule TEXT NOT NULL, row INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (schedule, row))`,
}

// prepareSchedules makes the schedules' tables and records when each was first deployed.
func (a *App) prepareSchedules() {
	if len(a.Schedules) == 0 {
		return
	}
	a.DB.mu.Lock()
	defer a.DB.mu.Unlock()
	for _, q := range schedTables {
		if err := a.DB.W.Exec(q); err != nil {
			panic(err)
		}
	}
	now := a.Clock()
	for _, sc := range a.Schedules {
		a.DB.W.Exec(`INSERT OR IGNORE INTO crudspec_schedules (name, since) VALUES (?, ?)`, sc.Name, now)
		a.DB.W.QueryRow(`SELECT since FROM crudspec_schedules WHERE name = ?`, sc.Name).Scan(&sc.since)
		if sc.Entity != "" {
			a.DB.Watch.watch(sc.Entity)
		}
	}
}

// ResetSchedules forgets every run and deploys the schedules again now (a test load), in the
// session's write (it takes the writer if it hasn't). Its caller holds the schedules.
func (a *App) ResetSchedules(s *Sess) {
	if len(a.Schedules) == 0 {
		return
	}
	s.Write()
	for _, q := range schedTables {
		s.execRaw(q)
	}
	s.execRaw(`DELETE FROM crudspec_schedule_runs`)
	s.execRaw(`DELETE FROM crudspec_schedules`)
	now := a.Clock()
	for _, sc := range a.Schedules {
		s.exec(`INSERT INTO crudspec_schedules (name, since) VALUES (?, ?)`, sc.Name, now)
		sc.since = now
		sc.ready, sc.pending = false, nil // every row looked at again
		if sc.Entity != "" {
			a.DB.Watch.watch(sc.Entity)
		}
	}
	a.DB.Watch.take()
}

// One pass at a time: the ticker's, or a test's clock advance. It's taken before the database's
// writer, never after it: a spec test, which holds the writer as it runs, holds this from its start
// (HoldSchedules), so the ticker can't take it and then wait for the writer the test holds.
var schedMu sync.Mutex

// HoldSchedules keeps the ticker from running due work until the returned func is called: a spec
// test or a test load holds it, before it takes the writer, for as long as it moves the clock and
// resets the schedules.
func HoldSchedules() func() { schedMu.Lock(); return schedMu.Unlock }

// RunDue runs every schedule's due work, and returns the events its runs emitted.
func (a *App) RunDue(req *Request) []Event { return a.runDue(req, nil) }

// RunDueIn is RunDue in a session that holds the writer already (a spec test's, whose wait moves
// the clock): each run is a savepoint of it, and the due rows are read on its writer. Its caller
// holds the schedules (HoldSchedules).
func (a *App) RunDueIn(s *Sess, req *Request) []Event { return a.runDue(req, s) }

func (a *App) runDue(req *Request, in *Sess) []Event {
	if in == nil {
		schedMu.Lock()
		defer schedMu.Unlock()
	}
	var events []Event
	now := a.Clock()
	written, unknown := a.DB.Watch.take()
	for _, sc := range a.Schedules {
		if sc.Entity != "" {
			sc.noteWritten(written[sc.Entity], unknown)
			done := false
			for {
				ids, ats, ok := a.dueRows(sc, now, in != nil)
				for i, id := range ids {
					events = append(events, a.runScheduled(sc, Obj{sc.Bind: id}, id, ats[i], req, in)...)
				}
				if !ok {
					break // tried again next tick, with what it was given to look at
				}
				if len(ids) < scheduleBatch {
					done = true
					break
				}
			}
			if done { // everything due by now has run: next time, only what came due or was written since
				sc.ready, sc.checked, sc.pending = true, now, nil
			}
			continue
		}
		if at := sc.periodDue(now); at > sc.since && a.lastRun(sc.Name, in != nil) != at {
			events = append(events, a.runScheduled(sc, Obj{}, 0, at, req, in)...)
		}
	}
	return events
}

// What a row schedule reads to find what's due. The first time after the server starts (or a test
// load, or a commit that couldn't say what it wrote, as an import), every row: what came due
// while it was down. After that, only the rows whose time came since it last looked (an index
// range on the time column) and the rows commits wrote since (a new row, or one whose time or
// condition changed, its time perhaps already past): so a tick costs what's new, not the table.
// The where is read in the run, as before, so a row whose condition doesn't hold when its time
// comes is marked and that time passes.

// SchedWatch keeps the ids of the rows of the schedules' entities that commits wrote
type SchedWatch struct {
	mu      sync.Mutex
	ents    map[string]bool
	ids     map[string]map[int64]bool
	unknown bool // a commit that couldn't say what it wrote: read everything again
}

func (w *SchedWatch) watch(entity string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.ents == nil {
		w.ents = map[string]bool{}
	}
	w.ents[entity] = true
}

// note: a commit's keys (publish), the row keys of the watched entities kept
func (w *SchedWatch) note(keys Deps, all bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.ents) == 0 {
		return
	}
	if all {
		w.unknown = true
		return
	}
	for _, k := range keys {
		if k.K != 'r' || !w.ents[k.E] {
			continue
		}
		if w.ids == nil {
			w.ids = map[string]map[int64]bool{}
		}
		if w.ids[k.E] == nil {
			w.ids[k.E] = map[int64]bool{}
		}
		w.ids[k.E][k.ID] = true
	}
}

// take gives what was noted since the last take, and forgets it
func (w *SchedWatch) take() (map[string]map[int64]bool, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	ids, unknown := w.ids, w.unknown
	w.ids, w.unknown = nil, false
	return ids, unknown
}

// pendingMax: past this many written rows to look at, reading the table once is the cheaper way
const pendingMax = 50_000

// noteWritten adds the rows commits wrote to what the next look reads
func (sc *Schedule) noteWritten(ids map[int64]bool, unknown bool) {
	if unknown {
		sc.ready, sc.pending = false, nil
	}
	if !sc.ready {
		return
	}
	if sc.pending == nil {
		sc.pending = map[int64]bool{}
	}
	for id := range ids {
		sc.pending[id] = true
	}
	if len(sc.pending) > pendingMax {
		sc.ready, sc.pending = false, nil
	}
}

// the time column, as milliseconds
func (sc *Schedule) col() string {
	if sc.Column == "created" || sc.Column == "updated" {
		return `t0."` + sc.Column + `"`
	}
	return `t0."` + strings.ReplaceAll(sc.Column, `"`, `""`) + `"` // INTEGER milliseconds
}

// dueRows: the rows whose time has come and hasn't run, oldest first (held: the caller's session
// holds the writer already); ok false when the query failed
func (a *App) dueRows(sc *Schedule, now int64, held bool) ([]int64, []int64, bool) {
	col, off := sc.col(), sc.OffsetMS
	upTo := col + ` <= ?` // the column, not the column plus the offset, so its index serves
	var cond string
	var args []any
	if sc.ready && now >= sc.checked {
		// what came due since it last looked, or was written since (and is due)
		cond = `((` + col + ` > ? AND ` + upTo + `)`
		args = append(args, sc.checked-off, now-off)
		if len(sc.pending) > 0 {
			list := make([]int64, 0, len(sc.pending))
			for id := range sc.pending {
				list = append(list, id)
			}
			b, _ := json.Marshal(list)
			cond += ` OR (t0.id IN (SELECT value FROM json_each(?)) AND ` + upTo + `)`
			args = append(args, string(b), now-off)
		}
		cond += `)`
	} else {
		sc.ready = false
		cond = col + ` IS NOT NULL AND ` + upTo
		args = append(args, now-off)
	}
	if !sc.PastDueFire {
		cond += ` AND ` + col + ` > ?`
		args = append(args, sc.since-off)
	}
	t := col + " + " + strconv.FormatInt(off, 10)
	q := `SELECT t0.id, ` + t + ` FROM "` + sc.Entity + `" t0 WHERE ` + cond +
		` AND NOT EXISTS (SELECT 1 FROM crudspec_schedule_runs r WHERE r.schedule = ? AND r.row = t0.id AND r.at = ` + t + `) ORDER BY 2, 1 LIMIT ` + strconv.Itoa(scheduleBatch)
	args = append(args, sc.Name)
	if !held {
		a.DB.mu.Lock()
		defer a.DB.mu.Unlock()
	}
	rows, err := a.DB.W.Query(q, args...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "schedule %s: %v\n", sc.Name, err)
		return nil, nil, false
	}
	defer rows.Close()
	var ids, ats []int64
	for rows.Next() {
		var id, at int64
		rows.Scan(&id, &at)
		ids, ats = append(ids, id), append(ats, at)
	}
	return ids, ats, true
}

// periodDue is the latest period start at or before now.
func (sc *Schedule) periodDue(now int64) int64 {
	if sc.PeriodMS > 0 {
		return sc.since + (now-sc.since)/sc.PeriodMS*sc.PeriodMS
	}
	loc := time.Local
	if sc.Zone != "" {
		if l, err := time.LoadLocation(sc.Zone); err == nil {
			loc = l
		}
	}
	hh, _ := strconv.Atoi(sc.Daily[:2])
	mm, _ := strconv.Atoi(sc.Daily[3:])
	t := time.UnixMilli(now).In(loc)
	occ := time.Date(t.Year(), t.Month(), t.Day(), hh, mm, 0, 0, loc)
	if occ.After(t) {
		occ = time.Date(t.Year(), t.Month(), t.Day()-1, hh, mm, 0, 0, loc)
	}
	return occ.UnixMilli()
}

func (a *App) lastRun(name string, held bool) int64 {
	var at int64 = -1
	if !held {
		a.DB.mu.Lock()
		defer a.DB.mu.Unlock()
	}
	a.DB.W.QueryRow(`SELECT at FROM crudspec_schedule_runs WHERE schedule = ? AND row = 0`, name).Scan(&at)
	return at
}

// runScheduled runs the schedule's action for one row (or period) in one transaction with its
// marker, after reading the row's time and condition again; it gives the run's events. in: a
// session to run it in (a spec test's), as a savepoint of what it holds; else one of its own.
func (a *App) runScheduled(sc *Schedule, raw Obj, row, at int64, req *Request, in *Sess) (events []Event) {
	act := a.Actions[sc.Action]
	s := in
	if s == nil {
		s = a.DB.Session(a.Ents)
		defer s.Done()
	}
	mark := func() {
		s.exec(`INSERT INTO crudspec_schedule_runs (schedule, row, at) VALUES (?, ?, ?) ON CONFLICT(schedule, row) DO UPDATE SET at = excluded.at`, sc.Name, row, at)
	}
	began := false
	defer func() {
		if r := recover(); r != nil {
			if began {
				s.Rollback()
			}
			why := fmt.Sprint(r)
			if o, ok := r.(*Outcome); ok {
				why = o.O + " (" + o.Msg + ")"
			}
			fmt.Fprintf(os.Stderr, "schedule %s: row %d at %d: %s\n", sc.Name, row, at, why)
			s.Begin() // marked, so it isn't tried again for this time
			mark()
			s.Commit()
			events = nil
		}
	}()
	s.Begin()
	began = true
	c := a.ctx(s, nil, nil, req)
	pa, pn, pc := s.Actor, s.Action, s.Clock
	s.Actor, s.Action, s.Clock = nil, "schedule "+sc.Name, c.Now
	defer func() { s.Actor, s.Action, s.Clock = pa, pn, pc }()
	c.Vars = act.Bind(raw, s)
	if sc.Entity != "" {
		// the row as it is now: still there, still due at this time, and its condition holds
		t, ok := sc.At(c).(Time)
		if !ok || t.T != at || !sc.Where(c) {
			mark()
			s.Commit()
			return nil
		}
	}
	logAt := len(s.Log)
	act.Body(c)
	if a.Invariants != nil {
		a.Invariants(c, s.Log[logAt:])
	}
	mark()
	s.Commit()
	began = false
	return *c.Events
}

// tick runs due work every second while the server runs.
func (sv *Server) runSchedules() {
	if len(sv.App.Schedules) == 0 {
		return
	}
	go func() {
		for range time.Tick(time.Second) {
			sv.runDueNow(false)
		}
	}()
}

// runDueNow runs due work; wait: the workflows its events start run before it returns (a
// test's clock advance), otherwise after, as an action's do.
func (sv *Server) runDueNow(wait bool) {
	defer func() {
		if x := recover(); x != nil {
			fmt.Fprintf(os.Stderr, "schedule error: %s\n", failure(x))
		}
	}()
	req := &Request{Method: "write", Base: sv.App.PublicBase}
	events := sv.App.RunDue(req)
	if wait {
		sv.App.RunWorkflows(events, req, sv.Externs)
	} else {
		sv.afterCommit(events, req)
	}
}

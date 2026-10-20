package rt

import (
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
	}
}

// ResetSchedules forgets every run and deploys the schedules again now (a test load), in the
// session's write (it takes the writer if it hasn't).
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
	}
}

var schedMu sync.Mutex // one pass at a time: the ticker's, or a test's clock advance

// RunDue runs every schedule's due work, and returns the events its runs emitted.
func (a *App) RunDue(req *Request) []Event {
	schedMu.Lock()
	defer schedMu.Unlock()
	var events []Event
	now := a.Clock()
	for _, sc := range a.Schedules {
		if sc.Entity != "" {
			for {
				ids, ats := a.dueRows(sc, now)
				for i, id := range ids {
					events = append(events, a.runScheduled(sc, Obj{sc.Bind: id}, id, ats[i], req)...)
				}
				if len(ids) < scheduleBatch {
					break
				}
			}
			continue
		}
		if at := sc.periodDue(now); at > sc.since && a.lastRun(sc.Name) != at {
			events = append(events, a.runScheduled(sc, Obj{}, 0, at, req)...)
		}
	}
	return events
}

// the time column, as milliseconds
func (sc *Schedule) col() string {
	if sc.Column == "created" || sc.Column == "updated" {
		return `t."` + sc.Column + `"`
	}
	return `t."` + strings.ReplaceAll(sc.Column, `"`, `""`) + `"` // INTEGER milliseconds
}

// dueRows: the rows whose time has come and hasn't run, oldest first.
func (a *App) dueRows(sc *Schedule, now int64) ([]int64, []int64) {
	t := sc.col() + " + " + strconv.FormatInt(sc.OffsetMS, 10)
	q := `SELECT t.id, ` + t + ` FROM "` + sc.Entity + `" t WHERE ` + sc.col() + ` IS NOT NULL AND ` + t + ` <= ?`
	args := []any{now}
	if !sc.PastDueFire {
		q += ` AND ` + t + ` > ?`
		args = append(args, sc.since)
	}
	q += ` AND NOT EXISTS (SELECT 1 FROM crudspec_schedule_runs r WHERE r.schedule = ? AND r.row = t.id AND r.at = ` + t + `) ORDER BY 2, 1 LIMIT ` + strconv.Itoa(scheduleBatch)
	args = append(args, sc.Name)
	a.DB.mu.Lock()
	defer a.DB.mu.Unlock()
	rows, err := a.DB.W.Query(q, args...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "schedule %s: %v\n", sc.Name, err)
		return nil, nil
	}
	defer rows.Close()
	var ids, ats []int64
	for rows.Next() {
		var id, at int64
		rows.Scan(&id, &at)
		ids, ats = append(ids, id), append(ats, at)
	}
	return ids, ats
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

func (a *App) lastRun(name string) int64 {
	var at int64 = -1
	a.DB.mu.Lock()
	defer a.DB.mu.Unlock()
	a.DB.W.QueryRow(`SELECT at FROM crudspec_schedule_runs WHERE schedule = ? AND row = 0`, name).Scan(&at)
	return at
}

// runScheduled runs the schedule's action for one row (or period) in one transaction with its
// marker, after reading the row's time and condition again; it gives the run's events.
func (a *App) runScheduled(sc *Schedule, raw Obj, row, at int64, req *Request) (events []Event) {
	act := a.Actions[sc.Action]
	s := a.DB.Session(a.Ents)
	defer s.Done()
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

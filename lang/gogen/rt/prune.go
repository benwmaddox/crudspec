package rt

import (
	"os"
	"strconv"
	"strings"
	"sync"
)

// Column pruning: a page reads only the columns it shows. The generator works out, for each
// screen, which fields of each entity its render can read (the screen, its layout, the
// components it shows, the functions and predicates they call, and what every page reads: the
// read permissions, gates, identity, displays, avatars and theme), as a bit per field
// (Screen.Mask). While the page renders, its session selects only those columns, and the
// generated ScanMask reads them; the other fields are left empty.
//
// A mask holds only while the session doesn't write: Write drops every row read before it,
// and a writing session reads whole rows (its saves compare them). The rows read under a mask
// are dropped when the render ends (EndMask), so none reaches anything else.
//
// CRUDSPEC_PRUNE=0 turns pruning off, for comparing a page's HTML with and without it;
// CRUDSPEC_PRUNE=check marks the text fields left out (PruneCheck).

var pruneOff = os.Getenv("CRUDSPEC_PRUNE") == "0"

// PruneCheck (CRUDSPEC_PRUNE=check): a text field left out holds Pruned, which no page should
// show; the test runs look for it.
var PruneCheck = os.Getenv("CRUDSPEC_PRUNE") == "check"

const Pruned = "⟦pruned⟧"

// PruneOn says whether pages prune their columns.
func PruneOn() bool { return !pruneOff }

// BeginMask makes the session select only the columns m says, entity by entity (an entity
// that isn't in m reads whole rows).
func (s *Sess) BeginMask(m map[string]uint64) {
	if pruneOff || m == nil {
		return
	}
	s.mask = m
}

// EndMask ends a mask: the rows read under it (in part) are dropped, as are the answers that
// hold them.
func (s *Sess) EndMask() {
	if s.mask == nil {
		return
	}
	s.mask = nil
	if !s.writing {
		s.ident = map[rowKey]*Row{}
		s.firsts = map[string]*Row{}
		s.memo, s.counts = nil, nil
		s.kept, s.keptN = nil, nil
	}
}

// maskOf is the fields to read of e, while a mask holds.
func (s *Sess) maskOf(e *Entity) (uint64, bool) {
	if s.mask == nil || s.writing || e.ScanMask == nil {
		return 0, false
	}
	m, ok := s.mask[e.Name]
	if !ok || m == e.fullMask() {
		return 0, false
	}
	return m, true
}

// cols is the SELECT list of e for this session.
func (s *Sess) cols(e *Entity) string {
	if m, ok := s.maskOf(e); ok {
		return e.colsFor(m)
	}
	return e.Cols
}

// scanRow reads one row of e, as cols selected it.
func (s *Sess) scanRow(e *Entity, st *Stmt) *Row {
	if m, ok := s.maskOf(e); ok {
		return e.ScanMask(st, m)
	}
	return e.Scan(st)
}

// SQL is a generated statement's SQL for this session: a statement that selects e's whole row
// (SELECT <e.Cols> …) selects the mask's columns instead.
func (s *Sess) SQL(e *Entity, q string) string {
	m, ok := s.maskOf(e)
	if !ok {
		return q
	}
	k := strconv.FormatUint(m, 16) + "\x00" + q
	if v, ok := e.pruned.Load(k); ok {
		return v.(string)
	}
	out := q
	if head := "SELECT " + e.Cols + " "; strings.HasPrefix(q, head) {
		out = "SELECT " + e.colsFor(m) + " " + q[len(head):]
	}
	e.pruned.Store(k, out)
	return out
}

// fullMask is every field's bit.
func (e *Entity) fullMask() uint64 {
	if len(e.Fields) >= 64 {
		return ^uint64(0)
	}
	return 1<<len(e.Fields) - 1
}

// colsFor is the SELECT list of id, seq, created, updated and the fields m says, in spec order.
func (e *Entity) colsFor(m uint64) string {
	if v, ok := e.pruned.Load(m); ok {
		return v.(string)
	}
	var b strings.Builder
	b.WriteString("t0.id, t0.seq, t0.created, t0.updated")
	for i, cs := range e.FieldCols {
		if i < 64 && m&(1<<i) != 0 {
			for _, c := range cs {
				b.WriteString(", t0.")
				b.WriteString(c)
			}
		}
	}
	e.pruned.Store(m, b.String())
	return b.String()
}

// (the column lists and statements made for masks, by mask and by statement)
type prunedCache = sync.Map

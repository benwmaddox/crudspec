package rt

import "testing"

// A where anchors a query's rows to a value (so a sum over them is told of any change to them by
// that value's key) only through the query's own row, in a top-level AND: not under an OR, and not
// through a subquery of the same table.
func TestWhereAnchor(t *testing.T) {
	anchor := func(where string) bool {
		keys := whereKeys("Expense", where)
		return len(keys) > 0 && keys[0].table == "Expense" && keys[0].col != ""
	}
	for _, c := range []struct {
		where string
		want  bool
	}{
		{`(t0."owner" = ?)`, true},
		{`(t0."owner" = ?) AND (t0."amount" > ?)`, true},
		{`((t0."owner" = ?) OR (t0."shared" = 1))`, false},
		{`(NOT (t0."owner" = ?))`, false},
		{`(EXISTS (SELECT 1 FROM "Expense" x WHERE x."owner" = ? AND x.id = t0."parent"))`, false},
		{``, false},
	} {
		if got := anchor(c.where); got != c.want {
			t.Errorf("%s: anchored %v, want %v (keys %+v)", c.where, got, c.want, whereKeys("Expense", c.where))
		}
	}
}

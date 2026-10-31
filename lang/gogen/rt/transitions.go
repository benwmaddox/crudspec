package rt

import (
	"fmt"
	"math"
)

// Move refuses a set of an enum field to a value its entity's transitions block doesn't allow from
// the value it has. Setting a field to the value it has is always allowed, and a field that holds no
// value yet (a row from before the field, or an optional one never set) may move anywhere, and none is
// no state, so a field can't be set to it. An
// upgrade's data migrations are exempt (Ctx.NoTransitions): they repair data as written.
func (c *Ctx) Move(entity, field string, from, to Val, table map[string][]string) {
	if c.NoTransitions || from == nil && to == nil {
		return
	}
	// none is no state: a field with transitions can't be emptied (a row with no value yet may start anywhere)
	if to == nil {
		Refuse("invalid", fmt.Sprintf("%s.%s may not be set to none", entity, field), "transition")
	}
	if from == nil {
		return
	}
	f, t := AsStr(from), AsStr(to)
	if f == t {
		return
	}
	for _, x := range table[f] {
		if x == t {
			return
		}
	}
	Refuse("invalid", fmt.Sprintf("%s.%s may not move from %s to %s", entity, field, f, t), "transition")
}

// SumOf adds the Ints a query's rows gave (sum(.f for E where p)); a row with none adds nothing,
// no rows add up to 0, and a sum past int64 refuses, as SQLite's SUM does.
func SumOf(vals Val) Val {
	total, _ := foldInts(vals)
	return total
}

// AvgOf is their mean in whole numbers, truncated toward zero (SUM/COUNT in SQL): none when no
// row gave an Int.
func AvgOf(vals Val) Val {
	total, n := foldInts(vals)
	if n == 0 {
		return nil
	}
	return total / n
}

func foldInts(vals Val) (int64, int64) {
	var total, n int64
	list, _ := vals.(List)
	for _, v := range list {
		if v == nil {
			continue
		}
		x := Num(v)
		if (x > 0 && total > math.MaxInt64-x) || (x < 0 && total < math.MinInt64-x) {
			Refuse("invalid", "a sum is past what a whole number holds", "overflow")
		}
		total += x
		n++
	}
	return total, n
}

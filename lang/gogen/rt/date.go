package rt

// Date: a calendar day (a birthdate, a booking's first day), with no time and no zone. D is the
// day's number since 1970-01-01 (negative before it), which is what is stored (an INTEGER),
// compared and subtracted. A day from an instant (today(), date_of(t)) is the day it is in the
// app's time zone (app … { time_zone "America/New_York" }; UTC when not said).

import (
	"math/big"
	"strconv"
	"strings"
	"time"
)

type Date struct{ D int64 }

// Zone is the app's time zone, for the day an instant falls on
var Zone = time.UTC

// SetZone is the app's time_zone (the generated program sets it as it starts)
func SetZone(name string) {
	if name == "" {
		return
	}
	if l, err := time.LoadLocation(name); err == nil {
		Zone = l
	}
}

func dayOf(t time.Time) Date {
	y, m, d := t.Date()
	return Date{D: time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / 86400}
}

// civil is the day's year, month and day
func (d Date) civil() (int, time.Month, int) { return time.Unix(d.D*86400, 0).UTC().Date() }

// MinDay and MaxDay are 0001-01-01 and 9999-12-31: a date is written YYYY-MM-DD, so a calendar
// step past them refuses the call (it would make a date no form, file or page could hold)
const MinDay, MaxDay = -719162, 2932896

func inRange(d Date) Date {
	if d.D < MinDay || d.D > MaxDay {
		Refuse("invalid", "date out of range (years 1 to 9999)", "date")
	}
	return d
}

// AddDays is n days on (refusing a date past year 9999 or before year 1)
func AddDays(d Date, n int64) Date {
	if n > MaxDay-MinDay || n < MinDay-MaxDay {
		Refuse("invalid", "date out of range (years 1 to 9999)", "date")
	}
	return inRange(Date{D: d.D + n})
}

// MakeDate is the date of year, month, day; a day that doesn't exist (Feb 30) refuses the call
func MakeDate(y, m, dd int64) Date {
	if y < 1 || y > 9999 {
		Refuse("invalid", "date out of range (years 1 to 9999)", "date")
	}
	t := time.Date(int(y), time.Month(m), int(dd), 0, 0, 0, 0, time.UTC)
	if m < 1 || m > 12 || dd < 1 || t.Day() != int(dd) {
		Refuse("invalid", "no such date: "+strconv.FormatInt(y, 10)+"-"+strconv.FormatInt(m, 10)+"-"+strconv.FormatInt(dd, 10), "date")
	}
	return dayOf(t)
}

// ParseDate reads 2026-11-18 (ISO); ok is false for anything else
func ParseDate(s string) (Date, bool) {
	t, err := time.Parse("2006-01-02", strings.TrimSpace(s))
	if err != nil {
		return Date{}, false
	}
	return dayOf(t), true
}

func (d Date) String() string { return time.Unix(d.D*86400, 0).UTC().Format("2006-01-02") }
func (d Date) MarshalJSON() ([]byte, error) {
	return []byte(`{"date":"` + d.String() + `"}`), nil
}

// DateOf is the day an instant falls on, in the app's zone
func DateOf(t Time) Date { return dayOf(time.UnixMilli(t.T).In(Zone)) }

// StartOfDay and EndOfDay are a day's first and last millisecond, in the app's zone
func StartOfDay(d Date) Time {
	y, m, dd := d.civil()
	return Time{T: time.Date(y, m, dd, 0, 0, 0, 0, Zone).UnixMilli()}
}
func EndOfDay(d Date) Time {
	y, m, dd := d.civil()
	return Time{T: time.Date(y, m, dd+1, 0, 0, 0, 0, Zone).UnixMilli() - 1, Seq: MaxSeq}
}

// AddMonths is d moved by n months, kept to the last day of a shorter month (Jan 31 + 1 month is
// Feb 28 or 29), as relativedelta does
func AddMonths(d Date, n int64) Date {
	y, m, dd := d.civil()
	if n > 12*10000 || n < -12*10000 {
		Refuse("invalid", "date out of range (years 1 to 9999)", "date")
	}
	total := int64(y)*12 + int64(m-1) + n
	ny, nm := total/12, time.Month(total%12+1)
	if total%12 < 0 {
		ny, nm = (total-11)/12, time.Month((total%12+12)%12+1)
	}
	last := time.Date(int(ny), nm+1, 0, 0, 0, 0, 0, time.UTC).Day()
	if dd > last {
		dd = last
	}
	return inRange(dayOf(time.Date(int(ny), nm, dd, 0, 0, 0, 0, time.UTC)))
}

// MonthsBetween is the whole months from a to b (negative when b is before a), as relativedelta
// counts them: Jan 15 to Feb 15 is 1, and Jan 31 to Feb 28 is 1 too (Jan 31 + 1 month is Feb 28),
// Jan 31 to Feb 27 is 0
func MonthsBetween(a, b Date) int64 {
	if b.D < a.D {
		return -MonthsBetween(b, a)
	}
	ay, am, _ := a.civil()
	by, bm, _ := b.civil()
	n := int64(by-ay)*12 + int64(bm-am)
	if AddMonths(a, n).D > b.D {
		n--
	}
	return n
}

// Weekday is 1 for Monday to 7 for Sunday (ISO 8601)
func Weekday(d Date) int64 {
	w := int64(time.Unix(d.D*86400, 0).UTC().Weekday())
	if w == 0 {
		return 7
	}
	return w
}

// FormatDate writes a day by a pattern: YYYY 2026, YY 26, MMMM November, MMM Nov, MM 11, M 11,
// DD 08, D 8, dddd Wednesday, ddd Wed; other characters as they are
func FormatDate(d Date, pattern string) string {
	y, m, dd := d.civil()
	wd := time.Unix(d.D*86400, 0).UTC().Weekday()
	tokens := []struct{ k, v string }{
		{"YYYY", strconv.Itoa(y)}, {"YY", pad2(y % 100)}, {"MMMM", m.String()}, {"MMM", m.String()[:3]},
		{"MM", pad2(int(m))}, {"M", strconv.Itoa(int(m))}, {"DD", pad2(dd)}, {"D", strconv.Itoa(dd)},
		{"dddd", wd.String()}, {"ddd", wd.String()[:3]},
	}
	var b strings.Builder
	for i := 0; i < len(pattern); {
		matched := false
		for _, t := range tokens {
			if strings.HasPrefix(pattern[i:], t.k) {
				b.WriteString(t.v)
				i += len(t.k)
				matched = true
				break
			}
		}
		if !matched {
			b.WriteByte(pattern[i])
			i++
		}
	}
	return b.String()
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// AsDate is a value as a Date: a Date, ISO text, or (an instant) the day it falls on; none stays
func AsDate(v Val) (Date, bool) {
	switch x := v.(type) {
	case Date:
		return x, true
	case string:
		return ParseDate(x)
	case Time:
		return DateOf(x), true
	}
	return Date{}, false
}

// BindDate is a Date parameter: from a form's YYYY-MM-DD, an agent's JSON or a value; empty is
// none, and text that isn't a date refuses the call
func BindDate(v Val) Val {
	if v == nil {
		return nil
	}
	if s, ok := v.(string); ok && strings.TrimSpace(s) == "" {
		return nil
	}
	d, ok := AsDate(v)
	if !ok {
		Refuse("invalid", "not a date (YYYY-MM-DD): "+Plain(v), "date")
	}
	return d
}

// ---- the calendar's builtins

func dateArg(a []Val, i int) (Date, bool) { return AsDate(arg(a, i)) }

func B_today(c *Ctx, a ...Val) Val { return DateOf(Time{T: c.Now()}) }
func B_date(c *Ctx, a ...Val) Val {
	if arg(a, 0) == nil || arg(a, 1) == nil || arg(a, 2) == nil {
		return nil
	}
	return MakeDate(Num(arg(a, 0)), Num(arg(a, 1)), Num(arg(a, 2)))
}
func B_to_date(c *Ctx, a ...Val) Val {
	if d, ok := ParseDate(Plain(arg(a, 0))); ok {
		return d
	}
	return nil
}
func B_date_of(c *Ctx, a ...Val) Val {
	if t, ok := arg(a, 0).(Time); ok {
		return DateOf(t)
	}
	return nil
}
func onDate(a []Val, f func(Date) Val) Val {
	if d, ok := dateArg(a, 0); ok {
		return f(d)
	}
	return nil
}
func B_year(c *Ctx, a ...Val) Val {
	return onDate(a, func(d Date) Val { y, _, _ := d.civil(); return int64(y) })
}
func B_month(c *Ctx, a ...Val) Val {
	return onDate(a, func(d Date) Val { _, m, _ := d.civil(); return int64(m) })
}
func B_day(c *Ctx, a ...Val) Val {
	return onDate(a, func(d Date) Val { _, _, dd := d.civil(); return int64(dd) })
}
func B_weekday(c *Ctx, a ...Val) Val { return onDate(a, func(d Date) Val { return Weekday(d) }) }
func B_add_days(c *Ctx, a ...Val) Val {
	return onDate(a, func(d Date) Val { return AddDays(d, Num(arg(a, 1))) })
}
func B_add_months(c *Ctx, a ...Val) Val {
	return onDate(a, func(d Date) Val { return AddMonths(d, Num(arg(a, 1))) })
}
func B_add_years(c *Ctx, a ...Val) Val {
	return onDate(a, func(d Date) Val {
		n := Num(arg(a, 1))
		if n > 10000 || n < -10000 {
			Refuse("invalid", "date out of range (years 1 to 9999)", "date")
		}
		return AddMonths(d, 12*n)
	})
}
func between(a []Val, f func(x, y Date) int64) Val {
	x, ok1 := dateArg(a, 0)
	y, ok2 := dateArg(a, 1)
	if !ok1 || !ok2 {
		return nil
	}
	return f(x, y)
}
func B_days_between(c *Ctx, a ...Val) Val {
	return between(a, func(x, y Date) int64 { return y.D - x.D })
}
func B_months_between(c *Ctx, a ...Val) Val { return between(a, MonthsBetween) }
func B_years_between(c *Ctx, a ...Val) Val {
	return between(a, func(x, y Date) int64 { return MonthsBetween(x, y) / 12 })
}
func B_start_of_month(c *Ctx, a ...Val) Val {
	return onDate(a, func(d Date) Val { y, m, _ := d.civil(); return dayOf(time.Date(y, m, 1, 0, 0, 0, 0, time.UTC)) })
}
func B_end_of_month(c *Ctx, a ...Val) Val {
	return onDate(a, func(d Date) Val { y, m, _ := d.civil(); return dayOf(time.Date(y, m+1, 0, 0, 0, 0, 0, time.UTC)) })
}
func B_start_of_day(c *Ctx, a ...Val) Val { return onDate(a, func(d Date) Val { return StartOfDay(d) }) }
func B_end_of_day(c *Ctx, a ...Val) Val   { return onDate(a, func(d Date) Val { return EndOfDay(d) }) }
func B_format_date(c *Ctx, a ...Val) Val {
	return onDate(a, func(d Date) Val { return FormatDate(d, Plain(arg(a, 1))) })
}

// hours(d) and minutes(d): a Duration as a Decimal number of them (exact to the scale)
func durIn(v Val, unitMS int64) Val {
	d, ok := v.(Dur)
	if !ok {
		return nil
	}
	n := divRound(new(big.Int).Mul(big.NewInt(d.MS), big.NewInt(DecScale)), big.NewInt(unitMS))
	return Decimal{N: n, P: 2}
}
func B_hours(c *Ctx, a ...Val) Val   { return durIn(arg(a, 0), 3_600_000) }
func B_minutes(c *Ctx, a ...Val) Val { return durIn(arg(a, 0), 60_000) }

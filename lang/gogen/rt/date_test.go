package rt

import (
	"testing"
	"time"
)

func d(s string) Date { x, ok := ParseDate(s); if !ok { panic(s) }; return x }

func TestDateCalendar(t *testing.T) {
	if d("1970-01-02").D != 1 || d("1969-12-31").D != -1 || d("2026-11-18").String() != "2026-11-18" {
		t.Fatal("epoch days")
	}
	cases := []struct{ got, want string }{
		{AddMonths(d("2026-01-31"), 1).String(), "2026-02-28"}, {AddMonths(d("2024-01-31"), 1).String(), "2024-02-29"},
		{AddMonths(d("2026-03-15"), -3).String(), "2025-12-15"}, {AddMonths(d("2026-12-31"), 2).String(), "2027-02-28"},
		{AddMonths(d("2026-02-28"), -14).String(), "2024-12-28"},
		{FormatDate(d("2026-11-08"), "MM/DD/YY"), "11/08/26"}, {FormatDate(d("2026-11-08"), "dddd, MMMM D, YYYY"), "Sunday, November 8, 2026"},
		{FormatDate(d("2026-11-08"), "ddd D MMM"), "Sun 8 Nov"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("got %s, want %s", c.got, c.want)
		}
	}
	if MonthsBetween(d("2026-01-31"), d("2026-02-28")) != 1 || MonthsBetween(d("2026-01-31"), d("2026-02-27")) != 0 || MonthsBetween(d("2026-01-15"), d("2026-02-15")) != 1 || MonthsBetween(d("2008-05-20"), d("2026-05-19")) != 215 || MonthsBetween(d("2026-05-19"), d("2008-05-20")) != -215 {
		t.Error("months between")
	}
	if Weekday(d("2026-11-16")) != 1 || Weekday(d("2026-11-22")) != 7 {
		t.Error("weekday")
	}
}

func TestDateZone(t *testing.T) {
	ny, _ := time.LoadLocation("America/New_York")
	old := Zone
	Zone = ny
	defer func() { Zone = old }()
	// 2026-11-18 03:00 UTC is still the 17th in New York
	at := time.Date(2026, 11, 18, 3, 0, 0, 0, time.UTC).UnixMilli()
	if got := DateOf(Time{T: at}).String(); got != "2026-11-17" {
		t.Errorf("date_of: %s", got)
	}
	s, e := StartOfDay(d("2026-11-17")), EndOfDay(d("2026-11-17"))
	if time.UnixMilli(s.T).In(ny).Format("2006-01-02 15:04") != "2026-11-17 00:00" || e.T-s.T != 86400000-1 {
		t.Errorf("day bounds: %v %v", s, e)
	}
	// a day 23 hours long, as clocks go forward (2026-03-08 in New York)
	s, e = StartOfDay(d("2026-03-08")), EndOfDay(d("2026-03-08"))
	if e.T-s.T != 23*3600000-1 {
		t.Errorf("spring forward: %d", e.T-s.T)
	}
	if got := Plain(durIn(Dur{MS: 9000000}, 3600000)); got != "2.50" {
		t.Errorf("hours: %s", got)
	}
}

package rt

import "testing"

func dec(s string, p int) Decimal { d, ok := ParseDecimal(s, p); if !ok { panic(s) }; return d }

func TestDecimalExact(t *testing.T) {
	if got := DecAdd(dec("0.1", 6), dec("0.2", 6)).N; got != dec("0.3", 6).N {
		t.Fatalf("0.1+0.2 = %d", got)
	}
	cases := []struct{ in string; p int; want string }{
		{"0.125", 2, "0.12"}, {"0.135", 2, "0.14"}, {"-0.125", 2, "-0.12"}, {"2.5", 0, "2"}, {"3.5", 0, "4"},
		{"12.5", 2, "12.50"}, {"7", 2, "7.00"}, {"0.0000005", 6, "0.000000"}, {"0.0000015", 6, "0.000002"}, {"-3", 0, "-3"},
	}
	for _, c := range cases {
		if got := dec(c.in, c.p).String(); got != c.want {
			t.Errorf("%s to %d places: %s, want %s", c.in, c.p, got, c.want)
		}
	}
	for _, bad := range []string{"", "abc", "1.2.3", "1e5", "--1", "."} {
		if _, ok := ParseDecimal(bad, 2); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestDecimalArithmetic(t *testing.T) {
	if got := DecMul(dec("19.99", 2), DecOf(3, 0)).String(); got != "59.97" {
		t.Errorf("19.99*3 = %s", got)
	}
	if got := DecRound(DecDiv(dec("10", 2), dec("3", 0)), 2).String(); got != "3.33" {
		t.Errorf("10/3 = %s", got)
	}
	if got := DecRound(DecDiv(dec("-10", 2), dec("3", 0)), 2).String(); got != "-3.33" {
		t.Errorf("-10/3 = %s", got)
	}
	if DecFloor(dec("-1.5", 1)) != -2 || DecCeil(dec("-1.5", 1)) != -1 || DecFloor(dec("1.5", 1)) != 1 || DecCeil(dec("1.5", 1)) != 2 {
		t.Error("floor/ceil")
	}
	if got := DecMod(dec("7.5", 1), dec("2", 0)).String(); got != "1.5" {
		t.Errorf("7.5 %% 2 = %s", got)
	}
	// mixed with Int, dynamically
	if got := Plain(Add(dec("1.25", 2), int64(2))); got != "3.25" {
		t.Errorf("1.25+2 = %s", got)
	}
	if !Equal(dec("12.5", 1), dec("12.50", 2)) || Compare(dec("2", 0), int64(3)) >= 0 || Compare(int64(3), dec("2.99", 2)) <= 0 {
		t.Error("equal/compare")
	}
	func() {
		defer func() {
			o, ok := recover().(*Outcome)
			if !ok || o.O != "invalid" {
				t.Errorf("division by zero: %v", o)
			}
		}()
		DecDiv(dec("1", 0), Decimal{})
	}()
	if v := Lift(map[string]any{"dec": "12.50"}); v.(Decimal).String() != "12.50" {
		t.Errorf("Lift: %v", v)
	}
}

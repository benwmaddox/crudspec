package rt

// Decimal: an exact number with a fixed scale, for money and the like. N is the value × 10^6
// (DecScale): what is stored (an INTEGER column), compared and summed, so 0.1 + 0.2 is 0.3 and
// a SQL SUM is exact. P is the places it shows with (a field's declared places, 2 for money):
// a write rule and a display format, not part of the value (12.5 == 12.50).
//
// Rounding is half-even (banker's), as Python's Decimal does: 0.125 to 2 places is 0.12, 0.135
// is 0.14. Dividing by zero refuses the action (invalid), as nothing sensible comes of it.

import (
	"math/big"
	"strconv"
	"strings"
)

type Decimal struct {
	N int64
	P int8
}

const DecScale = 1_000_000
const DecMaxPlaces = 6

// DecOf is an Int as a Decimal
func DecOf(n int64, places int8) Decimal { return Decimal{N: n * DecScale, P: places} }

var pow10 = [...]int64{1, 10, 100, 1000, 10000, 100000, 1000000}

// roundHalfEven rounds n (× 10^6) to the given places (0 to 6), still × 10^6
func roundHalfEven(n int64, places int) int64 {
	if places >= DecMaxPlaces {
		return n
	}
	if places < 0 {
		places = 0
	}
	unit := pow10[DecMaxPlaces-places]
	q, r := n/unit, n%unit
	if r < 0 {
		r, q = r+unit, q-1
	}
	if 2*r > unit || (2*r == unit && q%2 != 0) {
		q++
	}
	return q * unit
}

// DecRound is d rounded to places, shown with them
func DecRound(d Decimal, places int) Decimal {
	return Decimal{N: roundHalfEven(d.N, places), P: int8(clampPlaces(places))}
}

func clampPlaces(p int) int {
	if p < 0 {
		return 0
	}
	if p > DecMaxPlaces {
		return DecMaxPlaces
	}
	return p
}

// ParseDecimal reads "12.50", "-3", "0.125" exactly (no float on the way), rounded half-even to
// places; ok is false for anything else
func ParseDecimal(s string, places int) (Decimal, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return Decimal{}, false
	}
	neg := false
	if s[0] == '-' || s[0] == '+' {
		neg = s[0] == '-'
		s = s[1:]
	}
	whole, frac, _ := strings.Cut(s, ".")
	if whole == "" && frac == "" {
		return Decimal{}, false
	}
	for _, c := range whole + frac {
		if c < '0' || c > '9' {
			return Decimal{}, false
		}
	}
	if whole == "" {
		whole = "0"
	}
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil || w > 9_000_000_000_000 {
		return Decimal{}, false
	}
	// digits past the scale decide the rounding at 10^-6 first (half-even), then to places
	n := w * DecScale
	if len(frac) > DecMaxPlaces {
		keep, rest := frac[:DecMaxPlaces], frac[DecMaxPlaces:]
		f, _ := strconv.ParseInt(keep, 10, 64)
		n += f
		half := "5" + strings.Repeat("0", len(rest)-1)
		if rest > half || (rest == half && f%2 != 0) {
			n++
		}
	} else if frac != "" {
		f, _ := strconv.ParseInt(frac+strings.Repeat("0", DecMaxPlaces-len(frac)), 10, 64)
		n += f
	}
	if neg {
		n = -n
	}
	return Decimal{N: roundHalfEven(n, places), P: int8(clampPlaces(places))}, true
}

// String is the value with its places: 12.50, -3, 0.125
func (d Decimal) String() string { return DecText(d.N, int(d.P)) }

// DecText is n (× 10^6) shown with the given places (rounded half-even to them)
func DecText(n int64, places int) string {
	places = clampPlaces(places)
	n = roundHalfEven(n, places)
	neg := n < 0
	if neg {
		n = -n
	}
	whole, frac := n/DecScale, n%DecScale
	s := strconv.FormatInt(whole, 10)
	if places > 0 {
		f := strconv.FormatInt(frac, 10)
		f = strings.Repeat("0", DecMaxPlaces-len(f)) + f
		s += "." + f[:places]
	}
	if neg && n != 0 {
		s = "-" + s
	}
	return s
}

func maxP(a, b int8) int8 {
	if a > b {
		return a
	}
	return b
}

func DecAdd(a, b Decimal) Decimal { return Decimal{N: a.N + b.N, P: maxP(a.P, b.P)} }
func DecSub(a, b Decimal) Decimal { return Decimal{N: a.N - b.N, P: maxP(a.P, b.P)} }
func DecNeg(a Decimal) Decimal     { return Decimal{N: -a.N, P: a.P} }

// DecMul is a × b, rounded half-even to the scale; it shows with the places of both (at most 6)
func DecMul(a, b Decimal) Decimal {
	x := new(big.Int).Mul(big.NewInt(a.N), big.NewInt(b.N))
	return Decimal{N: divRound(x, big.NewInt(DecScale)), P: int8(clampPlaces(int(a.P) + int(b.P)))}
}

// DecDiv is a / b, rounded half-even to the scale; dividing by zero refuses the action
func DecDiv(a, b Decimal) Decimal {
	if b.N == 0 {
		Refuse("invalid", "division by zero", "division")
	}
	x := new(big.Int).Mul(big.NewInt(a.N), big.NewInt(DecScale))
	return Decimal{N: divRound(x, big.NewInt(b.N)), P: maxP(maxP(a.P, b.P), 2)}
}

// DecMod is a's remainder after dividing by b, with a's sign (as SQL and Go do); zero refuses
func DecMod(a, b Decimal) Decimal {
	if b.N == 0 {
		Refuse("invalid", "division by zero", "division")
	}
	return Decimal{N: a.N % b.N, P: maxP(a.P, b.P)}
}

// divRound is x / y rounded half-even
func divRound(x, y *big.Int) int64 {
	q, r := new(big.Int).QuoRem(x, y, new(big.Int))
	if r.Sign() != 0 {
		r2 := new(big.Int).Mul(new(big.Int).Abs(r), big.NewInt(2))
		c := r2.Cmp(new(big.Int).Abs(y))
		neg := (x.Sign() < 0) != (y.Sign() < 0)
		if c > 0 || (c == 0 && q.Bit(0) == 1) {
			if neg {
				q.Sub(q, big.NewInt(1))
			} else {
				q.Add(q, big.NewInt(1))
			}
		}
	}
	return q.Int64()
}

// DecFloor and DecCeil are the Int at or below, at or above
func DecFloor(d Decimal) int64 {
	q := d.N / DecScale
	if d.N%DecScale < 0 {
		q--
	}
	return q
}
func DecCeil(d Decimal) int64 {
	q := d.N / DecScale
	if d.N%DecScale > 0 {
		q++
	}
	return q
}

// AsDecimal is a value as a Decimal: an Int widens, text is parsed; none is 0
func AsDecimal(v Val) Decimal {
	switch x := v.(type) {
	case Decimal:
		return x
	case int64:
		return DecOf(x, 0)
	case int:
		return DecOf(int64(x), 0)
	case string:
		if d, ok := ParseDecimal(x, DecMaxPlaces); ok {
			return d
		}
	}
	return Decimal{}
}

// DecField is a stored value read as a field's: shown with the field's places
func DecField(n int64, places int8) Decimal { return Decimal{N: n, P: places} }

// DecStore is a value written to a field: rounded half-even to its places
func DecStore(v Val, places int) Decimal { return DecRound(AsDecimal(v), places) }

func (d Decimal) MarshalJSON() ([]byte, error) {
	return []byte(`{"dec":"` + d.String() + `"}`), nil
}

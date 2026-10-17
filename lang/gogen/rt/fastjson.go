package rt

import (
	"sort"
	"strconv"
	"unicode/utf8"
)

// AppendJSON writes a value as JSON.stringify would (the shapes MarshalJSON gives), without
// reflection: handler tokens encode the page's variables for every button.
func AppendJSON(b []byte, v Val) []byte {
	switch x := v.(type) {
	case nil:
		return append(b, "null"...)
	case bool:
		return strconv.AppendBool(b, x)
	case int64:
		return strconv.AppendInt(b, x, 10)
	case int:
		return strconv.AppendInt(b, int64(x), 10)
	case string:
		return appendStr(b, x)
	case Ref:
		b = append(b, `{"ref":`...)
		b = appendStr(b, x.E)
		b = append(b, `,"id":`...)
		b = strconv.AppendInt(b, x.ID, 10)
		return append(b, '}')
	case Time:
		b = append(b, `{"time":`...)
		b = strconv.AppendInt(b, x.T, 10)
		b = append(b, `,"seq":`...)
		b = strconv.AppendInt(b, x.Seq, 10)
		return append(b, '}')
	case Dur:
		b = append(b, `{"ms":`...)
		b = strconv.AppendInt(b, x.MS, 10)
		return append(b, '}')
	case Set:
		b = append(b, `{"set":[`...)
		for i, id := range x.IDs {
			if i > 0 {
				b = append(b, ',')
			}
			b = strconv.AppendInt(b, id, 10)
		}
		b = append(b, `],"entity":`...)
		b = appendStr(b, x.E)
		return append(b, '}')
	case List:
		b = append(b, '[')
		for i, e := range x {
			if i > 0 {
				b = append(b, ',')
			}
			b = AppendJSON(b, e)
		}
		return append(b, ']')
	case Obj:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b = append(b, '{')
		for i, k := range keys {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendStr(b, k)
			b = append(b, ':')
			b = AppendJSON(b, x[k])
		}
		return append(b, '}')
	}
	return append(b, JSString(v)...)
}

const hexDigits = "0123456789abcdef"

func appendStr(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"' || c == '\\':
				b = append(b, '\\', c)
			case c == '\n':
				b = append(b, '\\', 'n')
			case c == '\r':
				b = append(b, '\\', 'r')
			case c == '\t':
				b = append(b, '\\', 't')
			case c < 0x20:
				b = append(b, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&15])
			default:
				b = append(b, c)
			}
			i++
			continue
		}
		r, n := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && n == 1 {
			b = append(b, `�`...)
		} else {
			b = append(b, s[i:i+n]...)
		}
		i += n
	}
	return append(b, '"')
}

// the page's variables as [[name, value], …], sorted by name
func appendVars(b []byte, vars map[string]Val) []byte {
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	b = append(b, '[')
	for i, k := range keys {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '[')
		b = appendStr(b, k)
		b = append(b, ',')
		b = AppendJSON(b, vars[k])
		b = append(b, ']')
	}
	return append(b, ']')
}

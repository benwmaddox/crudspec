package rt

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

// The spec's builtin functions, as lang/interp.ts call() defines them.
// Generated code calls B_<name>(c, args...).

func arg(a []Val, i int) Val {
	if i < len(a) {
		return a[i]
	}
	return nil
}

func B_plain(c *Ctx, a ...Val) Val { return Plain(arg(a, 0)) }
func B_text(c *Ctx, a ...Val) Val  { return Plain(arg(a, 0)) }
func B_html(c *Ctx, a ...Val) Val  { return Plain(arg(a, 0)) }
func B_mentions(c *Ctx, a ...Val) Val {
	if r, ok := arg(a, 0).(Rich); ok {
		e := r.Entity
		if e == "" {
			e = c.App.ActorEntity
		}
		return Set{E: e, IDs: nonNilIDs(r.Mentions)}
	}
	return Set{E: c.App.ActorEntity, IDs: []int64{}}
}
func B_rich(c *Ctx, a ...Val) Val { return Rich{Text: Plain(arg(a, 0)), Mentions: []int64{}} }
func B_blank(c *Ctx, a ...Val) Val {
	v := arg(a, 0)
	return v == nil || strings.TrimSpace(Plain(v)) == ""
}
func B_present(c *Ctx, a ...Val) Val { return !B_blank(c, a...).(bool) }
func B_authenticates(c *Ctx, a ...Val) Val {
	return CheckPassword(arg(a, 0), Plain(arg(a, 1)))
}
func B_token(c *Ctx, a ...Val) Val { return c.App.Token(int(Num(arg(a, 0)))) }
func B_signed(c *Ctx, a ...Val) Val {
	r, _ := arg(a, 0).(Ref)
	d, _ := arg(a, 2).(Dur)
	return c.App.Sign(r, Plain(arg(a, 1)), c.Now()+d.MS)
}
func B_verify(c *Ctx, a ...Val) Val {
	purpose, ref, id, exp, ok := c.App.Unsign(Plain(arg(a, 1)))
	en, _ := arg(a, 0).(EntityName)
	if !ok || purpose != Plain(arg(a, 2)) || ref != en.E || exp < c.Now() {
		return nil
	}
	if c.S.Find(c.App.Ents[ref], id) == nil {
		return nil
	}
	return Ref{E: ref, ID: id}
}
func B_join(c *Ctx, a ...Val) Val {
	l, ok := arg(a, 0).(List)
	if !ok {
		panic(fmt.Errorf("join takes a list first"))
	}
	parts := make([]string, len(l))
	for i, x := range l {
		parts[i] = Plain(x)
	}
	return strings.Join(parts, Plain(arg(a, 1)))
}
func B_split(c *Ctx, a ...Val) Val {
	s := Plain(arg(a, 0))
	var parts []string
	if len(a) > 1 {
		parts = strings.Split(s, Plain(a[1]))
	} else {
		parts = strings.Fields(s)
	}
	out := make(List, len(parts))
	for i, p := range parts {
		out[i] = p
	}
	return out
}
func B_chunks(c *Ctx, a ...Val) Val {
	s := []rune(Plain(arg(a, 0)))
	n := int(Num(arg(a, 1)))
	out := List{}
	for i := 0; i < len(s); i += n {
		j := i + n
		if j > len(s) {
			j = len(s)
		}
		out = append(out, string(s[i:j]))
	}
	return out
}
func B_sentence(c *Ctx, a ...Val) Val {
	l, _ := arg(a, 0).(List)
	p := make([]string, len(l))
	for i, x := range l {
		p[i] = Plain(x)
	}
	switch len(p) {
	case 0:
		return ""
	case 1:
		return p[0]
	case 2:
		return p[0] + " and " + p[1]
	}
	return strings.Join(p[:len(p)-1], ", ") + ", and " + p[len(p)-1]
}
func B_any(c *Ctx, a ...Val) Val {
	switch x := arg(a, 0).(type) {
	case List:
		return len(x) > 0
	case Set:
		return len(x.IDs) > 0
	}
	return false
}
func B_count(c *Ctx, a ...Val) Val {
	switch x := arg(a, 0).(type) {
	case List:
		return int64(len(x))
	case Set:
		return int64(len(x.IDs))
	}
	return int64(0)
}
func B_first(c *Ctx, a ...Val) Val {
	l, ok := arg(a, 0).(List)
	if !ok {
		return nil
	}
	if len(a) > 1 {
		n := int(Num(a[1]))
		if n > len(l) {
			n = len(l)
		}
		if n < 0 {
			n = 0
		}
		return append(List{}, l[:n]...)
	}
	if len(l) == 0 {
		return nil
	}
	return l[0]
}
func B_last(c *Ctx, a ...Val) Val {
	l, ok := arg(a, 0).(List)
	if !ok {
		return nil
	}
	if len(a) > 1 {
		n := int(Num(a[1]))
		if n > len(l) {
			n = len(l)
		}
		return append(List{}, l[len(l)-n:]...)
	}
	if len(l) == 0 {
		return nil
	}
	return l[len(l)-1]
}
func B_distinct(c *Ctx, a ...Val) Val {
	l, _ := arg(a, 0).(List)
	out := List{}
	for _, x := range l {
		dup := false
		for _, y := range out {
			if Equal(x, y) {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, x)
		}
	}
	return out
}
func B_set(c *Ctx, a ...Val) Val {
	switch v := arg(a, 0).(type) {
	case Set:
		return v
	case Ref:
		return Set{E: v.E, IDs: []int64{v.ID}}
	case List:
		ids, e := []int64{}, ""
		for _, x := range v {
			if r, ok := x.(Ref); ok {
				ids = append(ids, r.ID)
				if e == "" {
					e = r.E
				}
			}
		}
		if e == "" {
			e = c.App.ActorEntity
		}
		return Set{E: e, IDs: ids}
	}
	return Set{E: c.App.ActorEntity, IDs: []int64{}}
}
func B_words(c *Ctx, a ...Val) Val { return int64(len(strings.Fields(Plain(arg(a, 0))))) }

var wordStart = regexp.MustCompile(`\b\w`)

func B_initials(c *Ctx, a ...Val) Val {
	return strings.Join(wordStart.FindAllString(Plain(arg(a, 0)), -1), "")
}
func B_first_word(c *Ctx, a ...Val) Val { return strings.SplitN(Plain(arg(a, 0)), " ", 2)[0] }
func B_after(c *Ctx, a ...Val) Val {
	s, p := Plain(arg(a, 0)), Plain(arg(a, 1))
	if strings.HasPrefix(s, p) {
		return s[len(p):]
	}
	return ""
}
func B_lower(c *Ctx, a ...Val) Val { return strings.ToLower(Plain(arg(a, 0))) }
func B_upper(c *Ctx, a ...Val) Val { return strings.ToUpper(Plain(arg(a, 0))) }
func B_trim(c *Ctx, a ...Val) Val  { return strings.TrimSpace(Plain(arg(a, 0))) }
func B_length(c *Ctx, a ...Val) Val {
	return int64(len(utf16Len(Plain(arg(a, 0)))))
}
func utf16Len(s string) []struct{} { // JavaScript's length counts UTF-16 units
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return make([]struct{}, n)
}
func B_contains(c *Ctx, a ...Val) Val    { return strings.Contains(Plain(arg(a, 0)), Plain(arg(a, 1))) }
func B_starts_with(c *Ctx, a ...Val) Val { return strings.HasPrefix(Plain(arg(a, 0)), Plain(arg(a, 1))) }
func B_replace(c *Ctx, a ...Val) Val {
	return strings.ReplaceAll(Plain(arg(a, 0)), Plain(arg(a, 1)), Plain(arg(a, 2)))
}
func B_public_ip(c *Ctx, a ...Val) Val { return PublicIP(Plain(arg(a, 0))) }
func B_scheme(c *Ctx, a ...Val) Val {
	u, err := url.Parse(Plain(arg(a, 0)))
	if err != nil || u.Scheme == "" {
		return ""
	}
	return u.Scheme
}
func B_port(c *Ctx, a ...Val) Val {
	u, err := url.Parse(Plain(arg(a, 0)))
	if err != nil || u.Scheme == "" {
		return int64(0)
	}
	if p := u.Port(); p != "" {
		return Num(p)
	}
	if u.Scheme == "https" {
		return int64(443)
	}
	return int64(80)
}
func B_host_within(c *Ctx, a ...Val) Val {
	u, err := url.Parse(Plain(arg(a, 0)))
	if err != nil || u.Host == "" {
		return false
	}
	h := strings.ToLower(u.Hostname())
	l, _ := arg(a, 1).(List)
	for _, x := range l {
		p := Plain(x)
		if h == p || strings.HasSuffix(h, "."+p) {
			return true
		}
	}
	return false
}
func B_url(c *Ctx, a ...Val) Val { return c.App.BaseURL(c) + Plain(arg(a, 0)) }
func B_host(c *Ctx, a ...Val) Val {
	u, err := url.Parse(Plain(arg(a, 0)))
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}
func B_path(c *Ctx, a ...Val) Val {
	u, err := url.Parse(Plain(arg(a, 0)))
	if err != nil || u.Host == "" {
		return ""
	}
	if u.Path == "" {
		return "/"
	}
	return u.Path
}
func B_with_host(c *Ctx, a ...Val) Val {
	u, err := url.Parse(Plain(arg(a, 0)))
	if err != nil || u.Host == "" {
		return Plain(arg(a, 0))
	}
	if p := u.Port(); p != "" {
		u.Host = Plain(arg(a, 1)) + ":" + p
	} else {
		u.Host = Plain(arg(a, 1))
	}
	return u.String()
}
func B_url_of(c *Ctx, a ...Val) Val { return c.App.URLOf(c, arg(a, 0)) }
func B_download(c *Ctx, a ...Val) Val { return c.App.URLOf(c, arg(a, 0)) }
func B_file(c *Ctx, a ...Val) Val {
	return c.App.StoreFile(arg(a, 0), Plain(arg(a, 1)), Plain(arg(a, 2)))
}
func B_request_file(c *Ctx, a ...Val) Val { return nil }

var nonWord = regexp.MustCompile(`[^\p{L}\p{N}_]`)

func B_words_only(c *Ctx, a ...Val) Val { return nonWord.ReplaceAllString(Plain(arg(a, 0)), " ") }
func B_max(c *Ctx, a ...Val) Val {
	x, y := Num(arg(a, 0)), Num(arg(a, 1))
	if x > y {
		return x
	}
	return y
}
func B_min(c *Ctx, a ...Val) Val {
	x, y := Num(arg(a, 0)), Num(arg(a, 1))
	if x < y {
		return x
	}
	return y
}
func B_cookie(c *Ctx, a ...Val) Val {
	if c.Req == nil || c.Req.Cookies == nil {
		return nil
	}
	if v, ok := c.Req.Cookies[Plain(arg(a, 0))]; ok {
		return v
	}
	return nil
}
func B_matches(c *Ctx, a ...Val) Val {
	hay := strings.ToLower(Plain(arg(a, 0)))
	words := strings.Fields(strings.ToLower(Plain(arg(a, 1))))
	if len(words) == 0 {
		return false
	}
	for _, w := range words {
		if !wordBoundaryPrefix(hay, w) {
			return false
		}
	}
	return true
}

// \bword in JavaScript's (Unicode-mode) sense: word characters are ASCII letters, digits, _
func wordBoundaryPrefix(hay, w string) bool {
	for i := 0; i+len(w) <= len(hay); i++ {
		if hay[i:i+len(w)] != w {
			continue
		}
		startsWord := isASCIIWord(rune(w[0]))
		prevWord := i > 0 && isASCIIWord(rune(hay[i-1]))
		if startsWord != prevWord {
			return true
		}
	}
	return false
}
func isASCIIWord(r rune) bool { return r == '_' || (r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r))) }

// PublicIP is the interpreter's public_ip(): exactly its rules.
var v4re = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)\.(\d+)$`)
var v6re = regexp.MustCompile(`(?i)^[0-9a-f:]+$`)

func PublicIP(ip string) bool {
	if m := v4re.FindStringSubmatch(ip); m != nil {
		n := [4]int64{}
		for i := 0; i < 4; i++ {
			n[i] = Num(m[i+1])
			if n[i] > 255 {
				return false
			}
		}
		a, b := n[0], n[1]
		return !(a == 127 || a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254))
	}
	if v6re.MatchString(ip) && strings.Contains(ip, ":") {
		l := strings.ToLower(ip)
		return !(l == "::1" || strings.HasPrefix(l, "fe80") || strings.HasPrefix(l, "fc") || strings.HasPrefix(l, "fd"))
	}
	return false
}

// EnumLabel is an enum value's label, from its enum's table (labels nil: its name made readable).
func EnumLabel(labels map[string]string, v string) string {
	if l, ok := labels[v]; ok {
		return l
	}
	s := strings.ReplaceAll(v, "_", " ")
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

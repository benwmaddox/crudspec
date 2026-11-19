package rt

// Conversions to a stricter kind, written in the spec (no value changes kind by itself): text
// to an Email, a Url or an Ip (none when it isn't one), and an Int to a Decimal. A form or API
// argument for an Email, Url or Ip parameter is checked the same way as it arrives (BindFmt).
// The compiler checks a literal with the same rules (lang/types.ts formatOk).

import (
	"net"
	"net/url"
	"regexp"
	"strings"
)

var emailRe = regexp.MustCompile(`^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[^\s@<>(),;:"\[\]]+$`)

// FormatOK: whether s is an Email, a Url (http or https, with a host) or an Ip
func FormatOK(format, s string) bool {
	switch format {
	case "Email":
		return emailRe.MatchString(s)
	case "Url":
		u, err := url.Parse(s)
		return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != ""
	case "Ip":
		return net.ParseIP(s) != nil
	}
	return true
}

func convert(format string, a []Val) Val {
	v := arg(a, 0)
	if v == nil {
		return nil
	}
	if s := Plain(v); FormatOK(format, s) {
		return s
	}
	return nil
}

func B_to_email(c *Ctx, a ...Val) Val { return convert("Email", a) }
func B_to_url(c *Ctx, a ...Val) Val   { return convert("Url", a) }
func B_to_ip(c *Ctx, a ...Val) Val    { return convert("Ip", a) }

// B_to_decimal: an Int as a Decimal (whole, so it can't fail)
func B_to_decimal(c *Ctx, a ...Val) Val {
	v := arg(a, 0)
	if v == nil {
		return nil
	}
	if d, ok := v.(Decimal); ok {
		return d
	}
	return DecOf(Num(v), 0)
}

// BindFmt: an argument for an Email, Url or Ip parameter, as it arrives: empty is none, and
// text that isn't one is refused (invalid)
func BindFmt(format, name string, v Val) Val {
	if v == nil {
		return nil
	}
	s := strings.TrimSpace(Plain(v))
	if s == "" {
		return nil
	}
	if !FormatOK(format, s) {
		article := "a"
		if format == "Email" {
			article = "an"
		}
		Refuse("invalid", name+" isn't "+article+" "+format+": "+s, "format")
	}
	return s
}

// B_default: x, or the fallback when x is none (default(x) has its empty value written in by
// the compiler, so the call always has two)
func B_default(c *Ctx, a ...Val) Val {
	if v := arg(a, 0); v != nil {
		return v
	}
	return arg(a, 1)
}

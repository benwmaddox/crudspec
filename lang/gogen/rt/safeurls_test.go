package rt

import (
	"regexp"
	"strings"
	"testing"
)

// safeMdURLs, a scan, gives what the regexp it replaced gave, on the HTML Markdown makes and on
// tricky text.
var oldMdURL = regexp.MustCompile(`(?i)(href|src)="([^"]*)"`)

func oldSafeMdURLs(h string) string {
	return oldMdURL.ReplaceAllStringFunc(h, func(m string) string {
		g := oldMdURL.FindStringSubmatch(m)
		u := strings.ToLower(strings.TrimSpace(g[2]))
		if i := strings.IndexAny(u, ":/?#"); i >= 0 && u[i] == ':' {
			if !(strings.HasPrefix(u, "http:") || strings.HasPrefix(u, "https:") || strings.HasPrefix(u, "mailto:")) {
				return g[1] + `="#"`
			}
		}
		return m
	})
}

func TestSafeMdURLs(t *testing.T) {
	cases := []string{
		``, `plain text`, `<p>no links</p>`,
		`<a href="/w/x/p/Page">Page</a>`, `<a href="https://example.test/a">x</a>`, `<a href="mailto:a@b.test">m</a>`,
		`<a href="javascript:alert(1)">x</a>`, `<img src="data:image/png;base64,AAA" alt="">`, `<a HREF="FILE:///etc/passwd">x</a>`,
		`<img SRC=" vbscript:x ">`, `<a href="?q=a:b">q</a>`, `<a href="#x:y">h</a>`, `<a href="/a:b">p</a>`, `<a href="a:b">s</a>`,
		`<a data-href="evil:x">d</a>`, `<a xhref="evil:x">d</a>`, `<img srcset="a:b 1x" src="ok.png">`,
		`<a href="evil:1">a</a><a href="/ok">b</a><img src="evil:2"><a href="https://ok">c</a>`,
		`<a href="unterminated:`, `text with ="quotes" and href= src= alone`, `<a href=""></a>`, `<a href=":x">c</a>`,
		`<p>é 日本 <a href="Https://Example.test">x</a></p>`, `<a href="  HTTP:x ">y</a>`, `<a hReF="tel:123">t</a>`,
	}
	for _, c := range cases {
		if got, want := safeMdURLs(c), oldSafeMdURLs(c); got != want {
			t.Errorf("%q:\n scan   %q\n regexp %q", c, got, want)
		}
	}
}

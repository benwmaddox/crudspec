package rt

import (
	"strings"
	"testing"
)

func TestMarkdownHTML(t *testing.T) {
	cases := []struct{ in, want, not string }{
		{"# Bosses\n\n**Hard**", "<h1>Bosses</h1>", ""},
		{"**Hard**", "<strong>Hard</strong>", ""},
		{"| a | b |\n|---|---|\n| 1 | 2 |", "<table>", ""},
		{"<script>alert(1)</script>", "", "<script"},
		{"<b onclick=x>hi</b>", "", "onclick"},
		{"[x](javascript:alert(1))", "", "javascript:"},
		{"[x](data:text/html,hi)", "", "data:"},
		{"![a](/files/abc.png?w=320)", `src="/files/abc.png?w=320"`, ""},
		{"See [[Master Sword]].", `<a href="/w/z/p/Master%20Sword">Master Sword</a>`, ""},
		{"See [[Master Sword|the sword]].", `>the sword</a>`, ""},
		{"[[<img src=x onerror=1>]]", "", "<img"},
		{"```\n[[Not a link]]\n```", "[[Not a link]]", "<a"},
		{"https://example.com", `<a href="https://example.com">`, ""},
	}
	for _, c := range cases {
		got := MarkdownHTML(c.in, "/w/z/p/", "md")
		if c.want != "" && !strings.Contains(got, c.want) {
			t.Errorf("%q: want %q in %s", c.in, c.want, got)
		}
		if c.not != "" && strings.Contains(got, c.not) {
			t.Errorf("%q: %q should not be in %s", c.in, c.not, got)
		}
	}
}

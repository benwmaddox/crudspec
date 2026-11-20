package rt

import (
	"strings"
	"testing"
)

func TestMarkdownHTML(t *testing.T) {
	cases := []struct{ in, want, not string }{
		{"# Bosses\n\n**Hard**", `<h1 id="bosses">Bosses</h1>`, ""},
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
		got := MarkdownHTML(c.in, "/w/z/p/", "md", nil, false)
		if c.want != "" && !strings.Contains(got, c.want) {
			t.Errorf("%q: want %q in %s", c.in, c.want, got)
		}
		if c.not != "" && strings.Contains(got, c.not) {
			t.Errorf("%q: %q should not be in %s", c.in, c.not, got)
		}
	}
}

func TestMarkdownKnownAndContents(t *testing.T) {
	got := MarkdownHTML("[[Iron Sword]] and [[Nowhere]] and [[iron sword|again]]", "/p/", "md", List{"Iron Sword"}, false)
	if !strings.Contains(got, `<a class="new" title="This page doesn't exist yet" href="/p/Nowhere">`) {
		t.Errorf("a missing page's link isn't marked: %s", got)
	}
	if strings.Count(got, `class="new"`) != 1 {
		t.Errorf("an existing page's link (in any case) is marked: %s", got)
	}
	if strings.Contains(MarkdownHTML("[[Nowhere]]", "/p/", "md", nil, false), `class="new"`) {
		t.Error("without known, nothing is marked")
	}
	toc := MarkdownHTML("## One\n\ntext\n\n### Two\n\n## Three", "/p/", "md", nil, true)
	if !strings.Contains(toc, `<nav class="toc"`) || !strings.Contains(toc, `<a href="#one">One</a>`) || !strings.Contains(toc, `<h2 id="one">`) || !strings.Contains(toc, `class="sub"`) {
		t.Errorf("contents: %s", toc)
	}
	if strings.Contains(MarkdownHTML("## One\n\n## Two", "/p/", "md", nil, true), "toc") {
		t.Error("contents for two headings")
	}
}

func TestEnhancements(t *testing.T) {
	if !strings.Contains(MarkdownHTML("| a |\n|---|\n| 1 |", "", "md", nil, false, true), `data-sortable`) {
		t.Error("sortable markdown isn't marked")
	}
	if strings.Contains(MarkdownHTML("x", "", "md", nil, false), `data-sortable`) {
		t.Error("plain markdown is marked sortable")
	}
	if got := ThemeToggle("t", "light"); !strings.Contains(got, `data-theme-toggle="light"`) || !strings.Contains(got, "Dark") {
		t.Errorf("toggle: %s", got)
	}
	if got := MarkdownEditorTag("/p/", List{"A", "B"}, "/files/x.png|X"); !strings.Contains(got, `data-known="A`+"\n"+`B"`) || !strings.Contains(got, `data-links="/p/"`) {
		t.Errorf("editor tag: %s", got)
	}
	if !strings.Contains(liveScript, "cs-markdown-editor") || !strings.Contains(liveScript, "data-theme-toggle") {
		t.Error("the page script hasn't the enhancements")
	}
}

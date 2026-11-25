package rt

import (
	"strconv"
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

// known as a lookup marks the same links as a list, asking once for each name in any case
func TestMarkdownKnownLookup(t *testing.T) {
	asked := map[string]int{}
	look := func(name string) bool { asked[strings.ToLower(name)]++; return strings.EqualFold(name, "Iron Sword") }
	got := MarkdownWith("[[Iron Sword]] and [[Nowhere]] and [[iron sword|again]] and [[NOWHERE]]", "/p/", "md", nil, MarkdownOpts{Known: look})
	if strings.Count(got, `class="new"`) != 2 || !strings.Contains(got, `class="new" title="This page doesn't exist yet" href="/p/Nowhere"`) {
		t.Errorf("the missing page's links aren't the ones marked: %s", got)
	}
	if len(asked) != 2 || asked["iron sword"] != 1 || asked["nowhere"] != 1 {
		t.Errorf("each name is asked once: %v", asked)
	}
	if MarkdownWith("no links", "/p/", "md", nil, MarkdownOpts{Known: look}); len(asked) != 2 {
		t.Errorf("a text without links asks nothing: %v", asked)
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
	if got := MarkdownEditorTag("/p/", "tok.sig", "img.sig", "", false); !strings.Contains(got, `data-known-lookup="tok.sig"`) || !strings.Contains(got, `data-images-lookup="img.sig"`) || !strings.Contains(got, `data-links="/p/"`) {
		t.Errorf("editor tag: %s", got)
	}
	if !strings.Contains(liveScript, "cs-markdown-editor") || !strings.Contains(liveScript, "data-theme-toggle") {
		t.Error("the page script hasn't the enhancements")
	}
}

// {{Name}} snippets and [[File:Name]] images, through the element's lookups
func TestMarkdownLookups(t *testing.T) {
	pages := map[string]string{
		"navbox":   "**Weapons:** [[Sword]] • [[Bow]]",
		"cost":     "Costs {{{coins|10}}} coins at level {{{1}}}.",
		"outer":    "Outer, then {{Inner}}",
		"inner":    "inner, then {{Deeper}}",
		"deeper":   "deeper, then {{Deepest}}",
		"deepest":  "too deep",
		"loop":     "loop: {{Loop}}",
		"folded":   "::: collapsed Costs\n| a | b |\n|---|---|\n| 1 | 2 |\n:::",
		"has code": "```\n{{Navbox}}\n```",
	}
	calls := 0
	look := func(name string) (string, bool) { calls++; s, ok := pages[strings.ToLower(name)]; return s, ok }
	files := func(name string) (string, bool) {
		if name == "Damage graph.png" {
			return "/files/abc123.png", true
		}
		return "", false
	}
	cases := []struct{ in, want, not string }{
		{"Top {{Navbox}}", `<a href="/w/z/p/Sword">Sword</a>`, "{{"},
		{"{{Cost|coins=25|3}}", "Costs 25 coins at level 3.", ""},
		{"{{Cost}}", "Costs 10 coins at level {{{1}}}.", ""},
		{"{{Outer}}", "deeper, then", "too deep"},
		{"{{Outer}}", `<a href="/w/z/p/Deepest">Deepest</a>`, ""},
		{"{{Loop}}", `<a href="/w/z/p/Loop">Loop</a>`, ""},
		{"{{Nowhere}}", `<a href="/w/z/p/Nowhere">Nowhere</a>`, ""},
		{"```\n{{Navbox}}\n```", "{{Navbox}}", "<strong>"},
		{"{{{a|plain}}} and {{{b}}}", "plain and {{{b}}}", ""},
		{"[[File:Damage graph.png|thumb|200px|How damage grows]]", `<img src="/files/abc123.png?w=200" loading="lazy" decoding="async" alt="How damage grows">`, ""},
		{"[[File:Damage graph.png]]", `alt="Damage graph"`, ""},
		{"[[File:Missing.png]]", "<del>Missing.png</del>", "<img"},
		{"[[Image:Damage graph.png|1000px]]", `src="/files/abc123.png?w=1600"`, ""},
		{"{{Folded}}{{Folded}}", `</details>
<details class="md-collapsed">`, ":::"},
	}
	for _, c := range cases {
		got := MarkdownWith(c.in, "/w/z/p/", "md", nil, MarkdownOpts{Include: look, Files: files})
		if c.want != "" && !strings.Contains(got, c.want) {
			t.Errorf("%q: want %q in %s", c.in, c.want, got)
		}
		if c.not != "" && strings.Contains(got, c.not) {
			t.Errorf("%q: %q should not be in %s", c.in, c.not, got)
		}
	}
	// at most includeBudget lookups, each name once per text
	calls = 0
	MarkdownWith(strings.Repeat("{{Navbox}} ", 200), "/w/z/p/", "md", nil, MarkdownOpts{Include: look})
	if calls != 1 {
		t.Errorf("the same snippet 200 times: %d lookups, want 1", calls)
	}
	calls = 0
	var many strings.Builder
	for i := 0; i < 80; i++ {
		many.WriteString("{{P" + strconv.Itoa(i) + "}} ")
	}
	MarkdownWith(many.String(), "/w/z/p/", "md", nil, MarkdownOpts{Include: look})
	if calls != includeBudget {
		t.Errorf("80 names: %d lookups, want %d", calls, includeBudget)
	}
	// a short page whose snippets multiply (B is C a thousand times, C is 10 KB) stays capped
	big := map[string]string{"b": strings.Repeat("{{C}}", 1000), "c": strings.Repeat("x", 10_000)}
	got := MarkdownWith(strings.Repeat("{{B}}", 1000), "/w/z/p/", "md", nil, MarkdownOpts{Include: func(n string) (string, bool) { s, ok := big[strings.ToLower(n)]; return s, ok }})
	if len(got) > 3*includeMaxBytes {
		t.Errorf("snippets that multiply: %d bytes, want at most about %d", len(got), includeMaxBytes)
	}
	// \{{Name}} is written as it is; {{{a|b}}} in code, or with no snippets, is left alone
	for _, c := range []struct {
		in, want string
		o        MarkdownOpts
	}{
		{`Write \{{Navbox}} to show it.`, "Write {{Navbox}} to show it.", MarkdownOpts{Include: look}},
		{"```\n{{{a|b}}}\n```", "{{{a|b}}}", MarkdownOpts{Include: look}},
		{"plain {{{a|b}}}", "plain {{{a|b}}}", MarkdownOpts{}},
	} {
		if got := MarkdownWith(c.in, "/w/z/p/", "md", nil, c.o); !strings.Contains(got, c.want) {
			t.Errorf("%q: want %q in %s", c.in, c.want, got)
		}
	}
}

// ::: tabs and ::: collapsed blocks
func TestMarkdownBlocks(t *testing.T) {
	cases := []struct{ in, want, not string }{
		{"::: tabs\n== Attack\nHits **hard**.\n== Speed\nFast.\n:::", `<div class="md-tabs"><section class="md-tab"><h4 class="md-tab-title">Attack</h4><p>Hits <strong>hard</strong>.</p>`, ":::"},
		{"::: tabs\n== Attack\nA\n== Speed\nB\n:::", `<h4 class="md-tab-title">Speed</h4><p>B</p>`, ""},
		{"::: collapsed Upgrade **costs**\n| a | b |\n|---|---|\n| 1 | 2 |\n:::", `<details class="md-collapsed"><summary>Upgrade <strong>costs</strong></summary><table>`, ":::"},
		{"::: collapsed\nx\n:::", "<summary>More</summary>", ""},
		{"::: tabs\n== Outer\n::: collapsed Inner\ndeep\n:::\n== Two\ny\n:::", `<details class="md-collapsed"><summary>Inner</summary><p>deep</p>`, ""},
		{"::: tabs\n== Outer\n::: collapsed Inner\ndeep\n:::\n== Two\ny\n:::", `<h4 class="md-tab-title">Two</h4><p>y</p>`, ""},
		{"```\n::: tabs\n== x\n:::\n```", "::: tabs", "md-tabs"},
		{"Before\n\n::: collapsed T\nin\n:::\n\nAfter", "<p>After</p>", ""},
		{"::: collapsed <script>x</script>\nin\n:::", "<summary>", "<script"},
		{"::: tabs\n== [[Sword]]\nin\n:::", `<a href="/w/z/p/Sword">Sword</a></h4>`, ""},
		{"::: collapsed never closed\ntext", "<p>text</p>", ""},
		{"::: tabs\n== Outer A\n::: tabs\n== Inner 1\nx\n== Inner 2\ny\n:::\n== Outer B\nz\n:::", `<h4 class="md-tab-title">Inner 2</h4><p>y</p>`, ":::"},
		{"::: tabs\n== Outer A\n::: tabs\n== Inner 1\nx\n== Inner 2\ny\n:::\n== Outer B\nz\n:::", "</section></div>\n</section><section class=\"md-tab\"><h4 class=\"md-tab-title\">Outer B</h4>", ""},
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

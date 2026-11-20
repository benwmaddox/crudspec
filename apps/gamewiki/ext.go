package main

import (
	"regexp"
	"strings"
)

// LineDiff compares two texts line by line (a longest common subsequence): each line of the
// result starts with "  " (in both), "- " (only in old) or "+ " (only in new). Long texts are
// compared by their changed middle only, so the table stays small.
func LineDiff(old, new string) []string {
	a, b := strings.Split(old, "\n"), strings.Split(new, "\n")
	pre := 0
	for pre < len(a) && pre < len(b) && a[pre] == b[pre] {
		pre++
	}
	suf := 0
	for suf < len(a)-pre && suf < len(b)-pre && a[len(a)-1-suf] == b[len(b)-1-suf] {
		suf++
	}
	ma, mb := a[pre:len(a)-suf], b[pre:len(b)-suf]
	out := []string{}
	ctx := func(lines []string, from, to int) { // unchanged lines: up to 3 shown around changes
		for _, l := range lines[from:to] {
			out = append(out, "  "+l)
		}
	}
	start := pre - 3
	if start < 0 {
		start = 0
	}
	if start > 0 {
		out = append(out, "@@ line "+itoa(start+1))
	}
	ctx(a, start, pre)
	if len(ma)*len(mb) > 4_000_000 { // too large to align: all out, all in
		for _, l := range ma {
			out = append(out, "- "+l)
		}
		for _, l := range mb {
			out = append(out, "+ "+l)
		}
	} else {
		n, m := len(ma), len(mb)
		lcs := make([][]int32, n+1)
		for i := range lcs {
			lcs[i] = make([]int32, m+1)
		}
		for i := n - 1; i >= 0; i-- {
			for j := m - 1; j >= 0; j-- {
				if ma[i] == mb[j] {
					lcs[i][j] = lcs[i+1][j+1] + 1
				} else if lcs[i+1][j] >= lcs[i][j+1] {
					lcs[i][j] = lcs[i+1][j]
				} else {
					lcs[i][j] = lcs[i][j+1]
				}
			}
		}
		i, j := 0, 0
		for i < n || j < m {
			switch {
			case i < n && j < m && ma[i] == mb[j]:
				out = append(out, "  "+ma[i])
				i, j = i+1, j+1
			case j < m && (i == n || lcs[i][j+1] >= lcs[i+1][j]):
				out = append(out, "+ "+mb[j])
				j++
			default:
				out = append(out, "- "+ma[i])
				i++
			}
		}
	}
	end := len(a) - suf + 3
	if end > len(a) {
		end = len(a)
	}
	ctx(a, len(a)-suf, end)
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

var (
	mdImage    = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	mdLink     = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	mdWiki     = regexp.MustCompile(`\[\[([^\]|]+)(?:\|([^\]]+))?\]\]`)
	mdMarks    = regexp.MustCompile("[*_`~>#]+")
	mdTableRow = regexp.MustCompile(`(?m)^\s*\|.*$`)
	mdSpaces   = regexp.MustCompile(`\s+`)
	mdParas    = regexp.MustCompile(`\n\s*\n`)
	mdBullet   = regexp.MustCompile(`(?m)^\s*([-*+]|\d+\.)\s+`)
)

// Excerpt is a page's text as a sentence or two of plain text, at most n characters, cut at a
// word: its paragraphs, without headings, tables, code or images; Markdown's marks left out,
// links as their text.
func Excerpt(text string, n int) string {
	var keep []string
	for _, para := range mdParas.Split(text, -1) {
		t := strings.TrimSpace(para)
		if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, "|") || strings.HasPrefix(t, "```") || strings.HasPrefix(t, "![") {
			continue
		}
		keep = append(keep, mdBullet.ReplaceAllString(t, ""))
		if len(strings.Join(keep, " ")) > n {
			break
		}
	}
	s := mdImage.ReplaceAllString(strings.Join(keep, " "), " ")
	s = mdTableRow.ReplaceAllString(s, " ")
	s = mdWiki.ReplaceAllStringFunc(s, func(m string) string {
		g := mdWiki.FindStringSubmatch(m)
		if g[2] != "" {
			return g[2]
		}
		return g[1]
	})
	s = mdLink.ReplaceAllString(s, "$1")
	s = mdMarks.ReplaceAllString(s, "")
	s = strings.TrimSpace(mdSpaces.ReplaceAllString(s, " "))
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	cut := string(r[:n])
	if i := strings.LastIndex(cut, " "); i > n/2 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,.;:") + "…"
}

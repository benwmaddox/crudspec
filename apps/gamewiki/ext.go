package main

import "strings"

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

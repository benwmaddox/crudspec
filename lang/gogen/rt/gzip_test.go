package rt

import (
	"bytes"
	"compress/gzip"
	"io"
	"strings"
	"testing"
)

func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	r, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// a page of cached pieces and what's around them comes back exactly, however the pieces fall
func TestGzipJoinsPieces(t *testing.T) {
	frag := &cacheEntry{html: []byte(strings.Repeat(`<div class="message"><form method="post">boost</form></div>`, 40))}
	other := &cacheEntry{html: []byte("<p>sidebar</p>")}
	page := []byte("<html><body>" + string(frag.html) + "<b>between</b>" + string(other.html) + string(frag.html) + "</body></html>")
	at1 := len("<html><body>")
	at2 := at1 + len(frag.html) + len("<b>between</b>")
	at3 := at2 + len(other.html)
	cases := map[string][]pageSeg{
		"none":              nil,
		"all three":         {{off: at1, e: frag}, {off: at2, e: other}, {off: at3, e: frag}},
		"out of order":      {{off: at3, e: frag}, {off: at1, e: frag}},
		"a wrong place":     {{off: at1 + 1, e: frag}, {off: at2, e: other}},
		"overlapping":       {{off: at1, e: frag}, {off: at1 + 5, e: other}},
		"past the end":      {{off: len(page) - 3, e: frag}},
		"the page is one":   {{off: 0, e: &cacheEntry{html: page}}},
		"ends on a piece":   {{off: at3, e: frag}},
		"starts on a piece": {{off: 0, e: &cacheEntry{html: page[:at1]}}},
	}
	for name, segs := range cases {
		got := gunzip(t, Gzip(page, segs))
		if !bytes.Equal(got, page) {
			t.Errorf("%s: the page didn't come back (%d bytes, want %d)", name, len(got), len(page))
		}
	}
	// a piece is compressed once, and reused
	first := frag.deflated()
	if &first[0] != &frag.deflated()[0] {
		t.Error("a fragment's compressed form was made again")
	}
	if z := Gzip(page, cases["all three"]); len(z) > len(page)/3 {
		t.Errorf("hardly compressed: %d of %d", len(z), len(page))
	}
}

func TestAcceptsGzip(t *testing.T) {
	for h, want := range map[string]bool{"gzip, deflate, br": true, "br": false, "": false, "gzip;q=0": false, "gzip;q=0.5": true, "*": true, "identity": false, "GZIP": true} {
		if AcceptsGzip(h) != want {
			t.Errorf("%q: want %v", h, want)
		}
	}
}

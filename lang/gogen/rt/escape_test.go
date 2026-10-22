package rt

import (
	"bytes"
	"testing"
)

// WriteEsc writes what Esc returns.
func TestWriteEscAsEsc(t *testing.T) {
	for _, s := range []string{"", "plain", `<a href="x">'&'</a>`, "&&<<>>\"\"''", "end&", "<start", "café &  "} {
		var b bytes.Buffer
		WriteEsc(&b, s)
		if b.String() != Esc(s) {
			t.Fatalf("%q: WriteEsc %q, Esc %q", s, b.String(), Esc(s))
		}
	}
}

// EncodeURIComponent's quick path gives back a text with nothing to encode as it is, and still
// encodes the rest.
func TestEncodeURIComponent(t *testing.T) {
	for in, want := range map[string]string{"123": "123", "a-b_c.d!e~f*g'h(i)": "a-b_c.d!e~f*g'h(i)", "a b": "a%20b", "café": "caf%C3%A9", "/x?y=1&z": "%2Fx%3Fy%3D1%26z", "": ""} {
		if got := EncodeURIComponent(in); got != want {
			t.Fatalf("%q: %q, want %q", in, got, want)
		}
	}
}

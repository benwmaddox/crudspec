package rt

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"strings"
	"testing"
)

// JSString's quick path for simple texts gives what the encoder gives, byte for byte.
func TestJSQuoteSimpleAsEncoder(t *testing.T) {
	enc := func(s string) string {
		var b strings.Builder
		e := json.NewEncoder(&b)
		e.SetEscapeHTML(false)
		e.Encode(s)
		return strings.TrimSuffix(b.String(), "\n")
	}
	cases := []string{"", "plain", `say "hi"`, `back\slash`, "two\nlines\r\n", "tab\there", "<b>&amp;</b> 'q'", "> quoted\n> reply\n\n"}
	r := rand.New(rand.NewSource(1))
	alphabet := []byte("ab \"\\\n\r\t<>&'/~\x7e{}")
	for i := 0; i < 2000; i++ {
		n := r.Intn(24)
		var b bytes.Buffer
		for j := 0; j < n; j++ {
			b.WriteByte(alphabet[r.Intn(len(alphabet))])
		}
		cases = append(cases, b.String())
	}
	for _, s := range cases {
		q, ok := jsQuoteSimple(s)
		if !ok {
			t.Fatalf("%q: not taken as simple", s)
		}
		if want := enc(s); q != want {
			t.Fatalf("%q: quick %s, encoder %s", s, q, want)
		}
	}
	// anything else goes to the encoder
	for _, s := range []string{"café", "\x01", "\x7f", "line sep", string([]byte{0xff})} {
		if _, ok := jsQuoteSimple(s); ok {
			t.Fatalf("%q taken as simple", s)
		}
	}
}

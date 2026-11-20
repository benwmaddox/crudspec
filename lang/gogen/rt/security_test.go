package rt

import "testing"

func TestForwardedFor(t *testing.T) {
	cases := []struct {
		vals []string
		hops int
		want string
	}{
		{[]string{"203.0.113.9"}, 1, "203.0.113.9"},
		{[]string{"10.0.0.1, 203.0.113.9"}, 1, "203.0.113.9"},             // the visitor wrote 10.0.0.1: the proxy's entry wins
		{[]string{"10.0.0.1", "203.0.113.9"}, 1, "203.0.113.9"},           // two headers are one list
		{[]string{"10.0.0.1, 203.0.113.9, 198.51.100.7"}, 2, "203.0.113.9"}, // behind two proxies
		{[]string{"203.0.113.9"}, 2, ""},                                  // fewer entries than proxies
		{[]string{"not-an-address"}, 1, ""},
		{nil, 1, ""},
	}
	for _, c := range cases {
		if got := forwardedFor(c.vals, c.hops); got != c.want {
			t.Errorf("forwardedFor(%q, %d) = %q, want %q", c.vals, c.hops, got, c.want)
		}
	}
}

func TestSniffUpload(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00")
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>`)
	cases := []struct {
		name, claimed string
		body          []byte
		ext, ctype    string
	}{
		{"a.png", "image/png", png, ".png", "image/png"},
		{"a.gif", "image/gif", png, ".png", "image/png"},                         // the bytes say PNG
		{"a.png", "image/png", svg, ".bin", "application/octet-stream"},          // named and sent as an image, isn't one
		{"a.svg", "image/svg+xml", svg, ".bin", "application/octet-stream"},      // not an image the app shows
		{"notes.txt", "text/plain", []byte("hello"), ".txt", "text/plain"},       // not media: as sent
		{"data.csv", "", []byte("a,b"), ".csv", "application/octet-stream"},
	}
	for _, c := range cases {
		ext, ct := sniffUpload(c.name, c.claimed, c.body)
		if ext != c.ext || ct != c.ctype {
			t.Errorf("sniffUpload(%q, %q) = %q %q, want %q %q", c.name, c.claimed, ext, ct, c.ext, c.ctype)
		}
	}
}

func TestSameOrigin(t *testing.T) {
	sv := &Server{cookie: "login"}
	signed := map[string]string{"login": "t"}
	cases := []struct {
		what string
		r    HTTPReq
		want bool
	}{
		{"same Origin", HTTPReq{Host: "w.test", Origin: "https://w.test", Cookies: signed}, true},
		{"another site's Origin", HTTPReq{Host: "w.test", Origin: "https://evil.test", Cookies: signed}, false},
		{"Sec-Fetch-Site cross-site", HTTPReq{Host: "w.test", FetchSite: "cross-site", Cookies: signed}, false},
		{"Origin null, signed in", HTTPReq{Host: "w.test", Origin: "null", Cookies: signed}, false},
		{"no Origin, signed in", HTTPReq{Host: "w.test", Cookies: signed}, false},
		{"no Origin, same-origin fetch", HTTPReq{Host: "w.test", FetchSite: "same-origin", Cookies: signed}, true},
		{"no Origin, no cookie (a program)", HTTPReq{Host: "w.test", Cookies: map[string]string{}}, true},
	}
	for _, c := range cases {
		if got := sv.sameOrigin(&c.r); got != c.want {
			t.Errorf("%s: sameOrigin = %v, want %v", c.what, got, c.want)
		}
	}
}

package rt

import "testing"

func TestHostName(t *testing.T) {
	for in, want := range map[string]string{"Zelda.Example.com:8080": "zelda.example.com", "localhost": "localhost", "wiki.test.": "wiki.test", "[::1]:80": "::1", "": ""} {
		if got := HostName(in); got != want {
			t.Errorf("HostName(%q) = %q, want %q", in, got, want)
		}
	}
}

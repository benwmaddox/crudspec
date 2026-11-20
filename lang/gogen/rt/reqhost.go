package rt

import (
	"net"
	"strings"
)

// HostName is the host a request asked for (its Host header), without the port, in lower
// case: "Zelda.Example.com:8080" is "zelda.example.com". An app reads it as request.host, to
// serve several sites from one program by the address they were reached at.
func HostName(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	return strings.ToLower(strings.TrimSuffix(strings.Trim(h, "[]"), "."))
}

package rt

import (
	"fmt"
	"strings"

	"rsc.io/qr"
)

// QRSVG draws text as a QR code (error correction M), made here and never by an outside
// service: the links can be invitations or sign-ins.
func QRSVG(text string, cell, margin int) string {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return `<svg xmlns="http://www.w3.org/2000/svg"/>`
	}
	size := (code.Size + 2*margin) * cell
	var b strings.Builder
	fmt.Fprintf(&b, `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="%dpx" height="%dpx" viewBox="0 0 %d %d" preserveAspectRatio="xMinYMin meet"><rect width="100%%" height="100%%" fill="white" cx="0" cy="0"/><path d="`, size, size, size, size)
	for y := 0; y < code.Size; y++ {
		for x := 0; x < code.Size; x++ {
			if code.Black(x, y) {
				fmt.Fprintf(&b, "M%d,%dl%d,0 0,%d -%d,0 0,-%dz ", (x+margin)*cell, (y+margin)*cell, cell, cell, cell, cell)
			}
		}
	}
	b.WriteString(`" stroke="transparent" fill="black"/></svg>`)
	return b.String()
}

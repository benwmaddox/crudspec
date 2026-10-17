package rt

import (
	"strings"
	"testing"
)

// A failure in code the generator mapped to a spec line is reported at that line.
func TestSpecWhere(t *testing.T) {
	var got string
	func() {
		defer func() {
			if x := recover(); x != nil {
				got = failure(x)
			}
		}()
		specCode()
	}()
	if !strings.Contains(got, "boom") || !strings.Contains(got, "demo.crud:42 (specCode)") {
		t.Fatalf("got %q", got)
	}
}

func specCode() {
//line demo.crud:42
	panic("boom")
}

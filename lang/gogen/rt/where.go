package rt

import (
	"fmt"
	"runtime"
	"strconv"
	"strings"
)

// SpecWhere is where in the spec a failure happened: the innermost frame of the stack that
// generated code mapped to a spec line (gen.ts writes //line directives), with the generated
// function it is in, or "" when no frame is in the spec. Called from a deferred recover, the
// stack still holds the frames of the failure.
func SpecWhere() string {
	pcs := make([]uintptr, 64)
	n := runtime.Callers(2, pcs)
	frames := runtime.CallersFrames(pcs[:n])
	for {
		f, more := frames.Next()
		if strings.HasSuffix(f.File, ".crud") {
			fn := f.Function
			if i := strings.LastIndex(fn, "."); i >= 0 {
				fn = fn[i+1:]
			}
			return f.File + ":" + strconv.Itoa(f.Line) + " (" + fn + ")"
		}
		if !more {
			return ""
		}
	}
}

// failure is a server error's message: what went wrong and, if it is known, where in the spec.
func failure(x any) string {
	msg := toString(x)
	if w := SpecWhere(); w != "" {
		msg += " at " + w
	}
	return msg
}

func toString(x any) string { return fmt.Sprint(x) }

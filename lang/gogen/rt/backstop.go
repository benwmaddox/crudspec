package rt

import (
	"fmt"
	"os"
)

// InvariantBroken reports an app invariant a workflow step left false: the build couldn't prove the
// step keeps it, so the step checks it after it runs. A step's writes are already applied (it runs
// outside a transaction), so this is a report, not a refusal; an action's check refuses instead.
func InvariantBroken(what string) {
	fmt.Fprintln(os.Stderr, "invariant broken: "+what)
}

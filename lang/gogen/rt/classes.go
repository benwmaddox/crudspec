package rt

import "strings"

// A class list: class={["todo", when(done, "completed")]} is join_classes of the list: the
// entries that aren't none, joined with a space between each. when(c, "x") is "x" when c holds,
// else none.

func B_when(c *Ctx, a ...Val) Val {
	if b, ok := arg(a, 0).(bool); ok && b {
		return Plain(arg(a, 1))
	}
	return nil
}

func B_join_classes(c *Ctx, a ...Val) Val {
	items, _ := arg(a, 0).(List)
	names := make([]string, 0, len(items))
	for _, x := range items {
		if x == nil {
			continue
		}
		names = append(names, Plain(x))
	}
	return strings.Join(names, " ")
}

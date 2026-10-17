package rt

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Agent arguments, checked by generated code per callable: each parameter's check is chosen
// from its type at build time.

func AgentObject(given any, schema string) (map[string]any, map[string]any) {
	if given == nil {
		return map[string]any{}, nil
	}
	g, ok := given.(map[string]any)
	if !ok {
		return nil, agentErr("invalid", "args must be an object", "parameters: "+schema)
	}
	return g, nil
}
func AgentUnknown(g map[string]any, names []string, callable string) map[string]any {
	for k := range g {
		if !contains(names, k) {
			list := strings.Join(names, ", ")
			if list == "" {
				list = "no parameters"
			}
			return agentErr("invalid", "unknown parameter "+k, callable+" takes "+list)
		}
	}
	return nil
}
func agentMissing(name string, required bool, schema string) map[string]any {
	if required {
		return agentErr("invalid", name+" is required", name+": "+schema)
	}
	return nil
}
func agentBad(name, what, schema string) map[string]any {
	return agentErr("invalid", name+" must be "+what, name+": "+schema)
}
func isInt(v any) bool {
	n, ok := v.(json.Number)
	if !ok {
		return false
	}
	if _, err := n.Int64(); err == nil {
		return true
	}
	f, err := n.Float64()
	return err == nil && f == float64(int64(f))
}

// AgentArg checks one argument. kind is "integer", "boolean", "string", "array" or "" (any);
// enum lists allowed values; required says whether it may be left out.
func AgentArg(g map[string]any, name, kind string, enum []string, required, rich bool, schema string) (Val, map[string]any) {
	v, present := g[name]
	if !present || v == nil {
		return nil, agentMissing(name, required, schema)
	}
	what := kind
	if enum != nil {
		what = "one of " + strings.Join(enum, ", ")
	}
	switch kind {
	case "integer":
		if !isInt(v) {
			return nil, agentBad(name, what, schema)
		}
	case "boolean":
		if _, ok := v.(bool); !ok {
			return nil, agentBad(name, what, schema)
		}
	case "string":
		if _, ok := v.(string); !ok {
			return nil, agentBad(name, what, schema)
		}
	case "array":
		l, ok := v.([]any)
		if !ok {
			return nil, agentBad(name, what, schema)
		}
		for _, e := range l {
			if !isInt(e) {
				return nil, agentBad(name, what, schema)
			}
		}
	}
	if enum != nil && !contains(enum, fmt.Sprint(v)) {
		return nil, agentBad(name, what, schema)
	}
	val := Lift(v)
	if rich {
		val = Rich{Text: Plain(val), Mentions: []int64{}, Embeds: []any{}}
	}
	return val, nil
}

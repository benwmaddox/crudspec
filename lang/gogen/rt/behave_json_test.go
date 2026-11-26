package rt

import "testing"

// behaveMaps is Behave as it was: the steps as maps, written by encoding/json. The direct
// writer must give the same bytes.
func behaveMaps(sv *Server, trigger string, steps []Step) string {
	out := []map[string]any{}
	for _, s := range steps {
		m := map[string]any{"a": s.A}
		if s.T != "" {
			m["t"] = s.T
			if s.Last {
				m["l"] = true
			}
		}
		switch s.A {
		case "go", "play":
			if s.V == nil {
				continue
			}
			m["v"] = SafeURL(Plain(s.V), false)
		case "prepend", "append":
			m["v"] = Plain(s.V)
		}
		out = append(out, m)
	}
	if len(out) == 0 {
		return ""
	}
	return ` data-do-` + trigger + `="` + Esc(behaviorJSON(out)) + `"`
}

func TestBehaveJSONAsEncoder(t *testing.T) {
	sv := &Server{}
	texts := []string{"", "plain", `quote " and \ back`, "<b>&amp;</b>", "line\nbreak\ttab\rret\bbs\ffeed", "\x00\x01\x1f\x7f",
		"é ünïcödé 🔥", "sep\u2028and\u2029", "bad \xff\xfe utf8", "> /play bell", "it's 'single'"}
	for _, x := range texts {
		for _, steps := range [][]Step{
			{{A: "prepend", T: x, Last: true, V: x}, {A: "focus", T: "composer"}},
			{{A: "append", V: x}},
			{{A: "go", V: "https://example.test/" + x}, {A: "scroll_to", T: x}},
			{{A: "go"}},
			{{A: "focus", T: x, Last: false}},
		} {
			got, want := sv.Behave("click", steps), behaveMaps(sv, "click", steps)
			if got != want {
				t.Errorf("for %q:\n got %s\nwant %s", x, got, want)
			}
		}
	}
}

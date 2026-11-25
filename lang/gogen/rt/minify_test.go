package rt

import (
	"strings"
	"testing"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
)

func TestMinified(t *testing.T) {
	if got := string(minified("app.css", []byte("/* the header */\na {\n  color : red ;\n}\n"))); got != "a{color:red}" {
		t.Errorf("css: %q", got)
	}
	if got := string(minified("app.js", []byte("// a note\nconst answer = 1 + 2;\nconsole.log( answer );\n"))); got != "const answer=1+2;console.log(answer)" {
		t.Errorf("js: %q", got)
	}
	keep := "/* as it is */ a { color: red }"
	if got := string(minified("app.min.css", []byte(keep))); got != keep {
		t.Errorf("a .min. file changed: %q", got)
	}
	if got := string(minified("logo.svg", []byte(keep))); got != keep {
		t.Errorf("an svg changed: %q", got)
	}
}

// the page script has the widgets and no stream; the stream script has the stream; both are
// sent minified and still carry what pages look for
func TestPageScripts(t *testing.T) {
	if strings.Contains(liveScript, "EventSource") || strings.Contains(liveScript, "/_events") {
		t.Error("the page script opens the stream")
	}
	if !strings.Contains(streamScript, "EventSource") || !strings.Contains(streamScript, "/_channel/") || !strings.Contains(streamScript, "data-signal") {
		t.Error("the stream script lacks the stream, channels or signals")
	}
	for name, pair := range map[string][2]string{"page": {liveScript, liveJS}, "stream": {streamScript, streamJS}, "visual": {visualSource, visualScript}} {
		if len(pair[1]) >= len(pair[0]) {
			t.Errorf("%s script not minified: %d >= %d", name, len(pair[1]), len(pair[0]))
		}
	}
	for _, s := range []string{"cs-markdown-editor", "data-theme-toggle", "crudspec-page", "pushState"} {
		if !strings.Contains(liveJS, s) {
			t.Errorf("minified page script lost %q", s)
		}
	}
}

// each script as sent is still JavaScript a browser reads (a minifier bug would break every page)
func TestScriptsParse(t *testing.T) {
	for name, src := range map[string]string{"page": liveJS, "stream": streamJS, "visual": visualScript} {
		if _, err := js.Parse(parse.NewInputString(src), js.Options{}); err != nil {
			t.Errorf("%s script: %v", name, err)
		}
	}
}

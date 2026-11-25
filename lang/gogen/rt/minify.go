package rt

// Minifying: the app's stylesheets and scripts, and the runtime's own scripts, are sent without
// their comments and spaces. Each is minified once: an asset the first time it's needed (when it
// is hashed and gzipped, assets.go), the runtime's scripts when the binary starts. A request
// never pays for it. A file already minified (.min.css, .min.js) is sent as it is, and so is
// one the minifier can't read: a broken file stays the author's to see, unchanged.

import (
	"bytes"
	"strings"

	"github.com/tdewolff/minify/v2"
	"github.com/tdewolff/minify/v2/css"
	"github.com/tdewolff/minify/v2/js"
)

var minifier = func() *minify.M {
	m := minify.New()
	m.AddFunc("text/css", css.Minify)
	m.Add("text/javascript", &js.Minifier{KeepVarNames: false})
	return m
}()

// minified is the file's bytes minified, by its extension (".css", ".js", ".mjs"); any other, a
// .min. file or one that fails, comes back as it was
func minified(name string, raw []byte) []byte {
	low := strings.ToLower(name)
	kind := ""
	switch {
	case strings.Contains(low, ".min."):
		return raw
	case strings.HasSuffix(low, ".css"):
		kind = "text/css"
	case strings.HasSuffix(low, ".js"), strings.HasSuffix(low, ".mjs"):
		kind = "text/javascript"
	default:
		return raw
	}
	var out bytes.Buffer
	if err := minifier.Minify(kind, &out, bytes.NewReader(raw)); err != nil || out.Len() == 0 {
		return raw
	}
	return out.Bytes()
}

// minJS is a runtime script minified (or as written, if the minifier can't read it)
func minJS(src string) string { return string(minified("x.js", []byte(src))) }

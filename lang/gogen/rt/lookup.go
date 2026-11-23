package rt

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// A lookup an editor's preview may run: <MarkdownEditor known={page_exists(w, _)}> puts the call,
// its function and arguments (the _ left out), in the page, signed with the app's secret, so the
// preview (/_markdown) asks it only of the names the text links to, as the person previewing. The
// signature keeps the arguments as the page gave them; the function runs under the read policies
// all the same.

// SignLookup: the function's name and its arguments (but the last, the name), signed
func (a *App) SignLookup(fn string, args List) string {
	b, _ := json.Marshal(map[string]any{"f": fn, "a": args})
	body := string(b)
	return base64.RawURLEncoding.EncodeToString(b) + "." + a.mac("lookup."+body)
}

// UnsignLookup: what SignLookup signed, or ok false for anything it didn't
func (a *App) UnsignLookup(token string) (fn string, args List, ok bool) {
	i := strings.LastIndexByte(token, '.')
	if i <= 0 {
		return "", nil, false
	}
	b, err := base64.RawURLEncoding.DecodeString(token[:i])
	if err != nil || a.mac("lookup."+string(b)) != token[i+1:] {
		return "", nil, false
	}
	var x struct {
		F string          `json:"f"`
		A json.RawMessage `json:"a"`
	}
	if json.Unmarshal(b, &x) != nil || a.Fns[x.F] == nil {
		return "", nil, false
	}
	l, _ := FromJSON(string(x.A)).(List)
	return x.F, l, true
}

// knownBy: the preview's question for each linked name, the lookup called with it (a refusal, or
// anything but true, is not known)
func (a *App) knownBy(c *Ctx, fn string, args List) func(name string) bool {
	f := a.Fns[fn]
	return func(name string) (known bool) {
		defer func() {
			if recover() != nil {
				known = false
			}
		}()
		v, _ := f(c, append(append(List{}, args...), name)).(bool)
		return v
	}
}

// valueBy: a lookup called with the name, its value (none for a refusal)
func (a *App) valueBy(c *Ctx, fn string, args List, name string) (v Val) {
	defer func() {
		if recover() != nil {
			v = nil
		}
	}()
	return a.Fns[fn](c, append(append(List{}, args...), name))
}

// lookupCall: /_lookup, an editor's question as someone types (the image picker): POST
// {"lookup": a signed lookup, "name": what's typed}; the lookup's value as JSON, asked as the
// person typing. Same origin only.
func (sv *Server) lookupCall(w http.ResponseWriter, r *HTTPReq, who Who) {
	if r.Method != "POST" || !sv.sameOrigin(r) {
		status(w, 403, "")
		return
	}
	var body struct {
		Lookup string `json:"lookup"`
		Name   string `json:"name"`
	}
	if json.Unmarshal([]byte(r.Text), &body) != nil || len(body.Name) > 200 {
		status(w, 400, "")
		return
	}
	fn, args, ok := sv.App.UnsignLookup(body.Lookup)
	if !ok {
		status(w, 400, "")
		return
	}
	v := sv.App.valueBy(sv.App.ctx(r.Sess, nil, who.Actor, r.request(who, "read")), fn, args, body.Name)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	io.WriteString(w, `{"value":`+JSON(v)+`}`)
}

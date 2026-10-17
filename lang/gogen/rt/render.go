package rt

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---- a page being rendered

type Who struct {
	Actor    Val
	Session  string
	Identity string
}

type page struct {
	slots     map[string]string
	slotOrder []string
	channels  []string
	bodyClass []string
}

type RCtx struct {
	Vars  map[string]Val
	Who   Who
	Req   *HTTPReq
	Title string
	P     *page
	sv    *Server
	c     *Ctx
}

func (rc *RCtx) with(vars map[string]Val) *RCtx {
	n := *rc
	n.Vars = vars
	n.c = nil
	return &n
}

func copyVars(m map[string]Val) map[string]Val {
	out := make(map[string]Val, len(m)+1)
	for k, v := range m {
		out[k] = v
	}
	return out
}

// the context the page's expressions are evaluated in: its variables over the ambient ones
func (rc *RCtx) ctx() *Ctx {
	if rc.c == nil {
		sv := rc.sv
		ev := []Event{}
		var res Val
		rc.c = &Ctx{App: sv.App, S: rc.Req.Sess, Vars: rc.Vars, Amb: rc.Req.amb(sv), Actor: rc.Who.Actor,
			Req: &Request{IP: rc.Req.IP, Method: "get", Identity: rc.Who.Identity, UserAgent: rc.Req.UA, SessionToken: rc.Who.Session, Cookies: rc.Req.Cookies, Base: rc.Req.Base, Now: rc.Req.Now},
			Events: &ev, Result: &res}
	}
	return rc.c
}

func (rc *RCtx) ev(e Expr) (v Val) {
	if e == nil {
		return nil
	}
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(*Outcome); ok {
				v = nil
				return
			}
			panic(r)
		}
	}()
	return e(rc.ctx())
}

// ---- HTML helpers

var escaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")

func Esc(s string) string { return escaper.Replace(s) }

// JSON as JavaScript's JSON.stringify writes it (no HTML escaping)
func JSString(v any) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
	return strings.TrimSuffix(b.String(), "\n")
}

func IsRef(v Val) bool { _, ok := v.(Ref); return ok }

// encodeURIComponent
func EncodeURIComponent(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// URLSearchParams' serialization
func formEncode(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("*-._", c) >= 0:
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func (sv *Server) fileURL(v Val) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		if strings.HasPrefix(x, "/") || strings.HasPrefix(x, "http") {
			return x
		}
		if x == "" {
			return ""
		}
		return "/assets/" + x
	case Obj:
		if s, ok := x["stored"]; ok && Plain(s) != "" {
			return "/files/" + Plain(s)
		}
	}
	return ""
}
func (sv *Server) fileURLMaybe(v Val) Val {
	if o, ok := v.(Obj); ok {
		if _, ok := o["stored"]; ok {
			return sv.fileURL(v)
		}
	}
	return v
}

// theme { classes json { … } }: the app's class names for the runtime's markup
func (sv *Server) dc(kind string) string {
	sv.classesOnce.Do(func() {
		sv.classes = map[string]string{}
		if e := sv.UI.Theme["classes"]; e != nil {
			if o, ok := sv.evalPlain(e).(Obj); ok {
				for k, v := range o {
					sv.classes[k] = Plain(v)
				}
			}
		}
	})
	if c, ok := sv.classes[kind]; ok {
		return c
	}
	if kind == "screen_reader" {
		return "visually-hidden"
	}
	return ""
}

// an expression outside any request (theme classes, display labels)
func (sv *Server) evalPlain(e Expr) Val {
	s := sv.App.DB.Session(sv.App.Ents)
	defer s.Done()
	return e(sv.plainCtx(s))
}
func (sv *Server) plainCtx(s *Sess) *Ctx {
	ev := []Event{}
	var res Val
	return &Ctx{App: sv.App, S: s, Vars: map[string]Val{}, Req: &Request{Method: "get"}, Events: &ev, Result: &res}
}

func (sv *Server) iconTag(name Val, size int) string {
	if name == nil || name == false || Plain(name) == "" {
		return ""
	}
	return fmt.Sprintf(`<img src="/assets/%s.svg" width="%d" height="%d" aria-hidden="true" class="%s">`, Esc(Plain(name)), size, size, sv.dc("icon"))
}
func avatarURL(u Val) string {
	if r, ok := u.(Ref); ok {
		return fmt.Sprintf("/avatars/%s/%d", r.E, r.ID)
	}
	return ""
}

func (sv *Server) displayOf(s *Sess, r Ref) string {
	e := sv.App.Ents[r.E]
	var row *Row
	if e != nil {
		row = s.Find(e, r.ID)
	}
	if row == nil {
		return fmt.Sprintf("%s %d", r.E, r.ID)
	}
	d := sv.UI.Displays[r.E]
	if d == nil {
		for _, k := range []string{"name", "title", "label", "subject"} {
			if i, ok := e.Index[k]; ok {
				if str, ok := row.F[i].(string); ok && str != "" {
					return str
				}
			}
		}
		return fmt.Sprintf("%s %d", r.E, r.ID)
	}
	return Plain(d(sv.plainCtx(s).OnRow(e, row)))
}

func snake(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			if i > 0 && s[i-1] >= 'a' && s[i-1] <= 'z' {
				b.WriteByte('_')
			}
			b.WriteByte(c + 32)
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// rows the person may read, by their entity's read permission
func (sv *Server) readable(rows Val, rc *RCtx) []Ref {
	out := []Ref{}
	var list []Val
	switch x := rows.(type) {
	case List:
		list = x
	case []Ref:
		for _, r := range x {
			list = append(list, r)
		}
	}
	for _, v := range list {
		r, ok := v.(Ref)
		if !ok {
			continue
		}
		perm := sv.UI.Permissions[r.E]
		if perm == nil {
			out = append(out, r)
			continue
		}
		if func() (ok bool) {
			defer func() {
				if recover() != nil {
					ok = false
				}
			}()
			return perm(rc.ctx(), r)
		}() {
			out = append(out, r)
		}
	}
	return out
}

func (sv *Server) viewArgs(view string, args []Expr, rc *RCtx) map[string]Val {
	out := map[string]Val{}
	for i, p := range sv.App.Views[view].Params {
		var v Val
		if i < len(args) && args[i] != nil {
			v = rc.ev(args[i])
		}
		out[p.Name] = rawArg(v)
	}
	return out
}

// an argument as the TypeScript runtime passes it to run(): ids for rows, id lists for sets
func rawArg(v Val) Val {
	switch x := v.(type) {
	case Ref:
		return x.ID
	case Set:
		l := make(List, len(x.IDs))
		for i, id := range x.IDs {
			l[i] = id
		}
		return l
	}
	return v
}

func (sv *Server) pickRows(el *El, rc *RCtx, typed string) []Ref {
	if el.Pick == nil || sv.App.Views[el.Pick.View] == nil {
		return []Ref{}
	}
	vars := copyVars(rc.Vars)
	vars["typed"] = typed
	r := sv.App.Run(rc.Req.Sess, el.Pick.View, sv.viewArgs(el.Pick.View, el.Pick.Args, rc.with(vars)), rc.Who.Actor, rc.Req.request(rc.Who, "get"), nil)
	if r.Rows == nil {
		return []Ref{}
	}
	return r.Rows
}

func (sv *Server) pickEntity(el *El) string {
	if el.Pick == nil {
		return ""
	}
	if v := sv.App.Views[el.Pick.View]; v != nil {
		return v.Entity
	}
	return ""
}

func (sv *Server) varsJSON(vars map[string]Val) []any {
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]any, 0, len(keys))
	for _, k := range keys {
		out = append(out, []any{k, vars[k]})
	}
	return out
}

func (sv *Server) pickSrc(el *El, rc *RCtx) string {
	body := base64.RawURLEncoding.EncodeToString([]byte(JSString(map[string]any{"e": el.ID, "v": sv.varsJSON(rc.Vars)})))
	return "/_pick?ctx=" + body + "." + sv.App.Mac(body)
}

func (sv *Server) screenURL(name string, args []Val, named map[string]Val) string {
	d := sv.screenByName[name]
	if d == nil {
		return "/"
	}
	route := d.Route
	q := []string{}
	for i, p := range d.Params {
		var v Val
		if i < len(args) {
			v = args[i]
		} else {
			v = named[p.Name]
		}
		s := ""
		if v != nil {
			if r, ok := v.(Ref); ok {
				s = strconv.FormatInt(r.ID, 10)
			} else {
				s = jsString(v)
			}
		}
		if strings.Contains(route, ":"+p.Name) {
			route = strings.Replace(route, ":"+p.Name, EncodeURIComponent(s), 1)
		} else if s != "" {
			q = append(q, formEncode(p.Name)+"="+formEncode(s))
		}
	}
	if len(q) > 0 {
		return route + "?" + strings.Join(q, "&")
	}
	return route
}

// String(v), as JavaScript writes a value
func jsString(v Val) string {
	switch v.(type) {
	case nil, bool, int64, int, float64, string, Rich, List:
		return Plain(v)
	}
	return "[object Object]"
}

func (sv *Server) targetURL(t *Target, rc *RCtx) string {
	if t.URL != nil {
		return Plain(sv.fileURLMaybe(rc.ev(t.URL)))
	}
	if t.Bare && t.Name == "back" {
		if b := rc.Req.Query.Get("back"); rc.Req.Query.Has("back") {
			return b
		}
		return "javascript:history.back()"
	}
	if t.Bare && t.Name == "home" {
		return "/"
	}
	args := make([]Val, len(t.Args))
	for i, a := range t.Args {
		args[i] = rc.ev(a)
	}
	named := map[string]Val{}
	for _, n := range t.Named {
		named[n.Name] = rc.ev(n.E)
	}
	return sv.screenURL(t.Name, args, named)
}

// an action call's fixed arguments, as hidden fields
func serial(v Val) string {
	switch x := v.(type) {
	case nil:
		return ""
	case Ref:
		return "#" + strconv.FormatInt(x.ID, 10)
	case Set:
		parts := make([]string, len(x.IDs))
		for i, id := range x.IDs {
			parts[i] = strconv.FormatInt(id, 10)
		}
		return "@" + strings.Join(parts, ",")
	case bool, int64, int, float64, string:
		return Plain(v)
	}
	return JSString(v)
}

func (sv *Server) hiddenArgs(action *Action, t *Target, rc *RCtx) string {
	var b strings.Builder
	for i, a := range t.Args {
		if i < len(action.Params) {
			fmt.Fprintf(&b, `<input type="hidden" name="__arg_%s" value="%s">`, action.Params[i].Name, Esc(serial(rc.ev(a))))
		}
	}
	for _, n := range t.Named {
		fmt.Fprintf(&b, `<input type="hidden" name="__arg_%s" value="%s">`, n.Name, Esc(serial(rc.ev(n.E))))
	}
	return b.String()
}

// Handlers ("on ok go …") are stateless: a form carries the handler elements' ids, the page
// and the variables in scope, signed.
func (sv *Server) handlerID(els []*El, rc *RCtx) string {
	ids := make([]int, len(els))
	for i, e := range els {
		ids[i] = e.ID
	}
	p := rc.Req.Path
	if rc.Req.RawQuery != "" {
		p += "?" + rc.Req.RawQuery
	}
	b := make([]byte, 0, 256)
	b = append(b, `{"e":[`...)
	for i, id := range ids {
		if i > 0 {
			b = append(b, ',')
		}
		b = strconv.AppendInt(b, int64(id), 10)
	}
	b = append(b, `],"p":`...)
	b = appendStr(b, p)
	b = append(b, `,"v":`...)
	b = appendVars(b, rc.Vars)
	b = append(b, '}')
	body := base64.RawURLEncoding.EncodeToString(b)
	return body + "." + sv.App.Mac(body)
}

type handler struct {
	path string
	els  []*El
	vars map[string]Val
}

func (sv *Server) verified(token string) ([]byte, bool) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, false
	}
	if !hmacEqual(sv.App.Mac(parts[0]), parts[1]) {
		return nil, false
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[0])
	return b, err == nil
}

func (sv *Server) handlerFrom(token string) *handler {
	b, ok := sv.verified(token)
	if !ok {
		return nil
	}
	var j struct {
		E []int
		P string
		V [][]json.RawMessage
	}
	if json.Unmarshal(b, &j) != nil {
		return nil
	}
	h := &handler{path: "/", vars: map[string]Val{}}
	if strings.HasPrefix(j.P, "/") && !strings.HasPrefix(j.P, "//") {
		h.path = j.P
	}
	for _, id := range j.E {
		if el := sv.UI.Elements[id]; el != nil {
			h.els = append(h.els, el)
		}
	}
	h.vars = varsFrom(j.V)
	return h
}

func varsFrom(v [][]json.RawMessage) map[string]Val {
	out := map[string]Val{}
	for _, kv := range v {
		if len(kv) != 2 {
			continue
		}
		var k string
		json.Unmarshal(kv[0], &k)
		out[k] = FromJSON(string(kv[1]))
	}
	return out
}

// ---- elements

func (sv *Server) render(els []*El, rc *RCtx) string {
	var b strings.Builder
	sv.renderTo(els, rc, &b)
	return b.String()
}

func (sv *Server) cls(el *El, rc *RCtx, base string) string {
	c := ""
	if e := el.Attrs["class"]; e != nil {
		c = Plain(rc.ev(e))
	}
	return strings.TrimSpace(base + " " + c)
}
func (sv *Server) attr(el *El, k string, rc *RCtx) Val {
	if el.Flags[k] {
		return true
	}
	if e := el.Attrs[k]; e != nil {
		return rc.ev(e)
	}
	return nil
}
func present(v Val) bool { return !(v == nil || v == false || v == "" || v == int64(0)) }

func (sv *Server) shown(el *El, rc *RCtx) bool {
	e := el.Attrs["if"]
	return e == nil || Truthy(rc.ev(e))
}

func (sv *Server) label(el *El, rc *RCtx) string {
	l := sv.attr(el, "label", rc)
	if !present(l) {
		return ""
	}
	visible := !el.Has("icon") && !el.Has("text") && (el.Name == "submit" || el.Name == "button" || el.Name == "link" ||
		(el.Name == "field" && (el.FieldKind == "select" || el.FieldKind == "choice" || el.FieldKind == "users") && !el.Has("placeholder")))
	if visible {
		return "<span>" + Esc(Plain(l)) + "</span>"
	}
	return `<span class="` + sv.dc("screen_reader") + `">` + Esc(Plain(l)) + "</span>"
}

func (sv *Server) tokenCSS(rc *RCtx) string {
	e := sv.UI.Theme["tokens"]
	if e == nil {
		return ""
	}
	o, ok := rc.ev(e).(Obj)
	if !ok {
		return ""
	}
	keys := make([]string, 0, len(o))
	for k := range o {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	vars := []string{}
	for _, k := range keys {
		v := jsString(o[k])
		if tokenName.MatchString(k) && tokenValue.MatchString(v) {
			vars = append(vars, "--"+strings.ReplaceAll(k, "_", "-")+": "+v+";")
		}
	}
	if len(vars) == 0 {
		return ""
	}
	return "<style>:root { " + strings.Join(vars, " ") + " }</style>"
}

var tokenName = regexp.MustCompile(`(?i)^[a-z][a-z0-9_-]*$`)
var tokenValue = regexp.MustCompile(`^[^;{}<>\\]+$`)

func jsTime(ms int64) time.Time { return time.UnixMilli(ms) }

func (sv *Server) renderEl(el *El, rc *RCtx, handlers []*El) string {
	if !sv.shown(el, rc) {
		return ""
	}
	kids := func() string { return sv.render(el.Children, rc) }
	icon := sv.attr(el, "icon", rc)
	switch el.Name {
	case "title":
		if el.Head != nil {
			rc.Title = Plain(rc.ev(el.Head))
		}
		return ""
	case "heading":
		return `<h1 class="` + Esc(sv.cls(el, rc, sv.dc("heading"))) + `">` + Esc(Plain(rc.ev(el.Head))) + "</h1>"
	case "text":
		v := rc.ev(el.Head)
		if v == nil {
			return ""
		}
		s := ""
		if r, ok := v.(Ref); ok {
			s = sv.displayOf(rc.Req.Sess, r)
		} else {
			s = jsString(v)
		}
		return `<span class="` + Esc(sv.cls(el, rc, "")) + `">` + Esc(s) + "</span>"
	case "strong":
		return `<strong class="` + Esc(sv.cls(el, rc, "")) + `" title="` + Esc(Plain(sv.attr(el, "title", rc))) + `">` + Esc(Plain(rc.ev(el.Head))) + "</strong>"
	case "richtext":
		rv := rc.ev(el.Head)
		rid := sv.attr(el, "id", rc)
		idAttr := ""
		if present(rid) {
			idAttr = ` id="` + Esc(Plain(rid)) + `"`
		}
		embeds := ""
		if r, ok := rv.(Rich); ok {
			for _, e := range r.Embeds {
				embeds += sv.embedHTML(e)
			}
		}
		return `<div` + idAttr + ` class="` + Esc(sv.cls(el, rc, "")) + `" dir="auto">` + autolink(Esc(Plain(rv))) + embeds + "</div>"
	case "time":
		t, ok := rc.ev(el.Head).(Time)
		if !ok || t.T == 0 {
			return ""
		}
		d := jsTime(t.T)
		text := d.Format("3:04 PM")
		if el.As == "date" {
			text = d.Format("Mon Jan 02 2006")
		}
		return `<time class="` + Esc(sv.cls(el, rc, "")) + `" datetime="` + d.UTC().Format("2006-01-02T15:04:05.000Z") + `">` + Esc(text) + "</time>"
	case "image":
		v := rc.ev(el.Head)
		if !present(v) {
			return ""
		}
		w, h := sv.attr(el, "width", rc), sv.attr(el, "height", rc)
		ws, hs := "", ""
		if present(w) {
			ws = `width="` + jsString(w) + `"`
		}
		if present(h) {
			hs = `height="` + jsString(h) + `"`
		}
		return `<img class="` + Esc(sv.cls(el, rc, "")) + `" src="` + Esc(sv.fileURL(v)) + `" ` + ws + ` ` + hs + ` alt="">`
	case "icon":
		return sv.iconTag(rc.ev(el.Head), 20)
	case "avatar":
		u := rc.ev(el.Head)
		large := ""
		if el.Flags["large"] {
			large = sv.dc("avatar_large")
		}
		alt := sv.attr(el, "label", rc)
		return `<figure class="` + Esc(sv.cls(el, rc, sv.dc("avatar"))) + ` ` + large + `"><img src="` + avatarURL(u) + `" alt="` + Esc(Plain(alt)) + `"></figure>`
	case "avatars":
		l, _ := rc.ev(el.Head).(List)
		var b strings.Builder
		b.WriteString(`<div class="avatar__group">`)
		for _, u := range l {
			b.WriteString(`<span class="avatar"><img src="` + avatarURL(u) + `" alt=""></span>`)
		}
		return b.String() + "</div>"
	case "separator":
		return `<hr class="separator">`
	case "field_display":
		l := sv.attr(el, "label", rc)
		aria := ""
		if present(l) {
			aria = ` aria-label="` + Esc(Plain(l)) + `"`
		}
		return `<input type="text" class="input" readonly value="` + Esc(Plain(rc.ev(el.Head))) + `"` + aria + ">"
	case "let":
		rc.Vars[el.LetName] = rc.ev(el.Head)
		rc.c = nil
		return ""
	case "if":
		if Truthy(rc.ev(el.Head)) {
			return sv.render(el.Children, rc)
		}
		if el.Else != nil {
			return sv.render(el.Else, rc)
		}
		return ""
	case "each":
		l := rc.ev(el.Over)
		var items []Val
		switch x := l.(type) {
		case List:
			items = x
		case Set:
			for _, id := range x.IDs {
				items = append(items, Ref{E: x.E, ID: id})
			}
		}
		var b strings.Builder
		for _, x := range items {
			vars := copyVars(rc.Vars)
			vars[el.Bind] = x
			b.WriteString(sv.render(el.Children, rc.with(vars)))
		}
		return b.String()
	case "list":
		return sv.renderList(el, rc)
	case "use":
		comp := sv.UI.Components[el.Call]
		vars := map[string]Val{}
		for i, p := range comp.Params {
			var v Val
			if i < len(el.CallArgs) {
				v = rc.ev(el.CallArgs[i])
			}
			vars[p] = v
		}
		return sv.render(comp.Body, rc.with(vars))
	case "widget":
		return sv.widget(el, rc)
	case "channel":
		parts := make([]string, len(el.CallArgs))
		for i, a := range el.CallArgs {
			v := rc.ev(a)
			if r, ok := v.(Ref); ok {
				parts[i] = EncodeURIComponent(strconv.FormatInt(r.ID, 10))
			} else {
				parts[i] = EncodeURIComponent(Plain(v))
			}
		}
		rc.P.channels = append(rc.P.channels, el.Call+":"+strings.Join(parts, ","))
		return ""
	case "signal":
		return `<div class="` + sv.dc("signal") + `"></div>`
	case "link":
		href := sv.targetURL(el.T, rc)
		unread := ""
		if e := el.Attrs["unread"]; e != nil && Truthy(rc.ev(e)) {
			unread = " unread"
		}
		base := ""
		if len(el.Children) == 0 {
			base = sv.dc("button")
		}
		return `<a href="` + Esc(href) + `" class="` + Esc(sv.cls(el, rc, base)) + unread + `">` + sv.iconTag(icon, 20) + sv.label(el, rc) + kids() + "</a>"
	case "button":
		return sv.renderButton(el, rc, handlers)
	case "form":
		return sv.renderForm(el, rc)
	case "field":
		return sv.renderField(el, rc)
	case "switch":
		link := sv.attr(el, "link", rc)
		on := el.Flags["on"]
		if !on && el.Attrs["value"] != nil {
			on = Truthy(rc.ev(el.Attrs["value"]))
		}
		checked, auto, linkAttr := "", "", ""
		if on {
			checked = "checked"
		}
		if el.Flags["auto_submit"] {
			auto = `onchange="this.form.requestSubmit()"`
		}
		if present(link) {
			linkAttr = `onchange="location.href=this.dataset.href" data-href="` + Esc(sv.screenURLFromVal(link)) + `"`
		}
		input := `<label class="switch">` + sv.iconTag(icon, 20) + `<input type="checkbox" class="switch__input" ` + checked + ` ` + auto + ` ` + linkAttr + `><span class="switch__btn round"></span>` + sv.label(el, rc) + `</label>`
		return `<div class="` + sv.dc("row") + `">` + input + `</div>`
	case "submit":
		return `<button type="submit" class="` + sv.dc("submit") + `">` + sv.iconTag(icon, 20) + sv.label(el, rc) + `</button>`
	case "section":
		lg := sv.attr(el, "legend", rc)
		banned := ""
		if present(sv.attr(el, "banned", rc)) {
			banned = " banned"
		}
		if present(lg) {
			return `<fieldset class="` + Esc(sv.cls(el, rc, "")) + banned + `"><legend><strong>` + Esc(Plain(lg)) + `</strong></legend>` + kids() + `</fieldset>`
		}
		return `<section class="` + Esc(sv.cls(el, rc, "")) + banned + `" id="` + Esc(Plain(sv.attr(el, "id", rc))) + `">` + kids() + `</section>`
	case "row":
		d := sv.attr(el, "data", rc)
		banned := ""
		if present(sv.attr(el, "banned", rc)) {
			banned = " banned"
		}
		data := ""
		if o, ok := d.(Obj); ok {
			keys := make([]string, 0, len(o))
			for k := range o {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				data += ` data-` + strings.ReplaceAll(k, "_", "-") + `="` + Esc(serial(o[k])) + `"`
			}
		}
		rid := sv.attr(el, "id", rc)
		idAttr := ""
		if present(rid) {
			idAttr = ` id="` + Esc(Plain(rid)) + `"`
		}
		class := sv.dc("row")
		if el.Attrs["class"] != nil {
			class = sv.cls(el, rc, "")
		}
		return `<div` + idAttr + ` class="` + Esc(class) + banned + `"` + data + `>` + kids() + `</div>`
	case "column":
		class := sv.dc("column")
		if el.Attrs["class"] != nil {
			class = sv.cls(el, rc, "")
		}
		return `<div class="` + Esc(class) + `">` + kids() + `</div>`
	case "menu":
		if !present(icon) && !el.Has("label") {
			return `<menu class="` + Esc(sv.cls(el, rc, sv.dc("menu"))) + `">` + kids() + `</menu>`
		}
		return `<details class="` + sv.dc("dropdown") + `"><summary class="` + sv.dc("button") + `">` + sv.iconTag(icon, 20) + sv.label(el, rc) + `</summary><menu class="` + sv.dc("dropdown_panel") + `">` + kids() + `</menu></details>`
	case "popup":
		panel := sv.attr(el, "panel", rc)
		pc := sv.dc("dropdown_panel")
		if panel != nil {
			pc = Plain(panel)
		}
		return `<details class="` + sv.dc("dropdown") + `"><summary class="` + Esc(sv.cls(el, rc, sv.dc("button"))) + `">` + sv.iconTag(icon, 20) + sv.label(el, rc) + `</summary><div class="` + Esc(pc) + `">` + kids() + `</div></details>`
	case "dialog", "frame":
		return "<div>" + kids() + "</div>"
	case "go":
		return ""
	case "nav", "main", "footer", "sidebar":
		html := kids()
		if _, ok := rc.P.slots[el.Name]; !ok {
			rc.P.slotOrder = append(rc.P.slotOrder, el.Name)
		}
		rc.P.slots[el.Name] += html
		if el.Name == "sidebar" && !contains(rc.P.bodyClass, "sidebar") {
			rc.P.bodyClass = append(rc.P.bodyClass, "sidebar")
		}
		return ""
	}
	return ""
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func (sv *Server) screenURLFromVal(v Val) string {
	if s, ok := v.(ScreenRef); ok {
		return sv.screenURL(s.Name, s.Args, nil)
	}
	return Plain(v)
}

func (sv *Server) embedHTML(e Val) string {
	o, _ := e.(Obj)
	img := ""
	if im := o["image"]; im != nil && Plain(im) != "" {
		img = `<div class="` + sv.dc("embed_image") + `"><img src="` + Esc(Plain(im)) + `" alt="" referrerpolicy="no-referrer"></div>`
	}
	return `<figure class="` + sv.dc("embed") + `"><div class="` + sv.dc("embed_body") + `"><div class="` + sv.dc("embed_content") + `"><div class="` + sv.dc("embed_title") + `"><a href="` + Esc(Plain(o["url"])) + `" rel="noreferrer" target="_blank">` + Esc(Plain(o["title"])) + `</a></div>` +
		`<div class="` + sv.dc("embed_description") + `">` + Esc(Plain(o["description"])) + `</div></div>` + img + `</div></figure>`
}

var linkRe = regexp.MustCompile(`(https?://[^\s<]+)`)

func autolink(s string) string {
	s = linkRe.ReplaceAllString(s, `<a href="$1" target="_blank" rel="noopener">$1</a>`)
	return strings.ReplaceAll(s, "\n", "<br>")
}

func (sv *Server) renderList(el *El, rc *RCtx) string {
	var b strings.Builder
	sv.listTo(el, rc, &b)
	return b.String()
}

func (sv *Server) listTo(el *El, rc *RCtx, w *strings.Builder) {
	var refs []Ref
	if el.ListQuery != nil {
		c := rc.ctx()
		for _, row := range el.ListQuery(c) {
			ref := Ref{E: el.ListEntity, ID: row.ID}
			if el.ListPerm == nil || el.ListPerm(c, ref) {
				refs = append(refs, ref)
			}
		}
	} else {
		r := sv.App.Run(rc.Req.Sess, el.ListView, sv.viewArgs(el.ListView, el.ListArgs, rc), rc.Who.Actor, rc.Req.request(rc.Who, "get"), nil)
		refs = r.Rows
	}
	items := make([]map[string]Val, 0, len(refs))
	for _, ref := range refs {
		vars := copyVars(rc.Vars)
		vars[el.Bind] = ref
		items = append(items, vars)
	}
	if el.Where != nil {
		kept := items[:0:0]
		for _, vars := range items {
			if Truthy(rc.with(vars).ev(el.Where)) {
				kept = append(kept, vars)
			}
		}
		items = kept
	}
	if el.Order != nil {
		type keyed struct {
			vars map[string]Val
			k    Val
		}
		ks := make([]keyed, len(items))
		for i, vars := range items {
			ks[i] = keyed{vars, rc.with(vars).ev(el.Order)}
		}
		sort.SliceStable(ks, func(i, j int) bool { return Compare(ks[i].k, ks[j].k) < 0 })
		for i := range ks {
			items[i] = ks[i].vars
		}
		if el.Desc {
			for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
				items[i], items[j] = items[j], items[i]
			}
		}
	}
	w.WriteString(`<div class="` + Esc(sv.cls(el, rc, "")) + `" data-live-list>`)
	for _, vars := range items {
		sv.renderTo(el.Children, rc.with(vars), w)
	}
	w.WriteString(`</div>`)
}

func (sv *Server) callArgs(params []Param, t *Target, rc *RCtx) map[string]Val {
	args := map[string]Val{}
	named := map[string]Expr{}
	for _, n := range t.Named {
		named[n.Name] = n.E
	}
	for i, p := range params {
		var e Expr
		if i < len(t.Args) {
			e = t.Args[i]
		} else {
			e = named[p.Name]
		}
		var v Val
		if e != nil {
			v = rc.ev(e)
		}
		args[p.Name] = rawArg(v)
	}
	return args
}

func (sv *Server) renderButton(el *El, rc *RCtx, handlers []*El) string {
	action := sv.App.Actions[el.T.Name]
	if action == nil {
		return ""
	}
	if !sv.wouldPass(action, el.T, rc) {
		return ""
	}
	confirm := sv.attr(el, "confirm", rc)
	text := sv.attr(el, "text", rc)
	icon := sv.attr(el, "icon", rc)
	hid := sv.handlerID(handlers, rc)
	sel := ""
	if e := el.Attrs["selected"]; e != nil && Truthy(rc.ev(e)) {
		sel = " btn--reversed"
	}
	onsubmit := ""
	if present(confirm) {
		onsubmit = `onsubmit="return confirm(` + Esc(JSString(Plain(confirm))) + `)"`
	}
	txt := ""
	if present(text) {
		txt = Esc(Plain(text))
	}
	return `<form method="post" action="/_do/` + el.T.Name + `" class="` + sv.dc("button_form") + `" ` + onsubmit + `>` + sv.hiddenArgs(action, el.T, rc) +
		`<input type="hidden" name="__h" value="` + hid + `"><button type="submit" class="` + Esc(sv.cls(el, rc, sv.dc("button"))) + sel + `">` + sv.iconTag(icon, 20) + txt + sv.label(el, rc) + sv.render(el.Children, rc) + `</button></form>`
}

func (sv *Server) wouldPass(action *Action, t *Target, rc *RCtx) bool {
	if rc.Who.Actor == nil && !contains(action.Skips, "signed_in") {
		return false
	}
	args := sv.callArgs(action.Params, t, rc)
	o, cause := sv.App.Guards(rc.Req.Sess, action.Name, args, rc.Who.Actor, rc.Req.request(rc.Who, "write"))
	return !((o == "forbidden" || o == "not_found") && cause == "require" || cause == "gate")
}

func (sv *Server) renderForm(el *El, rc *RCtx) string {
	action := sv.App.Actions[el.T.Name]
	if action == nil {
		return ""
	}
	hs := []*El{}
	for _, c := range el.Children {
		if c.Name == "on" {
			hs = append(hs, c)
		}
	}
	hid := sv.handlerID(hs, rc)
	auto := ""
	if el.Flags["auto_submit"] {
		auto = ` onchange="this.requestSubmit()"`
	}
	readonly := el.Attrs["readonly_unless"] != nil && !Truthy(rc.ev(el.Attrs["readonly_unless"]))
	body := sv.render(el.Children, rc)
	dis := ""
	if readonly {
		dis = "disabled"
	}
	return `<form method="post" action="/_do/` + el.T.Name + `" enctype="multipart/form-data" class="` + Esc(sv.cls(el, rc, sv.dc("form"))) + `" id="` + Esc(Plain(sv.attr(el, "id", rc))) + `"` + auto + `>` +
		sv.hiddenArgs(action, el.T, rc) + `<input type="hidden" name="__h" value="` + hid + `"><fieldset ` + dis + ` class="` + sv.dc("fieldset") + `">` + body + `</fieldset></form>`
}

func (sv *Server) renderField(el *El, rc *RCtx) string {
	name, kind := el.FieldName, el.FieldKind
	value := sv.attr(el, "value", rc)
	ph := sv.attr(el, "placeholder", rc)
	req := ""
	if el.Flags["required"] {
		req = " required"
	}
	max := sv.attr(el, "maxlength", rc)
	icon := sv.attr(el, "icon", rc)
	common := `name="` + name + `" class="input" placeholder="` + Esc(Plain(ph)) + `"` + req
	if present(max) {
		common += ` maxlength="` + jsString(max) + `"`
	}
	input := ""
	switch kind {
	case "textarea", "code":
		rows := sv.attr(el, "rows", rc)
		if rows == nil {
			rows = int64(3)
		}
		input = `<textarea ` + common + ` rows="` + jsString(rows) + `">` + Esc(Plain(value)) + `</textarea>`
	case "richtext":
		src := ""
		if el.Has("mentions") {
			src = sv.pickSrc(el, rc)
		}
		unfurlSrc := ""
		if el.Unfurl != "" && sv.App.Views[el.Unfurl] != nil {
			unfurlSrc = "/_view/" + el.Unfurl + "?" + el.UnfurlParam + "="
		}
		srcAttr, unfurlAttr := "", ""
		if src != "" {
			srcAttr = `data-mentions-src="` + Esc(src) + `"`
		}
		if unfurlSrc != "" {
			unfurlAttr = `data-unfurl-src="` + Esc(unfurlSrc) + `"`
		}
		input = `<textarea ` + common + ` rows="1" data-richtext ` + srcAttr + ` ` + unfurlAttr + ` onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!this.dataset.picking){event.preventDefault();this.form.requestSubmit()}">` + Esc(Plain(value)) + `</textarea>`
		if unfurlSrc != "" {
			input += `<input type="hidden" name="` + name + `__embeds" value="[]"><div class="embed-previews"></div>`
		}
		if src != "" {
			input += `<input type="hidden" name="` + name + `__mentions" value=""><input type="hidden" name="` + name + `__mentions_entity" value="` + Esc(sv.pickEntity(el)) + `"><div class="mention-picker" hidden style="position:absolute;bottom:100%;background:var(--color-bg,#fff);border:1px solid #ccc;border-radius:.5em;padding:.25em;z-index:10"></div>`
		}
	case "password":
		input = `<input type="password" ` + common + ` autocomplete="current-password">`
	case "email", "url":
		input = `<input type="` + kind + `" ` + common + ` value="` + Esc(Plain(value)) + `">`
	case "number":
		input = `<input type="number" step="1" ` + common + ` value="` + Esc(Plain(value)) + `">`
	case "choice":
		values, _ := sv.attr(el, "from", rc).(List)
		cur := ""
		if value != nil {
			cur = jsString(value)
		}
		var b strings.Builder
		b.WriteString(`<select name="` + name + `" class="` + sv.dc("input") + `"` + req + `>`)
		if !el.Flags["required"] {
			b.WriteString(`<option value="">—</option>`)
		}
		for _, v := range values {
			s := jsString(v)
			sel := ""
			if s == cur {
				sel = "selected"
			}
			label := strings.ReplaceAll(s, "_", " ")
			if bv, ok := v.(bool); ok {
				label = "No"
				if bv {
					label = "Yes"
				}
			}
			b.WriteString(`<option value="` + Esc(s) + `" ` + sel + `>` + Esc(label) + `</option>`)
		}
		input = b.String() + "</select>"
	case "file":
		multi, accept := "", ""
		if el.Flags["multiple"] {
			multi = "multiple"
		}
		if el.Has("accept") {
			accept = `accept="` + Esc(Plain(sv.attr(el, "accept", rc))) + `"`
		}
		input = `<input type="file" name="` + name + `" ` + multi + ` ` + accept + `>`
	case "hidden":
		input = `<input type="hidden" name="` + name + `" value="` + Esc(serial(value)) + `">`
	case "users", "select":
		var from []Ref
		if f := sv.attr(el, "from", rc); f != nil {
			from = sv.readable(f, rc)
		} else {
			from = sv.readable(sv.pickRows(el, rc, ""), rc)
		}
		var b strings.Builder
		if kind == "users" {
			selected := map[int64]bool{}
			if s, ok := sv.attr(el, "value", rc).(Set); ok {
				for _, id := range s.IDs {
					selected[id] = true
				}
			}
			b.WriteString(`<div class="` + sv.dc("choices") + `">`)
			for _, u := range from {
				chk := ""
				if selected[u.ID] {
					chk = "checked"
				}
				fmt.Fprintf(&b, `<label class="%s"><input type="checkbox" name="%s[]" value="%d" %s><span class="avatar"><img src="%s" alt=""></span><strong>%s</strong></label>`, sv.dc("choice"), name, u.ID, chk, avatarURL(u), Esc(sv.displayOf(rc.Req.Sess, u)))
			}
			input = b.String() + "</div>"
		} else {
			cur := sv.attr(el, "value", rc)
			curID := int64(-1)
			if r, ok := cur.(Ref); ok {
				curID = r.ID
			} else if s, ok := cur.(Set); ok && len(s.IDs) > 0 {
				curID = s.IDs[0]
			}
			b.WriteString(`<select name="` + name + `" class="` + sv.dc("input") + `"` + req + `><option value="">—</option>`)
			for _, u := range from {
				sel := ""
				if u.ID == curID {
					sel = "selected"
				}
				fmt.Fprintf(&b, `<option value="%d" %s>%s</option>`, u.ID, sel, Esc(sv.displayOf(rc.Req.Sess, u)))
			}
			input = b.String() + "</select>"
		}
	default:
		input = `<input type="text" ` + common + ` value="` + Esc(Plain(value)) + `">`
	}
	lab := sv.label(el, rc)
	shownLabel := strings.HasPrefix(lab, "<span>")
	class := sv.dc("field")
	if el.Attrs["class"] != nil {
		class = sv.cls(el, rc, "")
	}
	out := `<label class="` + Esc(class) + `">`
	if shownLabel {
		out += lab
	}
	out += sv.iconTag(icon, 24) + input
	if !shownLabel {
		out += lab
	}
	return out + "</label>"
}

func (sv *Server) widget(el *El, rc *RCtx) string {
	args := make([]Val, len(el.CallArgs))
	for i, a := range el.CallArgs {
		args[i] = rc.ev(a)
	}
	arg0 := Val(nil)
	if len(args) > 0 {
		arg0 = args[0]
	}
	lbl := sv.attr(el, "label", rc)
	if sv.UI.Declared[el.Call] {
		impl := sv.UI.Widgets[el.Call]
		if impl == nil {
			return ""
		}
		label := ""
		if lbl != nil {
			label = Plain(lbl)
		}
		return impl(args, WidgetHelpers{Icon: sv.iconTag(sv.attr(el, "icon", rc), 20), Label: label, Cls: sv.cls(el, rc, ""), DC: sv.dc,
			Display: func(r Ref) string { return sv.displayOf(rc.Req.Sess, r) }, FileURL: sv.fileURL, Attr: func(n string) Val { return sv.attr(el, n, rc) }})
	}
	or := func(v Val, d string) string {
		if v == nil {
			return d
		}
		return Plain(v)
	}
	switch el.Call {
	case "copy_button":
		return `<button type="button" class="` + sv.dc("button") + `" onclick="navigator.clipboard.writeText(` + Esc(JSString(Plain(arg0))) + `)">` + sv.iconTag(sv.attr(el, "icon", rc), 20) + `<span class="` + sv.dc("screen_reader") + `">` + Esc(or(lbl, "Copy")) + `</span></button>`
	case "share_button":
		return `<button type="button" class="` + sv.dc("button") + `" onclick="navigator.share && navigator.share({url: ` + Esc(JSString(Plain(sv.fileURLMaybe(arg0)))) + `})">` + sv.iconTag(sv.attr(el, "icon", rc), 20) + `<span class="` + sv.dc("screen_reader") + `">Share</span></button>`
	case "qr_link":
		return `<a class="` + sv.dc("button") + `" target="_blank" href="/_qr/` + base64.RawURLEncoding.EncodeToString([]byte(Plain(arg0))) + `">` + sv.iconTag(sv.attr(el, "icon", rc), 20) + `<span class="` + sv.dc("screen_reader") + `">` + Esc(or(lbl, "QR code")) + `</span></a>`
	case "lightbox":
		alt := ""
		if o, ok := arg0.(Obj); ok {
			alt = Plain(o["file"])
		}
		return `<a href="` + Esc(sv.fileURL(arg0)) + `" target="_blank"><img src="` + Esc(sv.fileURL(arg0)) + `" style="max-width:100%;max-height:20em" alt="` + Esc(alt) + `"></a>`
	case "push_permission":
		action := sv.App.Actions[el.ArgName]
		if el.ArgName == "" || action == nil {
			return ""
		}
		names := []string{}
		for i, p := range action.Params {
			if i < 3 {
				names = append(names, p.Name)
			}
		}
		return `<button type="button" class="` + Esc(sv.cls(el, rc, sv.dc("button"))) + `" hidden data-push-subscribe="/_do/` + Esc(action.Name) + `" data-push-params="` + Esc(strings.Join(names, ",")) + `" data-push-key="` + Esc(sv.vapidPublic) + `">` + sv.iconTag(sv.attr(el, "icon", rc), 20) + `<span data-push-label>` + Esc(or(sv.attr(el, "label", rc), "Turn on notifications")) + `</span></button>`
	}
	return ""
}

// ---- screens

func (sv *Server) renderScreen(d *Screen, params map[string]Val, who Who, req *HTTPReq, flash string) (html string, redirect string) {
	rc := &RCtx{Vars: params, Who: who, Req: req, P: &page{slots: map[string]string{}}, sv: sv}
	for _, el := range d.Body {
		switch el.Name {
		case "nav", "main", "footer", "sidebar", "title", "channel":
			sv.renderEl(el, rc, nil)
		case "if":
			if Truthy(rc.ev(el.Head)) {
				for _, c := range el.Children {
					if c.Name == "go" {
						return "", sv.targetURL(c.T, rc)
					}
				}
			}
		case "let":
			sv.renderEl(el, rc, nil)
		default:
			if _, ok := rc.P.slots["main"]; !ok {
				rc.P.slotOrder = append(rc.P.slotOrder, "main")
			}
			rc.P.slots["main"] += sv.renderEl(el, rc, nil)
		}
	}
	slot := func(n string) string { return rc.P.slots[n] }
	customCSS := ""
	if e := sv.UI.Theme["custom"]; e != nil {
		customCSS = Plain(rc.ev(e))
	}
	css := ""
	if e := sv.UI.Theme["stylesheets"]; e != nil {
		if l, ok := rc.ev(e).(List); ok {
			for _, n := range l {
				css += `<link rel="stylesheet" href="/assets/` + Esc(Plain(n)) + `">`
			}
		}
	}
	css += sv.tokenCSS(rc)
	chans := []string{}
	for _, c := range rc.P.channels {
		chans = append(chans, `fetch("/_channel/`+c+`/open", {method:"POST"}); setInterval(() => fetch("/_channel/`+c+`/every", {method:"POST"}), 50000); addEventListener("pagehide", () => navigator.sendBeacon("/_channel/`+c+`/close"));`)
	}
	live := strings.NewReplacer("${version}", strconv.FormatInt(sv.App.DB.Version.Load(), 10), "${channels}", strings.Join(chans, "\n"), "${picker_item}", sv.dc("picker_item")).Replace(liveScript)
	title := rc.Title
	if title == "" {
		title = sv.UI.AppName
	}
	var b strings.Builder
	b.WriteString(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">` + "\n")
	b.WriteString(`<title>` + Esc(title) + `</title>` + css)
	if customCSS != "" {
		b.WriteString(`<style>` + customCSS + `</style>`)
	}
	b.WriteString("</head>\n")
	b.WriteString(`<body class="` + strings.Join(rc.P.bodyClass, " ") + `">` + "\n")
	b.WriteString(`<nav id="nav">` + slot("nav") + "</nav>\n")
	if flash != "" {
		b.WriteString(`<div class="flash"><div class="flash__inner shadow">` + Esc(flash) + `</div></div>`)
	}
	b.WriteString("\n" + `<main id="main-content">` + slot("main") + `<footer id="footer">` + slot("footer") + "</footer></main>\n")
	b.WriteString(`<aside id="sidebar">` + slot("sidebar") + "</aside>\n")
	b.WriteString(live + "</body></html>")
	return b.String(), ""
}

const liveScript = `<script>
    // Refresh whenever the server's data is newer than this page, including changes made
    // between rendering and connecting (the stream sends the current version first).
    let V = ${version}; const es = new EventSource("/_events"); let busy = false;
    es.onmessage = async (m) => { const v = Number(m.data); if (v <= V || busy || document.activeElement?.matches("textarea,input[type=text]") && document.activeElement.value) return; busy = true; V = v;
      const html = await (await fetch(location.href, { headers: { "X-Live": "1" } })).text(); const doc = new DOMParser().parseFromString(html, "text/html");
      for (const id of ["main-content", "sidebar", "nav"]) { const a = document.getElementById(id), b = doc.getElementById(id); if (a && b && !a.contains(document.activeElement)) a.innerHTML = b.innerHTML; }
      busy = false; pushState(); };
    ${channels}
    const m = document.querySelector(".messages"); if (m) m.lastElementChild?.scrollIntoView();
    // Push notifications: a push_permission button subscribes this browser once allowed.
    const pushState = async () => {
      const btns = document.querySelectorAll("[data-push-subscribe]"); if (!btns.length || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
      const reg = await navigator.serviceWorker.getRegistration("/"); const sub = await reg?.pushManager.getSubscription();
      document.cookie = "push_endpoint=" + encodeURIComponent(sub?.endpoint ?? "") + "; Path=/; SameSite=Lax" + (sub ? "; Max-Age=31536000" : "; Max-Age=0");
      btns.forEach((b) => { b.hidden = false; if (sub && Notification.permission === "granted") b.querySelector("[data-push-label]").textContent = "Notifications are on"; });
    };
    pushState();
    if (!window.__pushReady) {
      window.__pushReady = true;
      document.addEventListener("click", async (e) => {
        const b = e.target.closest?.("[data-push-subscribe]"); if (!b) return;
        const say = (t) => { b.querySelector("[data-push-label]").textContent = t; };
        if (Notification.permission === "denied" || (await Notification.requestPermission()) !== "granted") return say("Notifications are blocked in this browser");
        const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/service-worker.js"));
        await navigator.serviceWorker.ready;
        const key = Uint8Array.from(atob(b.dataset.pushKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
        try {
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          const j = sub.toJSON(), names = b.dataset.pushParams.split(","), f = new FormData();
          f.set(names[0], j.endpoint); if (names[1]) f.set(names[1], j.keys.p256dh); if (names[2]) f.set(names[2], j.keys.auth);
          const res = await fetch(b.dataset.pushSubscribe + "?fetch=1", { method: "POST", body: f });
          if (res.headers.get("X-Crudspec-Outcome") !== "ok") { await sub.unsubscribe(); return say("Couldn't turn on notifications"); }
        } catch (err) { window.__pushError = String(err); return say("Couldn't turn on notifications"); }
        pushState();
      });
    }
    // Link previews: pasting a link into a field with "unfurl" fetches a preview to send along.
    if (!window.__unfurlReady) {
      window.__unfurlReady = true;
      document.addEventListener("paste", async (e) => {
        const ta = e.target; if (!ta.matches?.("textarea[data-unfurl-src]")) return;
        const text = (e.clipboardData?.getData("text") ?? "").trim(); if (!/^https?:\/\/\S+$/.test(text)) return;
        const res = await fetch(ta.dataset.unfurlSrc + encodeURIComponent(text)); if (res.status !== 200) return;
        const og = (await res.json()).value; if (!og) return;
        const hidden = ta.form.querySelector('input[name="' + ta.name + '__embeds"]'), box = ta.form.querySelector(".embed-previews");
        const list = JSON.parse(hidden.value || "[]"); list.push(og); hidden.value = JSON.stringify(list);
        const card = document.createElement("div"); card.className = "embed-preview"; card.textContent = og.title + " — " + og.description;
        const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.onclick = () => { hidden.value = JSON.stringify(JSON.parse(hidden.value).filter((o) => o.url !== og.url)); card.remove(); };
        card.append(x); box.append(card);
      });
    }
    // Mention picker, delegated from the document so it survives live re-renders: "@" then a
    // name prefix lists matching rows; Enter or a click picks one.
    if (!window.__pickerReady) {
      window.__pickerReady = true;
      let seq = 0;
      const parts = (ta) => ({ hidden: ta.form.querySelector('input[name="' + ta.name + '__mentions"]'), box: ta.parentElement.querySelector(".mention-picker") });
      const query = (ta) => ta.value.slice(0, ta.selectionStart).match(/@([\w ]{0,20})$/);
      const close = (ta) => { const { box } = parts(ta); if (box) box.hidden = true; delete ta.dataset.picking; };
      const pick = (ta, el) => { const at = query(ta); if (!at) return close(ta); const { hidden } = parts(ta); const start = ta.selectionStart - at[0].length;
        ta.value = ta.value.slice(0, start) + "@" + el.textContent + " " + ta.value.slice(ta.selectionStart);
        hidden.value = (hidden.value ? hidden.value + "," : "") + el.dataset.id; close(ta); ta.focus(); };
      document.addEventListener("input", async (e) => {
        const ta = e.target; if (!ta.matches?.("textarea[data-mentions-src]")) return;
        const { box } = parts(ta); ta.parentElement.style.position = "relative";
        const at = query(ta); if (!at) return close(ta);
        const mine = ++seq;
        const rows = await (await fetch(ta.dataset.mentionsSrc + "&typed=" + encodeURIComponent(at[1]))).json();
        if (mine !== seq) return;   // a newer keystroke's results will arrive
        box.innerHTML = rows.map((n) => '<div class="${picker_item}" style="display:block;cursor:pointer" data-id="' + n.id + '">' + String(n.label).replace(/</g, "&lt;") + "</div>").join("");
        if (!rows.length) return close(ta);
        box.hidden = false; ta.dataset.picking = "1";
        box.querySelectorAll("[data-id]").forEach((el) => el.onmousedown = (ev) => { ev.preventDefault(); pick(ta, el); });
      });
      document.addEventListener("keydown", (e) => {
        const ta = e.target; if (!ta.matches?.("textarea[data-mentions-src]")) return;
        const { box } = parts(ta); if (!box || box.hidden) return;
        if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); pick(ta, box.querySelector("[data-id]")); }
        if (e.key === "Escape") close(ta);
      }, true);
    }
  </script>`

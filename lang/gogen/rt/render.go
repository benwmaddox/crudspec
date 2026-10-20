package rt

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---- a page being rendered

type Who struct {
	Actor    Val
	Session  string
	Identity string
}

type page struct {
	slots     map[string]*bytes.Buffer
	hint      int // the screen's estimated size
	screen    *Screen
	plainTok  string               // the token of a button with no handlers: only the page's path
	gates     map[string][2]string // gate outcomes by the gates skipped: they read no arguments
	gateKeys  map[string]Deps      // what each gates' evaluation read: every button that reuses it reads it too
	slotOrder []string
	segs      []pageSeg // cached fragments written into the page's buffers, where (gzip.go)
	channels  []string
	bodyClass []string
	// what every render context of the page shares, made once: the request its expressions
	// see (per caller), the ambient values, and the (unused) events and result
	shared struct {
		who  Who
		req  *Request
		wreq *Request // the same, for writes (the guards of buttons)
		ev   []Event
		res  Val
	}
}

// sharedReq is the page's request for this caller, made once.
func (rc *RCtx) sharedReq() (get, write *Request) {
	sh := &rc.P.shared
	if sh.req == nil || sh.who.Session != rc.Who.Session || sh.who.Identity != rc.Who.Identity || !sameActor(sh.who.Actor, rc.Who.Actor) {
		sh.who = rc.Who
		sh.req = &Request{IP: rc.Req.IP, Method: "get", Identity: rc.Who.Identity, UserAgent: rc.Req.UA, SessionToken: rc.Who.Session, Cookies: rc.Req.Cookies, Base: rc.Req.Base, Now: rc.Req.Now}
		sh.wreq = rc.Req.request(rc.Who, "write")
	}
	return sh.req, sh.wreq
}
func sameActor(a, b Val) bool {
	ra, ok1 := a.(Ref)
	rb, ok2 := b.(Ref)
	if ok1 || ok2 {
		return ok1 && ok2 && ra == rb
	}
	return a == nil && b == nil
}

type RCtx struct {
	Vars  map[string]Val
	Who   Who
	Req   *HTTPReq
	Title string
	P     *page
	sv    *Server
	c     *Ctx
	toks  map[string]string // handler tokens made in this scope, until its variables change
}

func (rc *RCtx) with(vars map[string]Val) *RCtx {
	n := *rc
	n.Vars = vars
	n.c = nil
	n.toks = nil
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
		req, _ := rc.sharedReq()
		rc.c = &Ctx{App: sv.App, S: rc.Req.Sess, Vars: rc.Vars, Amb: rc.Req.amb(sv), Actor: rc.Who.Actor, Req: req, Events: &rc.P.shared.ev, Result: &rc.P.shared.res}
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

// SafeURL is an address a page may hold in an attribute: relative, or http(s), mailto or tel;
// a data: image when image is set (an <img src>). Anything else, javascript: among them, is "#".
func SafeURL(s string, image bool) string {
	t := strings.TrimSpace(s)
	i := strings.IndexAny(t, ":/?#")
	if i < 0 || t[i] != ':' {
		return s // no scheme: relative
	}
	switch strings.ToLower(t[:i]) {
	case "http", "https", "mailto", "tel":
		return s
	case "data":
		if image && strings.HasPrefix(strings.ToLower(t), "data:image/") && !strings.HasPrefix(strings.ToLower(t), "data:image/svg") {
			return s
		}
	}
	return "#"
}

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
		return sv.AssetURL(x)
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
	if kind == "selected" { // a button shown as selected
		return "selected"
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
	// an icon's tag depends only on its name and size (its asset's URL and the theme's class are
	// fixed while the server runs): made once
	n := Plain(name)
	key := n + "|" + strconv.Itoa(size)
	if t, ok := sv.icons.Load(key); ok {
		return t.(string)
	}
	z := strconv.Itoa(size)
	t := `<img src="` + Esc(sv.AssetURL(n+".svg")) + `" width="` + z + `" height="` + z + `" aria-hidden="true" class="` + sv.dc("icon") + `">`
	sv.icons.Store(key, t)
	return t
}
func avatarURL(u Val) string {
	if r, ok := u.(Ref); ok {
		return "/avatars/" + r.E + "/" + strconv.FormatInt(r.ID, 10)
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
		if l := sv.UI.DefaultLabels[r.E]; l != nil {
			if s := l(row); s != "" {
				return s
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
	r := sv.App.Run(rc.Req.Sess, el.Pick.View, el.Pick.Args(rc.with(vars)), rc.Who.Actor, rc.Req.request(rc.Who, "get"), nil)
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
	if f := sv.App.ScreenURLs[name]; f != nil {
		return f(args, named)
	}
	return "/"
}

// String(v), as JavaScript writes a value
func jsString(v Val) string {
	switch v.(type) {
	case nil, bool, int64, int, float64, string, Rich, List:
		return Plain(v)
	}
	return "[object Object]"
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

// Handlers ("on ok go …") are stateless: a form carries the handler elements' ids, the page
// and the variables in scope, signed.
func (sv *Server) handlerID(els []*El, rc *RCtx) string {
	ids := make([]int, len(els))
	for i, e := range els {
		ids[i] = e.ID
	}
	key := fmt.Sprint(ids)
	if t, ok := rc.toks[key]; ok {
		return t
	}
	t := sv.makeHandlerID(ids, rc)
	if rc.toks == nil {
		rc.toks = map[string]string{}
	}
	rc.toks[key] = t
	return t
}

func (sv *Server) makeHandlerID(ids []int, rc *RCtx) string {
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

func present(v Val) bool { return !(v == nil || v == false || v == "" || v == int64(0)) }

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

// ---- screens

func (sv *Server) renderScreen(d *Screen, params map[string]Val, who Who, req *HTTPReq, flash string) (page *bytes.Buffer, redirect string) {
	rc := &RCtx{Vars: params, Who: who, Req: req, P: newPage(), sv: sv}
	rc.P.screen = d
	defer rc.P.release()
	// what the page reads, for live updates; the version first, so no commit made while it
	// renders is missed
	version := req.Sess.ReadVersion()
	req.pageV = version
	req.Sess.Reads, req.Sess.lastOK = Deps{}, false
	req.amb(sv) // the ambient values (the theme's logo reads the database): the page's own reads
	if sv.Test {
		req.Sess.AllReads = Deps{}
	}
	defer func() { req.Sess.Reads, req.Sess.AllReads, req.Sess.frags = nil, nil, nil }()
	if to := d.Render(sv, rc); to != "" {
		return nil, to
	}
	customCSS := ""
	if e := sv.UI.Theme["custom"]; e != nil {
		customCSS = Plain(rc.ev(e))
	}
	css := ""
	if e := sv.UI.Theme["stylesheets"]; e != nil {
		if l, ok := rc.ev(e).(List); ok {
			for _, n := range l {
				css += `<link rel="stylesheet" href="` + Esc(sv.AssetURL(Plain(n))) + `">`
			}
		}
	}
	css += sv.tokenCSS(rc)
	// what the page shows is read: its reader goes back before the page is sent (a slow client
	// would hold it)
	req.Sess.EndSnapshot()
	// the page's data for the live script (one cached file, LiveScriptPath)
	chans := rc.P.channels
	if chans == nil {
		chans = []string{}
	}
	deps := sv.App.DB.Live.HashDeps(req.Sess.Reads)
	sort.Strings(deps) // in one order: the same page is the same bytes (the page cache's check)
	data := map[string]any{"v": version, "d": deps, "channels": chans, "picker": sv.dc("picker_item")}
	if sv.Test { // the keys as they are, for tests
		plain := []string{}
		for _, k := range req.Sess.AllReads {
			plain = append(plain, k.String())
		}
		sort.Strings(plain) // in one order: the same page is the same bytes
		data["dk"] = plain
		own := []string{}
		for _, k := range req.Sess.Reads {
			own = append(own, k.String())
		}
		sort.Strings(own)
		data["dko"] = own // read outside any fragment
	}
	req.Sess.Reads = nil
	pageData := JSString(data)
	live := `<script id="crudspec-page" type="application/json">` + strings.ReplaceAll(pageData, "</", "<\\/") + `</script><script src="` + LiveScriptPath + `" defer></script>`
	title := rc.Title
	if title == "" {
		title = sv.UI.AppName
	}
	b := GetBigBuf(rc.P.hint + 4096)
	// a slot copied into the page, with the places of the cached fragments in it
	put := func(n string) {
		sb := rc.P.slots[n]
		if sb == nil {
			return
		}
		at := b.Len()
		b.Write(sb.Bytes())
		for _, s := range rc.P.segs {
			if s.buf == sb {
				req.segs = append(req.segs, pageSeg{buf: b, off: at + s.off, e: s.e})
			}
		}
	}
	b.WriteString(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">` + "\n")
	b.WriteString(`<title>` + Esc(title) + `</title>` + css)
	if sv.Agents.Enabled() {
		b.WriteString(`<link rel="alternate" type="text/markdown" href="/llms.txt" title="For AI agents">`)
	}
	if customCSS != "" {
		b.WriteString(`<style>` + customCSS + `</style>`)
	}
	b.WriteString("</head>\n")
	b.WriteString(`<body class="` + strings.Join(rc.P.bodyClass, " ") + `">` + "\n")
	b.WriteString(`<a href="#main-content" class="skip-navigation btn">Skip to main content</a>` + "\n")
	b.WriteString(`<nav id="nav">`)
	put("nav")
	b.WriteString("</nav>\n")
	if flash != "" {
		// a notice, or an alert ("!…": what went wrong): an icon shown, the words for assistive
		// tech, gone when its animation ends
		style, icon := "", "check.svg"
		if strings.HasPrefix(flash, "!") {
			flash, style, icon = flash[1:], ` style="--flash-background: var(--color-negative)"`, "alert.svg"
		}
		b.WriteString(`<div class="flash" onanimationend="this.remove()"><div class="flash__inner shadow"` + style + `><img src="` + Esc(sv.AssetURL(icon)) + `" aria-hidden="true" width="24" height="24" class="colorize--white"></div><span class="for-screen-reader" role="alert" aria-atomic="true">` + Esc(flash) + `</span></div>`)
	}
	b.WriteString("\n" + `<main id="main-content">`)
	put("main")
	b.WriteString(`<footer id="footer">`)
	put("footer")
	b.WriteString("</footer></main>\n" + `<aside id="sidebar">`)
	put("sidebar")
	b.WriteString("</aside>\n")
	// the theme's brand: a link to whoever made the app, at the foot of every page
	// (theme { brand json { href, label, image } })
	if e := sv.UI.Theme["brand"]; e != nil {
		if o, ok := rc.ev(e).(Obj); ok {
			b.WriteString(`<a href="` + Esc(Plain(o["href"])) + `" id="app-logo" target="_blank" aria-label="` + Esc(Plain(o["label"])) + `"><img src="` + Esc(sv.AssetURL(Plain(o["image"]))) + `" alt="` + Esc(Plain(o["alt"])) + `"></a>` + "\n")
		}
	}
	b.WriteString(live + "</body></html>")
	// the screen learns the size its pages come to, and starts its next buffers there
	if old := d.learned.Load(); old == 0 {
		d.learned.Store(int64(b.Len()))
	} else {
		d.learned.Store((3*old + int64(b.Len())) / 4)
	}
	return b, ""
}

const liveScript = `(() => {
    const P = JSON.parse(document.getElementById("crudspec-page").textContent);
    // share buttons where the browser can share
    document.querySelectorAll("[data-web-share]").forEach((b) => { b.hidden = !navigator.canShare; });
    // Refresh whenever the server's data is newer than this page, including changes made
    // between rendering and connecting (the stream sends the current version first).
    // The stream sends each commit's keys (hashed); the page refreshes only when they meet what
    // it read (P.d), or when the stream can't say ("*"). It starts after the page's version, so
    // changes made between rendering and connecting count too.
    let V = P.v, D = new Set(P.d), stale = new Set(), all = false, busy = false; window.__live = { pages: 0, frags: 0, bytes: 0 };
    const es = new EventSource("/_events?since=" + V);
    // the page's fragments: <!--f:ID--> … <!--/f:ID HASH KEYS…-->, nested
    const frags = () => { const m = new Map(), stack = [], tw = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT); let n;
      while ((n = tw.nextNode())) { const t = n.data;
        if (t.startsWith("f:")) stack.push({ id: t.slice(2), start: n, parent: stack.at(-1) });
        else if (t.startsWith("/f:")) { const [id, h, ...d] = t.slice(3).split(" "); const f = stack.pop(); if (!f || f.id !== id) continue; f.end = n; f.h = h; f.d = new Set(d); m.set(id, f); } }
      return m; };
    const typing = () => document.activeElement?.matches("textarea,input[type=text]") && document.activeElement.value;
    const inside = (f, node) => node && f.start.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING && f.end.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING;
    const whole = async () => {
      window.__live.pages++;
      const r = await fetch(location.href, { headers: { "X-Live": "1" } }); const html = await r.text(); window.__live.bytes += html.length;
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const id of ["main-content", "sidebar", "nav"]) { const a = document.getElementById(id), b = doc.getElementById(id); if (a && b && !a.contains(document.activeElement)) a.innerHTML = b.innerHTML; }
      const pd = doc.getElementById("crudspec-page"); if (pd) D = new Set(JSON.parse(pd.textContent).d); };
    // just these fragments, from the page as it is now; what the page has unchanged stays
    const some = async (ids, F) => {
      window.__live.frags += ids.length;
      const r = await fetch(location.href, { headers: { "X-Live": "frags", "X-Live-Frags": ids.join(","), "X-Live-Known": [...F.values()].map((f) => f.id + ":" + f.h).join(",") } });
      const text = await r.text(); window.__live.bytes += text.length; const j = JSON.parse(text);
      if (ids.some((id) => j.frags[id] == null)) return whole();
      for (const id of ids) { const f = F.get(id), t = document.createElement("template"); t.innerHTML = j.frags[id];
        const keeps = [], tw = document.createTreeWalker(t.content, NodeFilter.SHOW_COMMENT); let n; while ((n = tw.nextNode())) if (n.data.startsWith("keep:")) keeps.push(n);
        for (const k of keeps) { const o = F.get(k.data.slice(5)); if (!o) return whole(); const range = document.createRange(); range.setStartBefore(o.start); range.setEndAfter(o.end); k.replaceWith(range.extractContents()); }
        const range = document.createRange(); range.setStartBefore(f.start); range.setEndAfter(f.end); range.deleteContents(); range.insertNode(t.content); }
      if (j.page) D = new Set(j.page.d); };
    const refresh = async () => {
      if (busy) return; busy = true;
      try {
        if (all || [...stale].some((k) => D.has(k))) { if (typing()) return; all = false; stale.clear(); await whole(); return; }
        const F = frags(), hit = [...F.values()].filter((f) => [...stale].some((k) => f.d.has(k)));
        const pick = hit.filter((f) => { for (let p = f.parent; p; p = p.parent) if (hit.includes(p)) return false; return true; });
        if (pick.some((f) => typing() && inside(f, document.activeElement))) return;
        stale.clear(); if (pick.length) await some(pick.map((f) => f.id), F);
      } finally { busy = false; pushState(); if (stale.size || all) setTimeout(refresh, 50); }
    };
    es.onmessage = (m) => { const [v, ...keys] = m.data.split(" "); if (Number(v) <= V) return; V = Number(v);
      if (keys[0] === "*") all = true; else for (const k of keys) stale.add(k);
      refresh(); };
    for (const c of P.channels) { fetch("/_channel/" + c + "/open", {method:"POST"}); setInterval(() => fetch("/_channel/" + c + "/every", {method:"POST"}), 50000); addEventListener("pagehide", () => navigator.sendBeacon("/_channel/" + c + "/close")); }
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
        box.innerHTML = rows.map((n) => '<div class="' + P.picker + '" style="display:block;cursor:pointer" data-id="' + n.id + '">' + String(n.label).replace(/</g, "&lt;") + "</div>").join("");
        if (!rows.length) return close(ta);
        box.hidden = false; ta.dataset.picking = "1";
        box.querySelectorAll("[data-id]").forEach((el) => el.onmousedown = (ev) => { ev.preventDefault(); pick(ta, el); });
      });
      // people found as they're typed: suggestions under the box; one picked becomes a chip
      // holding its users[] value
      const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const choose = (box, el) => { box.querySelector("[data-users-chosen]").insertAdjacentHTML("beforeend", '<span class="btn txt-small" data-chosen>' + esc(el.textContent) + '<input type="hidden" name="' + esc(box.dataset.usersName) + '[]" value="' + esc(el.dataset.id) + '"><button type="button" class="btn btn--plain" onclick="this.parentElement.remove()"><span class="for-screen-reader">Remove</span>×</button></span>');
        const inp = box.querySelector("input[type=text]"); inp.value = ""; inp.setCustomValidity(""); box.querySelector(".mention-picker").hidden = true; inp.focus(); };
      document.addEventListener("input", async (e) => {
        const box = e.target.closest?.("[data-users-src]"); if (!box || e.target.type !== "text") return;
        const list = box.querySelector(".mention-picker"), q = e.target.value.trim(); if (!q) { list.hidden = true; return; }
        const mine = ++seq;
        const rows = await (await fetch(box.dataset.usersSrc + "&typed=" + encodeURIComponent(q))).json();
        if (mine !== seq) return;
        const have = new Set([...box.querySelectorAll("[data-chosen] input")].map((h) => h.value));
        list.innerHTML = rows.filter((n) => !have.has(String(n.id))).map((n) => '<div class="' + P.picker + '" style="display:block;cursor:pointer" role="option" aria-selected="false" data-id="' + esc(n.id) + '">' + esc(n.label) + "</div>").join("");
        list.setAttribute("role", "listbox"); list.hidden = !list.children.length;
        list.querySelectorAll("[data-id]").forEach((el) => el.onmousedown = (ev) => { ev.preventDefault(); choose(box, el); });
      });
      document.addEventListener("keydown", (e) => {
        const box = e.target.closest?.("[data-users-src]"); if (!box || e.target.type !== "text" || e.key !== "Enter") return;
        const first = box.querySelector(".mention-picker:not([hidden]) [data-id]"); if (first) { e.preventDefault(); choose(box, first); }
      }, true);
      document.addEventListener("submit", (e) => {
        for (const box of e.target.querySelectorAll?.("[data-users-required]") ?? []) if (!box.querySelector("[data-chosen]")) { const inp = box.querySelector("input[type=text]"); inp.setCustomValidity("Choose someone"); inp.reportValidity(); e.preventDefault(); }
      }, true);
      document.addEventListener("keydown", (e) => {
        const ta = e.target; if (!ta.matches?.("textarea[data-mentions-src]")) return;
        const { box } = parts(ta); if (!box || box.hidden) return;
        if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); pick(ta, box.querySelector("[data-id]")); }
        if (e.key === "Escape") close(ta);
      }, true);
    }
  })();
`

// pieces of a screen's link, for the generated URL functions
func URLPart(v Val) string {
	if v == nil {
		return ""
	}
	if r, ok := v.(Ref); ok {
		return strconv.FormatInt(r.ID, 10)
	}
	return jsString(v)
}
func QueryPart(name string, v Val) string {
	s := URLPart(v)
	if s == "" {
		return ""
	}
	return formEncode(name) + "=" + formEncode(s)
}
func JoinQuery(route string, parts ...string) string {
	kept := parts[:0]
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	if len(kept) == 0 {
		return route
	}
	return route + "?" + strings.Join(kept, "&")
}
func IDOrText(v Val) string { return idOrText(v) }

// ---- buffers, pooled: a page and its slots are written into reused memory

var bufs = sync.Pool{New: func() any { return new(bytes.Buffer) }}

func GetBuf() *bytes.Buffer { b := bufs.Get().(*bytes.Buffer); b.Reset(); return b }
func PutBuf(b *bytes.Buffer) {
	if b == nil || b.Cap() > 4<<20 {
		return
	}
	if b.Cap() >= 64<<10 {
		select {
		case bigBufs <- b:
			return
		default:
		}
	}
	bufs.Put(b)
}

// Large buffers (pages, their main part) are kept in a free list that, unlike sync.Pool,
// survives a garbage collection: a page's buffers are hundreds of kilobytes, and making them
// again after every collection was a sixth of what rendering allocated.
var bigBufs = make(chan *bytes.Buffer, 32)

// GetBigBuf is a buffer for about n bytes.
func GetBigBuf(n int) *bytes.Buffer {
	var b *bytes.Buffer
	select {
	case b = <-bigBufs:
		b.Reset()
	default:
		b = GetBuf()
	}
	b.Grow(n)
	return b
}

func newPage() *page { return &page{slots: map[string]*bytes.Buffer{}} }
func (p *page) release() {
	for _, b := range p.slots {
		PutBuf(b)
	}
}

// LiveScriptPath is where the live script is served: its content's hash is in the name, so a
// browser keeps it for good and fetches it again only when it changes.
var LiveScriptPath = func() string {
	h := sha256.Sum256([]byte(liveScript))
	return "/_live." + hex.EncodeToString(h[:6]) + ".js"
}()

package rt

import (
	"bytes"
	"sync"
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
	slots     map[string]*bytes.Buffer
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
	defer rc.P.release()
	if to := d.Render(sv, rc); to != "" {
		return nil, to
	}
	slot := func(n string) []byte {
		if b := rc.P.slots[n]; b != nil {
			return b.Bytes()
		}
		return nil
	}
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
	b := GetBuf()
	b.WriteString(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">` + "\n")
	b.WriteString(`<title>` + Esc(title) + `</title>` + css)
	if customCSS != "" {
		b.WriteString(`<style>` + customCSS + `</style>`)
	}
	b.WriteString("</head>\n")
	b.WriteString(`<body class="` + strings.Join(rc.P.bodyClass, " ") + `">` + "\n")
	b.WriteString(`<nav id="nav">`)
	b.Write(slot("nav"))
	b.WriteString("</nav>\n")
	if flash != "" {
		b.WriteString(`<div class="flash"><div class="flash__inner shadow">` + Esc(flash) + `</div></div>`)
	}
	b.WriteString("\n" + `<main id="main-content">`)
	b.Write(slot("main"))
	b.WriteString(`<footer id="footer">`)
	b.Write(slot("footer"))
	b.WriteString("</footer></main>\n" + `<aside id="sidebar">`)
	b.Write(slot("sidebar"))
	b.WriteString("</aside>\n")
	b.WriteString(live + "</body></html>")
	return b, ""
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
	if b != nil && b.Cap() <= 4<<20 {
		bufs.Put(b)
	}
}

func newPage() *page { return &page{slots: map[string]*bytes.Buffer{}} }
func (p *page) release() {
	for _, b := range p.slots {
		PutBuf(b)
	}
}

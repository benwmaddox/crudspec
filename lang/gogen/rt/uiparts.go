package rt

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The pieces compiled screens are built from. The generator turns every screen and component
// into a Go function that evaluates its expressions and writes its markup in order; these
// helpers only format values (the TypeScript runtime's markup, exactly).

func (rc *RCtx) Ev(f func(c *Ctx) Val) Val { return rc.ev(f) }
func (rc *RCtx) Ctx() *Ctx                  { return rc.ctx() }
func (rc *RCtx) With1(k string, v Val) *RCtx {
	vars := copyVars(rc.Vars)
	vars[k] = v
	return rc.with(vars)
}
func (rc *RCtx) WithVars(vars map[string]Val) *RCtx { return rc.with(vars) }
func (rc *RCtx) Let(k string, v Val) {
	rc.Vars[k] = v
	rc.toks = nil
}
// AddSlot appends what was rendered for a slot (and gives the buffer back).
func (rc *RCtx) AddSlot(name string, html *bytes.Buffer) {
	rc.Slot(name).Write(html.Bytes())
	PutBuf(html)
}

// Slot is a slot's buffer, to write into: main starts at the screen's size.
func (rc *RCtx) Slot(name string) *bytes.Buffer {
	b, ok := rc.P.slots[name]
	if !ok {
		rc.P.slotOrder = append(rc.P.slotOrder, name)
		if name == "main" {
			b = GetBigBuf(rc.P.hint)
		} else {
			b = GetBuf()
		}
		rc.P.slots[name] = b
	}
	if name == "sidebar" && !contains(rc.P.bodyClass, "sidebar") {
		rc.P.bodyClass = append(rc.P.bodyClass, "sidebar")
	}
	return b
}

// Bind sets a loop's variable for its next item, in the loop's own scope: one scope for the
// whole loop, not a copy per item.
func (rc *RCtx) Bind(k string, v Val) {
	rc.Vars[k] = v
	rc.toks = nil
}
func (rc *RCtx) Channel(name string, args []Val) {
	parts := make([]string, len(args))
	for i, v := range args {
		if r, ok := v.(Ref); ok {
			parts[i] = EncodeURIComponent(strconv.FormatInt(r.ID, 10))
		} else {
			parts[i] = EncodeURIComponent(Plain(v))
		}
	}
	rc.P.channels = append(rc.P.channels, name+":"+strings.Join(parts, ","))
}

func Present(v Val) bool { return present(v) }

func (sv *Server) DC(kind string) string { return sv.dc(kind) }
func (sv *Server) Cls(base string, class Val, has bool) string {
	c := ""
	if has {
		c = Plain(class)
	}
	return strings.TrimSpace(base + " " + c)
}
func (sv *Server) Icon(v Val, size int) string { return sv.iconTag(v, size) }
func (sv *Server) Label(l Val, visible bool) string {
	if !present(l) {
		return ""
	}
	if visible {
		return "<span>" + Esc(Plain(l)) + "</span>"
	}
	return `<span class="` + sv.dc("screen_reader") + `">` + Esc(Plain(l)) + "</span>"
}
func (sv *Server) TextOf(rc *RCtx, v Val) string {
	if r, ok := v.(Ref); ok {
		return sv.displayOf(rc.Req.Sess, r)
	}
	return jsString(v)
}
func (sv *Server) RichHTML(rv, rid Val, class string) string {
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
	return `<div` + idAttr + ` class="` + Esc(class) + `" dir="auto">` + autolink(Esc(Plain(rv))) + embeds + "</div>"
}
func TimeHTML(v Val, as string, class func() string) string {
	t, ok := v.(Time)
	if !ok || t.T == 0 {
		return ""
	}
	d := jsTime(t.T)
	text := d.Format("3:04 PM")
	if as == "date" {
		text = d.Format("Mon Jan 02 2006")
	}
	return `<time class="` + Esc(class()) + `" datetime="` + d.UTC().Format("2006-01-02T15:04:05.000Z") + `">` + Esc(text) + "</time>"
}
func (sv *Server) Image(class string, v, wd, ht Val) string {
	ws, hs := "", ""
	if present(wd) {
		ws = `width="` + jsString(wd) + `"`
	}
	if present(ht) {
		hs = `height="` + jsString(ht) + `"`
	}
	return `<img class="` + Esc(class) + `" src="` + Esc(sv.fileURL(v)) + `" ` + ws + ` ` + hs + ` alt="">`
}
func (sv *Server) Avatar(class string, large bool, u, label Val) string {
	l := ""
	if large {
		l = sv.dc("avatar_large")
	}
	return `<figure class="` + Esc(class) + ` ` + l + `"><img src="` + avatarURL(u) + `" alt="` + Esc(Plain(label)) + `"></figure>`
}
func Avatars(v Val) string {
	l, _ := v.(List)
	var b strings.Builder
	b.WriteString(`<div class="avatar__group">`)
	for _, u := range l {
		b.WriteString(`<span class="avatar"><img src="` + avatarURL(u) + `" alt=""></span>`)
	}
	return b.String() + "</div>"
}
func FieldDisplay(label, v Val) string {
	aria := ""
	if present(label) {
		aria = ` aria-label="` + Esc(Plain(label)) + `"`
	}
	return `<input type="text" class="input" readonly value="` + Esc(Plain(v)) + `"` + aria + ">"
}
func Items(v Val) []Val {
	switch x := v.(type) {
	case List:
		return x
	case Set:
		out := make([]Val, len(x.IDs))
		for i, id := range x.IDs {
			out[i] = Ref{E: x.E, ID: id}
		}
		return out
	}
	return nil
}

// ---- lists

func (sv *Server) QueryRefs(rc *RCtx, entity string, rows []*Row, perm func(c *Ctx, row Val) bool) []Ref {
	c := rc.ctx()
	refs := []Ref{}
	for _, row := range rows {
		ref := Ref{E: entity, ID: row.ID}
		if perm == nil || perm(c, ref) {
			refs = append(refs, ref)
		}
	}
	return refs
}
func (sv *Server) ViewRefs(rc *RCtx, view string, raw map[string]Val) []Ref {
	return sv.App.Run(rc.Req.Sess, view, raw, rc.Who.Actor, rc.Req.request(rc.Who, "get"), nil).Rows
}
// ListRefs is a list's rows, filtered and ordered, each judged in one scratch scope with the
// row bound; the loop then binds each in its own scope (Bind).
func (sv *Server) ListRefs(rc *RCtx, refs []Ref, bind string, where func(rc *RCtx) bool, order func(rc *RCtx) Val, desc bool) []Ref {
	if where == nil && order == nil {
		return refs
	}
	r := rc.With1(bind, nil)
	items := make([]Ref, 0, len(refs))
	keys := []Val{}
	for _, ref := range refs {
		r.Bind(bind, ref)
		if where == nil || where(r) {
			items = append(items, ref)
			if order != nil {
				keys = append(keys, order(r))
			}
		}
	}
	if order != nil {
		idx := make([]int, len(items))
		for i := range idx {
			idx[i] = i
		}
		sort.SliceStable(idx, func(i, j int) bool { return Compare(keys[idx[i]], keys[idx[j]]) < 0 })
		sorted := make([]Ref, len(items))
		for i, k := range idx {
			sorted[i] = items[k]
		}
		items = sorted
		if desc {
			for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
				items[i], items[j] = items[j], items[i]
			}
		}
	}
	return items
}

func (sv *Server) ListItems(rc *RCtx, refs []Ref, bind string, where func(rc *RCtx) bool, order func(rc *RCtx) Val, desc bool) []*RCtx {
	items := make([]*RCtx, 0, len(refs))
	for _, ref := range refs {
		r := rc.With1(bind, ref)
		if where == nil || where(r) {
			items = append(items, r)
		}
	}
	if order != nil {
		keys := make(map[*RCtx]Val, len(items))
		for _, r := range items {
			keys[r] = order(r)
		}
		sort.SliceStable(items, func(i, j int) bool { return Compare(keys[items[i]], keys[items[j]]) < 0 })
		if desc {
			for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
				items[i], items[j] = items[j], items[i]
			}
		}
	}
	return items
}

// ---- links, buttons, forms

func (sv *Server) ScreenURL(name string, args List, named map[string]Val) string {
	return sv.screenURL(name, args, named)
}
func (sv *Server) Back(rc *RCtx) string {
	if rc.Req.Query.Has("back") {
		return rc.Req.Query.Get("back")
	}
	return "javascript:history.back()"
}
func (sv *Server) URLTarget(v Val) string { return Plain(sv.fileURLMaybe(v)) }
func RawArg(v Val) Val                    { return rawArg(v) }

// whether to offer an action's button: its gates and leading requires would pass
func (sv *Server) WouldPass(rc *RCtx, action string, args map[string]Val) bool {
	a := sv.App.Actions[action]
	if rc.Who.Actor == nil && !contains(a.Skips, "signed_in") {
		return false
	}
	o, cause := sv.App.Guards(rc.Req.Sess, action, args, rc.Who.Actor, rc.Req.request(rc.Who, "write"))
	return !((o == "forbidden" || o == "not_found") && cause == "require" || cause == "gate")
}
func (sv *Server) HandlerID(ids []int, rc *RCtx) string {
	// with no handlers, a post reads only the page's path from the token: one does for the page
	if len(ids) == 0 {
		if rc.P.plainTok == "" {
			rc.P.plainTok = sv.makeHandlerID(nil, rc.with(map[string]Val{}))
		}
		return rc.P.plainTok
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
func HiddenArg(name string, v Val) string {
	return `<input type="hidden" name="__arg_` + name + `" value="` + Esc(serial(v)) + `">`
}
func OnSubmit(confirm Val) string {
	if !present(confirm) {
		return ""
	}
	return `onsubmit="return confirm(` + Esc(JSString(Plain(confirm))) + `)"`
}
func TextOrEmpty(v Val) string {
	if !present(v) {
		return ""
	}
	return Esc(Plain(v))
}
func (sv *Server) Switch(icon Val, on, auto bool, link Val, label string) string {
	checked, a, l := "", "", ""
	if on {
		checked = "checked"
	}
	if auto {
		a = `onchange="this.form.requestSubmit()"`
	}
	if present(link) {
		l = `onchange="location.href=this.dataset.href" data-href="` + Esc(sv.screenURLFromVal(link)) + `"`
	}
	return `<div class="` + sv.dc("row") + `"><label class="switch">` + sv.iconTag(icon, 20) + `<input type="checkbox" class="switch__input" ` + checked + ` ` + a + ` ` + l + `><span class="switch__btn round"></span>` + label + `</label></div>`
}
func DataAttrs(d Val) string {
	o, ok := d.(Obj)
	if !ok {
		return ""
	}
	keys := make([]string, 0, len(o))
	for k := range o {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(` data-` + strings.ReplaceAll(k, "_", "-") + `="` + Esc(serial(o[k])) + `"`)
	}
	return b.String()
}

// ---- fields

type FieldVals struct {
	Value, PH, Max, Icon, Rows, From, Accept, Label Val
	Labels                                          map[string]string // a choice of enum values: their labels
	HasFrom, HasClass                               bool
	Class                                           Val
	Visible                                         bool // the label shows (otherwise it is for screen readers)
}

func (sv *Server) FieldHTML(rc *RCtx, id int, f FieldVals) string {
	el := sv.UI.Elements[id]
	name, kind := el.FieldName, el.FieldKind
	req := ""
	if el.Flags["required"] {
		req = " required"
	}
	common := `name="` + name + `" class="input" placeholder="` + Esc(Plain(f.PH)) + `"` + req
	if present(f.Max) {
		common += ` maxlength="` + jsString(f.Max) + `"`
	}
	value := f.Value
	input := ""
	switch kind {
	case "textarea", "code":
		rows := f.Rows
		if rows == nil {
			rows = int64(3)
		}
		input = `<textarea ` + common + ` rows="` + jsString(rows) + `">` + Esc(Plain(value)) + `</textarea>`
	case "richtext":
		src := ""
		if el.Flags["mentions"] {
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
	case "datetime", "date":
		// the browser shows and sends the time in its own zone, and says which (name__tz)
		typ, layout, ms := "datetime-local", "2006-01-02T15:04", ""
		if kind == "date" {
			typ, layout = "date", "2006-01-02"
		}
		shown := ""
		if t, ok := value.(Time); ok {
			ms, shown = strconv.FormatInt(t.T, 10), time.UnixMilli(t.T).Format(layout)
		}
		input = `<input type="` + typ + `" ` + common + ` value="` + shown + `" data-ms="` + ms + `"><input type="hidden" name="` + name + `__tz" value="">` +
			`<script>(function(i){var z=i.nextElementSibling;try{z.value=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}if(i.dataset.ms){var d=new Date(+i.dataset.ms);i.value=new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,` + strconv.Itoa(len(layout)) + `)}})(document.currentScript.previousElementSibling.previousElementSibling)</script>`
	case "time":
		input = `<input type="time" ` + common + ` value="` + Esc(Plain(value)) + `">`
	case "number":
		input = `<input type="number" step="1" ` + common + ` value="` + Esc(Plain(value)) + `">`
	case "choice":
		values, _ := f.From.(List)
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
			if f.Labels != nil {
				label = EnumLabel(f.Labels, Plain(v))
			}
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
		if el.Flags["accept"] {
			accept = `accept="` + Esc(Plain(f.Accept)) + `"`
		}
		input = `<input type="file" name="` + name + `" ` + multi + ` ` + accept + `>`
	case "hidden":
		input = `<input type="hidden" name="` + name + `" value="` + Esc(serial(value)) + `">`
	case "users", "select":
		var from []Ref
		if f.HasFrom && f.From != nil {
			from = sv.readable(f.From, rc)
		} else {
			from = sv.readable(sv.pickRows(el, rc, ""), rc)
		}
		var b strings.Builder
		if kind == "users" {
			selected := map[int64]bool{}
			if s, ok := value.(Set); ok {
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
			curID := int64(-1)
			if r, ok := value.(Ref); ok {
				curID = r.ID
			} else if s, ok := value.(Set); ok && len(s.IDs) > 0 {
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
	lab := sv.Label(f.Label, f.Visible)
	shownLabel := strings.HasPrefix(lab, "<span>")
	class := sv.dc("field")
	if f.HasClass {
		class = sv.Cls("", f.Class, true)
	}
	out := `<label class="` + Esc(class) + `">`
	if shownLabel {
		out += lab
	}
	out += sv.iconTag(f.Icon, 24) + input
	if !shownLabel {
		out += lab
	}
	return out + "</label>"
}

// ---- widgets

type WidgetVals struct {
	Label, Icon Val
	Class       string
	ArgName     string
	PushParams  string // push_permission: the action's first three parameters
	Attr        func(name string) Val
}

func (sv *Server) Widget(rc *RCtx, name string, args []Val, wv WidgetVals) string {
	arg0 := Val(nil)
	if len(args) > 0 {
		arg0 = args[0]
	}
	lbl := wv.Label
	if sv.UI.Declared[name] {
		impl := sv.UI.Widgets[name]
		if impl == nil {
			return ""
		}
		label := ""
		if lbl != nil {
			label = Plain(lbl)
		}
		attr := wv.Attr
		if attr == nil {
			attr = func(string) Val { return nil }
		}
		return impl(args, WidgetHelpers{Icon: sv.iconTag(wv.Icon, 20), Label: label, Cls: wv.Class, DC: sv.dc,
			Display: func(r Ref) string { return sv.displayOf(rc.Req.Sess, r) }, FileURL: sv.fileURL, Attr: attr})
	}
	or := func(v Val, d string) string {
		if v == nil {
			return d
		}
		return Plain(v)
	}
	icon := sv.iconTag(wv.Icon, 20)
	switch name {
	case "copy_button":
		return `<button type="button" class="` + sv.dc("button") + `" onclick="navigator.clipboard.writeText(` + Esc(JSString(Plain(arg0))) + `)">` + icon + `<span class="` + sv.dc("screen_reader") + `">` + Esc(or(lbl, "Copy")) + `</span></button>`
	case "share_button":
		return `<button type="button" class="` + sv.dc("button") + `" onclick="navigator.share && navigator.share({url: ` + Esc(JSString(Plain(sv.fileURLMaybe(arg0)))) + `})">` + icon + `<span class="` + sv.dc("screen_reader") + `">Share</span></button>`
	case "qr_link":
		return `<a class="` + sv.dc("button") + `" target="_blank" href="/_qr/` + base64.RawURLEncoding.EncodeToString([]byte(Plain(arg0))) + `">` + icon + `<span class="` + sv.dc("screen_reader") + `">` + Esc(or(lbl, "QR code")) + `</span></a>`
	case "lightbox":
		alt := ""
		if o, ok := arg0.(Obj); ok {
			alt = Plain(o["file"])
		}
		return `<a href="` + Esc(sv.fileURL(arg0)) + `" target="_blank"><img src="` + Esc(sv.fileURL(arg0)) + `" style="max-width:100%;max-height:20em" alt="` + Esc(alt) + `"></a>`
	case "push_permission":
		action := sv.App.Actions[wv.ArgName]
		if wv.ArgName == "" || action == nil {
			return ""
		}
		class := strings.TrimSpace(sv.dc("button") + " " + wv.Class)
		return `<button type="button" class="` + Esc(class) + `" hidden data-push-subscribe="/_do/` + Esc(action.Name) + `" data-push-params="` + Esc(wv.PushParams) + `" data-push-key="` + Esc(sv.vapidPublic) + `">` + icon + `<span data-push-label>` + Esc(or(lbl, "Turn on notifications")) + `</span></button>`
	}
	return ""
}


// Offer is whether to show an action's button: its gates and its typed guard (the leading
// requires, compiled with the button's arguments) would pass.
func (sv *Server) Offer(rc *RCtx, action string, guard func(c *Ctx) (string, string)) bool {
	a := sv.App.Actions[action]
	if rc.Who.Actor == nil && !contains(a.Skips, "signed_in") {
		return false
	}
	_, wreq := rc.sharedReq()
	c := sv.App.ctx(rc.Req.Sess, map[string]Val{}, rc.Who.Actor, wreq)
	try := func(f func() (string, string)) (o, cause string) {
		defer func() {
			if r := recover(); r != nil {
				if x, ok := r.(*Outcome); ok {
					o, cause = x.O, x.Cause
					return
				}
				o, cause = "ok", "" // a guard that can't be evaluated here doesn't hide the button
			}
		}()
		return f()
	}
	// the gates read the request and the actor, not the button's arguments: once per page
	key := strings.Join(a.Skips, ",")
	g, ok := rc.P.gates[key]
	s := rc.Req.Sess
	if !ok {
		// what the gates read is kept with their outcome, and read again by each button that reuses
		// it (so a fragment kept in the cache, or told of changes, knows its buttons depend on it)
		keep := s.capture
		s.capture = Deps{}
		s.lastOK = false
		g[0], g[1] = try(func() (string, string) { sv.App.gates(c, a.Skips); return "ok", "" })
		if rc.P.gates == nil {
			rc.P.gates, rc.P.gateKeys = map[string][2]string{}, map[string]Deps{}
		}
		rc.P.gates[key], rc.P.gateKeys[key] = g, s.capture
		s.capture = keep
		s.lastOK = false
	} else {
		if s.Reads != nil {
			for id, k := range rc.P.gateKeys[key] {
				s.readID(id, k)
			}
		}
	}
	o, cause := g[0], g[1]
	if o == "ok" && cause == "" {
		o, cause = try(func() (string, string) { return guard(c) })
	}
	return !((o == "forbidden" || o == "not_found") && cause == "require" || cause == "gate")
}

// SizeHint is the screen's estimated size: its buffers start there.
func (rc *RCtx) SizeHint(n int) {
	// what its pages have come to, once known; until then, the compiler's estimate
	if l := rc.P.screen; l != nil && l.learned.Load() > 0 {
		n = int(l.learned.Load() + l.learned.Load()/8)
	}
	rc.P.hint = n
}

package rt

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Requests into compiled code: who is asking, and each action's, view's, screen's and API
// route's arguments are decoded by functions the generator writes for them.

func (sv *Server) whoIs(r *HTTPReq) Who {
	s := r.Sess
	if sv.Test && r.TestActor != "" {
		e, id, _ := strings.Cut(r.TestActor, ":")
		n, _ := strconv.ParseInt(id, 10, 64)
		if ent := sv.App.Ents[e]; ent != nil && s.Find(ent, n) != nil {
			name := ""
			if sv.session != nil {
				name = sv.session.Name
			}
			return Who{Actor: Ref{E: e, ID: n}, Identity: name}
		}
	}
	for _, d := range sv.paramIDs {
		if raw := r.Query.Get(d.Key); raw != "" {
			if who := d.Resolve(sv.plainCtx(s), raw); who != nil {
				return Who{Actor: who, Identity: d.Name}
			}
			return Who{}
		}
	}
	token := r.Cookies[sv.cookie]
	if token == "" || sv.UI.SessionLookup == nil {
		return Who{}
	}
	// the cached answer, while no commit has changed what the lookup reads
	actor, cached, gen := s.DB.IDs.Get(token)
	if !cached {
		actor = sv.UI.SessionLookup(sv.plainCtx(s), token)
		s.DB.IDs.Put(token, actor, gen)
	}
	if actor == nil {
		return Who{}
	}
	return Who{Actor: actor, Session: token, Identity: sv.session.Name}
}

func (sv *Server) sessionCookie(c *Ctx, v Val) string {
	ref, ok := v.(Ref)
	if !ok || sv.UI.SessionToken == nil || ref.E != sv.session.Entity {
		return ""
	}
	token, found := sv.UI.SessionToken(c, ref)
	if !found {
		return ""
	}
	return sv.cookie + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"
}

// ---- form values, by the parameter's type (the generated Form functions call these)

func (r *HTTPReq) formRaw(name string) (v Val, present, fixed bool) {
	if s, ok := r.body("__arg_" + name); ok {
		return unserial(s), true, true
	}
	if f, ok := r.Files[name]; ok {
		return f, true, false
	}
	if b, ok := r.Body[name]; ok {
		if l, ok := b.([]string); ok {
			lv := List{}
			for _, x := range l {
				lv = append(lv, x)
			}
			return lv, true, false
		}
		return b, true, false
	}
	return nil, false, false
}

func (r *HTTPReq) FormSet(name string) Val {
	v, present, _ := r.formRaw(name)
	switch x := v.(type) {
	case List:
		ids := List{}
		for _, e := range x {
			ids = append(ids, jsNumber(e))
		}
		return ids
	case Obj:
		return x["set"]
	case nil:
		return List{}
	}
	if !present || v == "" {
		return List{}
	}
	return List{jsNumber(v)}
}
func (r *HTTPReq) FormRef(name string) Val {
	v, present, _ := r.formRaw(name)
	if ref, ok := v.(Ref); ok {
		return ref.ID
	}
	if !present || v == "" || v == nil {
		return nil
	}
	return jsNumber(v)
}
func (r *HTTPReq) FormBool(name string) Val {
	v, present, fixed := r.formRaw(name)
	if !present {
		if fixed {
			return nil
		}
		if b, ok := r.body("__bool"); ok {
			return b
		}
		return nil
	}
	return v == true || v == "true" || v == "on"
}
func (r *HTTPReq) FormInt(name string) Val {
	v, present, _ := r.formRaw(name)
	if !present || v == "" {
		return nil
	}
	return jsNumber(v)
}
// FormTime is a Time parameter: a datetime or date field's value, in the zone the browser sent
// with it (name__tz; else the server's), or an RFC 3339 time, or milliseconds.
func (r *HTTPReq) FormTime(name string) Val {
	v, present, _ := r.formRaw(name)
	if !present || v == nil || v == "" {
		return nil
	}
	if s, ok := v.(string); ok {
		tz, _, _ := r.formRaw(name + "__tz")
		return parseTime(s, Plain(tz))
	}
	return BindTime(v)
}

// FormValue is any other parameter: text, an enum's value, a file. An empty optional value
// other than Text is none.
func (r *HTTPReq) FormValue(name string, emptyIsNone bool) Val {
	v, present, _ := r.formRaw(name)
	if !present {
		return nil
	}
	if v == "" && emptyIsNone {
		return nil
	}
	return v
}

// FormRich is rich text from a composer: picked mentions still named in the text, and link
// previews, checked.
func (sv *Server) FormRich(r *HTTPReq, name string, optional bool) Val {
	v, present, _ := r.formRaw(name)
	text, isText := v.(string)
	if !isText {
		if !present {
			return nil
		}
		if v == "" && optional {
			return nil
		}
		return v
	}
	picked := []int64{}
	ms, _ := r.body(name + "__mentions")
	for _, x := range strings.Split(ms, ",") {
		if x != "" {
			n, _ := strconv.ParseInt(x, 10, 64)
			picked = append(picked, n)
		}
	}
	entity, _ := r.body(name + "__mentions_entity")
	mentions := []int64{}
	if e := sv.App.Ents[entity]; e != nil {
		for _, id := range picked {
			if r.Sess.Find(e, id) != nil && strings.Contains(text, "@"+sv.displayOf(r.Sess, Ref{E: entity, ID: id})) && !containsID(mentions, id) {
				mentions = append(mentions, id)
			}
		}
	}
	embeds := []any{}
	raw, _ := r.body(name + "__embeds")
	if raw == "" {
		raw = "[]"
	}
	var list []map[string]any
	if json.Unmarshal([]byte(raw), &list) == nil {
		for _, e := range list {
			title, ok1 := e["title"].(string)
			u, ok2 := e["url"].(string)
			if e == nil || !ok1 || !ok2 || !httpURL.MatchString(u) {
				continue
			}
			if len(embeds) == 4 {
				break
			}
			desc := ""
			if d, ok := e["description"]; ok && d != nil {
				desc = fmt.Sprint(d)
			}
			var img Val
			if s, ok := e["image"].(string); ok && httpURL.MatchString(s) {
				img = s
			}
			embeds = append(embeds, Obj{"title": truncate(title, 280), "url": u, "description": truncate(desc, 560), "image": img})
		}
	}
	return Rich{Text: text, Mentions: mentions, Entity: entity, Embeds: embeds}
}

// ---- other argument sources

// a channel's arguments, from its URL: numbers where they are numbers
func ChannelArg(parts []string, i int) Val {
	if i >= len(parts) {
		return nil
	}
	s, _ := url.PathUnescape(parts[i])
	if n, err := strconv.ParseFloat(s, 64); err == nil && n != 0 {
		return int64(n)
	}
	return s
}

// a /_view query parameter
func QueryRef(q url.Values, name string) Val {
	v := q.Get(name)
	if v == "" {
		return nil
	}
	n, _ := strconv.ParseFloat(v, 64)
	return int64(n)
}
func QueryText(q url.Values, name string) Val {
	if v := q.Get(name); v != "" {
		return v
	}
	return nil
}

// a screen parameter, from its route or query
func ScreenRaw(sp map[string]string, q url.Values, name string) string {
	if v, ok := sp[name]; ok {
		return v
	}
	return q.Get(name)
}
func CoerceRef(s *Sess, e *Entity, raw string) Val {
	if raw == "" {
		return nil
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(raw, "#"), 10, 64)
	if err != nil || s.Find(e, n) == nil {
		return nil
	}
	return Ref{E: e.Name, ID: n}
}
func CoerceBool(raw string) Val {
	if raw == "" {
		return nil
	}
	return raw == "true" || raw == "on"
}
func CoerceInt(raw string) Val {
	if raw == "" {
		return nil
	}
	n, _ := strconv.ParseFloat(raw, 64)
	return int64(n)
}
func CoerceText(raw string) Val {
	if raw == "" {
		return nil
	}
	return raw
}

// an API path parameter: a row's id where the target's parameter is a row
func PathRef(p map[string]string, name, entity string) Val {
	v := p[name]
	if v != "" && strings.Trim(v, "0123456789") == "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err == nil {
			return Ref{E: entity, ID: n}
		}
	}
	return v
}

// API arguments: rich text is sent as its text
func APIArg(v Val) Val {
	if r, ok := v.(Rich); ok {
		return r.Text
	}
	if s, ok := v.(Set); ok {
		return s
	}
	return rawArg(v)
}

// ---- handlers ("on ok go …"), compiled: what they decide

type Reacted struct {
	To      string
	Cookies []string
}

func (sv *Server) Flash(re *Reacted, v Val) { re.Cookies = append(re.Cookies, flashCookie(Plain(v))) }

// FlashAlert is Flash for what went wrong (a refused outcome's handler): shown as an alert.
func (sv *Server) FlashAlert(re *Reacted, v Val) { re.Cookies = append(re.Cookies, flashCookie("!"+Plain(v))) }
func (sv *Server) SignInAs(rc *RCtx, re *Reacted, v Val) {
	if c := sv.sessionCookie(rc.ctx(), v); c != "" {
		re.Cookies = append(re.Cookies, c)
	}
}

func (sv *Server) doAction(w http.ResponseWriter, name string, r *HTTPReq, who Who) {
	action := sv.App.Actions[name]
	if action == nil || action.Internal || action.AgentsOnly {
		status(w, 404, "")
		return
	}
	args := action.Form(sv, r)
	out := sv.App.Run(r.Sess, name, args, who.Actor, r.request(who, "write"), nil)
	if out.Outcome == "ok" {
		sv.afterCommit(out.Events, &Request{IP: r.IP, Method: "write", Base: r.Base})
	}
	hs, _ := r.body("__h")
	h := sv.handlerFrom(hs)
	back := "/"
	vars := map[string]Val{}
	var els []*El
	if h != nil {
		back, vars, els = h.path, h.vars, h.els
	}
	vars["result"] = out.Result
	backReq := *r
	backReq.Path, backReq.RawQuery = back, ""
	if i := strings.IndexByte(back, '?'); i >= 0 {
		backReq.Path, backReq.RawQuery = back[:i], back[i+1:]
		backReq.Query, _ = url.ParseQuery(backReq.RawQuery)
	} else {
		backReq.Query = url.Values{}
	}
	backReq.ambient = nil
	rc := &RCtx{Vars: vars, Who: who, Req: &backReq, P: newPage(), sv: sv}
	re := &Reacted{}
	var handler *El
	for _, e := range els {
		if e.Outcome == out.Outcome {
			handler = e
			break
		}
	}
	if handler != nil && handler.React != nil {
		handler.React(sv, rc, re)
	}
	cookies := re.Cookies
	// An action that produces a session row signs this browser in.
	if out.Outcome == "ok" {
		has := false
		for _, c := range cookies {
			if strings.HasPrefix(c, sv.cookie+"=") {
				has = true
			}
		}
		if !has {
			if c := sv.sessionCookie(sv.plainCtx(r.Sess), out.Result); c != "" {
				cookies = append(cookies, c)
			}
		}
	}
	if out.Outcome == "ok" && who.Session != "" && sv.UI.SessionLookup(sv.plainCtx(r.Sess), who.Session) == nil {
		cookies = append(cookies, sv.cookie+"=; Path=/; Max-Age=0")
	}
	w.Header().Set("X-Crudspec-Outcome", out.Outcome)
	if r.Query.Get("fetch") == "1" {
		for _, c := range cookies {
			w.Header().Add("Set-Cookie", c)
		}
		if out.Outcome == "ok" {
			w.WriteHeader(204)
		} else {
			w.WriteHeader(422)
		}
		return
	}
	if out.Outcome != "ok" && handler == nil {
		t, ok := outcomeText[out.Outcome]
		if !ok {
			t = out.Outcome
		}
		cookies = append(cookies, flashCookie(t))
	}
	to := re.To
	if to == "" {
		to = back
	}
	redirect(w, to, cookies)
}

func (sv *Server) apiCall(w http.ResponseWriter, api *APIDecl, route *APIRoute, p map[string]string, r *HTTPReq) {
	var actor Val
	if api.Ident != nil {
		actor = api.Ident.Resolve(sv.plainCtx(r.Sess), p[api.Ident.Key])
	}
	view := sv.App.Views[route.Target]
	vars := route.Vars(p)
	identity := ""
	if actor != nil {
		identity = api.Identity
	}
	who := Who{Actor: actor, Identity: identity}
	q := Obj{}
	for k, v := range r.Query {
		q[k] = v[len(v)-1]
	}
	argVars := copyVars(vars)
	argVars["request"] = Obj{"text": r.Text, "ip": r.IP}
	argVars["query"] = q
	rc := &RCtx{Vars: argVars, Who: who, Req: r, P: newPage(), sv: sv}
	args := route.Args(rc)
	method := "write"
	if view != nil {
		method = "get"
	}
	out := sv.App.Run(r.Sess, route.Target, args, actor, &Request{IP: r.IP, Method: method, Identity: identity, Text: r.Text, Base: r.Base, Now: r.Now}, api.Skips)
	code := map[string]int{"ok": route.Status, "forbidden": 403, "not_found": 404, "invalid": 422, "blocked": 429, "unauthenticated": 401}[out.Outcome]
	if out.Outcome == "ok" && code == 0 {
		code = 200
	}
	if code == 0 {
		code = 500
	}
	if out.Outcome == "ok" && view == nil {
		sv.afterCommit(out.Events, &Request{IP: r.IP, Method: "write", Base: r.Base})
	}
	body := ""
	if out.Outcome == "ok" && route.JSON != nil {
		c := rc.with(vars).ctx()
		if view != nil {
			l := []any{}
			for _, ref := range out.Rows {
				l = append(l, route.JSON(c, ref))
			}
			body = JSString(l)
		} else {
			body = JSString(route.JSON(c, out.Result))
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	io.WriteString(w, body)
}

// CoerceEnum is an enum screen parameter: one of the enum's values (values: the enum's labels,
// by value), else none, as a row that doesn't exist is
func CoerceEnum(raw string, values map[string]string) Val {
	if _, ok := values[raw]; ok {
		return raw
	}
	return nil
}

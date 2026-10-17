package rt

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The generic web layer, as lang/runtime/server.ts: HTTP, sessions, forms, handlers,
// live updates, files, the bot API and the test protocol. Nothing here is app-specific.

type Server struct {
	App          *App
	UI           *UI
	DataDir      string
	AssetDir     string
	Test         bool
	screenByName map[string]*Screen
	screenRes    []*regexp.Regexp
	screenNames  [][]string
	classesOnce  sync.Once
	classes      map[string]string
	vapidPublic  string
	Vapid        *Vapid
	assets       map[string]string
	session      *Identity
	cookie       string
	sessEntity   string
	sessField    string
	sessActor    string
	paramIDs     []*Identity
	Externs      map[string]func(args []Val) Val
	apiRes       []apiRoute
	Agents       *Agents
}

type apiRoute struct {
	api   *APIDecl
	route *APIRoute
	re    *regexp.Regexp
	names []string
}

type HTTPReq struct {
	Method, Path, RawQuery string
	Query                  url.Values
	Cookies                map[string]string
	IP, UA, Host, Base     string
	Body                   map[string]any // string or []string
	Files                  map[string]Obj
	Text                   string
	TestActor              string
	Sess                   *Sess
	ambient                map[string]Val
	Origin, FetchSite      string
	Now                    int64
}

func (r *HTTPReq) request(who Who, method string) *Request {
	return &Request{IP: r.IP, Method: method, Identity: who.Identity, UserAgent: r.UA, SessionToken: who.Session, Cookies: r.Cookies, Base: r.Base, Now: r.Now}
}

// the ambient values screens see: theme, app, client, input
func (r *HTTPReq) amb(sv *Server) map[string]Val {
	if r.ambient == nil {
		var logo Val
		if e := sv.UI.Theme["logo"]; e != nil {
			logo = func() (v Val) {
				defer func() {
					if x := recover(); x != nil {
						if _, ok := x.(*Outcome); !ok {
							panic(x)
						}
					}
				}()
				c := sv.plainCtx(r.Sess)
				return e(c)
			}()
		}
		var push Val
		if p := r.Cookies["push_endpoint"]; p != "" {
			push = p
		}
		r.ambient = map[string]Val{"theme": Obj{"logo": logo}, "app": Obj{"name": sv.UI.AppName, "version": "crudspec-runtime"}, "client": Obj{"push_endpoint": push}, "input": Obj{}}
	}
	return r.ambient
}

func NewServer(app *App, ui *UI, dataDir, assetDir string, test bool) *Server {
	sv := &Server{App: app, UI: ui, DataDir: dataDir, AssetDir: assetDir, Test: test, screenByName: map[string]*Screen{}, assets: map[string]string{}}
	for _, d := range ui.Screens {
		sv.screenByName[d.Name] = d
		names := []string{}
		pat := routeParam.ReplaceAllStringFunc(regexp.QuoteMeta(d.Route), func(m string) string {
			names = append(names, m[1:])
			return "([^/]+)"
		})
		sv.screenRes = append(sv.screenRes, regexp.MustCompile("^"+pat+"$"))
		sv.screenNames = append(sv.screenNames, names)
	}
	for _, id := range ui.Identities {
		switch id.Source {
		case "cookie":
			if sv.session == nil {
				sv.session = id
			}
		case "param":
			sv.paramIDs = append(sv.paramIDs, id)
		}
	}
	sv.cookie = "session"
	if sv.session != nil {
		sv.cookie, sv.sessEntity, sv.sessField = sv.session.Key, sv.session.Entity, sv.session.Field
		if sv.sessField == "" {
			sv.sessField = "token"
		}
		if e := app.Ents[sv.sessEntity]; e != nil {
			for _, f := range e.Fields {
				if f.Type == app.ActorEntity {
					sv.sessActor = f.Name
					break
				}
			}
		}
	}
	for _, api := range ui.APIs {
		for i := range api.Routes {
			rt := &api.Routes[i]
			full := api.Route
			if rt.Path != "" {
				full += "/" + rt.Path
			}
			names := []string{}
			pat := routeParam.ReplaceAllStringFunc(regexp.QuoteMeta(full), func(m string) string {
				names = append(names, m[1:])
				return "([^/]+)"
			})
			sv.apiRes = append(sv.apiRes, apiRoute{api: api, route: rt, re: regexp.MustCompile("^" + pat + "$"), names: names})
		}
	}
	sv.indexAssets(assetDir, "")
	return sv
}

func (sv *Server) indexAssets(dir, rel string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, f := range entries {
		full := filepath.Join(dir, f.Name())
		r2 := f.Name()
		if rel != "" {
			r2 = rel + "/" + f.Name()
		}
		if f.IsDir() {
			sv.indexAssets(full, r2)
			continue
		}
		sv.assets[r2] = full
		if _, ok := sv.assets[f.Name()]; !ok {
			sv.assets[f.Name()] = full
		}
	}
}

func (sv *Server) findAsset(name string) string {
	clean := strings.TrimLeft(name, "/")
	for _, p := range strings.Split(clean, "/") {
		if p == ".." {
			return ""
		}
	}
	if f, ok := sv.assets[clean]; ok {
		return f
	}
	return sv.assets[filepath.Base(clean)]
}

// ---- requests

const maxBody = 25 * 1024 * 1024

func (sv *Server) readReq(w http.ResponseWriter, hr *http.Request) (*HTTPReq, error) {
	r := &HTTPReq{Method: hr.Method, Path: hr.URL.Path, RawQuery: hr.URL.RawQuery, Query: hr.URL.Query(), Cookies: map[string]string{},
		UA: hr.Header.Get("User-Agent"), Host: hr.Host, Body: map[string]any{}, Files: map[string]Obj{}, Origin: hr.Header.Get("Origin"), FetchSite: hr.Header.Get("Sec-Fetch-Site")}
	if r.Host == "" {
		r.Host = "localhost"
	}
	r.Base = "http://" + r.Host
	r.Now = sv.App.Clock()
	for _, part := range strings.Split(hr.Header.Get("Cookie"), ";") {
		part = strings.TrimSpace(part)
		k, v, _ := strings.Cut(part, "=")
		if k == "" {
			continue
		}
		if d, err := url.QueryUnescape(strings.ReplaceAll(v, "+", "%2B")); err == nil {
			v = d
		}
		r.Cookies[k] = v
	}
	peer, _, _ := net.SplitHostPort(hr.RemoteAddr)
	peer = strings.TrimPrefix(peer, "::ffff:")
	fwd := strings.TrimSpace(strings.Split(hr.Header.Get("X-Forwarded-For"), ",")[0])
	r.IP = peer
	if fwd != "" && (peer == "127.0.0.1" || peer == "::1") {
		r.IP = fwd
	}
	if sv.Test {
		r.TestActor = hr.Header.Get("X-Test-Actor")
	}
	if hr.Method == "GET" {
		return r, nil
	}
	raw, err := io.ReadAll(io.LimitReader(hr.Body, maxBody+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxBody {
		return nil, errTooLarge
	}
	r.Text = string(raw)
	ct := hr.Header.Get("Content-Type")
	add := func(k, v string) {
		if strings.HasSuffix(k, "[]") {
			k = k[:len(k)-2]
			l, _ := r.Body[k].([]string)
			r.Body[k] = append(l, v)
		} else {
			r.Body[k] = v
		}
	}
	if strings.HasPrefix(ct, "application/x-www-form-urlencoded") {
		for _, kv := range strings.Split(string(raw), "&") {
			if kv == "" {
				continue
			}
			k, v, _ := strings.Cut(kv, "=")
			k, _ = url.QueryUnescape(k)
			v, _ = url.QueryUnescape(v)
			add(k, v)
		}
	} else if strings.HasPrefix(ct, "multipart/form-data") {
		_, params, _ := mime.ParseMediaType(ct)
		mr := multipart.NewReader(strings.NewReader(string(raw)), params["boundary"])
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			name := p.FormName()
			if name == "" {
				continue
			}
			content, _ := io.ReadAll(p)
			if _, isFile := p.Header["Content-Disposition"]; isFile && strings.Contains(p.Header.Get("Content-Disposition"), "filename=") {
				fn := p.FileName()
				if fn == "" {
					continue
				}
				id := sv.App.Token(16) + filepath.Ext(fn)
				os.WriteFile(filepath.Join(sv.DataDir, "files", id), content, 0o644)
				ctype := p.Header.Get("Content-Type")
				if ctype == "" {
					ctype = "application/octet-stream"
				}
				r.Files[name] = Obj{"file": fn, "stored": id, "content_type": ctype, "size": int64(len(content))}
			} else {
				add(name, string(content))
			}
		}
	}
	return r, nil
}

var errTooLarge = fmt.Errorf("too large")

func (r *HTTPReq) body(k string) (string, bool) {
	v, ok := r.Body[k]
	if !ok {
		return "", false
	}
	if s, ok := v.(string); ok {
		return s, true
	}
	return "", true
}

func (sv *Server) sameOrigin(r *HTTPReq) bool {
	if r.FetchSite != "" && r.FetchSite != "same-origin" && r.FetchSite != "none" {
		return false
	}
	if r.Origin != "" && r.Origin != "null" {
		u, err := url.Parse(r.Origin)
		return err == nil && u.Host == r.Host
	}
	return true
}

// ---- identities

func (sv *Server) resolveParamIdentity(d *Identity, raw string, s *Sess) Val {
	if raw == "" {
		return nil
	}
	format := d.Format
	if format == "" {
		format = "{id}"
	}
	names := []string{}
	for _, m := range regexp.MustCompile(`\{(\w+)\}`).FindAllStringSubmatch(format, -1) {
		names = append(names, m[1])
	}
	lits := regexp.MustCompile(`\{\w+\}`).Split(format, -1)
	pat := ""
	for i, l := range lits {
		if i > 0 {
			pat += "(.+?)"
		}
		pat += regexp.QuoteMeta(l)
	}
	m := regexp.MustCompile("^" + pat + "$").FindStringSubmatch(raw)
	if m == nil {
		return nil
	}
	want := map[string]string{}
	for i, n := range names {
		want[n] = m[i+1]
	}
	e := sv.App.Ents[d.Entity]
	var candidates []*Row
	if id, ok := want["id"]; ok {
		n, err := strconv.ParseInt(id, 10, 64)
		if err == nil {
			if r := s.Find(e, n); r != nil {
				candidates = []*Row{r}
			}
		}
	} else {
		candidates = s.Where(e, names[0], want[names[0]])
	}
	for _, row := range candidates {
		ok := true
		for _, n := range names {
			got := ""
			if n == "id" {
				got = strconv.FormatInt(row.ID, 10)
			} else {
				got = jsString(RowField(e, row, n))
			}
			if got != want[n] {
				ok = false
				break
			}
		}
		if ok && d.Where != nil && !d.Where(sv.plainCtx(s).OnRow(e, row)) {
			ok = false
		}
		if ok {
			return Ref{E: d.Entity, ID: row.ID}
		}
	}
	return nil
}

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
			if who := sv.resolveParamIdentity(d, raw, s); who != nil {
				return Who{Actor: who, Identity: d.Name}
			}
			return Who{}
		}
	}
	token := r.Cookies[sv.cookie]
	if token == "" || sv.sessEntity == "" {
		return Who{}
	}
	rows := s.Where(sv.App.Ents[sv.sessEntity], sv.sessField, token)
	if len(rows) == 0 {
		return Who{}
	}
	return Who{Actor: RowField(sv.App.Ents[sv.sessEntity], rows[0], sv.sessActor), Session: token, Identity: sv.session.Name}
}

// ---- the handler

func (sv *Server) ServeHTTP(w http.ResponseWriter, hr *http.Request) {
	r, err := sv.readReq(w, hr)
	if err != nil {
		w.WriteHeader(413)
		return
	}
	r.Sess = sv.App.DB.Session(sv.App.Ents)
	defer r.Sess.Done()
	defer func() {
		if x := recover(); x != nil {
			fmt.Fprintf(os.Stderr, "server error on %s %s: %v\n", r.Method, r.Path, x)
			w.WriteHeader(500)
			io.WriteString(w, "server error")
		}
	}()
	sv.handle(w, hr, r)
}

func status(w http.ResponseWriter, code int, body string) {
	w.WriteHeader(code)
	io.WriteString(w, body)
}

func redirect(w http.ResponseWriter, to string, cookies []string) {
	for _, c := range cookies {
		w.Header().Add("Set-Cookie", c)
	}
	w.Header().Set("Location", to)
	w.WriteHeader(303)
}

func flashCookie(msg string) string { return "flash=" + EncodeURIComponent(msg) + "; Path=/; Max-Age=10" }

var outcomeText = map[string]string{"forbidden": "You can’t do that.", "not_found": "Not found or inaccessible.", "invalid": "That didn’t work: check what you entered.", "blocked": "Too many requests or unauthorized.", "unauthenticated": "Please sign in."}

var avatarPath = regexp.MustCompile(`^/avatars/(\w+)/(\d+)$`)
var qrPath = regexp.MustCompile(`^/_qr/([A-Za-z0-9_-]+)$`)
var channelPath = regexp.MustCompile(`^/_channel/(\w+):([^/]*)/(open|close|every)$`)
var viewPath = regexp.MustCompile(`^/_view/(\w+)$`)
var doPath = regexp.MustCompile(`^/_do/(\w+)$`)

func (sv *Server) handle(w http.ResponseWriter, hr *http.Request, r *HTTPReq) {
	who := sv.whoIs(r)
	switch {
	case strings.HasPrefix(r.Path, "/assets/"):
		sv.sendFile(w, sv.findAsset(r.Path[8:]))
		return
	case strings.HasPrefix(r.Path, "/files/"):
		sv.sendUpload(w, filepath.Join(sv.DataDir, "files", filepath.Base(r.Path)))
		return
	case r.Path == "/_events":
		sv.events(w, hr)
		return
	case r.Path == "/service-worker.js":
		w.Header().Set("Content-Type", "text/javascript")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(200)
		io.WriteString(w, serviceWorker)
		return
	case r.Path == "/up":
		status(w, 200, "ok")
		return
	}
	if m := avatarPath.FindStringSubmatch(r.Path); m != nil {
		id, _ := strconv.ParseInt(m[2], 10, 64)
		sv.sendAvatar(w, r, m[1], id)
		return
	}
	if m := qrPath.FindStringSubmatch(r.Path); m != nil && len(m[1]) <= 2000 {
		text, err := base64.RawURLEncoding.DecodeString(m[1])
		if err != nil {
			status(w, 400, "")
			return
		}
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "private, max-age=300")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(200)
		io.WriteString(w, QRSVG(string(text), 6, 3))
		return
	}
	if sv.Agents != nil && sv.Agents.Handle(w, r, who, sv.sameOrigin(r)) {
		return
	}

	// channels: presence and the like
	if m := channelPath.FindStringSubmatch(r.Path); m != nil && r.Method == "POST" {
		if !sv.sameOrigin(r) {
			status(w, 403, "")
			return
		}
		d := sv.UI.Channels[m[1]]
		t := ""
		if d != nil {
			switch m[3] {
			case "open":
				t = d.Open
			case "close":
				t = d.Close
			case "every":
				t = d.Every
			}
		}
		if t != "" && who.Actor != nil {
			parts := strings.Split(m[2], ",")
			args := map[string]Val{}
			for i, p := range sv.App.Actions[t].Params {
				if i >= len(parts) {
					args[p.Name] = nil
					continue
				}
				s, _ := url.PathUnescape(parts[i])
				if n, err := strconv.ParseFloat(s, 64); err == nil && n != 0 {
					args[p.Name] = int64(n)
				} else {
					args[p.Name] = s
				}
			}
			out := sv.App.Run(r.Sess, t, args, who.Actor, r.request(who, "write"), nil)
			if out.Outcome == "ok" {
				sv.afterCommit(out.Events, &Request{IP: r.IP, Method: "write", Base: r.Base})
			}
		}
		status(w, 204, "")
		return
	}

	// bot API
	for _, ar := range sv.apiRes {
		if strings.ToUpper(ar.route.Method) != r.Method {
			continue
		}
		m := ar.re.FindStringSubmatch(r.Path)
		if m == nil {
			continue
		}
		p := map[string]string{}
		for i, n := range ar.names {
			p[n], _ = url.PathUnescape(m[i+1])
		}
		sv.apiCall(w, ar.api, ar.route, p, r)
		return
	}

	// pickers
	if r.Path == "/_pick" {
		if who.Actor == nil {
			status(w, 401, "")
			return
		}
		b, ok := sv.verified(r.Query.Get("ctx"))
		if !ok {
			status(w, 400, "")
			return
		}
		var j struct {
			E int
			V [][]json.RawMessage
		}
		json.Unmarshal(b, &j)
		el := sv.UI.Elements[j.E]
		rc := &RCtx{Vars: varsFrom(j.V), Who: who, Req: r, P: &page{slots: map[string]string{}}, sv: sv}
		rows := []Ref{}
		if el != nil {
			rows = sv.pickRows(el, rc, r.Query.Get("typed"))
		}
		out := []any{}
		for _, x := range rows {
			out = append(out, map[string]any{"id": x.ID, "label": sv.displayOf(r.Sess, x)})
		}
		writeJSON(w, 200, out, nil)
		return
	}

	// views as JSON: the permitted rows' ids
	if m := viewPath.FindStringSubmatch(r.Path); m != nil {
		view := sv.App.Views[m[1]]
		if view == nil {
			status(w, 404, "")
			return
		}
		args := map[string]Val{}
		for _, p := range view.Params {
			v := r.Query.Get(p.Name)
			if v == "" {
				args[p.Name] = nil
			} else if _, ok := sv.App.Ents[p.Type]; ok {
				n, _ := strconv.ParseFloat(v, 64)
				args[p.Name] = int64(n)
			} else {
				args[p.Name] = v
			}
		}
		if view.Extern {
			if who.Actor == nil {
				status(w, 401, "")
				return
			}
			c := sv.App.ctx(r.Sess, args, who.Actor, &Request{IP: r.IP, Method: "get", Identity: who.Identity, Base: r.Base, Now: r.Now})
			c.Externs = sv.Externs
			v := view.Value(c)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Crudspec-Outcome", "ok")
			if v == nil {
				w.WriteHeader(204)
				return
			}
			w.WriteHeader(200)
			io.WriteString(w, JSString(map[string]any{"outcome": "ok", "value": v}))
			return
		}
		req := r.request(who, "get")
		out := sv.App.Run(r.Sess, m[1], args, who.Actor, req, nil)
		ids := []int64{}
		for _, x := range out.Rows {
			ids = append(ids, x.ID)
		}
		writeJSON(w, 200, map[string]any{"outcome": out.Outcome, "rows": ids, "value": out.Result}, map[string]string{"X-Crudspec-Outcome": out.Outcome})
		return
	}

	if sv.Test && strings.HasPrefix(r.Path, "/_test/") {
		sv.testEndpoint(w, r)
		return
	}

	// Cross-site writes are refused (CSRF); the bot API is exempt.
	if r.Method != "GET" && !sv.sameOrigin(r) {
		status(w, 403, "cross-site request refused")
		return
	}

	if m := doPath.FindStringSubmatch(r.Path); m != nil && r.Method == "POST" {
		sv.doAction(w, m[1], r, who)
		return
	}

	// screens
	var d *Screen
	var sp map[string]string
	for i, re := range sv.screenRes {
		if m := re.FindStringSubmatch(r.Path); m != nil {
			d = sv.UI.Screens[i]
			sp = map[string]string{}
			for j, n := range sv.screenNames[i] {
				sp[n], _ = url.PathUnescape(m[j+1])
			}
			break
		}
	}
	if d == nil {
		status(w, 404, "not found")
		return
	}
	if !d.Public && who.Actor == nil {
		setupNow := false
		if sv.UI.SetupWhen != nil {
			setupNow = Truthy(sv.UI.SetupWhen(sv.plainCtx(r.Sess)))
		}
		target := sv.UI.SignIn
		if setupNow {
			target = sv.UI.Setup
		}
		to := "/"
		if s := sv.screenByName[target]; s != nil {
			to = s.Route
		}
		redirect(w, to, nil)
		return
	}
	params := map[string]Val{}
	for _, p := range d.Params {
		raw, ok := sp[p.Name]
		if !ok {
			raw = r.Query.Get(p.Name)
		}
		params[p.Name] = sv.coerce(p, raw, r.Sess)
	}
	rc := &RCtx{Vars: params, Who: who, Req: r, P: &page{slots: map[string]string{}}, sv: sv}
	for _, q := range d.Requires {
		if !Truthy(rc.ev(q.Cond)) {
			if q.Go != nil {
				var cookies []string
				if q.Flash != nil {
					cookies = append(cookies, flashCookie(Plain(rc.ev(q.Flash))))
				}
				redirect(w, sv.targetURL(q.Go, rc), cookies)
				return
			}
			code := 403
			if q.Outcome == "not_found" {
				code = 404
			}
			t, ok := outcomeText[q.Outcome]
			if !ok {
				t = q.Outcome
			}
			status(w, code, t)
			return
		}
	}
	if d.Remember != "" && len(d.Params) > 0 {
		w.Header().Add("Set-Cookie", d.Remember+"="+EncodeURIComponent(serial(params[d.Params[0].Name]))+"; Path=/; Max-Age=31536000")
	}
	html, to := sv.renderScreen(d, params, who, r, r.Cookies["flash"])
	if to != "" {
		redirect(w, to, nil)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Cookies["flash"] != "" {
		w.Header().Add("Set-Cookie", "flash=; Path=/; Max-Age=0")
	}
	w.WriteHeader(200)
	io.WriteString(w, html)
}

func writeJSON(w http.ResponseWriter, code int, v any, headers map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	for k, x := range headers {
		w.Header().Set(k, x)
	}
	w.WriteHeader(code)
	io.WriteString(w, JSString(v))
}

func (sv *Server) coerce(p Param, raw string, s *Sess) Val {
	if raw == "" {
		return nil
	}
	if e, ok := sv.App.Ents[p.Type]; ok {
		n, err := strconv.ParseInt(strings.TrimPrefix(raw, "#"), 10, 64)
		if err != nil || s.Find(e, n) == nil {
			return nil
		}
		return Ref{E: p.Type, ID: n}
	}
	switch p.Type {
	case "Bool":
		return raw == "true" || raw == "on"
	case "Int":
		n, _ := strconv.ParseFloat(raw, 64)
		return int64(n)
	}
	return raw
}

// ---- actions from forms

func unserial(s string) Val {
	switch {
	case s == "":
		return nil
	case strings.HasPrefix(s, "#"):
		n, _ := strconv.ParseFloat(s[1:], 64)
		return Ref{E: "?", ID: int64(n)}
	case strings.HasPrefix(s, "@"):
		ids := List{}
		for _, p := range strings.Split(s[1:], ",") {
			if p != "" {
				n, _ := strconv.ParseFloat(p, 64)
				ids = append(ids, int64(n))
			}
		}
		return Obj{"set": ids}
	case s == "true" || s == "false":
		return s == "true"
	case strings.HasPrefix(s, "{"):
		var x any
		d := json.NewDecoder(strings.NewReader(s))
		d.UseNumber()
		if d.Decode(&x) == nil {
			return Lift(x)
		}
		return s
	}
	return s
}

func jsNumber(v Val) Val {
	switch x := v.(type) {
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil {
			return nil
		}
		return int64(n)
	case int64:
		return x
	}
	return Num(v)
}

var httpURL = regexp.MustCompile(`^https?://`)

func (sv *Server) argsFromForm(action *Action, r *HTTPReq) map[string]Val {
	out := map[string]Val{}
	for _, p := range action.Params {
		fixedS, hasFixed := r.body("__arg_" + p.Name)
		var v Val
		present := true
		if hasFixed {
			v = unserial(fixedS)
		} else if f, ok := r.Files[p.Name]; ok {
			v = f
		} else if b, ok := r.Body[p.Name]; ok {
			if l, ok := b.([]string); ok {
				lv := List{}
				for _, x := range l {
					lv = append(lv, x)
				}
				v = lv
			} else {
				v = b
			}
		} else {
			present = false
		}
		_, isEntity := sv.App.Ents[p.Type]
		switch {
		case p.Type == "set":
			switch x := v.(type) {
			case List:
				ids := List{}
				for _, e := range x {
					ids = append(ids, jsNumber(e))
				}
				v = ids
			case Obj:
				v = x["set"]
			case nil:
				v = List{}
			default:
				if !present || v == "" {
					v = List{}
				} else {
					v = List{jsNumber(v)}
				}
			}
		case isEntity:
			if ref, ok := v.(Ref); ok {
				v = ref.ID
			} else if !present || v == "" || v == nil {
				v = nil
			} else {
				v = jsNumber(v)
			}
		case p.Type == "Bool":
			if !present {
				if hasFixed {
					v = nil
				} else if b, ok := r.body("__bool"); ok {
					v = b
				} else {
					v = nil
				}
			} else {
				v = v == true || v == "true" || v == "on"
			}
		case p.Type == "Int":
			if !present || v == "" {
				v = nil
			} else {
				v = jsNumber(v)
			}
		case p.Type == "RichText" && isString(v):
			text := v.(string)
			picked := []int64{}
			ms, _ := r.body(p.Name + "__mentions")
			for _, x := range strings.Split(ms, ",") {
				if x != "" {
					n, _ := strconv.ParseInt(x, 10, 64)
					picked = append(picked, n)
				}
			}
			entity, _ := r.body(p.Name + "__mentions_entity")
			mentions := []int64{}
			if e := sv.App.Ents[entity]; e != nil {
				for _, id := range picked {
					if r.Sess.Find(e, id) != nil && strings.Contains(text, "@"+sv.displayOf(r.Sess, Ref{E: entity, ID: id})) && !containsID(mentions, id) {
						mentions = append(mentions, id)
					}
				}
			}
			embeds := []any{}
			raw, _ := r.body(p.Name + "__embeds")
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
			v = Rich{Text: text, Mentions: mentions, Entity: entity, Embeds: embeds}
		case !present:
			v = nil
		case v == "" && p.Optional && p.Type != "Text":
			v = nil
		}
		out[p.Name] = v
	}
	return out
}

func isString(v Val) bool { _, ok := v.(string); return ok }

// String.prototype.slice(0, n), by UTF-16 code units
func truncate(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

func (sv *Server) doAction(w http.ResponseWriter, name string, r *HTTPReq, who Who) {
	action := sv.App.Actions[name]
	if action == nil || action.Internal {
		status(w, 404, "")
		return
	}
	args := sv.argsFromForm(action, r)
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
	rc := &RCtx{Vars: vars, Who: who, Req: &backReq, P: &page{slots: map[string]string{}}, sv: sv}
	cookies := []string{}
	var to string
	var handler *El
	for _, e := range els {
		if e.Outcome == out.Outcome {
			handler = e
			break
		}
	}
	if handler != nil {
		for _, re := range handler.Reactions {
			switch re.Kind {
			case "go":
				to = sv.targetURL(re.Target, rc.with(copyVars(vars)))
			case "flash":
				cookies = append(cookies, flashCookie(Plain(re.Value(rc.ctx()))))
			case "sign_in_as":
				if ref, ok := re.Value(rc.ctx()).(Ref); ok {
					if row := r.Sess.Find(sv.App.Ents[ref.E], ref.ID); row != nil {
						cookies = append(cookies, sv.cookie+"="+Plain(RowField(sv.App.Ents[ref.E], row, sv.sessField))+"; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000")
					}
				}
			}
		}
	}
	// An action that produces a session row signs this browser in.
	if ref, ok := out.Result.(Ref); out.Outcome == "ok" && ok && ref.E == sv.sessEntity {
		has := false
		for _, c := range cookies {
			if strings.HasPrefix(c, sv.cookie+"=") {
				has = true
			}
		}
		if !has {
			if row := r.Sess.Find(sv.App.Ents[ref.E], ref.ID); row != nil {
				cookies = append(cookies, sv.cookie+"="+Plain(RowField(sv.App.Ents[ref.E], row, sv.sessField))+"; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000")
			}
		}
	}
	if out.Outcome == "ok" && who.Session != "" && len(r.Sess.Where(sv.App.Ents[sv.sessEntity], sv.sessField, who.Session)) == 0 {
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
	if to == "" {
		to = back
	}
	redirect(w, to, cookies)
}

func (sv *Server) apiCall(w http.ResponseWriter, api *APIDecl, route *APIRoute, p map[string]string, r *HTTPReq) {
	var idDecl *Identity
	for _, d := range sv.UI.Identities {
		if d.Name == api.Identity {
			idDecl = d
		}
	}
	var actor Val
	if idDecl != nil {
		actor = sv.resolveParamIdentity(idDecl, p[idDecl.Key], r.Sess)
	}
	view := sv.App.Views[route.Target]
	var params []Param
	if view != nil {
		params = view.Params
	} else {
		params = sv.App.Actions[route.Target].Params
	}
	vars := map[string]Val{}
	for k, v := range p {
		var pt *Param
		for i := range params {
			if params[i].Name == k {
				pt = &params[i]
			}
		}
		_, isEnt := sv.App.Ents[func() string {
			if pt != nil {
				return pt.Type
			}
			return ""
		}()]
		if n, err := strconv.ParseInt(v, 10, 64); pt != nil && isEnt && err == nil && regexp.MustCompile(`^\d+$`).MatchString(v) {
			vars[k] = Ref{E: pt.Type, ID: n}
		} else {
			vars[k] = v
		}
	}
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
	rc := &RCtx{Vars: argVars, Who: who, Req: r, P: &page{slots: map[string]string{}}, sv: sv}
	args := map[string]Val{}
	for i, pp := range params {
		var v Val
		if i < len(route.Args) && route.Args[i] != nil {
			v = route.Args[i](rc.ctx())
		}
		if rv, ok := v.(Rich); ok {
			v = rv.Text
		}
		args[pp.Name] = rawArg(v)
		if _, ok := v.(Set); ok {
			args[pp.Name] = v
		}
	}
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

// ---- workflows, after the response

func (sv *Server) afterCommit(events []Event, req *Request) {
	if len(events) == 0 {
		return
	}
	go func() {
		defer func() {
			if x := recover(); x != nil {
				fmt.Fprintf(os.Stderr, "workflow error: %v\n", x)
			}
		}()
		sv.App.RunWorkflows(events, req, sv.Externs)
	}()
}

// ---- live updates: the data version, whenever it changes

func (sv *Server) events(w http.ResponseWriter, hr *http.Request) {
	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(200)
	last := sv.App.DB.Version.Load()
	fmt.Fprintf(w, "data: %d\n\n", last)
	if fl != nil {
		fl.Flush()
	}
	t := time.NewTicker(200 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-hr.Context().Done():
			return
		case <-t.C:
			if v := sv.App.DB.Version.Load(); v != last {
				last = v
				fmt.Fprintf(w, "data: %d\n\n", v)
				if fl != nil {
					fl.Flush()
				}
			}
		}
	}
}

// ---- files

var mimeTypes = map[string]string{".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".mp3": "audio/mpeg", ".js": "text/javascript"}
var inlineUploads = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp3": "audio/mpeg", ".mp4": "video/mp4"}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func (sv *Server) sendFile(w http.ResponseWriter, path string) {
	if path == "" || !isFile(path) {
		status(w, 404, "")
		return
	}
	ct, ok := mimeTypes[filepath.Ext(path)]
	if !ok {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "max-age=300")
	w.WriteHeader(200)
	f, _ := os.Open(path)
	defer f.Close()
	io.Copy(w, f)
}

// Uploads: only raster images, audio and video inline; anything else is downloaded.
func (sv *Server) sendUpload(w http.ResponseWriter, path string) {
	if !isFile(path) {
		status(w, 404, "")
		return
	}
	inline, ok := inlineUploads[strings.ToLower(filepath.Ext(path))]
	h := w.Header()
	if ok {
		h.Set("Content-Type", inline)
		h.Set("Content-Disposition", "inline")
	} else {
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Content-Disposition", "attachment")
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "private, max-age=300")
	w.WriteHeader(200)
	f, _ := os.Open(path)
	defer f.Close()
	io.Copy(w, f)
}

var imageName = regexp.MustCompile(`(?i)\.(svg|png|webp|jpe?g|gif)$`)

func (sv *Server) sendAvatar(w http.ResponseWriter, r *HTTPReq, entity string, id int64) {
	e := sv.App.Ents[entity]
	av := sv.UI.Avatars[entity]
	var row *Row
	if e != nil {
		row = r.Sess.Find(e, id)
	}
	if row == nil || av == nil {
		status(w, 404, "")
		return
	}
	v := av(sv.plainCtx(r.Sess).OnRow(e, row))
	if o, ok := v.(Obj); ok {
		if s := Plain(o["stored"]); s != "" {
			sv.sendUpload(w, filepath.Join(sv.DataDir, "files", s))
			return
		}
	}
	text := Plain(v)
	if imageName.MatchString(text) {
		sv.sendFile(w, sv.findAsset(text))
		return
	}
	initials := strings.ToUpper(firstUnits(strings.TrimSpace(text), 3))
	if initials == "" {
		initials = "?"
	}
	hue := (id * 47) % 360
	w.Header().Set("Content-Type", "image/svg+xml")
	w.WriteHeader(200)
	fmt.Fprintf(w, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="hsl(%d 55%% 55%%)"/><text x="50%%" y="50%%" fill="white" font-family="system-ui,sans-serif" font-size="230" font-weight="600" dominant-baseline="central" text-anchor="middle">%s</text></svg>`, hue, Esc(initials))
}

func firstUnits(s string, n int) string { return truncate(s, n) }

func hmacEqual(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// ---- serving

func (sv *Server) Listen(port int) error {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	fmt.Printf("crudspec app: %s on http://%s (data %s)\n", sv.App.Name, addr, sv.DataDir)
	srv := &http.Server{Addr: addr, Handler: sv, ReadHeaderTimeout: 10 * time.Second}
	return srv.ListenAndServe()
}

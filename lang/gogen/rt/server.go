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
	Mail         MailConfig // where send mail's messages go (mail.go)
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
	Auth                   string
	Now                    int64
	Live, LiveFrags, LiveKnown string // a live page's refresh: X-Live, and for "frags" which ones and what it has
	NoCache                    bool   // render without the fragment cache (X-No-Cache, --test only)
	Gzip                       bool   // the client takes gzip (Accept-Encoding)
	segs                       []pageSeg // the page's cached fragments, where they are in it (gzip.go)
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
		sv.screenRes = append(sv.screenRes, d.Pattern)
		sv.screenNames = append(sv.screenNames, d.Names)
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
	if app.DB != nil {
		app.DB.IDs.Configure(ui.SessionReads)
	}
	if sv.session != nil {
		sv.cookie, sv.sessEntity, sv.sessField = sv.session.Key, sv.session.Entity, sv.session.Field
		if sv.sessField == "" {
			sv.sessField = "token"
		}
	}
	for _, api := range ui.APIs {
		for i := range api.Routes {
			rt := &api.Routes[i]
			sv.apiRes = append(sv.apiRes, apiRoute{api: api, route: rt, re: rt.Pattern, names: rt.Names})
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
		UA: hr.Header.Get("User-Agent"), Host: hr.Host, Body: map[string]any{}, Files: map[string]Obj{}, Origin: hr.Header.Get("Origin"), FetchSite: hr.Header.Get("Sec-Fetch-Site"), Auth: hr.Header.Get("Authorization"), Gzip: AcceptsGzip(hr.Header.Get("Accept-Encoding")),
		Live: hr.Header.Get("X-Live"), LiveFrags: hr.Header.Get("X-Live-Frags"), LiveKnown: hr.Header.Get("X-Live-Known")}
	if r.Host == "" {
		r.Host = "localhost"
	}
	r.Base = "http://" + r.Host
	r.NoCache = sv.Test && hr.Header.Get("X-No-Cache") != ""
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
			fmt.Fprintf(os.Stderr, "server error on %s %s: %s\n", r.Method, r.Path, failure(x))
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
	case r.Path == LiveScriptPath:
		w.Header().Set("Content-Type", "text/javascript")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.WriteHeader(200)
		io.WriteString(w, liveScript)
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
		var call *ChannelCall
		if d != nil {
			switch m[3] {
			case "open":
				call = d.Open
			case "close":
				call = d.Close
			case "every":
				call = d.Every
			}
		}
		if call != nil && who.Actor != nil {
			args := call.Args(strings.Split(m[2], ","))
			out := sv.App.Run(r.Sess, call.Action, args, who.Actor, r.request(who, "write"), nil)
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
		rc := &RCtx{Vars: varsFrom(j.V), Who: who, Req: r, P: newPage(), sv: sv}
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
		args := view.Query(r.Query)
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
	params := d.Coerce(sp, r.Query, r.Sess)
	rc := &RCtx{Vars: params, Who: who, Req: r, P: newPage(), sv: sv}
	if d.Guard != nil {
		if g := d.Guard(sv, rc); g.Refused {
			if g.To != "" {
				redirect(w, g.To, g.Cookies)
				return
			}
			code := 403
			if g.Outcome == "not_found" {
				code = 404
			}
			t, ok := outcomeText[g.Outcome]
			if !ok {
				t = g.Outcome
			}
			status(w, code, t)
			return
		}
	}
	// an export: the file, or why not
	if d.File != nil {
		dl := d.File(sv, rc)
		if dl.Outcome != "ok" {
			code := map[string]int{"not_found": 404, "unauthenticated": 401, "blocked": 429, "invalid": 422}[dl.Outcome]
			if code == 0 {
				code = 403
			}
			t, ok := outcomeText[dl.Outcome]
			if !ok {
				t = dl.Outcome
			}
			status(w, code, t)
			return
		}
		serveDownload(w, dl)
		return
	}
	if d.Remember != "" {
		w.Header().Add("Set-Cookie", d.Remember+"="+EncodeURIComponent(serial(params[d.RememberParam]))+"; Path=/; Max-Age=31536000")
	}
	page, to := sv.renderScreen(d, params, who, r, r.Cookies["flash"])
	if to != "" {
		redirect(w, to, nil)
		return
	}
	if r.Live == "frags" { // a live page asking for fragments
		writeJSON(w, 200, liveFrags(page.Bytes(), r.LiveFrags, r.LiveKnown), nil)
		PutBuf(page)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Cookies["flash"] != "" {
		w.Header().Add("Set-Cookie", "flash=; Path=/; Max-Age=0")
	}
	writeBody(w, r, 200, page.Bytes(), r.segs)
	r.segs = nil
	PutBuf(page)
}

func writeJSON(w http.ResponseWriter, code int, v any, headers map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	for k, x := range headers {
		w.Header().Set(k, x)
	}
	w.WriteHeader(code)
	io.WriteString(w, JSString(v))
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

// ---- workflows, after the response

func (sv *Server) afterCommit(events []Event, req *Request) {
	if len(events) == 0 {
		return
	}
	go func() {
		defer func() {
			if x := recover(); x != nil {
				fmt.Fprintf(os.Stderr, "workflow error: %s\n", failure(x))
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
	// each message: the newest version, and the keys of the commits since the last one (or *)
	last, _ := strconv.ParseInt(hr.URL.Query().Get("since"), 10, 64)
	if last <= 0 {
		last = sv.App.DB.Version.Load()
	}
	send := func() {
		v, keys, all := sv.App.DB.Live.Since(last)
		if v == last && !all {
			return
		}
		if all {
			keys = []string{"*"}
		}
		if v < sv.App.DB.Version.Load() {
			v = sv.App.DB.Version.Load()
		}
		last = v
		fmt.Fprintf(w, "data: %d %s\n\n", v, strings.Join(keys, " "))
		if fl != nil {
			fl.Flush()
		}
	}
	fmt.Fprint(w, ": live\n\n")
	send()
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
			send()
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

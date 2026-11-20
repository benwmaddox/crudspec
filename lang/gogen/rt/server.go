package rt

import (
	"errors"
	"hash/crc32"
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
	assetInfos sync.Map // full path -> *assetInfo (assets.go)
	assetURLs  sync.Map // asset name -> its address with the hash (assets.go)
	icons      sync.Map // icon name and size -> its tag (iconTag)
	Pages      PageCache // whole pages (pagecache.go)
	Metrics    *Metrics  // what it did since it started (metrics.go)
	signals    sigHub    // who listens to which signal (signal.go)
	streams    streamCount // the live streams open, in all and by person (streams.go)
	App          *App
	Mail         MailConfig // where send mail's messages go (mail.go)
	UI           *UI
	DataDir      string
	AssetDir     string
	Test         bool
	Proxies      int // proxies on this machine in front of the app (X-Forwarded-For hops); 1 by default
	CDNCache     int // seconds a CDN may keep what a request with no cookies gets (--cdn-cache); 0: none
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
	ContentType            string // the request body's
	Secure                 bool   // reached over https: TLS, a local proxy's X-Forwarded-Proto, or an https --base-url
	Auth                   string
	Now                    int64
	Live, LiveFrags, LiveKnown string // a live page's refresh: X-Live, and for "frags" which ones and what it has
	NoCache                    bool   // render without the fragment cache (X-No-Cache, --test only)
	Prune                      string // X-Prune: 0 (off), check (prune.go), --test only
	Gzip                       bool   // the client takes gzip (Accept-Encoding)
	IfNoneMatch                string // a cached asset's ETag, to revalidate
	segs                       []pageSeg // the page's cached fragments, where they are in it (gzip.go)
	pageKey                    string     // its key in the page cache, when its page may be kept (pagecache.go)
	pageV                      int64      // the data version its page was rendered from
	pageCheck                  *pageEntry // --check-cache: the kept page this fresh one must equal
	pageCookies                []string   // the cookies its page sets (kept with it)
	cacheHit                   bool       // its page came from the page cache
}

func (r *HTTPReq) request(who Who, method string) *Request {
	return &Request{IP: r.IP, Method: method, Identity: who.Identity, UserAgent: r.UA, SessionToken: who.Session, Cookies: r.Cookies, Base: r.Base, Host: HostName(r.Host), Now: r.Now}
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
				sessionCookie = id.Key // the page cache keeps signed-out pages only (pagecache.go)
			}
		case "param":
			sv.paramIDs = append(sv.paramIDs, id)
		}
	}
	sv.cookie = "session"
	if app.DB != nil {
		app.DB.IDs.Configure(ui.SessionReads)
		app.DB.Pages, sv.Pages.Now = &sv.Pages, &app.DB.Version
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
		UA: hr.Header.Get("User-Agent"), Host: hr.Host, Body: map[string]any{}, Files: map[string]Obj{}, Origin: hr.Header.Get("Origin"), FetchSite: hr.Header.Get("Sec-Fetch-Site"), Auth: hr.Header.Get("Authorization"), Gzip: AcceptsGzip(hr.Header.Get("Accept-Encoding")), IfNoneMatch: hr.Header.Get("If-None-Match"),
		Live: hr.Header.Get("X-Live"), LiveFrags: hr.Header.Get("X-Live-Frags"), LiveKnown: hr.Header.Get("X-Live-Known")}
	if r.Host == "" {
		r.Host = "localhost"
	}
	r.Base = "http://" + r.Host
	r.NoCache = sv.Test && hr.Header.Get("X-No-Cache") != ""
	if sv.Test {
		r.Prune = hr.Header.Get("X-Prune")
	}
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
	r.IP = peer
	// behind a proxy on this machine, the visitor is the one the proxy says: the address it added
	// to X-Forwarded-For (the last, or the Nth from the end behind N proxies: --proxies), never the
	// first, which is whatever the visitor sent
	if peer == "127.0.0.1" || peer == "::1" {
		if ip := forwardedFor(hr.Header.Values("X-Forwarded-For"), sv.Proxies); ip != "" {
			r.IP = ip
		}
		r.Secure = strings.EqualFold(strings.TrimSpace(hr.Header.Get("X-Forwarded-Proto")), "https")
	}
	if hr.TLS != nil || strings.HasPrefix(sv.App.PublicBase, "https://") {
		r.Secure = true
	}
	if r.Secure {
		r.Base = "https://" + r.Host
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
	r.ContentType = ct
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
				ext, ctype := sniffUpload(fn, p.Header.Get("Content-Type"), content)
				id := sv.App.Token(16) + ext
				if err := sv.App.Store().Put(id, content, ctype); err != nil {
					fmt.Fprintln(os.Stderr, "files:", err)
					return nil, errStorage
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

// forwardedFor: the address hops proxies from the end of X-Forwarded-For (each proxy adds the one it
// was reached from), or "" when the header has fewer
func forwardedFor(values []string, hops int) string {
	if hops < 1 {
		hops = 1
	}
	var all []string
	for _, v := range values {
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				all = append(all, p)
			}
		}
	}
	if len(all) < hops {
		return ""
	}
	ip := all[len(all)-hops]
	if net.ParseIP(ip) == nil {
		return ""
	}
	return ip
}

// sameOrigin: a write came from this site's own pages. A browser says where a request comes from
// (Sec-Fetch-Site, Origin); one that says neither is a program, refused only when it carries the
// session cookie (a forged form post from a browser that says nothing, or Origin: null from a
// sandboxed frame, would carry it).
func (sv *Server) sameOrigin(r *HTTPReq) bool {
	if r.FetchSite != "" && r.FetchSite != "same-origin" && r.FetchSite != "none" {
		return false
	}
	if r.Origin != "" && r.Origin != "null" {
		u, err := url.Parse(r.Origin)
		return err == nil && u.Host == r.Host
	}
	if r.FetchSite != "" {
		return true // same-origin or none, and no Origin to say otherwise
	}
	_, signedIn := r.Cookies[sv.cookie]
	return !signedIn
}

// ---- identities

// ---- the handler

func (sv *Server) ServeHTTP(w http.ResponseWriter, hr *http.Request) {
	r, err := sv.readReq(w, hr)
	if err == errStorage {
		w.WriteHeader(503)
		return
	}
	if err != nil {
		w.WriteHeader(413)
		return
	}
	// every response: no other site frames the app (clickjacking), no type is guessed from the bytes,
	// and an address with a query leaves only as the site's origin (an uploaded file sets its own, stricter policy)
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "SAMEORIGIN")
	h.Set("Content-Security-Policy", "frame-ancestors 'self'")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	if r.Secure {
		h.Set("Strict-Transport-Security", "max-age=31536000")
	}
	// counted when it's answered (metrics.go): its kind, status and time, never its address
	if sv.Metrics != nil {
		sw, t0 := &statusWriter{ResponseWriter: w, code: 200}, time.Now()
		w = sw
		defer func() { sv.Metrics.record(r.Method, r.Path, sw.code, time.Since(t0), r.pageKey != "", r.cacheHit) }()
	}
	r.Sess = sv.App.DB.Session(sv.App.Ents)
	r.Sess.Snapshot = true
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

var outcomeText = map[string]string{"forbidden": "You can’t do that.", "not_found": "Not found or inaccessible.", "invalid": "That didn’t work: check what you entered.", "blocked": "Too many requests or unauthorized.", "conflict": "Someone else changed it first: load it again.", "unauthenticated": "Please sign in."}

var avatarPath = regexp.MustCompile(`^/avatars/(\w+)/(\d+)$`)
var qrPath = regexp.MustCompile(`^/_qr/([A-Za-z0-9_-]+)$`)
var signalPath = regexp.MustCompile(`^/_signal/(\w+:[^/]*)$`)
var channelPath = regexp.MustCompile(`^/_channel/(\w+):([^/]*)/(open|close|every)$`)
var viewPath = regexp.MustCompile(`^/_view/(\w+)$`)
var doPath = regexp.MustCompile(`^/_do/(\w+)$`)

func (sv *Server) handle(w http.ResponseWriter, hr *http.Request, r *HTTPReq) {
	// a page this request had at this version: sent as it was
	if r.pageKey = pageKey(r); r.pageKey != "" {
		if e := sv.Pages.get(r.pageKey, sv.App.DB.Version.Load()); e != nil {
			if !CheckFragCache {
				h := w.Header()
				h.Set("Content-Type", "text/html; charset=utf-8")
				h.Add("Vary", "Accept-Encoding")
				if e.gz {
					h.Set("Content-Encoding", "gzip")
				}
				for _, ck := range e.cookies {
					h.Add("Set-Cookie", ck)
				}
				if len(e.cookies) == 0 && sv.cdnOK(r) {
					sv.cdnHeaders(h)
				} else if sv.CDNCache > 0 {
					h.Set("Cache-Control", "private, no-cache")
				}
				h.Set("Content-Length", strconv.Itoa(len(e.body)))
				r.cacheHit = true
				w.WriteHeader(200)
				w.Write(e.body)
				return
			}
			r.pageCheck = e // rendered afresh, and compared
		}
	}
	// PageKeys: everything the request reads from here on is what its page depends on (the
	// session lookup and the gates too, read before the page renders, so Reads is on)
	if PageKeys && r.pageKey != "" {
		r.Sess.PageReads, r.Sess.Reads = IDs{}, Deps{}
		for _, e := range sv.UI.SessionReads { // a cached lookup reads nothing: what it would read
			if e == "*" {
				r.Sess.PageReads = nil // it reads anything: not kept
				break
			}
			r.Sess.PageReads[tableKey(e).Key()] = struct{}{}
		}
		if r.Sess.PageReads == nil {
			r.Sess.Reads = nil
		}
		defer func() { r.Sess.PageReads = nil }()
	}
	who := sv.whoIs(r)
	switch {
	case strings.HasPrefix(r.Path, "/assets/"):
		sv.sendAsset(w, r, r.Path[8:])
		return
	case strings.HasPrefix(r.Path, "/files/"):
		if key := r.Path[len("/files/"):]; !sv.fileReadable(r, who, key) {
			status(w, 404, "")
		} else {
			sv.sendUpload(w, key, r.Query.Get("w"), sv.cdnOK(r))
		}
		return
	case r.Path == "/_markdown": // an editor's preview (markdown.go)
		sv.markdownPreview(w, r)
		return
	case r.Path == "/_events":
		r.Sess.EndSnapshot() // it only waits: it holds no snapshot open
		sv.events(w, hr, r, who)
		return
	case strings.HasPrefix(r.Path, "/_el/"): // a declared element's script
		for _, e := range sv.UI.ElementScripts {
			if e.Path == r.Path {
				w.Header().Set("Content-Type", "text/javascript")
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				w.WriteHeader(200)
				io.WriteString(w, e.Body)
				return
			}
		}
		w.WriteHeader(404)
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
		sv.health(w)
		return
	case r.Path == "/_metrics":
		sv.metricsPage(w, r, who)
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
		if QRDraw == nil { // the spec has no qr_link
			status(w, 404, "")
			return
		}
		io.WriteString(w, QRDraw(string(text), 6, 3))
		return
	}
	if sv.Agents != nil && sv.Agents.Handle(w, r, who, sv.sameOrigin(r)) {
		return
	}

	// channels: presence and the like
	if m := signalPath.FindStringSubmatch(r.Path); m != nil && r.Method == "POST" {
		if !sv.sameOrigin(r) {
			status(w, 403, "")
			return
		}
		sv.sendSignal(w, r, who, m[1])
		return
	}
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
		if view == nil || view.AgentsOnly {
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
	// an address naming a row there isn't (/w/999, /w/abc): not found, before the screen's requires
	for _, n := range d.RowNames {
		if params[n] == nil {
			status(w, 404, outcomeText["not_found"])
			return
		}
	}
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
			code := map[string]int{"not_found": 404, "unauthenticated": 401, "blocked": 429, "invalid": 422, "conflict": 409}[dl.Outcome]
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
		// the cookie remembering a parameter: the same for the same request, so kept with the page
		// a reference as its id, as the spec reads the cookie back (text(.id) == cookie(…))
		val := serial(params[d.RememberParam])
		if ref, ok := params[d.RememberParam].(Ref); ok {
			val = strconv.FormatInt(ref.ID, 10)
		}
		ck := d.Remember + "=" + EncodeURIComponent(val) + "; Path=/; Max-Age=31536000"
		r.pageCookies = append(r.pageCookies, ck)
		w.Header().Add("Set-Cookie", ck)
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
	if len(r.pageCookies) == 0 && !r.Sess.clockRead && !r.Sess.visitorRead && sv.cdnOK(r) {
		sv.cdnHeaders(w.Header())
	} else if sv.CDNCache > 0 { // with a CDN in front, said outright: this one is no one else's
		w.Header().Set("Cache-Control", "private, no-cache")
	}
	if r.pageKey != "" && !r.Sess.clockRead && !r.Sess.visitorRead {
		body, gz := encodeBody(r, page.Bytes(), r.segs)
		if r.pageCheck != nil {
			checkPage(r.pageCheck, body, r.Path)
		}
		sv.Pages.put(r.pageKey, r.pageV, body, gz, r.pageCookies, r.Sess.PageReads)
		writeEncoded(w, 200, body, gz)
	} else {
		writeBody(w, r, 200, page.Bytes(), r.segs)
	}
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

func (sv *Server) events(w http.ResponseWriter, hr *http.Request, r *HTTPReq, who Who) {
	// a place among the streams, or refused (streams.go)
	each := who.Session
	if each == "" {
		each = "ip:" + r.IP
	}
	if !sv.streams.open(each) {
		w.Header().Set("Retry-After", "30")
		status(w, 503, "")
		return
	}
	defer sv.streams.close(each)
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
	// and the signals its page shows (signal.go), as they're sent
	var heard <-chan string
	if keys := hr.URL.Query().Get("signals"); keys != "" {
		ch, stop := sv.listen(strings.Split(keys, " "), who, r)
		defer stop()
		heard = ch
	}
	t := time.NewTicker(200 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-hr.Context().Done():
			return
		case <-t.C:
			send()
		case m := <-heard:
			fmt.Fprintf(w, "event: signal\ndata: %s\n\n", m)
			if fl != nil {
				fl.Flush()
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
// width: a ?w= asking for a thumbnail (thumbs.go), or empty for the file itself.
func (sv *Server) sendUpload(w http.ResponseWriter, key, width string, shared ...bool) {
	fs := sv.App.Store()
	if tw := thumbWidth(width); tw > 0 {
		tk, err := thumbnail(fs, key, tw)
		if err == nil {
			key = tk
		} else if !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stderr, "files: thumbnail of", key+":", err)
		}
	}
	data, err := fs.Get(key)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stderr, "files:", err)
			status(w, 503, "")
			return
		}
		status(w, 404, "")
		return
	}
	inline, ok := inlineUploads[strings.ToLower(filepath.Ext(key))]
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
	if len(shared) > 0 && shared[0] {
		sv.cdnHeaders(h) // a signed-out reader's: any signed-out reader may have it
	} else {
		h.Set("Cache-Control", "private, max-age=300")
	}
	h.Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(200)
	w.Write(data)
}

// sniffUpload: the extension a stored upload gets and the type it is known by, from its bytes where
// they say: a PNG named cat.gif is a .png, and a script named cat.png (or sent as image/png) isn't an
// image at all, so it is neither shown inline nor counted as file.kind "image".
var imageExts = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp"}

func sniffUpload(name, claimed string, content []byte) (ext, ctype string) {
	ext = strings.ToLower(filepath.Ext(name))
	sniffed := http.DetectContentType(content)
	if e, ok := imageExts[sniffed]; ok {
		return e, sniffed
	}
	media := func(t string) bool {
		return strings.HasPrefix(t, "image/") || strings.HasPrefix(t, "video/") || strings.HasPrefix(t, "audio/")
	}
	if _, inline := inlineUploads[ext]; inline || media(claimed) {
		// named or sent as media its bytes don't bear out: kept, as something to download
		if !media(sniffed) {
			return ".bin", "application/octet-stream"
		}
		return ext, sniffed
	}
	if claimed == "" {
		claimed = "application/octet-stream"
	}
	return ext, claimed
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
			sv.sendUpload(w, s, r.Query.Get("w"))
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
	// the background: the theme's avatar colors, one picked by the id (CRC-32 of its text, as
	// Campfire picks), else a hue from the id
	fill := fmt.Sprintf("hsl(%d 55%% 55%%)", (id*47)%360)
	if e := sv.UI.Theme["avatar_colors"]; e != nil {
		if l, ok := sv.evalPlain(e).(List); ok && len(l) > 0 {
			fill = Plain(l[crc32.ChecksumIEEE([]byte(strconv.FormatInt(id, 10)))%uint32(len(l))])
		}
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.WriteHeader(200)
	fmt.Fprintf(w, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="100%%" height="100%%" rx="50" fill="%s"/><text x="50%%" y="50%%" fill="#FFFFFF" text-anchor="middle" dy="0.35em" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="230" font-weight="800" letter-spacing="-5">%s</text></svg>`, Esc(fill), Esc(initials))
}

func firstUnits(s string, n int) string { return truncate(s, n) }

func hmacEqual(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// ---- serving

func (sv *Server) Listen(port int) error {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	fmt.Printf("crudspec app: %s on http://%s (data %s)\n", sv.App.Name, addr, sv.DataDir)
	// a body that trickles in (or a connection held open idle) ends instead of holding a goroutine
	srv := &http.Server{Addr: addr, Handler: sv, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 5 * time.Minute, IdleTimeout: 2 * time.Minute}
	return srv.ListenAndServe()
}

// ---- a CDN in front (--cdn-cache N)
//
// A page or file sent to a request with no cookies at all is what any signed-out reader gets for
// that address: a CDN may keep it N seconds, and serve it a while longer while it fetches a newer
// one. A request with a cookie (signed in, a flash message, a remembered choice) gets the page
// for itself, and so does one whose page set a cookie or read the clock. The CDN must pass a
// request that has a cookie through to the app, not answer it from what it keeps.

// cdnOK: whether what this request gets may be kept for every signed-out reader
func (sv *Server) cdnOK(r *HTTPReq) bool {
	return sv.CDNCache > 0 && r.Method == "GET" && len(r.Cookies) == 0 && r.Live == ""
}

func (sv *Server) cdnHeaders(h http.Header) {
	n := strconv.Itoa(sv.CDNCache)
	h.Set("Cache-Control", "public, max-age=0, s-maxage="+n+", stale-while-revalidate="+n)
}

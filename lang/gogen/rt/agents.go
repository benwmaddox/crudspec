package rt

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The agent interface: the spec's actions and views over JSON (/_agent/…) and MCP (/_mcp), for
// tokens a person issues at /_agents, described by lang/describe.ts and introduced at /llms.txt.
// Calls run with the same rules as the UI; dry runs are rolled back; deletes need a dry run's
// confirmation; every call is audited; private fields never leave the server.

type Callable struct {
	Name        string          `json:"name"`
	Kind        string          `json:"kind"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Effects     struct {
		Deletes []string `json:"deletes"`
		Externs []string `json:"externs"`
	} `json:"effects"`
	Annotations json.RawMessage `json:"annotations"`
	Confirm     bool            `json:"confirm"`
	raw         json.RawMessage
}
type Descriptor struct {
	App       string            `json:"app"`
	About     string            `json:"about"`
	Overview  string            `json:"overview"`
	Actor     string            `json:"actor"`
	Callables []json.RawMessage `json:"callables"`
}

type Agents struct {
	sv       *Server
	ident    *Identity
	app      string
	about    string
	overview string // the spec's, from lang/describe.ts: records, rules, how calls work
	list     []*Callable
	byName   map[string]*Callable
	db       *Conn
	issueRe  *regexp.Regexp
}

var mcpVersions = []string{"2025-06-18", "2025-03-26"}
var kindStatus = map[string]int{"ok": 200, "invalid": 422, "forbidden": 403, "not_found": 404, "unauthenticated": 401, "blocked": 429, "confirm_required": 409, "stale": 409, "unknown": 404}

func sha(t string) string { h := sha256.Sum256([]byte(t)); return hex.EncodeToString(h[:]) }

func NewAgents(sv *Server) *Agents {
	a := &Agents{sv: sv, byName: map[string]*Callable{}}
	for _, id := range sv.UI.Identities {
		if id.Source == "token" {
			a.ident = id
			break
		}
	}
	if a.ident == nil || sv.UI.Descriptor == "" {
		return a
	}
	var d Descriptor
	if err := json.Unmarshal([]byte(sv.UI.Descriptor), &d); err != nil {
		panic(err)
	}
	a.app, a.about, a.overview = d.App, d.About, d.Overview
	for _, raw := range d.Callables {
		c := &Callable{raw: raw}
		json.Unmarshal(raw, c)
		a.list = append(a.list, c)
		a.byName[c.Name] = c
	}
	a.db = sv.App.DB.W
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS crudspec_agent_tokens (id INTEGER PRIMARY KEY, hash TEXT UNIQUE NOT NULL, actor_entity TEXT NOT NULL, actor_id INTEGER NOT NULL, label TEXT NOT NULL, scope TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER)`,
		`CREATE TABLE IF NOT EXISTS crudspec_audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, token_id INTEGER, actor_id INTEGER, callable TEXT NOT NULL, args TEXT NOT NULL, dry_run INTEGER NOT NULL, outcome TEXT NOT NULL, changes TEXT)`,
		`CREATE TABLE IF NOT EXISTS crudspec_idempotency (token_id INTEGER NOT NULL, key TEXT NOT NULL, reply TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (token_id, key))`,
	} {
		sv.App.DB.mu.Lock()
		err := a.db.Exec(q)
		sv.App.DB.mu.Unlock()
		if err != nil {
			panic(err)
		}
	}
	return a
}

// the agent tables are written through the writer connection, one statement at a time
func (a *Agents) exec(s *Sess, q string, args ...any) {
	if s.writing {
		if err := a.db.Exec(q, args...); err != nil {
			panic(err)
		}
		return
	}
	a.sv.App.DB.mu.Lock()
	defer a.sv.App.DB.mu.Unlock()
	if err := a.db.Exec(q, args...); err != nil {
		panic(err)
	}
}

type caller struct {
	tokenID int64
	actor   Ref
	scope   string
}

type reply = map[string]any

func agentErr(kind, msg, hint string) reply {
	e := map[string]any{"kind": kind, "message": msg}
	if hint != "" {
		e["hint"] = hint
	}
	return reply{"outcome": kind, "error": e}
}

func (a *Agents) allowed(s *Sess, actor Ref) bool {
	e := a.sv.App.Ents[actor.E]
	if e == nil || actor.E != a.ident.Entity {
		return false
	}
	row := s.Find(e, actor.ID)
	if row == nil {
		return false
	}
	if a.ident.Where == nil {
		return true
	}
	return a.ident.Where(a.sv.plainCtx(s).OnRow(e, row))
}

func (a *Agents) issue(s *Sess, actor Ref, label, scope string) string {
	b := make([]byte, 24)
	rand.Read(b)
	token := "cs_" + base64.RawURLEncoding.EncodeToString(b)
	label = truncate(label, 80)
	if label == "" {
		label = "agent"
	}
	a.exec(s, `INSERT INTO crudspec_agent_tokens (hash, actor_entity, actor_id, label, scope, created) VALUES (?, ?, ?, ?, ?, ?)`, sha(token), actor.E, actor.ID, label, scope, time.Now().UnixMilli())
	return token
}

var bearer = regexp.MustCompile(`(?i)^Bearer\s+(\S+)$`)

func (a *Agents) caller(r *HTTPReq) (*caller, reply) {
	m := bearer.FindStringSubmatch(r.Auth)
	if m == nil {
		return nil, agentErr("unauthenticated", "no token", "send Authorization: Bearer <token>; a person issues tokens at /_agents (GET /llms.txt explains)")
	}
	var id, actorID int64
	var entity, scope string
	var revoked sql.NullInt64
	err := a.sv.App.DB.R.QueryRow(`SELECT id, actor_entity, actor_id, scope, revoked FROM crudspec_agent_tokens WHERE hash = ?`, sha(m[1])).Scan(&id, &entity, &actorID, &scope, &revoked)
	if err != nil || revoked.Valid {
		return nil, agentErr("unauthenticated", "unknown or revoked token", "ask the person to issue a new token at /_agents")
	}
	actor := Ref{E: entity, ID: actorID}
	if !a.allowed(r.Sess, actor) {
		return nil, agentErr("forbidden", "the person this token acts for no longer has agent access", "")
	}
	a.exec(r.Sess, `UPDATE crudspec_agent_tokens SET last_used = ? WHERE id = ?`, time.Now().UnixMilli(), id)
	if scope != "read" {
		scope = "full"
	}
	return &caller{tokenID: id, actor: actor, scope: scope}, nil
}

// ---- values

func isoTime(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }

func (a *Agents) serialize(s *Sess, v Val) any {
	switch x := v.(type) {
	case nil:
		return nil
	case List:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = a.serialize(s, e)
		}
		return out
	case Ref:
		return map[string]any{"entity": x.E, "id": x.ID, "label": a.sv.displayOf(s, x)}
	case Set:
		return map[string]any{"entity": x.E, "ids": nonNilIDs(x.IDs)}
	case Rich:
		o := map[string]any{"text": x.Text, "mentions": nonNilIDs(x.Mentions)}
		if len(x.Embeds) > 0 {
			o["embeds"] = x.Embeds
		}
		return o
	case Time:
		return isoTime(x.T)
	case Dur:
		return map[string]any{"ms": x.MS}
	case Obj:
		if _, ok := x["stored"]; ok {
			return map[string]any{"filename": x["file"], "content_type": x["content_type"], "size": x["size"], "url": a.sv.fileURL(x)}
		}
	}
	return v
}

// store keeps an agent's upload where a form's upload goes (a dry run's is described, not written)
func (a *Agents) store(u AgentUpload, write bool) Obj {
	id := a.sv.App.Token(16) + filepath.Ext(u.Name)
	if write {
		os.WriteFile(filepath.Join(a.sv.DataDir, "files", id), u.Data, 0o644)
	}
	return Obj{"file": u.Name, "stored": id, "content_type": u.Type, "size": int64(len(u.Data))}
}

func (a *Agents) row(s *Sess, ref Ref) any {
	e := a.sv.App.Ents[ref.E]
	row := s.Find(e, ref.ID)
	if row == nil {
		return nil
	}
	return e.AgentRow(a, s, ref, row)
}

// AgentBase is the part of an agent row every entity has.
func (a *Agents) AgentBase(s *Sess, ref Ref, row *Row) map[string]any {
	return map[string]any{"id": row.ID, "label": a.sv.displayOf(s, ref), "created": isoTime(row.Created), "updated": isoTime(row.Updated)}
}
func (a *Agents) Serialize(s *Sess, v Val) any { return a.serialize(s, v) }



// ---- calls

func (a *Agents) confirmFor(cl *caller, name string, args map[string]Val) string {
	v := a.sv.App.DB.Version.Load()
	body := JSString([]any{cl.tokenID, name, args, v})
	m := hmac.New(sha256.New, a.sv.App.Secret)
	m.Write([]byte(body))
	return strconv.FormatInt(v, 10) + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))[:32]
}

func changesOf(log []Change) map[string]any {
	type t struct {
		created []int64
		updated map[int64][]string
		deleted []int64
	}
	order := []string{}
	out := map[string]*t{}
	of := func(e string) *t {
		if x, ok := out[e]; ok {
			return x
		}
		order = append(order, e)
		out[e] = &t{updated: map[int64][]string{}}
		return out[e]
	}
	for _, c := range log {
		x := of(c.E)
		switch c.Op {
		case "create":
			x.created = append(x.created, c.ID)
		case "delete":
			x.deleted = append(x.deleted, c.ID)
			kept := []int64{}
			for _, id := range x.created {
				if id != c.ID {
					kept = append(kept, id)
				}
			}
			x.created = kept
			delete(x.updated, c.ID)
		default:
			if !containsID(x.created, c.ID) {
				fs := x.updated[c.ID]
				for _, f := range c.Fields {
					if !contains(fs, f) {
						fs = append(fs, f)
					}
				}
				x.updated[c.ID] = fs
			}
		}
	}
	res := map[string]any{}
	for _, e := range order {
		x := out[e]
		if len(x.created) == 0 && len(x.deleted) == 0 && len(x.updated) == 0 {
			continue
		}
		up := map[string]any{}
		for id, fs := range x.updated {
			up[strconv.FormatInt(id, 10)] = fs
		}
		res[e] = map[string]any{"created": nonNilIDs(x.created), "updated": up, "deleted": nonNilIDs(x.deleted)}
	}
	return res
}

func (a *Agents) call(r *HTTPReq, cl *caller, name string, body map[string]any) reply {
	app := a.sv.App
	s := r.Sess
	c := a.byName[name]
	if c == nil {
		return agentErr("unknown", "no action or view named "+name, "GET /_agent/describe lists them")
	}
	if c.Kind == "action" && cl.scope == "read" {
		return agentErr("forbidden", "this token is read-only", "ask for a token with full access")
	}
	args, bad := a.sv.UI.AgentArgs[c.Name](body["args"])
	if bad != nil {
		return bad
	}
	dry := body["dry_run"] == true
	method := "write"
	if c.Kind == "view" {
		method = "get"
	}
	req := &Request{IP: r.IP, Method: method, Identity: a.ident.Name, UserAgent: fmt.Sprintf("agent token %d", cl.tokenID), Base: r.Base, Now: r.Now}
	if c.Kind == "view" {
		out := app.Run(s, name, args, cl.actor, req, nil)
		if out.Outcome != "ok" {
			return agentErr(out.Outcome, orStr(out.Detail, out.Outcome), out.Hint)
		}
		if app.Views[name].Rows != nil {
			rows := []any{}
			for _, ref := range out.Rows {
				if x := a.row(s, ref); x != nil {
					rows = append(rows, x)
				}
			}
			return reply{"outcome": "ok", "rows": rows}
		}
		return reply{"outcome": "ok", "value": a.serialize(s, out.Result)}
	}
	// a delete without its confirmation runs as a dry run: a refusal comes back as it would, and
	// otherwise the changes it would make, with the confirm value that applies them
	ask := false
	if c.Confirm && !dry {
		given, _ := body["confirm"].(string)
		if given == "" {
			ask, dry = true, true
		} else if given != a.confirmFor(cl, name, args) {
			return agentErr("stale", "the data changed since the confirm value was given, or the arguments differ", "call again without confirm for a fresh one")
		}
	}
	// an outer transaction around the action's own, so a dry run can roll everything back
	confirm := ""
	if dry && c.Confirm {
		confirm = a.confirmFor(cl, name, args)
	}
	// files sent inline, stored as a form's uploads are once it's known the call will keep them (after the confirm value, which they'd change)
	for k, v := range args {
		if u, ok := v.(AgentUpload); ok {
			args[k] = a.store(u, !dry)
		}
	}
	s.Begin()
	mark := len(s.Log)
	out := app.Run(s, name, args, cl.actor, req, nil)
	changes := map[string]any{}
	if out.Outcome == "ok" {
		changes = changesOf(s.Log[mark:])
	}
	if dry {
		s.Rollback()
	} else {
		s.Commit()
	}
	s.Log = s.Log[:mark]
	if dry {
		rep := reply{"outcome": out.Outcome, "dry_run": true, "checked_by": "server", "changes": changes}
		if ask && out.Outcome != "ok" {
			return agentErr(out.Outcome, orStr(out.Detail, out.Outcome), out.Hint)
		}
		if ask {
			return reply{"outcome": "confirm_required", "changes": changes, "confirm": confirm, "error": agentErr("confirm_required", fmt.Sprintf("%s deletes rows (%s); nothing was changed", name, strings.Join(c.Effects.Deletes, ", ")), "check the changes, then call again with confirm set to the confirm value")["error"]}
		}
		if out.Outcome == "ok" {
			evs := []string{}
			for _, e := range out.Events {
				evs = append(evs, e.Name)
			}
			ex := c.Effects.Externs
			if ex == nil {
				ex = []string{}
			}
			rep["then"] = map[string]any{"events": evs, "externs": ex}
			if c.Confirm {
				rep["confirm"] = confirm
			}
		} else {
			rep["error"] = agentErr(out.Outcome, orStr(out.Detail, out.Outcome), out.Hint)["error"]
		}
		return rep
	}
	if out.Outcome != "ok" {
		return agentErr(out.Outcome, orStr(out.Detail, out.Outcome), out.Hint)
	}
	a.sv.afterCommit(out.Events, &Request{IP: r.IP, Method: "write", Base: r.Base})
	rep := reply{"outcome": "ok", "changes": changes}
	if out.Result != nil {
		rep["result"] = a.serialize(s, out.Result)
	}
	return rep
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (a *Agents) audit(r *HTTPReq, cl *caller, name string, body map[string]any, rep reply) {
	args := map[string]any{}
	if g, ok := body["args"].(map[string]any); ok {
		for k, v := range g {
			args[k] = v
			// a file sent inline is audited by name and size, not its contents
			if f, ok := v.(map[string]any); ok {
				if data, ok := f["data"].(string); ok {
					args[k] = map[string]any{"filename": f["filename"], "base64_chars": len(data)}
				}
			}
		}
	}
	for _, p := range a.sv.UI.AgentRedact[name] {
		if _, ok := args[p]; ok {
			args[p] = "[redacted]"
		}
	}
	var changes any
	if ch, ok := rep["changes"]; ok {
		changes = truncate(JSString(ch), 4000)
	}
	dry := 0
	if body["dry_run"] == true {
		dry = 1
	}
	a.exec(r.Sess, `INSERT INTO crudspec_audit (at, token_id, actor_id, callable, args, dry_run, outcome, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		time.Now().UnixMilli(), cl.tokenID, cl.actor.ID, name, truncate(JSString(args), 4000), dry, rep["outcome"], changes)
}

func (a *Agents) invoke(r *HTTPReq, cl *caller, name string, body map[string]any) reply {
	key, _ := body["idempotency_key"].(string)
	key = truncate(key, 200)
	argsJSON := "{}"
	if g, ok := body["args"]; ok && g != nil {
		argsJSON = JSString(g)
	}
	callHash := sha("[" + JSString(name) + "," + argsJSON + "]")
	dry := body["dry_run"] == true
	if key != "" && !dry {
		var saved string
		if a.sv.App.DB.R.QueryRow(`SELECT reply FROM crudspec_idempotency WHERE token_id = ? AND key = ? AND at > ?`, cl.tokenID, key, time.Now().UnixMilli()-86_400_000).Scan(&saved) == nil {
			var j struct {
				Call  string         `json:"call"`
				Reply map[string]any `json:"reply"`
			}
			json.Unmarshal([]byte(saved), &j)
			if j.Call != callHash {
				rep := agentErr("invalid", "this idempotency key was used for a different call", "use a new key for each distinct call")
				a.audit(r, cl, name, body, rep)
				return rep
			}
			j.Reply["replayed"] = true
			return j.Reply
		}
	}
	rep := a.call(r, cl, name, body)
	a.audit(r, cl, name, body, rep)
	if key != "" && !dry && rep["outcome"] == "ok" {
		a.exec(r.Sess, `INSERT OR REPLACE INTO crudspec_idempotency (token_id, key, reply, at) VALUES (?, ?, ?, ?)`, cl.tokenID, key, JSString(map[string]any{"call": callHash, "reply": rep}), time.Now().UnixMilli())
	}
	return rep
}

// ---- MCP

func (a *Agents) tools(cl *caller) []any {
	out := []any{}
	for _, c := range a.list {
		if !(c.Kind == "view" || cl.scope == "full") {
			continue
		}
		var schema map[string]any
		d := json.NewDecoder(bytes.NewReader(c.InputSchema))
		d.UseNumber()
		d.Decode(&schema)
		props, _ := schema["properties"].(map[string]any)
		if props == nil {
			props = map[string]any{}
		}
		schema["properties"] = props
		if c.Kind == "action" {
			props["dry_run"] = map[string]any{"type": "boolean", "description": "preview: run, report the changes, roll back"}
			if c.Confirm {
				props["confirm"] = map[string]any{"type": "string", "description": "the confirm value a call without it (or a dry run) returned; required to apply, because this deletes rows"}
			}
			props["idempotency_key"] = map[string]any{"type": "string", "description": "repeat a call safely: the same key returns the first result"}
		}
		desc := c.Description
		if c.Confirm {
			desc += " It deletes rows: called without confirm it changes nothing and returns the changes it would make, with a confirm value; call again with that value to apply them."
		}
		out = append(out, map[string]any{"name": c.Name, "description": desc, "inputSchema": schema, "annotations": c.Annotations})
	}
	return out
}

func (a *Agents) mcp(r *HTTPReq, cl *caller, msg map[string]any) any {
	id, hasID := msg["id"]
	ok := func(result any) any { return map[string]any{"jsonrpc": "2.0", "id": id, "result": result} }
	params, _ := msg["params"].(map[string]any)
	switch msg["method"] {
	case "initialize":
		v := mcpVersions[0]
		if pv, _ := params["protocolVersion"].(string); contains(mcpVersions, pv) {
			v = pv
		}
		return ok(map[string]any{"protocolVersion": v, "capabilities": map[string]any{"tools": map[string]any{"listChanged": false}}, "serverInfo": map[string]any{"name": a.app, "version": "crudspec"}, "instructions": a.instructions(r, cl)})
	case "ping":
		return ok(map[string]any{})
	case "tools/list":
		return ok(map[string]any{"tools": a.tools(cl)})
	case "tools/call":
		name := fmt.Sprint(params["name"])
		in, _ := params["arguments"].(map[string]any)
		args := map[string]any{}
		body := map[string]any{}
		for k, v := range in {
			switch k {
			case "dry_run", "confirm", "idempotency_key":
				body[k] = v
			default:
				args[k] = v
			}
		}
		body["args"] = args
		rep := a.invoke(r, cl, name, body)
		return ok(map[string]any{"content": []any{map[string]any{"type": "text", "text": JSString(rep)}}, "structuredContent": rep, "isError": rep["outcome"] != "ok"})
	}
	if !hasID {
		return nil
	}
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": fmt.Sprintf("unknown method %v", msg["method"])}}
}

// ---- HTTP

func agentJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	io.WriteString(w, JSString(v))
}

func statusOf(rep reply) int {
	if c, ok := kindStatus[fmt.Sprint(rep["outcome"])]; ok {
		return c
	}
	return 400
}

var agentCall = regexp.MustCompile(`^/_agent/call/(\w+)$`)
var agentRevoke = regexp.MustCompile(`^/_agents/revoke/(\d+)$`)

// Enabled says the app has an agent interface (a token identity).
func (a *Agents) Enabled() bool { return a != nil && a.ident != nil && a.list != nil }

// instructions: the overview, for the person this caller acts as
func (a *Agents) instructions(r *HTTPReq, cl *caller) string {
	access := "full access: views and actions"
	if cl.scope == "read" {
		access = "read-only access: views only"
	}
	return a.overview + "\n\nThis token acts as " + a.sv.displayOf(r.Sess, cl.actor) + ", with " + access + "."
}

// /llms.txt: how an agent gets in; public, read before any token
func (a *Agents) llms(w http.ResponseWriter, r *HTTPReq) {
	about := ""
	if a.about != "" {
		about = "\n> " + a.about + "\n"
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	io.WriteString(w, "# "+a.app+"\n"+about+`
This app has an interface for AI agents: the same actions and views as its screens, under the same rules, over MCP or JSON.

## Getting access

A person with an account signs in, opens `+r.Base+`/_agents and issues a token (full access, or read-only). The token is shown once. Send it as `+"`Authorization: Bearer <token>`"+`: the agent acts as that person, who can revoke it there and see what it did.

## Endpoints

- MCP (streamable HTTP, JSON replies): `+"`POST "+r.Base+"/_mcp`"+`. initialize returns instructions: the app's records, its rules and how calls work.
- JSON: `+"`GET "+r.Base+"/_agent/describe`"+` lists the callables with their parameters, effects and refusals; `+"`POST "+r.Base+"/_agent/call/<name>`"+` takes `+"`{\"args\": {…}, \"dry_run\": true|false, \"confirm\": \"…\", \"idempotency_key\": \"…\"}`"+`.

## Conventions

- dry_run: true runs an action, reports what it would change, and keeps nothing.
- An action that deletes rows needs confirm. Called without it, it changes nothing and replies confirm_required with the changes and a confirm value; call again with that value to apply.
- idempotency_key makes a retry safe: the same key returns the first call's result.
- Every reply has an outcome: ok, invalid, forbidden, not_found, unauthenticated, blocked, confirm_required or stale. A refusal carries a message, and often a hint naming the rule.
`)
}

func (a *Agents) Handle(w http.ResponseWriter, r *HTTPReq, who Who, sameOrigin bool) bool {
	if !strings.HasPrefix(r.Path, "/_agent") && r.Path != "/_mcp" && r.Path != "/llms.txt" {
		return false
	}
	if !a.Enabled() {
		status(w, 404, "")
		return true
	}
	if r.Path == "/llms.txt" {
		a.llms(w, r)
		return true
	}
	if r.Path == "/_agents" || strings.HasPrefix(r.Path, "/_agents/") {
		a.page(w, r, who, sameOrigin)
		return true
	}
	cl, bad := a.caller(r)
	if bad != nil {
		if bad["outcome"] == "unauthenticated" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="agents"`)
		}
		agentJSON(w, statusOf(bad), bad)
		return true
	}
	var body any = map[string]any{}
	if r.Method == "POST" && r.Text != "" {
		d := json.NewDecoder(strings.NewReader(r.Text))
		d.UseNumber()
		if d.Decode(&body) != nil {
			agentJSON(w, 400, agentErr("invalid", "the body isn't JSON", "send application/json"))
			return true
		}
	}
	if r.Path == "/_mcp" {
		if r.Method != "POST" {
			w.Header().Set("Allow", "POST")
			w.WriteHeader(405)
			return true
		}
		msgs, isList := body.([]any)
		if !isList {
			msgs = []any{body}
		}
		out := []any{}
		for _, m := range msgs {
			mm, _ := m.(map[string]any)
			if x := a.mcp(r, cl, mm); x != nil {
				out = append(out, x)
			}
		}
		if len(out) == 0 {
			w.WriteHeader(202)
			return true
		}
		if isList {
			agentJSON(w, 200, out)
		} else {
			agentJSON(w, 200, out[0])
		}
		return true
	}
	if r.Path == "/_agent/describe" {
		visible := []json.RawMessage{}
		for _, c := range a.list {
			if c.Kind == "view" || cl.scope == "full" {
				visible = append(visible, c.raw)
			}
		}
		agentJSON(w, 200, map[string]any{"app": a.app, "actor": a.sv.displayOf(r.Sess, cl.actor), "scope": cl.scope, "overview": a.instructions(r, cl), "callables": visible})
		return true
	}
	if m := agentCall.FindStringSubmatch(r.Path); m != nil && r.Method == "POST" {
		b, _ := body.(map[string]any)
		if b == nil {
			b = map[string]any{}
		}
		rep := a.invoke(r, cl, m[1], b)
		agentJSON(w, statusOf(rep), rep)
		return true
	}
	agentJSON(w, 404, agentErr("unknown", "no such endpoint", "GET /_agent/describe; POST /_agent/call/<name>; POST /_mcp"))
	return true
}

// /_agents: a person's tokens and their agents' recent calls
func (a *Agents) page(w http.ResponseWriter, r *HTTPReq, who Who, sameOrigin bool) {
	actor, ok := who.Actor.(Ref)
	if !ok || a.sv.session == nil || who.Identity != a.sv.session.Name {
		w.Header().Set("Location", "/")
		w.WriteHeader(303)
		return
	}
	issued := ""
	if r.Method == "POST" {
		if !sameOrigin {
			status(w, 403, "")
			return
		}
		if r.Path == "/_agents/issue" {
			if !a.allowed(r.Sess, actor) {
				status(w, 403, "agent access isn't available to you")
				return
			}
			label, _ := r.body("label")
			scope, _ := r.body("scope")
			if scope != "read" {
				scope = "full"
			}
			issued = a.issue(r.Sess, actor, label, scope)
		}
		if m := agentRevoke.FindStringSubmatch(r.Path); m != nil {
			id, _ := strconv.ParseInt(m[1], 10, 64)
			a.exec(r.Sess, `UPDATE crudspec_agent_tokens SET revoked = ? WHERE id = ? AND actor_entity = ? AND actor_id = ?`, time.Now().UnixMilli(), id, actor.E, actor.ID)
		}
		if issued == "" {
			w.Header().Set("Location", "/_agents")
			w.WriteHeader(303)
			return
		}
	}
	when := func(t sql.NullInt64) string {
		if !t.Valid || t.Int64 == 0 {
			return "never"
		}
		return strings.Replace(isoTime(t.Int64), "T", " ", 1)[:16]
	}
	var tokens, calls strings.Builder
	rows, err := a.sv.App.DB.R.Query(`SELECT id, label, scope, created, last_used, revoked FROM crudspec_agent_tokens WHERE actor_entity = ? AND actor_id = ? ORDER BY id DESC`, actor.E, actor.ID)
	if err == nil {
		for rows.Next() {
			var id int64
			var label, scope string
			var created, last, revoked sql.NullInt64
			rows.Scan(&id, &label, &scope, &created, &last, &revoked)
			access := "full"
			if scope == "read" {
				access = "read only"
			}
			act := fmt.Sprintf(`<form method="post" action="/_agents/revoke/%d"><button>Revoke</button></form>`, id)
			if revoked.Valid {
				act = "revoked"
			}
			fmt.Fprintf(&tokens, `<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>`, Esc(label), access, when(created), when(last), act)
		}
		rows.Close()
	}
	if tokens.Len() == 0 {
		tokens.WriteString(`<tr><td colspan="5">None yet</td></tr>`)
	}
	rows, err = a.sv.App.DB.R.Query(`SELECT a.at, a.callable, a.dry_run, a.outcome, t.label FROM crudspec_audit a JOIN crudspec_agent_tokens t ON t.id = a.token_id WHERE t.actor_entity = ? AND t.actor_id = ? ORDER BY a.id DESC LIMIT 50`, actor.E, actor.ID)
	if err == nil {
		for rows.Next() {
			var at sql.NullInt64
			var callable, outcome, label string
			var dry int
			rows.Scan(&at, &callable, &dry, &outcome, &label)
			d := ""
			if dry != 0 {
				d = " (dry run)"
			}
			fmt.Fprintf(&calls, `<tr><td>%s</td><td>%s</td><td>%s%s</td><td>%s</td></tr>`, when(at), Esc(label), Esc(callable), d, Esc(outcome))
		}
		rows.Close()
	}
	if calls.Len() == 0 {
		calls.WriteString(`<tr><td colspan="4">None yet</td></tr>`)
	}
	news := ""
	if issued != "" {
		news = `<p><strong>New token</strong> (shown once; copy it now):<br><code>` + Esc(issued) + `</code></p><p>MCP: <code>POST /_mcp</code>; JSON: <code>GET /_agent/describe</code>, <code>POST /_agent/call/&lt;name&gt;</code>; header <code>Authorization: Bearer &lt;token&gt;</code>.</p>`
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	io.WriteString(w, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent access</title>
<style>body{font:15px system-ui;max-width:52em;margin:2em auto;padding:0 1em}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.3em .5em;border-bottom:1px solid #ddd}code{background:#f3f3f3;padding:.2em .4em;word-break:break-all}</style>
<h1>Agent access</h1><p>An agent with a token acts as you, `+Esc(a.sv.displayOf(r.Sess, actor))+`, with your permissions and no more. Every call is recorded below.</p>
`+news+`
<form method="post" action="/_agents/issue"><input name="label" placeholder="What is it for?" required> <select name="scope"><option value="full">Full access</option><option value="read">Read only</option></select> <button>Issue a token</button></form>
<h2>Tokens</h2><table><tr><th>Label</th><th>Access</th><th>Issued</th><th>Last used</th><th></th></tr>
`+tokens.String()+`</table>
<h2>Recent agent calls</h2><table><tr><th>When</th><th>Token</th><th>Call</th><th>Outcome</th></tr>
`+calls.String()+`</table>`)
}

var _ = sort.Strings

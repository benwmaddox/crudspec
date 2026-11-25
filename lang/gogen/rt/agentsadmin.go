package rt

import (
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// /_agents/all: every token on the site and every agent call, for administrators (the app's
// admin condition), who may revoke any token. A person's own tokens are at /_agents.

var agentRevokeAny = regexp.MustCompile(`^/_agents/all/revoke/(\d+)$`)

// isAdmin: whether the person signed in is an administrator, by the app's admin condition
func (a *Agents) isAdmin(r *HTTPReq, who Who) (Ref, bool) {
	actor, ok := who.Actor.(Ref)
	if !ok || a.sv.UI.Admin == nil || a.sv.session == nil || who.Identity != a.sv.session.Name {
		return Ref{}, false
	}
	r.Sess.Inbound(actor)
	c := a.sv.plainCtx(r.Sess)
	c.Actor = actor
	return actor, Truthy(a.sv.UI.Admin(c))
}

func (a *Agents) adminPage(w http.ResponseWriter, r *HTTPReq, who Who, sameOrigin bool) {
	if _, ok := a.isAdmin(r, who); !ok {
		status(w, 404, "")
		return
	}
	if r.Method == "POST" {
		if !sameOrigin {
			status(w, 403, "")
			return
		}
		if m := agentRevokeAny.FindStringSubmatch(r.Path); m != nil {
			id, _ := strconv.ParseInt(m[1], 10, 64)
			a.exec(r.Sess, `UPDATE crudspec_agent_tokens SET revoked = ? WHERE id = ? AND revoked IS NULL`, time.Now().UnixMilli(), id)
		}
		w.Header().Set("Location", "/_agents/all")
		w.WriteHeader(303)
		return
	}
	when := func(t sql.NullInt64) string {
		if !t.Valid || t.Int64 == 0 {
			return "never"
		}
		return strings.Replace(isoTime(t.Int64), "T", " ", 1)[:16]
	}
	who2 := func(entity string, id int64) string {
		if entity == "" {
			return "?"
		}
		return a.sv.displayOf(r.Sess, Ref{E: entity, ID: id})
	}
	var tokens, calls strings.Builder
	rows, err := a.sv.App.DB.A.Query(`SELECT id, actor_entity, actor_id, label, scope, created, last_used, revoked FROM crudspec_agent_tokens ORDER BY revoked IS NOT NULL, last_used DESC, id DESC LIMIT 500`)
	if err == nil {
		type tok struct {
			id, actorID            int64
			entity, label, scope   string
			created, last, revoked sql.NullInt64
		}
		list := []tok{}
		for rows.Next() {
			var t tok
			rows.Scan(&t.id, &t.entity, &t.actorID, &t.label, &t.scope, &t.created, &t.last, &t.revoked)
			list = append(list, t)
		}
		rows.Close()
		for _, t := range list {
			access := "full"
			if t.scope == "read" {
				access = "read only"
			}
			act := fmt.Sprintf(`<form method="post" action="/_agents/all/revoke/%d"><button>Revoke</button></form>`, t.id)
			if t.revoked.Valid {
				act = "revoked"
			}
			fmt.Fprintf(&tokens, `<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>`, Esc(who2(t.entity, t.actorID)), Esc(t.label), access, when(t.created), when(t.last), act)
		}
	}
	if tokens.Len() == 0 {
		tokens.WriteString(`<tr><td colspan="6">None yet</td></tr>`)
	}
	rows, err = a.sv.App.DB.A.Query(`SELECT a.at, t.actor_entity, t.actor_id, t.label, a.callable, a.dry_run, a.outcome FROM crudspec_audit a JOIN crudspec_agent_tokens t ON t.id = a.token_id ORDER BY a.id DESC LIMIT 200`)
	if err == nil {
		type call struct {
			at                                sql.NullInt64
			entity, label, callable, outcome  string
			actorID                           int64
			dry                               int
		}
		list := []call{}
		for rows.Next() {
			var c call
			rows.Scan(&c.at, &c.entity, &c.actorID, &c.label, &c.callable, &c.dry, &c.outcome)
			list = append(list, c)
		}
		rows.Close()
		for _, c := range list {
			d := ""
			if c.dry != 0 {
				d = " (dry run)"
			}
			fmt.Fprintf(&calls, `<tr><td>%s</td><td>%s</td><td>%s</td><td>%s%s</td><td>%s</td></tr>`, when(c.at), Esc(who2(c.entity, c.actorID)), Esc(c.label), Esc(c.callable), d, Esc(c.outcome))
		}
	}
	if calls.Len() == 0 {
		calls.WriteString(`<tr><td colspan="5">None yet</td></tr>`)
	}
	state := "on"
	if !a.on(r.Sess) {
		state = "switched off (the app's agents_when doesn't hold)"
	}
	anon := "no: every agent needs a token"
	if a.anonymousReads(r.Sess) {
		anon = "yes: views, as a signed-out visitor, rate limited by address"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	io.WriteString(w, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agents on this site</title>
<style>body{font:15px system-ui;max-width:64em;margin:2em auto;padding:0 1em}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.3em .5em;border-bottom:1px solid #ddd}</style>
<h1>Agents on this site</h1>
<p>The agent interface is `+Esc(state)+`. Reads without a token: `+Esc(anon)+`. Calls without a token aren't recorded.</p>
<h2>Every token</h2><table><tr><th>For</th><th>Label</th><th>Access</th><th>Issued</th><th>Last used</th><th></th></tr>
`+tokens.String()+`</table>
<h2>Recent agent calls</h2><table><tr><th>When</th><th>For</th><th>Token</th><th>Call</th><th>Outcome</th></tr>
`+calls.String()+`</table>`)
}

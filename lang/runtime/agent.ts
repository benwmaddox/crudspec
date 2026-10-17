// The agent interface: the spec's actions and views over JSON (/_agent/…) and MCP (/_mcp),
// for agents acting for a person with a token that person issued (/_agents).
// - Opt-in: the spec declares `identity agent: <Entity> from token [where …]`; the where is
//   checked on every call, so a person who loses access takes their agents with them.
// - Same rules as the UI: calls run through the interpreter with the same permissions,
//   gates and rate limits; request.identity is the agent identity's name.
// - Dry runs are checked by the server: the call runs and is rolled back, and the changes
//   it would make are returned. Actions that delete rows need the confirmation a dry run
//   gives, bound to the arguments and the data version, so the previewed change is the
//   one applied, or the call is refused as stale.
// - Every call is audited. Fields that are passwords, identity keys or marked `private`
//   never leave the server.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Interpreter, Ref, Val } from "../interp.ts";
import type { Spec, Decl } from "../parser.ts";
import { describe, type Callable, type Descriptor } from "../describe.ts";
import { textLength } from "../sizes.ts";

export type AgentDeps = {
  it: Interpreter; spec: Spec; source: string; db: DatabaseSync; secret: string;
  commit: (events: any[] | undefined, request: any) => void;   // save, notify, run workflows
  version: () => number;
  sessionActor: (r: any) => Ref | null;                         // the signed-in person, for /_agents
  label: (ref: Ref) => string; fileUrl: (v: Val) => string;
};
type Req = { method: string; path: string; query: URLSearchParams; ip: string; text: string; body: Record<string, any> };
type Caller = { tokenId: number; actor: Ref; scope: "read" | "full" };
type Reply = { outcome: string; [k: string]: any };

const MCP_VERSIONS = ["2025-06-18", "2025-03-26"];   // newest first
export const AGENT_TABLES = ["crudspec_agent_tokens", "crudspec_audit", "crudspec_idempotency"];
const KIND_STATUS: Record<string, number> = { ok: 200, invalid: 422, forbidden: 403, not_found: 404, unauthenticated: 401, blocked: 429, confirm_required: 409, stale: 409, unknown: 404, unavailable: 400 };
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export class AgentApi {
  d: AgentDeps; ident?: Decl; descriptor: Descriptor; byName: Map<string, Callable>; privateFields: Map<string, Set<string>>;

  constructor(d: AgentDeps) {
    this.d = d;
    this.ident = d.spec.decls.find((x) => x.kind === "identity" && x.source === "token");
    this.descriptor = describe(d.spec, d.source);
    this.byName = new Map(this.descriptor.callables.map((c) => [c.name, c]));
    // never serialized: passwords, the fields identities match on, fields marked private
    this.privateFields = new Map();
    const mark = (e: string, f: string) => (this.privateFields.get(e) ?? this.privateFields.set(e, new Set()).get(e)!).add(f);
    for (const x of d.spec.decls) {
      if (x.kind === "entity") for (const f of x.fields) if (f.private || (f.type.kind === "named" && f.type.name === "Password")) mark(x.name, f.name);
      if (x.kind === "identity") {
        if (x.field) mark(x.entity, x.field);
        const fmt = x.format?.value; if (typeof fmt === "string") for (const m of fmt.matchAll(/\{(\w+)\}/g)) if (m[1] !== "id") mark(x.entity, m[1]);
      }
    }
    d.db.exec(`CREATE TABLE IF NOT EXISTS crudspec_agent_tokens (id INTEGER PRIMARY KEY, hash TEXT UNIQUE NOT NULL, actor_entity TEXT NOT NULL, actor_id INTEGER NOT NULL, label TEXT NOT NULL, scope TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER)`);
    d.db.exec(`CREATE TABLE IF NOT EXISTS crudspec_audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, token_id INTEGER, actor_id INTEGER, callable TEXT NOT NULL, args TEXT NOT NULL, dry_run INTEGER NOT NULL, outcome TEXT NOT NULL, changes TEXT)`);
    d.db.exec(`CREATE TABLE IF NOT EXISTS crudspec_idempotency (token_id INTEGER NOT NULL, key TEXT NOT NULL, reply TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (token_id, key))`);
  }
  get enabled() { return !!this.ident; }

  // ---------------------------------------------------------------- tokens
  allowed(actor: Ref): boolean {
    const it = this.d.it, row = it.store.find(actor);
    if (!row || actor.ref !== this.ident!.entity) return false;
    if (!this.ident!.where) return true;
    return it.truthy(it.eval(this.ident!.where, { vars: new Map(), actor: null, request: { ip: "", method: "get", identity: "" }, events: [], effects: [], row: { entity: actor.ref, row } } as any));
  }
  issue(actor: Ref, label: string, scope: "read" | "full"): string {
    const token = `cs_${randomBytes(24).toString("base64url")}`;
    this.d.db.prepare(`INSERT INTO crudspec_agent_tokens (hash, actor_entity, actor_id, label, scope, created) VALUES (?, ?, ?, ?, ?, ?)`).run(hash(token), actor.ref, actor.id, label.slice(0, 80) || "agent", scope, Date.now());
    return token;
  }
  caller(req: IncomingMessage): Caller | Reply {
    const m = String(req.headers.authorization ?? "").match(/^Bearer\s+(\S+)$/i);
    if (!m) return this.err("unauthenticated", "no token", "send Authorization: Bearer <token>; a person issues tokens at /_agents");
    const t = this.d.db.prepare(`SELECT id, actor_entity, actor_id, scope, revoked FROM crudspec_agent_tokens WHERE hash = ?`).get(hash(m[1])) as any;
    if (!t || t.revoked) return this.err("unauthenticated", "unknown or revoked token", "ask the person to issue a new token at /_agents");
    const actor = { ref: t.actor_entity, id: Number(t.actor_id) };
    if (!this.allowed(actor)) return this.err("forbidden", "the person this token acts for no longer has agent access", "");
    this.d.db.prepare(`UPDATE crudspec_agent_tokens SET last_used = ? WHERE id = ?`).run(Date.now(), t.id);
    return { tokenId: Number(t.id), actor, scope: t.scope === "read" ? "read" : "full" };
  }
  err(kind: string, message: string, hint: string, extra: Record<string, any> = {}): Reply { return { outcome: kind, error: { kind, message, ...(hint ? { hint } : {}) }, ...extra }; }

  // ---------------------------------------------------------------- values
  serialize(v: Val, entity?: string, field?: string): any {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map((x) => this.serialize(x));
    if (typeof v !== "object") return v;
    if ("ref" in v && "id" in v) return { entity: v.ref, id: v.id, label: this.d.label(v) };
    if ("set" in v) return { entity: v.entity, ids: v.set };
    if ("rich" in v) return { text: v.rich, mentions: v.mentions ?? [], ...(v.embeds?.length ? { embeds: v.embeds } : {}) };
    if ("stored" in v) return { filename: v.filename, content_type: v.content_type, size: v.size, url: this.d.fileUrl(v) };
    if ("time" in v) return new Date(v.time).toISOString();
    if ("ms" in v) return { ms: v.ms };
    return v;
  }
  row(ref: Ref): any {
    const row = this.d.it.store.find(ref); if (!row) return null;
    const hidden = this.privateFields.get(ref.ref) ?? new Set();
    const out: any = { id: row.id, label: this.d.label(ref), created: new Date(row.created).toISOString(), updated: new Date(row.updated).toISOString() };
    for (const [k, v] of Object.entries(row.fields)) if (!hidden.has(k)) out[k] = this.serialize(v, ref.ref, k);
    return out;
  }
  // JSON arguments, checked against the callable's parameters
  args(c: Callable, given: any): Record<string, unknown> | Reply {
    if (given === undefined || given === null) given = {};
    if (typeof given !== "object" || Array.isArray(given)) return this.err("invalid", "args must be an object", `parameters: ${JSON.stringify(c.inputSchema)}`);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(given)) if (!c.params.some((p) => p.name === k)) return this.err("invalid", `unknown parameter ${k}`, `${c.name} takes ${c.params.map((p) => p.name).join(", ") || "no parameters"}`);
    for (const p of c.params) {
      let v = given[p.name];
      if (v === undefined || v === null) { if (!p.optional && p.type !== "Bool") return this.err("invalid", `${p.name} is required`, `${p.name}: ${JSON.stringify(p.schema)}`); out[p.name] = null; continue; }
      const s = p.schema, bad = () => this.err("invalid", `${p.name} must be ${s.enum ? `one of ${s.enum.join(", ")}` : s.type}`, `${p.name}: ${JSON.stringify(s)}`);
      if (s.type === "integer" && !Number.isInteger(v)) return bad();
      if (s.type === "boolean" && typeof v !== "boolean") return bad();
      if (s.type === "string" && typeof v !== "string") return bad();
      if (typeof v === "string" && (s.maxLength !== undefined && textLength(v) > s.maxLength || s.minLength !== undefined && textLength(v) < s.minLength)) return this.err("invalid", `${p.name} must be ${s.minLength !== undefined ? `at least ${s.minLength}` : ""}${s.minLength !== undefined && s.maxLength !== undefined ? " and " : ""}${s.maxLength !== undefined ? `at most ${s.maxLength}` : ""} characters`, `${p.name}: ${JSON.stringify(s)}`);
      if (s.enum && !s.enum.includes(v)) return bad();
      if (s.type === "array" && !(Array.isArray(v) && v.every(Number.isInteger))) return bad();
      if (p.type === "RichText") v = { rich: v, mentions: [], embeds: [] };
      out[p.name] = v;
    }
    return out;
  }

  // ---------------------------------------------------------------- calls
  confirmFor(caller: Caller, name: string, args: Record<string, unknown>): string {
    const body = JSON.stringify([caller.tokenId, name, args, this.d.version()]);
    return `${this.d.version()}.${createHmac("sha256", this.d.secret).update(body).digest("base64url").slice(0, 32)}`;
  }
  // the rows a call created, updated (which fields) and deleted, from the store's change log
  changes(log: { entity: string; id: number; op: string; fields?: string[] }[]) {
    const out: Record<string, { created: number[]; updated: Record<number, string[]>; deleted: number[] }> = {};
    const of = (e: string) => (out[e] ??= { created: [], updated: {}, deleted: [] });
    for (const c of log) {
      const t = of(c.entity);
      if (c.op === "create") t.created.push(c.id);
      else if (c.op === "delete") { t.deleted.push(c.id); t.created = t.created.filter((x) => x !== c.id); delete t.updated[c.id]; }
      else if (!t.created.includes(c.id)) t.updated[c.id] = [...new Set([...(t.updated[c.id] ?? []), ...(c.fields ?? [])])];
    }
    for (const [e, t] of Object.entries(out)) if (!t.created.length && !t.deleted.length && !Object.keys(t.updated).length) delete out[e];
    return out;
  }
  call(caller: Caller, name: string, body: any, ip: string): Reply {
    const it = this.d.it;
    const c = this.byName.get(name);
    if (!c) return this.err("unknown", `no action or view named ${name}`, "GET /_agent/describe lists them");
    if (c.unavailable) return this.err("unavailable", `${name} ${c.unavailable}`, "");
    if (c.kind === "action" && caller.scope === "read") return this.err("forbidden", "this token is read-only", "ask for a token with full access");
    const args = this.args(c, body?.args);
    if ("outcome" in args) return args as Reply;
    const dry = body?.dry_run === true;
    const request = { ip, method: c.kind === "view" ? "get" : "write", identity: this.ident!.name, user_agent: `agent token ${caller.tokenId}` } as any;

    if (c.kind === "view") {
      const out = it.run(name, args, caller.actor, request);
      if (out.outcome !== "ok") return this.err(out.outcome, out.detail ?? out.outcome, "");
      return out.rows ? { outcome: "ok", rows: out.rows.map((ref) => this.row(ref)).filter(Boolean) } : { outcome: "ok", value: this.serialize(out.result) };
    }
    if (c.confirm && !dry) {
      const given = String(body?.confirm ?? "");
      if (!given) return this.err("confirm_required", `${name} deletes rows (${c.effects.deletes.join(", ")})`, "call it with dry_run: true, check the changes, then call again with the confirm value the dry run returns");
      if (given !== this.confirmFor(caller, name, args)) return this.err("stale", "the data changed since the dry run, or the arguments differ", "dry-run again");
    }
    // an outer transaction around the action's own, so a dry run can roll everything back
    it.store.begin();
    const mark = it.store.log.length;
    const out = it.run(name, args, caller.actor, request);
    const changes = out.outcome === "ok" ? this.changes(it.store.log.slice(mark)) : {};
    if (dry) it.store.rollback(); else it.store.commit();
    it.store.log.length = mark;
    if (dry) {
      // rolled back; a preview still counts against rate limits, so it can't be used to guess
      return { outcome: out.outcome, dry_run: true, checked_by: "server", changes, ...(out.outcome === "ok" ? { then: { events: (out.events ?? []).map((e) => e.event), externs: c.effects.externs } } : { error: { kind: out.outcome, message: out.detail ?? out.outcome } }), ...(c.confirm && out.outcome === "ok" ? { confirm: this.confirmFor(caller, name, args) } : {}) };
    }
    if (out.outcome !== "ok") return this.err(out.outcome, out.detail ?? out.outcome, "");
    this.d.commit(out.events, request);
    return { outcome: "ok", changes, ...(out.result !== undefined && out.result !== null ? { result: this.serialize(out.result) } : {}) };
  }
  audit(caller: Caller | null, name: string, body: any, reply: Reply) {
    const c = this.byName.get(name);
    const args = { ...(body?.args ?? {}) };
    for (const p of c?.params ?? []) if (p.type === "Password" && p.name in args) args[p.name] = "[redacted]";
    this.d.db.prepare(`INSERT INTO crudspec_audit (at, token_id, actor_id, callable, args, dry_run, outcome, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(Date.now(), caller?.tokenId ?? null, caller?.actor.id ?? null, name, JSON.stringify(args).slice(0, 4000), body?.dry_run ? 1 : 0, reply.outcome, reply.changes ? JSON.stringify(reply.changes).slice(0, 4000) : null);
  }
  // one call, with idempotency keys and the audit around it
  invoke(caller: Caller, name: string, body: any, ip: string): Reply {
    const key = typeof body?.idempotency_key === "string" ? body.idempotency_key.slice(0, 200) : "";
    const callHash = hash(JSON.stringify([name, body?.args ?? {}]));
    if (key && !body?.dry_run) {
      const hit = this.d.db.prepare(`SELECT reply FROM crudspec_idempotency WHERE token_id = ? AND key = ? AND at > ?`).get(caller.tokenId, key, Date.now() - 86_400_000) as any;
      if (hit) {
        const saved = JSON.parse(hit.reply);
        if (saved.call !== callHash) { const r = this.err("invalid", "this idempotency key was used for a different call", "use a new key for each distinct call"); this.audit(caller, name, body, r); return r; }
        return { ...saved.reply, replayed: true };
      }
    }
    const reply = this.call(caller, name, body, ip);
    this.audit(caller, name, body, reply);
    if (key && !body?.dry_run && reply.outcome === "ok") this.d.db.prepare(`INSERT OR REPLACE INTO crudspec_idempotency (token_id, key, reply, at) VALUES (?, ?, ?, ?)`).run(caller.tokenId, key, JSON.stringify({ call: callHash, reply }), Date.now());
    return reply;
  }

  // ---------------------------------------------------------------- MCP
  tools(caller: Caller) {
    return this.descriptor.callables.filter((c) => !c.unavailable && (c.kind === "view" || caller.scope === "full")).map((c) => {
      const props: any = { ...c.inputSchema.properties };
      const schema: any = { ...c.inputSchema, properties: props };
      if (c.kind === "action") {
        props.dry_run = { type: "boolean", description: "preview: run, report the changes, roll back" };
        if (c.confirm) props.confirm = { type: "string", description: "the confirm value from a dry run; required to apply, because this deletes rows" };
        props.idempotency_key = { type: "string", description: "repeat a call safely: the same key returns the first result" };
      }
      return { name: c.name, description: c.description + (c.confirm ? " Deleting needs a dry run first, then its confirm value." : ""), inputSchema: schema, annotations: c.annotations };
    });
  }
  mcp(caller: Caller, msg: any, ip: string): any {
    const reply = (result: any) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    switch (msg?.method) {
      case "initialize": return reply({ protocolVersion: MCP_VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: this.descriptor.app, version: "crudspec" } });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: this.tools(caller) });
      case "tools/call": {
        const { name, arguments: a = {} } = msg.params ?? {};
        const { dry_run, confirm, idempotency_key, ...args } = a;
        const r = this.invoke(caller, String(name), { args, dry_run, confirm, idempotency_key }, ip);
        return reply({ content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r, isError: r.outcome !== "ok" });
      }
      default: return msg?.id === undefined ? null : fail(-32601, `unknown method ${msg?.method}`);
    }
  }

  // ---------------------------------------------------------------- HTTP
  json(res: ServerResponse, status: number, body: any) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
  handle(r: Req, req: IncomingMessage, res: ServerResponse, sameOrigin: boolean): boolean {
    if (!r.path.startsWith("/_agent") && r.path !== "/_mcp") return false;
    if (!this.enabled) { res.writeHead(404); res.end(); return true; }
    if (r.path === "/_agents" || r.path.startsWith("/_agents/")) { this.page(r, req, res, sameOrigin); return true; }
    const caller = this.caller(req);
    if ("outcome" in caller) { this.json(res, KIND_STATUS[caller.outcome] ?? 400, caller); return true; }
    let body: any = {};
    if (r.method === "POST") { try { body = r.text ? JSON.parse(r.text) : {}; } catch { this.json(res, 400, this.err("invalid", "the body isn't JSON", "send application/json")); return true; } }
    if (r.path === "/_mcp" && r.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return true; }
    if (r.path === "/_mcp" && r.method === "POST") {
      const msgs = Array.isArray(body) ? body : [body];
      const out = msgs.map((m) => this.mcp(caller, m, r.ip)).filter(Boolean);
      if (!out.length) { res.writeHead(202); res.end(); return true; }
      this.json(res, 200, Array.isArray(body) ? out : out[0]); return true;
    }
    if (r.path === "/_agent/describe") {
      const visible = this.descriptor.callables.filter((c) => c.kind === "view" || caller.scope === "full");
      this.json(res, 200, { app: this.descriptor.app, actor: this.label(caller.actor), scope: caller.scope, callables: visible }); return true;
    }
    const m = r.path.match(/^\/_agent\/call\/(\w+)$/);
    if (m && r.method === "POST") { const reply = this.invoke(caller, m[1], body, r.ip); this.json(res, KIND_STATUS[reply.outcome] ?? 400, reply); return true; }
    this.json(res, 404, this.err("unknown", "no such endpoint", "GET /_agent/describe; POST /_agent/call/<name>; POST /_mcp"));
    return true;
  }
  label(a: Ref) { return this.d.label(a); }

  // /_agents: a person's tokens and their agents' recent calls
  page(r: Req, req: IncomingMessage, res: ServerResponse, sameOrigin: boolean) {
    const actor = this.d.sessionActor(r);
    const esc = (v: any) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    if (!actor) { res.writeHead(303, { Location: "/" }); res.end(); return; }
    let issued = "";
    if (r.method === "POST") {
      if (!sameOrigin) { res.writeHead(403); res.end(); return; }
      if (r.path === "/_agents/issue") {
        if (!this.allowed(actor)) { res.writeHead(403); res.end("agent access isn't available to you"); return; }
        issued = this.issue(actor, String(r.body.label ?? ""), r.body.scope === "read" ? "read" : "full");
      }
      const rv = r.path.match(/^\/_agents\/revoke\/(\d+)$/);
      if (rv) this.d.db.prepare(`UPDATE crudspec_agent_tokens SET revoked = ? WHERE id = ? AND actor_entity = ? AND actor_id = ?`).run(Date.now(), Number(rv[1]), actor.ref, actor.id);
      if (!issued) { res.writeHead(303, { Location: "/_agents" }); res.end(); return; }
    }
    const tokens = this.d.db.prepare(`SELECT id, label, scope, created, last_used, revoked FROM crudspec_agent_tokens WHERE actor_entity = ? AND actor_id = ? ORDER BY id DESC`).all(actor.ref, actor.id) as any[];
    const calls = this.d.db.prepare(`SELECT a.at, a.callable, a.dry_run, a.outcome, t.label FROM crudspec_audit a JOIN crudspec_agent_tokens t ON t.id = a.token_id WHERE t.actor_entity = ? AND t.actor_id = ? ORDER BY a.id DESC LIMIT 50`).all(actor.ref, actor.id) as any[];
    const when = (t: any) => (t ? new Date(Number(t)).toISOString().replace("T", " ").slice(0, 16) : "never");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent access</title>
<style>body{font:15px system-ui;max-width:52em;margin:2em auto;padding:0 1em}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.3em .5em;border-bottom:1px solid #ddd}code{background:#f3f3f3;padding:.2em .4em;word-break:break-all}</style>
<h1>Agent access</h1><p>An agent with a token acts as you, ${esc(this.label(actor))}, with your permissions and no more. Every call is recorded below.</p>
${issued ? `<p><strong>New token</strong> (shown once; copy it now):<br><code>${esc(issued)}</code></p><p>MCP: <code>POST /_mcp</code>; JSON: <code>GET /_agent/describe</code>, <code>POST /_agent/call/&lt;name&gt;</code>; header <code>Authorization: Bearer &lt;token&gt;</code>.</p>` : ""}
<form method="post" action="/_agents/issue"><input name="label" placeholder="What is it for?" required> <select name="scope"><option value="full">Full access</option><option value="read">Read only</option></select> <button>Issue a token</button></form>
<h2>Tokens</h2><table><tr><th>Label</th><th>Access</th><th>Issued</th><th>Last used</th><th></th></tr>
${tokens.map((t) => `<tr><td>${esc(t.label)}</td><td>${t.scope === "read" ? "read only" : "full"}</td><td>${when(t.created)}</td><td>${when(t.last_used)}</td><td>${t.revoked ? "revoked" : `<form method="post" action="/_agents/revoke/${t.id}"><button>Revoke</button></form>`}</td></tr>`).join("") || `<tr><td colspan="5">None yet</td></tr>`}</table>
<h2>Recent agent calls</h2><table><tr><th>When</th><th>Token</th><th>Call</th><th>Outcome</th></tr>
${calls.map((c) => `<tr><td>${when(c.at)}</td><td>${esc(c.label)}</td><td>${esc(c.callable)}${c.dry_run ? " (dry run)" : ""}</td><td>${esc(c.outcome)}</td></tr>`).join("") || `<tr><td colspan="4">None yet</td></tr>`}</table>`);
  }
}

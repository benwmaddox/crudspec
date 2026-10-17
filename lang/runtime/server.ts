// crudspec v2 runtime: serves a spec as a working web app. It has no app-specific code:
// screens, actions, views and the API all come from the spec; this file only provides the
// generic layer (HTTP, sessions, rendering, files, live updates, widgets).
//
//   node lang/runtime/server.ts <spec.crud> --data <dir> --assets <dir> [--port 3000] [--test --harness <file>]
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream, statSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { parse, type Decl, type El, type Expr } from "../parser.ts";
import { Interpreter, Store, type Ref, type Val } from "../interp.ts";
import { SqliteStore } from "./store-sqlite.ts";
import { upgrade, takeLock } from "./upgrade.ts";
import { AgentApi } from "./agent.ts";
import { withGenerated } from "../scaffold.ts";
import { guardedFetch } from "./net.ts";
import { loadVapid, sendPush, SERVICE_WORKER } from "./webpush.ts";

// ---------------------------------------------------------------- setup
const argv = process.argv.slice(2);
const opt = (name: string, def: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const specPath = argv[0];
const dataDir = opt("--data", "D:/code/crudspec-run");
const assetDir = opt("--assets", "assets");
const port = Number(opt("--port", "3000"));
const TEST = argv.includes("--test");   // adds /_test endpoints for the replay driver; never in production
mkdirSync(join(dataDir, "files"), { recursive: true });

const spec = parse(readFileSync(specPath, "utf8"));
// default screens for what the spec's own screens don't cover (scaffold.ts), under /_auto
withGenerated(spec, parse);
const it = new Interpreter(spec);
const secretPath = join(dataDir, "secret");
if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString("hex"));
const SECRET = readFileSync(secretPath, "utf8");

// Secure versions of the interpreter's deterministic hooks.
let fixedTokens = 0;   // test fixtures: deterministic tokens, so rendered screens are stable
it.hooks.token = (n) => { if (fixedTokens) return `fx${String(fixedTokens++).padStart(Math.max(1, n - 2), "0")}`.slice(0, Math.max(n, 4)); const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; const b = randomBytes(n); return Array.from(b, (x) => a[x % a.length]).join(""); };
it.hooks.sign = (r, purpose, expiresAt) => { const body = `${purpose}.${r.ref}.${r.id}.${expiresAt}`; return `${Buffer.from(body).toString("base64url")}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`; };
it.hooks.unsign = (text) => {
  const [b, mac] = text.split(".");
  if (!b || !mac) return null;
  const body = Buffer.from(b, "base64url").toString();
  const want = createHmac("sha256", SECRET).update(body).digest("base64url");
  if (want.length !== mac.length || !timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  const [purpose, ref, id, exp] = body.split(".");
  return { purpose, ref, id: Number(id), expiresAt: Number(exp) };
};
it.hooks.hash = (pw) => { const salt = randomBytes(16).toString("hex"); return { scrypt: `${salt}:${scryptSync(pw, salt, 32).toString("hex")}` }; };
it.hooks.check = (stored, given) => {
  if (!stored?.scrypt) return false;
  const [salt, h] = stored.scrypt.split(":");
  return timingSafeEqual(Buffer.from(h, "hex"), scryptSync(given, salt, 32));
};

// Files made by workflows (a webhook's attachment reply) are stored like uploads.
it.hooks.file = (bytes, name, contentType) => {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""));
  const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf" }[contentType] ?? "";
  const stored = it.hooks.token(16) + ext;
  writeFileSync(join(dataDir, "files", stored), buf);
  return { file: name + ext, stored, content_type: contentType, size: buf.length };
};

// Externs, the spec's only way out of the app. Workflows run after the response, as
// Rails' background jobs do.
it.deferWorkflows = true;
const vapid = loadVapid(dataDir);
const EXTERNS: Record<string, (args: Val[]) => Promise<Val>> = {
  // webhook.rb: POST JSON with a timeout; a 200 text reply becomes a message, another typed reply an attachment
  post_json: async ([url, body, timeout]) => {
    try {
      const r = await fetch(plain(url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout?.ms ?? 7000) });
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = (r.headers.get("content-type") ?? "").split(";")[0].trim() || null;
      return { status: r.status, content_type: ct, text: buf.toString("utf8"), body: buf, timed_out: false };
    } catch (e: any) {
      return { status: 0, content_type: null, text: "", body: null, timed_out: e?.name === "TimeoutError" || e?.name === "AbortError" };
    }
  },
  // A link preview from a page's og: tags (as opengraph/*.rb): fetched through the network
  // guard, HTML only and at most 5 MB; title, url and description required; the image kept only
  // if it is a JPEG, PNG, GIF or WebP.
  opengraph: async ([url]) => {
    const link = plain(url);
    if (/\.(zip|tar|gz|bz2|xz|rar|7z|dmg|exe|msi|pkg|deb|iso|jpe?g|png|gif|bmp|mp4|mov|avi|mkv|wmv|flv|heic|heif|mp3|wav|ogg|aac|wma|webm|ogv|mpe?g)(\?|#|$)/i.test(link)) return null;
    const res = await guardedFetch(link);
    if (!res || res.status !== 200 || !res.body || !(res.headers["content-type"] ?? "").split(";")[0].trim().startsWith("text/html")) return null;
    const html = res.body.toString("utf8");
    const og: Record<string, string> = {};
    for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
      const tag = m[0];
      const key = (tag.match(/(?:property|name)\s*=\s*["']og:([a-z_:]+)["']/i) ?? [])[1];
      const content = (tag.match(/content\s*=\s*"([^"]*)"/i) ?? tag.match(/content\s*=\s*'([^']*)'/i) ?? [])[1];
      if (key && content && !(key in og)) og[key] = decodeEntities(content);
    }
    const strip = (x?: string) => (x ?? "").replace(/<[^>]*>/g, "").trim();
    const title = strip(og.title), description = strip(og.description);
    let canonical = og.url && /^https?:\/\//.test(og.url) ? og.url : link;
    let image: string | null = og.image && /^https?:\/\//.test(og.image) ? og.image : null;
    if (image) { const head = await guardedFetch(image, { method: "HEAD" }); const ct = (head?.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(); if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(ct)) image = null; }
    if (!title || !description || !canonical) return null;
    return { title, url: canonical, image, description };
  },
  // A notification to one browser subscription (web_push/notification.rb): "sent", "expired"
  // (the push service no longer knows it) or "failed".
  web_push: async ([endpoint, p256dh, auth, title, body, path, badge]) =>
    sendPush(plain(endpoint), plain(p256dh), plain(auth), { title: plain(title), options: { body: plain(body), data: { path: plain(path), badge: Number(badge ?? 0) } } }, vapid),
};
// Scenario replays stay offline: the Rails oracle stubs push delivery too.
if (TEST) EXTERNS.web_push = async () => "sent";
async function afterCommit(events: { event: string; args: Val[] }[] | undefined, request: any) {
  if (!events?.length) return;
  await it.runWorkflows(events, request, EXTERNS);
  save(); changed();
}

// Persistence: SQLite, with the schema generated from the spec (store-sqlite.ts). Each start
// upgrades the database to this spec first (upgrade.ts): planned, rehearsed on a copy and
// checked against every row, or refused. A JSON snapshot from an older runtime is imported once.
{
  const other = takeLock(join(dataDir, "app.sqlite"));
  if (other) { console.error(`storage: another process (${other}) is running on ${dataDir}`); process.exit(1); }
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
  const plan = upgrade(join(dataDir, "app.sqlite"), spec, { apply: true });
  if (plan.status === "blocked") {
    console.error("storage: the database can't be upgraded to this spec. The plan, with what blocks it:");
    console.error(JSON.stringify(plan, null, 2));
    process.exit(1);
  }
  if (plan.status !== "current") console.log(`storage: ${plan.status} version ${plan.to.version}${plan.backup ? `; backup ${plan.backup}` : ""}`);
  for (const st of plan.steps) if (plan.status !== "current" || st.class !== "safe") console.log(`storage: ${st.class}: ${st.detail}`);
  for (const m of plan.migrations) console.log(`storage: migration "${m.name}": ${JSON.stringify(m.changed)}`);
  for (const n of plan.notes) console.log(`storage: note: ${n}`);
}
const sqlite = new SqliteStore(join(dataDir, "app.sqlite"), it);
sqlite.migrate();
function withReferenceData(s: Store): Store {
  // reference data comes from the spec, not the database
  for (const d of spec.decls) if (d.kind === "data") { s.tables.set(d.name, it.store.rows(d.name)); s.nextId.set(d.name, it.store.nextId.get(d.name) ?? 1); }
  return s;
}
{
  const loaded = sqlite.load();
  const legacy = join(dataDir, "store.json");
  if (loaded) it.store = withReferenceData(loaded);
  else if (existsSync(legacy)) {
    const j = JSON.parse(readFileSync(legacy, "utf8"));
    const s = new Store();
    for (const [k, rows] of Object.entries(j.tables)) s.tables.set(k, rows as any);
    s.nextId = new Map(Object.entries(j.nextId).map(([k, v]) => [k, Number(v)]));
    s.seq = j.seq;
    sqlite.fillDefaults(s);
    it.store = withReferenceData(s);
    sqlite.persist(it.store);
    sqlite.notes.push(`imported ${legacy}`);
  }
  for (const n of sqlite.notes) console.log(`storage: ${n}`);
}
function save() { sqlite.persist(it.store); }

// Agents: the spec's actions and views over JSON and MCP, for tokens people issue (agent.ts)
const agents = new AgentApi({
  it, spec, source: readFileSync(specPath, "utf8"), db: sqlite.db, secret: SECRET,
  commit: (events, request) => { save(); changed(); void afterCommit(events, request).catch((e) => console.error(e)); },
  version: () => version,
  sessionActor: (r) => { const w = whoIs(r); return w.identity === sessionIdentity?.name ? w.actor : null; },
  label: (ref) => displayOf(ref), fileUrl: (v) => fileUrl(v),
});

const decls = (kind: string) => spec.decls.filter((d) => d.kind === kind);
// --widgets <module>: implementations of the spec's widget declarations, each
// (args, helpers) => html. A declared widget without one renders nothing, with a warning.
const appWidgets = new Map(decls("widget").map((d) => [d.name, d]));
const widgetPath = opt("--widgets", "");
const widgetModule: Record<string, (args: Val[], h: any) => string> | null = widgetPath ? (await import(pathToFileURL(widgetPath).href)).default : null;
for (const n of appWidgets.keys()) if (!widgetModule?.[n]) console.warn(`widgets: ${n} is declared but not implemented${widgetPath ? ` in ${widgetPath}` : " (no --widgets module)"}`);
const screens = decls("screen"), components = new Map(decls("component").map((d) => [d.name, d])), layouts = new Map(decls("layout").map((d) => [d.name, d]));
const theme = decls("theme")[0];

// ---------------------------------------------------------------- live updates
let version = 0;
let clockOffset = 0;
let frozenClock: number | null = null;   // test fixtures freeze time, so screens render the same each run
const listeners = new Set<ServerResponse>();
function changed() { version++; for (const r of listeners) r.write(`data: ${version}\n\n`); }

// ---------------------------------------------------------------- requests
type Req = { method: string; path: string; query: URLSearchParams; cookies: Record<string, string>; ip: string; ua: string; body: Record<string, any>; files: Record<string, any>; text: string; testActor?: string };
type Who = { actor: Ref | null; session: string | null; identity?: string };

function cookies(req: IncomingMessage) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
const MAX_BODY = 25 * 1024 * 1024;
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) throw { status: 413 }; chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
function parseBody(buf: Buffer, ctype: string): { body: Record<string, any>; files: Record<string, any>; text: string } {
  const body: Record<string, any> = {}, files: Record<string, any> = {};
  const add = (k: string, v: any) => { if (k.endsWith("[]")) (body[k.slice(0, -2)] ??= []).push(v); else body[k] = v; };
  if (ctype.startsWith("application/x-www-form-urlencoded")) for (const [k, v] of new URLSearchParams(buf.toString())) add(k, v);
  else if (ctype.startsWith("multipart/form-data")) {
    const boundary = "--" + ctype.split("boundary=")[1];
    const parts = buf.toString("latin1").split(boundary).slice(1, -1);
    for (const part of parts) {
      const [head, ...rest] = part.split("\r\n\r\n");
      const content = rest.join("\r\n\r\n").replace(/\r\n$/, "");
      const name = head.match(/name="([^"]+)"/)?.[1]; if (!name) continue;
      const filename = head.match(/filename="([^"]*)"/)?.[1];
      if (filename !== undefined) {
        if (!filename) continue;
        const id = it.hooks.token(16) + extname(filename);
        writeFileSync(join(dataDir, "files", id), Buffer.from(content, "latin1"));
        files[name] = { file: filename, stored: id, content_type: head.match(/Content-Type: (.+)/i)?.[1]?.trim() ?? "application/octet-stream", size: Buffer.byteLength(content, "latin1") };
      } else add(name, Buffer.from(content, "latin1").toString("utf8"));
    }
  }
  return { body, files, text: buf.toString("utf8") };   // the raw body, as Rails' raw_request_body
}
// Identities, from the spec's identity declarations.
//   identity session: Session.token from cookie "session_token"
//   identity bot_key: User from param bot_key as "{id}-{bot_token}" where …
const appDecl = spec.decls.find((d) => d.kind === "app");
const ACTOR: string = appDecl?.props.actor?.name ?? "";
const APP_NAME = appDecl?.props.name ? String(appDecl.props.name.value) : "";
const identityDecls = decls("identity");
const sessionIdentity = identityDecls.find((d) => d.source === "cookie");
const COOKIE = sessionIdentity ? String(sessionIdentity.key.value) : "session";
const SESSION_ENTITY: string = sessionIdentity?.entity ?? "";
const SESSION_FIELD: string = sessionIdentity?.field ?? "token";
// the session's field that refers to the actor
const SESSION_ACTOR_FIELD: string = (it.entities.get(SESSION_ENTITY)?.fields ?? []).find((f: any) => f.type.kind === "named" && f.type.name === ACTOR)?.name ?? "";
const paramIdentities = identityDecls.filter((d) => d.source === "param");
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function resolveParamIdentity(d: Decl, raw: string | null | undefined): Ref | null {
  if (!raw) return null;
  const fmt = d.format ? String(d.format.value) : "{id}";
  const names = [...fmt.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const m = raw.match(new RegExp("^" + fmt.split(/\{\w+\}/).map(escapeRe).join("(.+?)") + "$"));
  if (!m) return null;
  const want = Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
  const row = it.store.rows(d.entity).find((r) => names.every((n) => String(n === "id" ? r.id : r.fields[n]) === want[n]) &&
    (!d.where || it.truthy(it.eval(d.where, { vars: new Map(), actor: null, request: { ip: "", method: "get", identity: "" }, events: [], effects: [], row: { entity: d.entity, row: r } } as any))));
  return row ? { ref: d.entity, id: row.id } : null;
}
// Trusts X-Forwarded-For only from a loopback proxy, as Rails trusts its proxies.
function clientIp(req: IncomingMessage): string {
  const peer = String(req.socket.remoteAddress ?? "").replace("::ffff:", "");
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd && (peer === "127.0.0.1" || peer === "::1") ? fwd : peer;
}
function whoIs(r: Req): Who {
  // test mode only: render as a given actor ("Entity:id"), for tools/screens
  if (TEST && r.testActor) { const [e, id] = r.testActor.split(":"); if (it.store.find({ ref: e, id: Number(id) })) return { actor: { ref: e, id: Number(id) }, session: null, identity: sessionIdentity?.name }; }
  // A parameter identity may come with any request; gates decide what it may do there.
  for (const d of paramIdentities) {
    const raw = r.query.get(d.key.name);
    if (raw) { const who = resolveParamIdentity(d, raw); return who ? { actor: who, session: null, identity: d.name } : { actor: null, session: null }; }
  }
  const token = r.cookies[COOKIE];
  if (!token || !SESSION_ENTITY) return { actor: null, session: null };
  const s = it.store.rows(SESSION_ENTITY).find((x) => x.fields[SESSION_FIELD] === token);
  if (!s) return { actor: null, session: null };
  return { actor: s.fields[SESSION_ACTOR_FIELD], session: token, identity: sessionIdentity!.name };
}

// ---------------------------------------------------------------- HTML
const esc = (v: any) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const BASE = "";   // URLs are site-relative
it.baseUrl = "";

type RCtx = { vars: Map<string, Val>; who: Who; req: Req; slots: Record<string, string>; title: string; channels: string[]; bodyClass: Set<string> };
// Ambient values the runtime provides to screens: theme, app and client.
function ambient(cookies?: Record<string, string>): Map<string, Val> {
  const base = { vars: new Map(), actor: null, request: { ip: "", method: "get", identity: "" }, events: [], effects: [] } as any;
  const logo = theme?.props.logo ? it.eval(theme.props.logo, base) : null;
  return new Map<string, Val>([["theme", { logo }], ["app", { name: APP_NAME, version: "crudspec-runtime" }], ["client", { push_endpoint: cookies?.push_endpoint || null }], ["input", {}]]);
}
const withAmbient = (vars: Map<string, Val>, cookies?: Record<string, string>) => { const m = ambient(cookies); for (const [k, v] of vars) m.set(k, v); return m; };
const ectx = (rc: RCtx, extra?: Map<string, Val>) => ({ vars: withAmbient(extra ?? rc.vars, rc.req.cookies), actor: rc.who.actor, request: { ip: rc.req.ip, method: "get" as const, identity: rc.who.identity ?? "", user_agent: rc.req.ua, session_token: rc.who.session ?? undefined, cookies: rc.req.cookies }, events: [], effects: [] });
function ev(e: Expr | undefined, rc: RCtx): Val { if (!e) return null; try { return it.eval(e, ectx(rc) as any); } catch (err) { if ((err as any).outcome) return null; throw err; } }
const plain = (v: Val) => it.plain(v);
const isRef = (v: Val) => v && typeof v === "object" && "ref" in v && "id" in v;

function fileUrl(v: Val): string {
  if (!v) return "";
  if (typeof v === "string") return v.startsWith("/") || v.startsWith("http") ? v : `/assets/${v}`;
  if (v.stored) return `/files/${v.stored}`;
  return "";
}
// theme { classes json { button: "…", … } }: the app's class names for the runtime's own markup.
// The runtime has none of its own, apart from neutral defaults for accessibility.
let themeClasses: Record<string, string> | null = null;
function dc(kind: string): string {
  if (!themeClasses) {
    const base = { vars: new Map(), actor: null, request: { ip: "", method: "get", identity: "" }, events: [], effects: [] } as any;
    themeClasses = theme?.props.classes ? (it.eval(theme.props.classes, base) ?? {}) : {};
  }
  return themeClasses![kind] ?? (kind === "screen_reader" ? "visually-hidden" : "");
}
function iconTag(name: Val, size = 20) { return name ? `<img src="/assets/${esc(plain(name))}.svg" width="${size}" height="${size}" aria-hidden="true" class="${dc("icon")}">` : ""; }
function avatarUrl(u: Val) { return isRef(u) ? `/avatars/${u.ref}/${u.id}` : ""; }
// display <Entity>: <expr> labels a row in pickers and lists
const displays = new Map(decls("display").map((d) => [d.entity, d.value]));
function displayOf(r: Ref): string {
  const row = it.store.find(r); const e = displays.get(r.ref);
  if (!row) return `${r.ref} ${r.id}`;
  if (!e) {
    // no `display` declared: a name or title field, if the entity has one
    const f = ["name", "title", "label", "subject"].find((k) => typeof row.fields[k] === "string" && row.fields[k]);
    return f ? row.fields[f] : `${r.ref} ${r.id}`;
  }
  return plain(it.eval(e, { vars: new Map(), actor: null, request: { ip: "", method: "get", identity: "" }, events: [], effects: [], row: { entity: r.ref, row } } as any));
}
// A picker (mentions, autocomplete) is a view call in the field's attributes, with "typed"
// bound to what the person has typed. /_pick/<element> evaluates it with the page's variables.
function pickCall(el: El): any { return (el.attrs.mentions ?? el.attrs.autocomplete) as any; }
// Rows the person may read, by their entity's read permission (choices never leak rows).
function readable(rows: Ref[], rc: RCtx): Ref[] {
  return (rows ?? []).filter((r) => {
    const cond = it.permissions.get(r.ref); if (!cond) return true;
    const snakeName = r.ref.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    try { return it.truthy(it.eval(cond, { ...ectx(rc), vars: new Map([...withAmbient(rc.vars, rc.req.cookies), [snakeName, r]]) } as any)); } catch { return false; }
  });
}
function pickRows(el: El, rc: RCtx, typed: string): Ref[] {
  const call = pickCall(el); const view = call && it.get("view", call.name);
  if (!view) return [];
  const vars = new Map(rc.vars); vars.set("typed", typed);
  const args: Record<string, unknown> = {};
  view.params.forEach((p: any, i: number) => { const a = call.args[i] ?? call.named?.[p.name]; const v = a ? it.eval(a, ectx({ ...rc, vars }) as any) : null; args[p.name] = isRef(v) ? v.id : v; });
  const r = it.run(view.name, args, rc.who.actor, { ip: rc.req.ip, method: "get", identity: rc.who.identity ?? "", cookies: rc.req.cookies });
  return r.rows ?? [];
}
function pickEntity(el: El, _rc: RCtx): string { const call = pickCall(el); return call ? it.get("view", call.name)?.rows?.entity ?? "" : ""; }
function pickSrc(el: El, rc: RCtx): string {
  const body = Buffer.from(JSON.stringify({ e: idOfEl.get(el), v: [...rc.vars] })).toString("base64url");
  return `/_pick?ctx=${body}.${mac(body)}`;
}
function screenUrl(name: string, args: Val[], named: Record<string, Val> = {}): string {
  const d = screens.find((s) => s.name === name);
  if (!d) return "/";
  let route: string = d.route; const q = new URLSearchParams();
  d.params.forEach((p: any, i: number) => {
    const v = i < args.length ? args[i] : named[p.name];
    const s = v === null || v === undefined ? "" : isRef(v) ? String(v.id) : String(v);
    if (route.includes(`:${p.name}`)) route = route.replace(`:${p.name}`, encodeURIComponent(s));
    else if (s !== "") q.set(p.name, s);
  });
  return route + (q.toString() ? `?${q}` : "");
}
function targetUrl(t: any, rc: RCtx): string {
  if (t.kind === "url") return plain(fileUrlMaybe(ev(t.value, rc)));
  if (t.bare && t.name === "back") return rc.req.query.get("back") ?? "javascript:history.back()";
  if (t.bare && t.name === "home") return "/";
  return screenUrl(t.name, t.args.map((a: Expr) => ev(a, rc)), Object.fromEntries(Object.entries(t.named).map(([k, v]) => [k, ev(v as Expr, rc)])));
}
function fileUrlMaybe(v: Val) { return v && typeof v === "object" && "stored" in v ? fileUrl(v) : v; }

// Encodes an action call's fixed arguments as hidden fields.
function serial(v: Val): string { if (v === null || v === undefined) return ""; if (isRef(v)) return `#${v.id}`; if (v && typeof v === "object" && "set" in v) return `@${v.set.join(",")}`; if (typeof v === "object") return JSON.stringify(v); return String(v); }
function hiddenArgs(action: Decl, t: any, rc: RCtx): string {
  const out: string[] = [];
  t.args.forEach((a: Expr, i: number) => { const p = action.params[i]; if (p) out.push(`<input type="hidden" name="__arg_${p.name}" value="${esc(serial(ev(a, rc)))}">`); });
  for (const [k, v] of Object.entries(t.named)) out.push(`<input type="hidden" name="__arg_${k}" value="${esc(serial(ev(v as Expr, rc)))}">`);
  return out.join("");
}

// Handlers ("on ok go …") are stateless: each "on" element has a stable id from the spec,
// and a form carries the ids, the page and the variables in scope, signed with HMAC.
const elById = new Map<number, El>(), idOfEl = new WeakMap<El, number>();
{
  let n = 0;
  const walk = (els: El[]) => { for (const el of els) { idOfEl.set(el, ++n); elById.set(n, el); walk(el.children); if (el.else) walk(el.else); } };
  for (const d of spec.decls) if (d.body && Array.isArray(d.body) && ["screen", "component", "layout"].includes(d.kind)) walk(d.body);
}
const mac = (body: string) => createHmac("sha256", SECRET).update(body).digest("base64url");
function handlerId(els: El[], rc: RCtx): string {
  const body = Buffer.from(JSON.stringify({ e: els.map((e) => idOfEl.get(e)), p: rc.req.path + (rc.req.query.toString() ? `?${rc.req.query}` : ""), v: [...rc.vars] })).toString("base64url");
  return `${body}.${mac(body)}`;
}
function handlerFrom(token: string): { path: string; els: El[]; vars: [string, Val][] } | undefined {
  const [body, sig] = token.split(".");
  if (!body || !sig || sig.length !== mac(body).length || !timingSafeEqual(Buffer.from(sig), Buffer.from(mac(body)))) return undefined;
  const j = JSON.parse(Buffer.from(body, "base64url").toString());
  return { path: String(j.p).startsWith("/") && !String(j.p).startsWith("//") ? j.p : "/", els: j.e.map((i: number) => elById.get(i)).filter(Boolean), vars: j.v };
}

function render(els: El[], rc: RCtx): string {
  let html = "";
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    // "on" right after a button belongs to that button
    if (el.name === "button") {
      const handlers: El[] = [];
      while (els[i + 1]?.name === "on") handlers.push(els[++i]);
      html += renderEl(el, rc, handlers);
    } else if (el.name !== "on") html += renderEl(el, rc, []);
  }
  return html;
}
function cls(el: El, rc: RCtx, base = "") { const c = el.attrs.class ? plain(ev(el.attrs.class as Expr, rc)) : ""; return `${base} ${c}`.trim(); }
function attrVal(el: El, k: string, rc: RCtx): Val { const a = el.attrs[k]; return a === true ? true : a ? ev(a as Expr, rc) : null; }
function shown(el: El, rc: RCtx) { return !el.attrs.if || it.truthy(ev(el.attrs.if as Expr, rc)); }
// A label is read out by screen readers next to an icon; with no icon (and no text) it is the visible text.
// theme { tokens json { accent: "#2f6feb", … } }: design tokens as CSS variables (--accent),
// after the stylesheets so the spec's values win. Names and values are sanitized.
function tokenCss(rc: RCtx): string {
  const t = theme?.props.tokens ? ev(theme.props.tokens, rc) : null;
  if (!t || typeof t !== "object") return "";
  const vars = Object.entries(t).filter(([k, v]) => /^[a-z][a-z0-9_-]*$/i.test(k) && /^[^;{}<>\\]+$/.test(String(v))).map(([k, v]) => `--${k.replace(/_/g, "-")}: ${v};`);
  return vars.length ? `<style>:root { ${vars.join(" ")} }</style>` : "";
}
function label(el: El, rc: RCtx) { const l = attrVal(el, "label", rc); if (!l) return ""; const visible = !el.attrs.icon && !el.attrs.text && (el.name === "submit" || el.name === "button" || el.name === "link" ||
    // a choice has no placeholder to say what it is, so its label shows
    (el.name === "field" && ["select", "choice", "users"].includes(el.head.kind) && !el.attrs.placeholder)); return visible ? `<span>${esc(plain(l))}</span>` : `<span class="${dc("screen_reader")}">${esc(plain(l))}</span>`; }

function renderEl(el: El, rc: RCtx, handlers: El[]): string {
  if (!shown(el, rc)) return "";
  const h = el.head;
  const kids = () => render(el.children, rc);
  const icon = attrVal(el, "icon", rc);
  switch (el.name) {
    case "title": if (h) rc.title = plain(ev(h, rc)); return "";
    case "heading": return `<h1 class="${esc(cls(el, rc, dc("heading")))}">${esc(plain(ev(h, rc)))}</h1>`;
    case "text": { const v = ev(h, rc); return v === null ? "" : `<span class="${esc(cls(el, rc))}">${esc(isRef(v) ? displayOf(v) : plain(v))}</span>`; }
    case "strong": return `<strong class="${esc(cls(el, rc))}" title="${esc(plain(attrVal(el, "title", rc)))}">${esc(plain(ev(h, rc)))}</strong>`;
    case "richtext": { const rv = ev(h, rc); return `<div class="${esc(cls(el, rc))}" dir="auto">${autolink(esc(plain(rv)))}${(rv?.embeds ?? []).map(embedHtml).join("")}</div>`; }
    case "time": { const t = ev(h, rc); if (!t?.time) return ""; const d = new Date(t.time); const as = (el.attrs.as as any)?.name;
      return `<time class="${esc(cls(el, rc))}" datetime="${d.toISOString()}">${esc(as === "date" ? d.toDateString() : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))}</time>`; }
    case "image": { const v = ev(h, rc); if (!v) return ""; const w = attrVal(el, "width", rc), hh = attrVal(el, "height", rc);
      return `<img class="${esc(cls(el, rc))}" src="${esc(fileUrl(v))}" ${w ? `width="${w}"` : ""} ${hh ? `height="${hh}"` : ""} alt="">`; }
    case "icon": return iconTag(ev(h, rc));
    case "avatar": { const u = ev(h, rc); return `<figure class="${esc(cls(el, rc, dc("avatar")))} ${el.attrs.large ? dc("avatar_large") : ""}"><img src="${avatarUrl(u)}" alt="${esc(plain(attrVal(el, "label", rc) ?? ""))}"></figure>`; }
    case "avatars": { const l = ev(h, rc) ?? []; return `<div class="avatar__group">${(l as Val[]).map((u) => `<span class="avatar"><img src="${avatarUrl(u)}" alt=""></span>`).join("")}</div>`; }
    case "separator": return `<hr class="separator">`;
    case "field_display": return `<input type="text" class="input" readonly value="${esc(plain(ev(h, rc)))}">`;
    case "let": rc.vars.set(h.name, ev(h.value, rc)); return "";
    case "if": return it.truthy(ev(h, rc)) ? render(el.children, rc) : el.else ? render(el.else, rc) : "";
    case "each": { const l = ev(h.over, rc); const items = Array.isArray(l) ? l : l?.set ? l.set.map((id: number) => ({ ref: l.entity, id })) : [];
      return items.map((x: Val) => { const vars = new Map(rc.vars); vars.set(h.bind, x); return render(el.children, { ...rc, vars }); }).join(""); }
    case "list": return renderList(el, rc);
    case "use": {
      const comp = components.get(h.name)!;
      const vars = new Map<string, Val>();
      comp.params.forEach((p: any, i: number) => vars.set(p.name, ev(h.args[i], rc)));
      return render(comp.body, { ...rc, vars });
    }
    case "widget": return widget(h, el, rc);
    case "channel": { const args = h.args.map((a: Expr) => { const v = ev(a, rc); return encodeURIComponent(isRef(v) ? String(v.id) : plain(v)); }); rc.channels.push(`${h.name}:${args.join(",")}`); return ""; }
    case "signal": return `<div class="${dc("signal")}"></div>`;
    case "link": {
      const href = targetUrl(h, rc);
      const unread = el.attrs.unread && it.truthy(ev(el.attrs.unread as Expr, rc)) ? " unread" : "";
      return `<a href="${esc(href)}" class="${esc(cls(el, rc, el.children.length ? "" : dc("button")))}${unread}">${iconTag(icon)}${label(el, rc)}${kids()}</a>`;
    }
    case "button": return renderButton(el, rc, handlers);
    case "form": return renderForm(el, rc);
    case "field": return renderField(el, rc);
    case "switch": {
      const link = attrVal(el, "link", rc);
      const on = el.attrs.on === true || (el.attrs.value ? it.truthy(ev(el.attrs.value as Expr, rc)) : false);
      const input = `<label class="switch">${iconTag(icon)}<input type="checkbox" class="switch__input" ${on ? "checked" : ""} ${el.attrs.auto_submit ? `onchange="this.form.requestSubmit()"` : ""} ${link ? `onchange="location.href=this.dataset.href" data-href="${esc(screenUrlFromVal(link))}"` : ""}><span class="switch__btn round"></span>${label(el, rc)}</label>`;
      return `<div class="${dc("row")}">${input}</div>`;
    }
    case "submit": return `<button type="submit" class="${dc("submit")}">${iconTag(icon)}${label(el, rc)}</button>`;
    case "section": { const lg = attrVal(el, "legend", rc); const banned = attrVal(el, "banned", rc) ? " banned" : "";
      return lg ? `<fieldset class="${esc(cls(el, rc))}${banned}"><legend><strong>${esc(plain(lg))}</strong></legend>${kids()}</fieldset>` : `<section class="${esc(cls(el, rc))}${banned}" id="${esc(plain(attrVal(el, "id", rc) ?? ""))}">${kids()}</section>`; }
    case "row": { const d = attrVal(el, "data", rc); const banned = attrVal(el, "banned", rc) ? " banned" : "";
      const data = d && typeof d === "object" ? Object.entries(d).map(([k, v]) => ` data-${k.replace(/_/g, "-")}="${esc(serial(v))}"`).join("") : "";
      // A class hint replaces the default layout classes, so the theme's own grids apply.
      return `<div class="${esc(el.attrs.class ? cls(el, rc) : dc("row"))}${banned}"${data}>${kids()}</div>`; }
    case "column": return `<div class="${esc(el.attrs.class ? cls(el, rc) : dc("column"))}">${kids()}</div>`;
    case "menu":
      // With an icon or label it's a dropdown; otherwise a plain <menu> list.
      if (!icon && !el.attrs.label) return `<menu class="${esc(cls(el, rc, dc("menu")))}">${kids()}</menu>`;
      return `<details class="${dc("dropdown")}"><summary class="${dc("button")}">${iconTag(icon)}${label(el, rc)}</summary><menu class="${dc("dropdown_panel")}">${kids()}</menu></details>`;
    case "popup": return `<details class="${dc("dropdown")}"><summary class="${esc(cls(el, rc, dc("button")))}">${iconTag(icon)}${label(el, rc)}</summary><div class="${esc(plain(attrVal(el, "panel", rc) ?? dc("dropdown_panel")))}">${kids()}</div></details>`;
    case "dialog": case "frame": return `<div>${kids()}</div>`;
    case "go": return "";
    case "nav": case "main": case "footer": case "sidebar": rc.slots[el.name] = (rc.slots[el.name] ?? "") + kids(); if (el.name === "sidebar") rc.bodyClass.add("sidebar"); return "";
  }
  return "";
}
function screenUrlFromVal(v: Val) { return v && typeof v === "object" && "screen" in v ? screenUrl(v.screen, v.args) : plain(v); }
// A link preview inside rich text; the theme's classes give it the app's look.
function embedHtml(e: any): string {
  return `<figure class="${dc("embed")}"><div class="${dc("embed_body")}"><div class="${dc("embed_content")}"><div class="${dc("embed_title")}"><a href="${esc(e.url)}" rel="noreferrer" target="_blank">${esc(e.title)}</a></div>` +
    `<div class="${dc("embed_description")}">${esc(e.description)}</div></div>${e.image ? `<div class="${dc("embed_image")}"><img src="${esc(e.image)}" alt="" referrerpolicy="no-referrer"></div>` : ""}</div></figure>`;
}
function decodeEntities(x: string) { return x.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function autolink(s: string) { return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, "<br>"); }

function renderList(el: El, rc: RCtx): string {
  const h = el.head;
  let refs: Ref[] = [];
  if (h.source.kind === "query") {
    const rows = it.select(h.source, ectx(rc) as any);
    const perm = it.permissions.get(h.source.entity);
    refs = rows.filter((row) => !perm || it.truthy(it.eval(perm, { ...ectx(rc), vars: new Map([[snake(h.source.entity), { ref: h.source.entity, id: row.id }]]) } as any))).map((row) => ({ ref: h.source.entity, id: row.id }));
  } else {
    const view = it.get("view", h.source.name)!;
    const args: Record<string, unknown> = {};
    view.params.forEach((p: any, i: number) => { const a = h.source.args[i] ?? h.source.named[p.name]; const v = a ? ev(a, rc) : null; args[p.name] = isRef(v) ? v.id : v?.set ? v.set : v; });
    const r = it.run(h.source.name, args, rc.who.actor, { ip: rc.req.ip, method: "get", identity: rc.who.identity ?? "", cookies: rc.req.cookies });
    refs = r.rows ?? [];
  }
  let items = refs.map((ref) => { const vars = new Map(rc.vars); vars.set(h.bind, ref); return vars; });
  if (h.where) items = items.filter((vars) => it.truthy(ev(h.where, { ...rc, vars })));
  if (h.order) { const keyed = items.map((vars) => ({ vars, k: ev(h.order, { ...rc, vars }) })); keyed.sort((a, b) => it.compare(a.k, b.k)); items = keyed.map((x) => x.vars); if (h.desc) items.reverse(); }
  const inner = items.map((vars) => render(el.children, { ...rc, vars })).join("");
  return `<div class="${esc(cls(el, rc))}" data-live-list>${inner}</div>`;
}

function renderButton(el: El, rc: RCtx, handlers: El[]): string {
  const h = el.head;
  const action = it.get("action", h.name);
  if (!action) return "";
  // Offer it only where its requires could pass: dry-run the action on a copy.
  if (!wouldPass(action, h, rc)) return "";
  const confirm = attrVal(el, "confirm", rc);
  const text = attrVal(el, "text", rc);
  const icon = attrVal(el, "icon", rc);
  const hid = handlerId(handlers, rc);
  const sel = el.attrs.selected && it.truthy(ev(el.attrs.selected as Expr, rc)) ? " btn--reversed" : "";
  return `<form method="post" action="/_do/${h.name}" class="${dc("button_form")}" ${confirm ? `onsubmit="return confirm(${esc(JSON.stringify(plain(confirm)))})"` : ""}>${hiddenArgs(action, h, rc)}<input type="hidden" name="__h" value="${hid}"><button type="submit" class="${esc(cls(el, rc, dc("button")))}${sel}">${iconTag(icon)}${text ? esc(plain(text)) : ""}${label(el, rc)}${render(el.children, rc)}</button></form>`;
}
function wouldPass(action: Decl, t: any, rc: RCtx): boolean {
  if (!rc.who.actor && !action.skips.includes("signed_in")) return false;
  const args: Record<string, unknown> = {};
  action.params.forEach((p: any, i: number) => { const a = t.args[i] ?? t.named[p.name]; const v = a ? ev(a, rc) : null; args[p.name] = isRef(v) ? v.id : v?.set ? v.set : v; });
  // Requires that depend only on fixed arguments and the actor decide; missing inputs don't.
  const saved = it.store; it.store = saved.clone();
  try {
    const r = it.run(action.name, args, rc.who.actor, { ip: rc.req.ip, method: "write", identity: rc.who.identity ?? "", cookies: rc.req.cookies });
    return !(["forbidden", "not_found"].includes(r.outcome) && r.cause === "require" || r.cause === "gate");
  } catch { return true; } finally { it.store = saved; }
}

function renderForm(el: El, rc: RCtx): string {
  const h = el.head;
  const action = it.get("action", h.name);
  if (!action) return "";
  const handlers = el.children.filter((c) => c.name === "on");
  const hid = handlerId(handlers, rc);
  const auto = el.attrs.auto_submit ? ` onchange="this.requestSubmit()"` : "";
  const readonly = el.attrs.readonly_unless && !it.truthy(ev(el.attrs.readonly_unless as Expr, rc));
  const body = render(el.children, rc);
  return `<form method="post" action="/_do/${h.name}" enctype="multipart/form-data" class="${esc(cls(el, rc, dc("form")))}" id="${esc(plain(attrVal(el, "id", rc) ?? ""))}"${auto}>${hiddenArgs(action, h, rc)}<input type="hidden" name="__h" value="${hid}"><fieldset ${readonly ? "disabled" : ""} class="${dc("fieldset")}">${body}</fieldset></form>`;
}
function renderField(el: El, rc: RCtx): string {
  const { name, kind } = el.head;
  const value = attrVal(el, "value", rc);
  const ph = attrVal(el, "placeholder", rc);
  const req = el.attrs.required ? " required" : "";
  const max = attrVal(el, "maxlength", rc);
  const icon = attrVal(el, "icon", rc);
  const common = `name="${name}" class="input" placeholder="${esc(plain(ph ?? ""))}"${req}${max ? ` maxlength="${max}"` : ""}`;
  let input = "";
  switch (kind) {
    case "textarea": case "code": input = `<textarea ${common} rows="${attrVal(el, "rows", rc) ?? 3}">${esc(plain(value))}</textarea>`; break;
    case "richtext": {
      // "mentions <view>" offers a picker on "@": picked people are recorded as mentions,
      // as Rails' mention attachments are; typed "@name" text alone is not a mention.
      const src = el.attrs.mentions ? pickSrc(el, rc) : "";
      const unfurl = el.attrs.unfurl ? (el.attrs.unfurl as any) : null;
      const unfurlSrc = unfurl && unfurl.kind === "name" && it.get("view", unfurl.name) ? `/_view/${unfurl.name}?${it.get("view", unfurl.name)!.params[0]?.name ?? "link"}=` : "";
      input = `<textarea ${common} rows="1" data-richtext ${src ? `data-mentions-src="${esc(src)}"` : ""} ${unfurlSrc ? `data-unfurl-src="${esc(unfurlSrc)}"` : ""} onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!this.dataset.picking){event.preventDefault();this.form.requestSubmit()}">${esc(plain(value))}</textarea>` +
        (unfurlSrc ? `<input type="hidden" name="${name}__embeds" value="[]"><div class="embed-previews"></div>` : "") +
        (src ? `<input type="hidden" name="${name}__mentions" value=""><input type="hidden" name="${name}__mentions_entity" value="${esc(pickEntity(el, rc))}"><div class="mention-picker" hidden style="position:absolute;bottom:100%;background:var(--color-bg,#fff);border:1px solid #ccc;border-radius:.5em;padding:.25em;z-index:10"></div>` : "");
      break;
    }
    case "password": input = `<input type="password" ${common} autocomplete="current-password">`; break;
    case "email": input = `<input type="email" ${common} value="${esc(plain(value))}">`; break;
    case "url": input = `<input type="url" ${common} value="${esc(plain(value))}">`; break;
    case "number": input = `<input type="number" step="1" ${common} value="${esc(plain(value))}">`; break;
    case "choice": {
      // fixed values: an enum's, or yes and no
      const values: Val[] = attrVal(el, "from", rc) ?? [];
      const cur = value === null || value === undefined ? "" : String(value);
      input = `<select name="${name}" class="${dc("input")}"${req}>${el.attrs.required ? "" : `<option value="">—</option>`}${values.map((v) => `<option value="${esc(String(v))}" ${String(v) === cur ? "selected" : ""}>${esc(typeof v === "boolean" ? (v ? "Yes" : "No") : String(v).replace(/_/g, " "))}</option>`).join("")}</select>`;
      break;
    }
    case "file": input = `<input type="file" name="${name}" ${el.attrs.multiple ? "multiple" : ""} ${el.attrs.accept ? `accept="${esc(plain(attrVal(el, "accept", rc)))}"` : ""}>`; break;
    case "hidden": input = `<input type="hidden" name="${name}" value="${esc(serial(value))}">`; break;
    case "users": {
      const from: Ref[] = readable(attrVal(el, "from", rc) ?? pickRows(el, rc, ""), rc);
      const sel = attrVal(el, "value", rc);
      const selected = new Set<number>(sel?.set ?? []);
      input = `<div class="${dc("choices")}">${from.map((u) => `<label class="${dc("choice")}"><input type="checkbox" name="${name}[]" value="${u.id}" ${selected.has(u.id) ? "checked" : ""}><span class="avatar"><img src="${avatarUrl(u)}" alt=""></span><strong>${esc(displayOf(u))}</strong></label>`).join("")}</div>`;
      break;
    }
    case "select": {
      const from: Ref[] = readable(attrVal(el, "from", rc) ?? pickRows(el, rc, ""), rc);
      const cur = attrVal(el, "value", rc);
      const curId = isRef(cur) ? cur.id : cur?.set?.[0];
      input = `<select name="${name}" class="${dc("input")}"${req}><option value="">—</option>${from.map((u) => `<option value="${u.id}" ${u.id === curId ? "selected" : ""}>${esc(displayOf(u))}</option>`).join("")}</select>`;
      break;
    }
    default: input = `<input type="text" ${common} value="${esc(plain(value))}">`;
  }
  const lab = label(el, rc), shownLabel = lab.startsWith("<span>");   // a visible label goes first
  return `<label class="${esc(el.attrs.class ? cls(el, rc) : dc("field"))}">${shownLabel ? lab : ""}${iconTag(icon, 24)}${input}${shownLabel ? "" : lab}</label>`;
}

function widget(h: any, el: El, rc: RCtx): string {
  const args = h.args.map((a: Expr) => ev(a, rc));
  const lbl = attrVal(el, "label", rc);
  // the app's own widgets (widget declarations, implemented by the --widgets module)
  if (appWidgets.has(h.name)) {
    const impl = widgetModule?.[h.name];
    return impl ? impl(args, { esc, plain, dc, icon: iconTag(attrVal(el, "icon", rc)), label: lbl === null || lbl === undefined ? "" : plain(lbl), cls: cls(el, rc), display: (r: Ref) => displayOf(r), fileUrl, attr: (n: string) => attrVal(el, n, rc) }) : "";
  }
  switch (h.name) {
    case "copy_button": return `<button type="button" class="${dc("button")}" onclick="navigator.clipboard.writeText(${esc(JSON.stringify(plain(args[0])))})">${iconTag(attrVal(el, "icon", rc))}<span class="${dc("screen_reader")}">${esc(plain(lbl ?? "Copy"))}</span></button>`;
    case "share_button": return `<button type="button" class="${dc("button")}" onclick="navigator.share && navigator.share({url: ${esc(JSON.stringify(plain(fileUrlMaybe(args[0]))))}})">${iconTag(attrVal(el, "icon", rc))}<span class="${dc("screen_reader")}">Share</span></button>`;
    case "qr_link": return `<a class="${dc("button")}" target="_blank" href="https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(plain(args[0]))}">${iconTag(attrVal(el, "icon", rc))}<span class="${dc("screen_reader")}">${esc(plain(lbl ?? "QR code"))}</span></a>`;
    case "lightbox": return `<a href="${esc(fileUrl(args[0]))}" target="_blank"><img src="${esc(fileUrl(args[0]))}" style="max-width:100%;max-height:20em" alt="${esc(args[0]?.file ?? "")}"></a>`;
    case "push_permission": {
      // push_permission(<action>): asks for notification permission, subscribes this browser and
      // sends the subscription to the action as (endpoint, p256dh key, auth key)
      const action = h.args[0]?.kind === "name" ? it.get("action", h.args[0].name) : undefined;
      if (!action) return "";
      return `<button type="button" class="${esc(cls(el, rc, dc("button")))}" hidden data-push-subscribe="/_do/${esc(action.name)}" data-push-params="${esc(action.params.slice(0, 3).map((p: any) => p.name).join(","))}" data-push-key="${esc(vapid.publicKey)}">${iconTag(attrVal(el, "icon", rc))}<span data-push-label>${esc(plain(attrVal(el, "label", rc) ?? "Turn on notifications"))}</span></button>`;
    }
    case "pwa_install_instructions": case "autocomplete": return "";
  }
  return "";
}

function renderScreen(d: Decl, params: Map<string, Val>, who: Who, req: Req, flash: string): string {
  const rc: RCtx = { vars: params, who, req, slots: {}, title: "", channels: [], bodyClass: new Set() };
  for (const el of d.body) {
    if (["nav", "main", "footer", "sidebar", "title", "channel"].includes(el.name)) renderEl(el, rc, []);
    else if (el.name === "if" || el.name === "let") {
      // screen-level redirect: if … { go target }
      if (el.name === "if" && it.truthy(ev(el.head, rc))) { const go = el.children.find((c) => c.name === "go"); if (go) throw { redirect: targetUrl(go.head, rc) }; }
      if (el.name === "let") renderEl(el, rc, []);
    } else rc.slots.main = (rc.slots.main ?? "") + renderEl(el, rc, []);
  }
  const layout = layouts.get(d.layout)!;
  const slot = (name: string) => rc.slots[name] ?? "";
  const customCss = theme ? plain(ev(theme.props.custom, rc)) : "";
  // theme { stylesheets [ … ] }: the app's stylesheets, served from the assets directory
  const sheets: string[] = theme?.props.stylesheets ? (ev(theme.props.stylesheets, rc) ?? []) : [];
  const css = sheets.map((n) => `<link rel="stylesheet" href="/assets/${esc(n)}">`).join("") + tokenCss(rc);
  const live = `<script>
    // Refresh whenever the server's data is newer than this page, including changes made
    // between rendering and connecting (the stream sends the current version first).
    let V = ${version}; const es = new EventSource("/_events"); let busy = false;
    es.onmessage = async (m) => { const v = Number(m.data); if (v <= V || busy || document.activeElement?.matches("textarea,input[type=text]") && document.activeElement.value) return; busy = true; V = v;
      const html = await (await fetch(location.href, { headers: { "X-Live": "1" } })).text(); const doc = new DOMParser().parseFromString(html, "text/html");
      for (const id of ["main-content", "sidebar", "nav"]) { const a = document.getElementById(id), b = doc.getElementById(id); if (a && b && !a.contains(document.activeElement)) a.innerHTML = b.innerHTML; }
      busy = false; pushState(); };
    ${rc.channels.map((c) => `fetch("/_channel/${c}/open", {method:"POST"}); setInterval(() => fetch("/_channel/${c}/every", {method:"POST"}), 50000); addEventListener("pagehide", () => navigator.sendBeacon("/_channel/${c}/close"));`).join("\n")}
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
        const text = (e.clipboardData?.getData("text") ?? "").trim(); if (!/^https?:\\/\\/\\S+$/.test(text)) return;
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
      const query = (ta) => ta.value.slice(0, ta.selectionStart).match(/@([\\w ]{0,20})$/);
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
        box.innerHTML = rows.map((n) => '<div class="${dc("picker_item")}" style="display:block;cursor:pointer" data-id="' + n.id + '">' + String(n.label).replace(/</g, "&lt;") + "</div>").join("");
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
  </script>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(rc.title || APP_NAME)}</title>${css}${customCss ? `<style>${customCss}</style>` : ""}</head>
<body class="${[...rc.bodyClass].join(" ")}">
<nav id="nav">${slot("nav")}</nav>
${flash ? `<div class="flash"><div class="flash__inner shadow">${esc(flash)}</div></div>` : ""}
<main id="main-content">${slot("main")}<footer id="footer">${slot("footer")}</footer></main>
<aside id="sidebar">${slot("sidebar")}</aside>
${live}</body></html>`;
  void layout;
}

// ---------------------------------------------------------------- routing
function matchScreen(path: string): { d: Decl; params: Record<string, string> } | null {
  for (const d of screens) {
    const names: string[] = [];
    const re = new RegExp("^" + String(d.route).replace(/:(\w+)/g, (_, n) => { names.push(n); return "([^/]+)"; }) + "$");
    const m = path.match(re);
    if (m) return { d, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
function coerce(p: any, raw: string | null | undefined): Val {
  if (raw === null || raw === undefined || raw === "") return null;
  const t = p.type.name;
  if (it.entities.has(t)) { const ref = { ref: t, id: Number(raw.replace(/^#/, "")) }; return it.store.find(ref) ? ref : null; }
  if (t === "Bool") return raw === "true" || raw === "on";
  if (t === "Int") return Number(raw);
  return raw;
}

function redirect(res: ServerResponse, to: string, headers: Record<string, string | string[]> = {}) { res.writeHead(303, { Location: to, ...headers }); res.end(); }
const flashCookie = (msg: string) => `flash=${encodeURIComponent(msg)}; Path=/; Max-Age=10`;
const OUTCOME_TEXT: Record<string, string> = { forbidden: "You can’t do that.", not_found: "Not found or inaccessible.", invalid: "That didn’t work: check what you entered.", blocked: "Too many requests or unauthorized.", unauthenticated: "Please sign in." };

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://local");
  const ctype = String(req.headers["content-type"] ?? "");
  const raw = req.method === "GET" ? Buffer.alloc(0) : await readBody(req);
  const pb = parseBody(raw, ctype);
  const r: Req = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, cookies: cookies(req), ip: clientIp(req), ua: String(req.headers["user-agent"] ?? ""), ...pb, testActor: TEST ? String(req.headers["x-test-actor"] ?? "") : "" };
  it.clock = frozenClock ?? Date.now() + clockOffset;
  it.baseUrl = `http://${req.headers.host ?? "localhost"}`;   // absolute URLs, as Rails' *_url helpers
  const who = whoIs(r);

  // static assets, files, avatars
  if (r.path.startsWith("/assets/")) return sendFile(res, findAsset(r.path.slice(8)));
  if (r.path.startsWith("/files/")) return sendUpload(res, join(dataDir, "files", basename(r.path)));
  const av = r.path.match(/^\/avatars\/(\w+)\/(\d+)$/);
  if (av) return sendAvatar(res, av[1], Number(av[2]));
  if (r.path === "/_events") { res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); res.write(`data: ${version}

`); listeners.add(res); req.on("close", () => listeners.delete(res)); return; }
  if (r.path === "/service-worker.js") { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" }); return res.end(SERVICE_WORKER); }
  if (r.path === "/up") { res.writeHead(200); return res.end("ok"); }
  if (agents.handle(r, req, res, sameOrigin(req))) return;

  // channels: presence and the like
  const ch = r.path.match(/^\/_channel\/(\w+):([^/]*)\/(open|close|every)$/);
  if (ch && r.method === "POST") {
    if (!sameOrigin(req)) { res.writeHead(403); return res.end(); }
    const d = decls("channel").find((c) => c.name === ch[1]);
    const t = d && (ch[3] === "every" ? d.every?.target : d[ch[3]]);
    if (t && who.actor) {
      const argVals = ch[2].split(",").map((s) => decodeURIComponent(s));
      const args: Record<string, unknown> = {}; const a = it.get("action", t.name)!;
      a.params.forEach((p: any, i: number) => (args[p.name] = argVals[i] === undefined ? null : Number(argVals[i]) || argVals[i]));
      const out = it.run(t.name, args, who.actor, { ip: r.ip, method: "write", identity: who.identity ?? "", cookies: r.cookies });
      if (out.outcome === "ok") { save(); changed(); void afterCommit(out.events, { ip: r.ip, method: "write", identity: "" }).catch((e) => console.error(e)); }
    }
    res.writeHead(204); return res.end();
  }

  // bot API
  for (const api of decls("api")) {
    const base = String(api.route);
    for (const route of api.routes) {
      if (route.method.toUpperCase() !== r.method) continue;
      const full = base + (route.path ? "/" + route.path : "");
      const names: string[] = [];
      const re = new RegExp("^" + full.replace(/:(\w+)/g, (_: string, n: string) => { names.push(n); return "([^/]+)"; }) + "$");
      const m = r.path.match(re); if (!m) continue;
      const p = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      return apiCall(api, route, p, r, res);
    }
  }

  // pickers: the rows a field's picker view offers for what has been typed, with labels
  if (r.path === "/_pick") {
    if (!who.actor) { res.writeHead(401); return res.end(); }
    const [body, sig] = String(r.query.get("ctx") ?? "").split(".");
    if (!body || !sig || sig.length !== mac(body).length || !timingSafeEqual(Buffer.from(sig), Buffer.from(mac(body)))) { res.writeHead(400); return res.end(); }
    const j = JSON.parse(Buffer.from(body, "base64url").toString());
    const el = elById.get(j.e);
    const rc: RCtx = { vars: new Map(j.v), who, req: r, slots: {}, title: "", channels: [], bodyClass: new Set() };
    const rows = el ? pickRows(el, rc, String(r.query.get("typed") ?? "")) : [];
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(rows.map((x) => ({ id: x.id, label: displayOf(x) }))));
  }

  // views as JSON: the permitted rows' ids (for clients and the replay driver)
  const vm = r.path.match(/^\/_view\/(\w+)$/);
  if (vm) {
    const view = it.get("view", vm[1]);
    if (!view) { res.writeHead(404); return res.end(); }
    const args: Record<string, unknown> = {};
    for (const p of view.params) { const v = r.query.get(p.name); args[p.name] = v === null || v === "" ? null : it.entities.has(p.type.name) ? Number(v) : v; }
    if (view.value?.kind === "extern") {
      // a value view that reads from outside (a fetch extern): evaluate its arguments, then await it
      if (!who.actor) { res.writeHead(401); return res.end(); }
      const ctx = { vars: new Map(Object.entries(args).map(([k, v]) => [k, v])), actor: who.actor, request: { ip: r.ip, method: "get", identity: who.identity ?? "" }, events: [], effects: [] } as any;
      const ext = it.get("extern", view.value.name);
      const argv = it.externArgs(view.value, ctx);
      const value = ext?.effect === "fetch" && EXTERNS[view.value.name] ? await EXTERNS[view.value.name](argv) : null;
      res.writeHead(value ? 200 : 204, { "Content-Type": "application/json", "X-Crudspec-Outcome": "ok" });
      return res.end(value ? JSON.stringify({ outcome: "ok", value }) : "");
    }
    const out = it.run(vm[1], args, who.actor, { ip: r.ip, method: "get", identity: who.identity ?? "", user_agent: r.ua, cookies: r.cookies });
    res.writeHead(200, { "Content-Type": "application/json", "X-Crudspec-Outcome": out.outcome });
    return res.end(JSON.stringify({ outcome: out.outcome, rows: (out.rows ?? []).map((x) => x.id), value: out.result ?? null }));
  }

  if (TEST && r.path.startsWith("/_test/")) return testEndpoint(r, res);

  // Cross-site writes are refused (CSRF), as the Rust port does; the bot API is exempt.
  if (r.method !== "GET" && !sameOrigin(req)) { res.writeHead(403); return res.end("cross-site request refused"); }

  // actions
  const act = r.path.match(/^\/_do\/(\w+)$/);
  if (act && r.method === "POST") return doAction(act[1], r, who, res);

  // screens
  const sm = matchScreen(r.path);
  if (!sm) { res.writeHead(404); return res.end("not found"); }
  const { d } = sm;
  if (!d.public && !who.actor) {
    // app { sign_in … setup … setup_when … }: where signed-out visitors go
    const base = { vars: new Map(), actor: null, request: { ip: r.ip, method: "get", identity: "" }, events: [], effects: [] } as any;
    const setupNow = appDecl?.props.setup_when ? it.truthy(it.eval(appDecl.props.setup_when, base)) : false;
    const target = setupNow ? appDecl?.props.setup?.name : appDecl?.props.sign_in?.name;
    return redirect(res, screens.find((x) => x.name === target)?.route ?? "/");
  }
  const params = new Map<string, Val>();
  for (const p of d.params) params.set(p.name, coerce(p, sm.params[p.name] ?? r.query.get(p.name)));
  const rc: RCtx = { vars: params, who, req: r, slots: {}, title: "", channels: [], bodyClass: new Set() };
  for (const q of d.requires) {
    if (!it.truthy(ev(q.cond, rc))) {
      if (q.go) return redirect(res, targetUrl(q.go, rc), q.flash ? { "Set-Cookie": flashCookie(plain(ev(q.flash, rc))) } : {});
      res.writeHead(q.outcome === "not_found" ? 404 : 403); return res.end(OUTCOME_TEXT[q.outcome] ?? q.outcome);
    }
  }
  if (d.remember) res.setHeader("Set-Cookie", `${d.remember}=${encodeURIComponent(serial(params.values().next().value))}; Path=/; Max-Age=31536000`);
  try {
    const html = renderScreen(d, params, who, r, r.cookies.flash ?? "");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...(r.cookies.flash ? { "Set-Cookie": "flash=; Path=/; Max-Age=0" } : {}) });
    res.end(html);
  } catch (e: any) {
    if (e?.redirect) return redirect(res, e.redirect);
    throw e;
  }
}

function argsFromForm(action: Decl, r: Req): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of action.params) {
    const fixed = r.body[`__arg_${p.name}`];
    let v: any = fixed !== undefined ? unserial(fixed) : r.files[p.name] ?? r.body[p.name];
    if (p.type.kind === "set") { v = Array.isArray(v) ? v.map(Number) : v?.set ?? (v ? [Number(v)] : []); }
    else if (it.entities.has(p.type.name)) v = isRef(v) ? v.id : v === undefined || v === "" ? null : Number(v);
    else if (p.type.name === "Bool") v = v === undefined ? (fixed !== undefined ? null : r.body.__bool ?? null) : v === true || v === "true" || v === "on";
    else if (p.type.name === "Int") v = v === undefined || v === "" ? null : Number(v);
    else if (p.type.name === "RichText" && typeof v === "string") {
      // keep only picked mentions whose "@Name" is still in the text
      const picked = String(r.body[`${p.name}__mentions`] ?? "").split(",").filter(Boolean).map(Number);
      const entity = String(r.body[`${p.name}__mentions_entity`] ?? "");
      const mentions = entity ? picked.filter((id) => it.store.find({ ref: entity, id }) && v.includes(`@${displayOf({ ref: entity, id })}`)) : [];
      let embeds: Val[] = [];
      try { embeds = JSON.parse(String(r.body[`${p.name}__embeds`] ?? "[]")).filter((e: any) => e && typeof e.title === "string" && typeof e.url === "string" && /^https?:\/\//.test(e.url))
        .slice(0, 4).map((e: any) => ({ title: String(e.title).slice(0, 280), url: e.url, description: String(e.description ?? "").slice(0, 560), image: typeof e.image === "string" && /^https?:\/\//.test(e.image) ? e.image : null })); } catch { embeds = []; }
      v = { rich: v, mentions: [...new Set(mentions)], entity: entity || undefined, embeds };
    }
    else if (v === undefined) v = null;
    else if (v === "" && p.type.optional && p.type.name !== "Text") v = null;
    out[p.name] = v;
  }
  return out;
}
function unserial(s: string): any {
  if (s === "") return null;
  if (s.startsWith("#")) return { ref: "?", id: Number(s.slice(1)) };
  if (s.startsWith("@")) return { set: s.slice(1).split(",").filter(Boolean).map(Number) };
  if (s === "true" || s === "false") return s === "true";
  if (s.startsWith("{")) try { return JSON.parse(s); } catch { return s; }
  return s;
}

function doAction(name: string, r: Req, who: Who, res: ServerResponse) {
  const action = it.get("action", name);
  if (!action || action.internal) { res.writeHead(404); return res.end(); }
  const args = argsFromForm(action, r);
  const out = it.run(name, args, who.actor, { ip: r.ip, method: "write", identity: who.identity ?? "", user_agent: r.ua, session_token: who.session ?? undefined, cookies: r.cookies });
  if (out.outcome === "ok") { save(); changed(); void afterCommit(out.events, { ip: r.ip, method: "write", identity: "" }).catch((e) => console.error(e)); }
  const h = handlerFrom(String(r.body.__h ?? ""));
  const back = h?.path ?? "/";
  const vars = new Map<string, Val>([...(h?.vars ?? []), ["result", out.result ?? null]]);
  const rc: RCtx = { vars, who, req: { ...r, path: back }, slots: {}, title: "", channels: [], bodyClass: new Set() };
  const headers: string[] = [];
  let to: string | null = null;
  const handler = h?.els.find((e) => e.head.outcome === out.outcome);
  for (const reaction of handler?.head.reactions ?? []) {
    if (reaction.kind === "go") { const ctx = { ...rc, vars: new Map([...vars]) }; to = targetUrl(reaction.target, ctx); }
    if (reaction.kind === "flash") headers.push(flashCookie(plain(it.eval(reaction.value, ectx(rc, vars) as any))));
    if (reaction.kind === "sign_in_as") { const s = it.eval(reaction.value, ectx(rc, vars) as any); const row = isRef(s) ? it.store.find(s) : null; if (row) headers.push(`${COOKIE}=${row.fields[SESSION_FIELD]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`); }
  }
  // An action that produces a session row signs this browser in (the spec's session identity).
  const res0 = out.result;
  if (out.outcome === "ok" && isRef(res0) && res0.ref === SESSION_ENTITY && !headers.some((h) => h.startsWith(`${COOKIE}=`))) {
    const row = it.store.find(res0); if (row) headers.push(`${COOKIE}=${row.fields[SESSION_FIELD]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }
  if (out.outcome === "ok" && who.session && !it.store.rows(SESSION_ENTITY).some((x) => x.fields[SESSION_FIELD] === who.session)) headers.push(`${COOKIE}=; Path=/; Max-Age=0`);
  res.setHeader("X-Crudspec-Outcome", out.outcome);
  // a script posting with ?fetch=1 gets the outcome itself rather than a redirect
  if (r.query.get("fetch") === "1") { res.writeHead(out.outcome === "ok" ? 204 : 422, headers.length ? { "Set-Cookie": headers } : {}); return res.end(); }
  if (out.outcome !== "ok" && !handler) headers.push(flashCookie(OUTCOME_TEXT[out.outcome] ?? out.outcome));
  return redirect(res, to ?? back, headers.length ? { "Set-Cookie": headers } : {});
}

function apiCall(api: Decl, route: any, p: Record<string, string>, r: Req, res: ServerResponse) {
  // the API's identity (api … identity <name>), from its path parameter
  const idDecl = identityDecls.find((d) => d.name === api.identity);
  const actor: Ref | null = idDecl ? resolveParamIdentity(idDecl, p[idDecl.key.name]) : null;
  const t = route.target;
  const isView = !!it.get("view", t.name);
  const decl = it.get(isView ? "view" : "action", t.name)!;
  // a path parameter has the type of the target's parameter with the same name
  const vars = new Map<string, Val>();
  for (const [k, v] of Object.entries(p)) {
    const pt = decl.params.find((x: any) => x.name === k)?.type;
    vars.set(k, pt?.kind === "named" && it.entities.has(pt.name) && /^\d+$/.test(v) ? { ref: pt.name, id: Number(v) } : v);
  }
  const rc: RCtx = { vars, who: { actor, session: null, identity: actor ? api.identity : undefined }, req: r, slots: {}, title: "", channels: [], bodyClass: new Set() };
  const reqVal = { text: r.text, ip: r.ip };
  const args: Record<string, unknown> = {};
  decl.params.forEach((pp: any, i: number) => {
    const a = t.args[i] ?? t.named[pp.name];
    let v: Val = a ? it.eval(a, { ...ectx(rc), vars: new Map([...vars, ["request", reqVal], ["query", Object.fromEntries(r.query)]]) } as any) : null;
    if (v && typeof v === "object" && "rich" in v) v = v.rich;
    args[pp.name] = isRef(v) ? v.id : v;
  });
  const out = it.run(t.name, args, actor, { ip: r.ip, method: isView ? "get" : "write", identity: actor ? api.identity : "", text: r.text }, api.skips ?? []);
  const status = { ok: route.status ?? 200, forbidden: 403, not_found: 404, invalid: 422, blocked: 429, unauthenticated: 401 }[out.outcome] ?? 500;
  if (out.outcome === "ok" && !isView) { save(); changed(); void afterCommit(out.events, { ip: r.ip, method: "write", identity: "" }).catch((e) => console.error(e)); }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let body = "";
  if (out.outcome === "ok" && route.json) {
    const fn = it.get("fn", route.json)!;
    const shape = (v: Val) => it.eval(fn.body, { ...ectx(rc), vars: new Map([[fn.params[0].name, v]]) } as any);
    body = JSON.stringify(isView ? (out.rows ?? []).map(shape) : shape(out.result));
  }
  res.writeHead(status, headers); res.end(body);
}

// ---------------------------------------------------------------- test endpoints (--test only)
// Generic: reset to an empty store, advance the clock, read max ids, evaluate a spec function.
// App-specific: building a scenario's setup and normalizing state come from the app's
// harness module (--harness <file>), which exports { reset(it, setup), name(kind, key, id), state(it, body) }.
type Harness = { reset: (it: Interpreter, setup: unknown) => unknown; name?: (kind: string, key: string, id: number) => void; state: (it: Interpreter, body: any) => unknown };
let harness: Harness | null = null;
const harnessPath = opt("--harness", "");
if (TEST && harnessPath) harness = (await import(pathToFileURL(harnessPath).href)).default as Harness;
async function testEndpoint(r: Req, res: ServerResponse) {
  const json = (v: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
  const body = r.text ? JSON.parse(r.text) : {};
  switch (r.path) {
    case "/_test/reset": {
      const fresh = new Store();
      for (const d of spec.decls) if (d.kind === "data") { fresh.tables.set(d.name, it.store.rows(d.name)); fresh.nextId.set(d.name, it.store.nextId.get(d.name) ?? 1); }
      it.store = fresh; it.counters = new Map(); clockOffset = 0; frozenClock = null; it.clock = Date.now();
      sqlite.clear();
      const out = harness ? harness.reset(it, body.setup) : {};
      // the runtime hashes passwords; a harness may write them plainly
      for (const [name, ent] of it.entities) for (const f of ent.fields ?? []) if (f.type.kind === "named" && f.type.name === "Password")
        for (const row of it.store.rows(name)) if (row.fields[f.name]?.password !== undefined) row.fields[f.name] = it.hooks.hash(row.fields[f.name].password);
      clockOffset = it.clock - Date.now() + 1;   // time continues from where setup left it
      save();
      return json(out);
    }
    // A fixture for any app, through its own rules: rows created as the spec's `create` would
    // (defaults, keys, triggers), then actions run as named actors. "$name" refers to a saved row.
    // { clock?, rows: [{entity, fields, save?}], steps: [{as?, call, args, save?, entity?}] }
    case "/_test/fixture": {
      const fresh = new Store();
      for (const d of spec.decls) if (d.kind === "data") { fresh.tables.set(d.name, it.store.rows(d.name)); fresh.nextId.set(d.name, it.store.nextId.get(d.name) ?? 1); }
      it.store = fresh; it.counters = new Map(); fixedTokens = 1;
      it.clock = Number(body.clock ?? Date.UTC(2026, 0, 15, 15, 0, 0)); clockOffset = it.clock - Date.now();
      sqlite.clear();
      const keys: Record<string, Ref> = {};
      const resolve = (v: any): any => typeof v === "string" && v.startsWith("$") ? (keys[v.slice(1)] ?? (() => { throw new Error(`unknown fixture name ${v}`); })()) : Array.isArray(v) ? v.map(resolve) : v;
      const idOf = (v: any): any => (v && typeof v === "object" && "ref" in v ? v.id : Array.isArray(v) ? v.map(idOf) : v);
      try {
        for (const row of body.rows ?? []) {
          const ent = it.entities.get(row.entity); if (!ent) throw new Error(`unknown entity ${row.entity}`);
          const fields = Object.entries(row.fields ?? {}).map(([name, v]) => ({ name, value: { kind: "lit", value: it.store_value(ent, name, resolve(v)) } }));
          const ctx = { vars: new Map(), actor: null, request: { ip: "203.0.113.1", method: "write", identity: "" }, events: [], effects: [] } as any;
          it.exec([{ kind: "create", entity: row.entity, fields, as: "__row" } as any], ctx);
          if (row.save) keys[row.save] = ctx.vars.get("__row");
          it.advance(1000);
        }
        for (const [i, st] of (body.steps ?? []).entries()) {
          const actor = st.as ? keys[st.as] : null;
          if (st.as && !actor) throw new Error(`step ${i + 1}: unknown actor ${st.as}`);
          const args = Object.fromEntries(Object.entries(st.args ?? {}).map(([k, v]) => [k, idOf(resolve(v))]));
          const before = st.entity ? Math.max(0, ...it.store.rows(st.entity).map((x) => x.id)) : 0;
          const out = it.run(st.call, args, actor, { ip: "203.0.113.1", method: "write", identity: sessionIdentity?.name ?? "" });
          if (out.outcome !== "ok") throw new Error(`step ${i + 1} (${st.call} as ${st.as ?? "anonymous"}): ${out.outcome} ${out.detail ?? ""}`);
          if (st.save) {
            const made = st.entity ? it.store.rows(st.entity).filter((x) => x.id > before).at(-1) : undefined;
            keys[st.save] = made ? { ref: st.entity, id: made.id } : out.result;
            if (!keys[st.save]) throw new Error(`step ${i + 1}: nothing to save as ${st.save}; give "entity"`);
          }
          it.advance(60_000);
        }
      } catch (e) { fixedTokens = 0; return json({ error: (e as Error).message }, 422); }
      fixedTokens = 0;
      frozenClock = it.clock;
      save(); changed();
      return json({ keys });
    }
    case "/_test/name": harness?.name?.(body.kind, body.key, body.id); return json({});
    case "/_test/state": return json(harness ? harness.state(it, body) : {});
    case "/_test/clock": clockOffset += Number(body.advance_ms ?? 0); if (frozenClock !== null) frozenClock += Number(body.advance_ms ?? 0); return json({ offset: clockOffset });
    case "/_test/maxid": return json({ id: Math.max(0, ...it.store.rows(body.entity).map((x) => x.id)) });
    case "/_test/fn": {
      const fn = it.get("fn", body.name)!;
      const vars = new Map<string, Val>(fn.params.map((p: any, i: number) => [p.name, body.refs?.[i] ? { ref: body.refs[i][0], id: body.refs[i][1] } : body.args?.[i] ?? null]));
      return json({ value: it.eval(fn.body, { vars, actor: null, request: { ip: "", method: "get", identity: "" }, events: [], effects: [] } as any) });
    }
  }
  res.writeHead(404); res.end();
}

// ---------------------------------------------------------------- files
// The assets directory is indexed once, whatever its layout: a name (or a path inside it) finds its file.
const assetIndex = new Map<string, string>();
(function index(dir: string, rel: string) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, f.name), r2 = rel ? `${rel}/${f.name}` : f.name;
    if (f.isDirectory()) index(full, r2);
    else { assetIndex.set(r2, full); if (!assetIndex.has(f.name)) assetIndex.set(f.name, full); }
  }
})(assetDir, "");
function findAsset(name: string): string {
  const clean = name.replace(/^\/+/, "");
  if (clean.split("/").includes("..")) return "";
  return assetIndex.get(clean) ?? assetIndex.get(basename(clean)) ?? "";
}
const MIME: Record<string, string> = { ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".mp3": "audio/mpeg", ".js": "text/javascript" };
// Uploaded files: only raster images, audio and video are shown inline; anything else
// (SVG, HTML, …) is downloaded, so an upload can never run script on this origin.
const INLINE_UPLOADS: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp3": "audio/mpeg", ".mp4": "video/mp4" };
function sendUpload(res: ServerResponse, path: string) {
  if (!existsSync(path) || !statSync(path).isFile()) { res.writeHead(404); return res.end(); }
  const inline = INLINE_UPLOADS[extname(path).toLowerCase()];
  res.writeHead(200, { "Content-Type": inline ?? "application/octet-stream", "X-Content-Type-Options": "nosniff",
    "Content-Disposition": inline ? "inline" : "attachment", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, max-age=300" });
  createReadStream(path).pipe(res);
}
function sameOrigin(req: IncomingMessage): boolean {
  const site = String(req.headers["sec-fetch-site"] ?? "");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin && origin !== "null") { try { return new URL(origin).host === req.headers.host; } catch { return false; } }
  return true;
}
function sendFile(res: ServerResponse, path: string) {
  if (!path || !existsSync(path) || !statSync(path).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream", "Cache-Control": "max-age=300" });
  createReadStream(path).pipe(res);
}
// avatar <Entity>: <expr> — a stored file, an image asset name, or text drawn as initials
const avatars = new Map(decls("avatar").map((d) => [d.entity, d.value]));
function sendAvatar(res: ServerResponse, entity: string, id: number) {
  const row = it.store.find({ ref: entity, id }); const e = avatars.get(entity);
  if (!row || !e) { res.writeHead(404); return res.end(); }
  const v = it.eval(e, { vars: new Map(), actor: null, request: { ip: "", method: "get", identity: "" }, events: [], effects: [], row: { entity, row } } as any);
  if (v && typeof v === "object" && v.stored) return sendUpload(res, join(dataDir, "files", v.stored));
  const text = plain(v);
  if (/\.(svg|png|webp|jpe?g|gif)$/i.test(text)) return sendFile(res, findAsset(text));
  const initials = text.trim().slice(0, 3).toUpperCase() || "?";   // the spec gives the text, e.g. initials(.name)
  const hue = (id * 47) % 360;
  res.writeHead(200, { "Content-Type": "image/svg+xml" });
  res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="hsl(${hue} 55% 55%)"/><text x="50%" y="50%" fill="white" font-family="system-ui,sans-serif" font-size="230" font-weight="600" dominant-baseline="central" text-anchor="middle">${esc(initials)}</text></svg>`);
}

function snake(s: string) { return s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(); }

createServer((req, res) => { handle(req, res).catch((e) => { if (e?.status) { res.writeHead(e.status); return res.end(); } console.error(e); if (!res.headersSent) res.writeHead(500); res.end("server error"); }); })
  .listen(port, "127.0.0.1", () => console.log(`crudspec runtime: ${specPath} on http://127.0.0.1:${port} (data ${dataDir})`));

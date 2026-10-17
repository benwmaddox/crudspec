// Runs oracle scenarios (the v1 format, plus v2 actions) against a v2 spec, and compares
// with Rails golden files. v1 actions map onto their v2 forms: sign_in takes the actor's
// email and the fixture password; join adds the password; become_present is present.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Interpreter, type Ref, type Val } from "../../../lang/interp.ts";
import type { Spec } from "../../../lang/parser.ts";

type Json = any;
export const PASSWORD = "oracle-password-1";   // the oracle's synthetic fixture password

export class Keys {
  by = new Map<string, Map<string, number>>();
  set(kind: string, key: string, id: number) { if (!this.by.has(kind)) this.by.set(kind, new Map()); this.by.get(kind)!.set(key, id); }
  id(kind: string, key: string) { const v = this.by.get(kind)?.get(key); if (v === undefined) throw new Error(`unknown ${kind} key ${key}`); return v; }
  has(kind: string, key: string) { return this.by.get(kind)?.has(key) ?? false; }
  key(kind: string, id: number) { for (const [k, v] of this.by.get(kind) ?? []) if (v === id) return k; return `${kind}#${id}`; }
}

export const KIND: Record<string, string> = { User: "user", Room: "room", Message: "message", Boost: "boost", Search: "search", PushSubscription: "push" };
export const CREATES: Record<string, string> = { create_open_room: "Room", create_closed_room: "Room", create_direct_room: "Room", post_message: "Message", boost: "Boost", join: "User", create_bot: "User", first_run: "User" };
export const RENAME: Record<string, string> = { become_present: "present", list_messages: "room_messages",
  bot_post: "post_message", bot_edit: "edit_message", bot_delete: "delete_message", bot_boost: "boost", bot_ui_post: "post_message" };
export const ANONYMOUS = new Set(["join", "sign_in", "first_run", "transfer_session"]);

export function setup(it: Interpreter, s: Json, keys: Keys) {
  const st = it.store, now = it.clock;
  if (s.empty) return;   // first-run scenarios start with no account
  const acct = s.account ?? {};
  st.insert("Account", { name: acct.name ?? "Oracle", join_code: acct.join_code ?? "JOIN-CODE", logo: null, custom_styles: null, restrict_room_creation: acct.restrict_room_creation ?? false }, now);
  const user = (k: string): Ref => ({ ref: "User", id: keys.id("user", k) });
  for (const u of s.users) {
    const row = st.insert("User", { name: u.name, email: u.email ?? null, password: { password: PASSWORD }, bio: u.bio ?? null, avatar: null, role: u.role ?? "member", status: "active", bot_token: u.bot_token ?? null }, now);
    keys.set("user", u.key, row.id);
    if (u.webhook_url) st.insert("Webhook", { user: { ref: "User", id: row.id }, url: u.webhook_url }, now);
  }
  for (const r of s.rooms ?? []) {
    const row = st.insert("Room", { type: r.type, name: r.name ?? null, creator: user(r.creator) }, now);
    keys.set("room", r.key, row.id);
    for (const m of r.members) {
      const spec = typeof m === "string" ? { user: m } : m;
      st.insert("Membership", { room: { ref: "Room", id: row.id }, user: user(spec.user), involvement: spec.involvement ?? (r.type === "direct" ? "everything" : "mentions"),
        unread_since: null, connected_at: spec.connected ? now : null, connections: spec.connected ? 1 : 0 }, now);
    }
  }
  for (const m of s.messages ?? []) {
    it.advance(1);
    const row = st.insert("Message", { room: { ref: "Room", id: keys.id("room", m.room) }, creator: user(m.creator), body: { rich: m.body, mentions: [] }, attachment: null, client_id: `c${m.key}` }, it.clock);
    keys.set("message", m.key, row.id);
  }
  for (const b of s.boosts ?? []) {
    const row = st.insert("Boost", { message: { ref: "Message", id: keys.id("message", b.message) }, booster: user(b.booster), content: b.content }, it.clock);
    keys.set("boost", b.key, row.id);
  }
  for (const q of s.searches ?? []) { it.advance(1000); st.insert("Search", { user: user(q.user), query: q.query }, it.clock); }
  for (const u of s.unread ?? []) {
    const m = st.rows("Membership").find((r) => r.fields.room.id === keys.id("room", u.room) && r.fields.user.id === keys.id("user", u.user));
    if (m) m.fields.unread_since = { time: it.clock, seq: 0 };
  }
  for (const u of s.users) if (u.ip) st.insert("Session", { user: user(u.key), token: `session-${u.key}`, ip: u.ip, user_agent: "oracle", last_active: { time: now, seq: 0 } }, now);
  // The oracle signs each of these users in through the real endpoint, and those requests
  // count against sign_in's rate limit: record them the same way.
  const limit = (it.get("action", "sign_in")?.body ?? []).find((x: any) => x.kind === "rate_limit");
  if (limit) for (const u of s.users) if (u.ip) { const key = `${limit.pos.line}:${u.ip}`; it.counters.set(key, [...(it.counters.get(key) ?? []), now]); }
}

export function normalized(it: Interpreter, keys: Keys, v2 = false, setupTokens: Map<number, string | null> = new Map()): Json {
  const base = normalizedV1(it, keys);
  if (!v2) return base;
  const s = it.store;
  const k = (kind: string, v: Val) => keys.key(kind, (v as Ref).id);
  const acct = s.rows("Account")[0];
  const searches: Record<string, string[]> = {};
  for (const r of [...s.rows("Search")].sort((a, b) => a.fields.user.id - b.fields.user.id || b.updated - a.updated || b.id - a.id)) (searches[k("user", r.fields.user)] ??= []).push(r.fields.query);
  return {
    ...base,
    account_settings: acct ? { name: acct.fields.name, custom_styles: acct.fields.custom_styles, join_code_reset: acct.fields.join_code !== "JOIN-CODE" } : null,
    profiles: s.rows("User").map((r) => ({ key: keys.key("user", r.id), bio: r.fields.bio, email: String(r.fields.email ?? "").includes("-deactivated-") ? "deactivated" : r.fields.email,
      bot_token_reset: r.fields.role === "bot" ? r.fields.bot_token !== (setupTokens.get(r.id) ?? null) : null })),
    webhooks: [...s.rows("Webhook")].sort((a, b) => a.fields.user.id - b.fields.user.id).map((r) => ({ user: k("user", r.fields.user), url: r.fields.url })),
    searches: Object.fromEntries(Object.entries(searches).sort(([a], [b]) => (a < b ? -1 : 1))),
    push_subscriptions: [...s.rows("PushSubscription")].sort((a, b) => a.fields.user.id - b.fields.user.id || a.id - b.id).map((r) => ({ user: k("user", r.fields.user), endpoint: r.fields.endpoint })),
  };
}

function normalizedV1(it: Interpreter, keys: Keys): Json {
  const s = it.store;
  const k = (kind: string, v: Val) => keys.key(kind, (v as Ref).id);
  const acct = s.rows("Account")[0];
  return {
    account: acct ? { restrict_room_creation: acct.fields.restrict_room_creation } : null,
    users: s.rows("User").map((r) => ({ key: keys.key("user", r.id), name: r.fields.name, role: r.fields.role, status: r.fields.status, email_deactivated: String(r.fields.email ?? "").includes("-deactivated-") })),
    rooms: s.rows("Room").map((r) => ({ key: keys.key("room", r.id), type: r.fields.type, name: r.fields.name, creator: k("user", r.fields.creator) })),
    memberships: [...s.rows("Membership")].sort((a, b) => a.fields.room.id - b.fields.room.id || a.fields.user.id - b.fields.user.id)
      .map((r) => ({ room: k("room", r.fields.room), user: k("user", r.fields.user), involvement: r.fields.involvement, unread: r.fields.unread_since !== null })),
    messages: s.rows("Message").map((r) => ({ key: keys.key("message", r.id), room: k("room", r.fields.room), creator: k("user", r.fields.creator), body: it.plain(r.fields.body) })),
    boosts: s.rows("Boost").map((r) => ({ key: keys.key("boost", r.id), message: k("message", r.fields.message), booster: k("user", r.fields.booster), content: r.fields.content })),
    bans: [...s.rows("Ban")].sort((a, b) => a.fields.user.id - b.fields.user.id || String(a.fields.ip).localeCompare(String(b.fields.ip))).map((r) => ({ user: k("user", r.fields.user), ip: r.fields.ip })),
    sessions: Object.fromEntries(Object.entries(s.rows("Session").reduce((acc: Record<string, number>, r) => { const key = k("user", r.fields.user); acc[key] = (acc[key] ?? 0) + 1; return acc; }, {})).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

export function argsFor(it: Interpreter, name: string, action: Json, keys: Keys, users: Record<string, Json>): Record<string, unknown> {
  const d = it.get("action", name) ?? it.get("view", name);
  if (!d) throw new Error(`spec has no action ${name}`);
  const out: Record<string, unknown> = {};
  for (const p of d.params) {
    let raw = action[p.name];
    if (name === "sign_in" && p.name === "email") raw = users[action.actor]?.email;
    if (name === "transfer_session" && p.name === "link") raw = action.link ?? signedFor(it, keys.id("user", action.user));
    if ((name === "sign_in" || name === "join" || name === "first_run") && p.name === "password") raw = action.password ?? PASSWORD;
    if (raw === undefined || raw === null) { out[p.name] = null; continue; }
    if (p.type.kind === "set") { out[p.name] = (raw as string[]).map((key) => keys.has(KIND[p.type.of], key) ? keys.id(KIND[p.type.of], key) : -1); continue; }
    const kind = KIND[p.type.name];
    out[p.name] = kind ? (keys.has(kind, raw) ? keys.id(kind, raw) : 999999) : raw;
  }
  return out;
}

// The transfer link the interpreter would hand this user now (fn transfer_link).
export function signedFor(it: Interpreter, userId: number): string {
  const fn = it.get("fn", "transfer_link")!;
  return it.eval(fn.body, { vars: new Map([["u", { ref: "User", id: userId }]]), actor: null, request: { ip: "", method: "write", identity: "" }, events: [], effects: [] } as any);
}

export type Diff = { scenario: string; where: string; expected: unknown; actual: unknown };

export function runScenario(spec: Spec, scenario: Json, golden: Json): Diff[] {
  const it = new Interpreter(spec);
  const keys = new Keys();
  setup(it, scenario.setup, keys);
  const v2 = scenario.v2 === true;
  const setupTokens = new Map(it.store.rows("User").map((r) => [r.id, r.fields.bot_token]));
  const diffs: Diff[] = [];
  const cmp = (where: string, e: any, a: any) => {
    if (JSON.stringify(e) === JSON.stringify(a)) return;
    // State: report each differing top-level key separately.
    if ((where === "initial" || where === "final") && e && a && typeof e === "object") {
      for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) if (JSON.stringify(e[key]) !== JSON.stringify(a[key])) diffs.push({ scenario: scenario.id, where: `${where}.${key}`, expected: e[key], actual: a[key] });
      return;
    }
    diffs.push({ scenario: scenario.id, where, expected: e, actual: a });
  };
  cmp("initial", golden.initial, normalized(it, keys, v2, setupTokens));
  const users: Record<string, Json> = Object.fromEntries((scenario.setup.users ?? []).map((u: Json) => [u.key, u]));
  golden.results.forEach((res: Json, i: number) => {
    const action = res.action;
    const name = RENAME[action.do] ?? action.do;
    it.advance(1000);
    if (action.do === "wait") { it.advance(action.seconds * 1000); cmp(`action ${i + 1} wait`, res.outcome, "ok"); return; }
    const viaBot = action.do.startsWith("bot_");
    const ip = action.ip ?? users[action.actor]?.ip ?? "203.0.113.250";
    // The actor is signed in only if they hold a session; sign_in and join act anonymously.
    let actor: Ref | null = null;
    if (viaBot) {
      // The bot API identifies a bot by "<id>-<token>" in the path.
      const bot = it.store.rows("User").find((r) => r.id === keys.id("user", action.actor))!;
      const key = action.bot_key ?? `${bot.id}-${bot.fields.bot_token}`;
      const [id, tok] = String(key).split("-");
      const match = it.store.rows("User").find((r) => r.id === Number(id) && r.fields.bot_token === tok && r.fields.role === "bot" && r.fields.status === "active");
      if (match) actor = { ref: "User", id: match.id };
    } else if (action.actor && !ANONYMOUS.has(name)) {
      const uid = keys.id("user", action.actor);
      if (it.store.rows("Session").some((s) => s.fields.user.id === uid)) actor = { ref: "User", id: uid };
    }
    const before = (it.store.nextId.get(CREATES[name] ?? "") ?? 1) - 1;
    const isView = !!it.get("view", name);
    // The browser presents the actor's session cookie; the bot API skips deny_bots, a bot key on a web form doesn't.
    const sessionToken = actor && !viaBot ? it.store.rows("Session").find((x) => x.fields.user.id === actor!.id)?.fields.token : undefined;
    const r = it.run(name, argsFor(it, name, action, keys, users), actor, { ip, method: isView ? "get" : "write", identity: viaBot && actor ? "bot_key" : actor ? "session" : "", user_agent: "oracle", session_token: sessionToken },
      viaBot && action.do !== "bot_ui_post" ? ["deny_bots"] : []);
    if (name === "first_run" && r.outcome === "ok" && !keys.has("room", "all_talk")) { const room = it.store.rows("Room")[0]; if (room) keys.set("room", "all_talk", room.id); }
    if (action.as && CREATES[name]) {
      const ent = CREATES[name];
      const newest = it.store.rows(ent).filter((row) => row.id > before).at(-1);
      if (newest) keys.set(KIND[ent], action.as, newest.id);
      if (newest && name === "join") users[action.as] = { key: action.as, ip, email: action.email };
    }
    cmp(`action ${i + 1} ${action.do} by ${action.actor}: outcome`, res.outcome, r.outcome);
    if (res.rows !== undefined) cmp(`action ${i + 1} ${action.do}: rows`, res.rows, (r.rows ?? []).map((ref) => keys.key("message", ref.id)));
  });
  cmp("final", golden.final, normalized(it, keys, v2, setupTokens));
  return diffs;
}

export function runAll(spec: Spec, scenarioDir: string, goldenDir: string) {
  const diffs: Diff[] = []; let total = 0, failed = 0;
  for (const f of readdirSync(goldenDir).filter((f) => f.endsWith(".json")).sort()) {
    const golden = JSON.parse(readFileSync(join(goldenDir, f), "utf8"));
    const scenario = JSON.parse(readFileSync(join(scenarioDir, f), "utf8"));
    total++;
    let d: Diff[];
    try { d = runScenario(spec, scenario, golden); } catch (e) { d = [{ scenario: scenario.id, where: "crash", expected: null, actual: String((e as Error).stack ?? e).split("\n").slice(0, 3).join(" | ") }]; }
    if (d.length) { failed++; diffs.push(...d); }
  }
  return { total, failed, diffs };
}

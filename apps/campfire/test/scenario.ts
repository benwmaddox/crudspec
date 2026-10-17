// Oracle scenarios (the v1 format, plus v2 actions) for a v2 spec: setups, arguments and
// normalized state, for the replay against the compiled app (replay-runtime.ts). v1 actions map onto their v2 forms: sign_in takes the actor's
// email and the fixture password; join adds the password; become_present is present.
import type { Decl, Spec } from "../../../lang/parser.ts";
import { Store, type Ref, type Val } from "../../../lang/rows.ts";

// What a setup builds rows in, and what normalizing reads: plain rows (world()); the compiled
// app runs the actions.
export type World = { store: Store; clock: number; advance(ms: number): void; counters: Map<string, number[]>; get(kind: string, name: string): any; entities: Map<string, Decl>; plain(v: Val): string };
export function world(spec: Spec): World {
  const decls = new Map(spec.decls.filter((d: any) => d.name).map((d: any) => [`${d.kind}:${d.name}`, d]));
  return { store: new Store(), clock: Date.UTC(2026, 0, 1), advance(ms) { this.clock += ms; }, counters: new Map(), get: (k, n) => decls.get(`${k}:${n}`),
    entities: new Map(spec.decls.filter((d: any) => d.kind === "entity" || d.kind === "data").map((d: any) => [d.name, d])),
    plain: (v) => v === null || v === undefined ? "" : typeof v === "object" && "rich" in v ? v.rich : String(v) };
}

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

export function setup(it: World, s: Json, keys: Keys) {
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
    if (m) { m.fields.unread_since = { time: it.clock, seq: 0 }; st.save("Membership", m, ["unread_since"]); }
  }
  for (const u of s.users) if (u.ip) st.insert("Session", { user: user(u.key), token: `session-${u.key}`, ip: u.ip, user_agent: "oracle", last_active: { time: now, seq: 0 } }, now);
  // The oracle signs each of these users in through the real endpoint, and those requests
  // count against sign_in's rate limit: record them the same way.
  const limit = (it.get("action", "sign_in")?.body ?? []).find((x: any) => x.kind === "rate_limit");
  if (limit) for (const u of s.users) if (u.ip) { const key = `${limit.pos.line}:${u.ip}`; it.counters.set(key, [...(it.counters.get(key) ?? []), now]); }
}

export function normalized(it: World, keys: Keys, v2 = false, setupTokens: Map<number, string | null> = new Map()): Json {
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

function normalizedV1(it: World, keys: Keys): Json {
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

export function argsFor(it: World, name: string, action: Json, keys: Keys, users: Record<string, Json>): Record<string, unknown> {
  const d = it.get("action", name) ?? it.get("view", name);
  if (!d) throw new Error(`spec has no action ${name}`);
  const out: Record<string, unknown> = {};
  for (const p of d.params) {
    let raw = action[p.name];
    if (name === "sign_in" && p.name === "email") raw = users[action.actor]?.email;
    if (name === "transfer_session" && p.name === "link") raw = action.link;   // the replay asks the app for it (/_test/fn transfer_link)
    if ((name === "sign_in" || name === "join" || name === "first_run") && p.name === "password") raw = action.password ?? PASSWORD;
    if (raw === undefined || raw === null) { out[p.name] = null; continue; }
    if (p.type.kind === "set") { out[p.name] = (raw as string[]).map((key) => keys.has(KIND[p.type.of], key) ? keys.id(KIND[p.type.of], key) : -1); continue; }
    const kind = KIND[p.type.name];
    out[p.name] = kind ? (keys.has(kind, raw) ? keys.id(kind, raw) : 999999) : raw;
  }
  return out;
}

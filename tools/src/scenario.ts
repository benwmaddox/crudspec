// Runs oracle scenarios against a spec with the reference interpreter, and compares
// outcomes and normalized state with the Rails golden files (oracle/golden/<run>/<id>.json).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Interpreter, type Ref, type Val } from "./interp.ts";
import type { Spec } from "./ast.ts";

type Json = any;

class Keys {
  byKind = new Map<string, Map<string, number>>();
  set(kind: string, key: string, id: number) { if (!this.byKind.has(kind)) this.byKind.set(kind, new Map()); this.byKind.get(kind)!.set(key, id); }
  id(kind: string, key: string): number { const id = this.byKind.get(kind)?.get(key); if (id === undefined) throw new Error(`unknown ${kind} key ${key}`); return id; }
  key(kind: string, id: number): string { for (const [k, v] of this.byKind.get(kind) ?? []) if (v === id) return k; return `${kind}#${id}`; }
}

const ENTITY_KIND: Record<string, string> = { User: "user", Room: "room", Message: "message", Boost: "boost" };
const CREATES: Record<string, string> = { create_open_room: "Room", create_closed_room: "Room", create_direct_room: "Room", post_message: "Message", boost: "Boost", join: "User" };

function buildSetup(it: Interpreter, setup: Json, keys: Keys) {
  const s = it.store;
  const acct = setup.account ?? {};
  s.insert("Account", { join_code: acct.join_code ?? "JOIN-CODE", restrict_room_creation: acct.restrict_room_creation ?? false });
  for (const u of setup.users) {
    const row = s.insert("User", { name: u.name, email: u.email, email_deactivated: false, role: u.role ?? "member", status: "active" });
    keys.set("user", u.key, row.id);
  }
  const user = (k: string): Ref => ({ ref: "User", id: keys.id("user", k) });
  for (const r of setup.rooms ?? []) {
    const row = s.insert("Room", { type: r.type, name: r.name ?? null, creator: user(r.creator) });
    keys.set("room", r.key, row.id);
    for (const m of r.members) {
      const spec = typeof m === "string" ? { user: m } : m;
      s.insert("Membership", { room: { ref: "Room", id: row.id }, user: user(spec.user), involvement: spec.involvement ?? (r.type === "direct" ? "everything" : "mentions"), unread: false, connected: false });
    }
  }
  for (const m of setup.messages ?? []) {
    const row = s.insert("Message", { room: { ref: "Room", id: keys.id("room", m.room) }, creator: user(m.creator), body: m.body });
    keys.set("message", m.key, row.id);
  }
  for (const b of setup.boosts ?? []) {
    const row = s.insert("Boost", { message: { ref: "Message", id: keys.id("message", b.message) }, booster: user(b.booster), content: b.content });
    keys.set("boost", b.key, row.id);
  }
  for (const u of setup.unread ?? []) {
    const m = s.rows("Membership").find((r) => (r.fields.room as Ref).id === keys.id("room", u.room) && (r.fields.user as Ref).id === keys.id("user", u.user));
    if (m) m.fields.unread = true;
  }
  for (const u of setup.users) if (u.ip) s.insert("Session", { user: user(u.key), ip: u.ip });
}

export function normalized(it: Interpreter, keys: Keys): Json {
  const s = it.store;
  const k = (kind: string, v: Val) => keys.key(kind, (v as Ref).id);
  const acct = s.rows("Account")[0];
  return {
    account: acct ? { restrict_room_creation: acct.fields.restrict_room_creation } : null,
    users: s.rows("User").map((r) => ({ key: k("user", { ref: "User", id: r.id }), name: r.fields.name, role: r.fields.role, status: r.fields.status, email_deactivated: r.fields.email_deactivated })),
    rooms: s.rows("Room").map((r) => ({ key: k("room", { ref: "Room", id: r.id }), type: r.fields.type, name: r.fields.name, creator: k("user", r.fields.creator) })),
    memberships: [...s.rows("Membership")]
      .sort((a, b) => (a.fields.room as Ref).id - (b.fields.room as Ref).id || (a.fields.user as Ref).id - (b.fields.user as Ref).id)
      .map((r) => ({ room: k("room", r.fields.room), user: k("user", r.fields.user), involvement: r.fields.involvement, unread: r.fields.unread })),
    messages: s.rows("Message").map((r) => ({ key: k("message", { ref: "Message", id: r.id }), room: k("room", r.fields.room), creator: k("user", r.fields.creator), body: r.fields.body })),
    boosts: s.rows("Boost").map((r) => ({ key: k("boost", { ref: "Boost", id: r.id }), message: k("message", r.fields.message), booster: k("user", r.fields.booster), content: r.fields.content })),
    bans: [...s.rows("Ban")]
      .sort((a, b) => (a.fields.user as Ref).id - (b.fields.user as Ref).id || String(a.fields.ip).localeCompare(String(b.fields.ip)))
      .map((r) => ({ user: k("user", r.fields.user), ip: r.fields.ip })),
    sessions: Object.fromEntries(
      Object.entries(s.rows("Session").reduce((acc: Record<string, number>, r) => { const key = k("user", r.fields.user); acc[key] = (acc[key] ?? 0) + 1; return acc; }, {}))
        .sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

function args(it: Interpreter, action: Json, keys: Keys): Record<string, unknown> {
  const decl = it.actions.get(action.do) ?? it.views.get(action.do);
  if (!decl) throw new Error(`spec has no action ${action.do}`);
  const out: Record<string, unknown> = {};
  for (const p of decl.params) {
    // sign_in's user is the actor signing in.
    const raw = action.do === "sign_in" && p.name === "user" ? action.actor : action[p.name];
    if (raw === undefined || raw === null) { out[p.name] = null; continue; }
    if (p.type.kind === "set") { out[p.name] = (raw as string[]).map((key) => keys.id(ENTITY_KIND[p.type.of] ?? p.type.of.toLowerCase(), key)); continue; }
    const kind = ENTITY_KIND[p.type.name];
    out[p.name] = kind ? keys.id(kind, raw) : raw;
  }
  return out;
}

export type Diff = { scenario: string; where: string; expected: unknown; actual: unknown };

export function runScenario(spec: Spec, scenario: Json, golden: Json): Diff[] {
  const it = new Interpreter(spec);
  const keys = new Keys();
  buildSetup(it, scenario.setup, keys);
  const diffs: Diff[] = [];
  const cmp = (where: string, expected: unknown, actual: unknown) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) diffs.push({ scenario: scenario.id, where, expected, actual });
  };
  cmp("initial", golden.initial, normalized(it, keys));
  const users = Object.fromEntries(scenario.setup.users.map((u: Json) => [u.key, u]));
  golden.results.forEach((res: Json, i: number) => {
    const action = res.action;
    const actor = action.actor && action.do !== "join" ? { ref: "User", id: keys.id("user", action.actor) } : null;
    const ip = action.ip ?? users[action.actor]?.ip ?? "203.0.113.250";
    const before = (it.store.nextId.get(CREATES[action.do] ?? "") ?? 1) - 1;
    const isView = it.views.has(action.do);
    const r = it.run(action.do, args(it, action, keys), actor, { ip, method: isView ? "get" : "write" });
    if (action.as && CREATES[action.do]) {
      const ent = CREATES[action.do];
      const newest = it.store.rows(ent).filter((row) => row.id > before).at(-1);
      if (newest) keys.set(ENTITY_KIND[ent], action.as, newest.id);
      if (newest && action.do === "join") users[action.as] = { key: action.as, ip };
    }
    cmp(`action ${i + 1} ${action.do} by ${action.actor}: outcome`, res.outcome, r.outcome);
    if (res.rows !== undefined) cmp(`action ${i + 1} ${action.do}: rows`, res.rows, (r.rows ?? []).map((ref) => keys.key("message", ref.id)));
  });
  cmp("final", golden.final, normalized(it, keys));
  return diffs;
}

// Runs a scenario with no golden: every action's outcome (and listed rows), then the final state.
export function runOnly(spec: Spec, scenario: Json): Json {
  const it = new Interpreter(spec);
  const keys = new Keys();
  buildSetup(it, scenario.setup, keys);
  const users = Object.fromEntries(scenario.setup.users.map((u: Json) => [u.key, u]));
  const results = (scenario.actions as Json[]).map((action) => {
    const actor = action.actor && action.do !== "join" ? { ref: "User", id: keys.id("user", action.actor) } : null;
    const ip = action.ip ?? users[action.actor]?.ip ?? "203.0.113.250";
    const before = (it.store.nextId.get(CREATES[action.do] ?? "") ?? 1) - 1;
    const isView = it.views.has(action.do);
    const r = it.run(action.do, args(it, action, keys), actor, { ip, method: isView ? "get" : "write" });
    if (action.as && CREATES[action.do]) {
      const ent = CREATES[action.do];
      const newest = it.store.rows(ent).filter((row) => row.id > before).at(-1);
      if (newest) keys.set(ENTITY_KIND[ent], action.as, newest.id);
      if (newest && action.do === "join") users[action.as] = { key: action.as, ip };
    }
    const out: Json = { action, outcome: r.outcome };
    if (r.detail) out.why = r.detail;
    if (r.rows) out.rows = r.rows.map((ref) => keys.key("message", ref.id));
    return out;
  });
  return { results, final: normalized(it, keys) };
}

export function runAll(spec: Spec, scenarioDir: string, goldenDir: string): { total: number; failed: number; diffs: Diff[] } {
  const diffs: Diff[] = [];
  let total = 0, failed = 0;
  for (const f of readdirSync(goldenDir).filter((f) => f.endsWith(".json")).sort()) {
    const golden = JSON.parse(readFileSync(join(goldenDir, f), "utf8"));
    const scenario = JSON.parse(readFileSync(join(scenarioDir, f), "utf8"));
    total++;
    const d = runScenario(spec, scenario, golden);
    if (d.length) { failed++; diffs.push(...d); }
  }
  return { total, failed, diffs };
}

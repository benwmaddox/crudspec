// Imports a Rails Campfire database (the benchmark snapshot) into a crudspec Campfire data
// directory, keeping every id, so the same pages show the same messages.
// usage: node bench/import-rails.ts <rails production.sqlite3> <crudspec data dir>
// Passwords aren't imported (Rails keeps bcrypt digests); the benchmark signs in with a
// session token from the snapshot. Attachments and avatars aren't imported.
process.removeAllListeners("warning");
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "../lang/parser.ts";
import { specMeta, Store, type Row } from "../lang/rows.ts";
import { withGenerated } from "../lang/scaffold.ts";
import { SqliteStore } from "../lang/runtime/store-sqlite.ts";
import { upgrade } from "../lang/runtime/upgrade.ts";

const [railsPath, dataDir] = process.argv.slice(2);
if (!railsPath || !dataDir) { console.error("usage: node bench/import-rails.ts <rails.sqlite3> <data dir>"); process.exit(64); }
const spec = withGenerated(parse(readFileSync("apps/campfire/campfire.crud", "utf8")), parse);
const rails = new DatabaseSync(railsPath, { readOnly: true });
const all = (sql: string) => rails.prepare(sql).all() as any[];
const ms = (t: string | null) => (t ? Date.parse(t.replace(" ", "T") + (/[zZ+]/.test(t.slice(19)) ? "" : "Z")) : 0);
const time = (t: string | null) => (t ? { time: ms(t), seq: 0 } : null);
const ref = (e: string, id: number | null) => (id === null || id === undefined ? null : { ref: e, id: Number(id) });
const plainHtml = (h: string) => (h ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
const ROLES = ["member", "administrator", "bot"], STATUSES = ["active", "deactivated", "banned"];
const ROOM_TYPES: Record<string, string> = { "Rooms::Open": "open", "Rooms::Closed": "closed", "Rooms::Direct": "direct" };

// rows in creation order across all tables, so seq follows Rails' order
type Pending = { entity: string; id: number; created: number; updated: number; fields: Record<string, unknown> };
const rows: Pending[] = [];
const add = (entity: string, r: any, fields: Record<string, unknown>) => rows.push({ entity, id: Number(r.id), created: ms(r.created_at), updated: ms(r.updated_at), fields });

for (const a of all(`SELECT * FROM accounts`)) {
  let settings: any = {}; try { settings = JSON.parse(a.settings ?? "{}"); } catch { /* none */ }
  add("Account", a, { name: a.name, join_code: a.join_code, logo: null, custom_styles: a.custom_styles, restrict_room_creation: !!settings.restrict_room_creation_to_administrators });
}
for (const u of all(`SELECT * FROM users`)) add("User", u, { name: u.name, email: u.email_address, password: null, bio: u.bio, avatar: null, role: ROLES[u.role] ?? "member", status: STATUSES[u.status] ?? "active", bot_token: u.bot_token });
for (const s of all(`SELECT * FROM sessions`)) add("Session", s, { user: ref("User", s.user_id), token: s.token, ip: s.ip_address, user_agent: s.user_agent, last_active: time(s.last_active_at) });
for (const r of all(`SELECT * FROM rooms`)) add("Room", r, { type: ROOM_TYPES[r.type] ?? "open", name: r.name, creator: ref("User", r.creator_id) });
for (const m of all(`SELECT * FROM memberships`)) add("Membership", m, { room: ref("Room", m.room_id), user: ref("User", m.user_id), involvement: m.involvement, unread_since: time(m.unread_at), connected_at: time(m.connected_at), connections: Number(m.connections ?? 0) });
const bodies = new Map(all(`SELECT record_id, body FROM action_text_rich_texts WHERE record_type = 'Message' AND name = 'body'`).map((b) => [Number(b.record_id), b.body]));
for (const m of all(`SELECT * FROM messages`)) add("Message", m, { room: ref("Room", m.room_id), creator: ref("User", m.creator_id), body: { rich: plainHtml(bodies.get(Number(m.id)) ?? ""), mentions: [], entity: "User", embeds: [] }, attachment: null, client_id: m.client_message_id ?? String(m.id) });
for (const b of all(`SELECT * FROM boosts`)) add("Boost", b, { message: ref("Message", b.message_id), booster: ref("User", b.booster_id), content: b.content });
for (const b of all(`SELECT * FROM bans`)) add("Ban", b, { user: ref("User", b.user_id), ip: b.ip_address });
for (const s of all(`SELECT * FROM searches`)) add("Search", s, { user: ref("User", s.user_id), query: s.query });
for (const p of all(`SELECT * FROM push_subscriptions`)) add("PushSubscription", p, { user: ref("User", p.user_id), endpoint: p.endpoint, p256dh_key: p.p256dh_key, auth_key: p.auth_key, user_agent: p.user_agent });
for (const w of all(`SELECT * FROM webhooks`)) add("Webhook", w, { user: ref("User", w.user_id), url: w.url });

// a fresh crudspec database at the current schema, then the rows, ids kept
rmSync(dataDir, { recursive: true, force: true }); mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "app.sqlite");
upgrade(dbPath, spec, { apply: true });
const store = new SqliteStore(dbPath, specMeta(spec));
const s = new Store();
rows.sort((a, b) => a.created - b.created || a.id - b.id);
let seq = 1;
for (const r of rows) {
  const row: Row = { id: r.id, seq: seq++, created: r.created, updated: r.updated || r.created, fields: r.fields as any };
  s.rows(r.entity).push(row);
  s.nextId.set(r.entity, Math.max(s.nextId.get(r.entity) ?? 1, r.id + 1));
}
s.seq = seq;
store.persist(s);
store.db.close();
const counts: Record<string, number> = {};
for (const r of rows) counts[r.entity] = (counts[r.entity] ?? 0) + 1;
console.log(`imported into ${dbPath}: ${JSON.stringify(counts)}`);

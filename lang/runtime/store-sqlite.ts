// SQLite persistence for the runtime. The schema comes from the spec: one table per entity,
// typed columns per field (a Time two: milliseconds and order; a File four: key, name, type,
// size), a RichText's mentions and link previews in two tables of their own, unique indexes from
// `unique (…)`, an index per reference. Only a declared Json field is JSON text.
// Additive spec changes migrate on start (new tables, new columns, defaults filled in);
// columns the spec no longer declares are kept and reported, never dropped.
import { DatabaseSync } from "node:sqlite";
import { Store, type Row, type SpecMeta, type Val } from "../rows.ts";
import { fieldSize } from "../sizes.ts";

type Col = { name: string; sql: string; kind: "ref" | "text" | "int" | "bool" | "time" | "dur" | "pw" | "file" | "rich" | "json" };
// a Time is two columns: its milliseconds (UTC), and its order among times in the same millisecond;
// a File four: its stored key, name, content type and size
const SEQ = "__seq";
const sqlDefs = (c: Col): [string, string][] => c.kind === "time" ? [[c.name, "INTEGER"], [c.name + SEQ, "INTEGER"]]
  : c.kind === "file" ? [[c.name, "TEXT"], [c.name + "__name", "TEXT"], [c.name + "__type", "TEXT"], [c.name + "__size", "INTEGER"]] : [[c.name, c.sql]];
const sqlNames = (c: Col) => sqlDefs(c).map(([n]) => n);
// a RichText's tables: its mentions (rows of an entity) and its link previews, in order
const richTables = (entity: string, field: string) => ({ mentions: `${entity}__${field}__mentions`, embeds: `${entity}__${field}__embeds` });

export class SqliteStore {
  db: DatabaseSync;
  it: SpecMeta;
  last = new Map<string, Map<number, string>>();   // entity -> id -> encoded row, as last persisted
  notes: string[] = [];

  constructor(path: string, it: SpecMeta) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.it = it;
  }

  // entities that are stored (reference data comes from the spec, not the database)
  entities(): [string, any][] { return [...this.it.entities].filter(([, d]) => d.kind === "entity"); }
  columns(ent: any): Col[] {
    return ent.fields.map((f: any): Col => {
      const t = f.type.kind === "named" ? f.type.name : "set";
      if (this.it.entities.has(t)) return { name: f.name, sql: "INTEGER", kind: "ref" };
      if (["Text", "Email", "Url", "Ip"].includes(t) || this.it.enums.has(t)) return { name: f.name, sql: "TEXT", kind: "text" };
      if (t === "Int") return { name: f.name, sql: "INTEGER", kind: "int" };
      if (t === "Bool") return { name: f.name, sql: "INTEGER", kind: "bool" };
      if (t === "Time") return { name: f.name, sql: "INTEGER", kind: "time" };
      if (t === "Duration") return { name: f.name, sql: "INTEGER", kind: "dur" };
      if (t === "Password") return { name: f.name, sql: "TEXT", kind: "pw" };   // its hash, "scrypt:<salt>:<key>"
      if (t === "File") return { name: f.name, sql: "TEXT", kind: "file" };
      if (t === "RichText") return { name: f.name, sql: "TEXT", kind: "rich" };   // its text
      return { name: f.name, sql: "TEXT", kind: "json" };   // a declared Json
    });
  }
  q(name: string) { return `"${name.replace(/"/g, '""')}"`; }

  migrate() { this.convertColumns(); this.migrateTables(); this.migrateIndexes(); }

  // Storage format 3: times, durations and passwords were JSON text; each such column becomes
  // its typed columns in place (new columns filled from the JSON, the old one dropped).
  convertColumns() {
    for (const [name, ent] of this.entities()) {
      if (!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)) continue;
      const info = new Map((this.db.prepare(`PRAGMA table_info(${this.q(name)})`).all() as any[]).map((r) => [r.name as string, String(r.type).toUpperCase()]));
      const T = this.q(name);
      for (const c of this.columns(ent)) {
        const f = this.q(c.name), had = info.get(c.name);
        if (had === undefined) continue;
        if ((c.kind === "time" || c.kind === "dur") && had !== "INTEGER") {
          const tmp = this.q(c.name + "__new");
          this.db.exec(`ALTER TABLE ${T} ADD COLUMN ${tmp} INTEGER`);
          if (c.kind === "time") {
            if (!info.has(c.name + SEQ)) this.db.exec(`ALTER TABLE ${T} ADD COLUMN ${this.q(c.name + SEQ)} INTEGER`);
            this.db.exec(`UPDATE ${T} SET ${tmp} = json_extract(${f}, '$.time'), ${this.q(c.name + SEQ)} = json_extract(${f}, '$.seq') WHERE ${f} IS NOT NULL`);
          } else this.db.exec(`UPDATE ${T} SET ${tmp} = json_extract(${f}, '$.ms') WHERE ${f} IS NOT NULL`);
          this.db.exec(`ALTER TABLE ${T} DROP COLUMN ${f}`);
          this.db.exec(`ALTER TABLE ${T} RENAME COLUMN ${tmp} TO ${f}`);
          this.notes.push(`converted ${name}.${c.name} from JSON text to ${c.kind === "time" ? "INTEGER milliseconds, with its order" : "INTEGER milliseconds"}`);
        }
        // a File stored as JSON ({"file", "stored", "content_type", "size"}): its four columns
        if (c.kind === "file" && !info.has(c.name + "__name")) {
          for (const [n, t] of sqlDefs(c).slice(1)) this.db.exec(`ALTER TABLE ${T} ADD COLUMN ${this.q(n)} ${t}`);
          this.db.exec(`UPDATE ${T} SET ${this.q(c.name + "__name")} = json_extract(${f}, '$.file'), ${this.q(c.name + "__type")} = json_extract(${f}, '$.content_type'), ${this.q(c.name + "__size")} = json_extract(${f}, '$.size'), ${f} = json_extract(${f}, '$.stored') WHERE ${f} IS NOT NULL AND json_valid(${f})`);
          this.notes.push(`converted ${name}.${c.name} from JSON text to its key, name, type and size columns`);
        }
        // a RichText stored as JSON ({"rich", "mentions", "entity", "embeds"}): its text, and its tables
        if (c.kind === "rich" && !this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(richTables(name, c.name).mentions)) {
          this.richTablesFor(name, ent);
          const t = richTables(name, c.name), J = `${f} IS NOT NULL AND json_valid(${f}) AND json_type(${f}, '$.rich') = 'text'`;
          this.db.exec(`INSERT INTO ${this.q(t.mentions)} (row, pos, entity, ref) SELECT r.id, m.key, coalesce(json_extract(r.${f}, '$.entity'), ''), m.value FROM ${T} r, json_each(r.${f}, '$.mentions') m WHERE ${J.replaceAll(f, "r." + f)}`);
          this.db.exec(`INSERT INTO ${this.q(t.embeds)} (row, pos, url, title, description, image) SELECT r.id, e.key, json_extract(e.value, '$.url'), coalesce(json_extract(e.value, '$.title'), ''), coalesce(json_extract(e.value, '$.description'), ''), json_extract(e.value, '$.image') FROM ${T} r, json_each(r.${f}, '$.embeds') e WHERE ${J.replaceAll(f, "r." + f)}`);
          this.db.exec(`UPDATE ${T} SET ${f} = json_extract(${f}, '$.rich') WHERE ${J}`);
          this.notes.push(`converted ${name}.${c.name} from JSON text to its text, with its mentions and previews in ${t.mentions} and ${t.embeds}`);
        }
        // a password hash stored as JSON ({"scrypt": "<salt>:<key>"}): its text
        if (c.kind === "pw") this.db.exec(`UPDATE ${T} SET ${f} = 'scrypt:' || json_extract(${f}, '$.scrypt') WHERE substr(${f}, 1, 1) = '{' AND json_valid(${f})`);
      }
    }
  }

  // A table's definition: STRICT (SQLite enforces each column's type), and a CHECK for every
  // sized column (sizes.ts; SQLite's length() counts characters, as the app does). Columns the
  // spec no longer declares are kept, untyped.
  tableSql(name: string, ent: any, kept: string[] = []): string {
    const cols = this.columns(ent).map((c, i) => {
      const f = ent.fields[i], z = fieldSize(f), t = f.type.name;
      const v = this.q(c.name);
      const checks = t === "Password" || c.kind === "time" || c.kind === "dur" || c.kind === "file" ? [] : [z.max !== undefined ? `length(${v}) <= ${z.max}` : "", z.min !== undefined ? `length(${v}) >= ${z.min}` : ""].filter(Boolean);
      return `, ${this.q(c.name)} ${c.sql}${checks.length ? ` CHECK (${v} IS NULL OR (${checks.join(" AND ")}))` : ""}${sqlDefs(c).slice(1).map(([n, t]) => `, ${this.q(n)} ${t}`).join("")}`;
    });
    return `CREATE TABLE ${this.q(name)} (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL${cols.join("")}${kept.map((k) => `, ${this.q(k)} ANY`).join("")}) STRICT`;
  }
  // a rich-text field's mentions and previews tables
  richTablesFor(name: string, ent: any) {
    for (const c of this.columns(ent)) {
      if (c.kind !== "rich") continue;
      const t = richTables(name, c.name);
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.q(t.mentions)} (row INTEGER NOT NULL, pos INTEGER NOT NULL, entity TEXT NOT NULL, ref INTEGER NOT NULL, PRIMARY KEY (row, pos)) STRICT`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${this.q("ix_" + t.mentions)} ON ${this.q(t.mentions)} (entity, ref)`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.q(t.embeds)} (row INTEGER NOT NULL, pos INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, image TEXT, PRIMARY KEY (row, pos)) STRICT`);
    }
  }
  // Tables and columns for every stored entity. A table whose definition no longer matches the
  // spec's (a size, STRICT) is rebuilt: a new table, the rows copied, the old one dropped.
  migrateTables() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS crudspec_meta (key TEXT PRIMARY KEY, value TEXT)`);
    for (const [name, ent] of this.entities()) {
      const cols = this.columns(ent);
      const exists = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as any;
      this.richTablesFor(name, ent);
      if (!exists) { this.db.exec(this.tableSql(name, ent)); continue; }
      const have = (this.db.prepare(`PRAGMA table_info(${this.q(name)})`).all() as any[]).map((r) => r.name as string);
      for (const c of cols) for (const [n, t] of sqlDefs(c)) if (!have.includes(n)) { this.db.exec(`ALTER TABLE ${this.q(name)} ADD COLUMN ${this.q(n)} ${t}`); if (n === c.name) this.notes.push(`added column ${name}.${c.name}`); }
      for (const h of have) if (!["id", "seq", "created", "updated"].includes(h) && !cols.some((c) => sqlNames(c).includes(h))) this.notes.push(`kept column ${name}.${h}: the spec no longer declares it`);
    }
  }
  // A table whose definition no longer matches the spec's (a size, STRICT) is rebuilt: a new
  // table, the rows copied, the old one dropped. An upgrade does this after the rows are
  // checked, so a row that wouldn't fit is reported rather than failing the copy.
  rebuildTables() {
    for (const [name, ent] of this.entities()) {
      const cols = this.columns(ent);
      const exists = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as any;
      if (!exists) continue;
      const have = (this.db.prepare(`PRAGMA table_info(${this.q(name)})`).all() as any[]).map((r) => r.name as string);
      const kept = have.filter((h) => !["id", "seq", "created", "updated"].includes(h) && !cols.some((c) => sqlNames(c).includes(h)));
      const want = this.tableSql(name, ent, kept);
      const body = (sql: string) => sql.slice(sql.indexOf("("));
      if (body(exists.sql) === body(want)) continue;
      const copy = ["id", "seq", "created", "updated", ...cols.flatMap(sqlNames).filter((c) => have.includes(c)), ...kept];
      const tmp = `${name}__rebuild`;
      this.db.exec(`DROP TABLE IF EXISTS ${this.q(tmp)}`);
      this.db.exec(want.replace(`CREATE TABLE ${this.q(name)} `, `CREATE TABLE ${this.q(tmp)} `));
      this.db.exec(`INSERT INTO ${this.q(tmp)} (${copy.map((c) => this.q(c)).join(", ")}) SELECT ${copy.map((c) => this.q(c)).join(", ")} FROM ${this.q(name)}`);
      this.db.exec(`DROP TABLE ${this.q(name)}`);
      this.db.exec(`ALTER TABLE ${this.q(tmp)} RENAME TO ${this.q(name)}`);
      this.notes.push(`rebuilt ${name} (STRICT, with its size checks)`);
    }
  }
  // Unique keys and reference indexes, exactly as the spec declares them: indexes it no
  // longer declares are dropped, so a removed unique key stops being enforced.
  migrateIndexes() {
    for (const [name, ent] of this.entities()) {
      const want = new Map<string, string>();
      for (const u of ent.uniques) want.set(`uq_${name}_${u.join("_")}`, `CREATE UNIQUE INDEX IF NOT EXISTS ${this.q(`uq_${name}_${u.join("_")}`)} ON ${this.q(name)} (${u.map((c: string) => this.q(c)).join(", ")})`);
      for (const c of this.columns(ent)) if (c.kind === "ref") want.set(`ix_${name}_${c.name}`, `CREATE INDEX IF NOT EXISTS ${this.q(`ix_${name}_${c.name}`)} ON ${this.q(name)} (${this.q(c.name)})`);
      for (const ix of this.db.prepare(`PRAGMA index_list(${this.q(name)})`).all() as any[])
        if (/^(uq|ix)_/.test(ix.name) && !want.has(ix.name)) this.db.exec(`DROP INDEX ${this.q(ix.name)}`);
      for (const tr of this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`).all(name) as any[])
        if (/^sz_/.test(tr.name)) this.db.exec(`DROP TRIGGER ${this.q(tr.name)}`);   // size triggers, before sizes were CHECKs
      for (const sql of want.values()) this.db.exec(sql);
    }
  }

  encode(c: Col, v: Val): unknown {
    if (v === null || v === undefined) return null;
    switch (c.kind) {
      case "ref": return v.id;
      case "bool": return v ? 1 : 0;
      case "int": return Number(v);
      case "text": return String(v);
      case "time": return Number(v.time);
      case "dur": return Number(v.ms);
      case "pw": return v.scrypt ? `scrypt:${v.scrypt}` : null;
      case "json": return JSON.stringify(v);
    }
  }
  // a field's values for its SQL columns (a time's two)
  encodeAll(c: Col, v: Val): unknown[] {
    if (c.kind === "time") return v == null ? [null, null] : [Number(v.time), Number(v.seq ?? 0)];
    if (c.kind === "file") return v == null || !v.stored ? [null, null, null, null] : [String(v.stored), String(v.file ?? ""), String(v.content_type ?? ""), Number(v.size ?? 0)];
    if (c.kind === "rich") return [v == null ? null : typeof v === "object" ? String(v.rich ?? "") : String(v)];
    return [this.encode(c, v)];
  }
  decode(c: Col, v: unknown, refEntity: string): Val {
    if (v === null || v === undefined) return null;
    switch (c.kind) {
      case "ref": return { ref: refEntity, id: Number(v) };
      case "bool": return v === 1 || v === 1n;
      case "int": return Number(v);
      case "text": return String(v);
      case "time": return { time: Number(v), seq: 0 };   // load() reads its order column too
      case "dur": return { ms: Number(v) };
      case "pw": return String(v).startsWith("scrypt:") ? { scrypt: String(v).slice(7) } : null;
      case "json": return JSON.parse(String(v));
    }
  }

  // Loads the database into a Store; returns null when the database is empty.
  load(): Store | null {
    const s = new Store();
    let any = false;
    for (const [name, ent] of this.entities()) {
      const cols = this.columns(ent);
      const rows = this.db.prepare(`SELECT * FROM ${this.q(name)} ORDER BY seq`).all() as any[];
      const seen = new Map<number, string>();
      for (const r of rows) {
        any = true;
        const fields: Record<string, Val> = {};
        cols.forEach((c, i) => (fields[c.name] = r[c.name] == null ? null
          : c.kind === "time" ? { time: Number(r[c.name]), seq: Number(r[c.name + SEQ] ?? 0) }
          : c.kind === "file" ? { file: String(r[c.name + "__name"] ?? ""), stored: String(r[c.name]), content_type: String(r[c.name + "__type"] ?? ""), size: Number(r[c.name + "__size"] ?? 0) }
          : c.kind === "rich" ? { rich: String(r[c.name]), mentions: [] }
          : this.decode(c, r[c.name], ent.fields[i].type.name)));
        const row: Row = { id: Number(r.id), seq: Number(r.seq), created: Number(r.created), updated: Number(r.updated), fields };
        s.rows(name).push(row);
      }
      // rich text: its mentions and previews
      const byId = new Map(s.rows(name).map((row) => [row.id, row]));
      for (const c of cols.filter((c) => c.kind === "rich")) {
        const t = richTables(name, c.name);
        for (const m of this.db.prepare(`SELECT row, entity, ref FROM ${this.q(t.mentions)} ORDER BY row, pos`).all() as any[]) {
          const v = byId.get(Number(m.row))?.fields[c.name]; if (!v) continue;
          v.mentions.push(Number(m.ref)); if (m.entity) v.entity = String(m.entity);
        }
        for (const e of this.db.prepare(`SELECT row, url, title, description, image FROM ${this.q(t.embeds)} ORDER BY row, pos`).all() as any[]) {
          const v = byId.get(Number(e.row))?.fields[c.name]; if (!v) continue;
          (v.embeds ??= []).push({ title: e.title, url: e.url, description: e.description, image: e.image ?? null });
        }
      }
      for (const row of s.rows(name)) seen.set(row.id, JSON.stringify(row));
      this.last.set(name, seen);
    }
    for (const m of this.db.prepare(`SELECT key, value FROM crudspec_meta`).all() as any[]) {
      if (m.key === "seq") s.seq = Number(m.value);
      else if (m.key.startsWith("next:")) s.nextId.set(m.key.slice(5), Number(m.value));
    }
    return any ? s : null;
  }

  // Empties every stored table (test resets).
  clear() {
    for (const [name, ent] of this.entities()) {
      this.db.exec(`DELETE FROM ${this.q(name)}`); this.last.set(name, new Map());
      for (const c of this.columns(ent)) if (c.kind === "rich") { const t = richTables(name, c.name); this.db.exec(`DELETE FROM ${this.q(t.mentions)}`); this.db.exec(`DELETE FROM ${this.q(t.embeds)}`); }
    }
    this.db.exec(`DELETE FROM crudspec_meta`);
  }

  // Writes what changed since the last persist, in one transaction.
  persist(s: Store) {
    this.db.exec("BEGIN");
    try {
      for (const [name, ent] of this.entities()) {
        const cols = this.columns(ent);
        const before = this.last.get(name) ?? new Map<number, string>();
        const now = new Map<number, string>();
        const names = cols.flatMap(sqlNames);
        const upsert = this.db.prepare(`INSERT INTO ${this.q(name)} (id, seq, created, updated${names.map((c) => `, ${this.q(c)}`).join("")}) VALUES (?, ?, ?, ?${names.map(() => ", ?").join("")})
          ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, created = excluded.created, updated = excluded.updated${names.map((c) => `, ${this.q(c)} = excluded.${this.q(c)}`).join("")}`);
        for (const row of s.rows(name)) now.set(row.id, JSON.stringify(row));
        // deletes first, so a row re-created with the same unique key never collides with its old self
        const del = this.db.prepare(`DELETE FROM ${this.q(name)} WHERE id = ?`);
        const rich = cols.filter((c) => c.kind === "rich").map((c) => ({ c, t: richTables(name, c.name) }));
        const dropRich = (id: number) => { for (const { t } of rich) { this.db.prepare(`DELETE FROM ${this.q(t.mentions)} WHERE row = ?`).run(id); this.db.prepare(`DELETE FROM ${this.q(t.embeds)} WHERE row = ?`).run(id); } };
        for (const id of before.keys()) if (!now.has(id)) { del.run(id); dropRich(id); }
        for (const row of s.rows(name)) if (before.get(row.id) !== now.get(row.id)) {
          upsert.run(row.id, row.seq, row.created, row.updated, ...(cols.flatMap((c) => this.encodeAll(c, row.fields[c.name])) as any[]));
          dropRich(row.id);
          for (const { c, t } of rich) {
            const v = row.fields[c.name];
            if (!v || typeof v !== "object") continue;
            (v.mentions ?? []).forEach((ref: number, i: number) => this.db.prepare(`INSERT INTO ${this.q(t.mentions)} (row, pos, entity, ref) VALUES (?, ?, ?, ?)`).run(row.id, i, String(v.entity ?? ""), Number(ref)));
            (v.embeds ?? []).forEach((e: any, i: number) => this.db.prepare(`INSERT INTO ${this.q(t.embeds)} (row, pos, url, title, description, image) VALUES (?, ?, ?, ?, ?, ?)`).run(row.id, i, String(e.url ?? ""), String(e.title ?? ""), String(e.description ?? ""), e.image ?? null));
          }
        }
        this.last.set(name, now);
      }
      const meta = this.db.prepare(`INSERT INTO crudspec_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      meta.run("seq", String(s.seq));
      for (const [k, v] of s.nextId) meta.run(`next:${k}`, String(v));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}

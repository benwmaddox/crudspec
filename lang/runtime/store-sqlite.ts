// SQLite persistence for the runtime. The schema comes from the spec: one table per entity,
// one typed column per field, unique indexes from `unique (…)`, an index per reference.
// Additive spec changes migrate on start (new tables, new columns, defaults filled in);
// columns the spec no longer declares are kept and reported, never dropped.
import { DatabaseSync } from "node:sqlite";
import { Store, type Interpreter, type Row, type Val } from "../interp.ts";
import { fieldSize } from "../sizes.ts";

type Col = { name: string; sql: string; kind: "ref" | "text" | "int" | "bool" | "json" };

export class SqliteStore {
  db: DatabaseSync;
  it: Interpreter;
  last = new Map<string, Map<number, string>>();   // entity -> id -> encoded row, as last persisted
  notes: string[] = [];

  constructor(path: string, it: Interpreter) {
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
      return { name: f.name, sql: "TEXT", kind: "json" };   // Time, File, RichText, Password, Json, Duration
    });
  }
  q(name: string) { return `"${name.replace(/"/g, '""')}"`; }

  migrate() { this.migrateTables(); this.migrateIndexes(); }

  // Tables and columns for every stored entity. Columns the spec dropped from view are kept.
  migrateTables() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS crudspec_meta (key TEXT PRIMARY KEY, value TEXT)`);
    for (const [name, ent] of this.entities()) {
      const cols = this.columns(ent);
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.q(name)} (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL${cols.map((c) => `, ${this.q(c.name)} ${c.sql}`).join("")})`);
      const have = new Set((this.db.prepare(`PRAGMA table_info(${this.q(name)})`).all() as any[]).map((r) => r.name));
      for (const c of cols) if (!have.has(c.name)) { this.db.exec(`ALTER TABLE ${this.q(name)} ADD COLUMN ${this.q(c.name)} ${c.sql}`); this.notes.push(`added column ${name}.${c.name}`); }
      for (const h of have) if (!["id", "seq", "created", "updated"].includes(h) && !cols.some((c) => c.name === h)) this.notes.push(`kept column ${name}.${h}: the spec no longer declares it`);
    }
  }
  // Unique keys and reference indexes, exactly as the spec declares them: indexes it no
  // longer declares are dropped, so a removed unique key stops being enforced.
  migrateIndexes() {
    for (const [name, ent] of this.entities()) {
      const want = new Map<string, string>();
      for (const u of ent.uniques) want.set(`uq_${name}_${u.join("_")}`, `CREATE UNIQUE INDEX IF NOT EXISTS ${this.q(`uq_${name}_${u.join("_")}`)} ON ${this.q(name)} (${u.map((c: string) => this.q(c)).join(", ")})`);
      // sizes (sizes.ts): a trigger per sized column. SQLite counts code points, never more
      // than the UTF-16 units the app counts, so the database only stops what the app would.
      for (const f of ent.fields) {
        const z = fieldSize(f), t = f.type.name;
        if ((z.max === undefined && z.min === undefined) || t === "Password") continue;
        const val = t === "RichText" ? `json_extract(NEW.${this.q(f.name)}, '$.rich')` : `NEW.${this.q(f.name)}`;
        const bad = [z.max !== undefined ? `length(${val}) > ${z.max}` : "", z.min !== undefined ? `length(${val}) < ${z.min}` : ""].filter(Boolean).join(" OR ");
        for (const when of ["INSERT", "UPDATE"]) {
          const n = `sz_${name}_${f.name}_${when.toLowerCase()}`;
          want.set(n, `CREATE TRIGGER IF NOT EXISTS ${this.q(n)} BEFORE ${when} ON ${this.q(name)} FOR EACH ROW WHEN ${val} IS NOT NULL AND (${bad}) BEGIN SELECT RAISE(ABORT, '${name}.${f.name} does not fit its size'); END`);
        }
      }
      for (const c of this.columns(ent)) if (c.kind === "ref") want.set(`ix_${name}_${c.name}`, `CREATE INDEX IF NOT EXISTS ${this.q(`ix_${name}_${c.name}`)} ON ${this.q(name)} (${this.q(c.name)})`);
      for (const ix of this.db.prepare(`PRAGMA index_list(${this.q(name)})`).all() as any[])
        if (/^(uq|ix)_/.test(ix.name) && !want.has(ix.name)) this.db.exec(`DROP INDEX ${this.q(ix.name)}`);
      for (const tr of this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`).all(name) as any[])
        if (/^sz_/.test(tr.name) && !want.has(tr.name)) this.db.exec(`DROP TRIGGER ${this.q(tr.name)}`);
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
      case "json": return JSON.stringify(v);
    }
  }
  decode(c: Col, v: unknown, refEntity: string): Val {
    if (v === null || v === undefined) return null;
    switch (c.kind) {
      case "ref": return { ref: refEntity, id: Number(v) };
      case "bool": return v === 1 || v === 1n;
      case "int": return Number(v);
      case "text": return String(v);
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
        cols.forEach((c, i) => (fields[c.name] = this.decode(c, r[c.name], ent.fields[i].type.name)));
        const row: Row = { id: Number(r.id), seq: Number(r.seq), created: Number(r.created), updated: Number(r.updated), fields };
        s.rows(name).push(row);
        seen.set(row.id, JSON.stringify(row));
      }
      this.last.set(name, seen);
    }
    for (const m of this.db.prepare(`SELECT key, value FROM crudspec_meta`).all() as any[]) {
      if (m.key === "seq") s.seq = Number(m.value);
      else if (m.key.startsWith("next:")) s.nextId.set(m.key.slice(5), Number(m.value));
    }
    return any ? s : null;
  }

  // New fields with defaults get them on existing rows, evaluated by the interpreter.
  fillDefaults(s: Store): number {
    let n = 0;
    for (const [name, ent] of this.entities()) for (const f of ent.fields) {
      if (!f.default) continue;
      for (const row of s.rows(name)) if (!(f.name in row.fields) || (row.fields[f.name] === null && !(f.type.kind === "named" && f.type.optional))) {
        row.fields[f.name] = this.it.eval(f.default, { vars: new Map(), actor: null, request: { ip: "", method: "get", identity: "" }, events: [], effects: [], row: { entity: name, row } } as any);
        n++;
      }
    }
    if (n) this.notes.push(`filled ${n} default value(s) for new fields`);
    return n;
  }

  // Empties every stored table (test resets).
  clear() {
    for (const [name] of this.entities()) { this.db.exec(`DELETE FROM ${this.q(name)}`); this.last.set(name, new Map()); }
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
        const upsert = this.db.prepare(`INSERT INTO ${this.q(name)} (id, seq, created, updated${cols.map((c) => `, ${this.q(c.name)}`).join("")}) VALUES (?, ?, ?, ?${cols.map(() => ", ?").join("")})
          ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, created = excluded.created, updated = excluded.updated${cols.map((c) => `, ${this.q(c.name)} = excluded.${this.q(c.name)}`).join("")}`);
        for (const row of s.rows(name)) now.set(row.id, JSON.stringify(row));
        // deletes first, so a row re-created with the same unique key never collides with its old self
        const del = this.db.prepare(`DELETE FROM ${this.q(name)} WHERE id = ?`);
        for (const id of before.keys()) if (!now.has(id)) del.run(id);
        for (const row of s.rows(name)) if (before.get(row.id) !== now.get(row.id))
          upsert.run(row.id, row.seq, row.created, row.updated, ...(cols.map((c) => this.encode(c, row.fields[c.name])) as any[]));
        this.last.set(name, now);
      }
      const meta = this.db.prepare(`INSERT INTO crudspec_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      meta.run("seq", String(s.seq));
      for (const [k, v] of s.nextId) meta.run(`next:${k}`, String(v));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}

// Upgrading a database to a new version of its spec. The plan is computed from the recorded
// previous schema (schema.ts), then rehearsed in full on a copy of the database:
//   renames and drops, new tables and columns, defaults for new fields, the spec's pending
//   `migration` blocks, then every check (required fields, enum values, references, unique
//   keys and invariants) on every row.
// Only if all of that passes is the copy kept; when applying, the original becomes the
// backup and the copy takes its place. Nothing ever prompts: every decision is in the spec.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Interpreter, Outcome, Store, type Row, type Val } from "../interp.ts";
import type { Spec } from "../parser.ts";
import { diff, schemaHash, schemaOf, type Schema, type Step, type Stored } from "../schema.ts";
import { SqliteStore } from "./store-sqlite.ts";

export type Violation = { check: string; entity: string; field?: string; detail: string; count: number; sample: number[] };
export type Plan = {
  status: "created" | "current" | "ready" | "applied" | "blocked";
  from: { version: number; schema: string } | null;
  to: { version: number; schema: string };
  steps: Step[];
  migrations: { name: string; changed: Record<string, { created: number; updated: number; deleted: number }>; error?: string }[];
  checks: Violation[];
  notes: string[];
  backup?: string;
};

const META = ["crudspec_meta", "crudspec_versions", "crudspec_migrations", "crudspec_agent_tokens", "crudspec_audit", "crudspec_idempotency"];

// The running app holds <data>/app.lock (its process id), so an upgrade can't swap the
// database underneath it. A lock whose process has gone is stale and ignored.
const lockPath = (dbPath: string) => join(dirname(dbPath), "app.lock");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
export function lockHolder(dbPath: string): number | null {
  try { const pid = Number(readFileSync(lockPath(dbPath), "utf8")); return pid && pid !== process.pid && alive(pid) ? pid : null; } catch { return null; }
}
// Takes the lock for this process; returns the other holder's id if it is taken.
export function takeLock(dbPath: string): number | null {
  const other = lockHolder(dbPath); if (other) return other;
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(lockPath(dbPath), String(process.pid));
  process.on("exit", () => { try { if (Number(readFileSync(lockPath(dbPath), "utf8")) === process.pid) rmSync(lockPath(dbPath)); } catch { /* gone */ } });
  return null;
}
const q = (n: string) => `"${n.replace(/"/g, '""')}"`;

function storedTables(db: DatabaseSync): Stored {
  const out: Stored = {};
  for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[]) {
    if (META.includes(t.name) || t.name.startsWith("sqlite_")) continue;
    out[t.name] = new Set((db.prepare(`PRAGMA table_info(${q(t.name)})`).all() as any[]).map((c) => c.name));
  }
  return out;
}
function ensureMeta(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS crudspec_versions (version INTEGER PRIMARY KEY, schema_hash TEXT NOT NULL, schema TEXT NOT NULL, plan TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS crudspec_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL)`);
}
function lastVersion(db: DatabaseSync): { version: number; hash: string; schema: Schema } | null {
  const has = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'crudspec_versions'`).get();
  if (!has) return null;
  const r = db.prepare(`SELECT version, schema_hash, schema FROM crudspec_versions ORDER BY version DESC LIMIT 1`).get() as any;
  return r ? { version: Number(r.version), hash: r.schema_hash, schema: JSON.parse(r.schema) } : null;
}
function appliedMigrations(db: DatabaseSync): Set<string> {
  const has = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'crudspec_migrations'`).get();
  return new Set(has ? (db.prepare(`SELECT name FROM crudspec_migrations`).all() as any[]).map((r) => r.name) : []);
}
function record(db: DatabaseSync, plan: Plan, schema: Schema, ran: string[], now: number) {
  ensureMeta(db);
  db.prepare(`INSERT INTO crudspec_versions (version, schema_hash, schema, plan, applied_at) VALUES (?, ?, ?, ?, ?)`).run(plan.to.version, plan.to.schema, JSON.stringify(schema), JSON.stringify({ ...plan, status: "applied" }), now);
  for (const m of ran) db.prepare(`INSERT INTO crudspec_migrations (name, version, applied_at) VALUES (?, ?, ?)`).run(m, plan.to.version, now);
}

// Every stored row against the spec: required fields, enum values, references, unique keys
// and invariants. Returns the violations, grouped, with up to five row ids each.
export function checkData(it: Interpreter): Violation[] {
  const found = new Map<string, Violation>();
  const add = (check: string, entity: string, field: string | undefined, detail: string, id: number) => {
    const k = `${check}|${entity}|${field ?? ""}|${detail}`;
    const v = found.get(k) ?? { check, entity, ...(field ? { field } : {}), detail, count: 0, sample: [] };
    v.count++; if (v.sample.length < 5) v.sample.push(id); found.set(k, v);
  };
  const ctx = (entity: string, row: Row) => ({ vars: new Map<string, Val>([["self", { ref: entity, id: row.id }]]), actor: null, request: { ip: "", method: "get", identity: "" }, events: [], effects: [], row: { entity, row } }) as any;
  for (const [name, ent] of it.entities) {
    if (ent.kind !== "entity") continue;
    const rows = it.store.rows(name);
    for (const row of rows) {
      for (const f of ent.fields) {
        const v = row.fields[f.name];
        if (f.type.kind !== "named") continue;
        if ((v === null || v === undefined) && !f.type.optional) add("required", name, f.name, `${name}.${f.name} is required but empty`, row.id);
        if (v === null || v === undefined) continue;
        const t = f.type.name, bad = (what: string) => add("type", name, f.name, `${name}.${f.name} holds a value that isn't ${what}`, row.id);
        if (t === "Int" && !Number.isInteger(v)) bad("a whole number");
        else if (t === "Bool" && typeof v !== "boolean") bad("true or false");
        else if (["Text", "Email", "Url", "Ip"].includes(t) && typeof v !== "string") bad("text");
        else if (it.entities.has(t) && !(typeof v === "object" && Number.isInteger(v.id))) bad(`a ${t}`);
        const values = it.enums.get(f.type.name);
        if (values && !values.includes(v)) add("enum", name, f.name, `${name}.${f.name} holds "${v}", which ${f.type.name} no longer has`, row.id);
        if (it.entities.get(f.type.name)?.kind === "entity" && Number.isInteger(v?.id) && !it.store.find({ ref: f.type.name, id: v.id })) add("reference", name, f.name, `${name}.${f.name} refers to a ${f.type.name} that doesn't exist`, row.id);
      }
      for (const inv of ent.invariants ?? []) {
        let ok = false;
        try { ok = it.truthy(it.eval(inv, ctx(name, row))); } catch { ok = false; }
        if (!ok) add("invariant", name, undefined, `invariant of ${name} at line ${inv.pos.line}`, row.id);
      }
    }
    for (const cols of ent.uniques) {
      const seen = new Map<string, number>();
      for (const row of rows) {
        if (cols.some((c: string) => row.fields[c] === null || row.fields[c] === undefined)) continue;   // as in SQL
        const key = JSON.stringify(cols.map((c: string) => row.fields[c]));
        if (seen.has(key)) add("unique", name, undefined, `duplicate (${cols.join(", ")})`, row.id); else seen.set(key, row.id);
      }
    }
  }
  return [...found.values()];
}

function snapshot(s: Store, entities: string[]): Map<string, Map<number, string>> {
  return new Map(entities.map((e) => [e, new Map(s.rows(e).map((r) => [r.id, JSON.stringify(r.fields)]))]));
}
function changes(a: Map<string, Map<number, string>>, b: Map<string, Map<number, string>>) {
  const out: Record<string, { created: number; updated: number; deleted: number }> = {};
  for (const [e, after] of b) {
    const before = a.get(e) ?? new Map();
    const c = { created: 0, updated: 0, deleted: 0 };
    for (const [id, v] of after) if (!before.has(id)) c.created++; else if (before.get(id) !== v) c.updated++;
    for (const id of before.keys()) if (!after.has(id)) c.deleted++;
    if (c.created || c.updated || c.deleted) out[e] = c;
  }
  return out;
}

// Plans the upgrade of the database at `path` to `spec` and, with apply, carries it out.
export function upgrade(path: string, spec: Spec, opts: { apply: boolean; now?: number }): Plan {
  const now = opts.now ?? Date.now();
  const next = schemaOf(spec), nextHash = schemaHash(next);
  const migrations = spec.decls.filter((d) => d.kind === "migration");

  const blockedEarly = (note: string): Plan => ({ status: "blocked", from: null, to: { version: 0, schema: nextHash }, steps: [], migrations: [], checks: [], notes: [note] });
  if (opts.apply) { const pid = lockHolder(path); if (pid) return blockedEarly(`the app is running (process ${pid}) on this data; stop it first. "plan" works while it runs`); }
  // a new database: create it and record the first version, unless one should be there
  if (!existsSync(path)) {
    const dir = dirname(path);
    if (existsSync(join(dir, "backups")) || (existsSync(dir) && readdirSync(dir).some((f) => f.startsWith("app.sqlite.upgrade-"))))
      return blockedEarly(`${path} is missing, but backups or an unfinished upgrade are there; restore the database from ${join(dir, "backups")} instead of starting empty`);
    const plan: Plan = { status: "created", from: null, to: { version: 1, schema: nextHash }, steps: diff(null, spec, {}), migrations: [], checks: [], notes: [] };
    if (!opts.apply) return { ...plan, status: "ready" };
    mkdirSync(dirname(path), { recursive: true });
    const it = new Interpreter(spec);
    const store = new SqliteStore(path, it); store.migrate();
    record(store.db, plan, next, migrations.map((m) => m.name), now);   // nothing to migrate in a new database
    store.db.close();
    return plan;
  }

  const db = new DatabaseSync(path);
  const prev = lastVersion(db), stored = storedTables(db), done = appliedMigrations(db);
  const steps = diff(prev?.schema ?? null, spec, stored);
  const pending = migrations.filter((m) => !done.has(m.name));
  const notes: string[] = [];
  for (const m of migrations) if (done.has(m.name)) notes.push(`migration "${m.name}" has been applied; it can be removed from the spec`);
  for (const d of spec.decls.filter((d) => d.kind === "drop")) {
    const there = d.field ? stored[d.entity]?.has(d.field) : !!stored[d.entity];
    if (!there) notes.push(`"drop ${d.field ? `${d.entity}.${d.field}` : `entity ${d.entity}`}" has been applied; it can be removed from the spec`);
  }
  for (const d of spec.decls.filter((d) => d.kind === "entity")) {
    if (d.was && !steps.some((s) => s.op === "rename_entity" && s.entity === d.name)) notes.push(`"entity ${d.name} was ${d.was}" has been applied; "was ${d.was}" can be removed`);
    for (const f of d.fields) if (f.was && !steps.some((s) => s.op === "rename_field" && s.entity === d.name && s.field === f.name)) notes.push(`"${d.name}.${f.name} was ${f.was}" has been applied; "was ${f.was}" can be removed`);
  }
  const from = prev ? { version: prev.version, schema: prev.hash } : null;
  const plan: Plan = { status: "ready", from, to: { version: (prev?.version ?? 0) + 1, schema: nextHash }, steps, migrations: [], checks: [], notes };

  if (steps.some((s) => s.class === "blocked")) { db.close(); return { ...plan, status: "blocked" }; }
  if (prev && prev.hash === nextHash && !pending.length && !steps.some((s) => s.class === "destructive")) { db.close(); return { ...plan, status: "current", to: from!, steps: steps.filter((s) => s.class !== "contract") }; }

  // what each destructive step would lose
  for (const s of steps) {
    if (s.op === "drop_field") s.detail += ` (${(db.prepare(`SELECT count(*) AS n FROM ${q(s.entity!)} WHERE ${q(s.field!)} IS NOT NULL`).get() as any).n} non-empty values)`;
    if (s.op === "drop_entity") s.detail += ` (${(db.prepare(`SELECT count(*) AS n FROM ${q(s.entity!)}`).get() as any).n} rows)`;
  }

  // rehearse on a copy
  const tmp = `${path}.upgrade-${now}`;
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
  db.exec(`VACUUM INTO ${q(tmp).replace(/^"|"$/g, "'")}`);
  db.close();
  const it = new Interpreter(spec);
  const store = new SqliteStore(tmp, it);
  const discard = () => { store.db.close(); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true }); };
  try {
    store.db.exec("BEGIN");
    for (const s of steps.filter((s) => s.op === "rename_entity")) store.db.exec(`ALTER TABLE ${q(s.from!)} RENAME TO ${q(s.to!)}`);
    for (const s of steps.filter((s) => s.op === "rename_field")) store.db.exec(`ALTER TABLE ${q(s.entity!)} RENAME COLUMN ${q(s.from!)} TO ${q(s.to!)}`);
    for (const s of steps.filter((s) => s.op === "rename_value"))
      for (const [ename, ent] of it.entities) if (ent.kind === "entity") for (const f of ent.fields) if (f.type.kind === "named" && f.type.name === s.entity)
        store.db.prepare(`UPDATE ${q(ename)} SET ${q(f.name)} = ? WHERE ${q(f.name)} = ?`).run(s.to!, s.from!);
    for (const s of steps.filter((s) => s.op === "drop_field")) {
      for (const ix of store.db.prepare(`PRAGMA index_list(${q(s.entity!)})`).all() as any[])
        if ((store.db.prepare(`PRAGMA index_info(${q(ix.name)})`).all() as any[]).some((c) => c.name === s.field)) store.db.exec(`DROP INDEX ${q(ix.name)}`);
      store.db.exec(`ALTER TABLE ${q(s.entity!)} DROP COLUMN ${q(s.field!)}`);
    }
    for (const s of steps.filter((s) => s.op === "drop_entity")) store.db.exec(`DROP TABLE ${q(s.entity!)}`);
    store.migrateTables();
    store.db.exec("COMMIT");

    const reference = it.store;   // reference data comes from the spec, not the database
    it.store = store.load() ?? new Store();
    for (const d of spec.decls) if (d.kind === "data") { it.store.tables.set(d.name, reference.rows(d.name)); it.store.nextId.set(d.name, reference.nextId.get(d.name) ?? 1); }
    it.clock = now;
    // sets, mentions and Json values name their entity; a rename rewrites them too
    const renames = new Map(steps.filter((s) => s.op === "rename_entity").map((s) => [s.from!, s.to!]));
    if (renames.size) {
      const fix = (v: any): any => {
        if (Array.isArray(v)) return v.map(fix);
        if (!v || typeof v !== "object") return v;
        const out: any = {};
        for (const [k, x] of Object.entries(v)) out[k] = (k === "entity" || k === "ref") && typeof x === "string" && renames.has(x) ? renames.get(x) : fix(x);
        return out;
      };
      for (const [ename, ent] of it.entities) if (ent.kind === "entity") for (const row of it.store.rows(ename)) for (const k of Object.keys(row.fields)) row.fields[k] = fix(row.fields[k]);
    }
    const base = { vars: new Map(), actor: null, request: { ip: "", method: "write", identity: "" }, events: [], effects: [], noTriggers: true } as any;
    // new fields get their default (which may read the row's other fields), or 0 for Int
    for (const s of steps.filter((s) => s.op === "add_field")) {
      const f = it.entities.get(s.entity!)!.fields.find((x: any) => x.name === s.field);
      for (const row of it.store.rows(s.entity!)) {
        if (f.default) row.fields[f.name] = it.eval(f.default, { ...base, vars: new Map([["self", { ref: s.entity, id: row.id }]]), row: { entity: s.entity, row } });
        else if (f.type.kind === "named" && f.type.name === "Int" && !f.type.optional) row.fields[f.name] = 0;
      }
    }
    // pending data migrations, in the order the spec declares them
    const names = [...it.entities].filter(([, d]) => d.kind === "entity").map(([n]) => n);
    for (const m of pending) {
      const before = snapshot(it.store, names);
      try { it.exec(m.body, { ...base, vars: new Map() }); }
      catch (e) {
        plan.migrations.push({ name: m.name, changed: {}, error: e instanceof Outcome ? `${e.outcome}: ${e.message}` : String((e as Error).message ?? e) });
        discard(); return { ...plan, status: "blocked" };
      }
      plan.migrations.push({ name: m.name, changed: changes(before, snapshot(it.store, names)) });
    }
    plan.checks = checkData(it);
    if (plan.checks.length) { discard(); return { ...plan, status: "blocked" }; }

    store.persist(it.store);
    store.migrateIndexes();
    record(store.db, plan, next, pending.map((m) => m.name), now);
  } catch (e) {
    try { store.db.exec("ROLLBACK"); } catch { /* not in a transaction */ }
    discard();
    return { ...plan, status: "blocked", notes: [...plan.notes, `the rehearsal failed: ${(e as Error).message}`] };
  }
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.db.close();
  if (!opts.apply) { for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true }); return plan; }

  // Swap. The backup is copied from the original, which stays in place, and then a single
  // rename replaces it with the upgraded copy: a crash at any point leaves a whole database.
  const backups = join(dirname(path), "backups");
  const backup = join(backups, `app-v${from?.version ?? 0}-${now}.sqlite`);
  try {
    mkdirSync(backups, { recursive: true });
    const orig = new DatabaseSync(path);
    orig.exec(`VACUUM INTO ${q(backup).replace(/^"|"$/g, "'")}`);
    orig.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    orig.close();
    for (const ext of ["-wal", "-shm"]) rmSync(path + ext, { force: true });
    for (const ext of ["-wal", "-shm"]) rmSync(tmp + ext, { force: true });
    renameSync(tmp, path);
  } catch (e) {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });
    return { ...plan, status: "blocked", notes: [...plan.notes, `the upgrade was rehearsed but couldn't replace the database (${(e as Error).message}); nothing changed`] };
  }
  return { ...plan, status: "applied", backup };
}

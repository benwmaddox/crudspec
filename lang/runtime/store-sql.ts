// The runtime's store: SQLite is the data. Rows are read with SQL when needed and written
// through at once; nothing loads the dataset. An action runs in a transaction (nested ones
// are savepoints), so a refusal is a rollback. Within a request, a row read twice is the same
// object (an identity map, cleared at the end of each request and on rollback).
// Reference data (`data` declarations) comes from the spec and stays in memory.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Outcome, Store, type Interpreter, type Row, type Val } from "../interp.ts";
import { SqliteStore } from "./store-sqlite.ts";

type Col = { name: string; sql: string; kind: "ref" | "text" | "int" | "bool" | "json" };
export type Change = { entity: string; id: number; op: "create" | "update" | "delete"; fields?: string[] };

export class SqlStore extends Store {
  db: DatabaseSync; it: Interpreter; codec: SqliteStore; mem: Store;
  cols = new Map<string, Col[]>(); types = new Map<string, string[]>();
  ident = new Map<string, Row>();
  depth = 0;
  counters: { nextId: Map<string, number>; seq: number }[] = [];
  log: Change[] = [];
  stmts = new Map<string, StatementSync>();
  readsSql = 0;   // statements run, for the planner's tests and profiles

  constructor(codec: SqliteStore, it: Interpreter, referenceData: Store) {
    super();
    this.codec = codec; this.db = codec.db; this.it = it; this.mem = referenceData;
    for (const [name, ent] of codec.entities()) { this.cols.set(name, codec.columns(ent)); this.types.set(name, ent.fields.map((f: any) => f.type.name)); }
    // ids and the global sequence continue from the database
    for (const name of this.cols.keys()) this.nextId.set(name, Number((this.db.prepare(`SELECT coalesce(max(id), 0) AS m FROM ${this.q(name)}`).get() as any).m) + 1);
    const meta = this.db.prepare(`SELECT value FROM crudspec_meta WHERE key = 'seq'`).get() as any;
    let seq = meta ? Number(meta.value) : 1;
    for (const name of this.cols.keys()) seq = Math.max(seq, Number((this.db.prepare(`SELECT coalesce(max(seq), 0) AS m FROM ${this.q(name)}`).get() as any).m) + 1);
    this.seq = seq;
  }
  q(n: string) { return `"${n.replace(/"/g, '""')}"`; }
  isMem(e: string) { return !this.cols.has(e); }
  prep(sql: string): StatementSync { let s = this.stmts.get(sql); if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); } this.readsSql++; return s; }
  // a stored value for a column, and a parameter for comparing with one
  param(e: string, field: string, v: Val): unknown {
    const c = this.cols.get(e)?.find((x) => x.name === field);
    if (field === "id") return v && typeof v === "object" && "id" in v ? v.id : v;
    return c ? this.codec.encode(c as any, v) : v;
  }
  materialize(e: string, r: any): Row {
    const key = `${e}:${r.id}`;
    const have = this.ident.get(key); if (have) return have;
    const cols = this.cols.get(e)!, types = this.types.get(e)!;
    const fields: Record<string, Val> = {};
    cols.forEach((c, i) => (fields[c.name] = this.codec.decode(c as any, r[c.name], types[i])));
    const row: Row = { id: Number(r.id), seq: Number(r.seq), created: Number(r.created), updated: Number(r.updated), fields };
    this.ident.set(key, row);
    return row;
  }
  select(e: string, where = "", params: unknown[] = [], tail = "ORDER BY seq"): Row[] {
    if (this.isMem(e)) return this.mem.rows(e);
    // the table is always t0, so planned conditions can name it
    return (this.prep(`SELECT t0.* FROM ${this.q(e)} t0${where ? ` WHERE ${where}` : ""} ${tail}`).all(...(params as any[])) as any[]).map((r) => this.materialize(e, r));
  }
  count(e: string, where = "", params: unknown[] = []): number {
    if (this.isMem(e)) return this.mem.rows(e).length;
    return Number((this.prep(`SELECT count(*) AS n FROM ${this.q(e)} t0${where ? ` WHERE ${where}` : ""}`).get(...(params as any[])) as any).n);
  }

  // ---- the Store interface
  rows(e: string): Row[] { return this.select(e); }
  find(r: { ref: string; id: number }): Row | undefined {
    if (this.isMem(r.ref)) return this.mem.find(r);
    const have = this.ident.get(`${r.ref}:${r.id}`); if (have) return have;
    const row = this.prep(`SELECT * FROM ${this.q(r.ref)} WHERE id = ?`).get(r.id) as any;
    return row ? this.materialize(r.ref, row) : undefined;
  }
  // singletons are read often: the first row is kept for the request, and dropped on any write to the entity
  firsts = new Map<string, Row | undefined>();
  first(e: string): Row | undefined {
    if (this.isMem(e)) return this.mem.first(e);
    if (!this.firsts.has(e)) this.firsts.set(e, this.select(e, "", [], "ORDER BY seq LIMIT 1")[0]);
    return this.firsts.get(e);
  }
  where(e: string, field: string, value: Val): Row[] {
    if (this.isMem(e)) return this.mem.rows(e).filter((r) => this.it.equal(r.fields[field], value));
    return this.select(e, `${this.q(field)} = ?`, [this.param(e, field, value)]);
  }
  clash(e: string, cols: string[], fields: Record<string, Val>, exceptId: number): Row | undefined {
    if (cols.some((c) => fields[c] === null || fields[c] === undefined)) return undefined;
    return this.select(e, `${cols.map((c) => `${this.q(c)} = ?`).join(" AND ")} AND id != ?`, [...cols.map((c) => this.param(e, c, fields[c])), exceptId], "LIMIT 1")[0];
  }
  private constraint(err: unknown, e: string): never {
    if (/UNIQUE constraint/i.test(String((err as Error).message))) throw new Outcome("invalid", `unique (${e})`, "unique");
    throw err;
  }
  insert(e: string, fields: Record<string, Val>, now: number): Row {
    if (this.isMem(e)) return this.mem.insert(e, fields, now);
    const id = this.nextId.get(e) ?? 1; this.nextId.set(e, id + 1);
    const row: Row = { id, seq: this.seq++, created: now, updated: now, fields };
    const cols = this.cols.get(e)!;
    try {
      this.prep(`INSERT INTO ${this.q(e)} (id, seq, created, updated${cols.map((c) => `, ${this.q(c.name)}`).join("")}) VALUES (?, ?, ?, ?${cols.map(() => ", ?").join("")})`)
        .run(row.id, row.seq, row.created, row.updated, ...(cols.map((c) => this.codec.encode(c as any, fields[c.name])) as any[]));
    } catch (err) { this.constraint(err, e); }
    this.ident.set(`${e}:${id}`, row); this.firsts.delete(e);
    this.log.push({ entity: e, id, op: "create" });
    return row;
  }
  save(e: string, row: Row, fields?: string[]): void {
    if (this.isMem(e)) return;
    const cols = this.cols.get(e)!;
    try {
      this.prep(`UPDATE ${this.q(e)} SET updated = ?${cols.map((c) => `, ${this.q(c.name)} = ?`).join("")} WHERE id = ?`)
        .run(row.updated, ...(cols.map((c) => this.codec.encode(c as any, row.fields[c.name])) as any[]), row.id);
    } catch (err) { this.constraint(err, e); }
    if (fields?.length) this.log.push({ entity: e, id: row.id, op: "update", fields });
  }
  remove(e: string, id: number): void {
    if (this.isMem(e)) return this.mem.remove(e, id);
    this.prep(`DELETE FROM ${this.q(e)} WHERE id = ?`).run(id);
    this.ident.delete(`${e}:${id}`); this.firsts.delete(e);
    this.log.push({ entity: e, id, op: "delete" });
  }
  // transactions, nested as savepoints
  begin(): void {
    this.counters.push({ nextId: new Map(this.nextId), seq: this.seq });
    this.db.exec(this.depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT s${this.depth}`);
    this.depth++;
  }
  commit(): void {
    this.depth--; this.counters.pop();
    if (this.depth > 0) { this.db.exec(`RELEASE s${this.depth}`); return; }
    this.prep(`INSERT INTO crudspec_meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(this.seq));
    this.db.exec("COMMIT");
  }
  rollback(): void {
    this.depth--;
    const c = this.counters.pop(); if (c) { this.nextId = c.nextId; this.seq = c.seq; }
    if (this.depth > 0) this.db.exec(`ROLLBACK TO s${this.depth}; RELEASE s${this.depth}`);
    else this.db.exec("ROLLBACK");
    this.ident.clear(); this.firsts.clear();   // rows read inside may hold rolled-back values
  }
  endRequest(): void { if (this.depth === 0) { this.ident.clear(); this.firsts.clear(); } }
  clone(): Store { throw new Error("the SQLite store isn't copied; use begin/rollback"); }
  // empties every stored table (test resets)
  clear(): void { this.codec.clear(); this.ident.clear(); this.firsts.clear(); for (const n of this.cols.keys()) this.nextId.set(n, 1); this.seq = 1; }
}

// Rows and the values in them, and an in-memory row store: what the scenario setups, the
// upgrade tooling and the importer build and read. Nothing here evaluates spec code.
export type Ref = { ref: string; id: number };
export type Time = { time: number; seq: number };
export type Val = any;
export type Row = { id: number; seq: number; created: number; updated: number; fields: Record<string, Val> };

export class Store {
  tables = new Map<string, Row[]>();
  nextId = new Map<string, number>();
  seq = 1;
  clone(): Store {
    const s = new Store();
    for (const [k, rows] of this.tables) s.tables.set(k, rows.map((r) => ({ ...r, fields: { ...r.fields } })));
    s.nextId = new Map(this.nextId); s.seq = this.seq;
    return s;
  }
  rows(e: string): Row[] { let t = this.tables.get(e); if (!t) { t = []; this.tables.set(e, t); } return t; }
  find(r: Ref): Row | undefined { return this.rows(r.ref).find((x) => x.id === r.id); }
  // changes made, in order (the agent interface reports a dry run's changes from it)
  log: { entity: string; id: number; op: "create" | "update" | "delete"; fields?: string[] }[] = [];
  insert(e: string, fields: Record<string, Val>, now: number): Row {
    const id = this.nextId.get(e) ?? 1; this.nextId.set(e, id + 1);
    const row = { id, seq: this.seq++, created: now, updated: now, fields };
    this.rows(e).push(row); this.log.push({ entity: e, id, op: "create" }); return row;
  }
  // The store interface the interpreter writes through. In memory, rows are changed in place,
  // so save() has nothing to do.
  save(e: string, row: Row, fields?: string[]): void { if (fields?.length) this.log.push({ entity: e, id: row.id, op: "update", fields }); }
  remove(e: string, id: number): void { const rows = this.rows(e); const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); this.log.push({ entity: e, id, op: "delete" }); }
  first(e: string): Row | undefined { return this.rows(e)[0]; }
  // rows whose field holds a value (references, for cascades)
  where(e: string, field: string, value: Val, equal: (a: Val, b: Val) => boolean): Row[] { return this.rows(e).filter((r) => equal(r.fields[field], value)); }
  // a row other than exceptId with the same full key (empty values never clash)
  clash(e: string, cols: string[], fields: Record<string, Val>, exceptId: number, equal: (a: Val, b: Val) => boolean): Row | undefined {
    if (cols.some((c) => fields[c] === null || fields[c] === undefined)) return undefined;
    return this.rows(e).find((r) => r.id !== exceptId && cols.every((c) => equal(r.fields[c], fields[c])));
  }
  // transactions: in memory, snapshots to go back to (nested ones stack)
  private snaps: Store[] = [];
  begin(): void { this.snaps.push(this.clone()); }
  commit(): void { this.snaps.pop(); }
  rollback(): void { const s = this.snaps.pop(); if (s) { this.tables = s.tables; this.nextId = s.nextId; this.seq = s.seq; } }
  endRequest(): void {}
}

// A spec's entities (stored ones and reference data) and enums, by name: what storing rows needs.
export type SpecMeta = { entities: Map<string, any>; enums: Map<string, string[]> };
export function specMeta(spec: { decls: any[] }): SpecMeta {
  return {
    entities: new Map(spec.decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => [d.name, d])),
    enums: new Map(spec.decls.filter((d) => d.kind === "enum").map((d) => [d.name, d.values])),
  };
}

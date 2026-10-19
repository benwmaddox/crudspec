// What the app's queries cost, from SQLite itself. The generator (gogen/gen.ts) records each
// query it compiles (the SQL it will run, and where it runs: which declaration, inside which
// per-row loops); then, on the database it makes for the app's schema, explain() asks SQLite how
// it would run each one (EXPLAIN QUERY PLAN). Nothing is guessed: a finding is what the plan says.
//   QUERY_UNINDEXED  the plan reads the whole table (SCAN): no index serves the condition
//   QUERY_SORTED     the plan sorts every match to keep a few (USE TEMP B-TREE FOR ORDER BY,
//                    with a LIMIT): an index in that order would read just those
// derive() finds, for those, an index that serves the query, and keeps it only if SQLite then
// plans the query with it (and without the scan or the sort). An app with `indexes auto` gets
// those indexes (gen.ts AutoIndexes; the app keeps them in step when it starts); any other app
// is told which to declare.
import type { DatabaseSync } from "node:sqlite";

export type Query = {
  entity: string;
  where: string;        // the SQL condition (t0 the row), "" for none
  orderBy: string;      // the ORDER BY the database runs ("t0.seq" when the order is Go's)
  limited: boolean;     // the database keeps only some rows (a LIMIT)
  decl: string;         // where it runs: "screen room", "view room_messages", "action post_message"
  loops: string[];      // the per-row loops around it, outermost first
};
export type Planned = Query & { plan: string[]; scan: boolean; sort: boolean };
export type Index = { entity: string; columns: string[]; name: string; serves: string[] };

let captured: Query[] = [];
const decls: string[] = [];
const loops: string[] = [];
export function start() { captured = []; decls.length = 0; loops.length = 0; }
export function pushDecl(d: string) { decls.push(d); }
export function popDecl() { decls.pop(); }
export function pushLoop(l: string) { loops.push(l); }
export function popLoop() { loops.pop(); }
export function onQuery(q: Omit<Query, "decl" | "loops">) {
  captured.push({ ...q, decl: decls[decls.length - 1] ?? "", loops: [...loops] });
}
export function queries(): Query[] { return captured; }

const sqlOf = (q: Query) => `SELECT t0.id FROM "${q.entity}" t0${q.where ? ` WHERE ${q.where}` : ""} ORDER BY ${q.orderBy}${q.limited ? " LIMIT 40" : ""}`;
// the plan's lines, without their tree drawing
function planOf(db: DatabaseSync, sql: string): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as any[]).map((r) => String(r.detail));
}
// reads every row: a SCAN of the table, or of an index in full; with a LIMIT, a walk of an index
// in the query's order (no sort) reads only the rows kept, and is no scan
const sortsAll = (plan: string[]) => plan.some((l) => /USE TEMP B-TREE FOR ORDER BY/.test(l));
const scans = (plan: string[], q: Query) => plan.some((l) => /^SCAN t0\b/.test(l) && !(q.limited && /USING (COVERING )?INDEX/.test(l) && !sortsAll(plan)));
const sorts = (plan: string[], q: Query) => q.limited && sortsAll(plan);

// each distinct query's plan (the same SQL from several places is planned once, kept for each)
export function explain(db: DatabaseSync, qs: Query[] = captured): Planned[] {
  const seen = new Map<string, string[]>();
  return qs.map((q) => {
    const sql = sqlOf(q);
    if (!seen.has(sql)) seen.set(sql, planOf(db, sql));
    const plan = seen.get(sql)!;
    // a query with no condition on the row and no limit asks for every row: reading them all is
    // no finding (a permission of true, or a parameter's test, is no condition on the row)
    const scan = scans(plan, q) && (/\bt0\./.test(q.where) || q.limited);
    return { ...q, plan, scan, sort: sorts(plan, q) };
  });
}

// a condition's top-level parts (AND), with their columns of t0
function parts(where: string): string[] {
  const out: string[] = []; let depth = 0, start = 0;
  const w = where;
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (c === "(") depth++; else if (c === ")") depth--;
    else if (depth === 0 && w.startsWith(" AND ", i)) { out.push(w.slice(start, i)); start = i + 5; i += 4; }
  }
  out.push(w.slice(start));
  // a part in its own parentheses: its inside, if that's one condition
  return out.map((p) => p.trim()).map((p) => (p.startsWith("(") && p.endsWith(")") && balanced(p.slice(1, -1)) ? p.slice(1, -1) : p));
}
const balanced = (s: string) => { let d = 0; for (const c of s) { if (c === "(") d++; else if (c === ")" && --d < 0) return false; } return d === 0; };
const col = (s: string) => s.replace(/^t0\./, "").replace(/^"(.*)"$/, "$1");
// the index a query would want: the columns it pins (= or IS a value), then its order's columns
// (or else a column it compares by range)
function wanted(q: Query): string[] {
  const eq: string[] = [], range: string[] = [];
  for (const p of parts(q.where)) {
    const m = /^(t0\.(?:"[^"]+"|\w+)) (?:=|IS) \?$/.exec(p);
    if (m) { eq.push(col(m[1])); continue; }
    const r = /^(t0\.(?:"[^"]+"|\w+)) (?:<|>|<=|>=) \?$/.exec(p);
    if (r) range.push(col(r[1]));
  }
  const order = q.orderBy.split(",").map((c) => col(c.trim().replace(/ DESC$/, ""))).filter((c) => c !== "id");
  const cols = [...new Set(eq)];
  for (const c of q.limited ? order : range.slice(0, 1)) if (!cols.includes(c)) cols.push(c);
  return cols;
}

// indexes that serve the queries that scan or sort, each one checked: SQLite must plan the
// query with it, without the scan (or the sort). An index that is a prefix of another is dropped.
export function derive(db: DatabaseSync, planned: Planned[]): Index[] {
  const found = new Map<string, Index>();
  for (const p of planned) {
    if (!p.scan && !p.sort) continue;
    const cols = wanted(p);
    if (!cols.length) continue;
    const name = `ax_${p.entity}_${cols.join("_")}`;
    const key = `${p.entity}(${cols.join(",")})`;
    if (!found.has(key)) {
      db.exec(`CREATE INDEX IF NOT EXISTS "${name}" ON "${p.entity}" (${cols.map((c) => `"${c}"`).join(", ")})`);
      const after = planOf(db, sqlOf(p));
      db.exec(`DROP INDEX "${name}"`);
      if (scans(after, p) || sorts(after, p) || !after.some((l) => l.includes(name))) continue;
      found.set(key, { entity: p.entity, columns: cols, name, serves: [] });
    }
    const ix = found.get(key)!;
    if (!ix.serves.includes(p.decl)) ix.serves.push(p.decl);
  }
  // an index whose columns start another's is served by that one: it goes, its queries with it
  const all = [...found.values()];
  const longer = (a: Index) => all.filter((b) => b !== a && b.entity === a.entity && b.columns.length > a.columns.length && a.columns.every((c, i) => b.columns[i] === c)).sort((x, y) => y.columns.length - x.columns.length)[0];
  for (const a of all) { const b = longer(a); if (b) for (const d of a.serves) if (!b.serves.includes(d)) b.serves.push(d); }
  return all.filter((a) => !longer(a));
}
export const indexSQL = (ix: Index) => `CREATE INDEX IF NOT EXISTS "${ix.name}" ON "${ix.entity}" (${ix.columns.map((c) => `"${c}"`).join(", ")})`;

export type CostFinding = { severity: "warning"; code: string; line: number; message: string };
// the findings: each query SQLite would scan for, or sort every match of, once per distinct query
// (the places that run it named together). With indexes auto, the derived indexes are the app's,
// so only what they don't serve is left; without it, each finding says which index to declare.
export function findings(planned: Planned[], indexes: Index[], auto: boolean, lineOf: (decl: string) => number): CostFinding[] {
  const out: CostFinding[] = [];
  const served = (p: Planned) => indexes.find((ix) => ix.entity === p.entity && ix.serves.includes(p.decl));
  const groups = new Map<string, Planned[]>();
  for (const p of planned) if (p.scan || p.sort) groups.set(`${p.entity}|${p.where}|${p.orderBy}|${p.limited}`, [...(groups.get(`${p.entity}|${p.where}|${p.orderBy}|${p.limited}`) ?? []), p]);
  for (const ps of groups.values()) {
    const p = ps[0], ix = served(p);
    if (auto && ix) continue;
    const where = [...new Set(ps.map((x) => x.decl || "the app"))].join(", ");
    const what = p.scan ? `reads every ${p.entity} row` : `sorts every matching ${p.entity} row to keep a few`;
    const fix = ix ? `; an index on ${p.entity} (${ix.columns.join(", ")}) serves it: declare it, or set indexes auto in the app` : `; no index can serve its condition (${p.where.length > 160 ? p.where.slice(0, 160) + "…" : p.where})`;
    out.push({ severity: "warning", code: p.scan ? "QUERY_UNINDEXED" : "QUERY_SORTED", line: lineOf(p.decl), message: `${where}: the query ${what} (SQLite's plan: ${p.plan.join("; ")})${fix}` });
  }
  return out;
}

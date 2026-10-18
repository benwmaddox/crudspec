// H10's data check (docs/H10-PROTOCOL.md): row counts per table of a database, and for the
// display-name task, whether a new column of the users' table holds each name's first word.
//   node h10/data.mjs counts <db> <out.json>
//   node h10/data.mjs compare <before.json> <after.json> [<db> display]
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
const [cmd, a, b, db, task] = process.argv.slice(2);
const SKIP = /^(sqlite_|crudspec_|ar_internal_metadata|schema_migrations|action_text|active_storage|solid_)/;
if (cmd === "counts") {
  const d = new DatabaseSync(a, { readOnly: true });
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name).filter((n) => !SKIP.test(n));
  const out = Object.fromEntries(tables.map((t) => [t, d.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n]));
  writeFileSync(b, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
} else {
  const before = JSON.parse(readFileSync(a, "utf8")), after = JSON.parse(readFileSync(b, "utf8"));
  const lost = Object.entries(before).filter(([t, n]) => (after[t] ?? 0) < n).map(([t, n]) => `${t}: ${n} -> ${after[t] ?? "gone"}`);
  const result = { lost, survived: lost.length === 0 };
  if (task === "display") {
    // the users' table and a column, other than the name, that holds each name's first word
    const d = new DatabaseSync(db, { readOnly: true });
    const users = ["users", "User"].find((t) => d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    const cols = d.prepare(`PRAGMA table_info("${users}")`).all().map((c) => c.name).filter((c) => c !== "name");
    const rows = d.prepare(`SELECT * FROM "${users}" WHERE name IS NOT NULL`).all();
    const first = (n) => String(n).trim().split(/\s+/)[0];
    const mapped = cols.find((c) => rows.length > 0 && rows.every((r) => r[c] === first(r.name)));
    result.mapped = mapped ?? null;
    result.users = rows.length;
  }
  console.log(JSON.stringify(result));
}

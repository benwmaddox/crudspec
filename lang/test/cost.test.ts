// Query costs from SQLite's own plans (lang/cost.ts): a query that reads a whole table, or sorts
// every match to keep a few, is a finding with the index that serves it, which is checked by
// planning the query again with it; a declared index or indexes auto removes the finding.
//   node lang/test/cost.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, lastCost } from "../gogen/gen.ts";
import * as cost from "../cost.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };
const dir = mkdtempSync(join(tmpdir(), "cost-test-"));
let n = 0;
const run = (src: string) => {
  const d = join(dir, `s${n++}`); mkdirSync(d);   // each spec an app of its own
  const f = join(d, "app.crud"); writeFileSync(f, src);
  const files = generate(f);
  const rep = lastCost!;
  return { rep, files, findings: cost.findings(rep.planned, rep.indexes, rep.auto, () => 1, rep.declared) };
};
const spec = (extra = "", app = "") => `
app t { name "T" actor User ${app} }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Board { title: Text }
entity Note { board: Board on delete cascade  tag: Text  body: Text ${extra} }
permission read Note: true
view tagged(tag: Text) { rows Note where .tag == tag }
view latest(b: Board) { rows Note where .board == b order by created  page 10 last }
view all_notes() { rows Note }
`;

const base = run(spec());
const codes = (fs: cost.CostFinding[]) => fs.map((f) => `${f.code} ${f.message.split(":")[0]}`);
ok("a condition no index serves: QUERY_UNINDEXED, naming the index that would", base.findings.some((f) => f.code === "QUERY_UNINDEXED" && f.message.startsWith("view tagged") && f.message.includes("Note (tag)")), codes(base.findings));
ok("the index was checked: SQLite plans the query with it", base.rep.indexes.some((ix) => ix.entity === "Note" && ix.columns.join() === "tag" && ix.serves.includes("view tagged")), base.rep.indexes);
ok("a window by created over a board's notes sorts them all: QUERY_SORTED", base.findings.some((f) => f.code === "QUERY_SORTED" && f.message.startsWith("view latest")), codes(base.findings));
ok("... an index on (board, created, seq) reads just the window", base.rep.indexes.some((ix) => ix.entity === "Note" && ix.columns.join() === "board,created,seq"), base.rep.indexes);
ok("a query for every row, with no limit, is no finding", !base.findings.some((f) => f.message.startsWith("view all_notes")), codes(base.findings));
ok("a reference's own index serves a lookup by it", !base.findings.some((f) => /Note \(board\)/.test(f.message)));

const declared = run(spec("index (tag)  index (board, created)"));
ok("declared indexes: those findings are gone", !declared.findings.some((f) => f.message.startsWith("view tagged") || f.message.startsWith("view latest")), codes(declared.findings));
ok("declared indexes are in the schema the app creates", /ix_Note__tag/.test(declared.files["app.go"] ?? Object.values(declared.files).join("\n")) && /ix_Note__board_created/.test(Object.values(declared.files).join("\n")));

const auto = run(spec("", "indexes auto"));
ok("indexes auto: no findings an index can fix", !auto.findings.some((f) => /serves it/.test(f.message)), codes(auto.findings));
const go = Object.values(auto.files).join("\n");
ok("indexes auto: the build carries the indexes, for the app to make", /AutoIndexes: \[\]string\{[^}]*ax_Note_tag[^}]*\}/.test(go) && /ax_Note_board_created_seq/.test(go));
ok("without indexes auto the build carries none", /AutoIndexes: \[\]string\{\}/.test(Object.values(base.files).join("\n")));

{
  const ix = run(`app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Note { title: Text  body: Text  owner: User on delete cascade  index (title)  index (body) }
permission read Note: true
view by_title(t: Text) { rows Note where .title == t }
`);
  const un = ix.findings.filter((f) => f.code === "INDEX_UNUSED").map((f) => f.message);
  ok("a declared index no query uses: INDEX_UNUSED; one a query uses, and the store's own reference index, not", un.length === 1 && /ix_Note__body/.test(un[0]), un);
}
{
  // a condition that only says what a field isn't: no index serves it, and nothing the spec can
  // write instead does, so reading every row is no finding
  const neg = run(spec("", "") + `view not_tagged(tag: Text) { rows Note where .tag != tag }\n`);
  ok("a scan for a != alone: no finding (no index could serve it)", !neg.findings.some((f) => f.message.startsWith("view not_tagged")), neg.findings.map((f) => f.message));
  const pos = run(spec("", "") + `view by_body(body: Text) { rows Note where .body == body }\n`);
  ok("... while a scan an index would serve still is one", pos.findings.some((f) => f.code === "QUERY_UNINDEXED" && f.message.startsWith("view by_body")), pos.findings.map((f) => f.message));
}
process.exit(failed ? 1 : 0);

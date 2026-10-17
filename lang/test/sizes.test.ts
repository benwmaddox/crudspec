// Sizes (lang/sizes.ts) in every layer: the interpreter refuses what doesn't fit, the agent
// schema says so, the type pass catches literals and forms that allow too much, the upgrade
// planner checks existing rows, and the database refuses by trigger.
//   node lang/test/sizes.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "../parser.ts";
import { Interpreter } from "../interp.ts";
import { describe } from "../describe.ts";
import { typecheck } from "../types.ts";
import { upgrade } from "../runtime/upgrade.ts";

const SPEC = `
entity Note { title: Text max 10 min 2  body: Text?  link: Url? }
action add(title: Text, link: Url?) { create Note { title: title, link: link } }
action rename(n: Note, title: Text) { set n.title = title }
action shout(word: Text max 3) { create Note { title: word + "!!" } }
screen s "/" layout l { main { form add { field title text maxlength 40  submit label "Go" } } }
layout l { main { slot main } }
`;
let failed = 0;
const ok = (what: string, pass: boolean, detail = "") => { console.log(`${pass ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`); if (!pass) failed++; };

const spec = parse(SPEC);
const it = new Interpreter(spec);
const run = (name: string, args: any) => it.run(name, args, null, { ip: "", method: "write", identity: "" });
ok("a value that fits is stored", run("add", { title: "hello" }).outcome === "ok");
const long = run("add", { title: "much too long" });
ok("a longer value is refused as invalid", long.outcome === "invalid" && long.cause === "size", long.detail);
ok("a shorter value is refused", run("add", { title: "x" }).outcome === "invalid");
ok("a set that doesn't fit is refused", run("rename", { n: 1, title: "far too long a title" }).outcome === "invalid");
ok("a type's default size applies (Url 2048)", run("add", { title: "ok", link: "https://x/" + "a".repeat(2100) }).outcome === "invalid");
ok("a declared parameter size is checked", run("shout", { word: "hello" }).outcome === "invalid");
ok("lengths count characters, as SQLite's length() does", run("add", { title: "😀😀😀😀😀😀" }).outcome === "ok" && run("add", { title: "😀😀😀😀😀😀😀😀😀😀😀" }).outcome === "invalid");   // 6 fit, 11 don't

const d = describe(spec);
const addTitle = d.callables.find((c) => c.name === "add")!.params.find((p) => p.name === "title")!;
ok("the agent schema carries the size, inferred from the field", addTitle.schema.maxLength === 10 && addTitle.schema.minLength === 2, JSON.stringify(addTitle.schema));

const tf = typecheck(spec).findings;
ok("a form that allows more than its field accepts is reported", tf.some((f) => f.code === "SIZE_FORM_LONGER"), tf.map((f) => f.code).join(", "));
const lit = typecheck(parse(SPEC.replace('create Note { title: word + "!!" }', 'create Note { title: "a title that is far too long" }'))).findings;
ok("a literal that doesn't fit is an error", lit.some((f) => f.code === "SIZE_LITERAL" && f.severity === "error"));

const dir = mkdtempSync(join(tmpdir(), "sizes-"));
try {
  const db = join(dir, "app.sqlite");
  const loose = parse(SPEC.replace("title: Text max 10 min 2", "title: Text"));
  upgrade(db, loose, { apply: true });
  const h = new DatabaseSync(db);
  h.prepare(`INSERT INTO "Note" (id, seq, created, updated, title) VALUES (1, 1, 0, 0, ?)`).run("a title much longer than ten");
  h.close();
  const plan = upgrade(db, spec, { apply: true });
  ok("tightening a size is a checked step", plan.steps.some((s) => s.op === "tighten_size" && s.class === "checked"), plan.steps.map((s) => s.op).join(", "));
  ok("rows that don't fit block the upgrade", plan.status === "blocked" && JSON.stringify(plan.checks).includes("longer than 10"), plan.status);
  const db2 = join(dir, "b.sqlite");
  upgrade(db2, spec, { apply: true });
  const h2 = new DatabaseSync(db2);
  let refused = "";
  try { h2.prepare(`INSERT INTO "Note" (id, seq, created, updated, title) VALUES (1, 1, 0, 0, ?)`).run("much too long for it"); } catch (e) { refused = (e as Error).message; }
  ok("the database refuses what doesn't fit", refused.includes("does not fit"), refused);
  h2.close();
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);

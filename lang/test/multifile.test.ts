// An app is every .crud file in its directory, with no imports: a declaration in one file is
// seen in all. Messages name file.crud:line; the app builds and runs from any of its files,
// or the directory.
//   node lang/test/multifile.test.ts      (needs Go: run it where `go` is installed)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readSource, at } from "../source.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(typeof info === "string" ? info : JSON.stringify(info, null, 2)); } };
const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", ...args], { encoding: "utf8" });

const dir = mkdtempSync(join(tmpdir(), "multifile-"));
writeFileSync(join(dir, "data.crud"), `entity Note { title: Text }
policy note_rows: true for rows of Note
`);
writeFileSync(join(dir, "ui.crud"), `app notes { name "Notes" }
layout l { <Main><Slot name=main /></Main> }
// Adds a note.
action add_note(title: Text) { create Note { title: title } }
screen home {
  route "/"
  layout l
  access public
  <Main>
    <List of={Note where true} as=n><span>{n.title}</span></List>
  </Main>
}
`);

const src = readSource(dir);
ok("the app's source is its files in name order", src.files.map((f) => f.path.split(/[\\/]/).pop()).join(",") === "data.crud,ui.crud" && at(src, 4) === "ui.crud:2", src.files);
const good = cli("check", dir);
ok("names resolve across files: check passes on the directory", good.status === 0 && /0 errors/.test(good.stdout), good.stdout + good.stderr);
const viaFile = cli("check", join(dir, "ui.crud"));
ok("… and on any one of its files", viaFile.status === 0, viaFile.stdout + viaFile.stderr);

writeFileSync(join(dir, "ui.crud"), `app notes { name "Notes" }
action add_note(title: Text) { create Note { title: title, colour: "red" } }
`);
const bad = cli("check", dir);
ok("a finding names the file and its line", bad.status === 1 && /ui\.crud:2/.test(bad.stdout), bad.stdout);
writeFileSync(join(dir, "ui.crud"), `app notes { name "Notes" }\naction add_note(title: Text) {\n`);
const parseErr = cli("check", dir);
ok("a parse error names the file and its line", parseErr.status === 1 && /ui\.crud:\d+:\d+/.test(parseErr.stdout), parseErr.stdout);

writeFileSync(join(dir, "ui.crud"), `app notes { name "Notes" }
layout l { <Main><Slot name=main /></Main> }
// Adds a note.
action add_note(title: Text) { create Note { title: title } }
screen home {
  route "/"
  layout l
  access public
  <Main>
    <List of={Note where true} as=n><span>{n.title}</span></List>
  </Main>
}
`);
const app = await startApp(join(dir, "ui.crud"), 13931);
try {
  await app.post("/_test/load", { clock: 1000, seq: 2, rows: { Note: [{ id: 1, seq: 1, created: 1, updated: 1, fields: { title: "from the other file" } }] } });
  const html = await (await fetch(app.base + "/")).text();
  ok("it builds and runs: a screen lists an entity declared in the other file", html.includes("from the other file"), html.slice(0, 400));
} finally { app.stop(); }

// a large app in four files, cut between declarations: the same findings as in one, each placed
// (file and line in it) at the same source text; a slip is made so there is an error to place too
{
  const { readFileSync } = await import("node:fs");
  const whole = readFileSync("apps/campfire/campfire.crud", "utf8").replace("fn plain_body(m: Message): Text = if present(plain(m.body))", "fn plain_body(m: Message): Text = if present(plain(m.bdy))");
  const lines = whole.replace(/\n$/, "").split("\n");
  const one = mkdtempSync(join(tmpdir(), "split-1-")), four = mkdtempSync(join(tmpdir(), "split-4-"));
  writeFileSync(join(one, "campfire.crud"), whole);
  // cut at blank lines before a declaration, near each quarter
  const cuts = [0.25, 0.5, 0.75].map((q) => { let i = Math.floor(lines.length * q); while (i < lines.length && !(lines[i] === "" && /^[a-z]/.test(lines[i + 1] ?? ""))) i++; return i + 1; });
  [0, ...cuts].forEach((from, k) => writeFileSync(join(four, `${k}.crud`), lines.slice(from, [...cuts, lines.length][k]).join("\n") + "\n"));
  const run = (d: string) => JSON.parse(cli("check", d, "--deep", "--json").stdout).findings as any[];
  const a = run(one), b = run(four);
  const textAt = (f: any) => readFileSync(f.file, "utf8").split("\n")[f.fileLine - 1];
  ok("Campfire in four files: the same findings as in one", JSON.stringify(a.map((f) => f.code).sort()) === JSON.stringify(b.map((f) => f.code).sort()) && a.some((f) => f.code === "UNKNOWN_FIELD"), { one: a.map((f) => f.code), four: b.map((f) => f.code) });
  ok("... each at the same source text, in its file", b.every((f) => { const g = a.find((x) => x.code === f.code && x.message === f.message); return g && (f.line === 0 || textAt(f) === textAt(g)); }), b.map((f) => [f.code, f.file, f.fileLine]));
  ok("... and the slip in the file it is in", b.find((f) => f.code === "UNKNOWN_FIELD")?.file.endsWith("0.crud") && textAt(b.find((f) => f.code === "UNKNOWN_FIELD")).includes("m.bdy"));
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);

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
permission read Note: true
`);
writeFileSync(join(dir, "ui.crud"), `app notes { name "Notes" }
layout l { <main><slot name=main /></main> }
// Adds a note.
action add_note(title: Text) { create Note { title: title } }
screen home {
  route "/"
  layout l
  access public
  <main>
    <list of={Note where true} as=n><text>{n.title}</text></list>
  </main>
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
layout l { <main><slot name=main /></main> }
// Adds a note.
action add_note(title: Text) { create Note { title: title } }
screen home {
  route "/"
  layout l
  access public
  <main>
    <list of={Note where true} as=n><text>{n.title}</text></list>
  </main>
}
`);
const app = await startApp(join(dir, "ui.crud"), 13931);
try {
  await app.post("/_test/load", { clock: 1000, seq: 2, rows: { Note: [{ id: 1, seq: 1, created: 1, updated: 1, fields: { title: "from the other file" } }] } });
  const html = await (await fetch(app.base + "/")).text();
  ok("it builds and runs: a screen lists an entity declared in the other file", html.includes("from the other file"), html.slice(0, 400));
} finally { app.stop(); }

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);

// app … { warnings error }: an app that holds itself to no warnings fails check and verify on any.
//   node lang/test/app-warnings.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "../parser.ts";
import { check } from "../check.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(String(detail).slice(0, 600)); } };
const spec = (setting: string) => `app t {
  name "T"
  ${setting}
}
entity Note { text: Text }
policy notes: true for rows of Note
// Adds a note.
action add_note(text: Text) { create Note { text: text } }
`;
const run = (src: string) => {
  const dir = mkdtempSync(join(tmpdir(), "cs-warn-"));
  writeFileSync(join(dir, "app.crud"), src);
  return spawnSync(process.execPath, ["--no-warnings", join(import.meta.dirname, "..", "cli.ts"), "check", join(dir, "app.crud")], { encoding: "utf8" });
};
const plain = run(spec(""));
ok("without it, a warning (an action no screen offers) passes check", plain.status === 0 && / 0 errors, [1-9]\d* warnings/.test(plain.stdout), plain.stdout);
const strict = run(spec("warnings error"));
ok("with warnings error, the same warning fails check, as an error", strict.status === 1 && /[1-9]\d* errors, 0 warnings/.test(strict.stdout) && strict.stdout.includes("the app says warnings error"), strict.stdout);
ok("warnings takes only error: APP_WARNINGS", check(parse(spec("warnings loud"))).some((f) => f.code === "APP_WARNINGS"));
process.exit(failed ? 1 : 0);

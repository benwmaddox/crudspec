// The change review on one change at a time to Tasks: each require removed from an action widens
// who can do it, and the review says so (exit 2); a require added narrows it, and the review
// doesn't flag it (exit 0).
//   node lang/test/review-mutants.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "../parser.ts";
import { readSpec } from "../source.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };
const src = readSpec("apps/tasks"), lines = src.split("\n"), spec = parse(src);
const dir = mkdtempSync(join(tmpdir(), "review-mutants-"));
mkdirSync(join(dir, "old")); mkdirSync(join(dir, "new"));
writeFileSync(join(dir, "old", "app.crud"), src);
const review = (text: string) => { writeFileSync(join(dir, "new", "app.crud"), text); return spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "review", join(dir, "old"), join(dir, "new")], { encoding: "utf8" }).status; };

const requires: number[] = [];
const walk = (x: any): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(walk); return; }
  if (x.kind === "require" && /^\s*require\b/.test(lines[x.pos.line - 1]) && !/[{(]\s*(\/\/.*)?$/.test(lines[x.pos.line - 1])) requires.push(x.pos.line);
  for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v); };
for (const d of spec.decls) if (d.kind === "action") walk(d.body);
const unflagged = requires.filter((l) => review(lines.map((t, i) => (i === l - 1 ? "" : t)).join("\n")) !== 2);
ok(`each of the ${requires.length} requires removed: the review flags it`, requires.length > 15 && unflagged.length === 0, unflagged.map((l) => lines[l - 1].trim()));

// a require added after an action's settings (agents no, skip gate)
const flagged: string[] = [];
for (const d of spec.decls) if (d.kind === "action") {
  let i = lines.findIndex((l, j) => j >= d.pos.line - 1 && /\{\s*(\/\/.*)?$/.test(l));
  while (/^\s*(agents no|people no|skip gate)\b/.test(lines[i + 1] ?? "")) i++;
  const out = [...lines]; out.splice(i + 1, 0, "  require actor != none else unauthenticated");
  if (review(out.join("\n")) !== 0) flagged.push(d.name);
}
ok("a require added to any action: not flagged", flagged.length === 0, flagged);
process.exit(failed ? 1 : 0);

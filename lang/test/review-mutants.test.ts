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

// a gate skipped where it wasn't: wider (a skip reads as a guard in the report, but loosens)
const unskipped: string[] = [];
for (const d of spec.decls) if (d.kind === "action" && !(d.skips ?? []).includes("signed_in")) {
  const i = lines.findIndex((l, j) => j >= d.pos.line - 1 && /\{\s*(\/\/.*)?$/.test(l));
  const out = [...lines]; out.splice(i + 1, 0, "  skip gate signed_in");
  if (review(out.join("\n")) !== 2) unskipped.push(d.name);
}
ok("skip gate signed_in added to an action: flagged", unskipped.length === 0, unskipped);

// a read permission narrowed (a condition and-ed on) isn't flagged; opened to everyone, it is
const perms = lines.map((l, i) => [l, i] as const).filter(([l]) => /^permission read \w+: /.test(l) && !/:\s*true\b/.test(l));
const narrowFlagged = perms.filter(([l, i]) => review(lines.map((t, j) => (j === i ? l.replace(/(\/\/.*)?$/, " and actor != none") : t)).join("\n")) !== 0).map(([l]) => l);
const openMissed = perms.filter(([l, i]) => review(lines.map((t, j) => (j === i ? l.replace(/:\s.*$/, ": true") : t)).join("\n")) !== 2).map(([l]) => l);
ok(`each of the ${perms.length} read permissions narrowed: not flagged; made true: flagged`, perms.length >= 3 && narrowFlagged.length === 0 && openMissed.length === 0, { narrowFlagged, openMissed });

// a refactor: member(actor, project) written out in place in every require
// holds in the same cases and reads the same fields: not flagged
const inlined = src.replaceAll("require member(actor, project) else", "require exists(Membership where .project == project and .person == actor) else");
ok("member(…) written out in place: not flagged", inlined !== src && review(inlined) === 0);

// a predicate's or gate's condition changed, in Tasks and Desk: a predicate made true (it admits
// more) or a gate made to block fewer is flagged; a predicate that admits fewer (and false) or a
// gate that blocks more (or true) is not
for (const app of ["apps/tasks", "app3"]) {
  const text = readSpec(app), ls = text.split("\n");
  const d2 = mkdtempSync(join(tmpdir(), "review-logic-")); mkdirSync(join(d2, "old")); mkdirSync(join(d2, "new"));
  writeFileSync(join(d2, "old", "app.crud"), text);
  const rev = (t: string) => { writeFileSync(join(d2, "new", "app.crud"), t); return spawnSync(process.execPath, ["--no-warnings", "lang/cli.ts", "review", join(d2, "old"), join(d2, "new")], { encoding: "utf8" }).status; };
  const edit = (i: number, f: (l: string) => string) => ls.map((t, j) => (j === i ? f(t) : t)).join("\n");
  const wrong: string[] = [];
  ls.forEach((l, i) => {
    const m = /^(predicate \w+\(.*?\) = |gate \w+: )(.+?)( -> \w+)?(\s*\/\/.*)?$/.exec(l);
    if (!m) return;
    const head = m[1], cond = m[2], tail = m[3] ?? "";
    const gate = head.startsWith("gate");
    const cases: [string, number][] = gate ? [[`(${cond}) and false`, 2], [`(${cond}) or true`, 0]] : [["true", 2], [`(${cond}) and false`, 0]];
    for (const [c, want] of cases) if (rev(edit(i, () => head + c + tail)) !== want) wrong.push(`${app}: ${head}${c}${tail} (want exit ${want})`);
  });
  ok(`${app}: each predicate and gate made wider is flagged, made narrower isn't`, wrong.length === 0, wrong);
}
process.exit(failed ? 1 : 0);

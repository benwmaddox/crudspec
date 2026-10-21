// How much of what a slip breaks does check --deep catch? Mutants of a real app's spec, each one
// change, each checked as the CLI checks (names, the type pass, the deep checks; not the costs).
// A mutant with no error, and no warning the app lacks, is a miss. The operators:
//   typo     a name where it is used gets a letter more: no such name, so every one should be caught
//   swap     a field read, set or written names another field of the same entity, of another
//            type (a reference to another entity, or a value of another kind)
//   unguard  a require in an action removed: who may, or what it takes, unchecked
//   attr     an attribute's name in a tag gets a letter more (a built-in's, a component's prop, HTML's)
//   keyword  a keyword (require, create, where, else, …) gets a letter more
//   unfield  a form's field removed: what the action takes, not given
// Misses are listed by what kind of node the name was in, with the line, to read.
//   node lang/test/mutants.ts <app> [--op typo|swap|unguard|attr|keyword|unfield] [--limit N] [--seed N] [--show N]
process.removeAllListeners("warning");
import { parse, SpecError } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { deepCheck } from "../deep.ts";
import { withGenerated } from "../scaffold.ts";
import { readSpec } from "../source.ts";
import { createRequire } from "node:module";

const [app, ...rest] = process.argv.slice(2);
if (!app) { console.error("usage: node lang/test/mutants.ts <app> [--op typo|swap] [--limit N] [--seed N] [--show N]"); process.exit(64); }
const opt = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const op = opt("--op") ?? "typo", limit = Number(opt("--limit") ?? 1e9), show = Number(opt("--show") ?? 40);
let seed = Number(opt("--seed") ?? 1);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const src = readSpec(app);
const lines = src.split("\n");
const offset = (line: number, col: number) => { let o = 0; for (let i = 0; i < line - 1; i++) o += lines[i].length + 1; return o + col - 1; };
const spec = parse(src);

// what check --deep says: its error codes, its warnings (code and message), and the lines each is at
function findings(s: string): { errors: string[]; warnings: Set<string>; lines: Map<string, number> } {
  const warnings = new Set<string>(), lines = new Map<string, number>();
  let sp;
  try { sp = parse(s); } catch (e) { if (e instanceof SpecError) return { errors: [e.code], warnings, lines: new Map([[`error ${e.code} ${e.message}`, e.pos.line]]) }; throw e; }
  const all: { severity: string; code: string; message: string; line?: number }[] = [...check(sp, { source: s })];
  if (!all.some((f) => f.severity === "error")) try {
    all.push(...typecheck(withGenerated(parse(s), parse)).findings, ...deepCheck(sp));
  } catch (e) { all.push({ severity: "error", code: "CRASH", message: (e as Error).message.split("\n")[0] }); }
  for (const f of all) { const k = f.severity === "warning" ? `${f.code} ${f.message}` : `error ${f.code} ${f.message}`; if (f.severity === "warning") warnings.add(k); lines.set(k, f.line ?? 0); }
  return { errors: all.filter((f) => f.severity === "error").map((f) => f.code), warnings, lines };
}
const base = findings(src);
if (base.errors.length) { console.error(`${app} has errors already: ${base.errors.join(", ")}`); process.exit(1); }

type Site = { off: number; len: number; name: string; node: string; line: number; repl: string };
const sites: Site[] = [];
const seen = new Set<number>();
const ident = /^[A-Za-z_][A-Za-z0-9_]*/;
const entities = new Map(spec.decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => [d.name, d]));

// every node with a position whose source, there, is the name it holds: a use of that name
function walk(x: any, parent: string, owner: any): void {
  if (!x || typeof x !== "object") return;
  if (Array.isArray(x)) { for (const y of x) walk(y, parent, owner); return; }
  const node = x.kind ? String(x.kind) : parent;
  if (x.pos && x.pos.line > 0) {
    let off = offset(x.pos.line, x.pos.col);
    if (src[off] === ".") off++;          // a field read: its position is the dot
    if (src[off] === "<") off++;          // an element: its position is the tag
    const m = ident.exec(src.slice(off));
    for (const k of ["name", "entity", "field", "of"]) {
      const v = x[k];
      if (typeof v === "string" && m && m[0] === v && !seen.has(off) && !(x.kind === owner?.kind && x === owner)) {
        seen.add(off);
        sites.push({ off, len: v.length, name: v, node: `${node}.${k}`, line: x.pos.line, repl: v + "q" });
        break;
      }
    }
  }
  for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v, node, owner);
}
for (const d of spec.decls) if (d.pos.line > 0) walk(d, d.kind, d);

// swap: a field name used (a read .f, a set or create's f:) for another field of its entity, of
// another name; the entity is the one the field belongs to, found by the name alone, so only
// field names no two entities share are swapped
const owners = new Map<string, string[]>();
for (const [e, d] of entities) for (const f of d.fields) owners.set(f.name, [...(owners.get(f.name) ?? []), e]);
// unguard: an action's require removed, the whole line (a check of who may, or of what's given)
const requires: Site[] = [];
const walkReq = (x: any, d: any): void => {
  if (!x || typeof x !== "object") return;
  if (Array.isArray(x)) return x.forEach((y) => walkReq(y, d));
  if (x.kind === "require" && x.pos?.line > 0 && /^\s*require\b/.test(lines[x.pos.line - 1]) && !/[{(]\s*(\/\/.*)?$/.test(lines[x.pos.line - 1])) {
    const off = offset(x.pos.line, 1), len = lines[x.pos.line - 1].length;
    requires.push({ off, len, name: `${d.kind} ${d.name}`, node: "require", line: x.pos.line, repl: "" });
  }
  for (const [k, v] of Object.entries(x)) if (k !== "pos") walkReq(v, d);
};
for (const d of spec.decls) if (d.kind === "action" && d.pos.line > 0) walkReq(d.body, d);
// attr: the attribute names in tags, where the colouring reader (editors/vscode/highlight.js) finds them
const attrs: Site[] = [];
for (const t of createRequire(import.meta.url)("../../editors/vscode/highlight.js").tokens(src)) if (t.kind === "attr") {
  const name = src.slice(t.start, t.end), line = src.slice(0, t.start).split("\n").length;
  if (/^(data|aria)-/.test(name)) continue;   // any such name is HTML's
  attrs.push({ off: t.start, len: name.length, name, node: "attr", line, repl: name + "q" });
}
// keyword: each keyword (require, create, where, else, …), where the colouring reader finds one
const keywords: Site[] = [];
for (const t of createRequire(import.meta.url)("../../editors/vscode/highlight.js").tokens(src)) if (t.kind === "kw" || t.kind === "ctl") {
  const name = src.slice(t.start, t.end), line = src.slice(0, t.start).split("\n").length;
  keywords.push({ off: t.start, len: name.length, name, node: "keyword", line, repl: name + "q" });
}
// unfield: a form's field removed, the whole line (<Field … /> on a line of its own)
const fieldsOut: Site[] = [];
lines.forEach((l, i) => { if (/^\s*<Field\b[^>]*\/>\s*$/.test(l)) fieldsOut.push({ off: offset(i + 1, 1), len: l.length, name: /name=(\w+)/.exec(l)?.[1] ?? "?", node: "field", line: i + 1, repl: "" }); });
const muts: Site[] = op === "typo" ? sites : op === "unguard" ? requires : op === "attr" ? attrs : op === "keyword" ? keywords : op === "unfield" ? fieldsOut : sites.flatMap((s) => {
  const own = owners.get(s.name);
  if (!own || own.length !== 1 || !/field|rowfield|assign/.test(s.node)) return [];
  const fs = entities.get(own[0])!.fields, typeOf = (f: any) => f.type.kind === "named" ? f.type.name : f.type.kind;
  const mine = typeOf(fs.find((f: any) => f.name === s.name));
  const others = fs.filter((f: any) => f.name !== s.name && typeOf(f) !== mine).map((f: any) => f.name);
  return others.length ? [{ ...s, repl: others[Math.floor(rand() * others.length)] }] : [];
});

const pick = muts.length > limit ? muts.map((m) => [rand(), m] as const).sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]) : muts;
const t0 = Date.now();
const missed: Site[] = [];
let warned = 0;   // no error, but a warning the app doesn't have
let atLine = 0;   // caught by a finding at the slip's own line
let suggested = 0, uses = 0;   // typo at a use: a finding says "did you mean" the name it was
const unsuggested: Site[] = [], wrong: Site[] = [];   // wrong: a suggestion, of another name
const by = new Map<string, { n: number; caught: number }>();
for (const m of pick) {
  const s = src.slice(0, m.off) + m.repl + src.slice(m.off + m.len);
  const f = findings(s);
  const b = by.get(m.node) ?? { n: 0, caught: 0 }; b.n++;
  const fresh = [...f.lines].filter(([k]) => k.startsWith("error ") || (!base.warnings.has(k) && f.warnings.has(k)));
  if (f.errors.length) b.caught++;
  else if (fresh.length) { b.caught++; warned++; }
  else missed.push(m);
  if (fresh.some(([, l]) => l === m.line)) atLine++;
  const declSite = /^(entity|data|enum|action|view|screen|component|layout|fn|predicate|widget|extern|signal|channel|identity|trigger|workflow|singleton)./.test(m.node);
  if ((op === "typo" || op === "attr" || op === "keyword") && f.errors.length && !declSite) { uses++; if (fresh.some(([k]) => k.includes(`did you mean ${m.name}?`))) suggested++; else { unsuggested.push(m); if (fresh.some(([k]) => /did you mean/.test(k))) wrong.push(m); } }
  by.set(m.node, b);
}
const caught = pick.length - missed.length;
console.log(`${app} ${op}: ${caught}/${pick.length} caught (${(100 * caught / Math.max(1, pick.length)).toFixed(1)}%; ${warned} by a warning alone; ${atLine} at the slip's line${op === "typo" || op === "attr" || op === "keyword" ? `; ${suggested} of ${uses} at uses suggest the name meant, ${wrong.length} another` : ""}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const [k, b] of [...by].sort((a, b) => (b[1].n - b[1].caught) - (a[1].n - a[1].caught))) if (b.caught < b.n) console.log(`  ${k}: ${b.n - b.caught} of ${b.n} missed`);
for (const m of missed.slice(0, show)) console.log(`  missed ${m.node} line ${m.line}: ${m.name} -> ${m.repl}   | ${lines[m.line - 1].trim().slice(0, 100)}`);
if (rest.includes("--unsuggested")) for (const m of unsuggested.slice(0, show)) console.log(`  no suggestion ${m.node} line ${m.line}: ${m.name} -> ${m.repl}   | ${lines[m.line - 1].trim().slice(0, 100)}`);
if (rest.includes("--unsuggested")) for (const m of wrong.slice(0, show)) console.log(`  wrong suggestion ${m.node} line ${m.line}: ${m.name} -> ${m.repl}   | ${lines[m.line - 1].trim().slice(0, 100)}`);

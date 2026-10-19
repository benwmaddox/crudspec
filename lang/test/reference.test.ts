// The reference can't drift: every UI element, attribute, field kind, outcome and builtin the
// parser, checker and generator know has a description, none is described that they don't know,
// and lang/REFERENCE.md is what lang/reference.ts generates.
//   node lang/test/reference.test.ts          (--write regenerates lang/REFERENCE.md)
import { readFileSync, writeFileSync } from "node:fs";
import { COMMON, ELEMENTS, FIELD_KINDS, OUTCOMES } from "../parser.ts";
import { BUILTINS } from "../check.ts";
import { BUILTINS as GEN_BUILTINS } from "../gogen/gen.ts";
import { ATTR_DOCS, BUILTIN_DOCS, ELEMENT_DOCS, FIELD_KIND_DOCS, HEADS, OUTCOME_DOCS, reference } from "../reference.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}${!pass && detail ? `: ${detail}` : ""}`); if (!pass) failed++; };
const same = (what: string, known: string[], described: string[]) => {
  const missing = known.filter((k) => !described.includes(k)), stale = described.filter((k) => !known.includes(k));
  ok(`${what}: each described, none stale`, !missing.length && !stale.length, `undescribed ${missing.join(", ") || "-"}; described but unknown ${stale.join(", ") || "-"}`);
};
same("UI elements", Object.keys(ELEMENTS), Object.keys(ELEMENT_DOCS));
same("attributes", [...new Set([...Object.keys(COMMON), ...Object.values(ELEMENTS).flatMap((e) => Object.keys(e.attrs))])], Object.keys(ATTR_DOCS));
same("element heads", [...new Set(Object.values(ELEMENTS).map((e) => e.head))], Object.keys(HEADS).filter((h) => Object.values(ELEMENTS).some((e) => e.head === h)));
ok("every head kind is described", Object.values(ELEMENTS).every((e) => HEADS[e.head]));
same("field kinds", [...FIELD_KINDS], Object.keys(FIELD_KIND_DOCS));
same("outcomes", OUTCOMES, Object.keys(OUTCOME_DOCS));
same("builtins", Object.keys(BUILTINS), Object.keys(BUILTIN_DOCS));
same("the generator's builtins are the checker's", Object.keys(BUILTINS), [...GEN_BUILTINS]);
// the theme classes the checker knows are the ones the runtime and the scaffold read
{
  const { THEME_CLASSES } = await import("../check.ts");
  const { readdirSync } = await import("node:fs");
  const srcs = ["lang/gogen/gen.ts", "lang/scaffold.ts", ...readdirSync("lang/gogen/rt").filter((f) => f.endsWith(".go")).map((f) => `lang/gogen/rt/${f}`)].map((f) => readFileSync(f, "utf8")).join("\n");
  const read = new Set([...srcs.matchAll(/\b(?:DC|dc)\("([a-z_]+)"\)/g)].map((m) => m[1]));
  if (srcs.includes("generated_section")) read.add("generated_section");
  same("theme classes", [...read], [...THEME_CLASSES]);
}
// every code the checkers report is in the list, with something it says
{
  const { checkCodes } = await import("../reference.ts");
  const listed = new Map(checkCodes().map((c) => [c.code, c]));
  const used = new Set<string>();
  for (const f of ["check.ts", "types.ts", "deep.ts"]) for (const m of readFileSync(`lang/${f}`, "utf8").matchAll(/(?:\berr\(|\bwarn\(|report\("(?:error|warning)", )"([A-Z][A-Z_]{3,})"/g)) used.add(m[1]);
  const missing = [...used].filter((c) => !listed.has(c));
  ok("checks: every code the checker, types and deep passes report is listed", used.size > 50 && missing.length === 0, { used: used.size, missing });
  const empty = [...listed.values()].filter((c) => c.says.replace(/[…\s]/g, "").length <= 3);
  ok("... each says something", empty.length === 0, empty);
}
const generated = reference() + "\n";
if (process.argv.includes("--write")) writeFileSync("lang/REFERENCE.md", generated);
ok("lang/REFERENCE.md is up to date (node lang/test/reference.test.ts --write)", readFileSync("lang/REFERENCE.md", "utf8") === generated);
process.exit(failed ? 1 : 0);

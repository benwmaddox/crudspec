import { readFileSync } from "node:fs";
import { parse, SpecError } from "./parser.ts";
import { check } from "./check.ts";

const [cmd, file, ...rest] = process.argv.slice(2);
try {
  const spec = parse(readFileSync(file, "utf8"));
  if (cmd === "parse") {
    const counts: Record<string, number> = {};
    for (const d of spec.decls) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    console.log(JSON.stringify(counts));
  } else if (cmd === "check") {
    const f = check(spec);
    for (const x of f) console.log(`${x.severity} ${x.code} line ${x.line} [${x.where}]: ${x.message}`);
    const errors = f.filter((x) => x.severity === "error").length;
    console.log(`${errors} errors, ${f.length - errors} warnings`);
    process.exit(errors ? 1 : 0);
  }
} catch (e) {
  if (e instanceof SpecError) { console.log(`error ${e.message}`); process.exit(1); }
  throw e;
}

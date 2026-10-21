// Every expression in the apps gets a type from the type pass (lang/types.ts), so none goes
// unchecked; the places listed below hold names or settings, not values, and are checked by
// lang/check.ts instead.
//   node lang/test/typed.test.ts
import { parse } from "../parser.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";
import { readSpec } from "../source.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };
const EXPR = new Set(["lit", "binary", "if", "unary", "query", "listq", "it", "interp", "field", "rowfield", "now", "name", "listlit", "setlit", "json", "duration", "call", "all"]);
// where an expression names something or sets something, rather than being a value
const NOT_VALUES = new Set(["app.props", "identity.key", "identity.format", "theme.props.classes", "el.attrs.as", "signal.carries"]);
let total = 0;
const untyped: string[] = [];
for (const app of ["apps/campfire", "apps/tasks", "apps/todomvc", "app3"]) {
  const spec = withGenerated(parse(readSpec(app)), parse);
  const { types } = typecheck(spec);
  const walk = (x: any, at: string[], inside: boolean): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, at, inside)); return; }
    const isExpr = EXPR.has(x.kind) && x.pos && !(x.kind === "if" && Array.isArray(x.then));   // an if statement isn't one
    if (isExpr && !inside) {
      total++;
      const place = at.slice(-2).join(".");
      if (!types.has(x) && ![...NOT_VALUES].some((p) => place.endsWith(p) || at.join(".").includes(p))) untyped.push(`${app}:${x.pos.line} (${at.slice(-3).join(".")})`);
    }
    for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v, [...at, ...(x.kind && !EXPR.has(x.kind) ? [x.kind, k] : [k])], inside || isExpr);
  };
  for (const d of spec.decls) walk(d, [], false);
}
ok(`every one of ${total} expressions in the apps is typed`, total > 1500 && untyped.length === 0, untyped.slice(0, 20));
process.exit(failed ? 1 : 0);

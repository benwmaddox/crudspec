// Write policies: `policy p: c else outcome for writes to Entity` becomes a require before each change of a row of it,
// in every action that makes one (lang/writerule.ts), unless the action says `skip policy p`.
//   node lang/test/writepolicy.test.ts
process.removeAllListeners("warning");
import { parse } from "../parser.ts";
import { check } from "../check.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail).slice(0, 400)); } };

const base = `app t { name "T"  actor User }
entity User { name: Text }
entity Recipe { title: Text  owner: User }
entity Step { text: Text  recipe: Recipe }
policy user_rows: true for rows of User
policy recipe_rows: true for rows of Recipe
policy step_rows: true for rows of Step
policy owner: .owner == actor else forbidden for writes to Recipe
`;
const bodyOf = (src: string, name: string): any[] => (parse(base + src).decls.find((d: any) => d.kind === "action" && d.name === name) as any).body;
const requires = (b: any[]) => b.filter((s) => s.kind === "require");

{
  const b = bodyOf(`action rename(r: Recipe, title: Text) {\n  set r.title = title\n  set r.title = title + "!"\n}\n`, "rename");
  ok("a set of a recipe gets the rule as a require first, with the row's name replaced by the row", b[0].kind === "require" && b[0].fromPolicy === "owner" && b[0].outcome === "forbidden" && JSON.stringify(b[0].cond).includes('"name":"r"') && !JSON.stringify(b[0].cond).includes('"name":"recipe"'), b[0]);
  ok("... once for the same row, not before each set", requires(b).length === 1 && b.length === 3, b.map((s: any) => s.kind));
}
{
  const b = bodyOf(`action drop(r: Recipe) { delete r }\naction touchit(r: Recipe) { touch r }\n`, "drop");
  ok("delete and touch are changes too", b[0].kind === "require" && requires(bodyOf(`action touchit(r: Recipe) { touch r }\n`, "touchit")).length === 1);
}
{
  const b = bodyOf(`action edit_step(s: Step, text: Text) {\n  set s.recipe.title = text\n}\n`, "edit_step");
  ok("a row reached through a field (s.recipe) is checked as that row", requires(b).length === 1 && JSON.stringify(requires(b)[0].cond).includes('"name":"recipe"'), b[0]);
  ok("a change of another entity gets nothing", requires(bodyOf(`action edit_text(s: Step, text: Text) {\n  set s.text = text\n}\n`, "edit_text")).length === 0);
}
{
  const b = bodyOf(`action each_mine() {\n  for each x in Recipe where .owner == actor {\n    set x.title = "a"\n  }\n}\n`, "each_mine");
  ok("a loop's row is known, and the require is inside the loop", b[0].kind === "foreach" && requires(b[0].body).length === 1, b);
  const c = bodyOf(`action looked(n: Text) {\n  let r = the(Recipe where .title == n)\n  set r.title = "x"\n}\n`, "looked");
  ok("a row from the(…) is known", requires(c).length === 1, c);
}
{
  ok("skip policy owner: no require", requires(bodyOf(`action free(r: Recipe) {\n  skip policy owner\n  set r.title = "x"\n}\n`, "free")).length === 0);
  const sp = parse(base + `schedule tidy for r in Recipe where r.title == "x" {\n  at r.created\n  if missed skip\n  set r.title = "y"\n}\n`);
  const act: any = sp.decls.find((d: any) => d.kind === "action" && d.scheduled === "tidy");
  ok("a schedule skips it, as it does every-action policies", requires(act.body).length === 0 && act.skips.includes("owner"), act);
}
{
  let err = ""; try { parse(base + `action wipe() { delete Recipe where .title == "x" }\n`); } catch (e: any) { err = e.code + " " + e.message; }
  ok("delete E where …: refused, with the loop to write instead", err.startsWith("WRITE_POLICY_BULK") && err.includes("for each x in Recipe"), err);
  ok("... unless the action skips the policy", (() => { try { parse(base + `action wipe() {\n  skip policy owner\n  delete Recipe where .title == "x"\n}\n`); return true; } catch { return false; } })());
}
{
  const f = check(parse(base + `action mystery(n: Text) {\n  let r = first_or_none(Recipe where .title == n)\n  set r.title = n\n}\nentity Other { a: Text }\naction guess(x: Other) {\n  set x.a = "q"\n}\n`));
  ok("an unknown policy to skip, an unknown entity, and a duplicate name are named", (() => {
    const g = check(parse(base + `action a(r: Recipe) {\n  skip policy nope\n  set r.title = "x"\n}\npolicy ghost: true else forbidden for writes to Nothing\npolicy owner: true else forbidden for every action\n`)).map((x) => x.code);
    return g.includes("UNKNOWN_GATE") && g.includes("UNKNOWN_ENTITY") && g.includes("DUPLICATE");
  })(), f.map((x) => x.code));
  ok("a policy skipped by name is a known one", !check(parse(base + `action a(r: Recipe) {\n  skip policy owner\n  set r.title = "x"\n}\n`)).some((x) => x.code === "UNKNOWN_GATE"));
}
{
  const f = check(parse(base + `action loose(rs: set of Recipe) {\n  for each x in rs {\n    set x.title = "a"\n  }\n}\n`));
  ok("a change whose row's entity is not known: WRITE_POLICY_UNRESOLVED", f.some((x) => x.code === "WRITE_POLICY_UNRESOLVED"), f.map((x) => x.code));
}
process.exit(failed ? 1 : 0);

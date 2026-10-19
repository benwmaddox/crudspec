// verify (lang/cli.ts), the gate for CI and packaging: a broken invariant fails it with a
// counterexample; a guard that keeps it passes; a writer that didn't change is taken from the
// cache; --against runs the change review, and a change that widens what's read needs a person.
//   node lang/test/verify.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)); } };
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "verify-test-"));
const verify = (name: string, src: string, ...args: string[]) => {
  const f = join(dir, `${name}.crud`); writeFileSync(f, src);
  const report = join(dir, `${name}.json`);
  const r = spawnSync(process.execPath, ["--no-warnings", cli, "verify", f, "--timeout", "8000", "--report", report, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr, report: r.status === 0 || r.status === 1 || r.status === 2 ? JSON.parse(readFileSync(report, "utf8")) : undefined };
};

const BASE = `app t { name "T"  actor User }
enum Role { member, administrator }
enum Status { active, gone }
entity User { name: Text  role: Role = member  status: Status = active  token: Text? }
identity login: User.token from cookie "login"
invariant has_admin: not exists(User where true) or exists(User where .role == administrator and .status == active)
action rename(name: Text) { require actor != none else forbidden  set actor.name = name }
`;
const LOOSE = BASE + `action deactivate(u: User) { require actor != none and actor.role == administrator else forbidden  set u.status = gone }\n`;
const SAFE = BASE + `action deactivate(u: User) {
  require actor != none and actor.role == administrator else forbidden
  require u.role != administrator or exists(User where .role == administrator and .status == active and it != u) else invalid
  set u.status = gone
}
`;
const a = verify("loose", LOOSE);
ok("a broken invariant fails verify (exit 1)", a.code === 1 && a.report?.result === "failed", a.out);
ok("... with the counterexample", /BROKEN +has_admin .* by action deactivate: .*status active → gone/.test(a.out), a.out);
ok("... and the report has it", a.report?.invariants.broken === 1 && a.report.invariants.results.some((r: any) => r.status === "broken" && r.where === "action deactivate"), a.report);
const b = verify("safe", SAFE);
ok("the guard keeps it: verify passes (exit 0)", b.code === 0 && b.report?.result === "passed" && b.report.invariants.broken === 0, b.out);
ok("... and rename, which didn't change, comes from the cache", b.report?.invariants.fromCache === 1 && b.report.invariants.results.find((r: any) => r.where === "action rename")?.cached === true, b.report);
const c = verify("safe2", "\n\n" + SAFE);
ok("lines moving don't change a proof: all from the cache", c.code === 0 && c.report?.invariants.fromCache === 2 && c.report.invariants.results.every((r: any) => r.line === 8), c.report);
const h = verify("field", SAFE.replace("token: Text? }", "token: Text?  bio: Text? }"));
ok("a field nothing reads changes no proof: all from the cache", h.code === 0 && h.report?.invariants.fromCache === 2, h.report?.invariants);
const i2 = verify("field_read", SAFE.replace("token: Text? }", "token: Text?  bio: Text? }").replace("set actor.name = name", "set actor.name = name  set actor.bio = name"));
ok("... a field an action writes proves that action again, and only it", i2.code === 0 && i2.report?.invariants.fromCache === 1 && i2.report.invariants.results.find((r: any) => r.where === "action rename")?.cached !== true, i2.report?.invariants);
const j = verify("enum", SAFE.replace("enum Status { active, gone }", "enum Status { active, gone, paused }"));
ok("an enum the invariant reads proves every action again", j.code === 0 && j.report?.invariants.fromCache === 0, j.report?.invariants);
const d = verify("review", SAFE.replace("set u.status = gone", "set u.status = gone  set u.name = actor.name"), "--against", join(dir, "safe.crud"));
ok("--against runs the change review; a writer that now reads more needs a person (exit 2)", d.code === 2 && d.report?.result === "needs review" && /Change review against/.test(d.out), d.out);
const e = verify("error", SAFE.replace("set u.status = gone", "set u.status = nowhere"));
ok("a spec with errors fails before any proof", e.code === 1 && e.report?.errors > 0 && e.report.invariants.results.length === 0, e.out);
const g = verify("ambient", SAFE.replace("invariant has_admin: ", "invariant has_admin: actor != none or "));
ok("an invariant that reads the actor is an error (INVARIANT_AMBIENT)", g.code === 1 && /INVARIANT_AMBIENT/.test(g.out), g.out);
const f = verify("none", SAFE.replace(/^invariant .*$/m, ""));
ok("a spec with no invariant passes with none to prove", f.code === 0 && /Invariants: none declared/.test(f.out), f.out);
// build proves them too, from the same cache, with a shorter limit
const build = (name: string) => spawnSync(process.execPath, ["--no-warnings", cli, "build", join(dir, `${name}.crud`), "--out", join(dir, `out-${name}`)], { encoding: "utf8" });
const bl = build("loose");
ok("build stops on a broken invariant (INVARIANT_BROKEN), before writing the program", bl.status === 1 && /error INVARIANT_BROKEN line \d+: has_admin is broken by action deactivate/.test(bl.stdout), bl.stdout + bl.stderr);
const bs = build("safe");
// (whether go build then works here is the Go toolchain's business: on Windows the apps build in WSL)
ok("build goes on when every invariant holds", !/INVARIANT_BROKEN/.test(bs.stdout) && /invariants: 2 proven, 0 broken, 0 unproven/.test(bs.stdout) && existsSync(join(dir, "out-safe", "app.go")), bs.stdout + bs.stderr);
process.exit(failed ? 1 : 0);

// transitions f { a -> b, c }: the moves an enum field may make. Checked statically (the block's
// own mistakes; a set that isn't a declared move; a dead move) and at run time, in a compiled app
// (a move the block doesn't declare ends with invalid, in a single set and in a loop's, and a
// whole action is all or none).
//   node lang/test/transitions.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { deepCheck } from "../deep.ts";
import { lifecycleDiff } from "../review.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };

const head = `app t { name "T" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
enum S { open, claimed, done, cancelled }
`;
const task = (extra: string) => `entity Task {\n  title: Text\n  status: S = open\n${extra}\n}\n`;
const MOVES = `  transitions status {\n    open -> claimed, cancelled\n    claimed -> open, done, cancelled\n  }`;
const codes = (src: string) => check(parse(head + src)).map((f) => f.code);
const deep = (src: string) => deepCheck(parse(head + src)).filter((f) => f.code.startsWith("TRANSITION_"));
const dcodes = (actions: string) => deep(task(MOVES) + actions).map((f) => f.code);

// the block's own mistakes
ok("a good block checks clean", codes(task(MOVES)).length === 0, codes(task(MOVES)));
ok("unknown field", codes(task("  transitions stat { open -> claimed }")).includes("TRANSITIONS_FIELD"));
ok("a field that is no enum", codes(task("  transitions title { open -> claimed }")).includes("TRANSITIONS_FIELD"));
ok("a value that isn't one (did you mean)", check(parse(head + task("  transitions status { open -> claimd }"))).some((f) => f.code === "TRANSITIONS_VALUE" && f.message.endsWith("did you mean claimed?")));
ok("two blocks for a field", codes(task(MOVES + "\n" + MOVES)).includes("TRANSITIONS_DUPLICATE"));
ok("two rows from a state", codes(task("  transitions status { open -> claimed  open -> done }")).includes("TRANSITIONS_DUPLICATE"));
ok("a state moving to itself", codes(task("  transitions status { open -> open }")).includes("TRANSITIONS_SELF"));
ok("a field named transitions is still a field", codes(`entity Z { transitions: Text }\n`).length === 0, codes(`entity Z { transitions: Text }\n`));

// the sets
ok("a guarded move is proved", dcodes("action claim(t: Task) { require t.status == open else invalid  set t.status = claimed }").every((c) => c !== "TRANSITION_UNPROVEN"));
ok("... with !=, a list, and an if", dcodes(`action a(t: Task) { if t.status != done and t.status != open and t.status != cancelled { set t.status = done } }
action b(t: Task) { require t.status in [open, claimed] else invalid  set t.status = cancelled }`).every((c) => c !== "TRANSITION_UNPROVEN"));
ok("an unguarded set is refused", dcodes("action finish(t: Task) { set t.status = done }").includes("TRANSITION_UNPROVEN"));
ok("... a guard that leaves a state open too", dcodes("action finish(t: Task) { require t.status in [claimed, open] else invalid  set t.status = done }").includes("TRANSITION_UNPROVEN"));
ok("... an or doesn't prove what only one side says", dcodes("action finish(t: Task) { require t.status == claimed or t.title == \"x\" else invalid  set t.status = done }").includes("TRANSITION_UNPROVEN"));
ok("... nor does a guard on another row", dcodes("action finish(t: Task, u: Task) { require u.status == claimed else invalid  set t.status = done }").includes("TRANSITION_UNPROVEN"));
ok("... nor a not that undoes it", dcodes("action finish(t: Task) { require not (t.status == claimed) else invalid  set t.status = done }").includes("TRANSITION_UNPROVEN"));
ok("a set after a set knows the state it made", dcodes("action go(t: Task) { require t.status == open else invalid  set t.status = claimed  set t.status = done }").every((c) => c !== "TRANSITION_UNPROVEN"));
ok("a loop's where is the guard", dcodes("action sweep() { for each t in Task where .status == open { set t.status = cancelled } }").every((c) => c !== "TRANSITION_UNPROVEN"));
ok("... and without it the loop is refused", dcodes("action sweep() { for each t in Task where .title != \"\" { set t.status = cancelled } }").includes("TRANSITION_UNPROVEN"));
ok("a set to none is refused", dcodes("action clear(t: Task) { set t.status = none }").includes("TRANSITION_NONE"));
ok("a let between two sets doesn't make the check forget the state", !dcodes("action go(t: Task) { require t.status == open else invalid  set t.status = claimed  let x = t.title  set t.status = done }").includes("TRANSITION_UNPROVEN"));
ok("... nor does a set of another field", !dcodes("action go(t: Task) { require t.status == open else invalid  set t.status = claimed  set t.title = \"x\"  set t.status = done }").includes("TRANSITION_UNPROVEN"));
ok("... an if's branches start in the state before it", !dcodes("action go(t: Task) { require t.status == open else invalid  set t.status = claimed  if t.title == \"x\" { set t.status = done } else { set t.status = open } }").includes("TRANSITION_UNPROVEN"));
ok("... but after the if, what it did is not known", dcodes("action go(t: Task) { require t.status == open else invalid  if t.title == \"x\" { set t.status = claimed }  set t.status = done }").includes("TRANSITION_UNPROVEN"));
ok("... and a trigger on the entity's updates could change the field, so a set of another field forgets it", deep(task(MOVES) + "trigger on update Task.title as x { set x.status = open }" + String.fromCharCode(10) + "action go(t: Task) { require t.status == open else invalid  set t.status = claimed  set t.title = " + String.fromCharCode(34) + "x" + String.fromCharCode(34) + "  set t.status = done }" + String.fromCharCode(10)).some((f) => f.code === "TRANSITION_UNPROVEN"));
ok("a set to a value that isn't a literal is left to run time", dcodes("action mv(t: Task, to: S) { set t.status = to }").includes("TRANSITION_DYNAMIC"));
ok("a declared move nothing makes is reported", dcodes("action claim(t: Task) { require t.status == open else invalid  set t.status = claimed }").includes("TRANSITION_UNUSED"));
ok("... but not when every move is made", dcodes(`action a(t: Task) { require t.status == open else invalid  set t.status = claimed }
action b(t: Task) { require t.status == open else invalid  set t.status = cancelled }
action c(t: Task) { require t.status == claimed else invalid  set t.status = open }
action d(t: Task) { require t.status == claimed else invalid  set t.status = done }
action e(t: Task) { require t.status == claimed else invalid  set t.status = cancelled }`).length === 0);
ok("a migration may set any state", deep(task(MOVES) + `migration "fix" { for each t in Task where .status == open { set t.status = done } }\n`).every((f) => f.code !== "TRANSITION_UNPROVEN"));

// the change review
{
  const v = (block: string) => parse(head + task(block));
  const was = v(MOVES);
  ok("no change in the moves, no lifecycle finding", lifecycleDiff(was, v(MOVES)).length === 0);
  const more = lifecycleDiff(was, v(MOVES.replace("open -> claimed, cancelled", "open -> claimed, cancelled, done")));
  ok("a move added is WIDER", more.length === 1 && more[0] === "WIDER Task.status may now move open -> done", more);
  const less = lifecycleDiff(was, v(MOVES.replace("claimed -> open, done, cancelled", "claimed -> done, cancelled")));
  ok("a move removed is narrowed", less.length === 1 && less[0] === "narrowed Task.status may no longer move claimed -> open", less);
  ok("a block taken out is WIDER", lifecycleDiff(was, v("")).some((x) => x.startsWith("WIDER Task.status has no transitions")));
  ok("a block put in is narrowed", lifecycleDiff(v(""), was).some((x) => x.startsWith("narrowed Task.status now has transitions")));
}

// at run time, in the compiled app
const SPEC = head + task(MOVES + `
  prev: S?
  transitions prev {
    open -> claimed
  }`) + `
action set_prev(t: Task, p: S?) { set t.prev = p }
action add(title: Text) { create Task { title: title } }
action move(t: Task, to: S) { set t.status = to }
action move_all(to: S) { for each t in Task where .title != "" { set t.status = to } }
action claim(t: Task) { require t.status == open else invalid  set t.status = claimed }
action finish_claimed() { for each t in Task where .status == claimed { set t.status = done } }
`;
const dir = mkdtempSync(join(tmpdir(), "transitions-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13911);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  await app.post("/_test/load", { clock: 1000, rows: { User: [row(1, { name: "ada", token: null })], Task: [row(1, { title: "a", status: "open" }), row(2, { title: "b", status: "claimed" }), row(3, { title: "c", status: "done" })] } });
  const call = async (action: string, args: Record<string, string>) => (await fetch(app.base + "/_do/" + action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": "User:1" }, body: new URLSearchParams(args), redirect: "manual" })).headers.get("X-Crudspec-Outcome");
  const status = async () => Object.fromEntries(((await app.post("/_test/dump", {})).rows.Task as any[]).map((t: any) => [t.id, t.fields.status]));
  ok("a declared move is made", (await call("move", { t: "1", to: "claimed" })) === "ok" && (await status())[1] === "claimed", await status());
  ok("an undeclared one is refused, the row left as it was", (await call("move", { t: "1", to: "open" })) === "ok" && (await call("move", { t: "1", to: "open" })) === "ok" && (await call("move", { t: "3", to: "open" })) === "invalid" && (await status())[3] === "done", await status());
  ok("a set to none is refused at run time, a set to a state from none is not", (await call("set_prev", { t: "1", p: "open" })) === "ok" && (await call("set_prev", { t: "1" })) === "invalid" && (await call("set_prev", { t: "1", p: "done" })) === "invalid", null);
  ok("a set to the state it has is always allowed", (await call("move", { t: "3", to: "done" })) === "ok");
  ok("a guarded action works", (await call("claim", { t: "1" })) === "ok" && (await status())[1] === "claimed", await status());
  // task 1 claimed, 2 claimed, 3 done: moving all to open is allowed for 1 and 2, but not 3
  ok("a loop's illegal move refuses the whole action", (await call("move_all", { to: "open" })) === "invalid", await status());
  const after = await status();
  ok("... and nothing it did before is kept", after[1] === "claimed" && after[2] === "claimed" && after[3] === "done", after);
  ok("a loop that is all legal goes through", (await call("finish_claimed", {})) === "ok" && JSON.stringify(Object.values(await status())) === JSON.stringify(["done", "done", "done"]), await status());
} finally { app.stop(); }
process.exit(failed ? 1 : 0);

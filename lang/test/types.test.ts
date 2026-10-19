// The type pass (lang/types.ts) on Campfire: the spec as it is has no findings, and each
// broken copy is caught with the finding it should get.
//   node lang/test/types.test.ts
import { readFileSync } from "node:fs";
import { parse } from "../parser.ts";
import { withGenerated } from "../scaffold.ts";
import { typecheck } from "../types.ts";

const src = readFileSync(new URL("../../apps/campfire/campfire.crud", import.meta.url), "utf8");
const run = (s: string) => typecheck(withGenerated(parse(s), parse)).findings;
let failed = 0;
const ok = (name: string, pass: boolean, detail = "") => { console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); if (!pass) failed++; };

const clean = run(src);
ok("Campfire as it is has no findings", clean.length === 0, clean.map((f) => `${f.code} line ${f.line}`).join(", "));

const cases: [string, string, string, string][] = [
  // [what, text to find, replacement, expected finding]
  ["a Bool parameter compared with an enum value it hides", `room.type == "closed") or closed == true`, `room.type == closed) or closed == true`, "TYPE_NEVER_EQUAL"],
  ["a text value that isn't one of the enum's", `room.type == "closed") or closed == true`, `room.type == "clossed") or closed == true`, "TYPE_NEVER_EQUAL"],
  ["a condition that isn't a Bool", "require member(actor, room) else not_found                       // G1", "require room.name else not_found", "TYPE_NOT_BOOL"],
  ["a field given the wrong type", "create Ban { user: user, ip: ip }", "create Ban { user: user, ip: user }", "TYPE_MISMATCH"],
  ["a field that doesn't exist", "require can_administer(actor, message.creator) else forbidden    // G3", "require can_administer(actor, message.author) else forbidden", "TYPE_NO_FIELD"],
  ["a required field given what may be none", "create User { name: name, email: email, password: password, avatar: avatar } as user", "create User { name: name, email: email, password: password, avatar: avatar } as user\n  create Room { type: open, name: name, creator: actor }", "TYPE_MAYBE_NONE"],
  ["a time compared with a number", "and (before == none or .created < before.created)", "and (before == none or .created < 5)", "TYPE_MISMATCH"],
  ["a function's result of the wrong type", "fn bot_key(u: User): Text =", "fn bot_key(u: User): Int =", "TYPE_MISMATCH"],
  ["count of something that isn't a list", "if count(Membership where .room == r and .user != actor) > 1", "if count(r) > 1", "TYPE_MISMATCH"],
  ["rows of one entity looked for in a set of another", "for each u in User where u in users {                           // R4", "for each u in Room where u in users {", "TYPE_MISMATCH"],
];
for (const [what, find, replace, code] of cases) {
  if (!src.includes(find)) { ok(what, false, "the text to change isn't in the spec"); continue; }
  const got = run(src.replace(find, replace));
  ok(what, got.some((f) => f.code === code), got.map((f) => `${f.code} line ${f.line}`).join(", ") || "no findings");
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);

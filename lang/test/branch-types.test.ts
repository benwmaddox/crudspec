// Two slips the type pass catches: an if's branches (a match's arms) that give different kinds
// of value, and present() / blank() of a value that is never none or empty. Both were found by
// swapping field names in TodoMVC (lang/test/mutants.test.ts): `completed { t.title }` in a Bool
// function, and `.completed.present()` in an invariant, which is always true.
//   node lang/test/branch-types.test.ts
process.removeAllListeners("warning");
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { typecheck } from "../types.ts";
import { withGenerated } from "../scaffold.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };
const head = `app t { name "T" actor Board }
entity Board { token: Text  unique (token) }
identity v: Board.token from cookie "t"
entity Room { name: Text }
entity Todo { board: Board  title: Text  completed: Bool = false  note: Text?  due: Int?  price: Decimal = 0  photo: File? }
enum Filter { all, active }
`;
const errors = (body: string) => { const src = head + body + "\n"; const s = parse(src); return [...check(s, { source: src }), ...typecheck(withGenerated(s, parse)).findings].filter((f: any) => f.severity === "error"); };
const has = (body: string, text: string) => errors(body).some((f: any) => f.code === "TYPE_MISMATCH" && f.message.includes(text));
const clean = (body: string) => errors(body).length === 0;

ok("a match's arms that give text and a Bool: TYPE_MISMATCH", has(`fn f(show: Filter?, t: Todo): Bool = match show { active { t.title } all, none { true } }\nview v(t: Todo) { value f(none, t) }`, "this match's arms give text and bool"));
ok("an if's branches that do: TYPE_MISMATCH", has(`fn f(t: Todo): Bool = if t.completed { t.title } else { true }\nview v(t: Todo) { value f(t) }`, "this if's branches give text and bool"));
ok("a row of one entity and of another: TYPE_MISMATCH", has(`fn f(t: Todo, r: Room): Text = text(if t.completed { t.board } else { r })\nview v(t: Todo, r: Room) { value f(t, r) }`, "this if's branches give"));
ok("an Int and a Decimal mix", clean(`fn f(t: Todo): Decimal = if t.completed { 1 } else { t.price }\nview v(t: Todo) { value f(t) }`), errors(`fn f(t: Todo): Decimal = if t.completed { 1 } else { t.price }\nview v(t: Todo) { value f(t) }`));
ok("a File and an asset's path mix", clean(`view v(t: Todo) { value if t.photo != none { t.photo } else { "default.png" } }`), errors(`view v(t: Todo) { value if t.photo != none { t.photo } else { "default.png" } }`));
ok("a value and none: fine (an optional)", clean(`fn f(t: Todo): Text? = if t.completed { t.title } else { none }\nview v(t: Todo) { value f(t) }`));

ok("present() of a Bool that is never none: TYPE_MISMATCH, always true", has(`invariant i: all(.completed.present() for Todo where true)`, "present() of bool that is never none is always true"));
ok("blank() of one: always false", has(`fn f(t: Todo): Bool = t.completed.blank()\nview v(t: Todo) { value f(t) }`, "always false"));
ok("present() of text, of optional text, of an optional Int: fine", clean(`invariant i: all(.title.present() and (.note.present() or true) and (.due.present() or true) for Todo where true)`), errors(`invariant i: all(.title.present() and (.note.present() or true) and (.due.present() or true) for Todo where true)`));
process.exit(failed ? 1 : 0);

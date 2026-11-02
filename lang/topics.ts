// `explain` for what is not a declaration: statements, expressions, outcomes and the built-in UI elements.
// Statements and expressions are tables whose examples lang/test/explain-topics.test.ts parses and checks, the way
// lang/shapes.ts is held to the parser; outcomes are facts about the runtime (lang/gogen/rt); elements are
// read from lang/std/ui.crud through lang/reference.ts, so they can't drift.
import { EXAMPLE_BASE } from "./shapes.ts";
import { OUTCOME_DOCS, referenceData } from "./reference.ts";

export type Item = {
  head: string;          // the form
  text: string;          // what it does, plainly
  example?: string;      // checked: it parses and the spec around it checks clean
  params?: string;       // the parameters of the action/view the example sits in (default: n: Note, title: Text)
  extra?: string;        // declarations the example needs
  need?: string[];       // parts that must be there, and what leaving one out says (informational)
};
export type Topic = { name: string; about: string; items: Item[]; notes?: string[] };

const P = "n: Note, title: Text";

export const STATEMENTS: Item[] = [
  { head: "require <condition> else <outcome> [\"reason\"]", text: "Ends the action with that outcome when the condition is false; nothing written so far is kept. Agents are told the reason, or the condition.", example: "require n.owner == actor else forbidden" },
  { head: "reject <outcome> [\"reason\"]", text: "Ends the action with that outcome, always (usually inside an if).", example: "if n.done { reject invalid \"already done\" }" },
  { head: "rate_limit <count> per <duration> by <expression> else <outcome>", text: "At most <count> tries in the window for each value of the expression (here: for each person); refused tries count too.", example: "rate_limit 5 per 1 min by actor else blocked" },
  { head: "create <Entity> { field: value, … } [as x]", text: "Inserts a row. A field left out takes its default. `as x` names the new row for the lines after it.", example: "create Note { title: title, owner: actor } as made" },
  { head: "ensure <Entity> { field: value, … }", text: "Like create, but does nothing when a row with the same unique key already exists.", example: "ensure Tag { name: title }", extra: "entity Tag { name: Text  unique (name) }\npolicy tag_rows: true for rows of Tag" },
  { head: "set <row>.<field> = <value>", text: "Changes one field of a row. A password is stored hashed.", example: "set n.title = title" },
  { head: "touch <row>", text: "Marks the row as updated now, without changing a field.", example: "touch n" },
  { head: "delete <row>", text: "Deletes that row, and does to the rows that refer to it what their `on delete` says.", example: "delete n" },
  { head: "delete <Entity> where <condition>", text: "Deletes every matching row. An entity with a `for writes to` policy refuses this form: loop over the rows instead.", example: "delete Note where .done" },
  { head: "for each <x> in <Entity> where <condition> { … }", text: "Repeats for the rows that match when the loop starts. `.field` in the where means a field of the row being tested.", example: "for each x in Note where .owner == actor { set x.done = true }" },
  { head: "for each <x> in <list> { … }", text: "Repeats for each item of a list.", example: "for each x in [1, 2] { let y = x + 1 }" },
  { head: "if <condition> { … } else if <condition> { … } else { … }", text: "Runs the first block whose condition holds.", example: "if n.done { touch n } else if title == \"a\" { delete n } else { reject invalid }" },
  { head: "match <value> { <a> { … } <b> { … } }", text: "Runs the block for the enum value it has. Every value must be covered (a value list, `a, b { }`, covers several).", example: "match m { glad { touch n } sad { delete n } }", params: "n: Note, m: Mood", extra: "enum Mood { glad, sad }" },
  { head: "let <x> = <value>", text: "Names a value for the rest of the block.", example: "let shout = title + \"!\"" },
  { head: "result <value>", text: "What the action produced, for the screen or API that called it.", example: "result n" },
  { head: "emit <Event>(args)", text: "Starts the event's `after commit on` workflows once the action has committed.", example: "emit Done(n)", extra: "after commit on Done(x) {\n  step a: touch x\n}" },
  { head: "send mail { to: …, subject: …, text: … }", text: "Queues an email (sent after the action commits).", example: "send mail { to: \"a@example.com\", subject: title, text: \"hi\" }" },
];

const E = "n: Note, title: Text, k: Int, m: Mood";
export const EXPRESSIONS: Item[] = [
  { head: "literals", text: "Numbers, \"text\", true, false, none, and lists.", example: "[1, 2, 3]" },
  { head: "a.b", text: "A field of a row. Through a reference it reaches the other row: n.owner.name.", example: "n.owner.name" },
  { head: ".field", text: "Only inside a query's `where`: a field of the row being tested.", example: "count(Note where .done)" },
  { head: "+  -  *  /  %", text: "Arithmetic on numbers; + joins text; a time plus a duration is a time.", example: "k + 1 * 2" },
  { head: "==  !=  <  <=  >  >=", text: "Comparisons. == and != also compare with none.", example: "n.owner != none" },
  { head: "and  or  not", text: "Conditions: `and` binds tighter than `or`.", example: "title == \"a\" and not n.done or k > 1" },
  { head: "<count> <unit>", text: "A duration: one of ms, s, min, h, day, written singular (15 min, 2 h, 365 day).", example: "now + 15 min" },
  { head: "x?  (types) and none", text: "A type ending in ? may be none. An optional value is not text until you say `x != none`; there is no ?? operator.", example: "if n.owner != none { n.owner.name } else { \"nobody\" }" },
  { head: "if <c> { <a> } else { <b> }", text: "A value chosen by a condition.", example: "if k > 1 { \"many\" } else { \"few\" }" },
  { head: "match <value> { <a> { … } … }", text: "A value chosen by an enum value; every value must be covered.", example: "match m { glad { 1 } sad { 2 } }" },
  { head: "exists(E where …)  count(E where …)", text: "Whether any row matches, and how many.", example: "exists(Note where .owner == n.owner and not .done)" },
  { head: "the(E where …)  the_or_none(E where …)  first_or_none(E where …)", text: "One row: `the` must find exactly one (else the action ends not_found), the others give none when nothing matches.", example: "the_or_none(User where .token == title)" },
  { head: "sum(.field for E where …)  avg(.field for E where …)", text: "The total or mean of a number field over the matching rows.", example: "sum(.qty for Line where true)", extra: "entity Line { qty: Int }\npolicy line_rows: true for rows of Line" },
  { head: "json { key: value, … }", text: "A structured value (for data attributes, API replies).", example: "json { a: 1, b: title }" },
  { head: "actor  now", text: "`actor` is the signed-in person (none when signed out); `now` is the current time.", example: "actor != none" },
  { head: "name(args)", text: "A call of one of your fn, a view, or a built-in function (`node lang/cli.ts reference` lists the built-ins: text, lower, contains, label, …).", example: "lower(title)" },
];

export const OUTCOMES: Item[] = [
  { head: "ok", text: "It worked. 200 (an API route may say another success status); a form post goes on to where its <On ok> says." },
  { head: "invalid", text: "A value does not fit: a size, a unique key, an invariant, a `require … else invalid`. 422." },
  { head: "forbidden", text: "The person may not do this. 403." },
  { head: "unauthenticated", text: "Not signed in. 401; a screen's `require … else go sign_in` is the usual friendly form." },
  { head: "not_found", text: "No such row, or not one the person may see. 404." },
  { head: "blocked", text: "A rate limit (`rate_limit … else blocked`) or a rule that blocks, such as a banned address. 429." },
];
export const OUTCOME_NOTES = [
  "How a caller sees them: an API route and the agent API answer with the status above. A form post (/_do/…) answers with a redirect back (303) and an X-Crudspec-Outcome header, plus a flash message for a refusal unless an <On …> handles it. A request with ?fetch=1 (a page script) answers 204 for ok and 422 for any other outcome, with the outcome in X-Crudspec-Outcome.",
  "Which to use: `forbidden` for who (a person may not), `invalid` for what (the values or the state), `not_found` to hide that a row exists, `unauthenticated` when signing in would help, `blocked` for volume or bans.",
];

export const TOPICS: Topic[] = [
  { name: "statements", about: "What an action (and a trigger, a workflow step, a schedule, a migration) can do, one line each", items: STATEMENTS, notes: ["Statements run in order inside one transaction: if the action ends with any outcome but ok, none of its writes are kept."] },
  { name: "expressions", about: "The values and conditions you can write: operators, optional values, durations, queries", items: EXPRESSIONS },
  { name: "outcomes", about: "How an action or view ends, and what the caller sees for each", items: OUTCOMES, notes: OUTCOME_NOTES },
];

// the wrapper a statement or expression example is checked in
export function wrap(topic: "statements" | "expressions", it: Item): string {
  const base = EXAMPLE_BASE + (it.extra ? it.extra + "\n" : "");
  const needsMood = topic === "expressions" || (it.example ?? "").includes("glad") || (it.params ?? "").includes("Mood");
  const mood = needsMood && !(it.extra ?? "").includes("enum Mood") ? "enum Mood { glad, sad }\n" : "";
  if (topic === "statements") return `${base}${mood}action demo(${it.params ?? P}) {\n  ${it.example}\n}\n`;
  return `${base}${mood}view demo(${E}) {\n  value ${it.example}\n}\n`;
}

export function topicOf(name: string): Topic | undefined { return TOPICS.find((t) => t.name === name); }

export function explainTopic(t: Topic): string {
  const out = [t.name, `  ${t.about}`];
  for (const it of t.items) {
    out.push("", `  ${it.head}`, `    ${it.text}`);
    if (it.example) out.push(`    example: ${it.example}`);
  }
  for (const n of t.notes ?? []) out.push("", `  note: ${n}`);
  return out.join("\n");
}

// the built-in UI elements, read from lang/std/ui.crud
export function explainElements(): string {
  const d = referenceData();
  const out = [
    "elements",
    "  The UI. A lowercase tag is plain HTML (<p class=\"note\">Hello {u.name}</p>, <h1>, <div class=\"row\">). An uppercase tag is a built-in",
    "  below, or one of your own components (component Card(title: Text) { … }). `{value}` among the content shows text; a row shows as its `show`",
    "  label and an enum value as its label. <Slot /> and <Fill name=…> hand content to a layout or component. `node lang/cli.ts reference` has every attribute.",
  ];
  for (const e of d.elements) {
    out.push("", `  <${e.name}>  ${e.about ?? ""}`, `    head: ${e.head}`, `    children: ${e.children ? "yes" : "no"}`);
    for (const a of e.attributes) out.push(`    ${a.name}${a.flag ? "" : "={…}"}  ${a.about ?? ""}`);
  }
  return out.join("\n");
}
export const TOPIC_NAMES = ["statements", "expressions", "elements", "outcomes"];
void OUTCOME_DOCS;

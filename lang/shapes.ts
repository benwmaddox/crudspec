// What each kind of declaration is made of, and which parts it must have: the table behind
// `node lang/cli.ts explain`, and the list of an app's settings the checker holds the app to.
//
// It is written by hand (the parser is hand-written too), and held to the parser by
// lang/test/explain.test.ts: every example must check clean, every part marked "required" must
// be refused when it is left out, and every part marked "optional" must be accepted when it is
// there. A part that is "required" here and isn't refused fails that test, so this table cannot
// quietly drift from the language.
//
//   need: "required"     the compiler refuses the declaration without it
//         "optional"     it may be left out
//         "if"           required when something else holds (`when` says what)

export type Need = "required" | "optional" | "if";
export type Part = {
  name: string;          // what it is called when explained
  syntax: string;        // how it is written
  need: Need;
  about: string;
  when?: string;         // for need "if"
  without?: string;      // the declaration without it (for required parts): the test holds it to be refused
  refusal?: string;      // the error code that refuses it, where the test checks one
  accepts?: string;      // a declaration with this part in it (for optional parts): the test holds it to be accepted
};
export type Shape = {
  kind: string;          // the word it starts with
  syntax: string;
  about: string;
  example: string;       // a whole declaration that checks clean beside EXAMPLE_BASE
  parts: Part[];
  notes?: string[];
};

// the declarations the examples may refer to (entities, an identity, a layout, a permission)
export const EXAMPLE_BASE = `entity User { name: Text  token: Text? }
entity Note { title: Text  done: Bool = false  owner: User }
identity login: User.token from cookie "login"
permission read User: true
permission read Note: true
layout l { <Main><Slot name=main /></Main> }
`;

// the settings an \`app\` block takes (the checker refuses any other: APP_SETTING_UNKNOWN)
export const APP_SETTINGS = ["name", "about", "actor", "sign_in", "setup", "setup_when", "indexes", "admin"];

const O = "optional", R = "required", IF = "if";
const p = (name: string, syntax: string, need: Need, about: string, extra: Partial<Part> = {}): Part => ({ name, syntax, need, about, ...extra });

export const SHAPES: Shape[] = [
  // ---- the app
  {
    kind: "app", syntax: "app <name> { settings }", about: "What the runtime needs to know about the app as a whole. The whole block is optional.",
    example: `app shop { name "Shop"  actor User }`,
    parts: [
      p("name", `name "…"`, O, "what the app is called"),
      p("about", `about "…"`, O, "what agents are told the app is for"),
      p("actor", "actor <Entity>", O, "who signs in and acts: the type of `actor`", { when: "agents, `admin` and sign-in are used" }),
      p("sign_in", "sign_in <screen>", O, "where a signed-out visitor is sent"),
      p("setup", "setup <screen>", O, "where the first visit goes while `setup_when` holds"),
      p("setup_when", "setup_when <condition>", O, "when the app is still to be set up (`not exists(User)`)"),
      p("indexes", "indexes auto | declared", O, "keep the indexes the queries want, or only the declared ones"),
      p("admin", "admin <condition about actor>", O, "who may use the generated /_admin section; without it there is none"),
    ],
    notes: ["Any other word is refused (APP_SETTING_UNKNOWN), with the nearest name."],
  },

  // ---- data
  {
    kind: "enum", syntax: "enum <Name> { a, b \"Label\", c was old }", about: "A fixed set of named values a field can hold.",
    example: "enum Stage { draft, live \"Published\", gone was retired }",
    parts: [
      p("values", "a, b, c", R, "the values, separated by commas", { without: "enum Stage", refusal: "PARSE_EXPECTED" }),
      p("label", `a "Label"`, O, "what people see for a value (the name, made readable, otherwise)"),
      p("was", "a was old_name", O, "the value's earlier name, so an upgrade renames it in the data"),
    ],
    notes: ["Value names are shared by every enum in the app: two enums can't both have `completed`."],
  },
  {
    kind: "entity", syntax: "entity <Name> { fields and rules }   singleton <Name> { … }   data <Name> { … } rows [ {…} ]", about: "A kind of row the app stores (a singleton has exactly one row; data is read-only reference data kept in memory).",
    example: "entity Task { title: Text max 80  note: Text?  owner: User on delete cascade\n  done: Bool = false\n  unique (owner, title)\n  invariant length(self.title) > 0 }",
    parts: [
      p("field", "name: Type [settings] [= default]", O, "a column; required of each row unless its type ends in ? or it has a default"),
      p("  max / min", "max N  min N", O, "sizes of a Text (characters)"),
      p("  on delete", "on delete cascade | restrict", O, "what deleting the referenced row does (default restrict)"),
      p("  on change touch", "on change touch", O, "a change to this row updates the referenced row's `updated`"),
      p("  searchable / private / write_only", "searchable  private  write_only", O, "searched by matches(); never shown to agents; written and never read"),
      p("  was", "was old_name", O, "the field's earlier name"),
      p("unique", "unique (a, b)", O, "at most one row for each combination of values"),
      p("index", "index (a, b)", O, "an index for queries that look rows up by a, then b"),
      p("invariant", "invariant <condition over self>", O, "holds for every row after every action"),
      p("transitions", "transitions field { a -> b, c }", O, "the moves an enum field may make; a state with no row is final"),
      p("was", "was OldName", O, "the entity's earlier name"),
    ],
    notes: ["Types: Text Int Bool Time Duration Password File RichText Email Url Ip Json, an enum, another Entity (a reference), T? (optional), set of Entity (parameters only).", "An entity with no fields is accepted."],
  },
  {
    kind: "invariant", syntax: "invariant <name>: <condition>", about: "A fact about the stored data that must hold between actions (the compiler proves each action keeps it).",
    example: "invariant notes_have_owners: all(.owner != none for Note where true)",
    parts: [p("condition", "<condition>", R, "what holds", { without: "invariant notes_have_owners:", refusal: "PARSE_EXPR" })],
  },

  // ---- rules
  {
    kind: "predicate", syntax: "predicate <name>(params) = <condition>", about: "A named condition. It may not call itself.",
    example: "predicate mine(n: Note) = n.owner == actor",
    parts: [p("params", "(name: Type, …)", R, "the arguments", { without: "predicate mine = true", refusal: "PARSE_EXPECTED" }), p("condition", "= <condition>", R, "what it says", { without: "predicate mine(n: Note)", refusal: "PARSE_EXPECTED" })],
  },
  {
    kind: "fn", syntax: "fn <name>(params): <Type> = <expression>", about: "A named pure function of any type. It may not call itself.",
    example: "fn title_of(n: Note): Text = n.title",
    parts: [p("result type", ": <Type>", R, "what it gives back", { without: "fn title_of(n: Note) = n.title", refusal: "PARSE_EXPECTED" })],
  },

  // ---- who may
  {
    kind: "identity", syntax: "identity <name>: <Entity>[.field] from cookie \"x\" | token | path <x>  [as \"{id}-{token}\"]  [where cond]", about: "How a request says who is acting.",
    example: `identity agent: User from token where .name != ""`,
    parts: [
      p("source", "from cookie \"x\" | token | path …", R, "where the proof comes from", { without: "identity agent: User", refusal: "PARSE_EXPECTED" }),
      p("format", `as "{id}-{token}"`, O, "how a path value is laid out"),
      p("where", "where <condition>", O, "who may be this identity"),
    ],
  },
  {
    kind: "gate", syntax: "gate <name>: <condition> -> <outcome>", about: "A check made before every action, in declaration order; an action opts out with `skip gate`.",
    example: "gate not_banned: false -> blocked",
    parts: [p("outcome", "-> outcome", R, "what the caller is told when the condition holds", { without: "gate not_banned: false", refusal: "PARSE_EXPECTED" })],
    notes: ["Outcomes: ok · forbidden · not_found · blocked · invalid · unauthenticated"],
  },
  {
    kind: "permission", syntax: "permission read <Entity>: <condition>", about: "Who may see rows of an entity, wherever they are shown (views, screens, exports, agents).",
    example: "permission read Note: actor != none",
    parts: [p("permission", "one for each entity something lists", IF, "refused when a view, screen or export shows rows of an entity with none", { when: "a view, screen or export lists the entity" })],
  },
  {
    kind: "policy", syntax: "policy <name>: <condition> else <outcome> | go <screen> [flash \"…\"]", about: "A name for a screen's requirement: screens take it with `access <name>`.",
    example: `policy owners: actor != none else forbidden`,
    parts: [p("else", "else outcome | go screen [flash \"…\"]", R, "what happens to a visitor who fails it", { without: "policy owners: actor != none", refusal: "PARSE_EXPECTED" })],
  },

  // ---- doing
  {
    kind: "action", syntax: "action <name>(params) { settings and statements }   internal action <name>(params) { … }", about: "The only way stored data changes. It is atomic: all of its writes apply, or none.",
    example: "action rename(note: Note, title: Text) {\n  agents no\n  require note.owner == actor else forbidden\n  set note.title = title\n}",
    parts: [
      p("params", "(name: Type, name: Type?, name: set of Entity)", O, "what the caller gives; `T?` is optional; a row is looked up when first used"),
      p("skip gate", "skip gate <name>", O, "run without that gate (repeatable); `actor` is none"),
      p("agents no", "agents no", O, "people only: agents can't call it", { accepts: "action a() {\n  agents no\n}" }),
      p("people no", "people no", O, "agents only (the app needs an agent identity, or no one could call it)", { accepts: "identity bot: User from token\naction a() {\n  people no\n}" }),
      p("statements", "…", O, "any of the statements below, in any order"),
    ],
    notes: [
      "internal action: callable only from a channel or a schedule, never from outside.",
      "Statements: require c else outcome [reason] · rate_limit N per <duration> by expr else outcome · create E { f: v } [as x] · ensure E { … } · set x.f = v · touch x · delete x · delete E where … · for each x in E where … { } · for each x in list { } · if … { } else if … { } else { } · match e { a { } b { } } · let x = v · result v · emit Event(args) · send mail { … } · reject outcome · call extern(args)",
      "Outcomes: ok · forbidden · not_found · blocked · invalid · unauthenticated",
      "A comment above an action is what agents read as its description.",
    ],
  },
  {
    kind: "trigger", syntax: "trigger on create <E> as x | delete <E> as x | update <E>.<f> as x | <Event>(x)  [when <condition>] { statements }", about: "Runs inside the action's transaction, just after the write that fires it.",
    example: "trigger on create Note as n {\n  set n.done = false\n}",
    parts: [
      p("event", "on create E as x | …", R, "what fires it", { without: "trigger { }", refusal: "PARSE_EXPECTED" }),
      p("when", "when <condition>", O, "only when it holds (`old.f` is the previous value on an update)"),
    ],
  },
  {
    kind: "workflow", syntax: "workflow on <Event>(x) { step <name>: statements … }", about: "Runs after the action that emitted its event commits, a step at a time; a step is retried until it succeeds, so it must be safe to run twice.",
    example: "workflow on NoteAdded(n) {\n  step tidy: set n.done = false\n}",
    parts: [p("step", "step name: statements", O, "the work, in order; a workflow with no step is accepted, and warned (WORKFLOW_NEVER_RUNS)")],
    notes: ["Only a workflow step may call an extern whose effect is not pure or fetch."],
  },
  {
    kind: "schedule", syntax: "schedule <name> { every <duration> | every day at \"HH:MM\" [in \"Zone\"]; statements }   schedule <name> for x in <E> [where c] { at x.<field> [± duration]; if missed run | skip; statements }", about: "Work the app does by itself when the time comes, past every gate; there is no request, so no `actor`.",
    example: `schedule tidy { every 1 h\n  delete Note where .done }`,
    parts: [
      p("when", "every … | at x.field", R, "a period, or each row's own time (a schedule for rows)", { without: "schedule tidy { delete Note where .done }", refusal: "PARSE_SCHEDULE" }),
      p("if missed", "if missed run | skip", IF, "what happens to rows already past their time when it is first deployed", { when: "the schedule is for rows" }),
    ],
  },
  {
    kind: "migration", syntax: "migration \"<name>\" { statements }", about: "A data change run once, when the app is upgraded.",
    example: `migration "close old notes" {\n  for each n in Note where .done { set n.title = n.title }\n}`,
    parts: [p("name", "a quoted name", R, "what it is called", { without: "migration { }", refusal: "PARSE_MIGRATION" })],
  },

  // ---- reading
  {
    kind: "view", syntax: "view <name>(params) { settings }", about: "What a caller can read: rows of one entity, or one value.",
    example: "view my_notes() {\n  updates live\n  rows Note where .owner == actor\n  order by .title\n  limit 50\n}",
    parts: [
      p("rows or value", "rows <Entity> where … | value <expression>", R, "what it returns (not both)", { without: "view my_notes() { updates live }", refusal: "PARSE_VIEW" }),
      p("updates", "updates live | none", O, "pages showing it are told when it changes", { accepts: "view v() {\n  updates live\n  rows Note where true\n}" }),
      p("require", "require <condition> else <outcome>", O, "who may call it", { accepts: "view v() {\n  require actor != none else forbidden\n  rows Note where true\n}" }),
      p("order", "order by <expr> [desc]", O, "the order of the rows", { accepts: "view v() {\n  rows Note where true\n  order by .title desc\n}" }),
      p("limit / page / window / around", "limit n  page n  window n first|last  around e n", O, "how many rows, or which part of a long list", { accepts: "view v() {\n  rows Note where true\n  limit 5\n}" }),
      p("agents no / people no", "agents no", O, "who may call it", { accepts: "view v() {\n  agents no\n  rows Note where true\n}" }),
    ],
    notes: ["The entity's `permission read` decides which rows anyone may see through it."],
  },
  {
    kind: "export", syntax: "export <name>(params) { route …  format csv|json  of <view>(args) [as row]  [named <expr>]  \"Column\": <expr>, … }", about: "A download of a view's rows, run as the person asking.",
    example: `view all_notes() { rows Note where true }\nexport notes { route "/notes.csv"  format csv  of all_notes() as n  "Title": .title }`,
    parts: [
      p("route", `route "/path"`, R, "its address", { without: `export notes { format csv  of all_notes() as n  "Title": .title }`, refusal: "PARSE_EXPORT" }),
      p("format", "format csv | json", R, "", { without: `export notes { route "/notes.csv"  of all_notes() as n  "Title": .title }`, refusal: "PARSE_EXPORT" }),
      p("of", "of <view>(args) [as row]", R, "the rows", { without: `export notes { route "/notes.csv"  format csv  "Title": .title }`, refusal: "PARSE_EXPORT" }),
      p("named", "named <expr>", O, "the file's name"),
      p("columns", `"Name": <expr>, …`, O, "one column for each; a private field may not be exported"),
    ],
  },
  {
    kind: "api", syntax: "api <name> { route \"…\"  identity <x>  [skip gate g]  get|post|put|patch|delete \"path\" -> <action or view>(…) … }", about: "Routes that call actions and views over HTTP, for another program.",
    example: `api notes_api {\n  route "/api/notes"\n  identity agent\n  get "" -> my_notes()\n}\nview my_notes() { rows Note where true }\nidentity agent: User from token`,
    parts: [
      p("route", `route "/api/…"`, R, "the prefix of its addresses", { without: `api notes_api {\n  identity agent\n}`, refusal: "PARSE_API" }),
      p("identity", "identity <name>", R, "who calls it", { without: `api notes_api {\n  route "/api/notes"\n}`, refusal: "PARSE_API" }),
      p("skip gate", "skip gate <name>", O, "gates that don't apply"),
      p("routes", "method \"path\" -> target [status n] [as json x] [headers {…}] [location e]", O, "what each does"),
    ],
  },
  {
    kind: "channel", syntax: "channel <name>(params) { requires <c>  on open <action>  on close <action>  every <duration> <action> }", about: "A live connection a page keeps open to the app.",
    example: "channel room(u: User) {\n  requires true\n}",
    parts: [p("requires", "requires <condition>", O, "who may connect"), p("on open / on close", "on open <action>", O, "what runs then"), p("every", "every <duration> <action>", O, "what runs while it is open")],
  },
  {
    kind: "signal", syntax: "signal <name>(params) { to <audience>  carries { … }  [requires <c>] }", about: "A message pushed to the pages of whoever should see it.",
    example: "signal typing(u: User) {\n  to u\n  carries { who: Text }\n}",
    parts: [
      p("to", "to <audience>", R, "who gets it", { without: "signal typing(u: User) {\n  carries { who: u.name }\n}", refusal: "PARSE_SIGNAL" }),
      p("carries", "carries { field: value }", R, "what it sends", { without: "signal typing(u: User) {\n  to u\n}", refusal: "PARSE_SIGNAL" }),
      p("requires", "requires <condition>", O, "who may send it"),
    ],
  },

  // ---- showing
  {
    kind: "screen", syntax: "screen <name>(params) { settings; elements }", about: "A page.",
    example: `screen home {\n  route "/"\n  layout l\n  access public\n  <Main><Heading>Hello</Heading></Main>\n}`,
    parts: [
      p("layout", "layout <name>", R, "the frame it fills", { without: `screen home {\n  route "/"\n  <Main><Heading>Hello</Heading></Main>\n}`, refusal: "PARSE_SCREEN" }),
      p("route", `route "/path/:param"`, R, "its address; each :name is one of its parameters", { without: `screen home {\n  layout l\n  <Main><Heading>Hello</Heading></Main>\n}`, refusal: "PARSE_SCREEN" }),
      p("params", "(name: Type, name: Type?)", O, "what its address and query carry"),
      p("access", "access public | signed_in | <policy>", O, "who may open it (default signed_in)", { accepts: `screen home {\n  route "/"\n  layout l\n  access signed_in\n  <Main><Heading>Hello</Heading></Main>\n}` }),
      p("remember", "remember <name>", O, "a cookie that keeps its last parameters", { accepts: `screen home {\n  route "/"\n  layout l\n  remember last\n  <Main><Heading>Hello</Heading></Main>\n}` }),
      p("require", "require <c> else <outcome> | go <screen> flash \"…\"", O, "who may open it, and where the rest are sent", { accepts: `screen home {\n  route "/"\n  layout l\n  require actor != none else forbidden\n  <Main><Heading>Hello</Heading></Main>\n}` }),
      p("elements", "<Main>…</Main>", O, "what it shows"),
    ],
    notes: ["Settings come first, then elements. An element is <Name attrs>content</Name>; a lowercase tag is plain HTML. See `explain elements`."],
  },
  {
    kind: "component", syntax: "component <Name>(params) { elements }", about: "A named piece of UI, used as <Name prop={…} /> . With a <Content /> in its body it takes children.",
    example: `component Card(title: Text) {\n  <Section><Heading>{title}</Heading><Content /></Section>\n}`,
    parts: [
      p("params", "(name: Type, …)", R, "its props", { without: "component Card { <Section></Section> }", refusal: "PARSE_EXPECTED" }),
      p("<Content />", "<Content />  <Content name=x />", O, "where what its user writes between its tags goes; a <Fill name=x> fills a named one"),
    ],
  },
  {
    kind: "layout", syntax: "layout <name> { elements }", about: "The frame screens fill, with named <Slot name=…/> places.",
    example: "layout wide { <Nav><Slot name=nav /></Nav><Main><Slot name=main /></Main> }",
    parts: [p("slots", "<Slot name=main />", O, "at least one, for generated screens to fill")],
  },
  {
    kind: "display", syntax: "display <Entity>: <expression>   avatar <Entity>: <expression>", about: "How a row is labelled in lists and pickers, and pictured (a File, an asset name, or text drawn as initials).",
    example: "display Note: .title",
    parts: [p("expression", ": <expression over the row>", R, "", { without: "display Note:", refusal: "PARSE_EXPR" })],
  },
  {
    kind: "theme", syntax: "theme <name> { stylesheets […]  classes { … }  tokens { … } }", about: "Stylesheets, the classes built-in elements get, and design tokens.",
    example: `theme plain { stylesheets ["app.css"] }`,
    parts: [p("settings", "stylesheets  classes  tokens", O, "an unknown setting is refused (THEME_PROP_UNKNOWN)")],
  },
  {
    kind: "widget", syntax: "widget <name>(params)", about: "Markup written in Go (widgets.go), used as <Widget call={name(args)} />.",
    example: "widget badge(label: Text)",
    parts: [p("params", "(name: Type, …)", R, "what it is given", { without: "widget badge", refusal: "PARSE_EXPECTED" })],
  },

  // ---- outside
  {
    kind: "extern", syntax: "extern fn <name>(params)[: <Type>] effect pure | fetch | <your word> [= go \"pkg\".Func | go Func]", about: "A function written outside the language (Go), and what it does to the world.",
    example: `extern fn shout(t: Text): Text effect pure = go "strings".ToUpper`,
    parts: [
      p("effect", "effect pure | fetch | <name>", R, "pure may be called anywhere; fetch only reads from outside; any other name only in a workflow step", { without: "extern fn shout(t: Text): Text", refusal: "PARSE_EXPECTED" }),
      p("result", ": <Type>", O, "what it gives back (none when left out)"),
      p("= go", `= go "pkg".Func | go Func`, O, "bind it to a Go function (the app's own ext.go, or a library)"),
    ],
  },
  {
    kind: "import", syntax: "import go \"<module>@<version>\"", about: "A Go module an extern binds to, pinned to a version.",
    example: `import go "github.com/google/uuid@v1.6.0"`,
    parts: [p("version", "@v1.2.3", R, "the version", { without: `import go "github.com/google/uuid"`, refusal: "PARSE_IMPORT" })],
  },
];

// the shape of one kind, or a list of the nearest kinds
export const shapeOf = (kind: string): Shape | undefined => SHAPES.find((s) => s.kind === kind);

// what `explain` prints for a kind: the form, what it is for, and each part with how much it is needed
export function explain(s: Shape): string {
  const out: string[] = [s.syntax, `  ${s.about}`];
  const w = Math.max(...s.parts.map((x) => x.name.length), 8), sw = Math.min(Math.max(...s.parts.map((x) => x.syntax.length), 8), 46);
  for (const x of s.parts) {
    const need = x.need === "required" ? "REQUIRED" : x.need === "if" ? "required if" : "optional";
    out.push(`    ${x.name.padEnd(w)}  ${x.syntax.padEnd(sw)}  ${need.padEnd(11)} ${x.about}${x.need === "if" && x.when ? ` (${x.when})` : ""}`);
  }
  for (const n of s.notes ?? []) out.push(`  note: ${n}`);
  out.push("  example:", ...s.example.split("\n").map((l) => `    ${l}`));
  return out.join("\n");
}

// The language reference, generated from the tables the parser, checker and type pass use: every
// UI element with its attributes, every field kind, outcome and builtin. lang/std/ui.crud describes
// the elements and field kinds, this file the rest; test/reference.test.ts fails when a table and
// its descriptions disagree, and when lang/REFERENCE.md isn't what this file generates.
//   node lang/cli.ts reference [--json]
import { readFileSync } from "node:fs";
import { COMMON, ELEMENTS, FIELD_KINDS, FLAG, OUTCOMES, STD_COMPONENTS, STD_DOCS, TAG_OF, attributesOf } from "./parser.ts";
export { attributesOf };
import { BUILTINS, GO_BINDING_TYPES, WIDGETS } from "./check.ts";

// how each kind of head is written
export const HEADS: Record<string, string> = {
  expr: "its value as content: `<x>{expression}</x>`",
  "expr?": "optionally, its value as content: `<x>{expression}</x>` or `<x />`",
  target: "where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms",
  field: '`name=parameter` (one of the form\'s action parameters) and `kind=…` (see field kinds)',
  on: "an outcome (`ok`, `invalid`, …) and what then happens: `go={screen(args)}`, `flash=\"…\"`, `sign_in={user}`, `stay`, `clear_form`, `shake`",
  list: '`of={view(args)}` or `of={Entity where …}`, `as=name`, and optionally `where={…}`, `order={…}`, `desc`',
  each: "written `for each x in xs { … }`",
  if: "written `if c { … } else if d { … } else { … }`",
  let: "written `let name = value`",
  call: "`call={name(args)}`",
  name: "`name=…`",
  "name?": "optionally `name=…`",
  none: "nothing: just its attributes and children",
};

export const OUTCOME_DOCS: Record<string, string> = {
  ok: "it worked", forbidden: "not allowed (403)", not_found: "no such row, or not one the person may see (404)", blocked: "a rate limit (429)",
  invalid: "a value doesn't fit: a size, a unique key, an invariant, a require (422)", unauthenticated: "not signed in (401)",
};

export const BUILTIN_DOCS: Record<string, string> = {
  plain: "plain(x): the text of a value (a RichText's text)",
  text: "text(x): a value as text (an enum value: its declared name)",
  html: "html(x): rich text as HTML",
  rich: "rich(text): text as RichText",
  label: "label(e): an enum value's label",
  mentions: "mentions(rich): the set of people it mentions",
  blank: "blank(x): true when it's none or empty",
  present: "present(x): true when it isn't blank",
  authenticates: "authenticates(stored, given): whether a password matches",
  token: "token(n): a random alphanumeric text of length n",
  signed: "signed(row, purpose, expires): a tamper-proof reference to a row",
  verify: "verify(Entity, text, purpose): the row a signed reference names, or none",
  join: "join(list, separator): a list's texts joined",
  split: "split(text) the list of its words; split(text, sep) its parts",
  chunks: "chunks(text, n): the text in pieces of n characters",
  sentence: "sentence(list): \"a, b and c\"",
  any: "any(list): whether a list of conditions has a true one",
  count: "count(list or query): how many",
  first: "first(list) the first item, or none; first(list, n) the first n",
  last: "last(list) the last item, or none; last(list, n) the last n",
  distinct: "distinct(list): without repeats",
  set: "set(x): a set of rows, from rows or a list",
  words: "words(text): the number of words",
  initials: "initials(text): the first letters of its words",
  first_word: "first_word(text): its first word",
  after: "after(text, prefix): the text after the prefix",
  lower: "lower(text): in lower case",
  upper: "upper(text): in upper case",
  trim: "trim(text): without surrounding spaces",
  length: "length(text): its length in characters",
  contains: "contains(text, part): whether it contains the part",
  starts_with: "starts_with(text, prefix): whether it starts with the prefix",
  replace: "replace(text, old, new): with each old replaced",
  public_ip: "public_ip(address): whether an IP address is public",
  scheme: "scheme(url): its scheme (`https`)",
  port: "port(url): its port",
  host_within: "host_within(url, domain): whether its host is the domain or under it",
  url: "url(text): text as an address",
  url_of: "url_of(file): a file's address",
  host: "host(url): its host",
  path: "path(url): its path",
  with_host: "with_host(url, host): with another host",
  file: "file(bytes, name, content_type): a file",
  request_file: "request_file(name): a file uploaded with the request, or none",
  words_only: "words_only(text): with punctuation removed",
  max: "max(a, b): the larger",
  min: "min(a, b): the smaller",
  cookie: "cookie(name): a cookie's value, or none",
  download: "download(file): a file's download address",
  matches: "matches(text, pattern): whether it matches a pattern",
};

// written among the elements as statements are among statements, not as tags
export const CONTROL_DOCS: Record<string, string> = { if: "the block, only when the condition holds", let: "names a value for the rest of the block", each: "the items of a list, each shown by the block" };
export const CONTROL_FORMS: Record<string, string> = {
  if: "{if c { … } else if d { … } else { … }}",
  let: "{let name = value}",
  each: "{for each x in xs { … }}",
};
const TEXT_HEAD = 'its text as content: raw text and `{expression}`, as `<Text>{n} items left</Text>` (spaces and line breaks show as one space; write `{"{"}`, `{"}"}` and `{"<"}` for those characters)';

export function referenceData() {
  return {
    control: Object.entries(CONTROL_FORMS).map(([name, form]) => ({ name, form, about: CONTROL_DOCS[name] })),
    elements: Object.entries(ELEMENTS).filter(([name]) => !(name in CONTROL_FORMS)).map(([name, e]) => ({
      name: TAG_OF[name], about: STD_DOCS.elements[name], head: e.text ? TEXT_HEAD : HEADS[e.head], children: !!e.block,
      attributes: Object.entries(e.attrs).map(([a, k]) => ({ name: a, flag: k === FLAG, about: STD_DOCS.attrs[name]?.[a] })),
    })),
    std_components: [...STD_COMPONENTS.values()].map((d) => ({ name: d.name, about: STD_DOCS.components[d.name], params: d.params.map((x: any) => x.name) })),
    common_attributes: Object.entries(COMMON).map(([a, k]) => ({ name: a, flag: k === FLAG, about: STD_DOCS.common[a] })),
    field_kinds: [...FIELD_KINDS].map((k) => ({ name: k, about: STD_DOCS.fieldKinds[k] })),
    outcomes: OUTCOMES.map((o) => ({ name: o, about: OUTCOME_DOCS[o] })),
    builtins: Object.entries(BUILTINS).map(([n, [lo, hi]]) => ({ name: n, args: lo === hi ? String(lo) : `${lo}-${hi}`, about: BUILTIN_DOCS[n] })),
    widgets: [...WIDGETS],
    go_binding_types: Object.entries(GO_BINDING_TYPES).map(([spec, go]) => ({ spec, go })),
  };
}

const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);
export function reference(): string {
  const d = referenceData();
  const out: string[] = [];
  const attr = (a: { name: string; flag: boolean; about?: string }) => `\`${a.name}${a.flag ? "" : "={…}"}\` ${a.about ?? ""}`;
  out.push("# crudspec reference", "", "Generated from the parser, checker and type pass (`node lang/cli.ts reference`). Don't edit: `lang/std/ui.crud` describes the elements and field kinds, `lang/reference.ts` the rest. `LANGUAGE.md` explains the language; this lists everything in it.", "");
  out.push("## UI elements", "", "`<name attr=\"text\" attr={expression} flag>children</name>`, or `<name … />`. An attribute shown as `name={…}` takes a value (`\"text\"` or `{expression}`); one shown bare is a flag.", "");
  for (const e of d.elements) {
    out.push(`### \`<${e.name}>\``, "", e.about ?? "", "",`- **Head:** ${e.head}.`, `- **Children:** ${e.children ? "yes" : "no"}.`);
    if (e.attributes.length) out.push(`- **Attributes:** ${e.attributes.map(attr).join("; ")}.`);
    out.push("");
  }
  out.push("### On every element", "", ...d.common_attributes.map((a) => `- ${attr(a)}`), "");
  out.push("### Content", "", "An element's content, and a block's, is text as it shows, `{expression}` (its value, as text) and elements: `<p>Hello {u.name}!</p>`. A run of only spaces and line breaks is nothing (write a space between two elements `{\" \"}`); other line breaks and the spaces around them show as one space. `//` at the start of a line or after a space starts a comment. Write `{\"{\"}`, `{\"}\"}` and `{\"<\"}` for those characters. Code goes in braces, its blocks content again:", "",
    ...d.control.map((c) => `- \`${c.form}\`: ${c.about}.`),
    "- `{match e { a { … } b, c { … } none { … } }}`: the block of the arm for e's value. e is an enum value (optional or not); each of the enum's values has exactly one arm, and `none` one too when e is optional. A match has no else, so a value added to the enum later has to be handled too.", "");
  out.push("### Components", "", "A component is used by its own tag, its parameters as props in order from the first: `<MessageItem m={m} />` (a component is named with a capital, as its tag is).", "",
    "The standard library's components (`lang/std/components.crud`), which an app has without declaring them, and which are compiled only when its UI uses them:", "",
    ...d.std_components.map((c) => `- \`<${c.name}${c.params.map((x: string) => ` ${x}={…}`).join("")} />\`: ${c.about}`), "");
  out.push("## Field kinds", "", ...d.field_kinds.map((k) => `- \`${k.name}\`: ${k.about}`), "");
  out.push("## Outcomes", "", ...d.outcomes.map((o) => `- \`${o.name}\`: ${o.about}`), "");
  out.push("## Builtin functions", "", ...d.builtins.map((b) => `- \`${b.name}\` (${b.args} argument${b.args === "1" ? "" : "s"}): ${b.about}`), "");
  out.push("## Built-in widgets", "", d.widgets.map((w) => `\`${w}\``).join(", "), "");
  out.push("## Externs and Go bindings", "",
    "`extern fn name(params): Result effect E`, optionally ending `= go \"pkg\".Func` (a Go package's function) or `= go Func` (one in the app's `ext.go`). A module outside the standard library is pinned with `import go \"module@version\"`. `node lang/cli.ts bind <package>` prints the lines for a package.", "",
    "- **Effects:** `pure` (the same arguments give the same result; reads and changes nothing outside the app) may be called anywhere. `fetch` (only reads from outside) may be called in workflow steps and value views. Any other name (`mail`, `http`, …) may be called in workflow steps only.",
    "- **Results from Go:** none; a value; `error`, seen as `Text?` (the message, none when it worked); `(value, error)`, seen as the value made optional.", "",
    "| Spec type | Go type |", "| --- | --- |", ...d.go_binding_types.map((t) => `| \`${t.spec}\` | ${t.go} |`), "");
  out.push("## Checks", "", "What `check` (and `--deep`, and `build`) reports, by code: an error stops the build; a warning names a likely mistake. Read from the checkers' own source, with what each message says (… is a name or value the message fills in). `LANGUAGE.md` explains the deep ones.", "",
    "| Code | | Pass | Says |", "| --- | --- | --- | --- |", ...checkCodes().map((c) => `| \`${c.code}\` | ${c.severity} | ${c.pass} | ${c.says.replace(/\|/g, "\\|")} |`), "");
  return out.join("\n");
}

// ---- the checks: every code the checker, the type pass, the deep checks, the cost pass and the
// parser report, read from their source, each with what its message says (a `${…}` in it is shown
// as …), or the description in the file's header where it has one; so the list can't fall behind
export type CheckCode = { code: string; severity: "error" | "warning"; pass: string; says: string };
export function checkCodes(): CheckCode[] {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  // the literal starting at s[i] (a `template`, "string" or 'string'), with its ${…} parts as …,
  // and the index just past it
  const scanLit = (s: string, i: number): { text: string; end: number } => {
    const q = s[i]; let out = "", j = i + 1;
    while (j < s.length && s[j] !== q) {
      if (s[j] === "\\") { out += s[j + 1]; j += 2; continue; }
      if (q === "`" && s[j] === "$" && s[j + 1] === "{") {
        let depth = 1; j += 2;
        while (j < s.length && depth) { const c = s[j]; if (c === "{") depth++; else if (c === "}") depth--; else if (c === "`" || c === '"' || c === "'") { j = scanLit(s, j).end; continue; } j++; }
        out += "…"; continue;
      }
      out += s[j]; j++;
    }
    return { text: out, end: j + 1 };
  };
  const literal = (s: string, i: number) => scanLit(s, i).text;
  const tidy = (t: string) => t.replace(/(…\s*)+…/g, "…").replace(/\s+/g, " ").trim();
  const header = (src: string) => {
    const m = new Map<string, string>(); let last = "";
    for (const line of src.split("\n")) {
      if (!line.startsWith("//")) { if (m.size) break; continue; }
      const h = line.match(/^\/\/\s+([A-Z][A-Z_]{3,})\s{2,}(.*)$/);
      if (h) { last = h[1]; m.set(last, h[2].trim()); }
      else if (last && /^\/\/\s{6,}\S/.test(line)) m.set(last, `${m.get(last)} ${line.replace(/^\/\/\s+/, "").trim()}`);
      else last = "";
    }
    return m;
  };
  const out = new Map<string, CheckCode>();
  const add = (code: string, severity: CheckCode["severity"], pass: string, says: string) => { if (!out.has(code)) out.set(code, { code, severity, pass, says: tidy(says) }); };
  const scan = (file: string, pass: string, re: RegExp, sev: (m: RegExpExecArray) => CheckCode["severity"]) => {
    const src = read(file), desc = header(src);
    for (const m of src.matchAll(re)) {
      const code = m.groups!.code;
      const at = m.index! + m[0].length;
      // the message: the first literal after the code that isn't the operand of a comparison
      let says = "";
      for (let j = at; j < at + 400 && j < src.length; j++) {
        if (src[j] !== "`" && src[j] !== '"') continue;
        const l = scanLit(src, j);
        if (/[=!]==?\s*$/.test(src.slice(at, j))) { j = l.end - 1; continue; }
        says = l.text; break;
      }
      add(code, sev(m as RegExpExecArray), pass, desc.get(code) ?? says);
    }
  };
  scan("./parser.ts", "parse", /fail\("(?<code>[A-Z][A-Z_]{3,})",\s*/g, () => "error");
  scan("./check.ts", "check", /\b(?<fn>err|warn)\("(?<code>[A-Z][A-Z_]{3,})",[^,]*,\s*/g, (m) => (m.groups!.fn === "err" ? "error" : "warning"));
  scan("./types.ts", "types", /report\("(?<sev>error|warning)", "(?<code>[A-Z][A-Z_]{3,})",[^,]*,\s*/g, (m) => m.groups!.sev as CheckCode["severity"]);
  scan("./deep.ts", "deep", /\bwarn\("(?<code>[A-Z][A-Z_]{3,})",[^,]*,\s*/g, () => "warning");
  scan("./deep.ts", "deep", /severity: "error", code: "(?<code>[A-Z][A-Z_]{3,})"/g, () => "error");
  for (const [code, says] of header(read("./cost.ts"))) add(code, "warning", "cost", says);
  add("INVARIANT_BROKEN", "error", "build", "an action or workflow step can break an invariant: the proof's counterexample");
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
}

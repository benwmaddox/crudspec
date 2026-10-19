// The language reference, generated from the tables the parser, checker and type pass use: every
// UI element with its attributes, every field kind, outcome and builtin. The descriptions are
// here; test/reference.test.ts fails when a table and its descriptions disagree, and when
// lang/REFERENCE.md isn't what this file generates.
//   node lang/cli.ts reference [--json]
import { COMMON, ELEMENTS, FIELD_KINDS, FLAG, OUTCOMES, attributesOf } from "./parser.ts";
export { attributesOf };
import { BUILTINS, GO_BINDING_TYPES, WIDGETS } from "./check.ts";

// how each kind of head is written
export const HEADS: Record<string, string> = {
  expr: "its value as content: `<x>{expression}</x>`",
  "expr?": "optionally, its value as content: `<x>{expression}</x>` or `<x />`",
  target: "where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms",
  field: '`name=parameter` (one of the form\'s action parameters) and `kind=…` (see field kinds)',
  on: "an outcome (`ok`, `invalid`, …) and what then happens: `go={screen(args)}`, `flash=\"…\"`, `sign_in_as={user}`, `stay`, `clear`, `shake`",
  list: '`of={view(args)}` or `of={Entity where …}`, `as=name`, and optionally `where={…}`, `order={…}`, `desc`',
  each: "written `for each x in xs { … }`",
  if: "written `if c { … } else if d { … } else { … }`",
  let: "written `let name = value`",
  call: "`call={name(args)}`",
  name: "`name=…`",
  "name?": "optionally `name=…`",
  none: "nothing: just its attributes and children",
};

export const ELEMENT_DOCS: Record<string, string> = {
  heading: "a page or section heading",
  text: "a piece of text; a row shows its entity's display, an enum value its label",
  strong: "emphasised text",
  richtext: "formatted text (a RichText value)",
  time: "a time, as a date, a time of day or relative",
  image: "an image from a file or a path under the assets",
  icon: "an icon by name, from the assets' images",
  avatar: "a person's avatar",
  avatars: "a row of avatars, for a set of people",
  separator: "a horizontal rule",
  field_display: "a label and a value, read only",
  link: "a link to a screen or an address",
  button: "a button that runs an action (a one-button form)",
  form: "a form for an action; its fields are the action's parameters",
  field: "a form field for one of the action's parameters",
  switch: "an on/off switch",
  submit: "the form's submit button",
  on: "what happens after a form or button's action ends with an outcome",
  list: "the rows of a view or a query, each shown by the children with the row bound to `as`",
  each: "the items of a list, each shown by the block",
  if: "the block, only when the condition holds",
  let: "names a value for the rest of the block",
  use: "a component (written as the component's own tag: `<message_item m={m} />`)",
  widget: "a runtime or app widget (`copy_button`, `share_button`, `qr_link`, `lightbox`, `autocomplete`, `push_permission`, or one the app declares)",
  channel: "keeps a declared channel open while the page is",
  signal: "shows a declared signal (typing indicators and the like)",
  section: "a section, optionally with a legend",
  row: "a horizontal group",
  column: "a vertical group",
  menu: "a menu of links and buttons",
  popup: "a button that opens a panel",
  dialog: "a dialog",
  frame: "a frame (a group the page refreshes on its own)",
  go: "goes to a screen at once (in a screen's if: a redirect)",
  title: "the page's title",
  slot: "where a screen's part goes, in a layout",
  flash: "where flash messages show, in a layout",
  nav: "the screen's navigation part (a layout slot)",
  main: "the screen's main part (a layout slot)",
  footer: "the screen's footer part (a layout slot)",
  aside: "an aside, optionally a named slot",
  sidebar: "the screen's sidebar part (a layout slot)",
};

export const ATTR_DOCS: Record<string, string> = {
  // on every element
  class: "a styling hint for the theme",
  id: "the element's HTML id",
  label: "its label: visible text on a link, button or submit without an icon or text; otherwise read out by screen readers",
  icon: "an icon shown with it",
  title: "a tooltip",
  data: "data attributes, from a json value",
  if: "shows the element only when this holds",
  // element-specific
  autolink: "links addresses in the text",
  as: "how a time shows: `{date}`, `{time}` or `{relative}`",
  width: "the image's width",
  height: "the image's height",
  large: "a large avatar",
  readonly: "shown read only",
  unread: "marks the link unread when this holds",
  text: "the button's visible text",
  confirm: "asks for confirmation first, with this question",
  reveal: "reveals the button's children instead of submitting at once",
  selected: "shows the button as selected when this holds",
  auto_submit: "submits when a field changes",
  readonly_unless: "the form is read only unless this holds",
  disabled: "the form is disabled when this holds",
  submit_on: "submits on this key (`\"enter\"`)",
  value: "the field's starting value",
  placeholder: "the field's placeholder",
  required: "the field must be filled in",
  maxlength: "the field's longest value (a sized field or parameter gets one by itself)",
  multiple: "a file field takes several files",
  preview: "a file field previews its image here",
  from: "a choice, select or users field's choices: a list",
  filter_over: "a users field filters its choices past this many",
  autocomplete: "a field picks from a view's rows as you type",
  mentions: "a rich-text field offers @mentions from a view",
  unfurl: "a rich-text field previews pasted links with a value view",
  drafts: "a rich-text field keeps a draft in the browser",
  rows: "a textarea's height in lines",
  role: "the field's ARIA role",
  accept: "the file types a file field takes (`\"image/*\"`)",
  on: "the switch starts on",
  off: "the switch starts off",
  link: "the switch goes to this screen when changed",
  caption: "a widget's caption",
  indicator: "shows a signal as an indicator",
  legend: "a section's legend",
  banned: "marks a row or section banned when this holds",
  panel: "the class of a popup's panel",
};

export const FIELD_KIND_DOCS: Record<string, string> = {
  text: "one line of text", email: "an email address", password: "a password", richtext: "formatted text with mentions and attachments",
  file: "a file upload", textarea: "several lines of text", users: "a set of people (from `from` or `autocomplete`)",
  select: "one row, from `from`", hidden: "a hidden value", url: "an address", code: "a short code", number: "a whole number (an Int)",
  choice: "one of a list: an enum's values (shown by their labels) or true/false",
  datetime: "a date and time (a Time), picked in the person's own time zone (their browser's), which the form sends along",
  date: "a date (a Time: its midnight, in the person's time zone)", time: "a time of day, as text (\"08:30\")",
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
export const CONTROL_FORMS: Record<string, string> = {
  if: "if c { … } else if d { … } else { … }",
  let: "let name = value",
  each: "for each x in xs { … }",
};
const TEXT_HEAD = 'its text as content: raw text and `{expression}`, as `<text>{n} items left</text>` (spaces and line breaks show as one space; write `{"{"}`, `{"}"}` and `{"<"}` for those characters)';
const TEXT_ELEMENTS = new Set(["text", "heading", "strong", "title"]);
export function referenceData() {
  return {
    control: Object.entries(CONTROL_FORMS).map(([name, form]) => ({ name, form, about: ELEMENT_DOCS[name] })),
    elements: Object.entries(ELEMENTS).filter(([name]) => !(name in CONTROL_FORMS)).map(([name, e]) => ({
      name, about: ELEMENT_DOCS[name], head: TEXT_ELEMENTS.has(name) ? TEXT_HEAD : HEADS[e.head], children: !!e.block,
      attributes: Object.entries(e.attrs).map(([a, k]) => ({ name: a, flag: k === FLAG, about: ATTR_DOCS[a] })),
    })),
    common_attributes: Object.entries(COMMON).map(([a, k]) => ({ name: a, flag: k === FLAG, about: ATTR_DOCS[a] })),
    field_kinds: [...FIELD_KINDS].map((k) => ({ name: k, about: FIELD_KIND_DOCS[k] })),
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
  out.push("# crudspec reference", "", "Generated from the parser, checker and type pass (`node lang/cli.ts reference`). Don't edit: `lang/reference.ts` holds the descriptions. `LANGUAGE.md` explains the language; this lists everything in it.", "");
  out.push("## UI elements", "", "`<name attr=\"text\" attr={expression} flag>children</name>`, or `<name … />`. An attribute shown as `name={…}` takes a value (`\"text\"` or `{expression}`); one shown bare is a flag.", "");
  for (const e of d.elements) {
    out.push(`### \`<${e.name}>\``, "", `${cap(e.about)}.`, "", `- **Head:** ${e.head}.`, `- **Children:** ${e.children ? "yes" : "no"}.`);
    if (e.attributes.length) out.push(`- **Attributes:** ${e.attributes.map(attr).join("; ")}.`);
    out.push("");
  }
  out.push("### On every element", "", ...d.common_attributes.map((a) => `- ${attr(a)}`), "");
  out.push("### Among the elements", "", "Written among elements, as statements are among statements:", "",
    ...d.control.map((c) => `- \`${c.form}\`: ${c.about}.`),
    "- `match e { a { … } b, c { … } none { … } }`: the block of the arm for e's value. e is an enum value (optional or not); each of the enum's values has exactly one arm, and `none` one too when e is optional. A match has no else, so a value added to the enum later has to be handled too.", "");
  out.push("### Components", "", "A component is used by its own tag, its parameters as props in order from the first: `<message_item m={m} />`.", "");
  out.push("## Field kinds", "", ...d.field_kinds.map((k) => `- \`${k.name}\`: ${k.about}`), "");
  out.push("## Outcomes", "", ...d.outcomes.map((o) => `- \`${o.name}\`: ${o.about}`), "");
  out.push("## Builtin functions", "", ...d.builtins.map((b) => `- \`${b.name}\` (${b.args} argument${b.args === "1" ? "" : "s"}): ${b.about}`), "");
  out.push("## Built-in widgets", "", d.widgets.map((w) => `\`${w}\``).join(", "), "");
  out.push("## Externs and Go bindings", "",
    "`extern fn name(params): Result effect E`, optionally ending `= go \"pkg\".Func` (a Go package's function) or `= go Func` (one in the app's `ext.go`). A module outside the standard library is pinned with `import go \"module@version\"`. `node lang/cli.ts bind <package>` prints the lines for a package.", "",
    "- **Effects:** `pure` (the same arguments give the same result; reads and changes nothing outside the app) may be called anywhere. `fetch` (only reads from outside) may be called in workflow steps and value views. Any other name (`mail`, `http`, …) may be called in workflow steps only.",
    "- **Results from Go:** none; a value; `error`, seen as `Text?` (the message, none when it worked); `(value, error)`, seen as the value made optional.", "",
    "| Spec type | Go type |", "| --- | --- |", ...d.go_binding_types.map((t) => `| \`${t.spec}\` | ${t.go} |`), "");
  return out.join("\n");
}

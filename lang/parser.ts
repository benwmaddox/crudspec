// Parser for crudspec v2 (lang/LANGUAGE.md). Newlines don't matter anywhere. The UI is
// TSX-style markup (see markup() below); the rest is declarations and expressions.

export type Pos = { line: number; col: number };
export type Tok = { t: "id" | "str" | "int" | "p" | "eof"; v: string; pos: Pos };
export type Expr = { kind: string; pos: Pos; [k: string]: any };
export type Stmt = { kind: string; pos: Pos; [k: string]: any };
export type El = { kind: "el"; name: string; head: any; attrs: Record<string, Expr | true>; children: El[]; else?: El[]; pos: Pos };
export type Decl = { kind: string; name: string; pos: Pos; [k: string]: any };
export type Spec = { decls: Decl[] };

export class SpecError extends Error {
  pos: Pos; code: string;
  constructor(code: string, message: string, pos: Pos) { super(`${pos.line}:${pos.col} ${code}: ${message}`); this.code = code; this.pos = pos; }
}

export const OUTCOMES = ["ok", "forbidden", "not_found", "blocked", "invalid", "unauthenticated"];
const PUNCT = ["==", "!=", "<=", ">=", "->", "{", "}", "(", ")", "[", "]", ",", ":", ".", "=", "<", ">", "?", "+", "-", "*", "/"];
const DURATION_UNITS = new Set(["ms", "s", "min", "h", "day"]);

export function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, line = 1, col = 1;
  const adv = (n: number) => { for (let k = 0; k < n; k++) { if (src[i] === "\n") { line++; col = 1; } else col++; i++; } };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { adv(1); continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") adv(1); continue; }
    const pos = { line, col };
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++; toks.push({ t: "id", v: src.slice(i, j), pos }); adv(j - i); continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < src.length && /[0-9]/.test(src[j])) j++; toks.push({ t: "int", v: src.slice(i, j), pos }); adv(j - i); continue; }
    if (c === '"') {
      let j = i + 1, out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && (src[j + 1] === '"' || src[j + 1] === "\\")) { out += src[j + 1]; j += 2; }
        else if (src[j] === "\\" && src[j + 1] === "n") { out += "\n"; j += 2; }   // a line break (mail text, say)
        else if (src[j] === "\n") throw new SpecError("LEX_STRING", "unterminated string", pos);
        else { out += src[j]; j++; }
      }
      if (j >= src.length) throw new SpecError("LEX_STRING", "unterminated string", pos);
      toks.push({ t: "str", v: out, pos }); adv(j + 1 - i); continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) throw new SpecError("LEX_CHAR", `unexpected character '${c}'`, pos);
    toks.push({ t: "p", v: p, pos }); adv(p.length);
  }
  toks.push({ t: "eof", v: "", pos: { line: line + 1, col: 1 } });
  return toks;
}

// ---- UI vocabulary: element names, and the attributes each may carry.
// An attribute is either a flag or takes one expression.
export const FLAG = 0, VALUE = 1;
export const COMMON: Record<string, number> = { class: VALUE, id: VALUE, label: VALUE, icon: VALUE, title: VALUE, data: VALUE, if: VALUE };
export const ELEMENTS: Record<string, { head: string; attrs: Record<string, number>; block?: boolean }> = {
  heading: { head: "expr", attrs: {} },
  text: { head: "expr", attrs: {} },
  strong: { head: "expr", attrs: {} },
  richtext: { head: "expr", attrs: { autolink: FLAG } },
  time: { head: "expr", attrs: { as: VALUE } },
  image: { head: "expr", attrs: { width: VALUE, height: VALUE } },
  icon: { head: "expr", attrs: {} },
  avatar: { head: "expr", attrs: { large: FLAG } },
  avatars: { head: "expr", attrs: {} },
  separator: { head: "none", attrs: {} },
  field_display: { head: "expr", attrs: { readonly: FLAG, label: VALUE } },
  link: { head: "target", attrs: { unread: VALUE }, block: true },
  button: { head: "target", attrs: { text: VALUE, confirm: VALUE, reveal: FLAG, selected: VALUE }, block: true },
  form: { head: "target", attrs: { auto_submit: FLAG, readonly_unless: VALUE, disabled: VALUE, submit_on: VALUE }, block: true },
  field: { head: "field", attrs: { value: VALUE, placeholder: VALUE, required: FLAG, maxlength: VALUE, multiple: FLAG, preview: VALUE, from: VALUE,
    filter_over: VALUE, autocomplete: VALUE, mentions: VALUE, unfurl: VALUE, drafts: FLAG, rows: VALUE, role: VALUE, accept: VALUE } },
  switch: { head: "none", attrs: { on: FLAG, off: FLAG, value: VALUE, link: VALUE, auto_submit: FLAG } },
  submit: { head: "none", attrs: {} },
  on: { head: "on", attrs: {} },
  list: { head: "list", attrs: {}, block: true },
  each: { head: "each", attrs: {}, block: true },
  if: { head: "if", attrs: {}, block: true },
  let: { head: "let", attrs: {} },
  use: { head: "call", attrs: {} },
  widget: { head: "call", attrs: { caption: VALUE } },
  channel: { head: "call", attrs: {} },
  signal: { head: "call", attrs: { indicator: FLAG } },
  section: { head: "none", attrs: { legend: VALUE, banned: VALUE }, block: true },
  row: { head: "none", attrs: { banned: VALUE }, block: true },
  column: { head: "none", attrs: {}, block: true },
  menu: { head: "none", attrs: {}, block: true },
  popup: { head: "none", attrs: { panel: VALUE }, block: true },
  dialog: { head: "none", attrs: {}, block: true },
  frame: { head: "none", attrs: {}, block: true },
  go: { head: "target", attrs: {} },
  title: { head: "expr?", attrs: {} },
  slot: { head: "name", attrs: {} },
  flash: { head: "none", attrs: {} },
  nav: { head: "none", attrs: {}, block: true },
  main: { head: "none", attrs: {}, block: true },
  footer: { head: "none", attrs: {}, block: true },
  aside: { head: "name?", attrs: {}, block: true },
  sidebar: { head: "none", attrs: {}, block: true },
};
// what an element takes, for errors: its head's attributes, then its own, then the common ones
export function attributesOf(name: string): string[] {
  const spec = ELEMENTS[name];
  if (!spec) return [];
  const head: Record<string, string[]> = { target: name === "button" || name === "form" ? ["action"] : ["to", "href"], field: ["name", "kind"], list: ["of", "as", "where", "order", "desc"],
    each: ["as", "in"], if: ["test"], let: ["name", "value"], call: ["call"], name: ["name"], "name?": ["name"] };
  return [...(head[spec.head] ?? []), ...Object.keys(spec.attrs), ...Object.keys(COMMON)];
}
export const FIELD_KINDS = new Set(["text", "email", "password", "richtext", "file", "textarea", "users", "select", "hidden", "url", "code", "number", "choice", "datetime", "date", "time"]);

export function parse(src: string): Spec {
  const toks = lex(src);
  let k = 0;
  const peek = (o = 0) => toks[k + o];
  const at = (v: string, o = 0) => { const t = toks[k + o]; return (t.t === "p" || t.t === "id") && t.v === v; };
  const next = () => toks[k++];
  const fail = (code: string, msg: string, t = peek()): never => { throw new SpecError(code, msg, t.pos); };
  const expect = (v: string) => { if (!at(v)) fail("PARSE_EXPECTED", `expected '${v}', found '${peek().v || "end of file"}'`); return next(); };
  const ident = (what = "a name") => { const t = peek(); if (t.t !== "id") fail("PARSE_EXPECTED", `expected ${what}, found '${t.v || "end of file"}'`); return next().v; };
  const outcome = () => { const t = peek(); const v = ident("an outcome"); if (!OUTCOMES.includes(v)) fail("PARSE_OUTCOME", `unknown outcome '${v}' (expected ${OUTCOMES.join(", ")})`, t); return v; };

  function typeRef(): any {
    if (at("set") && at("of", 1)) { next(); next(); return { kind: "set", of: ident("an entity name") }; }
    if (at("list") && at("of", 1)) { next(); next(); return { kind: "list", of: typeRef() }; }
    const name = ident("a type");
    const optional = at("?") ? (next(), true) : false;
    return { kind: "named", name, optional };
  }
  function params(): any[] {
    expect("("); const ps: any[] = [];
    while (!at(")")) {
      const pos = peek().pos; const name = ident("a parameter name"); expect(":"); const p: any = { name, type: typeRef(), pos };
      for (;;) { if (at("max") && peek(1).t === "int") { next(); p.max = Number(next().v); continue; } if (at("min") && peek(1).t === "int") { next(); p.min = Number(next().v); continue; } break; }
      ps.push(p); if (!at(")")) expect(",");
    }
    expect(")"); return ps;
  }

  // ---- expressions: implies < or < and < not < comparison < additive < multiplicative < postfix < primary
  function expr(): Expr { return implies(); }
  function implies(): Expr { let l = or(); while (at("implies")) { const pos = next().pos; l = { kind: "binary", op: "implies", left: l, right: or(), pos }; } return l; }
  function or(): Expr { let l = and(); while (at("or")) { const pos = next().pos; l = { kind: "binary", op: "or", left: l, right: and(), pos }; } return l; }
  function and(): Expr { let l = not(); while (at("and")) { const pos = next().pos; l = { kind: "binary", op: "and", left: l, right: not(), pos }; } return l; }
  function not(): Expr { if (at("not")) { const pos = next().pos; return { kind: "unary", op: "not", arg: not(), pos }; } return cmp(); }
  function cmp(): Expr {
    const l = add();
    for (const op of ["==", "!=", "<=", ">=", "<", ">", "in"]) if (at(op)) { const pos = next().pos; return { kind: "binary", op, left: l, right: add(), pos }; }
    return l;
  }
  function add(): Expr {
    let l = mul();
    while ((at("+") || at("-")) && !(at("-") && peek(1).t === "p" && peek(1).v === ">")) { const pos = peek().pos; const op = next().v; l = { kind: "binary", op, left: l, right: mul(), pos }; }
    return l;
  }
  function mul(): Expr { let l = postfix(); while (at("*") || (at("/") )) { const pos = peek().pos; const op = next().v; l = { kind: "binary", op, left: l, right: postfix(), pos }; } return l; }
  function postfix(): Expr {
    let e = primary();
    while (at(".") && peek(1).t === "id") { const pos = next().pos; e = { kind: "field", target: e, name: next().v, pos }; }
    return e;
  }
  // E where p order by e [desc] limit n
  function query(): any {
    const entity = ident("an entity name");
    let where: Expr | undefined, order: Expr | undefined, desc = false, limit: Expr | undefined;
    if (at("where")) { next(); where = expr(); }
    if (at("order")) { next(); expect("by"); order = expr(); if (at("desc")) { next(); desc = true; } else if (at("asc")) next(); }
    if (at("limit")) { next(); limit = expr(); }
    return { entity, where, order, desc, limit };
  }
  function args(): { args: Expr[]; named: Record<string, Expr> } {
    expect("("); const out: Expr[] = []; const named: Record<string, Expr> = {};
    while (!at(")")) {
      if (peek().t === "id" && at(":", 1)) { const n = next().v; next(); named[n] = expr(); }
      else out.push(expr());
      if (!at(")")) expect(",");
    }
    expect(")"); return { args: out, named };
  }
  function jsonObj(): Expr {
    const pos = expect("{").pos; const fields: Record<string, Expr> = {};
    while (!at("}")) { const n = peek().t === "str" ? next().v : ident("a key"); expect(":"); fields[n] = at("{") ? jsonObj() : expr(); if (!at("}")) expect(","); }
    expect("}"); return { kind: "json", fields, pos };
  }
  function primary(): Expr {
    const t = peek(); const pos = t.pos;
    if (t.t === "str") { next(); return { kind: "lit", value: t.v, pos }; }
    if (t.t === "int") {
      next();
      if (peek().t === "id" && DURATION_UNITS.has(peek().v) && peek().pos.line === t.pos.line) return { kind: "duration", amount: Number(t.v), unit: next().v, pos };
      return { kind: "lit", value: Number(t.v), pos };
    }
    if (at("-")) { next(); return { kind: "unary", op: "neg", arg: postfix(), pos }; }
    if (at("(")) { next(); const e = expr(); expect(")"); return e; }
    if (at("[")) { next(); const items: Expr[] = []; while (!at("]")) { items.push(expr()); if (!at("]")) expect(","); } expect("]"); return { kind: "listlit", items, pos }; }
    if (at("{")) { next(); const items: Expr[] = []; while (!at("}")) { items.push(expr()); if (!at("}")) expect(","); } expect("}"); return { kind: "setlit", items, pos }; }
    if (at(".")) { next(); let e: Expr = { kind: "rowfield", name: ident("a field name"), pos }; while (at(".") && peek(1).t === "id") { const p2 = next().pos; e = { kind: "field", target: e, name: next().v, pos: p2 }; } return e; }
    if (t.t !== "id") fail("PARSE_EXPR", `expected an expression, found '${t.v || "end of file"}'`);
    if (t.v === "true" || t.v === "false") { next(); return { kind: "lit", value: t.v === "true", pos }; }
    if (t.v === "none") { next(); return { kind: "lit", value: null, pos }; }
    if (t.v === "it") { next(); return { kind: "it", pos }; }
    if (t.v === "now") { next(); return { kind: "now", pos }; }
    if (t.v === "json" && at("{", 1)) { next(); return jsonObj(); }
    if (t.v === "call" && peek(1).t === "id") { next(); const name = next().v; const a = args(); return { kind: "extern", name, ...a, pos }; }
    if (t.v === "if") { next(); const cond = expr(); expect("then"); const th = expr(); expect("else"); return { kind: "if", cond, then: th, else: expr(), pos }; }
    if (["exists", "count", "the", "the_or_none", "first_or_none", "set"].includes(t.v) && at("(", 1) && peek(2).t === "id" && /^[A-Z]/.test(peek(2).v) && !at("(", 3) && !at(".", 3)) {
      next(); next(); const q = query(); expect(")"); return { kind: "query", op: t.v, ...q, pos };
    }
    if (t.v === "all" && at("(", 1)) { next(); next(); const q = query(); expect(":"); const cond = expr(); expect(")"); return { kind: "all", ...q, cond, pos }; }
    if (t.v === "list" && at("(", 1) && peek(2).t === "id" && /^[A-Z]/.test(peek(2).v)) {
      next(); next(); const q = query(); let map: Expr | undefined; if (at(":")) { next(); map = expr(); } expect(")"); return { kind: "listq", ...q, map, pos };
    }
    next();
    if (at("(")) { const a = args(); return { kind: "call", name: t.v, ...a, pos }; }
    return { kind: "name", name: t.v, pos };
  }

  // ---- statements
  function block(): Stmt[] { expect("{"); const out: Stmt[] = []; while (!at("}")) out.push(stmt()); expect("}"); return out; }
  function assigns(): any[] {
    expect("{"); const out: any[] = [];
    while (!at("}")) { const name = ident("a field name"); expect(":"); out.push({ name, value: expr() }); if (!at("}")) expect(","); }
    expect("}"); return out;
  }
  function stmt(): Stmt {
    const t = peek(); const pos = t.pos;
    switch (t.v) {
      case "require": { next(); const cond = expr(); expect("else"); return { kind: "require", cond, outcome: outcome(), pos }; }
      case "create": case "ensure": {
        next(); const entity = ident("an entity name"); const fields = assigns();
        let as: string | undefined; if (at("as")) { next(); as = ident(); }
        return { kind: "create", entity, fields, as, ensure: t.v === "ensure", pos };
      }
      case "set": {
        next(); const lhs = postfix();
        if (lhs.kind !== "field") fail("PARSE_SET", "set needs a field: set x.f = value", t);
        expect("="); return { kind: "set", target: lhs.target, name: lhs.name, value: expr(), pos };
      }
      case "touch": { next(); return { kind: "touch", target: expr(), pos }; }
      case "delete": {
        next();
        if (peek().t === "id" && /^[A-Z]/.test(peek().v) && !at(".", 1)) { const q = query(); return { kind: "deleteWhere", entity: q.entity, where: q.where, pos }; }
        return { kind: "delete", target: expr(), pos };
      }
      case "for": {
        next(); expect("each"); const bind = ident("a loop variable"); expect("in");
        if (peek().t === "id" && /^[A-Z]/.test(peek().v) && !at("(", 1)) { const q = query(); return { kind: "foreach", bind, entity: q.entity, where: q.where, body: block(), pos }; }
        const over = expr(); return { kind: "foreachList", bind, over, body: block(), pos };
      }
      case "if": {
        next(); const cond = expr(); const th = block(); let el: Stmt[] = [];
        if (at("else")) { next(); el = at("if") ? [stmt()] : block(); }
        return { kind: "if", cond, then: th, else: el, pos };
      }
      // send mail { to: …, subject: …, text: …, unsubscribe: … }: a message in the outbox, sent after the commit
      case "send": { next(); expect("mail"); return { kind: "sendmail", fields: Object.fromEntries(assigns().map((a: any) => [a.name, a.value])), pos }; }
      case "emit": { next(); const event = ident("an event name"); const a = args(); return { kind: "emit", event, args: a.args, pos }; }
      case "reject": { next(); return { kind: "reject", outcome: outcome(), pos }; }
      case "let": { next(); const name = ident(); expect("="); return { kind: "let", name, value: expr(), pos }; }
      case "result": { next(); return { kind: "result", value: expr(), pos }; }
      case "call": { const e = expr(); return { kind: "callstmt", call: e, pos }; }
      case "rate_limit": {
        next(); const n = Number(next().v); expect("per"); const per = primary(); expect("by"); const by = expr(); expect("else");
        return { kind: "rate_limit", n, per, by, outcome: outcome(), pos };
      }
    }
    return fail("PARSE_STMT", `expected a statement, found '${t.v || "end of file"}'`);
  }

  // ---- UI elements
  function target(): any {
    // a screen, action, component or view call; "back"; "url <expr>"; "home"
    if (at("url")) { next(); return { kind: "url", value: expr() }; }
    const pos = peek().pos; const name = ident("a screen or action");
    if (at("(")) { const a = args(); return { kind: "ref", name, ...a, pos }; }
    return { kind: "ref", name, args: [], named: {}, bare: true, pos };
  }
  // ---- the UI: TSX-style markup
  //   <name attr="text" attr={expr} flag>children</name>   or   <name … />
  // An element's main value is its content (<heading>{room.name}</heading>); an action or a
  // screen it goes to is an attribute (<button action={boost(m, "👍")}>, <link to={home}>).
  // A tag that isn't a UI element uses the component of that name, its props named after the
  // component's parameters (<message_item m={m} />). An <if test={…}> may be followed by
  // <else test={…}> and <else>.
  function uiBlock(): El[] {
    expect("{"); const out = markup(); expect("}"); return out;
  }
  const closing = () => at("<") && peek(1).t === "p" && peek(1).v === "/";
  // elements, up to a closing tag or the end of the block
  function markup(): El[] {
    const out: El[] = [];
    while (at("<") && !closing()) { const el = element(out); if (el) out.push(el); }
    return out;
  }
  // an attribute's value: "text", or {…} read by parse
  function attrValue(parse: () => any): any {
    if (peek().t === "str") { const t = next(); return { kind: "lit", value: t.v, pos: t.pos }; }
    expect("{"); const v = parse(); expect("}"); return v;
  }
  function callHead(): any { const n = ident("a name"); const a = at("(") ? args() : { args: [], named: {} }; return { name: n, ...a }; }
  function element(siblings: El[]): El | null {
    expect("<"); const pos = peek().pos; const tagTok = peek();
    const tag = ident("an element name");
    if (tag === "else") return elseElement(siblings, tagTok);
    const spec = ELEMENTS[tag];
    const el: El = { kind: "el", name: spec ? tag : "use", head: null, attrs: {}, children: [], pos };
    const allowed: Record<string, number> = spec ? { ...COMMON, ...spec.attrs } : {};
    const h: any = {};   // the head's parts, as attributes give them
    const reactions: any[] = [];
    const named: Record<string, Expr> = {};
    while (!at(">") && !at("/")) {
      const atok = peek(); const an = ident("an attribute name");
      const valued = at("=");
      const value = (parse: () => any) => { if (!valued) fail("UI_ATTR_VALUE", `${an} needs a value: ${an}="…" or ${an}={…}`, atok); next(); return attrValue(parse); };
      const name = () => { if (!valued) fail("UI_ATTR_VALUE", `${an} needs a name: ${an}="…"`, atok); next(); const t = next(); if (t.t !== "str") fail("PARSE_EXPECTED", `${an} takes a quoted name`, t); return t.v; };
      if (!spec) { named[an] = value(expr); continue; }   // a component's prop
      const head = spec.head;
      if ((head === "target") && (an === "to" || an === "action")) { h.target = value(target); continue; }
      if (head === "target" && an === "href") { h.target = { kind: "url", value: value(expr) }; continue; }
      if (head === "field" && an === "name") { h.name = name(); continue; }
      if (head === "field" && an === "kind") { const kind = name(); if (!FIELD_KINDS.has(kind)) fail("UI_FIELD_KIND", `unknown field kind '${kind}'; the kinds: ${[...FIELD_KINDS].join(", ")}`, atok); h.kind = kind; continue; }
      if (head === "on") {
        if (!valued && OUTCOMES.includes(an)) { h.outcome = an; continue; }
        if (an === "go") { reactions.push({ kind: "go", target: value(target) }); continue; }
        if (an === "flash" || an === "sign_in_as") { reactions.push({ kind: an, value: value(expr) }); continue; }
        if (["stay", "clear", "shake"].includes(an) && !valued) { reactions.push({ kind: an }); continue; }
        fail("UI_REACTION", `unknown reaction '${an}' (expected an outcome, go, stay, flash, sign_in_as, clear, shake)`, atok);
      }
      if (head === "list") {
        if (an === "of") { h.source = value(() => (peek().t === "id" && /^[A-Z]/.test(peek().v) ? { kind: "query", ...query() } : { kind: "view", ...target() })); continue; }
        if (an === "as") { h.bind = name(); continue; }
        if (an === "where") { h.where = value(expr); continue; }
        if (an === "order") { h.order = value(expr); continue; }
        if (an === "desc" && !valued) { h.desc = true; continue; }
      }
      if (head === "each" && an === "as") { h.bind = name(); continue; }
      if (head === "each" && an === "in") { h.over = value(expr); continue; }
      if (head === "if" && an === "test") { h.test = value(expr); continue; }
      if (head === "let" && an === "name") { h.name = name(); continue; }
      if (head === "let" && an === "value") { h.value = value(expr); continue; }
      if (head === "call" && an === "call") { h.call = value(callHead); continue; }
      if ((head === "name" || head === "name?") && an === "name") { h.name = name(); continue; }
      if (!(an in allowed)) fail("UI_ATTR", `${tag} has no attribute '${an}'; it takes: ${attributesOf(tag).join(", ")} (node lang/cli.ts reference)`, atok);
      if (allowed[an] === VALUE) el.attrs[an] = value(expr);
      else { if (valued) fail("UI_ATTR_FLAG", `${an} is a flag: write it alone`, atok); el.attrs[an] = true; }
    }
    // content and children
    let content: Expr | undefined;
    if (at("/")) { next(); expect(">"); }
    else {
      expect(">");
      if (spec && (spec.head === "expr" || spec.head === "expr?")) { if (at("{")) { next(); content = expr(); expect("}"); } }
      else el.children = markup();
      expect("<"); expect("/");
      const close = peek(); const cn = ident("a closing tag");
      if (cn !== tag) fail("UI_CLOSE", `expected </${tag}>, found </${cn}>`, close);
      expect(">");
    }
    if (!spec) { el.head = { name: tag, args: [], named }; Object.defineProperty(el.head, "__props", { value: true }); return el; }
    if (el.children.length && !spec.block) fail("UI_CHILDREN", `${tag} has no children`, tagTok);
    const need = (v: any, what: string) => { if (v === undefined) fail("UI_HEAD", `${tag} needs ${what}`, tagTok); return v; };
    switch (spec.head) {
      case "expr": el.head = need(content, `its value as content: <${tag}>{…}</${tag}>`); break;
      case "expr?": if (content) el.head = content; break;
      case "target": el.head = need(h.target, tag === "button" || tag === "form" ? "action={…}" : "to={…} or href={…}"); break;
      case "field": el.head = { name: need(h.name, 'name="…"'), kind: need(h.kind, 'kind="…"') }; break;
      case "on": el.head = { outcome: need(h.outcome, "an outcome (ok, invalid, …)"), reactions }; break;
      case "list": el.head = { source: need(h.source, "of={…}"), bind: need(h.bind, 'as="…"'), where: h.where, order: h.order, desc: !!h.desc }; break;
      case "each": el.head = { bind: need(h.bind, 'as="…"'), over: need(h.over, "in={…}") }; break;
      case "if": el.head = need(h.test, "test={…}"); break;
      case "let": el.head = { name: need(h.name, 'name="…"'), value: need(h.value, "value={…}") }; break;
      case "call": el.head = need(h.call, "call={…}"); break;
      case "name": el.head = need(h.name, 'name="…"'); break;
      case "name?": if (h.name) el.head = h.name; break;
    }
    return el;
  }
  // <else> and <else test={…}>: the alternatives of the <if> before it
  function elseElement(siblings: El[], tagTok: Tok): null {
    let p = siblings[siblings.length - 1];
    if (!p || p.name !== "if") fail("UI_ELSE", "<else> must follow an <if>", tagTok);
    while (p.else) {
      if (p.else.length === 1 && (p.else[0] as any).__elseIf) p = p.else[0];
      else fail("UI_ELSE", "an <if> has one <else> without a test, last", tagTok);
    }
    let test: Expr | undefined;
    while (!at(">") && !at("/")) {
      const atok = peek(); const an = ident("an attribute name");
      if (an !== "test" || !at("=")) fail("UI_ATTR", `else takes only test={…}`, atok);
      next(); test = attrValue(expr);
    }
    let children: El[] = [];
    if (at("/")) { next(); expect(">"); }
    else { expect(">"); children = markup(); expect("<"); expect("/"); const c = peek(); if (ident() !== "else") fail("UI_CLOSE", "expected </else>", c); expect(">"); }
    if (test) {
      const alt: El = { kind: "el", name: "if", head: test, attrs: {}, children, pos: tagTok.pos };
      Object.defineProperty(alt, "__elseIf", { value: true });
      p.else = [alt];
    } else p.else = children;
    return null;
  }

  // ---- declarations
  function entityBody(name: string, singleton: boolean, pos: Pos): Decl {
    let was: string | undefined; if (at("was")) { next(); was = ident("the entity's previous name"); }
    expect("{"); const fields: any[] = []; const uniques: string[][] = []; const invariants: Expr[] = [];
    while (!at("}")) {
      if (at("unique")) { next(); expect("("); const cols: string[] = []; while (!at(")")) { cols.push(ident("a field name")); if (!at(")")) expect(","); } expect(")"); uniques.push(cols); continue; }
      if (at("invariant")) { next(); invariants.push(expr()); continue; }
      const fpos = peek().pos; const fname = ident("a field name"); expect(":"); const type = typeRef();
      let onDelete = "restrict", touches = false, searchable = false, priv = false, was: string | undefined, max: number | undefined, min: number | undefined;
      for (;;) {
        // sizes: max N / min N characters (UTF-16 units, as a browser counts them)
        if (at("max") && peek(1).t === "int") { next(); max = Number(next().v); continue; }
        if (at("min") && peek(1).t === "int") { next(); min = Number(next().v); continue; }
        if (at("on") && at("delete", 1)) { next(); next(); onDelete = ident(); continue; }
        if (at("touches")) { next(); touches = true; continue; }
        if (at("searchable")) { next(); searchable = true; continue; }
        if (at("was")) { next(); was = ident("the field's previous name"); continue; }
        if (at("private")) { next(); priv = true; continue; }
        break;
      }
      let def: Expr | undefined; if (at("=")) { next(); def = expr(); }
      fields.push({ name: fname, type, onDelete, touches, searchable, private: priv, default: def, was, max, min, pos: fpos });
    }
    expect("}"); return { kind: "entity", name, singleton, fields, uniques, invariants, was, pos };
  }
  function action(pos: Pos, internal: boolean): Decl {
    const name = ident(); const ps = params(); const skips: string[] = [];
    while (at("skip")) { next(); expect("gate"); skips.push(ident("a gate name")); }
    return { kind: "action", name, params: ps, skips, internal, body: block(), pos };
  }
  function view(pos: Pos): Decl {
    const name = ident(); const ps = params();
    const v: any = { kind: "view", name, params: ps, requires: [], live: false, pos };
    if (at("live")) { next(); v.live = true; }
    if (at("value")) { next(); v.value = expr(); return v; }
    expect("{");
    while (!at("}")) {
      if (at("require")) { next(); const cond = expr(); expect("else"); v.requires.push({ cond, outcome: outcome() }); }
      else if (at("rows")) { next(); v.rows = query(); }
      else if (at("order")) { next(); expect("by"); v.order = expr(); if (at("desc")) { next(); v.desc = true; } }
      else if (at("window")) {
        next(); const n = Number(next().v); const end = ident(); let unless: Expr | undefined; if (at("unless")) { next(); unless = expr(); }
        v.window = { size: n, end, unless };
      }
      else if (at("around")) { next(); v.around = { at: expr(), size: Number(next().v) }; }
      else if (at("limit")) { next(); v.limit = expr(); }
      else if (at("page")) { next(); v.page = Number(next().v); }
      else fail("PARSE_VIEW", `unexpected '${peek().v}' in view`);
    }
    expect("}"); return v;
  }
  function decl(): Decl {
    const t = peek(); const pos = t.pos;
    switch (t.v) {
      // import go "module/path@v1.2.3": a Go module the app's externs bind to, pinned
      case "import": {
        next(); expect("go");
        if (peek().t !== "str") fail("PARSE_IMPORT", `import go takes a quoted module path with its version: import go "github.com/owner/mod@v1.2.3"`);
        const spec = next().v; const at_ = spec.lastIndexOf("@");
        if (at_ <= 0) fail("PARSE_IMPORT", `import go "${spec}" needs a version: "${spec}@v1.2.3" (the standard library needs no import)`);
        return { kind: "import", name: spec.slice(0, at_), module: spec.slice(0, at_), version: spec.slice(at_ + 1), pos };
      }
      // export name "/route" (params) csv|json of view(args) [as row] [named filename] { "Column": .field, … }:
      // a download of a view's rows, a column per entry (a screen whose page is a file)
      case "export": {
        next(); const name = ident("an export name");
        if (peek().t !== "str") fail("PARSE_EXPORT", `export ${name} needs its route: export ${name} "/path"`);
        const route = next().v; const ps = at("(") ? params() : [];
        const format = ident("csv or json"); if (format !== "csv" && format !== "json") fail("PARSE_EXPORT", `an export is csv or json, not '${format}'`);
        expect("of"); const source = expr();
        let as: string | undefined; if (at("as")) { next(); as = ident("a name for the row"); }
        let filename: Expr | undefined; if (at("named")) { next(); filename = expr(); }
        expect("{"); const columns: { key: string; value: Expr; pos: Pos }[] = [];
        while (!at("}")) { const kpos = peek().pos; const key = peek().t === "str" ? next().v : ident("a column name"); expect(":"); columns.push({ key, value: expr(), pos: kpos }); if (at(",")) next(); }
        expect("}");
        return { kind: "screen", name, route, params: ps, requires: [], body: [], file: { format, source, as, filename, columns }, pos } as any;
      }
      // schedule name for x in Entity [where c] at x.field [± duration] past_due fire|skip { … }
      // schedule name every day at "08:00" [in "Zone"] { … }   or   every <duration> { … }
      case "schedule": {
        next(); const name = ident("a schedule name"); const d: any = { kind: "schedule", name, pos };
        if (at("for")) {
          next(); d.bind = ident("a row name"); expect("in"); d.entity = ident("an entity name");
          if (at("where")) { next(); d.where = expr(); }
          expect("at"); d.at = expr();
          if (!at("past_due")) fail("PARSE_SCHEDULE", "a schedule for rows says what happens to rows already past due when it's first deployed: past_due fire (they run then) or past_due skip (only times after the deploy run)");
          next(); const p = ident("fire or skip"); if (p !== "fire" && p !== "skip") fail("PARSE_SCHEDULE", `past_due takes fire or skip, not '${p}'`);
          d.pastDue = p;
        } else if (at("every")) {
          next();
          if (at("day")) {
            next(); expect("at"); if (peek().t !== "str") fail("PARSE_SCHEDULE", `every day at takes a quoted time of day: every day at "08:00"`);
            const tod = next().v; if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(tod)) fail("PARSE_SCHEDULE", `"${tod}" isn't a time of day (HH:MM, 24-hour)`);
            d.every = { daily: tod };
            if (at("in")) { next(); if (peek().t !== "str") fail("PARSE_SCHEDULE", `in takes a quoted time zone: in "America/New_York"`); d.every.zone = next().v; }
          } else { const e = expr(); if (e.kind !== "duration") fail("PARSE_SCHEDULE", "every takes a duration (every 15 min) or day at \"HH:MM\""); d.every = { period: e }; }
        } else fail("PARSE_SCHEDULE", "a schedule runs for rows (schedule n for x in Entity at x.time …) or every period (schedule n every day at \"08:00\" …)");
        d.body = block();
        return d;
      }
      case "enum": {
        next(); const name = ident(); expect("{"); const values: string[] = []; const renames: Record<string, string> = {}; const labels: Record<string, string> = {};
        while (!at("}")) {
          const v = ident(); values.push(v);
          if (peek().t === "str") labels[v] = next().v;   // its label, as people see it
          if (at("was")) { next(); renames[v] = ident("the value's previous name"); }
          if (!at("}")) expect(",");
        }
        expect("}"); return { kind: "enum", name, values, renames, labels, pos };
      }
      // migration "name" { statements }: a data migration, run once when the app is upgraded
      case "migration": { next(); const t = next(); if (t.t !== "str") fail("PARSE_MIGRATION", "a migration needs a quoted name"); return { kind: "migration", name: t.v, body: block(), pos }; }
      // drop Entity.field / drop entity Entity: deletes stored data on the next upgrade
      case "drop": {
        next();
        if (at("entity")) { next(); const entity = ident("an entity name"); return { kind: "drop", name: entity, entity, pos }; }
        const entity = ident("an entity name"); expect("."); const field = ident("a field name");
        return { kind: "drop", name: `${entity}.${field}`, entity, field, pos };
      }
      case "entity": case "singleton": { next(); return entityBody(ident(), t.v === "singleton", pos); }
      case "data": {
        next(); const name = ident(); const body = entityBody(name, false, pos); expect("rows"); expect("[");
        const rows: any[] = []; while (!at("]")) { rows.push(assigns()); if (!at("]")) expect(","); } expect("]");
        return { ...body, kind: "data", rows };
      }
      case "predicate": { next(); const name = ident(); const ps = params(); expect("="); return { kind: "predicate", name, params: ps, body: expr(), pos }; }
      case "fn": { next(); const name = ident(); const ps = params(); expect(":"); const ret = typeRef(); expect("="); return { kind: "fn", name, params: ps, returns: ret, body: expr(), pos }; }
      case "gate": { next(); const name = ident(); expect(":"); const cond = expr(); expect("->"); return { kind: "gate", name, cond, outcome: outcome(), pos }; }
      case "identity": {
        next(); const name = ident(); expect(":"); const entity = ident(); const d: any = { kind: "identity", name, entity, pos };
        if (at(".")) { next(); d.field = ident(); }
        // from token: agent tokens the runtime issues and checks (gogen/rt/agents.go)
        expect("from"); d.source = ident(); if (d.source !== "token") d.key = primary();
        if (at("as")) { next(); d.format = primary(); }
        if (at("where")) { next(); d.where = expr(); }
        return d;
      }
      case "internal": { next(); expect("action"); return action(pos, true); }
      case "action": { next(); return action(pos, false); }
      case "trigger": {
        next(); expect("on"); let on: any; const kind = ident();
        if (kind === "create" || kind === "delete") on = { kind, entity: ident() };
        else if (kind === "update") { const entity = ident(); expect("."); on = { kind: "update", entity, field: ident() }; }
        else on = { kind: "event", event: kind };
        let bind = ""; if (on.kind === "event") { expect("("); bind = ident(); expect(")"); } else { expect("as"); bind = ident(); }
        let when: Expr | undefined; if (at("when")) { next(); when = expr(); }
        return { kind: "trigger", name: `trigger@${pos.line}`, on, bind, when, body: block(), pos };
      }
      case "workflow": {
        next(); expect("on"); const event = ident(); expect("("); const bind = ident(); expect(")"); expect("{");
        const steps: any[] = [];
        while (!at("}")) { expect("step"); const sname = ident(); expect(":"); const body: Stmt[] = []; while (!at("step") && !at("}")) body.push(stmt()); steps.push({ name: sname, body }); }
        expect("}"); return { kind: "workflow", name: `workflow ${event}`, event, bind, steps, pos };
      }
      case "permission": { next(); expect("read"); const entity = ident(); expect(":"); return { kind: "permission", name: entity, entity, cond: expr(), pos }; }
      case "view": { next(); return view(pos); }
      case "extern": {
        next(); expect("fn"); const name = ident(); const ps = params(); let ret: any;
        if (at(":")) { next(); ret = typeRef(); }
        expect("effect"); const effect = ident();
        // = go "pkg".Func (a Go package's function) or = go Func (one in the app's own Go file)
        let go: any;
        if (at("=")) {
          next(); expect("go");
          const pkg = peek().t === "str" ? next().v : undefined;
          if (pkg !== undefined) expect(".");
          go = { pkg, fn: ident("a Go function name") };
        }
        return { kind: "extern", name, params: ps, returns: ret, effect, go, pos };
      }
      case "channel": {
        next(); const name = ident(); const ps = params(); const d: any = { kind: "channel", name, params: ps, pos };
        if (at("requires")) { next(); d.requires = expr(); }
        while (at("on") || at("every")) {
          if (at("on")) { next(); const w = ident(); d[w] = target(); }
          else { next(); d.every = { interval: primary(), target: target() }; }
        }
        return d;
      }
      case "signal": {
        next(); const name = ident(); const ps = params(); expect("to"); const to = expr(); expect("carries");
        const carries = jsonObj(); const d: any = { kind: "signal", name, params: ps, to, carries, pos };
        if (at("requires")) { next(); d.requires = expr(); }
        return d;
      }
      case "api": {
        next(); const name = ident(); const route = next().v; expect("identity"); const identityName = ident(); const skips: string[] = [];
        while (at("skip")) { next(); expect("gate"); skips.push(ident("a gate name")); }
        expect("{");
        const routes: any[] = [];
        while (!at("}")) {
          const rpos = peek().pos; const method = ident(); const path = next().v; expect("->"); const tgt = target();
          const r: any = { method, path, target: tgt, pos: rpos };
          for (;;) {
            if (at("status")) { next(); r.status = Number(next().v); continue; }
            if (at("as")) { next(); expect("json"); r.json = ident(); continue; }
            if (at("headers")) { next(); r.headers = jsonObj(); continue; }
            if (at("location")) { next(); r.location = expr(); continue; }
            break;
          }
          routes.push(r);
        }
        expect("}"); return { kind: "api", name, route, identity: identityName, skips, routes, pos };
      }
      case "app": {
        // app <name> { name … actor … sign_in … setup … setup_when … }: what the runtime needs to know about the app
        next(); const name = ident(); expect("{"); const props: Record<string, Expr> = {};
        while (!at("}")) { const p = ident(); props[p] = expr(); }
        expect("}"); return { kind: "app", name, props, pos };
      }
      case "avatar": {
        // avatar <Entity>: <expr over the row> — a File, an image asset name, or text drawn as initials
        next(); const entity = ident("an entity name"); expect(":"); return { kind: "avatar", name: entity, entity, value: expr(), pos };
      }
      case "display": {
        // display <Entity>: <expr over the row> — how pickers and lists label a row
        next(); const entity = ident("an entity name"); expect(":"); return { kind: "display", name: entity, entity, value: expr(), pos };
      }
      case "theme": {
        next(); const name = ident(); expect("{"); const props: Record<string, Expr> = {};
        while (!at("}")) { const p = ident(); props[p] = expr(); }
        expect("}"); return { kind: "theme", name, props, pos };
      }
      case "layout": { next(); const name = ident(); return { kind: "layout", name, body: uiBlock(), pos }; }
      // widget name(params): an app's own widget, implemented in the module given to the runtime with --widgets
      case "widget": { next(); const name = ident(); return { kind: "widget", name, params: params(), pos }; }
      case "component": { next(); const name = ident(); const ps = params(); return { kind: "component", name, params: ps, body: uiBlock(), pos }; }
      case "screen": {
        next(); const name = ident(); const route = peek().t === "str" ? next().v : ""; const ps = at("(") ? params() : [];
        expect("layout"); const layout = ident(); const d: any = { kind: "screen", name, route, params: ps, layout, pos, public: false };
        for (;;) {
          if (at("public")) { next(); d.public = true; continue; }
          if (at("remember")) { next(); d.remember = next().v; continue; }
          break;
        }
        expect("{"); const requires: any[] = []; const body: El[] = [];
        while (!at("}")) {
          if (at("require")) {
            const rpos = next().pos; const cond = expr(); expect("else");
            if (at("go")) { next(); const tg = target(); let flash: Expr | undefined; if (at("flash")) { next(); flash = add(); /* no comparisons: a "<" next is the markup */ } requires.push({ cond, go: tg, flash, pos: rpos }); }
            else requires.push({ cond, outcome: outcome(), pos: rpos });
          } else { const el = element(body); if (el) body.push(el); }
        }
        expect("}"); d.requires = requires; d.body = body; return d;
      }
    }
    return fail("PARSE_DECL", `expected a declaration, found '${t.v || "end of file"}'`);
  }

  const decls: Decl[] = [];
  while (peek().t !== "eof") decls.push(decl());
  // each schedule's body is an internal action the runtime runs when the time comes, past every
  // gate (no request comes with it): schedule_<name>(<row>), or schedule_<name>() for periods
  const gateNames = decls.filter((d) => d.kind === "gate").map((d) => d.name);
  for (const s of decls.filter((d) => d.kind === "schedule") as any[]) {
    const params = s.bind ? [{ name: s.bind, type: { kind: "named", name: s.entity, optional: false }, pos: s.pos }] : [];
    decls.push({ kind: "action", name: `schedule_${s.name}`, params, skips: gateNames, internal: true, scheduled: s.name, body: s.body, pos: s.pos } as any);
  }
  // <component prop={…}>: its props in the order of the component's parameters
  const comps = new Map(decls.filter((d) => d.kind === "component").map((d) => [d.name, d]));
  const props = (els: El[]) => { for (const el of els) {
    if (el.name === "use" && el.head?.__props) {
      const c = comps.get(el.head.name);
      if (!c) throw new SpecError("UI_ELEMENT", `unknown UI element or component '${el.head.name}'; the elements: ${Object.keys(ELEMENTS).filter((n) => n !== "use").join(", ")}${comps.size ? `; the components: ${[...comps.keys()].join(", ")}` : ""} (node lang/cli.ts reference)`, el.pos);
      for (const n of Object.keys(el.head.named)) if (!c.params.some((q: any) => q.name === n)) throw new SpecError("UI_PROP", `${c.name} has no parameter '${n}'`, el.pos);
      const args: Expr[] = [];
      for (const q of c.params) { if (!(q.name in el.head.named)) break; args.push(el.head.named[q.name]); }
      if (args.length < Object.keys(el.head.named).length) throw new SpecError("UI_PROP", `${c.name}'s props must be given in order from the first: missing ${c.params[args.length].name}`, el.pos);
      el.head = { name: el.head.name, args, named: {} };
    }
    props(el.children); if (el.else) props(el.else);
  } };
  for (const d of decls) if (Array.isArray(d.body) && ["screen", "component", "layout"].includes(d.kind)) props(d.body);
  return { decls };
}

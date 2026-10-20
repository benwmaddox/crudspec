// Parser for crudspec v2 (lang/LANGUAGE.md). Newlines don't matter anywhere. The UI is
// TSX-style markup (see markup() below); the rest is declarations and expressions.
import { readFileSync } from "node:fs";

export type Pos = { line: number; col: number };
// off and end: the token's place in the source (end exclusive), for raw text and the syntax upgrade
export type Tok = { t: "id" | "str" | "int" | "p" | "eof"; v: string; pos: Pos; off: number; end: number };
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

// The lexer makes tokens as the parser asks for them, so the parser can also read raw text (a
// text element's content) from where the last token ended: seek there, then rawText.
export class Lexer {
  i = 0; line = 1; col = 1;
  readonly src: string;
  private starts: number[] = [0];   // each line's first offset, for seek
  constructor(src: string) { this.src = src; for (let j = 0; j < src.length; j++) if (src[j] === "\n") this.starts.push(j + 1); }
  private adv(n: number) { const s = this.src; for (let k = 0; k < n; k++) { if (s[this.i] === "\n") { this.line++; this.col = 1; } else this.col++; this.i++; } }
  seek(off: number) {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.starts[mid] <= off) lo = mid; else hi = mid - 1; }
    this.i = off; this.line = lo + 1; this.col = off - this.starts[lo] + 1;
  }
  next(): Tok {
    const src = this.src;
    while (this.i < src.length) {
      const c = src[this.i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") { this.adv(1); continue; }
      if (c === "/" && src[this.i + 1] === "/") { while (this.i < src.length && src[this.i] !== "\n") this.adv(1); continue; }
      break;
    }
    const i = this.i, pos = { line: this.line, col: this.col };
    if (i >= src.length) return { t: "eof", v: "", pos: { line: this.line + 1, col: 1 }, off: i, end: i };
    const c = src[i];
    const tok = (t: Tok["t"], v: string, end: number): Tok => { this.adv(end - i); return { t, v, pos, off: i, end }; };
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++; return tok("id", src.slice(i, j), j); }
    if (/[0-9]/.test(c)) { let j = i; while (j < src.length && /[0-9]/.test(src[j])) j++; return tok("int", src.slice(i, j), j); }
    if (c === '"') {
      let j = i + 1, out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && (src[j + 1] === '"' || src[j + 1] === "\\")) { out += src[j + 1]; j += 2; }
        else if (src[j] === "\\" && src[j + 1] === "n") { out += "\n"; j += 2; }   // a line break (mail text, say)
        else if (src[j] === "\n") throw new SpecError("LEX_STRING", "unterminated string", pos);
        else { out += src[j]; j++; }
      }
      if (j >= src.length) throw new SpecError("LEX_STRING", "unterminated string", pos);
      return tok("str", out, j + 1);
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) throw new SpecError("LEX_CHAR", `unexpected character '${c}'`, pos);
    return tok("p", p, i + p.length);
  }
  // raw text from here up to a "<", "{" or "}" (not taken), or the end. "//" starts a comment
  // at the start of a line or after a space, so a link's "https://" is text.
  rawText(): { text: string; stop: string; pos: Pos } {
    const src = this.src, pos = { line: this.line, col: this.col };
    let out = "";
    while (this.i < src.length) {
      const c = src[this.i];
      if (c === "<" || c === "{" || c === "}") return { text: out, stop: c, pos };
      if (c === "/" && src[this.i + 1] === "/" && (src[this.i - 1] === " " || src[this.i - 1] === "\t" || /^[ \t]*$/.test(src.slice(this.starts[this.line - 1], this.i)))) {
        while (this.i < src.length && src[this.i] !== "\n") this.adv(1);
        continue;
      }
      out += c; this.adv(1);
    }
    return { text: out, stop: "", pos };
  }
}

export function lex(src: string): Tok[] {
  const lx = new Lexer(src), toks: Tok[] = [];
  for (;;) { const t = lx.next(); toks.push(t); if (t.t === "eof") return toks; }
}

// a text element's raw text as it shows: runs of spaces collapse to one; a line break and the
// spaces around it are one space between words, and nothing at the start or end of a line
export function textOfRaw(s: string): string {
  const lines = s.split(/\r?\n/);
  if (lines.length === 1) return s.replace(/[ \t]+/g, " ");
  return lines.map((l, i) => { let t = l.replace(/[ \t]+/g, " "); if (i > 0) t = t.replace(/^ /, ""); if (i < lines.length - 1) t = t.replace(/ $/, ""); return t; }).filter((t) => t !== "").join(" ");
}

// ---- UI vocabulary: element names, and the attributes each may carry, read from the standard
// library's declarations (lang/std/ui.crud) when this module loads. An attribute is either a
// flag or takes one expression; an element's head is what its other parameters' types say.
export const FLAG = 0, VALUE = 1;
export type ElementSpec = { head: string; attrs: Record<string, number>; block?: boolean; headParams: string[]; text?: boolean };
export const COMMON: Record<string, number> = {};
export const ELEMENTS: Record<string, ElementSpec> = {};
export const FIELD_KINDS = new Set<string>();
// a built-in element's tag (Heading, FieldDisplay) and the name the compiler knows it by (heading, field_display)
export const TAG_OF: Record<string, string> = {};
export const BY_TAG: Record<string, string> = {};
// built-in elements renamed in v4, by their old tags: what upgrade-syntax makes of them
const OLD_NAMES: Record<string, string> = { richtext: "rich_text" };
// built-in names that are HTML elements too: lowercase, they are the HTML element (<main>, <form>)
const HTML_TOO = new Set(["link", "button", "form", "section", "menu", "dialog", "title", "time", "strong", "main", "nav", "footer", "aside", "slot"]);
// HTML's void elements: no content, no closing tag
export const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
export const pascal = (n: string) => n.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
export const snake = (n: string) => n.replace(/(?<=[a-z0-9])([A-Z])/g, "_$1").toLowerCase();
// what each is for, from the comments in lang/std/ui.crud: an element's above it, a parameter's or
// a field kind's beside it (lang/reference.ts writes REFERENCE.md from these)
export const STD_DOCS = { elements: {} as Record<string, string>, attrs: {} as Record<string, Record<string, string>>, common: {} as Record<string, string>, fieldKinds: {} as Record<string, string> };
// the old forms of if, let and for each, read only by upgrade-syntax: not elements
const LEGACY_FORMS: Record<string, ElementSpec> = {
  each: { head: "each", attrs: {}, block: true, headParams: ["as", "in"] },
  if: { head: "if", attrs: {}, block: true, headParams: ["test"] },
  let: { head: "let", attrs: {}, headParams: ["name", "value"] },
};
// the head a parameter type makes, and the types written as attributes rather than the head
const HEAD_OF: Record<string, string> = { Text: "expr", Content: "expr", Target: "target", Href: "target", Action: "target", Param: "field", FieldKind: "field", Outcome: "on", Reaction: "on", Rows: "list", Bind: "list", Filter: "list", Order: "list", Desc: "list", Call: "call", Name: "name" };
const NOT_ATTRIBUTES = new Set(["Outcome", "Reaction", "Text", "Content"]);   // written bare, or as the content
function loadStd(src: string) {
  const std = parse(src), lines = src.split(/\r?\n/);
  // the comment lines just above a line, and the comment at the end of one
  const above = (line: number) => { const out: string[] = []; for (let i = line - 2; i >= 0 && /^\s*\/\//.test(lines[i]); i--) out.unshift(lines[i].replace(/^\s*\/\/\s?/, "")); return out.join(" "); };
  const beside = (line: number) => /\/\/\s?(.*)$/.exec(lines[line - 1] ?? "")?.[1] ?? "";
  for (const d of std.decls as any[]) {
    if (d.kind === "enum" && d.name === "FieldKind") {
      for (const v of d.values) { FIELD_KINDS.add(v); STD_DOCS.fieldKinds[v] = beside(lines.findIndex((l, i) => i >= d.pos.line - 1 && new RegExp(`^\\s*${v}\\b`).test(l)) + 1); }
      continue;
    }
    if (d.kind !== "native") continue;
    if (d.common) { for (const p of d.params) { COMMON[p.name] = p.type.name === "Flag" ? FLAG : VALUE; STD_DOCS.common[p.name] = beside(p.pos.line); } continue; }
    STD_DOCS.elements[snake(d.name)] = above(d.pos.line);
    STD_DOCS.attrs[snake(d.name)] = Object.fromEntries(d.params.map((p: any) => [p.name, beside(p.pos.line)]));
    const spec: ElementSpec = { head: "none", attrs: {}, headParams: [] };
    for (const p of d.params) {
      const t = p.type.name;
      if (t === "Children") spec.block = true;
      else if (t === "Flag") spec.attrs[p.name] = FLAG;
      else if (t === "Value") spec.attrs[p.name] = VALUE;
      else if (HEAD_OF[t]) {
        spec.head = HEAD_OF[t] + ((t === "Text" || t === "Content" || t === "Name") && p.type.optional ? "?" : "");
        if (t === "Text") spec.text = true;
        if (!NOT_ATTRIBUTES.has(t)) spec.headParams.push(p.name);
      } else throw new Error(`lang/std/ui.crud: ${d.name}'s ${p.name} has type ${t}, which isn't an element parameter type`);
    }
    ELEMENTS[snake(d.name)] = spec; TAG_OF[snake(d.name)] = d.name; BY_TAG[d.name] = snake(d.name);
  }
  Object.assign(ELEMENTS, LEGACY_FORMS);
}
// what an element takes, for errors: its head's attributes, then its own, then the common ones
export function attributesOf(name: string): string[] {
  const spec = ELEMENTS[name];
  if (!spec) return [];
  return [...spec.headParams, ...Object.keys(spec.attrs), ...Object.keys(COMMON)];
}

// legacy: also read the syntax before v3 (if … then … else, <if>/<else>, <let>, <each>, quoted
// names, list(E where p : e)), recording in edits how to write each in the current syntax.
// Only `upgrade-syntax` (lang/syntax-upgrade.ts) uses it.
// group: the edits of one construct (an <if> and its <else>s, say), applied together
export type Edit = { from: number; to: number; text: string; what: string; group: number };
export type ParseOpts = { legacy?: boolean; edits?: Edit[] };

export function parse(src: string, opts: ParseOpts = {}): Spec {
  const legacy = !!opts.legacy;
  let groups = 0;
  // (legacy) the components a spec before v4 declares: its lowercase tags that aren't HTML
  const legacyComponents = new Set(legacy ? [...src.matchAll(/\bcomponent\s+([a-z_]\w*)\s*\(/g)].map((m) => m[1]) : []);
  const edit = (from: number, to: number, text: string, what: string, group = ++groups) => { opts.edits?.push({ from, to, text, what, group }); };
  const lx = new Lexer(src);
  const toks: Tok[] = [];   // made as needed; toks[k] is the next one
  let k = 0;
  const peek = (o = 0) => { while (toks.length <= k + o) toks.push(toks.length && toks[toks.length - 1].t === "eof" ? toks[toks.length - 1] : lx.next()); return toks[k + o]; };
  const at = (v: string, o = 0) => { const t = peek(o); return (t.t === "p" || t.t === "id") && t.v === v; };
  const next = () => { const t = peek(); k++; return t; };
  const last = () => toks[k - 1];
  // back to the source just after the last token taken, dropping any look-ahead (for raw text)
  const toRaw = () => { toks.length = k; lx.seek(k ? toks[k - 1].end : 0); };
  const text = (from: number, to: number) => src.slice(from, to).trim();
  const fail = (code: string, msg: string, t = peek()): never => { throw new SpecError(code, msg, t.pos); };
  const expect = (v: string) => { if (!at(v)) fail("PARSE_EXPECTED", `expected '${v}', found '${peek().v || "end of file"}'`); return next(); };
  const ident = (what = "a name") => { const t = peek(); if (t.t !== "id") fail("PARSE_EXPECTED", `expected ${what}, found '${t.v || "end of file"}'`); return next().v; };
  const outcome = () => { const t = peek(); const v = ident("an outcome"); if (!OUTCOMES.includes(v)) fail("PARSE_OUTCOME", `unknown outcome '${v}' (expected ${OUTCOMES.join(", ")})`, t); return v; };
  // an optional reason after an outcome, on its line: require … else forbidden "only the author may edit it"
  const reason = (): string | undefined => { const t = peek(); return t.t === "str" && t.pos.line === last()?.pos.line ? next().v : undefined; };

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
  // among elements (let, if, for each, match), a "<" that starts a tag ends the expression:
  // <name>, <name/>, <name attr…>
  let inMarkup = 0;
  const OPWORDS = new Set(["and", "or", "implies", "in", "not"]);
  const tagNext = () => inMarkup > 0 && at("<") && peek(1).t === "id" && (at(">", 2) || at("/", 2) || (peek(2).t === "id" && !OPWORDS.has(peek(2).v) && (at("=", 3) || at(">", 3) || at("/", 3) || peek(3).t === "id")));
  function cmp(): Expr {
    const l = add();
    if (tagNext()) return l;
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
    if (at("(")) { next(); const keep = inMarkup; inMarkup = 0; try { const e = expr(); expect(")"); return e; } finally { inMarkup = keep; } }
    if (at("[")) { next(); const items: Expr[] = []; while (!at("]")) { items.push(expr()); if (!at("]")) expect(","); } expect("]"); return { kind: "listlit", items, pos }; }
    if (at("{")) { next(); const items: Expr[] = []; while (!at("}")) { items.push(expr()); if (!at("}")) expect(","); } expect("}"); return { kind: "setlit", items, pos }; }
    if (at(".")) { next(); let e: Expr = { kind: "rowfield", name: ident("a field name"), pos }; while (at(".") && peek(1).t === "id") { const p2 = next().pos; e = { kind: "field", target: e, name: next().v, pos: p2 }; } return e; }
    if (t.t !== "id") fail("PARSE_EXPR", `expected an expression, found '${t.v || "end of file"}'`);
    if (t.v === "true" || t.v === "false") { next(); return { kind: "lit", value: t.v === "true", pos }; }
    if (t.v === "none") { next(); return { kind: "lit", value: null, pos }; }
    if (t.v === "it") { next(); const e: Expr = { kind: "it", pos }; Object.defineProperty(e, "__tok", { value: t }); return e; }
    if (t.v === "now") { next(); return { kind: "now", pos }; }
    if (t.v === "json" && at("{", 1)) { next(); return jsonObj(); }
    if (t.v === "call" && peek(1).t === "id") { next(); const name = next().v; const a = args(); return { kind: "extern", name, ...a, pos }; }
    // if c { a } else if d { b } else { e }: an expression's if always has an else
    if (t.v === "if") {
      next(); const cond = expr();
      if (at("then")) {
        if (!legacy) fail("PARSE_IF", "write an expression's if as if c { a } else { b }");
        const g = ++groups; const thenTok = next(); const th = expr(); const elseTok = expect("else");
        const elseStart = peek(); const el = expr(); const elseIf = el.kind === "if" && elseStart.t === "id" && elseStart.v === "if";
        edit(thenTok.off, thenTok.end, "{", "if then else", g);
        edit(elseTok.off, elseTok.end, elseIf ? "} else" : "} else {", "if then else", g);
        if (!elseIf) edit(last().end, last().end, " }", "if then else", g);
        return { kind: "if", cond, then: th, else: el, pos };
      }
      expect("{"); const th = expr(); expect("}");
      if (!at("else")) fail("PARSE_IF", "an if in an expression needs an else: if c { a } else { b }");
      next();
      let el: Expr;
      if (at("if")) el = primary();
      else { expect("{"); el = expr(); expect("}"); }
      return { kind: "if", cond, then: th, else: el, pos };
    }
    if (t.v === "match") return match<Expr, Expr>(() => { expect("{"); const e = expr(); expect("}"); return e; }, (cond, then, els, p) => ({ kind: "if", cond, then, else: els ?? then, pos: p }), (n) => n);
    if (["exists", "count", "the", "the_or_none", "first_or_none", "set"].includes(t.v) && at("(", 1) && peek(2).t === "id" && /^[A-Z]/.test(peek(2).v) && !at("(", 3) && !at(".", 3)) {
      next(); next(); const q = query(); expect(")"); return { kind: "query", op: t.v, ...q, pos };
    }
    // list(E where p), list(e for E where p) and all(c for E where p): in e and c, .f is the row's
    // field and it the row, as in the where
    if ((t.v === "all" || t.v === "list") && at("(", 1)) {
      next(); next();
      const queryFirst = peek().t === "id" && /^[A-Z]/.test(peek().v) && ["where", "order", "limit", ")", ":"].includes(peek(1).v);
      if (queryFirst) {
        const qStart = peek(); const q = query();
        if (at(":")) {
          if (!legacy) fail("PARSE_PROJECTION", `write ${t.v}(<${t.v === "all" ? "condition" : "value"}> for ${q.entity} where …)`);
          const colon = next(); const mStart = peek(); const m = expr();
          edit(qStart.off, last().end, `${text(mStart.off, last().end)} for ${text(qStart.off, colon.off)}`, "projection");
          expect(")");
          return t.v === "all" ? { kind: "all", ...q, cond: m, pos } : { kind: "listq", ...q, map: m, pos };
        }
        if (t.v === "all") fail("PARSE_PROJECTION", `all takes a condition for each row: all(<condition> for ${q.entity} where …)`);
        expect(")"); return { kind: "listq", ...q, map: undefined, pos };
      }
      const m = expr();
      if (!at("for")) fail("PARSE_PROJECTION", `expected for: ${t.v}(<${t.v === "all" ? "condition" : "value"}> for Entity where …)`);
      next(); const q = query(); expect(")");
      return t.v === "all" ? { kind: "all", ...q, cond: m, pos } : { kind: "listq", ...q, map: m, pos };
    }
    next();
    if (at("(")) { const a = args(); return { kind: "call", name: t.v, ...a, pos }; }
    return { kind: "name", name: t.v, pos };
  }

  // for each u in E where …: the row is u in the where (.f is u.f), and it is no name there.
  // u becomes the row (it) for the type pass and the generator; a nested query's row is its own.
  function namedRow(e: any, bind: string): any {
    if (!e || typeof e !== "object") return e;
    if (Array.isArray(e)) return e.map((x) => namedRow(x, bind));
    if (e.kind === "it") {
      const tok: Tok | undefined = e.__tok;
      if (!legacy) fail("ROW_NAMED", `the row is named ${bind} here: write ${bind}, not it`, tok ?? peek());
      if (tok) edit(tok.off, tok.end, bind, "it in a named loop");
      return e;
    }
    // (before v3 the loop's name in its where was no name for the row: an enum value of that name
    // meant the value; upgrade-syntax refuses a rewrite whose loop name is also an enum value)
    if (e.kind === "name" && e.name === bind) return { kind: "it", pos: e.pos };
    if (["query", "listq", "all"].includes(e.kind)) return e;
    const out: any = {};
    for (const [k, v] of Object.entries(e)) out[k] = k === "pos" ? v : namedRow(v, bind);
    return out;
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
      case "require": { next(); const cond = expr(); expect("else"); return { kind: "require", cond, outcome: outcome(), reason: reason(), pos }; }
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
        if (peek().t === "id" && /^[A-Z]/.test(peek().v) && !at("(", 1)) { const q = query(); return { kind: "foreach", bind, entity: q.entity, where: q.where && namedRow(q.where, bind), body: block(), pos }; }
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
      case "reject": { next(); return { kind: "reject", outcome: outcome(), reason: reason(), pos }; }
      case "match": return match<Stmt[], Stmt>(block, (cond, then, els, p) => ({ kind: "if", cond, then, else: els ?? [], pos: p }), (n) => [n]);
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
  // An element's main value is its content: <heading>Welcome, {actor.name}</heading> (raw text
  // and {…}, in text, heading, strong and title) or <image>{url}</image>; an action or a screen
  // it goes to is an attribute (<button action={boost(m, "👍")}>, <link to={home}>). A tag that
  // isn't a UI element uses the component of that name, its props named after the component's
  // parameters (<message_item m={m} />). Among elements, as statements are among statements:
  //   if c { … } else if d { … } else { … }     let name = value     for each x in xs { … }
  //   match e { a { … } b, c { … } none { … } }   (every value of e's enum, and none if it's optional)
  function uiBlock(): El[] {
    expect("{"); const out = content(true); expect("}"); return out;
  }
  const closing = () => at("<") && peek(1).t === "p" && peek(1).v === "/";
  // an element's children, or a block's: content (below); before v4, elements and bare
  // control forms, which upgrade-syntax wraps in braces
  function markup(): El[] { return content(); }
  // content, up to a closing tag or the block's "}" (not taken): text as it shows, {expression}
  // (its value as text) and elements; {if …} {for each …} {let …} {match …}: code among them,
  // whose blocks are content again. A run of only spaces and line breaks is nothing (a space
  // between two elements is written {" "}); in other text, line breaks and the spaces around
  // them are one space, as in a <Text>.
  // block: a {…}'s body, whose spaces just inside its braces are layout, not text
  function content(block = false): El[] {
    const out: El[] = [];
    let parts: (string | Expr)[] = [], at0: Pos | undefined;
    const flush = (end = false) => {
      if (block && !out.length && typeof parts[0] === "string") parts[0] = parts[0].replace(/^[ \t]+/, "");
      if (block && end && typeof parts[parts.length - 1] === "string") parts[parts.length - 1] = (parts[parts.length - 1] as string).replace(/[ \t]+$/, "");
      const text = parts.filter((p): p is string => typeof p === "string").join("");
      if (parts.some((p) => typeof p !== "string") || text.trim()) {
        const shown: Expr[] = [];
        for (const p of parts) {
          if (typeof p !== "string") { shown.push(p); continue; }
          const s = /\n/.test(p) ? textOfRaw(p) : p.replace(/[ \t]+/g, " ");
          if (s) shown.push({ kind: "lit", value: s, pos: at0! });
        }
        const head = shown.length === 1 ? shown[0] : { kind: "interp", parts: shown, pos: at0! };
        out.push({ kind: "el", name: "text", head, attrs: {}, children: [], pos: at0!, plain: true } as El);
      }
      parts = []; at0 = undefined;
    };
    for (;;) {
      toRaw();
      // (legacy) before v4 there was no text: a control form starting a run is the old bare form
      if (legacy && /^\s*(if\s|match\s|for\s+each\s|let\s+[A-Za-z_]\w*\s*=)/.test(src.slice(k ? toks[k - 1].end : 0, (k ? toks[k - 1].end : 0) + 200))) { flush(); markupItem(out); continue; }
      toRaw();
      const r = lx.rawText();
      if (r.text) { parts.push(r.text); at0 ??= r.pos; }
      if (r.stop === "{") {
        if (codeAhead()) { flush(); next(); code(out); expect("}"); continue; }
        at0 ??= peek().pos; parts.push(braced(expr).v); continue;
      }
      if (r.stop === "<" && !closing()) { flush(); const el = element(out); if (el) out.push(el); continue; }
      break;
    }
    flush(true);
    return out;
  }
  // code (if, let, for each, match) at token o: after a "{" (o = 1), or bare (o = 0, before v4)
  const controlAt = (o: number) => { const t = peek(o); return t.t === "id" && (t.v === "if" || t.v === "match" || (t.v === "for" && at("each", o + 1)) || (t.v === "let" && peek(o + 1).t === "id" && at("=", o + 2))); };
  const codeAhead = () => controlAt(1);
  const bareControl = () => controlAt(0);
  // inside {…}: one or more of if, let, for each and match, up to the "}"
  function code(out: El[]) {
    while (!at("}")) {
      if (at("<")) fail("UI_CODE", "inside {…}, elements go in an if's or for each's block: {if c { <P>…</P> }}");
      if (!controlItem(out)) fail("UI_CODE", `inside {…}: if, let, for each or match, found '${peek().v || "end of file"}'`);
    }
  }
  function markupItem(out: El[]): boolean {
    if (at("<") && !closing()) { const el = element(out); if (el) out.push(el); return true; }
    // (legacy) a bare control form among elements is {…} from v4
    const t = peek();
    if (legacy && bareControl()) {
      const g = ++groups;
      edit(t.off, t.off, "{", "code in braces", g);
      const taken = controlItem(out);
      edit(last().end, last().end, "}", "code in braces", g);
      return taken;
    }
    return false;
  }
  function controlItem(out: El[]): boolean {
    const t = peek();
    if (t.t !== "id") return false;
    if (t.v === "if") { out.push(markupIf()); return true; }
    if (t.v === "let" && peek(1).t === "id" && at("=", 2)) {
      next(); const name = next().v; next();
      out.push({ kind: "el", name: "let", head: { name, value: markupExpr() }, attrs: {}, children: [], pos: t.pos }); return true;
    }
    if (t.v === "for" && at("each", 1)) {
      next(); next(); const bind = ident("a name for each item"); expect("in"); const over = markupExpr();
      out.push({ kind: "el", name: "each", head: { bind, over }, attrs: {}, children: uiBlock(), pos: t.pos }); return true;
    }
    if (t.v === "match") {
      out.push(match<El[], El>(uiBlock, (cond, then, els, pos) => ({ kind: "el", name: "if", head: cond, attrs: {}, children: then, ...(els ? { else: els } : {}), pos }), (n) => [n]));
      return true;
    }
    return false;
  }
  function markupExpr(): Expr { inMarkup++; try { return expr(); } finally { inMarkup--; } }
  function markupIf(): El {
    const pos = next().pos; const cond = markupExpr();
    const el: El = { kind: "el", name: "if", head: cond, attrs: {}, children: uiBlock(), pos };
    if (at("else")) {
      next();
      if (at("if")) { const alt = markupIf(); Object.defineProperty(alt, "__elseIf", { value: true }); el.else = [alt]; }
      else el.else = uiBlock();
    }
    return el;
  }
  // match subject { a { … } b, c { … } none { … } }: an if for each arm but the last, which is
  // the else; the first if keeps what the match said (__match) so the type check can see that
  // every value of the subject's enum, and none for an optional one, has exactly one arm.
  // body reads an arm's body; mkIf makes an if (els: the else's body, if any); wrap makes an if
  // into a body (the else of the one before).
  function match<B, N>(body: () => B, mkIf: (cond: Expr, then: B, els: B | undefined, pos: Pos) => N, wrap: (n: N) => B): N {
    const pos = next().pos; const subject = expr(); expect("{");
    const arms: { values: { name: string; pos: Pos }[]; body: B; pos: Pos }[] = [];
    while (!at("}")) {
      const apos = peek().pos;
      if (at("else")) fail("MATCH_ELSE", "a match has no else: give each value its arm, so a value added to the enum later has to be handled too");
      const values: { name: string; pos: Pos }[] = [];
      for (;;) { const vt = peek(); values.push({ name: ident("an enum value (or none)"), pos: vt.pos }); if (!at(",")) break; next(); }
      arms.push({ values, body: body(), pos: apos });
    }
    expect("}");
    if (!arms.length) fail("MATCH_EMPTY", "a match needs an arm for each value");
    const cmp = (v: { name: string; pos: Pos }): Expr => {
      const e: Expr = { kind: "binary", op: "==", left: subject, right: { kind: "lit", value: v.name === "none" ? null : v.name, pos: v.pos }, pos: v.pos };
      Object.defineProperty(e, "__fromMatch", { value: true }); return e;
    };
    const cond = (a: (typeof arms)[number]): Expr => a.values.slice(1).reduce((l: Expr, v) => ({ kind: "binary", op: "or", left: l, right: cmp(v), pos: v.pos }), cmp(a.values[0]));
    // if a0 { } else if a1 { } … else { last }; a match of one arm is an if with no else
    const build = (i: number): N => mkIf(cond(arms[i]), arms[i].body, i + 1 === arms.length ? undefined : i + 2 === arms.length ? arms[i + 1].body : wrap(build(i + 1)), arms[i].pos);
    const top = build(0);
    Object.defineProperty(top, "__match", { value: { subject, arms: arms.map((a) => ({ values: a.values, pos: a.pos })), pos } });
    return top;
  }
  // a name with dashes written in a tag: my-widget, aria-label, data-id (the dashes touching)
  const dashed = (first: string) => { let s = first; while (at("-") && peek().off === last().end && peek(1).t === "id" && peek(1).off === peek().end) { next(); s += "-" + next().v; } return s; };
  // <p class="x" data-id={r.id} hidden>…</p>, <my-widget …>: plain HTML, its attributes as
  // written ("text", {value} or bare) and its content content; a void element (<br>, <img …>)
  // has none. check refuses what could run script (lang/check.ts).
  function htmlElement(tag: string, pos: Pos, tagTok: Tok): El {
    const attrs: Record<string, Expr | true> = {};
    while (!at(">") && !at("/")) {
      const atok = peek(); const an = dashed(ident("an attribute name"));
      if (an in attrs) fail("UI_ATTR", `${tag}'s ${an} is given twice`, atok);
      if (at("=")) { next(); attrs[an] = attrValue(expr); } else attrs[an] = true;
    }
    const el: El = { kind: "el", name: "html", head: { tag, custom: tag.includes("-") }, attrs, children: [], pos };
    if (at("/")) { next(); expect(">"); return el; }
    expect(">");
    if (VOID.has(tag)) return el;
    if (tag === "style") fail("UI_HTML_STYLE", "<style>: styles go in the theme's stylesheets (theme t { stylesheets [\"app.css\"] }), and elements take a class", tagTok);
    el.children = content();
    expect("<"); expect("/"); const close = peek(); const cn = dashed(ident("a closing tag"));
    if (cn !== tag) fail("UI_CLOSE", `expected </${tag}>, found </${cn}>`, close);
    expect(">");
    return el;
  }
  // an attribute's value: "text", or {…} read by parse
  function attrValue(parse: () => any): any {
    if (peek().t === "str") { const t = next(); return { kind: "lit", value: t.v, pos: t.pos }; }
    expect("{"); const keep = inMarkup; inMarkup = 0; try { const v = parse(); expect("}"); return v; } finally { inMarkup = keep; }
  }
  // {…} as an attribute's value, with where its source is (for the syntax upgrade)
  function braced(parse: () => any): { v: any; from: number; to: number } {
    const ob = expect("{"); const v = parse(); const cb = expect("}"); return { v, from: ob.end, to: cb.off };
  }
  function callHead(): any { const n = ident("a name"); const a = at("(") ? args() : { args: [], named: {} }; return { name: n, ...a }; }
  // text that reads the same written raw: no braces, "<", line breaks, tabs, doubled or end spaces
  const RAW_SAFE = (s: string) => s !== "" && s === s.trim() && !/[{}<\r\n\t]|  /.test(s);
  // a text element's content, just after its ">": raw text and {…}, up to "</"
  function textContent(tag: string): Expr | undefined {
    const parts: (string | Expr)[] = [];
    let only: { v: Expr; from: number; to: number } | undefined, nonBlank = false, count = 0;
    for (;;) {
      toRaw();
      const r = lx.rawText();
      if (r.text) { parts.push(r.text); if (r.text.trim()) nonBlank = true; }
      if (r.stop === "{") { const ob = peek(); const b = braced(expr); parts.push(b.v); count++; only = { v: b.v, from: ob.off, to: last().end }; continue; }
      if (r.stop === "}") throw new SpecError("UI_TEXT", `a "}" in ${tag}'s text: write {"}"}`, r.pos);
      if (r.stop === "<" && !closing()) fail("UI_TEXT", `${tag} holds text and {…}, not elements`);
      break;
    }
    // (legacy) <text>{"Save"}</text> is now written <text>Save</text>
    if (legacy && count === 1 && !nonBlank && only && only.v.kind === "lit" && typeof only.v.value === "string" && RAW_SAFE(only.v.value)) edit(only.from, only.to, only.v.value, "text");
    // as it shows: each raw part as textOfRaw makes it; the start and the end trimmed; a part
    // that is only a line break and spaces is nothing
    const out: Expr[] = [];
    parts.forEach((p, i) => {
      if (typeof p !== "string") { out.push(p); return; }
      if (/^\s*$/.test(p) && /\n/.test(p)) return;
      let s = textOfRaw(p);
      if (i === 0) s = s.replace(/^ /, "");
      if (i === parts.length - 1) s = s.replace(/ $/, "");
      if (s) out.push({ kind: "lit", value: s, pos: { line: 0, col: 0 } });
    });
    if (!out.length) return undefined;
    if (out.length === 1) return out[0];
    return { kind: "interp", parts: out, pos: out[0].pos };
  }
  function element(siblings: El[]): El | null {
    const lt = expect("<"); const pos = peek().pos; const tagTok = peek();
    const written = dashed(ident("an element name"));
    if (written === "else") return elseElement(siblings, tagTok, lt);
    const g = ++groups;
    if (!legacy && (written === "if" || written === "let" || written === "each")) fail("UI_OLD_FORM", ({ if: "write {if c { … } else { … }} among the elements", let: "write {let name = value} among the elements", each: "write {for each x in xs { … }} among the elements" } as Record<string, string>)[written], tagTok);
    // <Heading>: a built-in element (by the name the compiler knows it by); <MessageItem>: a
    // component; <p>, <my-widget>: plain HTML. Before v4 a lowercase tag was a built-in or a
    // component, which upgrade-syntax capitalises
    let tag = written;
    const old = written === "if" || written === "let" || written === "each";
    if (/^[A-Z]/.test(written)) { if (BY_TAG[written]) tag = BY_TAG[written]; }
    else if (!old) {
      const builtin = OLD_NAMES[written] ?? written, now = TAG_OF[builtin] ?? pascal(written);
      if (legacy && (TAG_OF[builtin] || legacyComponents.has(written))) {
        edit(tagTok.off, tagTok.end, now, "tag case");
        tag = TAG_OF[builtin] ? builtin : now;   // the element, or a component by its new name
      } else {
        if (TAG_OF[builtin] && !HTML_TOO.has(written)) fail("UI_TAG_CASE", `<${written}> isn't HTML: the built-in is <${now}> (built-in elements and components start with a capital)`, tagTok);
        return htmlElement(written, pos, tagTok);
      }
    }
    const spec = ELEMENTS[tag];
    const el: El = { kind: "el", name: spec ? tag : "use", head: null, attrs: {}, children: [], pos };
    const allowed: Record<string, number> = spec ? { ...COMMON, ...spec.attrs } : {};
    const h: any = {};   // the head's parts, as attributes give them
    const span: any = {};   // (legacy) where the old forms' parts are
    const reactions: any[] = [];
    const named: Record<string, Expr> = {};
    while (!at(">") && !at("/")) {
      const atok = peek(); const an = ident("an attribute name");
      const valued = at("=");
      const value = (parse: () => any) => { if (!valued) fail("UI_ATTR_VALUE", `${an} needs a value: ${an}="…" or ${an}={…}`, atok); next(); return attrValue(parse); };
      // a name: name=title, as=t, kind=text
      const name = (): string => {
        if (!valued) fail("UI_ATTR_VALUE", `${an} needs a name: ${an}=x`, atok);
        next(); const t = next();
        if (t.t === "id") return t.v;
        const isName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.v);
        if (t.t === "str" && legacy && isName) { edit(t.off, t.end, t.v, "name"); return t.v; }
        return fail("UI_NAME", t.t === "str" ? `${an} takes a name, not text: ${an}=${isName ? t.v : "x"}` : `${an} takes a name: ${an}=x`, t);
      };
      if (!spec) { named[an] = value(expr); continue; }   // a component's prop
      const head = spec.head;
      if ((head === "target") && (an === "to" || an === "action")) { h.target = value(target); continue; }
      if (head === "target" && an === "href") { h.target = { kind: "url", value: value(expr) }; continue; }
      if (head === "field" && an === "name") { h.name = name(); continue; }
      if (head === "field" && an === "kind") { const kind = name(); if (!FIELD_KINDS.has(kind)) fail("UI_FIELD_KIND", `unknown field kind '${kind}'; the kinds: ${[...FIELD_KINDS].join(", ")}`, atok); h.kind = kind; continue; }
      if (head === "on") {
        if (!valued && OUTCOMES.includes(an)) { h.outcome = an; continue; }
        if (an === "go") { reactions.push({ kind: "go", target: value(target) }); continue; }
        // (legacy) sign_in_as={…} and clear are now sign_in={…} and clear_form
        if ((an === "sign_in_as" || (an === "clear" && !valued)) && !legacy) fail("UI_REACTION", an === "clear" ? "write clear_form" : "write sign_in={…}", atok);
        if (an === "sign_in_as" || an === "clear") edit(atok.off, atok.end, an === "clear" ? "clear_form" : "sign_in", "on reaction");
        if (an === "flash" || an === "sign_in_as" || an === "sign_in") { reactions.push({ kind: an === "sign_in" ? "sign_in_as" : an, value: value(expr) }); continue; }
        if (["stay", "clear", "clear_form", "shake"].includes(an) && !valued) { reactions.push({ kind: an === "clear_form" ? "clear" : an }); continue; }
        fail("UI_REACTION", `unknown reaction '${an}' (expected an outcome, go, stay, flash, sign_in, clear_form, shake)`, atok);
      }
      if (head === "list") {
        if (an === "of") { h.source = value(() => (peek().t === "id" && /^[A-Z]/.test(peek().v) ? { kind: "query", ...query() } : { kind: "view", ...target() })); continue; }
        if (an === "as") { h.bind = name(); continue; }
        if (an === "where") { h.where = value(expr); continue; }
        if (an === "order") { h.order = value(expr); continue; }
        if (an === "desc" && !valued) { h.desc = true; continue; }
      }
      if (head === "each" && an === "as") { h.bind = name(); continue; }
      if (head === "each" && an === "in") { next(); const b = braced(expr); h.over = b.v; span.over = b; continue; }
      if (head === "if" && an === "test") { next(); const b = braced(expr); h.test = b.v; span.test = b; continue; }
      if (head === "let" && an === "name") { h.name = name(); continue; }
      if (head === "let" && an === "value") { next(); const b = braced(expr); h.value = b.v; span.value = b; continue; }
      if (head === "call" && an === "call") { h.call = value(callHead); continue; }
      if ((head === "name" || head === "name?") && an === "name") { h.name = name(); continue; }
      if (!(an in allowed)) fail("UI_ATTR", `${written} has no attribute '${an}'; it takes: ${attributesOf(tag).join(", ")} (node lang/cli.ts reference)`, atok);
      if (allowed[an] === VALUE) el.attrs[an] = value(expr);
      else { if (valued) fail("UI_ATTR_FLAG", `${an} is a flag: write it alone`, atok); el.attrs[an] = true; }
    }
    if (old && Object.keys(el.attrs).length) fail("UPGRADE_UNSUPPORTED", `<${tag}> with ${Object.keys(el.attrs).join(", ")}: rewrite it by hand`, tagTok);
    const src = (s: any) => text(s.from, s.to);
    // content and children
    let content: Expr | undefined;
    if (at("/")) {
      next(); const gt = expect(">");
      if (tag === "if") edit(lt.off, gt.end, `if ${src(span.test)} { }`, "<if>", g);
      if (tag === "let") edit(lt.off, gt.end, `let ${h.name} = ${src(span.value)}`, "<let>", g);
      if (tag === "each") edit(lt.off, gt.end, `for each ${h.bind} in ${src(span.over)} { }`, "<each>", g);
    } else {
      const gt = expect(">");
      if (tag === "if") edit(lt.off, gt.end, `if ${src(span.test)} {`, "<if>", g);
      if (tag === "each") edit(lt.off, gt.end, `for each ${h.bind} in ${src(span.over)} {`, "<each>", g);
      if (tag === "let") fail("UPGRADE_UNSUPPORTED", "<let> with children: rewrite it by hand", tagTok);
      if (spec && ELEMENTS[tag]?.text) content = textContent(tag);
      else if (spec && (spec.head === "expr" || spec.head === "expr?")) { if (at("{")) { next(); content = expr(); expect("}"); } }
      else el.children = markup();
      const clt = expect("<"); expect("/");
      const close = peek(); const cn = ident("a closing tag");
      if (cn !== written) fail("UI_CLOSE", `expected </${written}>, found </${cn}>`, close);
      if (legacy && !old && !/^[A-Z]/.test(written)) edit(close.off, close.end, TAG_OF[OLD_NAMES[written] ?? written] ?? pascal(written), "tag case");
      const cgt = expect(">");
      if (tag === "if" || tag === "each") edit(clt.off, cgt.end, "}", `<${tag}>`, g);
      if (tag === "if") Object.defineProperty(el, "__closeEnd", { value: cgt.end });
    }
    if (tag === "if") Object.defineProperty(el, "__group", { value: g });
    if (!spec) { el.head = { name: tag, args: [], named }; Object.defineProperty(el.head, "__props", { value: true }); return el; }
    if (el.children.length && !spec.block) fail("UI_CHILDREN", `${written} has no children`, tagTok);
    const need = (v: any, what: string) => { if (v === undefined) fail("UI_HEAD", `${written} needs ${what}`, tagTok); return v; };
    switch (spec.head) {
      case "expr": el.head = need(content, ELEMENTS[tag]?.text ? `its text as content: <${written}>…</${written}>` : `its value as content: <${written}>{…}</${written}>`); break;
      case "expr?": if (content) el.head = content; break;
      case "target": el.head = need(h.target, tag === "button" || tag === "form" ? "action={…}" : "to={…} or href={…}"); break;
      case "field": el.head = { name: need(h.name, "name=…"), kind: need(h.kind, "kind=…") }; break;
      case "on": el.head = { outcome: need(h.outcome, "an outcome (ok, invalid, …)"), reactions }; break;
      case "list": el.head = { source: need(h.source, "of={…}"), bind: need(h.bind, "as=…"), where: h.where, order: h.order, desc: !!h.desc }; break;
      case "each": el.head = { bind: need(h.bind, "as=…"), over: need(h.over, "in={…}") }; break;
      case "if": el.head = need(h.test, "test={…}"); break;
      case "let": el.head = { name: need(h.name, "name=…"), value: need(h.value, "value={…}") }; break;
      case "call": el.head = need(h.call, "call={…}"); break;
      case "name": el.head = need(h.name, "name=…"); break;
      case "name?": if (h.name) el.head = h.name; break;
    }
    return el;
  }
  // (legacy) <else> and <else test={…}>: the alternatives of the <if> before it
  function elseElement(siblings: El[], tagTok: Tok, lt: Tok): null {
    if (!legacy) fail("UI_OLD_FORM", "write if c { … } else { … } among the elements", tagTok);
    let p = siblings[siblings.length - 1];
    if (!p || p.name !== "if") fail("UI_ELSE", "<else> must follow an <if>", tagTok);
    while (p.else) {
      if (p.else.length === 1 && (p.else[0] as any).__elseIf) p = p.else[0];
      else fail("UI_ELSE", "an <if> has one <else> without a test, last", tagTok);
    }
    const g: number = (p as any).__group ?? ++groups;
    let test: Expr | undefined, tspan: any;
    while (!at(">") && !at("/")) {
      const atok = peek(); const an = ident("an attribute name");
      if (an !== "test" || !at("=")) fail("UI_ATTR", `else takes only test={…}`, atok);
      next(); const b = braced(expr); test = b.v; tspan = b;
    }
    // right after the closing tag before it: "} else {", on one line
    const after: number | undefined = (p as any).__closeEnd;
    const joined = after !== undefined && /^\s*$/.test(src.slice(after, lt.off));
    const open = (end: number, selfClosing: boolean) => edit(joined ? after! : lt.off, end, `${joined ? " " : ""}else${test ? ` if ${text(tspan.from, tspan.to)}` : ""} {${selfClosing ? " }" : ""}`, "<else>", g);
    let children: El[] = [], closeEnd: number | undefined;
    if (at("/")) { next(); open(expect(">").end, true); }
    else {
      open(expect(">").end, false); children = markup();
      const clt = expect("<"); expect("/"); const c = peek(); if (ident() !== "else") fail("UI_CLOSE", "expected </else>", c);
      const cgt = expect(">");
      edit(clt.off, cgt.end, "}", "<else>", g);
      closeEnd = cgt.end;
    }
    if (test) {
      const alt: El = { kind: "el", name: "if", head: test, attrs: {}, children, pos: tagTok.pos };
      Object.defineProperty(alt, "__elseIf", { value: true });
      Object.defineProperty(alt, "__group", { value: g });
      if (closeEnd !== undefined) Object.defineProperty(alt, "__closeEnd", { value: closeEnd });
      p.else = [alt];
    } else p.else = children;
    return null;
  }

  // ---- declarations
  function entityBody(name: string, singleton: boolean, pos: Pos): Decl {
    let was: string | undefined; if (at("was")) { next(); was = ident("the entity's previous name"); }
    expect("{"); const fields: any[] = []; const uniques: string[][] = []; const invariants: Expr[] = []; const indexes: string[][] = [];
    while (!at("}")) {
      // index (a, b): an index for queries that look rows up by a (then b); see lang/cost.ts
      if (at("index") && at("(", 1)) { next(); expect("("); const cols: string[] = []; while (!at(")")) { cols.push(ident("a field name")); if (!at(")")) expect(","); } expect(")"); indexes.push(cols); continue; }
      if (at("unique")) { next(); expect("("); const cols: string[] = []; while (!at(")")) { cols.push(ident("a field name")); if (!at(")")) expect(","); } expect(")"); uniques.push(cols); continue; }
      if (at("invariant")) { next(); invariants.push(expr()); continue; }
      const fpos = peek().pos; const fname = ident("a field name"); expect(":"); const type = typeRef();
      let onDelete = "restrict", touches = false, searchable = false, priv = false, writeOnly = false, was: string | undefined, max: number | undefined, min: number | undefined;
      for (;;) {
        // sizes: max N / min N characters (UTF-16 units, as a browser counts them)
        if (at("max") && peek(1).t === "int") { next(); max = Number(next().v); continue; }
        if (at("min") && peek(1).t === "int") { next(); min = Number(next().v); continue; }
        if (at("on") && at("delete", 1)) { next(); next(); onDelete = ident(); continue; }
        // on change touch: a change to the row updates the referenced row's updated time
        if (at("on") && at("change", 1)) { next(); next(); expect("touch"); touches = true; continue; }
        if (at("touches")) { if (!legacy) fail("PARSE_FIELD", "write on change touch"); const t = next(); edit(t.off, t.end, "on change touch", "touches"); touches = true; continue; }
        if (at("searchable")) { next(); searchable = true; continue; }
        if (at("was")) { next(); was = ident("the field's previous name"); continue; }
        if (at("private")) { next(); priv = true; continue; }
        if (at("write_only")) { next(); writeOnly = true; continue; }
        break;
      }
      let def: Expr | undefined; if (at("=")) { next(); def = expr(); }
      fields.push({ name: fname, type, onDelete, touches, searchable, private: priv, writeOnly, default: def, was, max, min, pos: fpos });
    }
    expect("}"); return { kind: "entity", name, singleton, fields, uniques, invariants, indexes, was, pos };
  }
  // ---- options: a declaration's settings, a line each at the top of its body, in any order
  //   screen room(room: Room) { route "/rooms/:room"  layout app  access public  … }
  // A setting with a closed set of values says which when it gets another.
  function oneOf(what: string, values: string[]): string {
    const t = peek(); const v = ident(`${what}: ${values.join(" or ")}`);
    if (!values.includes(v)) fail("OPTION_VALUE", `${what} takes ${values.join(" or ")}, not '${v}'`, t);
    return v;
  }
  function once(seen: Set<string>, key: string, t: Tok) {
    if (seen.has(key)) fail("OPTION_REPEATED", `${key} is set twice`, t);
    seen.add(key);
  }
  // (legacy) a header modifier, removed where it was: its tokens and the spaces before them, and
  // its line when nothing else is on it (a comment beside it stays)
  function drop(first: Tok, lastTok: Tok, g: number, what: string) {
    let a = first.off; while (a > 0 && (src[a - 1] === " " || src[a - 1] === "\t")) a--;
    let b = lastTok.end;
    if (a === 0 || src[a - 1] === "\n") { let c = b; while (src[c] === " " || src[c] === "\t") c++; if (src[c] === "\n" || c >= src.length) b = c + 1; else if (src[c] === "/" && src[c + 1] === "/") { a = first.off; b = lastTok.end; } }
    edit(a, Math.min(b, src.length), "", what, g);
  }
  // (legacy) the option lines, at the top of the body that opens at brace: on their own lines when
  // the brace ends its line, else on the brace's line
  function putOptions(brace: Tok, lines: string[], g: number, what: string, declStart: number) {
    if (!lines.length) return;
    let ls = declStart; while (ls > 0 && src[ls - 1] !== "\n") ls--;
    const indent = (/^[ \t]*/.exec(src.slice(ls)) ?? [""])[0] + "  ";
    const eol = src.indexOf("\n", brace.end);
    const rest = src.slice(brace.end, eol < 0 ? src.length : eol);
    if (eol >= 0 && /^\s*(\/\/.*)?$/.test(rest)) edit(eol + 1, eol + 1, lines.map((l) => indent + l + "\n").join(""), what, g);
    else edit(brace.end, brace.end, " " + lines.join("  ") + " ", what, g);
  }
  // (legacy) a header that had no body: its settings now in one
  function wrapOptions(after: Tok, lastTok: Tok, g: number, what: string) {
    const multi = src.slice(after.end, lastTok.end).includes("\n");
    // the brace before a comment beside the header's first line
    edit(after.end, after.end, " {", what, g);
    edit(lastTok.end, lastTok.end, multi ? "\n}" : " }", what, g);
  }
  const text2 = (a: Tok, b: Tok) => src.slice(a.off, b.end);

  function action(pos: Pos, internal: boolean): Decl {
    const nameTok = peek(); const name = ident(); const ps = params(); const skips: string[] = [];
    // skip gate g: the action runs without that gate (a setting, the first lines of the body)
    if (at("skip")) {
      if (!legacy) fail("PARSE_OPTIONS", "write skip gate … as the first line of the action's body");
      const g = ++groups; const lines: string[] = [];
      while (at("skip")) { const a = next(); expect("gate"); const gt = peek(); skips.push(ident("a gate name")); drop(a, gt, g, "skip gate"); lines.push(`skip gate ${gt.v}`); }
      const brace = peek(); const body = block(); putOptions(brace, lines, g, "skip gate", nameTok.off);
      return { kind: "action", name, params: ps, skips, internal, body, pos };
    }
    expect("{"); const out: Stmt[] = []; const no: Record<string, boolean> = {};
    // settings, the body's first lines: skip gate g; agents no (people only); people no (agents only)
    for (;;) {
      if (at("skip") && at("gate", 1)) { next(); next(); const t = peek(); const gname = ident("a gate name"); if (skips.includes(gname)) fail("OPTION_REPEATED", `skip gate ${gname} is set twice`, t); skips.push(gname); }
      else if (callersNo(no)) { /* taken */ }
      else break;
    }
    while (!at("}")) out.push(stmt());
    expect("}");
    return { kind: "action", name, params: ps, skips, internal, body: out, ...no, pos };
  }
  // agents no / people no: who may not call an action or view (noAgents, noPeople)
  function callersNo(no: Record<string, boolean>): boolean {
    if (!((at("agents") || at("people")) && at("no", 1))) return false;
    const t = next(); next();
    const key = t.v === "agents" ? "noAgents" : "noPeople";
    if (no[key]) fail("OPTION_REPEATED", `${t.v} no is set twice`, t);
    no[key] = true;
    return true;
  }
  function view(pos: Pos): Decl {
    const nameTok = peek(); const name = ident(); const ps = params();
    const v: any = { kind: "view", name, params: ps, requires: [], live: false, pos };
    const g = ++groups;
    // (legacy) view v(…) live … / view v(…) [live] value e
    let liveTok: Tok | undefined;
    if (at("live")) { if (!legacy) fail("PARSE_OPTIONS", "write updates live as the first line of the view's body"); liveTok = next(); v.live = true; }
    if (at("value")) {
      if (!legacy) fail("PARSE_OPTIONS", "write a value view's value in its body: view v(…) { value … }");
      const vt = next(); v.value = expr();
      if (liveTok) drop(liveTok, liveTok, g, "view live");
      edit(vt.off, vt.off, `{ ${liveTok ? "updates live  " : ""}`, "view value", g); edit(last().end, last().end, " }", "view value", g);
      return v;
    }
    const brace = expect("{");
    if (liveTok) { drop(liveTok, liveTok, g, "view live"); putOptions(brace, ["updates live"], g, "view live", nameTok.off); }
    const seen = new Set<string>();
    while (!at("}")) {
      if (at("updates")) { once(seen, "updates", next()); v.live = oneOf("updates", ["live", "none"]) === "live"; }
      else if (callersNo(v)) { /* taken */ }
      else if (at("value")) { next(); v.value = expr(); }
      else if (at("require")) { next(); const cond = expr(); expect("else"); v.requires.push({ cond, outcome: outcome(), reason: reason() }); }
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
    expect("}");
    if (v.value && v.rows) fail("PARSE_VIEW", `view ${name} has both rows and a value`);
    return v;
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
      // export name(params) { route "/path"  format csv|json  of view(args) as row  named filename  "Column": .field, … }:
      // a download of a view's rows, a column per entry (a screen whose page is a file)
      case "export": {
        const et = next(); const nameTok = peek(); const name = ident("an export name");
        let route = "", ps: any[] = [], format = "", source: Expr | undefined, as: string | undefined, filename: Expr | undefined;
        if (peek().t === "str") {
          // (legacy) export name "/route" (params) csv of view(args) [as m] [named e] { … }
          if (!legacy) fail("PARSE_OPTIONS", `write export ${name}(…) { route "…"  format …  of …  … }`);
          const g = ++groups; const rt = next(); route = rt.v; const lp = peek(); ps = at("(") ? params() : [];
          edit(nameTok.end, lp.v === "(" ? lp.off : rt.end, "", "export header", g);
          const ft = peek(); format = ident("csv or json");
          expect("of"); const sstart = peek(); source = expr(); let send = last();
          if (at("as")) { next(); as = ident("a name for the row"); send = last(); }
          let nt: Tok | undefined, nstart: Tok | undefined, nend: Tok | undefined;
          if (at("named")) { nt = next(); nstart = peek(); filename = expr(); nend = last(); }
          const lines = [`route ${JSON.stringify(route)}`, `format ${format}`, `of ${text2(sstart, send)}`, ...(nt ? [`named ${text2(nstart!, nend!)}`] : [])];
          drop(ft, nend ?? send, g, "export header");
          const brace = peek(); expect("{");
          putOptions(brace, lines, g, "export header", et.off);
        } else {
          ps = at("(") ? params() : [];
          expect("{"); const seen = new Set<string>();
          for (;;) {
            const t = peek();
            if (at("route")) { once(seen, "route", next()); if (peek().t !== "str") fail("PARSE_EXPORT", `route takes the address in quotes: route "/rooms/:room/export.csv"`); route = next().v; continue; }
            if (at("format")) { once(seen, "format", next()); format = oneOf("format", ["csv", "json"]); continue; }
            if (at("of")) { once(seen, "of", next()); source = expr(); if (at("as")) { next(); as = ident("a name for the row"); } continue; }
            if (at("named")) { once(seen, "named", next()); filename = expr(); continue; }
            void t; break;
          }
          if (!route) fail("PARSE_EXPORT", `export ${name} needs its address: route "/…"`);
          if (!format) fail("PARSE_EXPORT", `export ${name} needs format csv or format json`);
          if (!source) fail("PARSE_EXPORT", `export ${name} needs the rows it exports: of view(…)`);
        }
        if (format !== "csv" && format !== "json") fail("PARSE_EXPORT", `an export is csv or json, not '${format}'`);
        const columns: { key: string; value: Expr; pos: Pos }[] = [];
        while (!at("}")) { const kpos = peek().pos; const key = peek().t === "str" ? next().v : ident("a column name"); expect(":"); columns.push({ key, value: expr(), pos: kpos }); if (at(",")) next(); }
        expect("}");
        return { kind: "screen", name, route, params: ps, requires: [], body: [], file: { format, source, as, filename, columns }, pos } as any;
      }
      // schedule name for x in Entity [where c] { at x.field [± duration]  if missed run|skip  … }
      // schedule name { every day at "08:00" [in "Zone"]  … }   or   { every <duration>  … }
      case "schedule": {
        const st = next(); const name = ident("a schedule name"); const d: any = { kind: "schedule", name, pos };
        if (at("for")) { next(); d.bind = ident("a row name"); expect("in"); d.entity = ident("an entity name"); if (at("where")) { next(); d.where = expr(); } }
        const every = () => {
          if (at("day")) {
            next(); expect("at"); if (peek().t !== "str") fail("PARSE_SCHEDULE", `every day at takes a quoted time of day: every day at "08:00"`);
            const tod = next().v; if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(tod)) fail("PARSE_SCHEDULE", `"${tod}" isn't a time of day (HH:MM, 24-hour)`);
            d.every = { daily: tod };
            if (at("in")) { next(); if (peek().t !== "str") fail("PARSE_SCHEDULE", `in takes a quoted time zone: in "America/New_York"`); d.every.zone = next().v; }
          } else { const e = expr(); if (e.kind !== "duration") fail("PARSE_SCHEDULE", "every takes a duration (every 15 min) or day at \"HH:MM\""); d.every = { period: e }; }
        };
        if (at("at") || at("every")) {
          // (legacy) the time before the body: at x.f … past_due fire|skip, or every …
          if (!legacy) fail("PARSE_OPTIONS", "write the schedule's at …, if missed … or every … as the first lines of its body");
          const g = ++groups; const lines: string[] = [];
          if (at("at")) {
            const a = next(); const s0 = peek(); d.at = expr(); const s1 = last();
            if (!at("past_due")) fail("PARSE_SCHEDULE", "a schedule for rows says what happens to rows already past due when it's first deployed");
            next(); const pt = peek(); const p = ident("fire or skip"); if (p !== "fire" && p !== "skip") fail("PARSE_SCHEDULE", `past_due takes fire or skip, not '${p}'`);
            d.pastDue = p; drop(a, pt, g, "schedule header"); lines.push(`at ${text2(s0, s1)}`, `if missed ${p === "fire" ? "run" : "skip"}`);
          } else { const a = next(); const s0 = peek(); every(); const s1 = last(); drop(a, s1, g, "schedule header"); lines.push(`every ${text2(s0, s1)}`); }
          const brace = peek(); d.body = block(); putOptions(brace, lines, g, "schedule header", st.off);
        } else {
          expect("{"); const seen = new Set<string>();
          for (;;) {
            if (at("at")) { once(seen, "at", next()); d.at = expr(); continue; }
            if (at("every")) { once(seen, "every", next()); every(); continue; }
            if (at("if") && at("missed", 1) && (at("run", 2) || at("skip", 2))) { once(seen, "if missed", next()); next(); d.pastDue = next().v === "run" ? "fire" : "skip"; continue; }
            break;
          }
          const out: Stmt[] = []; while (!at("}")) out.push(stmt()); expect("}"); d.body = out;
        }
        if (d.bind ? !d.at : !d.every) fail("PARSE_SCHEDULE", d.bind ? `schedule ${name} runs for rows: say when, at ${d.bind}.<a time field>` : `schedule ${name} needs every … (every day at "08:00", every 15 min) or for x in Entity with at …`);
        if (d.bind && !d.pastDue) fail("PARSE_SCHEDULE", `schedule ${name} says what happens to rows already past their time when it's first deployed: if missed run (they run then) or if missed skip`);
        if (d.bind && d.every) fail("PARSE_SCHEDULE", `a schedule for rows runs at each row's time, not every …`);
        return d;
      }
      // invariant name: condition, true of the data at every moment between actions (lang/invariants.ts
      // proves each action keeps it, with Z3)
      case "invariant": { next(); const name = ident("the invariant's name"); expect(":"); return { kind: "invariant", name, cond: expr(), pos }; }
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
      // channel name(params) { requires c  on open action(…)  on close action(…)  every 50 s action(…) }
      case "channel": {
        next(); const name = ident(); const ps = params(); const d: any = { kind: "channel", name, params: ps, pos };
        const after = last();
        const legacyForm = !at("{");
        if (legacyForm && !legacy) fail("PARSE_OPTIONS", `write the channel's settings in braces: channel ${name}(…) { requires …  on open …  every … }`);
        if (!legacyForm) next();
        const seen = new Set<string>();
        for (;;) {
          if (at("requires")) { once(seen, "requires", next()); d.requires = expr(); continue; }
          if (at("on")) { next(); const t = peek(); const w = oneOf("on", ["open", "close"]); once(seen, `on ${w}`, t); d[w] = target(); continue; }
          if (at("every")) { once(seen, "every", next()); d.every = { interval: primary(), target: target() }; continue; }
          break;
        }
        if (legacyForm) { if (last() !== after) wrapOptions(after, last(), ++groups, "channel"); }
        else expect("}");
        return d;
      }
      // signal name(params) { to audience  carries { field: Type, … }  requires c }
      case "signal": {
        next(); const name = ident(); const ps = params(); const after = last();
        const legacyForm = !at("{");
        if (legacyForm && !legacy) fail("PARSE_OPTIONS", `write the signal's settings in braces: signal ${name}(…) { to …  carries { … }  requires … }`);
        if (!legacyForm) next();
        const d: any = { kind: "signal", name, params: ps, pos };
        const seen = new Set<string>();
        for (;;) {
          if (at("to")) { once(seen, "to", next()); d.to = expr(); continue; }
          if (at("carries")) { once(seen, "carries", next()); d.carries = jsonObj(); continue; }
          if (at("requires")) { once(seen, "requires", next()); d.requires = expr(); continue; }
          break;
        }
        if (!d.to || !d.carries) fail("PARSE_SIGNAL", `signal ${name} needs to … (who gets it) and carries { … } (what it sends)`);
        const out = { kind: "signal", name, params: ps, to: d.to, carries: d.carries, pos, ...(d.requires ? { requires: d.requires } : {}) };
        if (legacyForm) wrapOptions(after, last(), ++groups, "signal");
        else expect("}");
        return out as any;
      }
      // api name { route "/api/…"  identity bot_key  skip gate g  get "" -> view(…) … }
      case "api": {
        const at0 = next(); const nameTok = peek(); const name = ident(); let route = "", identityName = ""; const skips: string[] = [];
        if (peek().t === "str") {
          // (legacy) api name "/route" identity x [skip gate g] { routes }
          if (!legacy) fail("PARSE_OPTIONS", `write api ${name} { route "…"  identity …  … }`);
          const g = ++groups; const rt = next(); route = rt.v; const it = expect("identity"); const idt = peek(); identityName = ident(); const lines = [`route ${JSON.stringify(route)}`, `identity ${identityName}`];
          let lastTok = idt;
          while (at("skip")) { next(); expect("gate"); const gt = peek(); skips.push(ident("a gate name")); lastTok = gt; lines.push(`skip gate ${gt.v}`); }
          drop(rt, lastTok, g, "api header"); void it;
          const brace = expect("{"); putOptions(brace, lines, g, "api header", at0.off);
        } else {
          expect("{"); const seen = new Set<string>();
          for (;;) {
            if (at("route")) { once(seen, "route", next()); if (peek().t !== "str") fail("PARSE_API", `route takes the address in quotes`); route = next().v; continue; }
            if (at("identity")) { once(seen, "identity", next()); identityName = ident("an identity"); continue; }
            if (at("skip") && at("gate", 1)) { next(); next(); const t = peek(); const gname = ident("a gate name"); if (skips.includes(gname)) fail("OPTION_REPEATED", `skip gate ${gname} is set twice`, t); skips.push(gname); continue; }
            break;
          }
          if (!route || !identityName) fail("PARSE_API", `api ${name} needs route "…" and identity …`);
        }
        void nameTok;
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
        while (!at("}")) {
          const p = ident();
          // classes { button: "btn", … }: the class each kind of element gets (lang/check.ts THEME_CLASSES)
          if (p === "classes" && at("json") && at("{", 1)) { if (!legacy) fail("PARSE_THEME", "write classes { button: \"…\", … }, without json"); const j = next(); edit(j.off, peek().off, "", "classes json"); }
          props[p] = p === "classes" && at("{") ? jsonObj() : expr();
        }
        expect("}"); return { kind: "theme", name, props, pos };
      }
      case "layout": { next(); const name = ident(); return { kind: "layout", name, body: uiBlock(), pos }; }
      // widget name(params): an app's own widget, implemented in the module given to the runtime with --widgets
      case "widget": { next(); const name = ident(); return { kind: "widget", name, params: params(), pos }; }
      // native component name(params) / native common(params): a UI element the compiler and
      // runtime implement, and the attributes every element takes (lang/std/ui.crud)
      case "native": {
        next();
        if (at("common")) { next(); return { kind: "native", name: "common", common: true, params: params(), pos }; }
        expect("component"); const name = ident("an element name"); return { kind: "native", name, params: params(), pos };
      }
      case "component": {
        // a component is named as its tag is written: MessageItem (before v4, message_item)
        next(); const nt = peek(); let name = ident();
        if (!/^[A-Z]/.test(name)) { if (!legacy) fail("UI_TAG_CASE", `name the component ${pascal(name)}: components start with a capital, as their tags do`, nt); edit(nt.off, nt.end, pascal(name), "tag case"); name = pascal(name); }
        const ps = params(); return { kind: "component", name, params: ps, body: uiBlock(), pos };
      }
      // screen name(params) { route "/path"  layout app  access public|signed_in  remember name  require …  <markup> }
      case "screen": {
        const st = next(); const nameTok = peek(); const name = ident();
        const d: any = { kind: "screen", name, route: "", params: [], layout: "", pos, public: false };
        const g = ++groups; const lines: string[] = [];
        // (legacy) screen name ["/route"] [(params)] layout L [public] [remember "x"] { … }
        if (peek().t === "str") {
          if (!legacy) fail("PARSE_OPTIONS", `write screen ${name}(…) { route "…"  layout …  … }`);
          const rt = next(); d.route = rt.v; lines.push(`route ${JSON.stringify(d.route)}`); const lp = peek(); edit(nameTok.end, lp.v === "(" ? lp.off : rt.end, "", "screen header", g);
        }
        if (at("(")) d.params = params();
        if (at("layout")) {
          if (!legacy) fail("PARSE_OPTIONS", `write the screen's layout as the first line of its body: screen ${name}(…) { layout …  … }`);
          const lt = next(); d.layout = ident(); lines.push(`layout ${d.layout}`); let lastTok = last();
          for (;;) {
            if (at("public")) { next(); d.public = true; lines.push("access public"); lastTok = last(); continue; }
            if (at("remember")) { next(); const t = next(); d.remember = t.v; if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.v)) fail("UPGRADE_UNSUPPORTED", `remember "${t.v}": a name, please`, t); lines.push(`remember ${t.v}`); lastTok = t; continue; }
            break;
          }
          drop(lt, lastTok, g, "screen header");
          const brace = peek(); expect("{"); putOptions(brace, lines, g, "screen header", st.off);
        } else {
          expect("{"); const seen = new Set<string>();
          for (;;) {
            if (at("route")) { once(seen, "route", next()); if (peek().t !== "str") fail("PARSE_SCREEN", `route takes the address in quotes: route "/rooms/:room"`); d.route = next().v; continue; }
            if (at("layout") && peek(1).t === "id") { once(seen, "layout", next()); d.layout = ident("a layout"); continue; }
            if (at("access")) { once(seen, "access", next()); d.public = oneOf("access", ["public", "signed_in"]) === "public"; continue; }
            if (at("remember")) { once(seen, "remember", next()); d.remember = ident("a name for the cookie"); continue; }
            break;
          }
          if (!d.layout) fail("PARSE_SCREEN", `screen ${name} needs its layout: layout <name>`);
        }
        const requires: any[] = []; const body: El[] = [];
        while (!at("}")) {
          if (at("require")) {
            const rpos = next().pos; const cond = expr(); expect("else");
            if (at("go")) { next(); const tg = target(); let flash: Expr | undefined; if (at("flash")) { next(); flash = add(); /* no comparisons: a "<" next is the markup */ } requires.push({ cond, go: tg, flash, pos: rpos }); }
            else requires.push({ cond, outcome: outcome(), pos: rpos });
          } else if (at("{")) {
            // {if …} and the like among the screen's parts
            if (!codeAhead()) fail("UI_EXPECTED", "a screen's parts are elements, {if …}, {let …}, {for each …} or {match …}: text goes in an element");
            next(); code(body); expect("}");
          } else if (!markupItem(body)) fail("UI_EXPECTED", `expected an element (<…>), {if …}, {let …}, {for each …}, {match …} or require, found '${peek().v || "end of file"}'`);
        }
        expect("}"); d.requires = requires; d.body = body;
        // the old form's key order, so a rewrite reads as the same program
        return { kind: "screen", name, route: d.route, params: d.params, layout: d.layout, pos, public: d.public, ...(d.remember !== undefined ? { remember: d.remember } : {}), requires, body } as any;
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
  for (const c of comps.values()) if (BY_TAG[c.name]) throw new SpecError("UI_TAG_CLASH", `component ${c.name} has a built-in element's name: <${c.name}> would be the element; name it something else`, c.pos);
  const props = (els: El[]) => { for (const el of els) {
    if (el.name === "use" && el.head?.__props) {
      const c = comps.get(el.head.name);
      if (!c) throw new SpecError("UI_ELEMENT", `unknown UI element or component '${el.head.name}'; the elements: ${Object.values(TAG_OF).filter((n) => n !== "Use").join(", ")}${comps.size ? `; the components: ${[...comps.keys()].join(", ")}` : ""} (node lang/cli.ts reference)`, el.pos);
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

// the standard library's UI vocabulary (above), read once
loadStd(readFileSync(new URL("./std/ui.crud", import.meta.url), "utf8"));

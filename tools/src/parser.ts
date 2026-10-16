// Lexer and recursive-descent parser for crudspec v1. Newlines carry no meaning:
// every statement and declaration starts with a keyword, and an expression ends
// where the next token can't continue it.
import type { Decl, Expr, Field, Param, Pos, Spec, Stmt, TypeRef, TriggerEvent, Assign, ViewDecl } from "./ast.ts";
import { OUTCOMES } from "./ast.ts";

type Tok = { t: "id" | "str" | "int" | "p" | "eof"; v: string; pos: Pos };

export class SpecError extends Error {
  pos: Pos;
  code: string;
  constructor(code: string, message: string, pos: Pos) {
    super(`${pos.line}:${pos.col} ${code}: ${message}`);
    this.code = code;
    this.pos = pos;
  }
}

const PUNCT = ["==", "!=", "<=", ">=", "->", "{", "}", "(", ")", ",", ":", ".", "=", "<", ">", "?"];

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, line = 1, col = 1;
  const adv = (n: number) => { for (let k = 0; k < n; k++) { if (src[i] === "\n") { line++; col = 1; } else col++; i++; } };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { adv(1); continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") adv(1); continue; }
    const pos = { line, col };
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j), pos }); adv(j - i); continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i; while (j < src.length && /[0-9]/.test(src[j])) j++;
      toks.push({ t: "int", v: src.slice(i, j), pos }); adv(j - i); continue;
    }
    if (c === '"') {
      let j = i + 1, out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && (src[j + 1] === '"' || src[j + 1] === "\\")) { out += src[j + 1]; j += 2; }
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
  toks.push({ t: "eof", v: "", pos: { line, col } });
  return toks;
}

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

  function typeRef(): TypeRef {
    if (at("set")) { next(); expect("of"); return { kind: "set", of: ident("an entity name") }; }
    const name = ident("a type");
    const optional = at("?") ? (next(), true) : false;
    return { kind: "named", name, optional };
  }

  function params(): Param[] {
    expect("(");
    const ps: Param[] = [];
    while (!at(")")) {
      const pos = peek().pos; const name = ident("a parameter name"); expect(":");
      ps.push({ name, type: typeRef(), pos });
      if (!at(")")) expect(",");
    }
    expect(")");
    return ps;
  }

  // ---- expressions: implies < or < and < not < comparison < postfix < primary
  function expr(): Expr { return implies(); }
  function implies(): Expr {
    let l = or();
    while (at("implies")) { const pos = next().pos; l = { kind: "binary", op: "implies", left: l, right: or(), pos }; }
    return l;
  }
  function or(): Expr {
    let l = and();
    while (at("or")) { const pos = next().pos; l = { kind: "binary", op: "or", left: l, right: and(), pos }; }
    return l;
  }
  function and(): Expr {
    let l = not();
    while (at("and")) { const pos = next().pos; l = { kind: "binary", op: "and", left: l, right: not(), pos }; }
    return l;
  }
  function not(): Expr {
    if (at("not")) { const pos = next().pos; return { kind: "unary", op: "not", arg: not(), pos }; }
    return cmp();
  }
  function cmp(): Expr {
    const l = postfix();
    for (const op of ["==", "!=", "<=", ">=", "<", ">", "in"]) {
      if (at(op)) { const pos = next().pos; return { kind: "binary", op, left: l, right: postfix(), pos }; }
    }
    return l;
  }
  function postfix(): Expr {
    let e = primary();
    while (at(".") && peek(1).t === "id") { const pos = next().pos; e = { kind: "field", target: e, name: next().v, pos }; }
    return e;
  }
  function query(entityExpected = true) {
    const entity = ident("an entity name");
    let where: Expr | undefined;
    if (at("where")) { next(); where = expr(); }
    return { entity, where };
  }
  function primary(): Expr {
    const t = peek();
    const pos = t.pos;
    if (t.t === "str") { next(); return { kind: "lit", value: t.v, pos }; }
    if (t.t === "int") { next(); return { kind: "lit", value: Number(t.v), pos }; }
    if (at("(")) { next(); const e = expr(); expect(")"); return e; }
    if (at("{")) {
      next(); const items: Expr[] = [];
      while (!at("}")) { items.push(expr()); if (!at("}")) expect(","); }
      expect("}"); return { kind: "setlit", items, pos };
    }
    if (at(".")) { next(); return { kind: "rowfield", name: ident("a field name"), pos }; }
    if (t.t !== "id") fail("PARSE_EXPR", `expected an expression, found '${t.v || "end of file"}'`);
    if (t.v === "true" || t.v === "false") { next(); return { kind: "lit", value: t.v === "true", pos }; }
    if (t.v === "none") { next(); return { kind: "lit", value: null, pos }; }
    if (t.v === "it") { next(); return { kind: "it", pos }; }
    if (t.v === "if") {
      next(); const cond = expr(); expect("then"); const th = expr(); expect("else");
      return { kind: "if", cond, then: th, else: expr(), pos };
    }
    if ((t.v === "exists" || t.v === "count" || t.v === "the") && at("(", 1)) {
      next(); next(); const q = query(); expect(")");
      return { kind: "query", op: t.v as "exists" | "count" | "the", entity: q.entity, where: q.where, pos };
    }
    if (t.v === "all" && at("(", 1)) {
      next(); next(); const q = query(); expect(":"); const cond = expr(); expect(")");
      return { kind: "all", entity: q.entity, where: q.where, cond, pos };
    }
    next();
    if (at("(")) {
      next(); const args: Expr[] = [];
      while (!at(")")) { args.push(expr()); if (!at(")")) expect(","); }
      expect(")"); return { kind: "call", name: t.v, args, pos };
    }
    return { kind: "name", name: t.v, pos };
  }

  // ---- statements
  function block(): Stmt[] {
    expect("{"); const out: Stmt[] = [];
    while (!at("}")) out.push(stmt());
    expect("}"); return out;
  }
  function assigns(): Assign[] {
    expect("{"); const out: Assign[] = [];
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
        expect("=");
        const f = lhs as Extract<Expr, { kind: "field" }>;
        return { kind: "set", target: f.target, name: f.name, value: expr(), pos };
      }
      case "delete": {
        next();
        if (peek().t === "id" && /^[A-Z]/.test(peek().v) && !at(".", 1)) {
          const q = query(); return { kind: "deleteWhere", entity: q.entity, where: q.where, pos };
        }
        return { kind: "delete", target: expr(), pos };
      }
      case "for": {
        next(); expect("each"); const bind = ident("a loop variable"); expect("in"); const q = query();
        return { kind: "foreach", bind, entity: q.entity, where: q.where, body: block(), pos };
      }
      case "if": {
        next(); const cond = expr(); const th = block(); let el: Stmt[] = [];
        if (at("else")) { next(); el = at("if") ? [stmt()] : block(); }
        return { kind: "if", cond, then: th, else: el, pos };
      }
      case "emit": {
        next(); const event = ident("an event name"); expect("("); const args: Expr[] = [];
        while (!at(")")) { args.push(expr()); if (!at(")")) expect(","); }
        expect(")"); return { kind: "emit", event, args, pos };
      }
      case "reject": { next(); return { kind: "reject", outcome: outcome(), pos }; }
    }
    return fail("PARSE_STMT", `expected a statement (require, create, ensure, set, delete, for each, if, emit, reject), found '${t.v || "end of file"}'`);
  }

  // ---- declarations
  function entityBody(name: string, singleton: boolean, pos: Pos): Decl {
    expect("{"); const fields: Field[] = []; const uniques: string[][] = []; const invariants: Expr[] = [];
    while (!at("}")) {
      if (at("unique")) {
        next(); expect("("); const cols: string[] = [];
        while (!at(")")) { cols.push(ident("a field name")); if (!at(")")) expect(","); }
        expect(")"); uniques.push(cols); continue;
      }
      if (at("invariant")) { next(); invariants.push(expr()); continue; }
      const fpos = peek().pos; const fname = ident("a field name"); expect(":"); const type = typeRef();
      let onDelete: "cascade" | "restrict" = "restrict";
      if (at("on")) { next(); expect("delete"); const v = ident(); if (v !== "cascade" && v !== "restrict") fail("PARSE_ON_DELETE", "on delete must be cascade or restrict"); onDelete = v as "cascade" | "restrict"; }
      let def: Expr | undefined; if (at("=")) { next(); def = expr(); }
      fields.push({ name: fname, type, onDelete, default: def, pos: fpos });
    }
    expect("}");
    return { kind: "entity", name, singleton, fields, uniques, invariants, pos };
  }

  function decl(): Decl {
    const t = peek(); const pos = t.pos;
    switch (t.v) {
      case "enum": {
        next(); const name = ident("an enum name"); expect("{"); const values: string[] = [];
        while (!at("}")) { values.push(ident("an enum value")); if (!at("}")) expect(","); }
        expect("}"); return { kind: "enum", name, values, pos };
      }
      case "entity": case "singleton": { next(); return entityBody(ident("an entity name"), t.v === "singleton", pos); }
      case "predicate": { next(); const name = ident(); const ps = params(); expect("="); return { kind: "predicate", name, params: ps, body: expr(), pos }; }
      case "gate": { next(); const name = ident(); expect(":"); const cond = expr(); expect("->"); return { kind: "gate", name, cond, outcome: outcome(), pos }; }
      case "action": {
        next(); const name = ident(); const ps = params(); const skips: string[] = [];
        while (at("skip")) { next(); expect("gate"); skips.push(ident("a gate name")); }
        return { kind: "action", name, params: ps, skips, body: block(), pos };
      }
      case "trigger": {
        next(); expect("on"); let on: TriggerEvent;
        const kind = ident();
        if (kind === "create" || kind === "delete") on = { kind, entity: ident("an entity name") };
        else if (kind === "update") { const entity = ident("an entity name"); expect("."); on = { kind: "update", entity, field: ident("a field name") }; }
        else { on = { kind: "event", event: kind }; }
        let bind = "";
        if (on.kind === "event") { expect("("); bind = ident(); expect(")"); }
        else { expect("as"); bind = ident(); }
        let when: Expr | undefined; if (at("when")) { next(); when = expr(); }
        return { kind: "trigger", on, bind, when, body: block(), pos };
      }
      case "workflow": {
        next(); expect("on"); const event = ident("an event name"); expect("("); const bind = ident(); expect(")");
        expect("{"); const steps: { name: string; body: Stmt[] }[] = [];
        while (!at("}")) {
          expect("step"); const sname = ident("a step name"); expect(":"); const body: Stmt[] = [];
          while (!at("step") && !at("}")) body.push(stmt());
          steps.push({ name: sname, body });
        }
        expect("}"); return { kind: "workflow", event, bind, steps, pos };
      }
      case "permission": { next(); expect("read"); const entity = ident(); expect(":"); return { kind: "permission", entity, cond: expr(), pos }; }
      case "view": {
        next(); const name = ident(); const ps = params(); expect("{");
        const v: ViewDecl = { kind: "view", name, params: ps, requires: [], rows: { entity: "" }, orderBy: "created", pos };
        while (!at("}")) {
          if (at("require")) { next(); const cond = expr(); expect("else"); v.requires.push({ cond, outcome: outcome() }); }
          else if (at("rows")) { next(); const q = query(); v.rows = q; }
          else if (at("order")) { next(); expect("by"); v.orderBy = ident(); }
          else if (at("window")) {
            next(); const n = peek(); if (n.t !== "int") fail("PARSE_WINDOW", "window needs a size"); next();
            const end = ident(); if (end !== "last" && end !== "first") fail("PARSE_WINDOW", "window end must be last or first");
            let unless: Expr | undefined; if (at("unless")) { next(); unless = expr(); }
            v.window = { size: Number(n.v), end: end as "last" | "first", unless };
          } else fail("PARSE_VIEW", `unexpected '${peek().v}' in view`);
        }
        expect("}"); return v;
      }
    }
    return fail("PARSE_DECL", `expected a declaration (enum, entity, singleton, predicate, gate, action, trigger, workflow, permission, view), found '${t.v || "end of file"}'`);
  }

  const decls: Decl[] = [];
  while (peek().t !== "eof") decls.push(decl());
  return { decls };
}

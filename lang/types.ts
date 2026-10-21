// The type pass: a type for every expression, and what can be none. It is the deep half of
// validation (the checker in check.ts resolves names; this proves the values fit), and the
// generator compiles to typed Go from its result.
//
// The rules are the language's (the compiled app's, gogen/rt): a field of none is none, `none < x` holds, a
// non-Bool condition is false. What is legal but almost surely a mistake is reported.
//
// Optional values narrow: after `x != none` (in `and`, `if … then`, `require`, or an `if`
// statement), `x` is known to be there. Facts are keyed by the expression's text, so a pure
// call (`sound_of(m) != none`) narrows too.
import type { Decl, El, Expr, Spec, Stmt } from "./parser.ts";
import { ELEMENTS, TAG_OF } from "./parser.ts";
import { paramSizes, textLength, fieldSize } from "./sizes.ts";
import { didYouMean } from "./didyoumean.ts";

export type Ty =
  | { k: "int" | "bool" | "text" | "time" | "dur" | "rich" | "file" | "password" | "any"; opt?: boolean }
  | { k: "enum"; e: string; opt?: boolean }
  | { k: "ref"; e: string; opt?: boolean }
  | { k: "set"; e: string }
  | { k: "list"; of: Ty }
  | { k: "obj"; fields?: Record<string, Ty>; closed?: boolean; opt?: boolean }   // closed: it has those fields and no others
  | { k: "old"; e: string }
  | { k: "none" }
  | { k: "entity"; e: string }
  | { k: "screen" } | { k: "apiref" } | { k: "reference" };

export type TypeFinding = { severity: "error" | "warning"; code: string; line: number; col?: number; message: string };
// reads: the entity fields each screen and component reads ("screen ticket" -> "Ticket.subject"), for the change review's exposure diff
// events: what each event's emits send (a workflow's argument)
export type Typed = { findings: TypeFinding[]; types: WeakMap<object, Ty>; reads: Map<string, Set<string>>; events: Map<string, Ty> };

const ANY: Ty = { k: "any" };
const T = (k: any, opt = false): Ty => ({ k, opt } as Ty);
// what the runtime's externs return (rt/externs.go DefaultExterns)
const RUNTIME_RESULTS: Record<string, Record<string, Ty>> = {
  post_json: { status: T("int"), content_type: T("text", true), text: T("text"), body: ANY, timed_out: T("bool") },
  opengraph: { title: T("text", true), url: T("text", true), image: T("text", true), description: T("text", true) },
};
const show = (t: Ty): string => {
  switch (t.k) {
    case "ref": return `${t.e}${t.opt ? "?" : ""}`;
    case "enum": return `${t.e}${t.opt ? "?" : ""}`;
    case "set": return `set of ${t.e}`;
    case "list": return `list of ${show(t.of)}`;
    case "old": return `the old ${t.e}`;
    case "entity": return `the entity ${t.e}`;
    default: return `${t.k}${(t as any).opt ? "?" : ""}`;
  }
};
const optional = (t: Ty) => (t as any).opt === true || t.k === "none";
const req = (t: Ty): Ty => ("opt" in t ? ({ ...t, opt: false } as Ty) : t);
const opt = (t: Ty): Ty => (["int", "bool", "text", "time", "dur", "rich", "file", "password", "any", "enum", "ref"].includes(t.k) ? ({ ...t, opt: true } as Ty) : t);
const canon = (e: any) => JSON.stringify(e, (k, v) => (k === "pos" ? undefined : v));
const TEXTY = new Set(["text", "rich", "enum", "password", "any"]);

export function typecheck(spec: Spec): Typed {
  const findings: TypeFinding[] = [];
  const types = new WeakMap<object, Ty>();
  const reads = new Map<string, Set<string>>();  // comprehensive field reads from all sources
  let reading: Set<string> | null = null;   // the context being typed (screen, action, etc.)
  const decls = spec.decls;
  const of = (k: string) => decls.filter((d) => d.kind === k);
  const get = (k: string, n: string) => decls.find((d) => d.kind === k && d.name === n);
  const ents = new Map<string, Decl>(decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => [d.name, d]));
  const enums = new Map<string, string[]>(of("enum").map((d) => [d.name, d.values]));
  const enumOf = new Map<string, string>();
  for (const [n, vs] of enums) for (const v of vs) enumOf.set(v, n);
  const appDecl = of("app")[0];
  const actorEntity: string = ents.has(appDecl?.props.actor?.name) ? appDecl.props.actor.name : "";   // none when it names no entity (check says so)
  // at: a line, or a position (line and column)
  const report = (severity: "error" | "warning", code: string, at: number | { line: number; col?: number } | undefined, message: string) => {
    const line = typeof at === "number" ? at : at?.line ?? 0, col = typeof at === "object" ? at?.col : undefined;
    if (!findings.some((f) => f.code === code && f.line === line && f.message === message)) findings.push({ severity, code, line, ...(col ? { col } : {}), message });
  };

  // a declared type
  const fromType = (t: any): Ty => {
    if (!t) return ANY;
    if (t.kind === "set") return { k: "set", e: t.of };
    if (t.kind === "list") return { k: "list", of: fromType(t.of) };
    const o = !!t.optional, n = t.name;
    if (ents.has(n)) return { k: "ref", e: n, opt: o };
    if (enums.has(n)) return { k: "enum", e: n, opt: o };
    switch (n) {
      case "Text": case "Email": case "Url": case "Ip": return T("text", o);
      case "Int": return T("int", o);
      case "Bool": return T("bool", o);
      case "Time": return T("time", o);
      case "Duration": return T("dur", o);
      case "RichText": return T("rich", o);
      case "File": return T("file", o);
      case "Password": return T("password", o);
      default: return T("any", o);   // Json, and extern result shapes
    }
  };
  const fieldTy = (e: string, f: string): Ty | null => {
    if (f === "id") return T("int");
    if (f === "created" || f === "updated") return T("time");
    const d = ents.get(e)?.fields.find((x: any) => x.name === f);
    return d ? fromType(d.type) : null;
  };

  // scopes: names and their types, the row in context, and what is known not to be none
  type Sc = { vars: Map<string, Ty>; row?: string; facts: Set<string>; dynamic?: boolean; actorThere?: boolean; form?: string };
  const actionSizes = new Map([...paramSizes(spec)].map(([d, m]) => [d.name, m]));
  const child = (s: Sc, o: Partial<Sc> = {}): Sc => ({ ...s, vars: new Map(s.vars), facts: new Set(s.facts), ...o });

  // what a condition, when true (or false), says about expressions being there
  const factsOf = (e: any, truth: boolean, out = new Set<string>()): Set<string> => {
    if (!e) return out;
    if (e.kind === "binary" && e.op === "and" && truth) { factsOf(e.left, true, out); factsOf(e.right, true, out); }
    else if (e.kind === "binary" && e.op === "or" && !truth) { factsOf(e.left, false, out); factsOf(e.right, false, out); }
    else if (e.kind === "unary" && e.op === "not") factsOf(e.arg, !truth, out);
    else if (e.kind === "binary" && (e.op === "!=" || e.op === "==") && (e.op === "!=") === truth) {
      const none = (x: any) => x?.kind === "lit" && x.value === null;
      if (none(e.right)) out.add(canon(e.left)); else if (none(e.left)) out.add(canon(e.right));
    }
    else if (e.kind === "call" && (e.name === "present") === truth && (e.name === "present" || e.name === "blank") && e.args[0]) out.add(canon(e.args[0]));
    // (x == y says nothing about x when y may be none: no fact)
    return out;
  };
  const known = (s: Sc, e: any) => s.facts.has(canon(e));

  // ---- expressions
  function ty(e: Expr, s: Sc): Ty {
    const t = ty0(e, s);
    types.set(e, t);
    return t;
  }
  // a Password is kept hashed and checked with authenticates(); shown, it would show the hash
  function notPassword(t: Ty, at: any, where: string) {
    if (t.k === "password") report("error", "TYPE_PASSWORD_SHOWN", at, `${where} shows a Password: it is stored hashed, and never shown`);
  }
  function cond(e: Expr, s: Sc, what: string) {
    // an if or a match as a condition: each arm is one
    if (e?.kind === "if" && e.then && e.else) {
      matchCheck(e, s);
      cond(e.cond, s, "the if's condition");
      cond(e.then, child(s, { facts: new Set([...s.facts, ...factsOf(e.cond, true)]) }), what);
      cond(e.else, child(s, { facts: new Set([...s.facts, ...factsOf(e.cond, false)]) }), what);
      return;
    }
    const t = ty(e, s);
    if (t.k !== "bool" && t.k !== "any") report("error", "TYPE_NOT_BOOL", e.pos, `${what} is ${show(t)}, not a Bool; it is never true`);
    else if (optional(t) && t.k === "bool") report("warning", "TYPE_OPTIONAL_BOOL", e.pos, `${what} may be none, which counts as false`);
  }
  function expectTexty(t: Ty, line: number | undefined, what: string) {
    if (!TEXTY.has(t.k) && t.k !== "none") report("error", "TYPE_MISMATCH", line, `${what} takes text, given ${show(t)}`);
  }
  function ty0(e: Expr, s: Sc): Ty {
    switch (e.kind) {
      case "lit": return e.value === null ? { k: "none" } : typeof e.value === "string" ? T("text") : typeof e.value === "number" ? T("int") : T("bool");
      case "duration": return T("dur");
      case "now": return T("time");
      case "it": return s.row ? { k: "ref", e: s.row } : ANY;
      case "rowfield": { const f = s.row ? fieldTy(s.row, e.name) ?? ANY : ANY; if (s.row && fieldTy(s.row, e.name)) reading?.add(`${s.row}.${e.name}`); return known(s, e) ? req(f) : f; }
      case "name": {
        const n = e.name;
        const v = s.vars.get(n);
        if (v) return known(s, e) ? req(v) : v;
        if (n === "actor") return actorEntity ? { k: "ref", e: actorEntity, opt: !(s.actorThere || known(s, e)) } : ANY;
        if (n === "result") return ANY;
        if (n === "request") return { k: "obj", closed: true, fields: { ip: T("text"), method: T("text"), identity: T("text"), user_agent: T("text", true), session_token: T("text", true), text: T("text", true), cookies: { k: "obj" } } };   // rt.Ctx.ReqObj
        if (n === "get" || n === "write" || get("identity", n)) return T("text");
        if (enumOf.has(n)) return { k: "enum", e: enumOf.get(n)! };
        const ent = ents.get(n);
        if (ent?.singleton) return { k: "ref", e: n };
        if (ent) return { k: "entity", e: n };
        if (get("view", n) || get("action", n) || get("screen", n)) return { k: "reference" };
        if (s.row) { const f = fieldTy(s.row, n); if (f) { reading?.add(`${s.row}.${n}`); return f; } }
        return ANY;
      }
      case "field": {
        if (e.target.kind === "name" && enums.has(e.target.name) && !s.vars.has(e.target.name)) return { k: "enum", e: e.target.name };
        const t = ty(e.target, s);
        const there = known(s, e);
        const wrap = (f: Ty) => (there ? req(f) : optional(t) ? opt(f) : f);
        switch (t.k) {
          case "ref": {
            const f = fieldTy(t.e, e.name);
            if (!f) { report("error", "TYPE_NO_FIELD", e.pos, `${t.e} has no field ${e.name}${didYouMean(e.name, ["id", "created", "updated", ...(ents.get(t.e)?.fields ?? []).map((f: any) => f.name)])}`); return ANY; }
            reading?.add(`${t.e}.${e.name}`);
            return wrap(f);
          }
          case "old": { const f = fieldTy(t.e, e.name); return f ? f : ANY; }
          // the fields a value of these types has (rt.ValueField)
          case "file": case "time": case "dur": case "rich": {
            const fields: Record<string, Ty> = ({
              file: { filename: T("text"), content_type: T("text"), size: T("int"), kind: T("text") },
              time: { time: T("int"), seq: T("int") }, dur: { ms: T("int") },
              rich: { rich: T("text"), mentions: { k: "list", of: T("int") }, entity: T("text"), embeds: { k: "list", of: ANY } },
            } as Record<string, Record<string, Ty>>)[t.k];
            if (!fields[e.name]) { report("error", "TYPE_NO_FIELD", e.pos, `${show(t)} has no field ${e.name}${didYouMean(e.name, Object.keys(fields)) || `; its fields are ${Object.keys(fields).join(", ")}`}`); return ANY; }
            return wrap(fields[e.name]);
          }
          case "none": report("warning", "TYPE_FIELD_OF_NONE", e.pos, `.${e.name} of none is always none`); return { k: "none" };
          case "int": case "bool": case "text": case "enum":
            report("error", "TYPE_NO_FIELD", e.pos, `${show(t)} has no field ${e.name}`); return ANY;
          case "list": case "set":
            report("error", "TYPE_NO_FIELD", e.pos, `.${e.name} of a ${t.k}`); return ANY;
          case "obj":
            if (t.closed && !t.fields?.[e.name]) { report("error", "TYPE_NO_FIELD", e.pos, `it has no field ${e.name}${didYouMean(e.name, Object.keys(t.fields ?? {})) || `; its fields are ${Object.keys(t.fields ?? {}).join(", ")}`}`); return ANY; }
            return wrap(t.fields?.[e.name] ?? ANY);
        }
        return ANY;
      }
      case "unary":
        if (e.op === "not") { cond(e.arg, s, "not's operand"); return T("bool"); }
        { const t = ty(e.arg, s); if (t.k !== "int" && t.k !== "any") report("error", "TYPE_MISMATCH", e.pos, `- of ${show(t)}`); return T("int"); }
      case "binary": return binary(e, s);
      // a text element's raw text and {…} parts
      case "interp": for (const part of e.parts) notPassword(ty(part, s), part.pos ?? e.pos, "text"); return T("text");
      case "if": {
        matchCheck(e, s);
        cond(e.cond, s, "the if's condition");
        const a = ty(e.then, child(s, { facts: new Set([...s.facts, ...factsOf(e.cond, true)]) }));
        const b = ty(e.else, child(s, { facts: new Set([...s.facts, ...factsOf(e.cond, false)]) }));
        return join(a, b);
      }
      case "listlit": case "setlit": {
        const items = e.items.map((i: Expr) => ty(i, s));
        return { k: "list", of: items.reduce((a: Ty | null, b: Ty) => (a ? join(a, b) : b), null) ?? ANY };
      }
      case "json": {
        const fields: Record<string, Ty> = {};
        for (const [k, v] of Object.entries(e.fields)) fields[k] = ty(v as Expr, s);
        return { k: "obj", fields };
      }
      case "query": case "all": case "listq": {
        if (!ents.has(e.entity)) return ANY;
        const rs = child(s, { row: e.entity });
        if (e.where) cond(e.where, rs, "the where");
        if (e.where) for (const f of factsOf(e.where, true)) rs.facts.add(f);
        if (e.order) ty(e.order, rs);
        if (e.limit) { const l = ty(e.limit, s); if (l.k !== "int" && l.k !== "any") report("error", "TYPE_MISMATCH", e.limit.pos, `limit is ${show(l)}, not an Int`); }
        if (e.kind === "all") { cond(e.cond, rs, "all's condition"); return T("bool"); }
        if (e.kind === "listq") return { k: "list", of: e.map ? ty(e.map, rs) : { k: "ref", e: e.entity } };
        switch (e.op) {
          case "exists": return T("bool");
          case "count": return T("int");
          case "the": return { k: "ref", e: e.entity };
          case "the_or_none": case "first_or_none": return { k: "ref", e: e.entity, opt: true };
          case "set": return { k: "set", e: e.entity };
        }
        return ANY;
      }
      case "extern": {
        const d = get("extern", e.name);
        if (d) args(d.params, e, s, `${e.name}()`); else for (const a of [...e.args, ...Object.values(e.named)]) ty(a as Expr, s);
        // a runtime extern's result has the runtime's shape (rt/externs.go)
        const shape = d && !d.go ? RUNTIME_RESULTS[e.name] : undefined;
        if (shape) return { k: "obj", fields: shape, closed: true, opt: !!d!.returns?.optional };
        return d?.returns ? fromType(d.returns) : ANY;
      }
      case "call": return call(e, s);
    }
    return ANY;
  }

  function join(a: Ty, b: Ty): Ty {
    if (a.k === "none") return opt(b);
    if (b.k === "none") return opt(a);
    if (a.k === "any" || b.k === "any") return ANY;
    if (a.k !== b.k) {
      if (TEXTY.has(a.k) && TEXTY.has(b.k)) return T("text", optional(a) || optional(b));
      return ANY;
    }
    if ((a.k === "ref" || a.k === "enum") && (a as any).e !== (b as any).e) return ANY;
    return optional(a) || optional(b) ? opt(a) : a;
  }

  function comparable(a: Ty, b: Ty): boolean {
    if (a.k === "any" || b.k === "any" || a.k === "none" || b.k === "none") return true;
    if (a.k === "ref" && b.k === "ref") return a.e === b.e;
    if (a.k === "enum" && b.k === "enum") return a.e === b.e;
    if (a.k === "enum" && b.k === "text" || a.k === "text" && b.k === "enum") return true;
    if (TEXTY.has(a.k) && TEXTY.has(b.k)) return true;
    return a.k === b.k;
  }

  // a match (parser.ts: an if per arm, keeping what the match said in __match): its subject is an
  // enum value; each of the enum's values, and none when the subject is optional, has exactly one arm
  function matchCheck(node: any, s: Sc) {
    const m = node.__match;
    if (!m) return;
    const t = ty(m.subject, s);
    if (t.k === "any") return;
    if (t.k !== "enum") { report("error", "MATCH_NOT_ENUM", m.pos, `match takes an enum value; this is ${show(t)}`); return; }
    const values = enums.get(t.e) ?? [];
    const seen = new Set<string>();
    for (const a of m.arms) for (const v of a.values) {
      if (v.name === "none" ? !t.opt : !values.includes(v.name)) report("error", "MATCH_UNKNOWN", v.pos, v.name === "none" ? `${t.e} here is never none` : `${v.name} is not a ${t.e}; its values: ${values.join(", ")}`);
      else if (seen.has(v.name)) report("error", "MATCH_DUPLICATE", v.pos, `${v.name} has two arms`);
      seen.add(v.name);
    }
    const missing = [...values, ...(t.opt ? ["none"] : [])].filter((v) => !seen.has(v));
    if (missing.length) report("error", "MATCH_MISSING", m.pos, `the match has no arm for ${missing.join(", ")}: every value of ${t.e}${t.opt ? ", and none," : ""} needs one`);
  }
  function binary(e: Expr, s: Sc): Ty {
    if (e.op === "and" || e.op === "or" || e.op === "implies") {
      cond(e.left, s, `${e.op}'s left side`);
      const rs = e.op === "and" || e.op === "implies" ? child(s, { facts: new Set([...s.facts, ...factsOf(e.left, true)]) }) : child(s, { facts: new Set([...s.facts, ...factsOf(e.left, false)]) });
      cond(e.right, rs, `${e.op}'s right side`);
      return T("bool");
    }
    const l = ty(e.left, s);
    if (e.op === "in") {
      const r = ty(e.right, s);
      if (r.k === "set" && l.k === "ref" && l.e !== r.e) report("error", "TYPE_MISMATCH", e.pos, `a ${l.e} is never in a set of ${r.e}`);
      if (r.k === "set" && l.k !== "ref" && l.k !== "any") report("error", "TYPE_MISMATCH", e.pos, `${show(l)} is never in a set of ${r.e}`);
      if (r.k === "list" && !comparable(l, r.of)) report("error", "TYPE_MISMATCH", e.pos, `${show(l)} is never in a list of ${show(r.of)}`);
      if (!["set", "list", "any"].includes(r.k)) report("error", "TYPE_MISMATCH", e.pos, `in takes a set or a list, given ${show(r)}`);
      return T("bool");
    }
    const r = ty(e.right, s);
    switch (e.op) {
      case "==": case "!=":
        if ((e as any).__fromMatch) return T("bool");
        // a field that is never none, compared with none: a slip for an optional field
        for (const [a, ax, bx] of [[l, e.left, e.right], [r, e.right, e.left]] as [Ty, any, any][])
          if (bx.kind === "lit" && bx.value === null && (ax.kind === "field" || ax.kind === "rowfield") && ["int", "bool", "text", "time", "dur", "rich", "file", "enum", "ref"].includes(a.k) && !optional(a) && !known(s, ax))
            report("warning", "TYPE_NEVER_NONE", e.pos, `${ax.kind === "rowfield" ? "." : ""}${ax.name} is never none, so ${e.op} none is always ${e.op === "!=" ? "true" : "false"}`);
        if ((l.k === "password" && r.k !== "none") || (r.k === "password" && l.k !== "none")) report("error", "TYPE_NEVER_EQUAL", e.pos, `a Password is stored hashed, so ${e.op} never compares what was typed: check it with authenticates(password, typed)`);
        else if (!comparable(l, r)) report("error", "TYPE_NEVER_EQUAL", e.pos, `${show(l)} and ${show(r)} are never equal`);
        // an enum is stored as its value's name, so it equals text that is one (a parameter, a
        // literal); a text field compared with an enum is most likely a slip for an enum field
        else for (const [a, b, bx] of [[l, r, e.right], [r, l, e.left]] as [Ty, Ty, any][])
          if (a.k === "enum" && b.k === "text" && (bx.kind === "field" || bx.kind === "rowfield"))
            report("warning", "TYPE_ENUM_TEXT", e.pos, `a ${a.e} compared with the text field ${bx.name}: is a ${a.e} field meant? (equal only when ${bx.name} holds a value's name, such as ${(enums.get(a.e) ?? [])[0] ?? "…"})`);
        for (const [a, b] of [[l, e.right], [r, e.left]] as [Ty, any][]) if (a.k === "enum" && b.kind === "lit" && typeof b.value === "string" && !(enums.get(a.e) ?? []).includes(b.value)) report("error", "TYPE_NEVER_EQUAL", e.pos, `"${b.value}" is not a ${a.e}`);
        return T("bool");
      case "<": case "<=": case ">": case ">=":
        if (!comparable(l, r) || ["bool", "ref", "set", "list", "obj", "file"].includes(l.k)) report("error", "TYPE_MISMATCH", e.pos, `${show(l)} ${e.op} ${show(r)} has no order`);
        return T("bool");
      case "+":
        if (l.k === "time" && r.k === "dur") return T("time", optional(l));
        if (l.k === "set" && r.k === "set") { if (l.e !== r.e) report("error", "TYPE_MISMATCH", e.pos, `set of ${l.e} + set of ${r.e}`); return l; }
        if (l.k === "list") return l;
        if (l.k === "int" && r.k === "int") { if (optional(l) || optional(r)) report("warning", "TYPE_OPTIONAL_ARITHMETIC", e.pos, "a number that may be none counts as 0"); return T("int"); }
        if (l.k === "time") { report("error", "TYPE_MISMATCH", e.pos, `${show(l)} + ${show(r)}: a time takes a Duration (+ 5 min)`); return T("time"); }
        // otherwise text joined: a value that isn't text, a number or a yes/no shows as
        // [object Object] (rt.Plain)
        for (const t of [l, r]) if (["ref", "time", "dur", "file", "set", "obj", "password", "old", "entity"].includes(t.k))
          report("error", "TYPE_MISMATCH", e.pos, `${show(t)} in text shows as [object Object]: ${t.k === "ref" ? "write the field meant (its name?)" : t.k === "time" || t.k === "dur" ? "show it with <Time>, or text(…)" : "write the field meant"}`);
        return T("text");
      case "-":
        if (l.k === "time" && r.k === "dur") return T("time", optional(l));
        if ((l.k !== "int" && l.k !== "any") || (r.k !== "int" && r.k !== "any")) report("error", "TYPE_MISMATCH", e.pos, `${show(l)} - ${show(r)}`);
        if (optional(l) || optional(r)) report("warning", "TYPE_OPTIONAL_ARITHMETIC", e.pos, "a number that may be none counts as 0");
        return T("int");
      case "*": case "/":
        if ((l.k !== "int" && l.k !== "any") || (r.k !== "int" && r.k !== "any")) report("error", "TYPE_MISMATCH", e.pos, `${show(l)} ${e.op} ${show(r)}`);
        return T("int");
    }
    return ANY;
  }

  // arguments to something with declared parameters
  function args(params: any[], e: Expr, s: Sc, what: string, strict = false) {
    params.forEach((p: any, i: number) => {
      const a = i < e.args.length ? e.args[i] : e.named?.[p.name];
      if (!a) return;
      fits(fromType(p.type), ty(a, s), a.pos ?? e.pos, `${what}'s ${p.name}`, strict);
    });
  }
  // whether a value of type v may be given where w is declared
  function fits(w: Ty, v: Ty, line: number | { line: number; col?: number } | undefined, what: string, strict = true) {
    if (w.k === "any" || v.k === "any") return;
    if (v.k === "none") { if (strict && !optional(w) && w.k !== "set" && w.k !== "list") report("error", "TYPE_NONE", line, `${what} can't be none`); return; }
    const kindOk = w.k === v.k ? ((w.k === "ref" || w.k === "enum") ? (w as any).e === (v as any).e : (w.k === "set" ? (w as any).e === (v as any).e : true))
      : (w.k === "text" && TEXTY.has(v.k)) || (w.k === "rich" && v.k === "text") || (w.k === "password" && v.k === "text") || (w.k === "enum" && v.k === "text") || (w.k === "set" && v.k === "list");
    if (!kindOk) { report("error", "TYPE_MISMATCH", line, `${what} is ${show(w)}, given ${show(v)}`); return; }
    if (strict && optional(v) && !optional(w)) report("warning", "TYPE_MAYBE_NONE", line, `${what} is required, but the value may be none`);
  }

  const BUILTIN: Record<string, (a: Ty[], e: Expr) => Ty> = {
    plain: () => T("text"), text: () => T("text"), html: () => T("text"), rich: () => T("rich"),
    mentions: () => ({ k: "set", e: actorEntity }), blank: () => T("bool"), present: () => T("bool"),
    authenticates: () => T("bool"), token: () => T("text"), signed: () => T("text"),
    verify: (_a, e) => (e.args[0]?.kind === "name" && ents.has(e.args[0].name) ? { k: "ref", e: e.args[0].name, opt: true } : ANY),
    join: () => T("text"), split: () => ({ k: "list", of: T("text") }), chunks: () => ({ k: "list", of: T("text") }), sentence: () => T("text"),
    any: () => T("bool"), count: () => T("int"), first: (a, e) => (e.args.length > 1 ? a[0] : a[0]?.k === "list" ? opt(a[0].of) : ANY),
    last: (a, e) => (e.args.length > 1 ? a[0] : a[0]?.k === "list" ? opt(a[0].of) : ANY), distinct: (a) => a[0] ?? ANY,
    set: (a) => (a[0]?.k === "ref" ? { k: "set", e: a[0].e } : a[0]?.k === "set" ? a[0] : a[0]?.k === "list" && a[0].of.k === "ref" ? { k: "set", e: a[0].of.e } : { k: "set", e: actorEntity }),
    words: () => T("int"), initials: () => T("text"), first_word: () => T("text"), label: () => T("text"), after: () => T("text"), lower: () => T("text"), upper: () => T("text"),
    trim: () => T("text"), length: () => T("int"), contains: () => T("bool"), starts_with: () => T("bool"), replace: () => T("text"), public_ip: () => T("bool"),
    scheme: () => T("text"), port: () => T("int"), host_within: () => T("bool"), url: () => T("text"), host: () => T("text"), path: () => T("text"),
    with_host: () => T("text"), url_of: () => T("text"), file: () => T("file"), request_file: () => T("file", true), words_only: () => T("text"),
    max: () => T("int"), min: () => T("int"), cookie: () => T("text", true), download: () => T("text"), matches: () => T("bool"),
  };
  // builtins that take text: what they're given must be text-like
  const TEXT_ARGS: Record<string, number[]> = { lower: [0], upper: [0], trim: [0], words_only: [0], initials: [0], first_word: [0], after: [0, 1], contains: [0, 1], starts_with: [0, 1], replace: [0, 1, 2], scheme: [0], host: [0], path: [0], port: [0], public_ip: [0], with_host: [0, 1], split: [0], chunks: [0],
    plain: [0], html: [0], mentions: [0], matches: [0, 1], words: [0] };

  function call(e: Expr, s: Sc): Ty {
    const fn = get("predicate", e.name) ?? get("fn", e.name);
    if (fn) { args(fn.params, e, s, `${e.name}()`); return fn.kind === "predicate" ? T("bool") : fromType(fn.returns); }
    if (get("screen", e.name)) { args(get("screen", e.name)!.params, e, s, `${e.name}()`); return { k: "screen" }; }
    const view = get("view", e.name);
    if (view?.rows) { args(view.params, e, s, `${e.name}()`); return { k: "list", of: { k: "ref", e: view.rows.entity } }; }
    if (decls.some((d) => d.kind === "api" && d.name === e.name)) { for (const a of e.args) ty(a, s); return { k: "apiref" }; }
    const a = e.args.map((x: Expr) => ty(x, s));
    for (const i of TEXT_ARGS[e.name] ?? []) if (a[i]) expectTexty(a[i], e.args[i].pos?.line ?? e.pos?.line, `${e.name}()`);
    if (["count", "any"].includes(e.name) && a[0] && !["list", "set", "any"].includes(a[0].k)) report("error", "TYPE_MISMATCH", e.pos, `${e.name}() takes a list or a set, given ${show(a[0])}`);
    if (["join", "sentence", "distinct", "first", "last"].includes(e.name) && a[0] && !["list", "any"].includes(a[0].k)) report("error", "TYPE_MISMATCH", e.pos, `${e.name}() takes a list, given ${show(a[0])}`);
    if (e.name === "download" && a[0] && !["file", "any", "none"].includes(a[0].k)) report("error", "TYPE_MISMATCH", e.args[0].pos ?? e.pos, `download() takes a File, given ${show(a[0])}`);
    if (e.name === "authenticates" && a[0] && !["password", "any"].includes(a[0].k)) report("error", "TYPE_MISMATCH", e.pos, `authenticates() checks a Password, given ${show(a[0])}`);
    const b = BUILTIN[e.name];
    return b ? b(a, e) : ANY;
  }

  // ---- statements; returns the scope after them (a require's facts hold afterwards)
  function stmts(ss: Stmt[], s: Sc): Sc { let cur = s; for (const st of ss) cur = stmt(st, cur); return cur; }
  function stmt(st: Stmt, s: Sc): Sc {
    switch (st.kind) {
      case "require": cond(st.cond, s, "the require"); return child(s, { facts: new Set([...s.facts, ...factsOf(st.cond, true)]) });
      case "let": { const t = ty(st.value, s); const n = child(s); n.vars.set(st.name, t); n.facts.delete(canon({ kind: "name", name: st.name })); return n; }
      case "result": ty(st.value, s); return s;
      case "callstmt": ty(st.call, s); return s;
      case "rate_limit": { ty(st.by, s); const p = ty(st.per, s); if (p.k !== "dur" && p.k !== "any") report("error", "TYPE_MISMATCH", st.pos, "rate_limit per takes a duration"); return s; }
      case "create": {
        const ent = ents.get(st.entity);
        if (!ent) return s;
        for (const a of st.fields) {
          const f = ent.fields.find((x: any) => x.name === a.name);
          if (f) fits(fromType(f.type), ty(a.value, s), a.pos ?? a.value.pos ?? st.pos, `${st.entity}.${a.name}`);
          const z = f ? fieldSize(f) : {};
          if (a.value.kind === "lit" && typeof a.value.value === "string" && (z.max !== undefined && textLength(a.value.value) > z.max || z.min !== undefined && textLength(a.value.value) < z.min)) report("error", "SIZE_LITERAL", a.value.pos, `"${a.value.value}" doesn't fit ${st.entity}.${a.name} (${z.min !== undefined ? `min ${z.min} ` : ""}${z.max !== undefined ? `max ${z.max}` : ""})`);
        }
        const n = child(s);
        if (st.as) n.vars.set(st.as, { k: "ref", e: st.entity });
        return n;
      }
      case "set": {
        const t = ty(st.target, s);
        const v = ty(st.value, s);
        if (t.k === "ref") {
          const f = ents.get(t.e)?.fields.find((x: any) => x.name === st.name);
          if (!f) report("error", "TYPE_NO_FIELD", st.pos, `${t.e} has no field ${st.name}`);
          else fits(fromType(f.type), v, st.value.pos ?? st.pos, `${t.e}.${st.name}`);
          if (optional(t)) report("warning", "TYPE_MAYBE_NONE", st.pos, `set on a ${t.e} that may be none`);
        } else if (!["any"].includes(t.k)) report("error", "TYPE_MISMATCH", st.pos, `set needs a row, given ${show(t)}`);
        return s;
      }
      case "touch": case "delete": { const t = ty(st.target, s); if (!["ref", "any", "none"].includes(t.k)) report("error", "TYPE_MISMATCH", st.pos, `${st.kind} needs a row, given ${show(t)}`); return s; }
      case "deleteWhere": if (st.where) cond(st.where, child(s, { row: st.entity }), "the where"); return s;
      case "foreach": {
        if (st.where) cond(st.where, child(s, { row: st.entity }), "the where");
        const n = child(s); n.vars.set(st.bind, { k: "ref", e: st.entity });
        stmts(st.body, n);
        return s;
      }
      case "foreachList": {
        const o = ty(st.over, s);
        const el: Ty = o.k === "list" ? o.of : o.k === "set" ? { k: "ref", e: o.e } : ANY;
        if (!["list", "set", "any"].includes(o.k)) report("error", "TYPE_MISMATCH", st.pos, `for each needs a list or a set, given ${show(o)}`);
        const n = child(s); n.vars.set(st.bind, el);
        stmts(st.body, n);
        return s;
      }
      case "if": {
        matchCheck(st, s);
        cond(st.cond, s, "the if");
        stmts(st.then, child(s, { facts: new Set([...s.facts, ...factsOf(st.cond, true)]) }));
        stmts(st.else ?? [], child(s, { facts: new Set([...s.facts, ...factsOf(st.cond, false)]) }));
        return s;
      }
      case "emit": for (const a of st.args) ty(a, s); return s;
      case "sendmail": for (const v of Object.values(st.fields)) ty(v as Expr, s); return s;
      case "reject": return s;
    }
    return s;
  }

  // ---- the declarations
  const paramVars = (ps: any[]) => new Map<string, Ty>((ps ?? []).map((p: any) => [p.name, fromType(p.type)]));
  const base = (): Sc => ({ vars: new Map(), facts: new Set() });
  // the gates that guarantee an actor: `actor == none -> …`
  const actorGates = of("gate").filter((g) => g.cond.kind === "binary" && g.cond.op === "==" && g.cond.left.kind === "name" && g.cond.left.name === "actor" && g.cond.right.kind === "lit" && g.cond.right.value === null).map((g) => g.name);
  const actorAfterGates = (skips: string[]) => actorGates.some((g) => !skips.includes(g));

  for (const d of of("entity").concat(of("data"))) {
    for (const f of d.fields) if (f.default) {
      reading = new Set(); reads.set(`default ${d.name}.${f.name}`, reading);
      fits(fromType(f.type), ty(f.default, { ...base(), row: d.name }), f.default.pos ?? d.pos, `${d.name}.${f.name}'s default`);
      reading = null;
    }
    for (const inv of d.invariants ?? []) {
      reading = new Set(); reads.set(`invariant ${d.name}`, reading);
      cond(inv, { vars: new Map([["self", { k: "ref", e: d.name }]]), row: d.name, facts: new Set() }, "the invariant");
      reading = null;
    }
  }
  for (const d of [...of("fn"), ...of("predicate")]) {
    reading = new Set(); reads.set(`${d.kind} ${d.name}`, reading);
    const t = ty(d.body, { ...base(), vars: paramVars(d.params) });
    if (d.kind === "predicate") { if (t.k !== "bool" && t.k !== "any") report("error", "TYPE_NOT_BOOL", d.body.pos, `predicate ${d.name} is ${show(t)}, not a Bool`); }
    else fits(fromType(d.returns), t, d.body.pos ?? d.pos, `fn ${d.name}'s result`);
    reading = null;
  }
  for (const g of of("gate")) { reading = new Set(); reads.set(`gate ${g.name}`, reading); cond(g.cond, base(), `gate ${g.name}`); reading = null; }
  for (const inv of of("invariant")) { reading = new Set(); reads.set(`invariant ${inv.name}`, reading); cond(inv.cond, base(), `invariant ${inv.name}`); reading = null; }
  for (const p of of("permission")) {
    reading = new Set(); reads.set(`permission ${p.entity}`, reading);
    cond(p.cond, { ...base(), vars: new Map([[p.entity.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(), { k: "ref", e: p.entity }]]) }, `permission ${p.entity}`);
    reading = null;
  }
  for (const a of of("action")) {
    reading = new Set(); reads.set(`action ${a.name}`, reading);
    stmts(a.body, { ...base(), vars: paramVars(a.params), actorThere: actorAfterGates(a.skips ?? []) });
    reading = null;
  }
  for (const v of of("view")) {
    reading = new Set(); reads.set(`view ${v.name}`, reading);
    let s: Sc = { ...base(), vars: paramVars(v.params), actorThere: actorAfterGates([]) };
    for (const r of v.requires) { cond(r.cond, s, "the require"); s = child(s, { facts: new Set([...s.facts, ...factsOf(r.cond, true)]) }); }
    if (v.value) ty(v.value, s);
    else {
      const rs = child(s, { row: v.rows.entity });
      if (v.rows.where) cond(v.rows.where, rs, "the rows' where");
      if (v.order) ty(v.order, rs);
      if (v.window?.unless) cond(v.window.unless, s, "window's unless");
      if (v.around) { const t = ty(v.around.at, s); if (t.k === "ref" && t.e !== v.rows.entity) report("error", "TYPE_MISMATCH", v.pos, `around a ${t.e} in a view of ${v.rows.entity}`); }
      if (v.limit) ty(v.limit, s);
    }
    reading = null;
  }
  // events carry what their emits send
  const eventTy = new Map<string, Ty>();
  const collectEmits = (ss: Stmt[], s: Sc) => { const walk = (xs: any[], sc: Sc) => { let cur = sc; for (const x of xs ?? []) {
    if (x.kind === "emit" && x.args[0]) { const t = ty(x.args[0], cur); const had = eventTy.get(x.event); eventTy.set(x.event, had ? join(had, t) : t); }
    if (x.kind === "if") { walk(x.then, cur); walk(x.else ?? [], cur); }
    else if (x.kind === "foreach") { const n = child(cur); n.vars.set(x.bind, { k: "ref", e: x.entity }); walk(x.body, n); }
    else if (x.kind === "foreachList") { const n = child(cur); n.vars.set(x.bind, ANY); walk(x.body, n); }
    cur = stmt(x, cur);
  } }; walk(ss, s); };
  const findingsBefore = findings.length;
  for (const a of of("action")) collectEmits(a.body, { ...base(), vars: paramVars(a.params), actorThere: actorAfterGates(a.skips ?? []) });
  findings.length = findingsBefore;   // the actions were already checked; this pass only collects
  for (const t of of("trigger")) {
    const bind: Ty = t.on.kind === "delete" ? { k: "old", e: t.on.entity } : t.on.kind === "event" ? eventTy.get(t.on.event) ?? ANY : { k: "ref", e: t.on.entity };
    const vars = new Map<string, Ty>([[t.bind, bind]]);
    if (t.on.kind === "update") vars.set("old", { k: "old", e: t.on.entity });
    const s: Sc = { ...base(), vars };
    reading = new Set(); reads.set(`trigger on ${t.on.kind} ${t.on.entity ?? t.on.event}`, reading);
    if (t.when) cond(t.when, s, "the trigger's when");
    stmts(t.body, t.when ? child(s, { facts: new Set([...s.facts, ...factsOf(t.when, true)]) }) : s);
    reading = null;
  }
  for (const w of of("workflow")) {
    reading = new Set(); reads.set(`workflow ${w.name}`, reading);
    for (const step of w.steps) stmts(step.body, { ...base(), vars: new Map([[w.bind, eventTy.get(w.event) ?? ANY]]) });
    reading = null;
  }

  // ---- the UI
  const ambient = new Map<string, Ty>([["theme", { k: "obj" }], ["app", { k: "obj", fields: { name: T("text"), version: T("text") } }], ["client", { k: "obj" }], ["input", { k: "obj" }], ["typed", T("text")]]);
  const uiEls = (els: El[], s: Sc): void => {
    let cur = s;
    for (const x of els) cur = uiEl(x, cur);
  };
  const target = (t: any, s: Sc, kind: "screen" | "action") => {
    if (!t || t.kind === "url") { if (t?.value) ty(t.value, s); return; }
    if (t.bare && (t.name === "back" || t.name === "home")) return;
    const d = get(kind === "screen" ? "screen" : "action", t.name);
    if (d) args(d.params, t, s, `${t.name}()`, kind === "action");
  };
  function uiEl(x: El, s: Sc): Sc {
    if (x.attrs.if) cond(x.attrs.if as Expr, s, "the if attribute");
    const inner = x.attrs.if ? child(s, { facts: new Set([...s.facts, ...factsOf(x.attrs.if, true)]) }) : s;
    // what lang/std/ui.crud says an element's attributes and content are
    const el = ELEMENTS[x.name];
    for (const [k, v] of Object.entries(x.attrs)) if (v !== true && k !== "if" && k !== "as" && !["mentions", "autocomplete", "unfurl"].includes(k)) {
      if (el?.bools?.includes(k)) cond(v as Expr, inner, `${TAG_OF[x.name] ?? x.name}'s ${k}`); else ty(v as Expr, inner);
    }
    const h = x.head;
    if (el?.content && h && typeof h === "object" && h.kind) {
      const t = ty(h, inner), tag = TAG_OF[x.name] ?? x.name;
      if (el.content === "Time" && !["time", "any", "none"].includes(t.k)) report("error", "TYPE_MISMATCH", h.pos ?? x.pos, `<${tag}> shows a Time, given ${show(t)}`);
      if (el.content === "Row" && !["ref", "any", "none"].includes(t.k)) report("error", "TYPE_MISMATCH", h.pos ?? x.pos, `<${tag}> shows a row's avatar, given ${show(t)}`);
      // the image comes from the entity's avatar declaration; without one it is missing (a 404)
      if (el.content === "Row" && t.k === "ref" && !decls.some((d) => d.kind === "avatar" && d.entity === t.e))
        report("error", "AVATAR_UNDECLARED", h.pos ?? x.pos, `<${tag}> of a ${t.e}, which has no avatar: declare one, avatar ${t.e}: initials(.name)`);
    }
    switch (x.name) {
      case "if": {
        matchCheck(x, inner);
        cond(h, inner, "the if");
        uiEls(x.children, child(inner, { facts: new Set([...inner.facts, ...factsOf(h, true)]) }));
        if (x.else) uiEls(x.else, child(inner, { facts: new Set([...inner.facts, ...factsOf(h, false)]) }));
        return s;
      }
      case "let": { const t = ty(h.value, inner); const n = child(s); n.vars.set(h.name, t); return n; }
      case "each": {
        const o = ty(h.over, inner);
        if (!["list", "set", "any"].includes(o.k)) report("error", "TYPE_MISMATCH", x.pos, `each needs a list or a set, given ${show(o)}`);
        const n = child(inner); n.vars.set(h.bind, o.k === "list" ? o.of : o.k === "set" ? { k: "ref", e: o.e } : ANY);
        uiEls(x.children, n);
        return s;
      }
      case "list": {
        const src = h.source;
        let el: Ty = ANY;
        if (src.kind === "query") { ty({ kind: "listq", entity: src.entity, where: src.where, order: src.order, limit: src.limit, pos: x.pos } as any, inner); el = { k: "ref", e: src.entity }; }
        else { const v = get("view", src.name); if (v) { args(v.params, src, inner, `${src.name}()`); if (v.rows) el = { k: "ref", e: v.rows.entity }; } }
        const n = child(inner); n.vars.set(h.bind, el);
        if (h.where) cond(h.where, n, "the list's where");
        if (h.order) ty(h.order, n);
        uiEls(x.children, n);
        return s;
      }
      case "use": { const c = get("component", h.name); if (c) args(c.params, h, inner, `${h.name}()`); return s; }
      case "widget": { const w = get("widget", h.name); if (w) args(w.params, { ...h, args: h.args ?? [] }, inner, `${h.name}()`); else for (const a of h.args ?? []) ty(a, inner); return s; }
      case "channel": case "signal": for (const a of h.args ?? []) ty(a, inner); return s;
      case "link": case "go": target(h, inner, "screen"); break;
      case "button": target(h, inner, "action"); break;
      case "form": target(h, inner, "action"); uiEls(x.children, child(inner, { form: h.name })); return s;
      case "field": {
        const z = inner.form ? actionSizes.get(inner.form)?.get(h.name) : undefined;
        const ml: any = x.attrs.maxlength;
        if (z?.max !== undefined && ml?.kind === "lit" && typeof ml.value === "number" && ml.value > z.max) report("warning", "SIZE_FORM_LONGER", x.pos, `the form lets ${h.name} take ${ml.value} characters, but ${inner.form} accepts at most ${z.max}`);
        break;
      }
      case "on": for (const r of h.reactions) { if (r.kind === "go") target(r.target, inner, "screen"); else if (r.value) ty(r.value, inner); } return s;
      default: if (h && typeof h === "object" && h.kind) notPassword(ty(h, inner), h.pos ?? x.pos, `<${TAG_OF[x.name] ?? x.name}>`);
    }
    if (x.children.length) uiEls(x.children, inner);
    return s;
  }
  for (const d of [...of("screen"), ...of("component")]) {
    const vars = new Map([...ambient, ...paramVars(d.params), ["result", ANY]]);
    let s: Sc = { vars, facts: new Set(), actorThere: d.kind === "screen" && !d.public };
    for (const r of d.requires ?? []) { cond(r.cond, s, "the screen's require"); s = child(s, { facts: new Set([...s.facts, ...factsOf(r.cond, true)]) }); }
    reading = new Set(); reads.set(`${d.kind} ${d.name}`, reading);
    uiEls(d.body, s);
    reading = null;
  }
  for (const d of of("display").concat(of("avatar"))) {
    reading = new Set(); reads.set(`${d.kind} ${d.name}`, reading);
    notPassword(ty(d.value, { ...base(), row: d.entity }), d.value.pos ?? d.pos, `${d.kind} ${d.entity}`);
    reading = null;
  }
  // an identity reads the field it looks its row up by (Session.token from cookie …), and its where
  for (const d of of("identity")) {
    reading = new Set(); reads.set(`identity ${d.name}`, reading);
    // (as gen.ts's SESSION_LOOKUP: a cookie names the row by its token field, and the row's
    // reference to the actor's entity is who signs in)
    if (d.field || d.source === "cookie") reading.add(`${d.entity}.${d.field ?? "token"}`);
    const actorRef = d.source === "cookie" ? ents.get(d.entity)?.fields.find((f: any) => f.type.kind === "named" && f.type.name === actorEntity) : undefined;
    if (actorRef) reading.add(`${d.entity}.${actorRef.name}`);
    if (d.where) cond(d.where, { ...base(), row: d.entity }, `identity ${d.name}'s where`);
    reading = null;
  }

  findings.sort((a, b) => a.line - b.line);
  return { findings, types, reads, events: eventTy };
}

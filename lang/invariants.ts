// Invariants: `invariant name: condition` holds of the data between any two actions. This proves,
// with the Z3 SMT solver, that each action keeps each invariant: if every invariant holds before
// the action and its gates and requires pass, the invariant holds after its writes (and the
// triggers they set off). A way to break it is a counterexample: the action's arguments, who acts,
// and the rows before and after. Z3 is loaded only for a spec that declares an invariant.
//
// The encoding, made to be easy for the solver:
// - Sorts, not numbers: each entity's rows are a sort of their own (Row_Room), each enum a finite
//   sort, text a sort with each literal a distinct value, a file or a password an opaque one. Only
//   Int, Time and Duration are numbers.
// - The store: per entity, whether a row exists (an array from its rows to Bool), and per field
//   its value, with whether an optional field has one.
// - An action runs on it symbolically: create, set and delete are stores (a delete follows the
//   references' cascades and restricts); a loop over rows, or a delete of rows where something
//   holds, is a new array and a statement of what it holds; an if is both branches merged; a gate
//   or require that fails changes nothing, so it is an assumption; what comes from outside
//   (arguments, the actor, now, the request) is any value of its sort.
// - What holds anyway is assumed before and after: references name rows that exist, unique keys,
//   entity invariants (the runtime refuses a write that breaks one), the actor's session; and,
//   before, every declared invariant.
// - Sliced: for each invariant, only the writes to what it reads (and to what those writes and the
//   action's conditions read) are kept, and the facts about the entities in play.
// - Bounded first: a search with a few rows of each kind finds a counterexample fast; if there is
//   none, the full proof (any number of rows) runs.
// What it can't follow makes the proof "unproven", with the reason: never a false "broken".
import type { Decl, Expr, Spec, Stmt } from "./parser.ts";
import { typecheck } from "./types.ts";
import { facts, fires, stepId } from "./facts.ts";
import { readSpec } from "./source.ts";
import * as fs2 from "node:fs";

export type InvResult = {
  invariant: string; line: number; where: string; whereLine?: number;   // where: "action post_message", whereLine: its line
  status: "proven" | "broken" | "unproven";
  reason?: string;                                           // unproven: why
  counterexample?: string;                                   // broken: what happens
  how?: "bounded" | "proof";                                 // which search decided it
};

class Unsupported extends Error {}
const no = (what: string): never => { if (process.env.CRUDSPEC_INV_TRACE) console.error(new Error(what).stack); throw new Unsupported(what); };

// part: [from, to) of the things that write (actions, then workflow steps), for one process of
// proveAll; with none, all of them in this process
export async function proveInvariants(spec: Spec, opts: { timeoutMs?: number; boundedMs?: number; rows?: number; part?: [number, number] } = {}): Promise<InvResult[]> {
  const invs = spec.decls.filter((d) => d.kind === "invariant");
  if (!invs.length) return [];
  const { init } = await import("z3-solver");
  const { Context, Z3: LL } = await init();
  let Z: any;
  const results: InvResult[] = [];
  const decls = spec.decls;
  const of = (k: string) => decls.filter((d) => d.kind === k);
  const ents = new Map<string, Decl>(of("entity").map((d) => [d.name, d]));
  const enums = new Map<string, string[]>(of("enum").map((d) => [d.name, d.values]));
  const enumOf = new Map<string, string>(); for (const [n, vs] of enums) for (const v of vs) enumOf.set(v, n);
  const fns = new Map<string, Decl>([...of("fn"), ...of("predicate")].map((d) => [d.name, d]));
  // each expression's type, from the type pass over this spec
  const typedTypes = typecheck(spec).types;
  const appDecl = decls.find((d) => d.kind === "app");
  const identities = new Set(of("identity").map((d) => d.name));
  const actorEntity: string | undefined = appDecl?.props.actor?.name;
  const TEXT_TYPES = new Set(["Text", "Email", "Url", "Ip"]), NUM_TYPES = new Set(["Int", "Time", "Duration"]);
  let fresh = 0;
  const name = (p: string) => `${p}_${fresh++}`;

  // ---- sorts, made again in each action's context
  type Sorts = { row: Map<string, any>; en: Map<string, { sort: any; vals: Map<string, any> }>; text: any; opaque: any; Int: any; Bool: any; texts: Map<string, any> };
  let S: Sorts;
  let T: any, F: any;
  const newContext = (tag: string) => {
    Z = Context(tag); T = Z.Bool.val(true); F = Z.Bool.val(false);
    const row = new Map<string, any>(); for (const e of ents.keys()) row.set(e, Z.Sort.declare(`Row_${e}`));
    const en = new Map<string, { sort: any; vals: Map<string, any> }>();
    for (const [n, vs] of enums) { const sort = Z.Sort.declare(`Enum_${n}`); en.set(n, { sort, vals: new Map(vs.map((v) => [v, Z.Const(`${n}.${v}`, sort)])) }); }
    S = { row, en, text: Z.Sort.declare("Text"), opaque: Z.Sort.declare("Opaque"), Int: Z.Int.sort(), Bool: Z.Bool.sort(), texts: new Map() };
  };
  const textLit = (s: string) => { if (!S.texts.has(s)) S.texts.set(s, Z.Const(`"${s.replace(/[^ -~]/g, "?")}"`, S.text)); return S.texts.get(s)!; };
  // enum values are distinct, and an enum has no others; text literals are distinct
  const sortFacts = () => {
    const out: any[] = [];
    for (const [, { sort, vals }] of S.en) {
      const vs = [...vals.values()];
      if (vs.length > 1) out.push(Z.Distinct(...vs));
      if (!bound) { const x = Z.Const(name("e"), sort); out.push(Z.ForAll([x], Z.Or(...vs.map((v) => x.eq(v))))); }
    }
    const ts = [...S.texts.values()]; if (ts.length > 1) out.push(Z.Distinct(...ts));
    return out;
  };

  // ---- what a field is: its sort, and what a value of it means
  type FK = { kind: "num" | "bool" | "ref" | "enum" | "text" | "opaque"; ref?: string; enumName?: string; optional: boolean };
  const kindOfType = (t: any): FK => {
    if (t.kind !== "named") return no(`a ${t.kind} value`);
    const optional = !!t.optional;
    if (ents.has(t.name)) return { kind: "ref", ref: t.name, optional };
    if (enums.has(t.name)) return { kind: "enum", enumName: t.name, optional };
    if (t.name === "Bool") return { kind: "bool", optional };
    if (NUM_TYPES.has(t.name)) return { kind: "num", optional };
    if (TEXT_TYPES.has(t.name)) return { kind: "text", optional };
    return { kind: "opaque", optional };   // a file, a password, rich text, Json: compared only with none
  };
  const fieldKind = (e: string, f: string): FK => {
    if (f === "created" || f === "updated") return { kind: "num", optional: false };
    const fd = ents.get(e)?.fields.find((x: any) => x.name === f) ?? no(`${e}.${f}`);
    return kindOfType(fd.type);
  };
  const sortOf = (k: FK) => k.kind === "num" ? S.Int : k.kind === "bool" ? S.Bool : k.kind === "ref" ? S.row.get(k.ref!) : k.kind === "enum" ? S.en.get(k.enumName!)!.sort : k.kind === "text" ? S.text : S.opaque;
  // ---- quantifiers and row constants. bound: the rows of each kind in a bounded search (0: any
  // number, real quantifiers). Bounded, "for all rows" is a conjunction over those rows and "some
  // row" a disjunction, so the problem has no quantifiers and is decided fast and completely; each
  // row-valued term is one of those rows, each enum-valued one of its values (closures)
  let bound = 0;
  let domains = new Map<string, any[]>();
  let closures: any[] = [];
  const rowsOf = (e: string) => { if (!domains.has(e)) domains.set(e, Array.from({ length: bound }, (_, i) => Z.Const(`${e}#${i + 1}`, S.row.get(e)))); return domains.get(e)!; };
  const inRowsOf = (e: string, t: any) => Z.Or(...rowsOf(e).map((d) => t.eq(d)));
  const entityOfSort = (sort: any) => { const n = String(sort.name()); return n.startsWith("Row_") ? n.slice(4) : undefined; };
  const enumOfSort = (sort: any) => { const n = String(sort.name()); return n.startsWith("Enum_") ? n.slice(5) : undefined; };
  const close = (t: any) => {
    if (!bound) return t;
    const e = entityOfSort(t.sort); if (e) closures.push(inRowsOf(e, t));
    const en = enumOfSort(t.sort); if (en) closures.push(Z.Or(...[...S.en.get(en)!.vals.values()].map((v) => t.eq(v))));
    return t;
  };
  // a fresh value of a sort (closed in a bounded search)
  const freshOf = (n: string, sort: any) => close(Z.Const(name(n), sort));
  const rowConst = (n: string, e: string) => close(Z.Const(n, S.row.get(e)));
  // an array from an entity's rows: in a bounded search, the values it holds at those rows are closed
  const arrayOf = (n: string, e: string, range: any) => {
    const a = Z.Array.const(n, S.row.get(e), range);
    if (bound && (enumOfSort(range) || entityOfSort(range))) for (const d of rowsOf(e)) close(a.select(d));
    return a;
  };
  const forAll = (e: string, body: (x: any) => any): any => {
    if (bound) return Z.And(T, ...rowsOf(e).map(body));
    const x = Z.Const(name(`x_${e}`), S.row.get(e)); return Z.ForAll([x], body(x));
  };
  const exists = (e: string, body: (x: any) => any): any => {
    if (bound) return Z.Or(F, ...rowsOf(e).map(body));
    const x = Z.Const(name(`x_${e}`), S.row.get(e)); return Z.Exists([x], body(x));
  };
  const fieldsOfEntity = (e: string) => [...ents.get(e)!.fields.map((x: any) => x.name), "created", "updated"].filter((f) => { try { fieldKind(e, f); return true; } catch { return false; } });

  // ---- the store
  type State = { ex: Map<string, any>; val: Map<string, any>; has: Map<string, any> };
  const mkState = (tag: string): State => {
    const s: State = { ex: new Map(), val: new Map(), has: new Map() };
    for (const e of ents.keys()) {
      const R = S.row.get(e);
      s.ex.set(e, arrayOf(`${tag}_ex_${e}`, e, S.Bool)); void R;
      for (const f of fieldsOfEntity(e)) {
        const k = fieldKind(e, f);
        s.val.set(`${e}.${f}`, arrayOf(`${tag}_${e}.${f}`, e, sortOf(k)));
        if (k.optional) s.has.set(`${e}.${f}`, arrayOf(`${tag}_has_${e}.${f}`, e, S.Bool));
      }
    }
    return s;
  };
  const copy = (s: State): State => ({ ex: new Map(s.ex), val: new Map(s.val), has: new Map(s.has) });
  const merge = (c: any, a: State, b: State): State => {
    const out = copy(a);
    for (const [k, v] of a.ex) if (b.ex.get(k) !== v) out.ex.set(k, Z.If(c, v, b.ex.get(k)));
    for (const [k, v] of a.val) if (b.val.get(k) !== v) out.val.set(k, Z.If(c, v, b.val.get(k)));
    for (const [k, v] of a.has) if (b.has.get(k) !== v) out.has.set(k, Z.If(c, v, b.has.get(k)));
    return out;
  };

  // ---- values: a term of its sort, and whether it is there (none is not)
  type V = { t: any; has: any; k?: FK["kind"]; entity?: string; enumName?: string; list?: V[]; set?: { arr: any; entity: string }; unknown?: string; outside?: boolean };
  // a value the proof doesn't work out. From outside (the request, an identity, the address's
  // parameters) any value can really come, as an argument's can: a counterexample may use it.
  // Worked out by something the proof doesn't follow (a text function, a Go call, a count), the
  // solver may pick a value that can't happen: a counterexample that needs one is "unproven".
  let unknowns: string[] = [];
  const outside = (what: string): V => ({ t: undefined, has: Z.Bool.const(name("oh")), unknown: what, outside: true });
  // every use is recorded, a repeat too: a check for new ones counts them (the reasons drop repeats)
  const unknown = (what: string): V => { unknowns.push(what); return { t: undefined, has: Z.Bool.const(name("uh")), unknown: what }; };
  const some = (t: any, k: FK["kind"], extra: Partial<V> = {}): V => ({ t, has: T, k, ...extra });
  const none = (): V => ({ t: undefined, has: F });
  const B = (b: any): V => ({ t: b, has: T, k: "bool" });
  // an unknown, as a Bool or as a value of a sort
  const asBool = (v: V) => (v.unknown ? Z.Bool.const(name("ub")) : v.k === "bool" ? Z.And(v.has, v.t) : no("a condition that isn't a Bool"));
  const termOf = (v: V, sort: any) => (v.t !== undefined && !v.unknown ? v.t : freshOf("val", sort));
  // assume, pc: where a lookup's facts go while an action runs (an invariant has none); old: the
  // store before an update trigger's write
  type Env = { vars: Map<string, V>; row?: { entity: string; id: any }; state: State; depth: number; assume?: any[]; pc?: any; old?: State };

  const field = (st: State, e: string, f: string, id: any): V => {
    const k = fieldKind(e, f);
    const t = (st.val.get(`${e}.${f}`) ?? no(`${e}.${f}`)).select(id);
    return { t, has: k.optional ? st.has.get(`${e}.${f}`)!.select(id) : T, k: k.kind, entity: k.ref, enumName: k.enumName };
  };
  const eq = (a: V, b: V): any => {
    if (a.unknown || b.unknown) return Z.Bool.const(name("ueq"));
    if (a.t === undefined || b.t === undefined) return Z.Not(Z.Xor(a.has, b.has));   // none against a value: whether it's there
    if (a.k !== b.k) return no(`a ${a.k} compared with a ${b.k} (the type pass refuses that; this is the proof's own mistake)`);
    return Z.Or(Z.And(a.has, b.has, a.t.eq(b.t)), Z.And(Z.Not(a.has), Z.Not(b.has)));
  };

  // a query's rows: a condition for all, or for some, of a fresh row
  function rowsWhere(q: any, env: Env, body: (id: any, inEnv: Env) => any, quant: "all" | "exists"): any {
    const e = q.entity; if (!ents.has(e)) no(`rows of ${e}`);
    const at = (y: any) => { const inner: Env = { ...env, row: { entity: e, id: y } }; return { inner, cond: q.where ? asBool(tr(q.where, inner)) : T, ex: env.state.ex.get(e).select(y) }; };
    return quant === "all" ? forAll(e, (y) => { const a = at(y); return Z.Implies(Z.And(a.ex, a.cond), body(y, a.inner)); }) : exists(e, (y) => { const a = at(y); return Z.And(a.ex, a.cond, body(y, a.inner)); });
  }
  const enumVal = (v: string): V => some(S.en.get(enumOf.get(v)!)!.vals.get(v), "enum", { enumName: enumOf.get(v) });

  function tr(e: Expr, env: Env): V {
    switch (e.kind) {
      case "lit":
        if (e.value === null) return none();
        if (typeof e.value === "boolean") return B(e.value ? T : F);
        if (typeof e.value === "number") return some(Z.Int.val(e.value), "num");
        if (typeof e.value === "string") return enumOf.has(e.value) ? enumVal(e.value) : some(textLit(e.value), "text");
        return no("a value");
      case "duration": return some(Z.Int.val(e.amount * ({ ms: 1, s: 1000, min: 60000, h: 3600000, day: 86400000 } as any)[e.unit]), "num");
      case "now": return env.vars.get("now")!;
      case "it": return env.row ? some(env.row.id, "ref", { entity: env.row.entity }) : no("it outside a query");
      case "rowfield": return env.row ? (e.name === "id" ? unknown("an id") : field(env.state, env.row.entity, e.name, env.row.id)) : no(".field outside a query");
      case "name": {
        if (env.vars.has(e.name)) return env.vars.get(e.name)!;
        if (e.name === "actor") return env.vars.get("actor") ?? no("no actor");
        if (["request", "query", "client", "input", "typed"].includes(e.name)) return outside(e.name);
        if (["theme", "app"].includes(e.name)) return unknown(e.name);
        if (identities.has(e.name)) return outside(`the identity ${e.name}`);
        if (e.name === "get" || e.name === "write") return some(textLit(e.name), "text");   // request.method's values
        if (enumOf.has(e.name)) return enumVal(e.name);
        if (ents.get(e.name)?.singleton) return some(singleton(e.name), "ref", { entity: e.name });
        if (env.row && (["created", "updated"].includes(e.name) || ents.get(env.row.entity)?.fields.some((f: any) => f.name === e.name))) return field(env.state, env.row.entity, e.name, env.row.id);
        return no(`the name ${e.name}`);
      }
      case "field": {
        if (e.target.kind === "name" && enums.has(e.target.name) && !env.vars.has(e.target.name)) return enumVal(e.name);
        if (e.target.kind === "name" && e.target.name === "old" && env.old && env.vars.has("old")) { const o = env.vars.get("old")!; return field(env.old, o.entity!, e.name, o.t); }
        const t = tr(e.target, env);
        if (t.entity && t.t !== undefined && !t.unknown) {
          if (e.name === "id") return unknown("an id");
          const f = field(env.state, t.entity, e.name, t.t);
          return { ...f, has: Z.And(t.has, f.has) };
        }
        return t.outside ? outside(`${t.unknown}.${e.name}`) : unknown(t.unknown ? `${t.unknown}.${e.name}` : `.${e.name} of a value`);
      }
      case "unary":
        if (e.op === "not") return B(Z.Not(asBool(tr(e.arg, env))));
        { const a = tr(e.arg, env); return a.k === "num" ? { ...a, t: a.t.neg() } : unknown("a negation"); }
      case "binary": {
        const op = e.op;
        if (op === "and" || op === "or" || op === "implies") {
          const a = asBool(tr(e.left, env)), b = asBool(tr(e.right, env));
          return B(op === "and" ? Z.And(a, b) : op === "or" ? Z.Or(a, b) : Z.Implies(a, b));
        }
        if (op === "in") {
          const x = tr(e.left, env);
          if (e.right.kind === "listlit" || e.right.kind === "setlit") return B(Z.Or(F, ...e.right.items.map((i: Expr) => eq(x, tr(i, env)))));
          const s = tr(e.right, env);
          if (s.set && x.t !== undefined && !x.unknown) return B(Z.And(x.has, s.set.arr.select(x.t)));
          if (s.list) return B(Z.Or(F, ...s.list.map((i) => eq(x, i))));
          return B(Z.Bool.const(name("uin")));
        }
        let a = tr(e.left, env), b = tr(e.right, env);
        const asText = (x: Expr, v: V, other: V) => (x.kind === "lit" && typeof x.value === "string" && other.k === "text" && v.k === "enum" ? some(textLit(x.value), "text") : v);
        a = asText(e.left, a, b); b = asText(e.right, b, a);
        // a set and a row or a set: the rows of both
        if (op === "+" && a.set && (b.set || b.entity) && env.assume) {
          const arr = Z.Array.const(name("union"), S.row.get(a.set.entity), S.Bool);
          env.assume.push(forAll(a.set.entity, (x) => arr.select(x).eq(Z.Or(a.set!.arr.select(x), b.set ? b.set.arr.select(x) : Z.And(b.has, x.eq(b.t))))));
          return { t: undefined, has: T, set: { arr, entity: a.set.entity } };
        }
        if (op === "==") return B(eq(a, b));
        if (op === "!=") return B(Z.Not(eq(a, b)));
        if (a.unknown || b.unknown || a.k !== "num" || b.k !== "num") return ["<", "<=", ">", ">="].includes(op) ? B(Z.Bool.const(name("ucmp"))) : unknown(`${a.unknown ?? a.k ?? (a.set ? "a set" : "a value")} ${op} ${b.unknown ?? b.k ?? (b.set ? "a set" : "a value")}`);
        const both = Z.And(a.has, b.has);
        switch (op) {
          case "<": return B(Z.And(both, a.t.lt(b.t)));
          case "<=": return B(Z.And(both, a.t.le(b.t)));
          case ">": return B(Z.And(both, a.t.gt(b.t)));
          case ">=": return B(Z.And(both, a.t.ge(b.t)));
          case "+": return { t: a.t.add(b.t), has: both, k: "num" };
          case "-": return { t: a.t.sub(b.t), has: both, k: "num" };
          case "*": return { t: a.t.mul(b.t), has: both, k: "num" };
        }
        return no(`the operator ${op}`);
      }
      case "if": {
        const c = asBool(tr(e.cond, env)), a = tr(e.then, env), b = tr(e.else, env);
        if (a.unknown || b.unknown) return unknown(a.unknown ?? b.unknown!);
        if (a.t === undefined && b.t === undefined) return none();
        const kind = a.t !== undefined ? a : b;
        const sort = a.t !== undefined ? a.t.sort : b.t.sort;
        if (a.t !== undefined && b.t !== undefined && a.k !== b.k) return no("an if whose branches differ in kind");
        return { t: Z.If(c, a.t ?? freshOf("n", sort), b.t ?? freshOf("n", sort)), has: Z.If(c, a.has, b.has), k: kind.k, entity: kind.entity, enumName: kind.enumName };
      }
      case "listlit": case "setlit": return { t: undefined, has: T, list: e.items.map((i: Expr) => tr(i, env)) };
      case "query": {
        const op = e.op;
        if (op === "exists") return B(rowsWhere(e, env, () => T, "exists"));
        if (op === "set" && env.assume) {
          const arr = Z.Array.const(name(`set_${e.entity}`), S.row.get(e.entity), S.Bool);
          env.assume.push(forAll(e.entity, (x) => arr.select(x).eq(Z.And(env.state.ex.get(e.entity).select(x), e.where ? asBool(tr(e.where, { ...env, row: { entity: e.entity, id: x } })) : T))));
          return { t: undefined, has: T, set: { arr, entity: e.entity } };
        }
        if ((op === "the" || op === "the_or_none" || op === "first_or_none") && env.assume) {
          // the row a lookup finds: one that exists and matches (the runtime refuses the action when the() finds none)
          const y = rowConst(name(`the_${e.entity}`), e.entity), h = op === "the" ? T : Z.Bool.const(name("found"));
          const matches = (id: any) => Z.And(env.state.ex.get(e.entity).select(id), e.where ? asBool(tr(e.where, { ...env, row: { entity: e.entity, id } })) : T);
          env.assume.push(Z.Implies(env.pc ?? T, Z.Implies(h, matches(y))));
          if (op !== "the") env.assume.push(Z.Implies(env.pc ?? T, Z.Implies(Z.Not(h), Z.Not(rowsWhere(e, env, () => T, "exists")))));
          return { t: y, has: h, k: "ref", entity: e.entity };
        }
        return unknown(`${op}(${e.entity} …)`);
      }
      case "all": return B(rowsWhere(e, env, (_y, inner) => asBool(tr(e.cond, inner)), "all"));
      case "call": {
        const d = fns.get(e.name);
        if (d) {
          if (env.depth > 6) no(`${e.name} calls too deep`);
          const vars = new Map(env.vars);
          d.params.forEach((p: any, i: number) => vars.set(p.name, tr(e.args[i] ?? e.named?.[p.name] ?? { kind: "lit", value: null, pos: e.pos }, env)));
          const v = tr(d.body, { ...env, vars, row: undefined, depth: env.depth + 1 });
          return d.kind === "predicate" ? B(asBool(v)) : v;
        }
        if (e.name === "token") return some(freshOf("token", S.text), "text");
        // set(x, y): the rows given, of one entity
        if (e.name === "set" && env.assume && e.args.length) {
          const items = e.args.map((a: Expr) => tr(a, env));
          if (items.every((v: V) => v.entity && v.t !== undefined && !v.unknown) && new Set(items.map((v: V) => v.entity)).size === 1) {
            const en = items[0].entity!, arr = Z.Array.const(name(`setof_${en}`), S.row.get(en), S.Bool);
            env.assume.push(forAll(en, (x) => arr.select(x).eq(Z.Or(F, ...items.map((v: V) => Z.And(v.has, x.eq(v.t)))))));
            return { t: undefined, has: T, set: { arr, entity: en } };
          }
        }
        if (e.name === "present" || e.name === "blank") {
          const a = tr(e.args[0], env);
          if (a.unknown) return B(Z.Bool.const(name("upresent")));
          const p = Z.And(a.has, a.k === "text" ? Z.Not(a.t.eq(textLit(""))) : T);
          return B(e.name === "present" ? p : Z.Not(p));
        }
        return unknown(`${e.name}(…)`);
      }
      case "extern": return unknown(`call ${e.name}`);
      case "listq": return unknown(`list(… ${e.entity} …)`);
      default: return no(`a ${e.kind} expression`);
    }
  }
  let singles = new Map<string, any>();
  const singleton = (e: string) => { if (!singles.has(e)) singles.set(e, rowConst(`the_${e}`, e)); return singles.get(e)!; };

  // ---- what holds anyway, of a state, for the entities given: references name rows that exist,
  // unique keys, entity invariants (the runtime refuses a write that breaks one). fields: when
  // given, only facts about those fields (a sliced store holds others as they were before)
  function background(st: State, env0: Env, only: Set<string>, fields?: Set<string>): any[] {
    const out: any[] = [];
    const ok = (f: string) => !fields || fields.has(f);
    for (const e of only) if (ents.get(e)?.singleton) out.push(st.ex.get(e).select(singleton(e)));
    for (const e of only) {
      const d = ents.get(e); if (!d) continue;
      const ex = (y: any) => st.ex.get(e).select(y);
      for (const f of d.fields) {
        if (!ok(f.name)) continue;
        let k: FK; try { k = fieldKind(e, f.name); } catch { continue; }
        if (k.kind !== "ref") continue;
        out.push(forAll(e, (y) => { const v = field(st, e, f.name, y); return Z.Implies(Z.And(ex(y), v.has), st.ex.get(k.ref!).select(v.t)); }));
      }
      for (const u of d.uniques ?? []) {
        if (!u.every(ok)) continue;
        try {
          const same = (y: any, y2: any) => Z.And(...u.map((f: string) => { const a = field(st, e, f, y), b = field(st, e, f, y2); return Z.And(a.has, b.has, a.t.eq(b.t)); }));
          out.push(forAll(e, (y) => forAll(e, (y2) => Z.Implies(Z.And(ex(y), ex(y2), same(y, y2)), y.eq(y2)))));
        } catch { /* a key over fields it can't express: not assumed */ }
      }
      for (const inv of d.invariants ?? []) {
        if (fields && ![...fieldsOf(inv)].every((f) => fields.has(f) || !fieldsOfEntity(e).includes(f))) continue;
        const had = unknowns.length;
        try { const c = forAll(e, (y) => Z.Implies(ex(y), asBool(tr(inv, { ...env0, state: st, vars: new Map([...env0.vars, ["self", some(y, "ref", { entity: e })]]), row: undefined, assume: undefined })))); if (unknowns.length === had) out.push(c); } catch { /* not assumed */ }
        unknowns.length = had;
      }
    }
    return out;
  }

  // ---- an action, run on a state: the state after, and what must hold for it to get there
  type Run = { st: State; assume: any[]; pc: any; touched: Set<string> };
  const triggers = of("trigger");
  // keep: whether a write to a field (or a create or delete of an entity's rows) is in the slice
  let keep: (what: string) => boolean = () => true;
  // the entities a delete of e's rows can reach: e, and what refers to it on delete cascade or
  // restrict, and so on (a restrict can refuse the delete, so it is part of what the delete does)
  const deleteReach = (e: string): Set<string> => {
    const out = new Set<string>([e]), queue = [e];
    while (queue.length) { const x = queue.pop()!; for (const [c, d] of ents) for (const f of d.fields) if (f.type.kind === "named" && f.type.name === x && (f.onDelete === "cascade" || f.onDelete === "restrict") && !out.has(c)) { out.add(c); queue.push(c); } }
    return out;
  };
  const keepDelete = (e: string) => [...deleteReach(e)].some((x) => keep(x));
  function deleteWhere(run: Run, e: string, dead: (y: any) => any, env: Env, seen = 0) {
    if (seen > ents.size) no("cascades too deep");
    if (!keepDelete(e)) return;
    const st = run.st; const R = S.row.get(e);
    const old = st.ex.get(e);
    const now = arrayOf(name(`ex_${e}`), e, S.Bool); void R;
    run.assume.push(forAll(e, (y) => now.select(y).eq(Z.And(old.select(y), Z.Not(dead(y))))));
    st.ex.set(e, now);
    run.touched.add(e);
    for (const t of triggers) if (t.on.kind === "delete" && t.on.entity === e && writesIn(t.body)) no(`a trigger on delete of ${e} that writes`);
    // rows that refer to a deleted row: restrict refuses the action, cascade deletes them too
    for (const [c, d] of ents) for (const f of d.fields) {
      if (!(f.type.kind === "named" && f.type.name === e)) continue;
      const refs = (zz: any) => { const v = field(st, c, f.name, zz); return Z.And(st.ex.get(c).select(zz), v.has, old.select(v.t), dead(v.t)); };
      if (f.onDelete === "cascade") deleteWhere(run, c, refs, env, seen + 1);
      else if (f.onDelete === "restrict") run.assume.push(Z.Implies(run.pc, Z.Not(exists(c, refs))));
      else no(`on delete ${f.onDelete}`);
    }
  }
  // the unknowns each field may now hold (an unknown matters to an invariant that reads the field)
  let storedUnknowns = new Map<string, string[]>();
  // the rows the action made, for the counterexample
  let created: { entity: string; id: any }[] = [];
  function store(run: Run, e: string, f: string, id: any, v: V) {
    const key = `${e}.${f}`;
    if (v.unknown && !v.outside) storedUnknowns.set(f, [...(storedUnknowns.get(f) ?? []), v.unknown]);
    const k = fieldKind(e, f);
    const arr = run.st.val.get(key);
    let t = termOf(v, sortOf(k));
    if (String(t.sort.name()) !== String(sortOf(k).name())) { t = freshOf("conv", sortOf(k)); storedUnknowns.set(f, [...(storedUnknowns.get(f) ?? []), `${e}.${f} from a ${v.k}`]); }
    const stored = arr.store(id, t);
    run.st.val.set(key, run.pc === T ? stored : Z.If(run.pc, stored, arr));
    if (k.optional) { const h = run.st.has.get(key); const hs = h.store(id, v.has); run.st.has.set(key, run.pc === T ? hs : Z.If(run.pc, hs, h)); }
    else run.assume.push(Z.Implies(run.pc, v.has));   // a required field set to none is refused
    run.touched.add(e);
  }
  function exec(ss: Stmt[], run: Run, env: Env): void { for (const s of ss) execOne(s, run, env); }
  // a field's value, its unknowns put with the field
  const valueFor = (f: string, x: Expr, env: Env): V => {
    const mark = unknowns.length;
    const v = tr(x, env);
    if (unknowns.length > mark) { storedUnknowns.set(f, [...new Set([...(storedUnknowns.get(f) ?? []), ...unknowns.slice(mark)])]); unknowns.length = mark; }
    return v;
  };
  function execOne(s: Stmt, run: Run, env: Env): void {
    const cur = (): Env => ({ ...env, state: run.st, assume: run.assume, pc: run.pc });
    switch (s.kind) {
      case "require": run.assume.push(Z.Implies(run.pc, asBool(tr(s.cond, cur())))); return;
      case "reject": run.assume.push(Z.Not(run.pc)); return;
      case "rate_limit": case "emit": case "sendmail": case "result": case "touch": case "callstmt": return;
      case "let": env.vars.set(s.name, tr(s.value, cur())); return;
      case "if": {
        const c = asBool(tr(s.cond, cur()));
        const before = copy(run.st), pc = run.pc;
        run.pc = Z.And(pc, c); exec(s.then, run, { ...env, vars: new Map(env.vars) }); const a = run.st;
        run.st = copy(before); run.pc = Z.And(pc, Z.Not(c)); exec(s.else ?? [], run, { ...env, vars: new Map(env.vars) }); const b = run.st;
        run.pc = pc; run.st = merge(c, a, b);
        return;
      }
      case "create": {
        const e = s.entity; const d = ents.get(e) ?? no(`create ${e}`);
        if (s.ensure) {
          // either a row like it is there (nothing changes) or it is made
          const made = Z.Bool.const(name("ensured"));
          const pc = run.pc; const before = copy(run.st);
          run.pc = Z.And(pc, made); execOne({ ...s, ensure: false } as any, run, env);
          run.st = merge(made, run.st, before); run.pc = pc;
          return;
        }
        const id = rowConst(name(`new_${e}`), e);
        if (!keep(e)) { if (s.as) env.vars.set(s.as, some(id, "ref", { entity: e })); return; }
        created.push({ entity: e, id });
        run.assume.push(Z.Implies(run.pc, Z.Not(run.st.ex.get(e).select(id))));
        const given = new Map(s.fields.map((a: any) => [a.name, a.value]));
        const vals = new Map<string, V>();
        for (const f of d.fields) {
          let k: FK; try { k = fieldKind(e, f.name); } catch { continue; }
          const src = given.get(f.name) ?? f.default;
          let v: V;
          if (src) { try { v = valueFor(f.name, src, cur()); } catch (err) { if (!(err instanceof Unsupported)) throw err; v = unknown(`${e}.${f.name}'s value`); storedUnknowns.set(f.name, [...(storedUnknowns.get(f.name) ?? []), v.unknown!]); unknowns.pop(); v = { ...v, has: T }; } }
          else v = k.optional ? none() : { t: freshOf("v", sortOf(k)), has: T, k: k.kind };
          vals.set(f.name, v);
        }
        const ex = run.st.ex.get(e).store(id, T);
        run.st.ex.set(e, run.pc === T ? ex : Z.If(run.pc, ex, run.st.ex.get(e)));
        if (s.as) env.vars.set(s.as, some(id, "ref", { entity: e }));
        for (const [f, v] of vals) store(run, e, f, id, v);
        store(run, e, "created", id, env.vars.get("now")!);
        const row = some(id, "ref", { entity: e });
        for (const t of triggers) if (t.on.kind === "create" && t.on.entity === e) runTrigger(t, row, run, env);
        return;
      }
      case "set": {
        if (!keep(s.name)) return;
        const target = tr(s.target, cur());
        if (!target.entity || target.t === undefined || target.unknown) no("set on a value that isn't a row");
        run.assume.push(Z.Implies(run.pc, target.has));
        const v = valueFor(s.name, s.value, cur());
        const before = copy(run.st);
        store(run, target.entity!, s.name, target.t, v);
        for (const t of triggers) if (t.on.kind === "update" && t.on.entity === target.entity && t.on.field === s.name) runTrigger(t, target, run, env, before);
        return;
      }
      case "delete": {
        const target = tr(s.target, cur());
        if (!target.entity || target.t === undefined || target.unknown) no("delete of a value that isn't a row");
        const pc = run.pc;
        deleteWhere(run, target.entity!, (y) => Z.And(pc, y.eq(target.t), target.has), env);
        return;
      }
      case "deleteWhere": {
        const pc = run.pc; const st0 = run.st;
        deleteWhere(run, s.entity, (y) => Z.And(pc, s.where ? asBool(tr(s.where, { ...env, state: st0, row: { entity: s.entity, id: y } })) : T), env);
        return;
      }
      case "foreach": {
        // a loop whose writes are all outside the slice is left out, as each of them would be
        if (!sliceNeeds(s.body, new Map([[s.bind, s.entity]]), env)) return;
        const e = s.entity; const R = S.row.get(e); const y = Z.Const(name(`each_${e}`), R);
        const st0 = run.st;
        const inRows = Z.And(run.pc, st0.ex.get(e).select(y), s.where ? asBool(tr(s.where, { ...env, state: st0, row: { entity: e, id: y } })) : T);
        if (s.body.length === 1 && s.body[0].kind === "create") { rowPerRow(s, s.body[0], run, env, y, inRows); return; }
        // a loop that writes only its own row: every matching row's new values at once
        const onlyRow = (ss: Stmt[]): void => { for (const x of ss) {
          if (x.kind === "set") { if (!(x.target.kind === "name" && x.target.name === s.bind)) no("a loop that writes another row than its own"); continue; }
          if (x.kind === "if") { onlyRow(x.then); onlyRow(x.else ?? []); continue; }
          if (["let", "require", "emit", "sendmail", "callstmt", "rate_limit", "touch"].includes(x.kind)) continue;
          no(`a loop with a ${x.kind}`);
        } };
        onlyRow(s.body);
        const sub: Run = { st: copy(st0), assume: [], pc: T, touched: new Set() };
        const vars = new Map(env.vars); vars.set(s.bind, some(y, "ref", { entity: e }));
        exec(s.body, sub, { ...env, vars, state: sub.st });
        for (const [k, arr] of sub.st.val) if (arr !== st0.val.get(k)) {
          const [kEnt, kField] = k.split(".");
          const now = arrayOf(name(`loop_${k}`), kEnt, sortOf(fieldKind(kEnt, kField)));
          run.assume.push(forAll(e, (z) => now.select(z).eq(Z.If(Z.substitute(inRows, [y, z]), Z.substitute(arr.select(y), [y, z]), st0.val.get(k).select(z)))));
          run.st.val.set(k, now);
          const [en, f] = k.split(".");
          if (triggers.some((t) => t.on.kind === "update" && t.on.entity === en && t.on.field === f && writesIn(t.body))) no(`a loop that sets off a trigger on ${k}`);
        }
        for (const [k, arr] of sub.st.has) if (arr !== st0.has.get(k)) {
          const now = arrayOf(name(`loophas_${k}`), e, S.Bool);
          run.assume.push(forAll(e, (z) => now.select(z).eq(Z.If(Z.substitute(inRows, [y, z]), Z.substitute(arr.select(y), [y, z]), st0.has.get(k).select(z)))));
          run.st.has.set(k, now);
        }
        for (const a of sub.assume) run.assume.push(forAll(e, (z) => Z.substitute(Z.Implies(inRows, a), [y, z])));
        for (const t of sub.touched) run.touched.add(t);
        return;
      }
      case "foreachList": {
        if (!sliceNeeds(s.body, new Map(), env)) return;
        const writes = (ss: Stmt[]): boolean => ss.some((x) => ["create", "set", "delete", "deleteWhere", "foreach", "foreachList"].includes(x.kind) || (x.kind === "if" && (writes(x.then) || writes(x.else ?? []))));
        if (writes(s.body)) no("a loop over a list that writes");
        return;
      }
      default: no(`a ${s.kind} statement`);
    }
  }
  // whether a loop's body writes anything the slice keeps: a create or delete of a kept entity, a
  // set of a kept field (a delete of a row whose entity isn't known is taken as kept)
  function sliceNeeds(ss: Stmt[], binds: Map<string, string>, env: Env): boolean {
    return (ss as any[]).some((x) => {
      if (x.kind === "create") return keep(x.entity);
      if (x.kind === "deleteWhere") return keepDelete(x.entity);
      if (x.kind === "set") return keep(x.name);
      if (x.kind === "delete") { const n = x.target?.kind === "name" ? x.target.name : undefined; const e = n ? binds.get(n) ?? env.vars.get(n)?.entity : undefined; return e ? keepDelete(e) : true; }
      if (x.kind === "if") return sliceNeeds(x.then, binds, env) || sliceNeeds(x.else ?? [], binds, env);
      if (x.kind === "foreach") return sliceNeeds(x.body, new Map([...binds, [x.bind, x.entity]]), env);
      if (x.kind === "foreachList") return sliceNeeds(x.body, binds, env);
      return false;
    });
  }
  // for each x in E where p { create|ensure R { f: v(x), … } }: R's rows after are the ones before,
  // unchanged, and new ones, each made for a matching x (from) with those fields; each matching x
  // has such a row after (to): new with create, before or new with ensure
  function rowPerRow(loop: any, c: any, run: Run, env: Env, y: any, inRows: any) {
    const Rn = c.entity; const d = ents.get(Rn) ?? no(`create ${Rn}`);
    if (!keep(Rn)) return;
    for (const t of triggers) if (t.on.kind === "create" && t.on.entity === Rn && writesIn(t.body)) no(`a loop whose rows set off a trigger on create of ${Rn}`);
    const LS = S.row.get(loop.entity), RS = S.row.get(Rn);
    const st0 = run.st; const st1 = copy(st0);
    const vars = new Map(env.vars); vars.set(loop.bind, some(y, "ref", { entity: loop.entity }));
    const given = new Map<string, V>(c.fields.map((a: any) => [a.name, valueFor(a.name, a.value, { ...env, vars, state: st0, assume: run.assume, pc: run.pc })]));
    const tag = name(`made_${Rn}`);
    st1.ex.set(Rn, arrayOf(`${tag}_ex`, Rn, S.Bool));
    const keys = fieldsOfEntity(Rn);
    for (const f of keys) {
      const k = `${Rn}.${f}`;
      st1.val.set(k, arrayOf(`${tag}_${f}`, Rn, sortOf(fieldKind(Rn, f))));
      if (st0.has.has(k)) st1.has.set(k, arrayOf(`${tag}_has_${f}`, Rn, S.Bool));
    }
    for (const f of d.fields) if (!given.has(f.name) && f.default) storedUnknowns.set(f.name, [...(storedUnknowns.get(f.name) ?? []), `${Rn}.${f.name}'s default`]);
    void RS; void LS;
    const same = (id: any) => keys.map((f) => { const k = `${Rn}.${f}`; const a = [st1.val.get(k).select(id).eq(st0.val.get(k).select(id))]; if (st0.has.has(k)) a.push(st1.has.get(k).select(id).eq(st0.has.get(k).select(id))); return Z.And(...a); });
    const made = (zz: any, yy: any) => Z.And(T, ...[...given].map(([f, v]) => eq(field(st1, Rn, f, zz), { ...v, t: v.t === undefined || v.unknown ? v.t : Z.substitute(v.t, [y, yy]), has: Z.substitute(v.has, [y, yy]) })));
    const inRowsAt = (yy: any) => Z.substitute(inRows, [y, yy]);
    const from = Z.Function.declare(`${tag}_from`, RS, LS), to = Z.Function.declare(`${tag}_to`, LS, RS);
    if (bound) { for (const d of rowsOf(Rn)) close(from.call(d)); for (const d of rowsOf(loop.entity)) close(to.call(d)); }
    run.assume.push(forAll(Rn, (z) => Z.Implies(st0.ex.get(Rn).select(z), Z.And(st1.ex.get(Rn).select(z), ...same(z)))));
    run.assume.push(forAll(Rn, (z) => Z.Implies(Z.And(st1.ex.get(Rn).select(z), Z.Not(st0.ex.get(Rn).select(z))), Z.And(inRowsAt(from.call(z)), made(z, from.call(z))))));
    run.assume.push(forAll(loop.entity, (y2) => Z.Implies(inRowsAt(y2), Z.And(st1.ex.get(Rn).select(to.call(y2)), c.ensure ? T : Z.Not(st0.ex.get(Rn).select(to.call(y2))), made(to.call(y2), y2)))));
    run.st = st1;
    run.touched.add(Rn);
  }
  const writesIn = (ss: Stmt[]): boolean => ss.some((x: any) => ["create", "set", "delete", "deleteWhere", "reject", "require"].includes(x.kind) || (x.kind === "if" && (writesIn(x.then) || writesIn(x.else ?? []))) || ((x.kind === "foreach" || x.kind === "foreachList") && writesIn(x.body)));
  function runTrigger(t: Decl, subject: V, run: Run, env: Env, old?: State) {
    if (!writesIn(t.body)) return;   // a trigger that writes nothing (and refuses nothing) changes nothing
    if (env.depth > 4) no("triggers too deep");
    const vars = new Map(env.vars); vars.set(t.bind, subject);
    if (old) vars.set("old", subject);
    const tenv: Env = { ...env, vars, depth: env.depth + 1, state: run.st, old };
    if (t.when) { const pc = run.pc; run.pc = Z.And(pc, asBool(tr(t.when, { ...tenv, assume: run.assume, pc }))); exec(t.body, run, tenv); run.pc = pc; }
    else exec(t.body, run, tenv);
  }

  // ---- what expressions read: entities, and field names
  const owners = (fields: Set<string>) => [...ents].filter(([, d]) => d.fields.some((f: any) => fields.has(f.name))).map(([n]) => n);
  // the entities whose fields an expression reads, by type: .f inside a query is the query's
  // entity's, x.f the entity of x's type (the type pass's); through the functions and predicates
  // it calls. A field whose owner the types don't give: every entity with a field of that name
  const typedOwners = (x: any, out = new Set<string>(), row?: string, seen = new Set<string>()): Set<string> => {
    if (!x || typeof x !== "object") return out;
    if (Array.isArray(x)) { for (const y of x) typedOwners(y, out, row, seen); return out; }
    const byName = (f: string) => { for (const n of owners(new Set([f]))) out.add(n); };
    if (x.kind === "rowfield") { if (row) out.add(row); else byName(x.name); }
    if (x.kind === "field") { const t: any = typedTypes.get(x.target); if (t?.k === "ref" && ents.has(t.e)) out.add(t.e); else if (x.name !== "id") byName(x.name); }
    if (x.kind === "call" && fns.has(x.name) && !seen.has(x.name)) { seen.add(x.name); typedOwners(fns.get(x.name)!.body, out, undefined, seen); }
    const inner = typeof x.entity === "string" && ents.has(x.entity) ? x.entity : row;
    for (const [k, v] of Object.entries(x)) if (k !== "pos") typedOwners(v, out, ["where", "map", "cond", "order", "by"].includes(k) ? inner : row, seen);
    return out;
  };
  const readsOf = (x: any, out = new Set<string>()): Set<string> => {
    if (out.size === 0 && x && typeof x === "object" && !Array.isArray(x) && !(x as any).__inner) { const own = readsOfRaw(x, new Set()); for (const n of typedOwners(x)) own.add(n); for (const n of own) out.add(n); return out; }
    return readsOfRaw(x, out);
  };
  const readsOfRaw = (x: any, out = new Set<string>()): Set<string> => {
    if (!x || typeof x !== "object") return out;
    if (Array.isArray(x)) { x.forEach((y) => readsOf(y, out)); return out; }
    if (x.entity && typeof x.entity === "string") out.add(x.entity);
    for (const [k, v] of Object.entries(x)) if (k !== "pos") readsOfRaw(v, out);
    return out;
  };
  function fieldsOf(x: any, out = new Set<string>()): Set<string> {
    if (!x || typeof x !== "object") return out;
    if (Array.isArray(x)) { x.forEach((y) => fieldsOf(y, out)); return out; }
    if ((x.kind === "rowfield" || x.kind === "field") && typeof x.name === "string") out.add(x.name);
    if (x.kind === "name" && typeof x.name === "string") out.add(x.name);
    if (x.kind === "call" && fns.has(x.name)) fieldsOf(fns.get(x.name)!.body, out);
    for (const [k, v] of Object.entries(x)) if (k !== "pos") fieldsOf(v, out);
    return out;
  }
  // the slice for an invariant: the field names and entities that matter. They start as what it
  // reads; a write to one of them brings in what that write reads, and the action's conditions
  // (requires, ifs, lookups, gates) bring in what they read, until nothing more comes in
  function slice(inv: Decl, body: Stmt[], gs: Decl[], fired: Decl[], params: any[] = []): Set<string> {
    const want = new Set<string>([...fieldsOf(inv.cond), ...readsOf(inv.cond)]);
    const add = (x: any) => { let more = false; for (const n of [...fieldsOf(x), ...readsOf(x)]) if (!want.has(n)) { want.add(n); more = true; } return more; };
    // what the triggers a write sets off can do, as statements of the action
    const withTriggers = (ss: Stmt[]): Stmt[] => ss;
    for (let changed = true; changed;) {
      changed = false;
      // gates read the state before the action writes anything: what they read needs no write kept
      void gs;
      // a delete of a row whose entity a loop or a parameter gives: wanted if what it reaches is;
      // of one whose entity isn't known here, always
      const delWanted = (e: string | undefined) => !e || [...deleteReach(e)].some((x) => want.has(x));
      const wantedIn = (ss: any[], binds: Map<string, string>): boolean => ss.some((x) =>
        x.kind === "set" ? want.has(x.name) : x.kind === "create" ? want.has(x.entity) : x.kind === "deleteWhere" ? delWanted(x.entity)
        : x.kind === "delete" ? delWanted(x.target?.kind === "name" ? binds.get(x.target.name) : undefined)
        : x.kind === "if" ? wantedIn(x.then, binds) || wantedIn(x.else ?? [], binds)
        : x.kind === "foreach" ? wantedIn(x.body, new Map([...binds, [x.bind, x.entity]]))
        : x.kind === "foreachList" ? wantedIn(x.body, binds) : false);
      const refuses = (ss: any[]): boolean => ss.some((x) => x.kind === "require" || x.kind === "reject" || x.kind === "rate_limit" || (x.kind === "if" && refuses([...x.then, ...(x.else ?? [])])) || ((x.kind === "foreach" || x.kind === "foreachList") && refuses(x.body)));
      const walk = (ss: Stmt[], guard: any[], binds: Map<string, string>): void => { for (const x of withTriggers(ss) as any[]) {
        const writes = x.kind === "set" ? [x.name] : x.kind === "create" ? [x.entity] : [];
        // a require decides whether the rest runs; a let matters only where what is wanted reads it
        if (x.kind === "require" || (x.kind === "let" && want.has(x.name))) changed = add(x) || changed;
        // an if matters when a branch writes something wanted, or can refuse the action
        if (x.kind === "if") { if (wantedIn([x], binds) || refuses([...x.then, ...(x.else ?? [])])) changed = add(x.cond) || changed; walk(x.then, [...guard, x.cond], binds); walk(x.else ?? [], [...guard, x.cond], binds); continue; }
        if (x.kind === "foreach" || x.kind === "foreachList") {
          const inner = x.kind === "foreach" ? new Map([...binds, [x.bind, x.entity]]) : binds;
          // the rows a loop runs for matter only if its body writes something wanted
          if (wantedIn(x.body, inner) || refuses(x.body)) { changed = add(x.where ?? x.over) || changed; changed = add(x.entity ? { entity: x.entity } : null) || changed; }
          walk(x.body, [...guard, x.where ?? x.over], inner); continue;
        }
        if (x.kind === "delete" || x.kind === "deleteWhere") { if (wantedIn([x], binds)) { changed = add(x.kind === "delete" ? x.target : x) || changed; for (const g of guard) changed = add(g) || changed; } continue; }
        if (writes.some((w) => want.has(w))) { changed = add(x) || changed; for (const g of guard) changed = add(g) || changed; }
      } };
      walk(body, [], new Map(params.filter((p: any) => p.type?.kind === "named" && ents.has(p.type.name)).map((p: any) => [p.name, p.type.name])));
      // triggers: kept whole when they write something wanted, or can refuse the write
      for (const t of fired) if (writesIn(t.body) && (wantedIn(t.body, new Map(t.on?.entity ? [[t.bind, t.on.entity]] : [])) || refuses(t.body))) { changed = add(t.body) || changed; if (t.when) changed = add(t.when) || changed; }
    }
    return want;
  }
  const writesSomething = (ss: Stmt[]): boolean => ss.some((x: any) => ["create", "set", "delete", "deleteWhere"].includes(x.kind) || (x.kind === "if" && (writesSomething(x.then) || writesSomething(x.else ?? []))) || ((x.kind === "foreach" || x.kind === "foreachList") && writesSomething(x.body)));

  // ---- the things that write: actions (schedules are internal actions) and workflow steps
  const gates = of("gate");
  const typed = typecheck(spec), events = typed.events;
  const fx = facts(spec, typed);
  // the triggers a writer can set off (facts.ts fires: by what it creates, sets, deletes and cascades to)
  const fired = (id: string): Decl[] => [...fires(fx, id)].map((t) => fx.decl.get(t));
  const eventType = (ev: string) => { const t: any = events.get(ev); return t?.k === "ref" ? { kind: "named", name: t.e, optional: !!t.opt } : { kind: "named", name: "?" }; };
  const runners: { id: string; where: string; line?: number; params: any[]; body: Stmt[]; gates: Decl[] }[] = [
    ...of("action").map((a) => ({ id: fx.idOf(a), where: `action ${a.name}`, line: a.pos?.line, params: a.params, body: a.body, gates: gates.filter((g) => !(a.skips ?? []).includes(g.name)) })),
    ...of("workflow").flatMap((w) => w.steps.map((st: any) => ({ id: stepId(w, st), where: `${w.name}: ${st.name}`, line: st.pos?.line ?? w.pos?.line, params: [{ name: w.bind, type: eventType(w.event) }], body: st.body, gates: [] }))),
  ];

  // one proof: the problem built for a bounded search (rows of each kind) or the full proof (0)
  type Built = { all: any[]; paramVals: [string, V][]; actor?: V; pre: State; post: State; reads: Set<string>; fr: Set<string>; relevant: string[]; made: { entity: string; id: any }[]; done?: Partial<InvResult> };
  function build(runner: (typeof runners)[number], inv: Decl, ri: number, rows: number): Built {
    newContext(`p${ri}_${inv.name}_${rows}`);
    bound = rows; domains = new Map(); closures = [];
    fresh = 0; unknowns = []; storedUnknowns = new Map(); singles = new Map(); created = [];
    const want = slice(inv, runner.body, runner.gates, fired(runner.id), runner.params);
    keep = (w) => want.has(w);
    const pre = mkState("pre");
    const vars = new Map<string, V>();
    vars.set("now", some(Z.Int.const("now"), "num"));
    let actor: V | undefined;
    if (actorEntity) { actor = { t: rowConst("actor", actorEntity), has: Z.Bool.const("signed_in"), k: "ref", entity: actorEntity }; vars.set("actor", actor); }
    const paramVals: [string, V][] = [];
    for (const p of runner.params) {
      const t = p.type;
      let v: V;
      if (t.kind === "set" && ents.has(t.of)) v = { t: undefined, has: T, set: { arr: Z.Array.const(`p_${p.name}`, S.row.get(t.of), S.Bool), entity: t.of } };
      else { let k: FK; try { k = kindOfType(t); } catch { k = { kind: "opaque", optional: true }; } v = { t: close(Z.Const(`p_${p.name}`, sortOf(k))), has: k.optional ? Z.Bool.const(`p_has_${p.name}`) : T, k: k.kind, entity: k.ref, enumName: k.enumName }; }
      vars.set(p.name, v); paramVals.push([p.name, v]);
    }
    const env: Env = { vars, state: pre, depth: 0 };
    const run: Run = { st: copy(pre), assume: [], pc: T, touched: new Set() };
    // a row argument names a row that exists (the runtime finds it); the actor too, and is a session's
    for (const [, v] of paramVals) if (v.entity && v.t !== undefined) run.assume.push(Z.Implies(v.has, pre.ex.get(v.entity).select(v.t)));
    if (actor) {
      run.assume.push(Z.Implies(actor.has, pre.ex.get(actorEntity!).select(actor.t)));
      const sess = of("identity").find((d) => d.source === "cookie");
      const sessRef = sess ? ents.get(sess.entity)?.fields.find((f: any) => f.type.kind === "named" && f.type.name === actorEntity) : undefined;
      if (sess && sessRef) { const sv = rowConst(name("session"), sess.entity); run.assume.push(Z.Implies(actor.has, Z.And(pre.ex.get(sess.entity).select(sv), pre.val.get(`${sess.entity}.${sessRef.name}`).select(sv).eq(actor.t)))); }
    }
    for (const g of runner.gates) run.assume.push(Z.Not(asBool(tr(g.cond, { ...env, assume: run.assume, pc: T }))));
    exec(runner.body, run, env);
    const reads = readsOf(inv.cond);
    const post = run.st;
    const fr = fieldsOf(inv.cond);
    const base = { paramVals, actor, pre, post, reads, fr, relevant: [] as string[], made: [...created] };
    if (![...run.touched].some((e) => reads.has(e))) return { ...base, all: [], done: { status: "proven", reason: "it writes nothing the invariant reads" } };
    const runUnknowns = [...unknowns];
    const inPlay = new Set<string>([...run.touched, ...reads, ...paramVals.filter(([, v]) => v.entity).map(([, v]) => v.entity!), ...(actor ? [actorEntity!] : [])]);
    for (const e of [...inPlay]) for (const f of ents.get(e)?.fields ?? []) if (f.type.kind === "named" && ents.has(f.type.name)) inPlay.add(f.type.name);
    // invariants see only their own names, not the action's
    const clean: Env = { vars: new Map([["now", vars.get("now")!]]), state: pre, depth: 0 };
    const facts = [...background(pre, clean, inPlay), ...invs.map((o) => asBool(tr(o.cond, { ...clean, state: pre }))), ...run.assume, ...background(post, { ...clean, state: post }, run.touched, want)];
    const before = unknowns.length;
    const goal = Z.Not(asBool(tr(inv.cond, { ...clean, state: post })));
    if (unknowns.length > before) return { ...base, all: [], done: { reason: `the invariant reads ${[...new Set(unknowns.slice(before))].join(", ")}` } };
    const relevant = [...new Set([...runUnknowns, ...[...storedUnknowns].filter(([f]) => fr.has(f)).flatMap(([, u]) => u)])];
    return { ...base, relevant, all: [...sortFacts(), ...facts, goal, ...closures] };
  }
  const solve = async (b: Built, ms: number) => {
    const s = new Z.Solver(); s.set("timeout", ms);
    for (const c of b.all) s.add(c);
    const res = await s.check();
    if (process.env.CRUDSPEC_SMT_DUMP) fs2.writeFileSync(`${process.env.CRUDSPEC_SMT_DUMP}-${bound || "full"}.smt2`, s.toString());
    return { res, s };
  };
  const why = (s: any) => { try { return LL.solver_get_reason_unknown(Z.ptr, s.ptr); } catch { return "no reason given"; } };

  for (const [ri, runner] of runners.entries()) {
    if (opts.part && (ri < opts.part[0] || ri >= opts.part[1])) continue;
    for (const inv of invs) {
      const r: InvResult = { invariant: inv.name, line: inv.pos.line, where: runner.where, whereLine: runner.line, status: "unproven" };
      results.push(r);
      if ((globalThis as any).gc) (globalThis as any).gc();
      try {
        // a few rows of each kind first: a way to break it is found fast, and is a real one
        const small = build(runner, inv, ri, opts.rows ?? 3);
        if (small.done) { Object.assign(r, small.done); continue; }
        const sb = await solve(small, opts.boundedMs ?? 3000);
        if (sb.res === "sat") {
          r.how = "bounded";
          const ce = describeModel(sb.s.model(), small.paramVals, small.actor, small.pre, small.post, small.reads, small.fr, small.made);
          if (small.relevant.length) r.reason = `a way to break it needs values the proof can't see (${small.relevant.join(", ")}): ${ce}`;
          else { r.status = "broken"; r.counterexample = ce; }
          continue;
        }
        // then any number of rows
        const full = build(runner, inv, ri, 0);
        const fb = await solve(full, opts.timeoutMs ?? 6000);
        r.how = "proof";
        if (fb.res === "unsat") r.status = "proven";
        else if (fb.res === "sat") {
          const ce = describeModel(fb.s.model(), full.paramVals, full.actor, full.pre, full.post, full.reads, full.fr, full.made);
          if (full.relevant.length) r.reason = `a way to break it needs values the proof can't see (${full.relevant.join(", ")}): ${ce}`;
          else { r.status = "broken"; r.counterexample = ce; }
        } else r.reason = `Z3 could not decide it with any number of rows (${why(fb.s)}); none of ${opts.rows ?? 3} rows of each kind breaks it`;
      } catch (e) {
        if (e instanceof Unsupported) r.reason = `the proof can't express ${e.message}`;
        else throw e;
      }
    }
  }


  // ---- a counterexample, as people read it: the arguments, who acts, and for each row they name
  // the fields that changed, then the other fields the invariant reads
  function describeModel(m: any, params: [string, V][], actor: V | undefined, pre: State, post: State, reads: Set<string>, fieldsRead: Set<string>, made: { entity: string; id: any }[] = []): string {
    const ids = new Map<string, number>();
    const rowName = (e: string, x: any) => { const k = m.eval(x, true).toString(); if (!ids.has(k)) ids.set(k, ids.size + 1); return `${e}#${ids.get(k)}`; };
    const truth = (x: any) => { try { return m.eval(x, true).toString() === "true"; } catch { return false; } };
    const textOf = (x: any) => { const k = m.eval(x, true).toString(); for (const [s, c] of S.texts) if (m.eval(c, true).toString() === k) return JSON.stringify(s); return "\"…\""; };
    const valueOf = (v: V) => {
      if (!truth(v.has)) return "none";
      if (v.t === undefined || v.unknown) return "?";
      if (v.k === "bool") return truth(v.t) ? "true" : "false";
      if (v.k === "enum") { const k = m.eval(v.t, true).toString(); for (const [n, c] of S.en.get(v.enumName!)!.vals) if (m.eval(c, true).toString() === k) return n; return "?"; }
      if (v.k === "ref") return rowName(v.entity!, v.t);
      if (v.k === "text") return textOf(v.t);
      if (v.k === "num") return m.eval(v.t, true).toString();
      return "…";
    };
    const args = params.map(([n, v]) => `${n}: ${v.set ? "{…}" : valueOf(v)}`).join(", ");
    const rows: [string, any][] = []; const seen = new Set<string>();
    const addRow = (e: string, id: any) => { const k = rowName(e, id); if (!seen.has(k)) { seen.add(k); rows.push([e, id]); } };
    for (const [, v] of params) if (v.entity && v.t !== undefined && truth(v.has)) addRow(v.entity, v.t);
    if (actor && truth(actor.has)) addRow(actor.entity!, actor.t);
    for (const c of made) addRow(c.entity, c.id);
    const lines: string[] = [];
    for (const [e, id] of rows) {
      if (!reads.has(e)) continue;
      const was = truth(pre.ex.get(e).select(id)), is = truth(post.ex.get(e).select(id));
      if (!was && !is) continue;
      if (!is) { lines.push(`${rowName(e, id)} deleted`); continue; }
      const fs = ents.get(e)!.fields.map((f: any) => f.name).filter((f: string) => { try { fieldKind(e, f); return true; } catch { return false; } });
      const at = (st: State, f: string) => valueOf(field(st, e, f, id));
      const changed = fs.filter((f: string) => was && at(pre, f) !== at(post, f)).map((f: string) => `${f} ${at(pre, f)} → ${at(post, f)}`);
      const also = fs.filter((f: string) => fieldsRead.has(f) && !(was && at(pre, f) !== at(post, f))).map((f: string) => `${f} ${at(post, f)}`);
      lines.push(`${rowName(e, id)}${was ? "" : " (new)"} ${changed.join(", ")}${also.length ? `${changed.length ? " " : ""}(${also.join(", ")})` : ""}`);
    }
    const who = actor ? (truth(actor.has) ? ` by ${rowName(actor.entity!, actor.t)}` : " signed out") : "";
    return `(${args})${who}${lines.length ? `: ${lines.join("; ")}` : ""}`;
  }
  return results;
}

// every proof, in child processes of one action each, several at a time: Z3's memory is the
// process's, and is let go only when it ends (lang/invariants-worker.ts runs one part)
export async function proveAll(specPath: string, opts: { batch?: number; parallel?: number; timeoutMs?: number; only?: number[] } = {}): Promise<InvResult[]> {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("./parser.ts");
  const spec = parse(readSpec(specPath));
  const invs = spec.decls.filter((d) => d.kind === "invariant");
  if (!invs.length) return [];
  const names = writerNames(spec), total = names.length;
  const { spawn } = await import("node:child_process");
  const { cpus } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const worker = fileURLToPath(new URL("./invariants-worker.ts", import.meta.url));
  const batch = opts.batch ?? 1, parallel = opts.parallel ?? Math.max(1, Math.min(4, cpus().length - 1));
  // only: the writers to prove (indices into writerNames), one process each; the rest are left out
  const parts: [number, number][] = [];
  if (opts.only) for (const i of opts.only) parts.push([i, i + 1]);
  else for (let i = 0; i < total; i += batch) parts.push([i, Math.min(total, i + batch)]);
  const out: InvResult[][] = new Array(parts.length);
  let next = 0;
  const nl = String.fromCharCode(10);
  const one = (k: number) => new Promise<void>((done) => {
    const pr = spawn(process.execPath, ["--expose-gc", "--no-warnings", worker, specPath, String(parts[k][0]), String(parts[k][1]), String(opts.timeoutMs ?? 6000)], { stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = ""; pr.stdout.on("data", (d) => (so += d)); pr.stderr.on("data", (d) => (se += d));
    // a process the solver crashed (it can run out of memory on a long search): its proofs are unproven
    pr.on("close", (code) => {
      if (code === 0) { try { out[k] = JSON.parse(so); return done(); } catch { /* below */ } }
      const why = /out of bounds|memory/i.test(se) ? "Z3 ran out of memory" : `the proof stopped (${se.trim().split(nl).pop()?.slice(0, 120) ?? "no output"})`;
      out[k] = names.slice(parts[k][0], parts[k][1]).flatMap((where) => invs.map((inv) => ({ invariant: inv.name, line: inv.pos.line, where, status: "unproven" as const, reason: why })));
      done();
    });
  });
  await Promise.all(Array.from({ length: Math.min(parallel, parts.length) }, async () => { while (next < parts.length) await one(next++); }));
  return out.flat();
}
// the things that write (actions and workflow steps), in the order proveInvariants takes them
export function writerNames(spec: Spec): string[] {
  return [...spec.decls.filter((d) => d.kind === "action").map((a) => `action ${a.name}`), ...spec.decls.filter((d) => d.kind === "workflow").flatMap((w) => w.steps.map((st: any) => `${w.name}: ${st.name}`))];
}


// what each writer's proofs depend on, as a hash, for verify's and build's cache. A proof reads:
//   - the prover's own source and the time limit;
//   - the writer (a workflow step: its workflow, and the type its event carries);
//   - the triggers it can set off (facts.ts fires);
//   - what every proof assumes: the invariants, gates, identities, the app, the events, and
//     each entity's structure (singleton, unique keys, entity invariants, reference fields: the
//     facts assumed of rows, and what a delete cascades to or is refused by);
//   - the functions, predicates and externs those name, and so on until nothing more is named;
//   - the other fields of entities, only those with a name any of that mentions (a field's value
//     reaches a proof only by its name), and on an entity it creates rows of, those with a
//     default (a create works defaults out);
//   - the enums it mentions by name or by a value (a bare value names its enum).
// So adding a field nothing reads, or changing an action, proves again only what can change.
// Names are gathered as every string in the syntax trees, which can only over-count. Positions
// are left out (and a trigger's name, trigger@<line>): a line moving doesn't change a proof
export async function proofKeys(spec: Spec, timeoutMs: number): Promise<string[]> {
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const strip = (x: unknown): unknown => Array.isArray(x) ? x.map(strip) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "pos").map(([k, v]) => [k, k === "name" && typeof v === "string" ? v.replace(/@\d+$/, "") : strip(v)])) : x;
  const strings = (x: unknown, out: Set<string>): Set<string> => {
    if (typeof x === "string") out.add(x);
    else if (Array.isArray(x)) for (const y of x) strings(y, out);
    else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) if (k !== "pos") strings(v, out);
    return out;
  };
  const prover = ["./invariants.ts", "./invariants-worker.ts", "./types.ts", "./parser.ts", "./facts.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8"));
  const hash = (...xs: string[]) => { const h = createHash("sha256"); for (const x of xs) h.update(x).update("|"); return h.digest("hex"); };
  const of = (k: string) => spec.decls.filter((d) => d.kind === k);
  const entities = of("entity");
  const isRef = (f: any) => f.type?.kind === "named" && entities.some((e) => e.name === f.type.name);
  const structure = entities.map((e) => ({ name: e.name, singleton: !!e.singleton, uniques: e.uniques ?? [], invariants: e.invariants ?? [], refs: e.fields.filter(isRef) }));
  const always = [...["invariant", "gate", "identity", "app", "event"].flatMap(of), ...structure];
  const base = hash(...prover, String(timeoutMs), JSON.stringify(strip(always)));
  const named = new Map<string, Decl>([...of("fn"), ...of("predicate"), ...of("extern")].map((d) => [d.name, d]));
  const enums = of("enum");
  const alwaysNames = strings(always, new Set());
  // the entities a create (or ensure) in it makes rows of
  const creates = (x: any, out: Set<string>): Set<string> => {
    if (Array.isArray(x)) for (const y of x) creates(y, out);
    else if (x && typeof x === "object") { if (x.kind === "create" && typeof x.entity === "string") out.add(x.entity); for (const [k, v] of Object.entries(x)) if (k !== "pos") creates(v, out); }
    return out;
  };
  const fx = facts(spec);
  const deps = (writer: unknown, ids: string[]): string => {
    const fired = [...fires(fx, ...ids)].map((t) => fx.decl.get(t));
    const N = strings([writer, fired], new Set(alwaysNames));
    const fns = new Set<string>(), fields = new Set<string>(), made = new Set<string>();
    for (let more = true; more;) {
      more = false;
      creates([writer, fired.map((t) => t.body)], made);
      for (const [n, d] of named) if (N.has(n) && !fns.has(n)) { fns.add(n); strings(d, N); more = true; }
      for (const e of entities) for (const f of e.fields) {
        const k = `${e.name}.${f.name}`;
        if (fields.has(k) || isRef(f) || !(N.has(f.name) || (f.default != null && made.has(e.name)))) continue;
        fields.add(k); strings(f, N); more = true;
      }
    }
    const fieldDecls = [...fields].sort().map((k) => { const [e, f] = k.split("."); return [k, entities.find((x) => x.name === e)!.fields.find((x: any) => x.name === f)]; });
    const enumDecls = enums.filter((d) => N.has(d.name) || d.values.some((v: string) => N.has(v)));
    return JSON.stringify(strip([fired, [...fns].sort().map((n) => named.get(n)), fieldDecls, enumDecls]));
  };
  const actions = of("action");
  const steps = of("workflow").flatMap((w) => w.steps.map((st: any) => ({ w, st })));
  const events = steps.length ? typecheck(spec).events : new Map();
  return [
    ...actions.map((a) => hash(base, "action", JSON.stringify(strip(a)), deps(a, [fx.idOf(a)]))),
    ...steps.map(({ w, st }) => hash(base, "step", st.name, JSON.stringify(strip(w)), JSON.stringify(events.get(w.event) ?? null), deps(w, w.steps.map((s: any) => stepId(w, s))))),
  ];
}

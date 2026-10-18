// Static checker for crudspec v2: name resolution and light typing for the logic,
// plus the UI rules in docs/LANGUAGE-v2.md (targets, form fields, permissions, reachability).
import type { Decl, El, Expr, Spec, Stmt } from "./parser.ts";

export type Finding = { severity: "error" | "warning"; code: string; where: string; message: string; line: number };

type T = { k: "any" } | { k: "ref"; e: string } | { k: "set"; e: string } | { k: "list"; of: T } | { k: "enum"; e: string } | { k: "scalar"; s: string } | { k: "none" };
const ANY: T = { k: "any" };
const S = (s: string): T => ({ k: "scalar", s });

export const BUILTINS: Record<string, [number, number]> = {      // name -> [min args, max args]
  plain: [1, 1], mentions: [1, 1], blank: [1, 1], present: [1, 1], authenticates: [2, 2], token: [1, 1], signed: [3, 3], verify: [3, 3],
  join: [2, 2], split: [1, 2], chunks: [2, 2], sentence: [1, 1], any: [1, 1], count: [1, 1], first: [1, 2], last: [1, 2], distinct: [1, 1],
  words: [1, 1], initials: [1, 1], first_word: [1, 1], label: [1, 1], after: [2, 2], lower: [1, 1], upper: [1, 1], trim: [1, 1], length: [1, 1],
  contains: [2, 2], starts_with: [2, 2], replace: [3, 3], public_ip: [1, 1], scheme: [1, 1], port: [1, 1], host_within: [2, 2],
  url: [1, 1], url_of: [1, 1], host: [1, 1], path: [1, 1], with_host: [2, 2], text: [1, 1], rich: [1, 1], html: [1, 1], file: [3, 3], request_file: [1, 1], words_only: [1, 1],
  max: [2, 2], min: [2, 2], cookie: [1, 1], download: [1, 1], matches: [2, 2], set: [1, 1],
};
export const WIDGETS = new Set(["copy_button", "share_button", "qr_link", "lightbox", "autocomplete", "push_permission"]);   // built in; apps declare their own
const AMBIENT = new Set(["actor", "request", "query", "client", "app", "theme", "result", "back", "home", "input", "typed"]);

export function check(spec: Spec): Finding[] {
  const out: Finding[] = [];
  const by = (kind: string) => new Map(spec.decls.filter((d) => d.kind === kind).map((d) => [d.name, d] as [string, Decl]));
  const enums = by("enum"), entities = new Map([...by("entity"), ...by("data")]), predicates = by("predicate"), fns = by("fn");
  const externs = by("extern"), actions = by("action"), views = by("view"), screens = by("screen"), components = by("component");
  const appWidgets = by("widget");
  const layouts = by("layout"), channels = by("channel"), signals = by("signal"), gates = by("gate"), identities = by("identity");
  const appDecl = spec.decls.find((d) => d.kind === "app");
  const actorEntity: string | undefined = appDecl?.props.actor?.name;
  const enumOf = new Map<string, string>();
  for (const e of enums.values()) for (const v of e.values) enumOf.set(v, e.name);
  const permissions = new Set(spec.decls.filter((d) => d.kind === "permission").map((d) => d.entity));
  const emitted = new Set<string>();
  const referencedActions = new Set<string>();
  let where = "";
  const err = (code: string, line: number, message: string) => out.push({ severity: "error", code, where, message, line });
  const warn = (code: string, line: number, message: string) => out.push({ severity: "warning", code, where, message, line });

  // Duplicate names in the same namespace.
  const seen = new Map<string, number>();
  for (const d of spec.decls) {
    if (["trigger", "workflow", "permission"].includes(d.kind)) continue;
    const ns = ["action", "view"].includes(d.kind) ? "callable" : d.kind;
    const key = `${ns}:${d.name}`;
    if (seen.has(key)) { where = d.name; err("DUPLICATE", d.pos.line, `${d.name} is declared twice`); }
    seen.set(key, d.pos.line);
  }

  const typeOf = (t: any): T => {
    if (!t) return ANY;
    if (t.kind === "set") return { k: "set", e: t.of };
    if (t.kind === "list") return { k: "list", of: typeOf(t.of) };
    if (entities.has(t.name)) return { k: "ref", e: t.name };
    if (enums.has(t.name)) return { k: "enum", e: t.name };
    return S(t.name);
  };
  const fieldOf = (e: string, f: string, line: number): T => {
    if (["id", "created", "updated"].includes(f)) return f === "id" ? S("Int") : S("Time");
    const ent = entities.get(e);
    if (!ent) return ANY;
    const fd = ent.fields.find((x: any) => x.name === f);
    if (!fd) { err("UNKNOWN_FIELD", line, `${e} has no field ${f}`); return ANY; }
    return typeOf(fd.type);
  };

  type Scope = { vars: Map<string, T>; row?: string; orderRow?: string; inWorkflow?: boolean; inView?: boolean; ui?: boolean };
  const withRow = (sc: Scope, row: string): Scope => ({ ...sc, row });
  const child = (sc: Scope): Scope => ({ ...sc, vars: new Map(sc.vars) });

  function expr(e: Expr | undefined, sc: Scope): T {
    if (!e) return ANY;
    switch (e.kind) {
      case "lit": return e.value === null ? { k: "none" } : S(typeof e.value === "string" ? "Text" : typeof e.value === "number" ? "Int" : "Bool");
      case "duration": return S("Duration");
      case "now": return S("Time");
      case "it": if (!sc.row) { err("IT_OUTSIDE_WHERE", e.pos.line, "'it' outside a where"); return ANY; } return { k: "ref", e: sc.row };
      case "rowfield": if (!sc.row) { err("ROWFIELD_OUTSIDE_WHERE", e.pos.line, `.${e.name} outside a where`); return ANY; } return fieldOf(sc.row, e.name, e.pos.line);
      case "name": {
        if (sc.vars.has(e.name)) return sc.vars.get(e.name)!;
        if (e.name === "actor") return actorEntity ? { k: "ref", e: actorEntity } : ANY;
        if (AMBIENT.has(e.name)) return ANY;
        if (enumOf.has(e.name)) return { k: "enum", e: enumOf.get(e.name)! };
        if (entities.get(e.name)?.singleton) return { k: "ref", e: e.name };
        if (["get", "write"].includes(e.name) || identities.has(e.name)) return ANY;
        // An order-by may name the row's fields bare, as v1 views do.
        if (sc.orderRow && (["created", "updated", "id"].includes(e.name) || entities.get(sc.orderRow)?.fields.some((f: any) => f.name === e.name))) return fieldOf(sc.orderRow, e.name, e.pos.line);
        if (entities.has(e.name)) return S("Entity");
        if (views.has(e.name) || screens.has(e.name)) return S("Reference");
        if (actions.has(e.name)) { referencedActions.add(e.name); return S("Reference"); }
        err("UNKNOWN_NAME", e.pos.line, `unknown name ${e.name}`); return ANY;
      }
      case "field": {
        const t = expr(e.target, sc);
        if (t.k === "ref") return fieldOf(t.e, e.name, e.pos.line);
        return ANY;
      }
      case "unary": expr(e.arg, sc); return e.op === "not" ? S("Bool") : ANY;
      case "binary": {
        const l = expr(e.left, sc), r = expr(e.right, sc);
        if (["==", "!="].includes(e.op) && l.k === "ref" && r.k === "ref" && l.e !== r.e) err("TYPE_MISMATCH", e.pos.line, `${l.e} compared with ${r.e}`);
        if (["==", "!="].includes(e.op) && l.k === "enum" && r.k === "enum" && l.e !== r.e) err("TYPE_MISMATCH", e.pos.line, `${l.e} compared with ${r.e}`);
        if (["==", "!="].includes(e.op) && ((l.k === "enum" && r.k === "ref") || (l.k === "ref" && r.k === "enum"))) err("TYPE_MISMATCH", e.pos.line, `${l.k === "enum" ? l.e : (l as any).e} compared with ${r.k === "enum" ? r.e : (r as any).e} (is a parameter hiding an enum value?)`);
        if (["+"].includes(e.op) && (l.k === "set" || r.k === "set")) return l.k === "set" ? l : r;
        return ["==", "!=", "<", "<=", ">", ">=", "in", "and", "or", "implies"].includes(e.op) ? S("Bool") : (l.k === "any" ? r : l);
      }
      case "if": expr(e.cond, sc); { const a = expr(e.then, sc); const b = expr(e.else, sc); return a.k === "none" ? b : a; }
      case "listlit": case "setlit": { let t: T = ANY; for (const i of e.items) t = expr(i, sc); return { k: "list", of: t }; }
      case "json": for (const v of Object.values(e.fields)) expr(v as Expr, sc); return S("Json");
      case "query": case "all": case "listq": {
        if (!entities.has(e.entity)) { err("UNKNOWN_ENTITY", e.pos.line, `unknown entity ${e.entity}`); return ANY; }
        const rs = withRow(sc, e.entity);
        expr(e.where, rs); expr(e.order, { ...rs, orderRow: e.entity }); expr(e.limit, sc);
        if (e.kind === "all") expr(e.cond, rs);
        if (e.kind === "listq") return { k: "list", of: e.map ? expr(e.map, rs) : { k: "ref", e: e.entity } };
        if (e.kind === "all" || e.op === "exists") return S("Bool");
        if (e.op === "count") return S("Int");
        if (e.op === "set") return { k: "set", e: e.entity };
        return { k: "ref", e: e.entity };
      }
      case "extern": {
        const x = externs.get(e.name);
        if (!x) { err("UNKNOWN_EXTERN", e.pos.line, `unknown extern ${e.name}`); }
        else {
          const allowed = sc.inWorkflow || x.effect === "pure" || (sc.inView && x.effect === "fetch");
          if (!allowed) err("EXTERN_OUTSIDE_WORKFLOW", e.pos.line, `extern ${e.name} (effect ${x.effect}) called outside a workflow step`);
          const n = e.args.length + Object.keys(e.named).length;
          if (n !== x.params.length) err("ARITY", e.pos.line, `${e.name} takes ${x.params.length} arguments, given ${n}`);
        }
        for (const a of [...e.args, ...Object.values(e.named)]) expr(a as Expr, sc);
        return x?.returns ? typeOf(x.returns) : ANY;
      }
      case "call": {
        for (const a of [...e.args, ...Object.values(e.named)]) expr(a as Expr, sc);
        const n = e.args.length + Object.keys(e.named).length;
        const d = predicates.get(e.name) ?? fns.get(e.name);
        if (d) {
          if (n !== d.params.length) err("ARITY", e.pos.line, `${e.name} takes ${d.params.length} arguments, given ${n}`);
          return d.kind === "predicate" ? S("Bool") : typeOf(d.returns);
        }
        if (screens.has(e.name)) { checkArgs(screens.get(e.name)!, e, "screen"); return S("Screen"); }
        if (views.has(e.name)) { checkArgs(views.get(e.name)!, e, "view"); return ANY; }
        if (spec.decls.some((x) => x.kind === "api" && x.name === e.name)) return S("Url");
        if (["message_api"].includes(e.name)) return S("Url");
        const b = BUILTINS[e.name];
        if (!b) { err("UNKNOWN_FUNCTION", e.pos.line, `unknown function ${e.name}`); return ANY; }
        if (n < b[0] || n > b[1]) err("ARITY", e.pos.line, `${e.name} takes ${b[0] === b[1] ? b[0] : `${b[0]}–${b[1]}`} arguments, given ${n}`);
        if (e.name === "set" && e.args[0]) { const t = expr(e.args[0], sc); if (t.k === "ref") return { k: "set", e: t.e }; }
        // list functions take the list first; a scalar there is a mistake (first(1, l) for first(l, 1))
        if (["first", "last", "join", "chunks", "distinct", "any", "sentence"].includes(e.name) && e.args[0]) {
          const t0 = expr(e.args[0], sc);
          if (t0.k === "scalar" && !(e.name === "chunks" && t0.s === "Text")) err("BUILTIN_ARGUMENT", e.pos.line, `${e.name} takes a list first: ${e.name}(list${b[1] > 1 ? ", …" : ""}), given a ${t0.s}`);
          if (e.name === "join") return S("Text");
          if ((e.name === "first" || e.name === "last") && t0.k === "list") return n > 1 ? t0 : t0.of;
        }
        if (["words", "length", "count"].includes(e.name)) return S("Int");
        if (e.name === "split") return { k: "list", of: S("Text") };
        return ANY;
      }
    }
    return ANY;
  }

  function checkArgs(d: Decl, e: any, what: string) {
    const params = d.params ?? [];
    const n = e.args.length;
    if (n > params.length) err("ARITY", e.pos?.line ?? d.pos.line, `${what} ${d.name} takes at most ${params.length} arguments, given ${n}`);
    for (const k of Object.keys(e.named ?? {})) if (!params.some((p: any) => p.name === k)) err("UNKNOWN_ARGUMENT", e.pos?.line ?? d.pos.line, `${what} ${d.name} has no parameter ${k}`);
  }

  function stmts(ss: Stmt[], sc: Scope) { for (const s of ss) stmt(s, sc); }
  function stmt(s: Stmt, sc: Scope) {
    switch (s.kind) {
      case "require": expr(s.cond, sc); return;
      case "reject": return;
      case "let": sc.vars.set(s.name, expr(s.value, sc)); return;
      case "result": expr(s.value, sc); return;
      case "touch": expr(s.target, sc); return;
      case "callstmt": expr(s.call, sc); return;
      case "rate_limit": expr(s.by, sc); return;
      case "create": {
        const ent = entities.get(s.entity);
        if (!ent) { err("UNKNOWN_ENTITY", s.pos.line, `unknown entity ${s.entity}`); return; }
        const given = new Set<string>();
        for (const a of s.fields) {
          given.add(a.name); expr(a.value, sc);
          if (!ent.fields.some((f: any) => f.name === a.name)) err("UNKNOWN_FIELD", s.pos.line, `${s.entity} has no field ${a.name}`);
        }
        for (const f of ent.fields) if (!given.has(f.name) && !f.default && !(f.type.kind === "named" && f.type.optional)) err("MISSING_FIELD", s.pos.line, `create ${s.entity} without required field ${f.name}`);
        if (s.as) sc.vars.set(s.as, { k: "ref", e: s.entity });
        return;
      }
      case "set": { const t = expr(s.target, sc); if (t.k === "ref") fieldOf(t.e, s.name, s.pos.line); expr(s.value, sc); return; }
      case "delete": expr(s.target, sc); return;
      case "deleteWhere": if (!entities.has(s.entity)) err("UNKNOWN_ENTITY", s.pos.line, `unknown entity ${s.entity}`); else expr(s.where, withRow(sc, s.entity)); return;
      case "foreach": {
        if (!entities.has(s.entity)) { err("UNKNOWN_ENTITY", s.pos.line, `unknown entity ${s.entity}`); return; }
        expr(s.where, withRow(sc, s.entity));
        const c = child(sc); c.row = undefined; c.vars.set(s.bind, { k: "ref", e: s.entity }); stmts(s.body, c); return;
      }
      case "foreachList": { const t = expr(s.over, sc); const c = child(sc); c.vars.set(s.bind, t.k === "list" ? t.of : ANY); stmts(s.body, c); return; }
      case "if": expr(s.cond, sc); stmts(s.then, child(sc)); stmts(s.else, child(sc)); return;
      case "emit": emitted.add(s.event); for (const a of s.args) expr(a, sc); return;
    }
  }

  const paramScope = (ps: any[], extra: Record<string, T> = {}): Scope => {
    const vars = new Map<string, T>(Object.entries(extra));
    for (const p of ps) vars.set(p.name, typeOf(p.type));
    return { vars };
  };

  // ---- logic declarations
  // an extern bound to Go: types the binding can carry, and a pinned import for a module
  const imports = by("import");
  const GO_TYPES = ["Text", "Email", "Url", "Int", "Bool", "Time", "Duration"];
  const goType = (t: any) => t.kind === "named" ? GO_TYPES.includes(t.name) : t.kind === "list" && t.of.kind === "named" && t.of.name === "Text";
  function checkGoBinding(d: any) {
    if (d.effect === "TODO") err("GO_EFFECT", d.pos.line, `extern ${d.name}: choose its effect (lang/cli.ts bind leaves TODO): pure when it changes nothing outside the app, fetch when it only reads from outside, otherwise a name for what it does (mail, http, …)`);
    for (const p of d.params) if (p.type.optional || !goType(p.type))
      err("GO_TYPE", p.pos?.line ?? d.pos.line, `extern ${d.name}: parameter ${p.name} can't be passed to Go; the types a binding takes: ${GO_TYPES.join(", ")}, list of Text (not optional)`);
    if (d.returns && !goType(d.returns)) err("GO_TYPE", d.pos.line, `extern ${d.name}: its result can't come from Go; the types: ${GO_TYPES.join(", ")}, list of Text, optionally ?`);
    const pkg: string | undefined = d.go.pkg;
    if (pkg && pkg.split("/")[0].includes(".") && ![...imports.values()].some((i: any) => pkg === i.module || pkg.startsWith(i.module + "/")))
      err("GO_IMPORT", d.pos.line, `extern ${d.name} binds to "${pkg}", which isn't the standard library: add import go "<module>@<version>"`);
  }
  for (const d of spec.decls) {
    where = `${d.kind} ${d.name}`;
    switch (d.kind) {
      case "extern": if (d.go) checkGoBinding(d); break;
      case "entity": case "data":
        for (const f of d.fields) if (f.default) expr(f.default, { vars: new Map(), row: d.name });
        for (const inv of d.invariants) expr(inv, { vars: new Map([["self", { k: "ref", e: d.name } as T]]), row: d.name });
        for (const u of d.uniques) for (const c of u) if (!d.fields.some((f: any) => f.name === c)) err("UNKNOWN_FIELD", d.pos.line, `unique on unknown field ${c}`);
        if (d.was && entities.has(d.was)) err("WAS_CONFLICT", d.pos.line, `${d.name} was ${d.was}, but ${d.was} is still declared`);
        for (const f of d.fields) if (f.was && d.fields.some((g: any) => g.name === f.was)) err("WAS_CONFLICT", f.pos.line, `${d.name}.${f.name} was ${f.was}, but ${f.was} is still a field`);
        break;
      case "migration": {
        // a data migration changes rows as written: no events, no externs
        stmts(d.body, paramScope([]));
        const walk = (x: any): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk);
          if (x.kind === "emit" || x.kind === "extern") err("MIGRATION_EFFECT", x.pos?.line ?? d.pos.line, `migration "${d.name}" can't ${x.kind === "emit" ? "emit events" : "call externs"}`);
          for (const v of Object.values(x)) walk(v); };
        walk(d.body);
        break;
      }
      case "enum":
        for (const [v, old] of Object.entries(d.renames ?? {})) if (d.values.includes(old)) err("WAS_CONFLICT", d.pos.line, `${d.name}: ${v} was ${old}, but ${old} is still a value`);
        break;
      case "drop": {
        const ent = entities.get(d.entity);
        if (!d.field && ent) err("DROP_DECLARED", d.pos.line, `drop entity ${d.entity}, but ${d.entity} is still declared`);
        if (d.field && ent?.fields.some((f: any) => f.name === d.field)) err("DROP_DECLARED", d.pos.line, `drop ${d.entity}.${d.field}, but the field is still declared`);
        break;
      }
      case "predicate": case "fn": expr(d.body, paramScope(d.params)); break;
      case "gate": expr(d.cond, { vars: new Map() }); break;
      case "permission": if (!entities.has(d.entity)) err("UNKNOWN_ENTITY", d.pos.line, `unknown entity ${d.entity}`); else expr(d.cond, paramScope([], { [snake(d.entity)]: { k: "ref", e: d.entity } })); break;
      case "action":
        for (const g of d.skips) if (!gates.has(g)) err("UNKNOWN_GATE", d.pos.line, `skip of unknown gate ${g}`);
        stmts(d.body, paramScope(d.params));
        break;
      case "trigger": {
        const vars: Record<string, T> = {};
        if (d.on.kind !== "event") { if (!entities.has(d.on.entity)) err("UNKNOWN_ENTITY", d.pos.line, `trigger on unknown entity ${d.on.entity}`); vars[d.bind] = { k: "ref", e: d.on.entity }; vars.old = { k: "ref", e: d.on.entity }; }
        const sc = paramScope([], vars); expr(d.when, sc); stmts(d.body, sc); break;
      }
      case "workflow": for (const st of d.steps) stmts(st.body, { ...paramScope([], { [d.bind]: ANY }), inWorkflow: true }); break;
      case "view": {
        const sc: Scope = { ...paramScope(d.params), inView: true };
        for (const r of d.requires) expr(r.cond, sc);
        if (d.value) expr(d.value, sc);
        if (d.rows) {
          if (!entities.has(d.rows.entity)) err("UNKNOWN_ENTITY", d.pos.line, `unknown entity ${d.rows.entity}`);
          else { expr(d.rows.where, withRow(sc, d.rows.entity)); expr(d.order, { ...withRow(sc, d.rows.entity), orderRow: d.rows.entity }); if (!permissions.has(d.rows.entity)) err("VIEW_WITHOUT_PERMISSION", d.pos.line, `${d.name} returns ${d.rows.entity} rows, which have no read permission`); }
        }
        expr(d.limit, sc);
        break;
      }
      case "channel": {
        const sc = paramScope(d.params); expr(d.requires, sc);
        for (const key of ["open", "close"]) if (d[key]) targetAction(d[key], sc);
        if (d.every) targetAction(d.every.target, sc);
        break;
      }
      case "signal": { const sc = paramScope(d.params); expr(d.to, sc); expr(d.requires, sc); break; }
      case "api":
        for (const r of d.routes) {
          // path parameters take the types of the target's parameters with the same names
          const target = actions.get(r.target.name) ?? views.get(r.target.name);
          const pathNames = [...`${d.route}/${r.path}`.matchAll(/:(\w+)/g)].map((m) => m[1]);
          const sc = paramScope([], Object.fromEntries(pathNames.map((n) => { const p = target?.params.find((x: any) => x.name === n); return [n, p ? typeOf(p.type) : ANY]; })));
          if (actions.has(r.target.name)) targetAction(r.target, sc);
          else if (views.has(r.target.name)) { for (const a of [...r.target.args, ...Object.values(r.target.named)]) expr(a as Expr, sc); checkArgs(views.get(r.target.name)!, r.target, "view"); }
          else err("UNKNOWN_TARGET", r.pos.line, `api route calls unknown action or view ${r.target.name}`);
          if (r.json && !fns.has(r.json)) err("UNKNOWN_FUNCTION", r.pos.line, `unknown JSON shape ${r.json}`);
          if (r.location) expr(r.location, sc);
        }
        break;
    }
  }
  for (const w of spec.decls.filter((d) => d.kind === "workflow")) if (!emitted.has(w.event)) { where = w.name; warn("WORKFLOW_NEVER_RUNS", w.pos.line, `nothing emits ${w.event}`); }

  function targetAction(t: any, sc: Scope): Decl | undefined {
    const a = actions.get(t.name);
    if (!a) { err("UNKNOWN_ACTION", t.pos?.line ?? 0, `unknown action ${t.name}`); return; }
    referencedActions.add(t.name);
    for (const x of [...(t.args ?? []), ...Object.values(t.named ?? {})]) expr(x as Expr, sc);
    checkArgs(a, t, "action");
    return a;
  }

  // ---- UI
  function ui(els: El[], sc: Scope, form?: { action: Decl; given: Set<string> }) {
    for (const el of els) uiEl(el, sc, form);
  }
  function uiEl(el: El, sc: Scope, form?: { action: Decl; given: Set<string> }) {
    for (const [k, v] of Object.entries(el.attrs)) if (v !== true && k !== "as") expr(v as Expr, sc);
    const h = el.head;
    switch (el.name) {
      case "heading": case "text": case "strong": case "richtext": case "time": case "image": case "icon": case "avatar": case "avatars": case "field_display": case "title":
        if (h) expr(h, sc); break;
      case "let": sc.vars.set(h.name, expr(h.value, sc)); return;
      case "if": expr(h, sc); ui(el.children, child(sc), form); if (el.else) ui(el.else, child(sc), form); return;
      case "each": { const t = expr(h.over, sc); const c = child(sc); c.vars.set(h.bind, t.k === "list" ? t.of : ANY); ui(el.children, c, form); return; }
      case "list": {
        const c = child(sc);
        let rowEntity: string | undefined;
        if (h.source.kind === "query") {
          if (!entities.has(h.source.entity)) err("UNKNOWN_ENTITY", el.pos.line, `unknown entity ${h.source.entity}`);
          else { rowEntity = h.source.entity; expr(h.source.where, withRow(sc, rowEntity)); expr(h.source.order, { ...withRow(sc, rowEntity), orderRow: rowEntity }); }
        } else {
          const v = views.get(h.source.name);
          if (!v) err("UNKNOWN_VIEW", el.pos.line, `list of unknown view ${h.source.name}`);
          else { checkArgs(v, h.source, "view"); for (const a of [...h.source.args, ...Object.values(h.source.named)]) expr(a as Expr, sc); rowEntity = v.rows?.entity; }
        }
        if (rowEntity && !permissions.has(rowEntity)) err("SCREEN_SHOWS_UNPERMITTED", el.pos.line, `a list shows ${rowEntity} rows, which have no read permission`);
        c.vars.set(h.bind, rowEntity ? { k: "ref", e: rowEntity } : ANY);
        expr(h.where, c); expr(h.order, c);
        ui(el.children, c, form); return;
      }
      case "use": {
        const comp = components.get(h.name);
        if (!comp) err("UNKNOWN_COMPONENT", el.pos.line, `unknown component ${h.name}`);
        else if (h.args.length !== comp.params.length) err("ARITY", el.pos.line, `component ${h.name} takes ${comp.params.length} arguments, given ${h.args.length}`);
        for (const a of h.args) expr(a, sc); return;
      }
      case "widget":
        if (appWidgets.has(h.name)) checkArgs(appWidgets.get(h.name), h, "widget");
        else if (!WIDGETS.has(h.name)) err("UNKNOWN_WIDGET", el.pos.line, `unknown widget ${h.name}; declare it with "widget ${h.name}(…)" and implement it in the app's widget module`);
        for (const a of [...h.args, ...Object.values(h.named)]) expr(a as Expr, sc); break;
      case "channel": if (!channels.has(h.name)) err("UNKNOWN_CHANNEL", el.pos.line, `unknown channel ${h.name}`); for (const a of h.args) expr(a, sc); break;
      case "signal": if (!signals.has(h.name)) err("UNKNOWN_SIGNAL", el.pos.line, `unknown signal ${h.name}`); for (const a of h.args) expr(a, sc); break;
      case "link": case "go": {
        if (h.kind === "url") expr(h.value, sc);
        else if (!(h.bare && AMBIENT.has(h.name))) {
          const s = screens.get(h.name);
          if (!s) err("UNKNOWN_SCREEN", el.pos.line, `${el.name} to unknown screen ${h.name}`);
          else { checkArgs(s, h, "screen"); for (const a of [...h.args, ...Object.values(h.named)]) expr(a as Expr, sc); }
        }
        break;
      }
      case "button": {
        const a = targetAction(h, sc);
        if (a) {
          const given = new Set<string>([...a.params.slice(0, h.args.length).map((p: any) => p.name), ...Object.keys(h.named)]);
          for (const p of a.params) if (!given.has(p.name) && !(p.type.kind === "named" && p.type.optional)) err("MISSING_INPUT", el.pos.line, `button calls ${a.name} without its parameter ${p.name}`);
        }
        break;
      }
      case "form": {
        const a = targetAction(h, sc);
        if (a) {
          const given = new Set<string>([...a.params.slice(0, h.args.length).map((p: any) => p.name), ...Object.keys(h.named)]);
          const f = { action: a, given };
          const c = child(sc); c.vars.set("result", ANY);
          ui(el.children, c, f);
          for (const p of a.params) if (!given.has(p.name) && !(p.type.kind === "named" && p.type.optional)) err("MISSING_INPUT", el.pos.line, `form for ${a.name} has no field for its parameter ${p.name}`);
          return;
        }
        ui(el.children, child(sc)); return;
      }
      case "field": {
        if (!form) { err("FIELD_OUTSIDE_FORM", el.pos.line, `field ${h.name} outside a form`); break; }
        const param = form.action.params.find((p: any) => p.name === h.name);
        if (!param) err("FIELD_NOT_A_PARAMETER", el.pos.line, `${form.action.name} has no parameter ${h.name}`);
        else {
          // the field's kind must fit the parameter's type
          const isSetParam = param.type.kind === "set";
          const isRowParam = param.type.kind === "named" && entities.has(param.type.name);
          if (h.kind === "users" && !isSetParam) err("FIELD_KIND_MISMATCH", el.pos.line, `field ${h.name} is a multi-select (users), but ${form.action.name}.${h.name} is not a set`);
          if (isSetParam && h.kind !== "users" && h.kind !== "hidden") err("FIELD_KIND_MISMATCH", el.pos.line, `${form.action.name}.${h.name} is a set; use a users field`);
          if (h.kind === "select" && !isRowParam) err("FIELD_KIND_MISMATCH", el.pos.line, `field ${h.name} is a select, but ${form.action.name}.${h.name} is not a row`);
          const isChoiceParam = param.type.kind === "named" && (enums.has(param.type.name) || param.type.name === "Bool");
          if (h.kind === "choice" && !isChoiceParam) err("FIELD_KIND_MISMATCH", el.pos.line, `field ${h.name} is a choice, but ${form.action.name}.${h.name} is neither an enum nor a Bool`);
          if (h.kind === "choice" && !el.attrs.from) err("FIELD_WITHOUT_CHOICES", el.pos.line, `field ${h.name} needs from [values]`);
          if (h.kind === "number" && !(param.type.kind === "named" && param.type.name === "Int")) err("FIELD_KIND_MISMATCH", el.pos.line, `field ${h.name} is a number, but ${form.action.name}.${h.name} is not an Int`);
          if ((h.kind === "users" || h.kind === "select") && !el.attrs.from && !el.attrs.autocomplete) err("FIELD_WITHOUT_CHOICES", el.pos.line, `field ${h.name} needs from or autocomplete`);
        }
        form.given.add(h.name);
        break;
      }
      case "on": for (const r of h.reactions) { if (r.kind === "go") uiEl({ kind: "el", name: "go", head: r.target, attrs: {}, children: [], pos: el.pos }, sc, form); else if (r.value) expr(r.value, { ...sc, vars: new Map([...sc.vars, ["result", ANY]]) }); } break;
      case "slot": break;
    }
    if (el.children.length && !["form", "if", "each", "list"].includes(el.name)) ui(el.children, sc, form);
  }

  for (const d of spec.decls) {
    where = `${d.kind} ${d.name}`;
    if (d.kind === "component") ui(d.body, paramScope(d.params));
    if (d.kind === "layout") ui(d.body, { vars: new Map() });
    if (d.kind === "screen") {
      if (!layouts.has(d.layout)) err("UNKNOWN_LAYOUT", d.pos.line, `unknown layout ${d.layout}`);
      const sc = paramScope(d.params);
      for (const r of d.requires) { expr(r.cond, sc); if (r.go) uiEl({ kind: "el", name: "go", head: r.go, attrs: {}, children: [], pos: r.pos }, sc); if (r.flash) expr(r.flash, sc); }
      ui(d.body, sc);
    }
    if (d.kind === "theme") for (const v of Object.values(d.props)) expr(v as Expr, { vars: new Map() });
    if (d.kind === "app") {
      if (actorEntity && !entities.has(actorEntity)) err("UNKNOWN_ENTITY", d.pos.line, `app actor ${actorEntity} is not an entity`);
      for (const k of ["sign_in", "setup"]) { const t = d.props[k]; if (t && !screens.has(t.name)) err("UNKNOWN_SCREEN", d.pos.line, `app ${k} names unknown screen ${t.name}`); }
      if (d.props.setup_when) expr(d.props.setup_when, { vars: new Map() });
    }
    if (d.kind === "avatar" || d.kind === "display") {
      if (!entities.has(d.entity)) err("UNKNOWN_ENTITY", d.pos.line, `${d.kind} for unknown entity ${d.entity}`);
      else expr(d.value, { vars: new Map(), row: d.entity });
    }
  }

  // Reachability: every non-internal action is offered by a screen, the API or a channel.
  for (const a of actions.values()) {
    where = `action ${a.name}`;
    if (!a.internal && !referencedActions.has(a.name)) warn("ACTION_UNREACHABLE", a.pos.line, `no screen, API route or channel offers ${a.name}; the runtime generates /_auto/actions/${a.name} for it (cli scaffold prints it)`);
    if (a.internal && referencedActions.has(a.name) && ![...channels.values()].some((c) => [c.open, c.close, c.every?.target].some((t: any) => t?.name === a.name))) {
      warn("INTERNAL_ACTION_OFFERED", a.pos.line, `internal action ${a.name} is offered outside a channel`);
    }
  }
  return out;
}

function snake(s: string): string { return s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(); }

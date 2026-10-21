// Static checker for crudspec v2: name resolution and light typing for the logic,
// plus the UI rules in docs/LANGUAGE-v2.md (targets, form fields, permissions, reachability).
import { HTML_COMMON, HTML_ELEMENTS, REACT_ATTRS, TAG_OF, type Decl, type El, type Expr, type Pos, type Spec, type Stmt } from "./parser.ts";
// plain HTML named like a slot the layout has: <main> where <Main> was meant
const slotLike = (x: El) => x.name === "html" && ["main", "nav", "footer", "aside"].includes(x.head.tag);
import { describe } from "./describe.ts";
import { didYouMean } from "./didyoumean.ts";

export type Finding = { severity: "error" | "warning"; code: string; where: string; message: string; line: number; col?: number };

type T = { k: "any" } | { k: "ref"; e: string } | { k: "set"; e: string } | { k: "list"; of: T } | { k: "enum"; e: string } | { k: "scalar"; s: string } | { k: "none" };
const ANY: T = { k: "any" };
const S = (s: string): T => ({ k: "scalar", s });

// the spec types a Go binding carries, and the Go types for each (rt/gobind.go fits; bind/main.go specType)
export const GO_BINDING_TYPES: Record<string, string> = {
  Text: "string or []byte", Email: "string or []byte", Url: "string or []byte", Int: "int, int8…int64, uint…uint64 (a value that doesn't fit is refused)",
  Bool: "bool", Time: "time.Time", Duration: "time.Duration", "list of Text": "[]string",
};
const GO_TYPES = Object.keys(GO_BINDING_TYPES).filter((t) => !t.startsWith("list"));
// the value types a field, parameter or result can be (lang/types.ts fromType reads each)
// what other languages call the value types
const OTHER_TYPES: Record<string, string> = {
  String: "Text", string: "Text", str: "Text", varchar: "Text", text: "Text", UUID: "Text", uuid: "Text",
  Integer: "Int", integer: "Int", Number: "Int", number: "Int", Long: "Int", long: "Int", bigint: "Int", Float: "Int", float: "Int", Double: "Int", double: "Int", Decimal: "Int", decimal: "Int",
  Boolean: "Bool", boolean: "Bool", bool: "Bool",
  DateTime: "Time", Date: "Time", Timestamp: "Time", datetime: "Time", date: "Time", timestamp: "Time", Instant: "Time",
  JSON: "Json", json: "Json", Object: "Json", URL: "Url", URI: "Url", Uri: "Url", Html: "RichText", HTML: "RichText", Markdown: "RichText",
};
export const SCALAR_TYPES = ["Text", "Email", "Url", "Ip", "Int", "Bool", "Time", "Duration", "RichText", "File", "Password", "Json"];
export const BUILTINS: Record<string, [number, number]> = {      // name -> [min args, max args]
  plain: [1, 1], mentions: [1, 1], blank: [1, 1], present: [1, 1], authenticates: [2, 2], token: [1, 1], signed: [3, 3], verify: [3, 3],
  join: [2, 2], split: [1, 2], chunks: [2, 2], sentence: [1, 1], any: [1, 1], count: [1, 1], first: [1, 2], last: [1, 2], distinct: [1, 1],
  words: [1, 1], initials: [1, 1], first_word: [1, 1], label: [1, 1], after: [2, 2], lower: [1, 1], upper: [1, 1], trim: [1, 1], length: [1, 1],
  contains: [2, 2], starts_with: [2, 2], replace: [3, 3], public_ip: [1, 1], scheme: [1, 1], port: [1, 1], host_within: [2, 2],
  url: [1, 1], url_of: [1, 1], host: [1, 1], path: [1, 1], with_host: [2, 2], text: [1, 1], rich: [1, 1], html: [1, 1], file: [3, 3], request_file: [1, 1], words_only: [1, 1],
  max: [2, 2], min: [2, 2], cookie: [1, 1], download: [1, 1], matches: [2, 2], set: [1, 1],
};
// the theme classes the runtime reads (sv.DC/dc in lang/gogen), and the scaffold's; an app's own
// widgets read others (lang/test/reference.test.ts keeps this list in step with the runtime)
export const THEME_CLASSES = new Set(["avatar", "avatar_large", "button", "button_form", "choice", "choices", "column", "dropdown", "dropdown_panel", "embed", "embed_body", "embed_content",
  "embed_description", "embed_image", "embed_title", "field", "fieldset", "form", "generated_section", "heading", "icon", "input", "menu", "picker_item", "row", "screen_reader", "selected", "signal", "submit"]);
export const WIDGETS = new Set(["copy_button", "share_button", "qr_link", "lightbox", "autocomplete", "push_permission"]);   // built in; apps declare their own
// the fields of the ambient objects with a fixed shape: request (rt.Ctx.ReqObj), and what a
// screen sees (rt/server.go's ambient)
const AMBIENT_FIELDS: Record<string, string[]> = {
  request: ["ip", "method", "identity", "user_agent", "session_token", "text", "cookies"],
  theme: ["logo"], app: ["name", "version"], client: ["push_endpoint"],
};
const AMBIENT = new Set(["actor", "request", "query", "client", "app", "theme", "result", "back", "home", "input", "typed"]);

// widgetClasses: the theme classes the app's own widgets read (cli.ts finds them in its Go files); source: the spec's text, for the comments agents read
export function check(spec: Spec, opts: { widgetClasses?: string[]; source?: string } = {}): Finding[] {
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
  // where a finding is: a line, or a position (line and column) when the checker has one
  const at = (p: number | Pos | undefined): { line: number; col?: number } => (typeof p === "number" ? { line: p } : p ? { line: p.line, col: p.col } : { line: 0 });
  const err = (code: string, p: number | Pos | undefined, message: string) => out.push({ severity: "error", code, where, message, ...at(p) });
  const warn = (code: string, p: number | Pos | undefined, message: string) => out.push({ severity: "warning", code, where, message, ...at(p) });

  // Duplicate names in the same namespace.
  const seen = new Map<string, number>();
  for (const d of spec.decls) {
    if (["trigger", "workflow", "permission"].includes(d.kind)) continue;
    const ns = ["action", "view"].includes(d.kind) ? "callable" : d.kind;
    const key = `${ns}:${d.name}`;
    if (seen.has(key)) { where = d.name; err("DUPLICATE", d.pos, `${d.name} is declared twice`); }
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
  const fieldOf = (e: string, f: string, line: number | Pos): T => {
    if (["id", "created", "updated"].includes(f)) return f === "id" ? S("Int") : S("Time");
    const ent = entities.get(e);
    if (!ent) return ANY;
    const fd = ent.fields.find((x: any) => x.name === f);
    if (!fd) { err("UNKNOWN_FIELD", line, `${e} has no field ${f}${didYouMean(f, ["id", "created", "updated", ...ent.fields.map((x: any) => x.name)])}`); return ANY; }
    return typeOf(fd.type);
  };

  type Scope = { vars: Map<string, T>; row?: string; orderRow?: string; inWorkflow?: boolean; inView?: boolean; ui?: boolean; noPrivate?: string; input?: string[] };
  const withRow = (sc: Scope, row: string): Scope => ({ ...sc, row });
  const child = (sc: Scope): Scope => ({ ...sc, vars: new Map(sc.vars) });

  function expr(e: Expr | undefined, sc: Scope): T {
    if (!e) return ANY;
    switch (e.kind) {
      case "lit": return e.value === null ? { k: "none" } : S(typeof e.value === "string" ? "Text" : typeof e.value === "number" ? "Int" : "Bool");
      case "duration": return S("Duration");
      case "interp": for (const p of e.parts) expr(p, sc); return S("Text");   // text with {…} in it
      case "now": return S("Time");
      case "it": if (!sc.row) { err("IT_OUTSIDE_WHERE", e.pos, "'it' outside a where"); return ANY; } return { k: "ref", e: sc.row };
      case "rowfield": if (!sc.row) { err("ROWFIELD_OUTSIDE_WHERE", e.pos, `.${e.name} outside a where`); return ANY; } return fieldOf(sc.row, e.name, e.pos);
      case "name": {
        if (sc.vars.has(e.name)) return sc.vars.get(e.name)!;
        if (e.name === "actor") return actorEntity && entities.has(actorEntity) ? { k: "ref", e: actorEntity } : ANY;
        if (AMBIENT.has(e.name)) return ANY;
        if (enumOf.has(e.name)) return { k: "enum", e: enumOf.get(e.name)! };
        if (entities.get(e.name)?.singleton) return { k: "ref", e: e.name };
        if (["get", "write"].includes(e.name) || identities.has(e.name)) return ANY;
        // An order-by may name the row's fields bare, as v1 views do.
        if (sc.orderRow && (["created", "updated", "id"].includes(e.name) || entities.get(sc.orderRow)?.fields.some((f: any) => f.name === e.name))) return fieldOf(sc.orderRow, e.name, e.pos);
        if (entities.has(e.name)) return S("Entity");
        if (views.has(e.name) || screens.has(e.name)) return S("Reference");
        if (actions.has(e.name)) { referencedActions.add(e.name); return S("Reference"); }
        if (["null", "nil", "undefined", "NULL", "None"].includes(e.name)) { err("UNKNOWN_NAME", e.pos, `unknown name ${e.name}: crudspec writes none`); return { k: "none" }; }
        err("UNKNOWN_NAME", e.pos, `unknown name ${e.name}${didYouMean(e.name, [...sc.vars.keys(), ...AMBIENT, ...entities.keys(), ...views.keys(), ...screens.keys(), ...actions.keys(), ...enumOf.keys(), ...identities.keys(), "get", "write", "none", "not", "true", "false", "and", "or", ...(sc.orderRow ? ["created", "updated", "id", ...(entities.get(sc.orderRow)?.fields ?? []).map((f: any) => f.name)] : [])])}`); return ANY;
      }
      case "field": {
        const t = expr(e.target, sc);
        // input, in a form's reactions, is what the form sent: its action's parameters
        const known = e.target.kind === "name" && !sc.vars.has(e.target.name) ? (e.target.name === "input" ? sc.input : AMBIENT_FIELDS[e.target.name]) : undefined;
        if (known && !known.includes(e.name))
          err("UNKNOWN_FIELD", e.pos, `${e.target.name} has no field ${e.name}${didYouMean(e.name, known) || `; its fields are ${known.join(", ")}`}`);
        if (t.k === "ref" && sc.noPrivate && (entities.get(t.e) as any)?.fields.find((f: any) => f.name === e.name)?.private)
          err("PRIVATE_FIELD", e.pos, `${t.e}.${e.name} is private, so it can't go in ${sc.noPrivate}`);
        if (t.k === "ref") return fieldOf(t.e, e.name, e.pos);
        return ANY;
      }
      case "unary": expr(e.arg, sc); return e.op === "not" ? S("Bool") : ANY;
      case "binary": {
        const l = expr(e.left, sc), r = expr(e.right, sc);
        if (["==", "!="].includes(e.op) && l.k === "ref" && r.k === "ref" && l.e !== r.e) err("TYPE_MISMATCH", e.pos, `${l.e} compared with ${r.e}`);
        if (["==", "!="].includes(e.op) && l.k === "enum" && r.k === "enum" && l.e !== r.e) err("TYPE_MISMATCH", e.pos, `${l.e} compared with ${r.e}`);
        if (["==", "!="].includes(e.op) && ((l.k === "enum" && r.k === "ref") || (l.k === "ref" && r.k === "enum"))) err("TYPE_MISMATCH", e.pos, `${l.k === "enum" ? l.e : (l as any).e} compared with ${r.k === "enum" ? r.e : (r as any).e} (is a parameter hiding an enum value?)`);
        if (["+"].includes(e.op) && (l.k === "set" || r.k === "set")) return l.k === "set" ? l : r;
        return ["==", "!=", "<", "<=", ">", ">=", "in", "and", "or", "implies"].includes(e.op) ? S("Bool") : (l.k === "any" ? r : l);
      }
      case "if": expr(e.cond, sc); { const a = expr(e.then, sc); const b = expr(e.else, sc); return a.k === "none" ? b : a; }
      case "listlit": case "setlit": { let t: T = ANY; for (const i of e.items) t = expr(i, sc); return { k: "list", of: t }; }
      case "json": for (const v of Object.values(e.fields)) expr(v as Expr, sc); return S("Json");
      case "query": case "all": case "listq": {
        if (!entities.has(e.entity)) { err("UNKNOWN_ENTITY", e.pos, `unknown entity ${e.entity}${didYouMean(e.entity, entities.keys())}`); return ANY; }
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
        if (!x) { err("UNKNOWN_EXTERN", e.pos, `unknown extern ${e.name}${didYouMean(e.name, externs.keys())}`); }
        else {
          const allowed = sc.inWorkflow || x.effect === "pure" || (sc.inView && x.effect === "fetch");
          if (!allowed) err("EXTERN_OUTSIDE_WORKFLOW", e.pos, `extern ${e.name} (effect ${x.effect}) called outside a workflow step`);
          const n = e.args.length + Object.keys(e.named).length;
          if (n !== x.params.length) err("ARITY", e.pos, `${e.name} takes ${x.params.length} arguments, given ${n}`);
        }
        for (const a of [...e.args, ...Object.values(e.named)]) expr(a as Expr, sc);
        return x?.returns ? typeOf(x.returns) : ANY;
      }
      case "call": {
        for (const a of [...e.args, ...Object.values(e.named)]) expr(a as Expr, sc);
        const n = e.args.length + Object.keys(e.named).length;
        const d = predicates.get(e.name) ?? fns.get(e.name);
        if (d) {
          if (n !== d.params.length) err("ARITY", e.pos, `${e.name} takes ${d.params.length} arguments, given ${n}`);
          return d.kind === "predicate" ? S("Bool") : typeOf(d.returns);
        }
        if (screens.has(e.name)) { checkArgs(screens.get(e.name)!, e, "screen"); return S("Screen"); }
        if (views.has(e.name)) { const vd = views.get(e.name)!; if (sc.ui && vd.noPeople) err("PEOPLE_NO_OFFERED", e.pos, `view ${e.name} says people no: only agents call it, so no screen shows it`); checkArgs(vd, e, "view"); return ANY; }
        if (spec.decls.some((x) => x.kind === "api" && x.name === e.name)) return S("Url");
        const b = BUILTINS[e.name];
        if (!b) { err("UNKNOWN_FUNCTION", e.pos, `unknown function ${e.name}${didYouMean(e.name, [...fns.keys(), ...predicates.keys(), ...Object.keys(BUILTINS), ...views.keys(), ...externs.keys(), ...screens.keys(), ...actions.keys(), ...spec.decls.filter((x) => x.kind === "api").map((x) => x.name)])}`); return ANY; }
        if (n < b[0] || n > b[1]) err("ARITY", e.pos, `${e.name} takes ${b[0] === b[1] ? b[0] : `${b[0]}–${b[1]}`} arguments, given ${n}`);
        if (e.name === "set" && e.args[0]) { const t = expr(e.args[0], sc); if (t.k === "ref") return { k: "set", e: t.e }; }
        // matches(.f, q) searches a field the entity says is searched: searchable
        if (e.name === "matches" && e.args[0]?.kind === "rowfield" && sc.row) {
          const f = entities.get(sc.row)?.fields.find((x: any) => x.name === e.args[0].name);
          if (f && !f.searchable) warn("MATCHES_UNSEARCHABLE", e.args[0].pos ?? e.pos, `matches searches ${sc.row}.${f.name}, which isn't marked searchable: mark it (${f.name}: … searchable), so the spec says it is searched`);
        }
        // url_of takes a screen or route with its arguments (url_of(home())), or a file
        if (e.name === "url_of" && e.args[0]?.kind === "name" && (screens.has(e.args[0].name) || spec.decls.some((x) => x.kind === "api" && x.name === e.args[0].name)))
          err("URL_OF_CALL", e.pos, `url_of takes ${e.args[0].name} with its arguments: url_of(${e.args[0].name}(…))`);
        // list functions take the list first; a scalar there is a mistake (first(1, l) for first(l, 1))
        if (["first", "last", "join", "chunks", "distinct", "any", "sentence"].includes(e.name) && e.args[0]) {
          const t0 = expr(e.args[0], sc);
          if (t0.k === "scalar" && !(e.name === "chunks" && t0.s === "Text")) err("BUILTIN_ARGUMENT", e.pos, `${e.name} takes a list first: ${e.name}(list${b[1] > 1 ? ", …" : ""}), given a ${t0.s}`);
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
    if (n > params.length) err("ARITY", e.pos ?? d.pos, `${what} ${d.name} takes at most ${params.length} arguments, given ${n}`);
    for (const k of Object.keys(e.named ?? {})) if (!params.some((p: any) => p.name === k)) err("UNKNOWN_ARGUMENT", e.pos ?? d.pos, `${what} ${d.name} has no parameter ${k}${didYouMean(k, params.map((p: any) => p.name))}`);
    // a link to a screen gives what its address needs: each required parameter, and each the route names
    if (what === "screen") {
      const given = new Set<string>([...params.slice(0, n).map((p: any) => p.name), ...Object.keys(e.named ?? {})]);
      const inRoute = new Set([...String(d.route ?? "").matchAll(/:(\w+)/g)].map((m) => m[1]));
      for (const p of params) if (!given.has(p.name) && (inRoute.has(p.name) || !(p.type.kind === "named" && p.type.optional)))
        err("LINK_ARGS", e.pos ?? d.pos, `a link to screen ${d.name} without its parameter ${p.name}${inRoute.has(p.name) ? ` (its address, ${d.route}, has it)` : ""}`);
    }
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
      case "rate_limit":
        expr(s.by, sc);
        if (typeof s.n === "number" && s.n < 1) err("RATE_LIMIT_NEVER", s.pos, `rate_limit ${s.n} per …: no call is ever let through; the limit is how many calls a period allows (1 or more)`);
        if (s.per?.kind === "duration" && s.per.amount <= 0) err("RATE_LIMIT_NEVER", s.pos, "rate_limit … per 0: a period is longer than nothing (per 1 min)");
        return;
      case "create": {
        const ent = entities.get(s.entity);
        if (!ent) { err("UNKNOWN_ENTITY", s.pos, `unknown entity ${s.entity}${didYouMean(s.entity, entities.keys())}`); return; }
        const given = new Set<string>();
        for (const a of s.fields) {
          given.add(a.name); expr(a.value, sc);
          if (!ent.fields.some((f: any) => f.name === a.name)) err("UNKNOWN_FIELD", a.pos ?? s.pos, `${s.entity} has no field ${a.name}${didYouMean(a.name, ent.fields.map((f: any) => f.name))}`);
        }
        for (const f of ent.fields) if (!given.has(f.name) && !f.default && !(f.type.kind === "named" && f.type.optional)) err("MISSING_FIELD", s.pos, `create ${s.entity} without required field ${f.name}`);
        if (s.as) sc.vars.set(s.as, { k: "ref", e: s.entity });
        return;
      }
      case "set": { const t = expr(s.target, sc); if (t.k === "ref") fieldOf(t.e, s.name, s.pos); expr(s.value, sc); return; }
      case "delete": expr(s.target, sc); return;
      case "deleteWhere": if (!entities.has(s.entity)) err("UNKNOWN_ENTITY", s.pos, `unknown entity ${s.entity}${didYouMean(s.entity, entities.keys())}`); else expr(s.where, withRow(sc, s.entity)); return;
      case "foreach": {
        // the loop names the row: a name that is also an enum value would mean two things in its where
        if (enumOf.has(s.bind)) err("ROW_NAME_SHADOWS", s.pos, `the loop variable ${s.bind} is also a ${enumOf.get(s.bind)} value: name the row differently (for each ${s.bind}_row in …)`);
        if (!entities.has(s.entity)) { err("UNKNOWN_ENTITY", s.pos, `unknown entity ${s.entity}${didYouMean(s.entity, entities.keys())}`); return; }
        expr(s.where, withRow(sc, s.entity));
        const c = child(sc); c.row = undefined; c.vars.set(s.bind, { k: "ref", e: s.entity }); stmts(s.body, c); return;
      }
      case "foreachList": { const t = expr(s.over, sc); const c = child(sc); c.vars.set(s.bind, t.k === "list" ? t.of : ANY); stmts(s.body, c); return; }
      case "if": expr(s.cond, sc); stmts(s.then, child(sc)); stmts(s.else, child(sc)); return;
      case "emit": emitted.add(s.event); for (const a of s.args) expr(a, sc); return;
      case "sendmail": {
        const keys = Object.keys(s.fields), allowed = ["to", "subject", "text", "unsubscribe"];
        for (const k of keys) if (!allowed.includes(k)) err("MAIL_FIELD", s.pos, `send mail has no ${k}; it takes: ${allowed.join(", ")}`);
        for (const k of ["to", "subject", "text"]) if (!keys.includes(k)) err("MAIL_FIELD", s.pos, `send mail needs ${k}`);
        if (s.fields.to) { const t = expr(s.fields.to, sc); if (t.k === "scalar" && !["Email", "Text"].includes(t.s)) err("MAIL_TO", s.pos, `send mail's to is an Email, not ${t.s}`); }
        // what a message says leaves the app: no private field in it
        for (const k of ["subject", "text", "unsubscribe"]) if (s.fields[k]) expr(s.fields[k], { ...sc, noPrivate: `send mail's ${k}` });
        return;
      }
    }
  }

  const paramScope = (ps: any[], extra: Record<string, T> = {}): Scope => {
    const vars = new Map<string, T>(Object.entries(extra));
    for (const p of ps) vars.set(p.name, typeOf(p.type));
    return { vars };
  };

  // ---- logic declarations
  // an export: rows of a view (so its requires and the rows' read permission hold), each column
  // a typed expression over the row, no private field in it, and no column twice
  function checkExport(d: any, sc: Scope) {
    const src = d.file.source;
    const v: any = src.kind === "call" ? views.get(src.name) : undefined;
    if (!v) { err("EXPORT_SOURCE", d.pos, `export ${d.name} is of a view's rows: ${d.file.format} of <view>(…)${views.size ? `; the views: ${[...views.keys()].join(", ")}` : ""}`); return; }
    if (!v.rows) { err("EXPORT_SOURCE", d.pos, `export ${d.name}: view ${v.name} gives a value, not rows`); return; }
    expr(src, sc);
    if (d.file.filename) expr(d.file.filename, sc);
    const seen = new Set<string>();
    for (const c of d.file.columns) {
      if (seen.has(c.key)) err("EXPORT_COLUMN", c.pos, `export ${d.name} has column "${c.key}" twice`);
      seen.add(c.key);
      const rs = withRow(sc, v.rows.entity);
      if (d.file.as) rs.vars = new Map([...rs.vars, [d.file.as, { k: "ref", e: v.rows.entity } as T]]);
      expr(c.value, { ...rs, noPrivate: `export ${d.name}` });
    }
    if (!d.file.columns.length) err("EXPORT_COLUMN", d.pos, `export ${d.name} has no columns`);
  }
  // a schedule: its rows' time is a Time field of the row, optionally moved by a duration, so the
  // runtime finds due rows with one query; a period's zone is a real one
  function checkSchedule(d: any) {
    if (d.every?.zone) { try { new Intl.DateTimeFormat("en", { timeZone: d.every.zone }); } catch { err("SCHEDULE_ZONE", d.pos, `schedule ${d.name}: unknown time zone "${d.every.zone}" (an IANA name, like "America/New_York")`); } }
    if (d.every?.period) { const ms = durMs(d.every.period); if (ms < 60_000) err("SCHEDULE_PERIOD", d.pos, `schedule ${d.name}: every ${d.every.period.amount} ${d.every.period.unit} is too often; the shortest period is 1 min`); }
    if (!d.entity) return;
    const ent: any = entities.get(d.entity);
    if (!ent) { err("UNKNOWN_ENTITY", d.pos, `schedule ${d.name}: unknown entity ${d.entity}${didYouMean(d.entity, entities.keys())}`); return; }
    if (d.where) expr(d.where, { vars: new Map([[d.bind, { k: "ref", e: d.entity } as T]]), row: undefined } as any);
    let a = d.at; let off = 0;
    if (a.kind === "binary" && (a.op === "+" || a.op === "-") && a.right.kind === "duration") { off = durMs(a.right) * (a.op === "-" ? -1 : 1); a = a.left; }
    const field = a.kind === "field" && a.target.kind === "name" && a.target.name === d.bind ? a.name : undefined;
    const f = field && ent.fields.find((x: any) => x.name === field);
    if (!field || !(field === "created" || field === "updated" || (f && f.type.kind === "named" && f.type.name === "Time")))
      err("SCHEDULE_AT", d.at.pos ?? d.pos, `schedule ${d.name}: at takes a Time field of ${d.bind}, optionally plus or minus a duration: at ${d.bind}.send_at, at ${d.bind}.updated + 30 day`);
    d.atField = field; d.atOffset = off;
  }
  const durMs = (x: any) => x.amount * ({ ms: 1, s: 1000, min: 60_000, h: 3_600_000, day: 86_400_000 } as Record<string, number>)[x.unit];
  // a schedule's body runs with no request: no actor, request values, cookies or rate limits
  function checkScheduledBody(d: any) {
    const bad = (x: any): void => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) return x.forEach(bad);
      const why = x.kind === "name" && (x.name === "actor" || x.name === "request") ? x.name
        : x.kind === "call" && x.name === "cookie" ? "cookie()" : x.kind === "rate_limit" ? "rate_limit" : "";
      if (why) err("SCHEDULE_CONTEXT", x.pos ?? d.pos, `schedule ${d.scheduled} runs with no request, so it can't use ${why}`);
      for (const [k, v] of Object.entries(x)) if (k !== "pos") bad(v);
    };
    bad(d.body);
    const mails = (x: any): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(mails);
      if (x.kind === "sendmail" && !x.fields.unsubscribe) err("MAIL_UNSUBSCRIBE", x.pos, `schedule ${d.scheduled} sends mail on its own, so the mail needs an unsubscribe link: send mail { …, unsubscribe: url_of(…) }`);
      for (const [k, v] of Object.entries(x)) if (k !== "pos") mails(v); };
    mails(d.body);
  }
  // an extern bound to Go: types the binding can carry, and a pinned import for a module
  const imports = by("import");
  const goType = (t: any) => t.kind === "named" ? GO_TYPES.includes(t.name) : t.kind === "list" && t.of.kind === "named" && t.of.name === "Text";
  function checkGoBinding(d: any) {
    if (d.effect === "TODO") err("GO_EFFECT", d.pos, `extern ${d.name}: choose its effect (lang/cli.ts bind leaves TODO): pure when the same arguments always give the same result and it reads and changes nothing outside the app (not the clock or randomness), fetch when it only reads from outside, otherwise a name for what it does (mail, http, …)`);
    for (const p of d.params) if (p.type.optional || !goType(p.type))
      err("GO_TYPE", p.pos ?? d.pos, `extern ${d.name}: parameter ${p.name} can't be passed to Go; the types a binding takes: ${GO_TYPES.join(", ")}, list of Text (not optional)`);
    if (d.returns && !goType(d.returns)) err("GO_TYPE", d.pos, `extern ${d.name}: its result can't come from Go; the types: ${GO_TYPES.join(", ")}, list of Text, optionally ?`);
    const pkg: string | undefined = d.go.pkg;
    if (pkg && pkg.split("/")[0].includes(".") && ![...imports.values()].some((i: any) => pkg === i.module || pkg.startsWith(i.module + "/")))
      err("GO_IMPORT", d.pos, `extern ${d.name} binds to "${pkg}", which isn't the standard library: add import go "<module>@<version>"`);
  }
  // every type written is one there is: a value type, or a declared entity, data shape or enum
  // (an extern's result names the shape its Go function returns, which the spec doesn't declare)
  const typeNames = [...SCALAR_TYPES, ...entities.keys(), ...enums.keys()];
  const typeRef = (t: any, d: any): void => {
    if (t.kind === "list") return typeRef(t.of, d);
    const n = t.kind === "set" ? t.of : t.name;
    if (t.kind === "set" ? !entities.has(n) : !typeNames.includes(n))
      err("UNKNOWN_TYPE", t.pos ?? d.pos, `unknown type ${n}${OTHER_TYPES[n] ? `; did you mean ${OTHER_TYPES[n]}? (crudspec's name for it${OTHER_TYPES[n] === "Int" && /float|double|decimal/i.test(n) ? "; there are no fractions: count in cents" : ""})` : ""}` + (OTHER_TYPES[n] ? "" : `${didYouMean(n, t.kind === "set" ? entities.keys() : typeNames) || (t.kind === "set" ? "; a set is of an entity" : `; the value types are ${SCALAR_TYPES.join(", ")}`)}`));
  };
  const typesIn = (x: any, d: any): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach((y) => typesIn(y, d));
    for (const [k, v] of Object.entries(x) as [string, any][]) {
      // an extern's result: any shape's name, but one a letter or two from a type there is is a slip
      if (k === "returns" && d.kind === "extern") {
        const n = v?.kind === "named" ? v.name : undefined;
        if (n && !typeNames.includes(n) && didYouMean(n, typeNames)) err("UNKNOWN_TYPE", v.pos ?? d.pos, `unknown type ${n}${didYouMean(n, typeNames)} (an extern's result may name its Go shape, but not one this close to a type)`);
        continue;
      }
      if ((k === "type" || k === "returns") && v && typeof v === "object" && (v.kind === "list" || v.kind === "set" || (v.kind === "named" && "optional" in v))) typeRef(v, d);
      else if (k !== "pos") typesIn(v, d);
    }
  };
  for (const d of spec.decls) if (!(d as any).native) { where = `${d.kind} ${d.name}`; typesIn(d, d); }
  // a size (max, min) is text's: on another type it means nothing; and one nothing fits is a slip
  function sizeCheck(f: any, what: string) {
    if (f.max === undefined && f.min === undefined) return;
    const t = f.type?.kind === "named" ? f.type.name : f.type?.kind;
    if (!["Text", "Email", "Url", "Ip", "Password", "RichText"].includes(t)) { err("SIZE_NOT_TEXT", f.pos, `${what} is ${t}: max and min size text (characters), and mean nothing here${t === "Int" ? "; a number's range is checked with require (require n <= 100 else invalid)" : ""}`); return; }
    if (f.max !== undefined && f.max < 1) err("SIZE_IMPOSSIBLE", f.pos, `${what} max ${f.max}: no text but the empty one fits`);
    if (f.max !== undefined && f.min !== undefined && f.min > f.max) err("SIZE_IMPOSSIBLE", f.pos, `${what} min ${f.min} max ${f.max}: no text is both`);
  }
  for (const d of spec.decls) {
    where = `${d.kind} ${d.name}`;
    switch (d.kind) {
      case "extern": if (d.go) checkGoBinding(d); break;
      case "schedule": checkSchedule(d); break;
      case "entity": case "data":
        for (const f of d.fields) sizeCheck(f, `${d.name}.${f.name}`);
        // every stored field has columns of its own: a collection is rows of an entity, not JSON
        if (d.kind === "entity") for (const f of d.fields) if (f.type.kind === "set" || f.type.kind === "list")
          err("STORED_COLLECTION", f.pos ?? d.pos, `${d.name}.${f.name} is a ${f.type.kind} of ${f.type.of?.name ?? f.type.of}; a stored field holds one value. Keep the collection as rows: an entity with a reference to ${d.name} (and one to each member), or a view over them`);
        for (const f of d.fields) if (f.default) expr(f.default, { vars: new Map(), row: d.name });
        // a data shape's rows: each names its fields, and has the ones that have no default
        if (d.kind === "data") for (const row of d.rows ?? []) {
          const given = new Set<string>();
          for (const a of row) {
            if (!d.fields.some((f: any) => f.name === a.name)) err("UNKNOWN_FIELD", a.pos, `${d.name} has no field ${a.name}${didYouMean(a.name, d.fields.map((f: any) => f.name))}`);
            else if (given.has(a.name)) err("DUPLICATE_FIELD", a.pos, `${a.name} is given twice`);
            given.add(a.name);
            expr(a.value, { vars: new Map() });
          }
          for (const f of d.fields) if (!given.has(f.name) && !f.default && !(f.type.kind === "named" && f.type.optional))
            err("MISSING_FIELD", row[0]?.pos ?? d.pos, `a ${d.name} row without its required field ${f.name}`);
        }
        for (const inv of d.invariants) expr(inv, { vars: new Map([["self", { k: "ref", e: d.name } as T]]), row: d.name });
        for (const u of d.uniques) for (const c of u) if (!d.fields.some((f: any) => f.name === c)) err("UNKNOWN_FIELD", d.pos, `unique on unknown field ${c}${didYouMean(c, d.fields.map((f: any) => f.name))}`);
        if (d.was && entities.has(d.was)) err("WAS_CONFLICT", d.pos, `${d.name} was ${d.was}, but ${d.was} is still declared`);
        for (const f of d.fields) if (f.was && d.fields.some((g: any) => g.name === f.was)) err("WAS_CONFLICT", f.pos, `${d.name}.${f.name} was ${f.was}, but ${f.was} is still a field`);
        break;
      case "migration": {
        // a data migration changes rows as written: no events, no externs
        stmts(d.body, paramScope([]));
        const walk = (x: any): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk);
          if (x.kind === "sendmail") err("MIGRATION_EFFECT", x.pos ?? d.pos, `migration "${d.name}" can't send mail`);
          if (x.kind === "emit" || x.kind === "extern") err("MIGRATION_EFFECT", x.pos ?? d.pos, `migration "${d.name}" can't ${x.kind === "emit" ? "emit events" : "call externs"}`);
          for (const v of Object.values(x)) walk(v); };
        walk(d.body);
        break;
      }
      case "enum":
        for (const [v, old] of Object.entries(d.renames ?? {})) if (d.values.includes(old)) err("WAS_CONFLICT", d.pos, `${d.name}: ${v} was ${old}, but ${old} is still a value`);
        break;
      case "drop": {
        const ent = entities.get(d.entity);
        if (!d.field && ent) err("DROP_DECLARED", d.pos, `drop entity ${d.entity}, but ${d.entity} is still declared`);
        if (d.field && ent?.fields.some((f: any) => f.name === d.field)) err("DROP_DECLARED", d.pos, `drop ${d.entity}.${d.field}, but the field is still declared`);
        break;
      }
      case "predicate": case "fn": expr(d.body, paramScope(d.params)); break;
      case "gate": expr(d.cond, { vars: new Map() }); break;
      case "permission": if (!entities.has(d.entity)) err("UNKNOWN_ENTITY", d.pos, `unknown entity ${d.entity}${didYouMean(d.entity, entities.keys())}`); else expr(d.cond, paramScope([], { [snake(d.entity)]: { k: "ref", e: d.entity } })); break;
      case "action":
        for (const q of d.params) sizeCheck(q, `${d.name}'s ${q.name}`);
        if ((d as any).scheduled) checkScheduledBody(d);
        for (const g of d.skips) if (!gates.has(g)) err("UNKNOWN_GATE", d.pos, `skip of unknown gate ${g}${didYouMean(g, gates.keys())}`);
        stmts(d.body, paramScope(d.params));
        break;
      case "trigger": {
        const vars: Record<string, T> = {};
        if (d.on.kind !== "event") { if (!entities.has(d.on.entity)) err("UNKNOWN_ENTITY", d.pos, `trigger on unknown entity ${d.on.entity}${didYouMean(d.on.entity, entities.keys())}`); vars[d.bind] = { k: "ref", e: d.on.entity }; vars.old = { k: "ref", e: d.on.entity }; }
        const sc = paramScope([], vars); expr(d.when, sc); stmts(d.body, sc); break;
      }
      case "workflow": for (const st of d.steps) stmts(st.body, { ...paramScope([], { [d.bind]: ANY }), inWorkflow: true }); break;
      case "view": {
        const sc: Scope = { ...paramScope(d.params), inView: true };
        for (const r of d.requires) expr(r.cond, sc);
        if (d.value) expr(d.value, sc);
        if (d.rows) {
          if (!entities.has(d.rows.entity)) err("UNKNOWN_ENTITY", d.pos, `unknown entity ${d.rows.entity}${didYouMean(d.rows.entity, entities.keys())}`);
          else { expr(d.rows.where, withRow(sc, d.rows.entity)); expr(d.rows.order ?? d.order, { ...withRow(sc, d.rows.entity), orderRow: d.rows.entity }); expr(d.rows.limit, sc); if (!permissions.has(d.rows.entity)) err("VIEW_WITHOUT_PERMISSION", d.pos, `${d.name} returns ${d.rows.entity} rows, which have no read permission`); }
        }
        expr(d.limit, sc); expr(d.window?.unless, sc); expr(d.around?.at, sc);
        if (d.window && d.window.size < 1) err("WINDOW_EMPTY", d.pos, `window ${d.window.size} ${d.window.end}: the view shows no rows; a window is how many it shows (1 or more)`);
        if (d.around && d.around.size < 1) err("WINDOW_EMPTY", d.pos, `around … ${d.around.size}: the view shows no rows around it`);
        break;
      }
      case "channel": {
        const sc = paramScope(d.params); expr(d.requires, sc);
        for (const key of ["open", "close"]) if (d[key]) targetAction(d[key], sc);
        if (d.every) targetAction(d.every.target, sc);
        break;
      }
      case "signal": {
        const sc = paramScope(d.params); expr(d.to, sc); expr(d.requires, sc);
        // the compiler checks a signal but doesn't build it yet: say so, rather than let the spec
        // look as if it works
        warn("SIGNAL_NOT_SENT", d.pos, `signal ${d.name} is checked, but the compiled app doesn't send signals yet: <Signal ${d.name}(…)> shows nothing, and no page hears it`);
        // what it carries is named by type: carries { user_id: Int, name: Text }
        const typeNames = [...SCALAR_TYPES, ...entities.keys(), ...enums.keys()];
        for (const v of Object.values(d.carries?.fields ?? {}) as any[])
          if (v.kind === "name" && !typeNames.includes(v.name)) err("UNKNOWN_TYPE", v.pos ?? d.pos, `unknown type ${v.name}${didYouMean(v.name, typeNames) || `; the value types are ${SCALAR_TYPES.join(", ")}`}`);
        break;
      }
      case "identity": {
        const ent = entities.get(d.entity);
        if (!ent) { err("UNKNOWN_ENTITY", d.pos, `identity ${d.name}: unknown entity ${d.entity}${didYouMean(d.entity, entities.keys())}`); break; }
        if (d.field) fieldOf(d.entity, d.field, d.pos);
        // a key's format names the fields it joins: "{id}-{bot_token}"
        if (d.format?.kind === "lit") for (const m of String(d.format.value).matchAll(/\{(\w+)\}/g)) fieldOf(d.entity, m[1], d.format.pos ?? d.pos);
        expr(d.where, withRow(paramScope([]), d.entity));
        break;
      }
      case "api":
        for (const r of d.routes) {
          // path parameters take the types of the target's parameters with the same names
          const target = actions.get(r.target.name) ?? views.get(r.target.name);
          const pathNames = [...`${d.route}/${r.path}`.matchAll(/:(\w+)/g)].map((m) => m[1]);
          const sc = paramScope([], Object.fromEntries(pathNames.map((n) => { const p = target?.params.find((x: any) => x.name === n); return [n, p ? typeOf(p.type) : ANY]; })));
          if (actions.has(r.target.name)) targetAction(r.target, sc);
          else if (views.has(r.target.name)) { for (const a of [...r.target.args, ...Object.values(r.target.named)]) expr(a as Expr, sc); checkArgs(views.get(r.target.name)!, r.target, "view"); }
          else err("UNKNOWN_TARGET", r.pos, `api route calls unknown action or view ${r.target.name}${didYouMean(r.target.name, [...actions.keys(), ...views.keys()])}`);
          if (target?.noPeople) err("PEOPLE_NO_OFFERED", r.pos, `${r.target.name} says people no: only agents call it, so no API route offers it`);
          if (r.json && !fns.has(r.json)) err("UNKNOWN_FUNCTION", r.pos, `unknown JSON shape ${r.json}${didYouMean(r.json, fns.keys())}`);
          if (r.location) expr(r.location, sc);
          if (r.headers) expr(r.headers, sc);
        }
        break;
    }
  }
  for (const w of spec.decls.filter((d) => d.kind === "workflow")) if (!emitted.has(w.event)) { where = w.name; warn("WORKFLOW_NEVER_RUNS", w.pos, `nothing emits ${w.event}`); }

  function targetAction(t: any, sc: Scope): Decl | undefined {
    const a = actions.get(t.name);
    if (!a) { err("UNKNOWN_ACTION", t.pos?.line ?? 0, `unknown action ${t.name}${didYouMean(t.name, actions.keys())}`); return; }
    referencedActions.add(t.name);
    for (const x of [...(t.args ?? []), ...Object.values(t.named ?? {})]) expr(x as Expr, sc);
    checkArgs(a, t, "action");
    return a;
  }

  // ---- UI
  function ui(els: El[], sc: Scope, form?: { action: Decl; given: Set<string> }) {
    const usc = sc.ui ? sc : { ...sc, ui: true };   // what a screen shows: a person sees it
    for (const el of els) uiEl(el, usc, form);
  }
  function uiEl(el: El, sc: Scope, form?: { action: Decl; given: Set<string> }) {
    for (const [k, v] of Object.entries(el.attrs)) if (v !== true && k !== "as") expr(v as Expr, sc);
    const h = el.head;
    if ((el as any).plain) {
      // text that reads as code written without its braces: shown as text, not run
      const parts: Expr[] = h.kind === "interp" ? h.parts : [h];
      const first = parts[0]?.kind === "lit" ? String(parts[0].value) : "";
      if (/^\s*(let \w+ =|for each \w+ in )/.test(first) || (/^\s*(if|match) \S/.test(first) && parts.length > 1))
        warn("UI_TEXT_CODE", el.pos, `"${first.trim().slice(0, 30)}…" shows as text: code among elements goes in braces, {${first.trim().split(" ")[0]} …}`);
    }
    // a block that is only a quoted string shows its quotes
    for (const block of el.name === "if" || el.name === "each" ? [el.children, el.else ?? []] : [])
      if (block.length === 1 && (block[0] as any).plain && block[0].head.kind === "lit" && /^".*"$/.test(String(block[0].head.value).trim()))
        warn("UI_TEXT_QUOTED", block[0].pos, `${String(block[0].head.value).trim()} shows with its quotes: in a block, text is written as it shows (${String(block[0].head.value).trim().slice(1, -1)}), or as {${String(block[0].head.value).trim()}}`);
    switch (el.name) {
      case "time": {
        const as = el.attrs.as as any;
        if (as && !(as.kind === "name" && ["date", "time"].includes(as.name)))
          err("UI_ATTR_VALUE", as.pos ?? el.pos, `<Time as=…> is {date} or {time}${as.kind === "name" ? `, not ${as.name}${didYouMean(as.name, ["date", "time"])}` : ""}`);
        if (h) expr(h, sc); break;
      }
      case "heading": case "text": case "strong": case "rich_text": case "image": case "icon": case "avatar": case "avatars": case "field_display": case "title":
        if (h) expr(h, sc); break;
      case "let": sc.vars.set(h.name, expr(h.value, sc)); return;
      case "if": expr(h, sc); ui(el.children, child(sc), form); if (el.else) ui(el.else, child(sc), form); return;
      case "each": { const t = expr(h.over, sc); const c = child(sc); c.vars.set(h.bind, t.k === "list" ? t.of : ANY); ui(el.children, c, form); return; }
      case "list": {
        const c = child(sc);
        let rowEntity: string | undefined;
        if (h.source.kind === "query") {
          if (!entities.has(h.source.entity)) err("UNKNOWN_ENTITY", el.pos, `unknown entity ${h.source.entity}${didYouMean(h.source.entity, entities.keys())}`);
          else { rowEntity = h.source.entity; expr(h.source.where, withRow(sc, rowEntity)); expr(h.source.order, { ...withRow(sc, rowEntity), orderRow: rowEntity }); }
        } else {
          const v = views.get(h.source.name);
          if (!v) err("UNKNOWN_VIEW", el.pos, `list of unknown view ${h.source.name}${didYouMean(h.source.name, views.keys())}`);
          else { if (v.noPeople) err("PEOPLE_NO_OFFERED", el.pos, `view ${h.source.name} says people no: only agents call it, so no screen shows it`); checkArgs(v, h.source, "view"); for (const a of [...h.source.args, ...Object.values(h.source.named)]) expr(a as Expr, sc); rowEntity = v.rows?.entity; }
        }
        if (rowEntity && !permissions.has(rowEntity)) err("SCREEN_SHOWS_UNPERMITTED", el.pos, `a list shows ${rowEntity} rows, which have no read permission`);
        c.vars.set(h.bind, rowEntity ? { k: "ref", e: rowEntity } : ANY);
        expr(h.where, c); expr(h.order, c);
        ui(el.children, c, form); return;
      }
      case "use": {
        const comp = components.get(h.name);
        if (!comp) err("UNKNOWN_COMPONENT", el.pos, `unknown component ${h.name}${didYouMean(h.name, components.keys())}`);
        else if (h.args.length !== comp.params.length) err("ARITY", el.pos, `component ${h.name} takes ${comp.params.length} arguments, given ${h.args.length}`);
        for (const a of h.args) expr(a, sc); return;
      }
      case "widget":
        if (appWidgets.has(h.name)) checkArgs(appWidgets.get(h.name), h, "widget");
        else if (!WIDGETS.has(h.name)) err("UNKNOWN_WIDGET", el.pos, `unknown widget ${h.name}${didYouMean(h.name, [...appWidgets.keys(), ...WIDGETS])}; declare it with "widget ${h.name}(…)" and implement it in the app's widget module`);
        for (const a of [...h.args, ...Object.values(h.named)]) expr(a as Expr, sc); break;
      case "channel": if (!channels.has(h.name)) err("UNKNOWN_CHANNEL", el.pos, `unknown channel ${h.name}${didYouMean(h.name, channels.keys())}`); for (const a of h.args) expr(a, sc); break;
      case "signal": if (!signals.has(h.name)) err("UNKNOWN_SIGNAL", el.pos, `unknown signal ${h.name}${didYouMean(h.name, signals.keys())}`); for (const a of h.args) expr(a, sc); break;
      case "link": case "go": {
        if (h.kind === "url") {
          expr(h.value, sc);
          // the text it starts with, as written
          const lead = (x: any): string | undefined => x?.kind === "lit" && typeof x.value === "string" ? x.value : x?.kind === "binary" && x.op === "+" ? lead(x.left) : undefined;
          const path = lead(h.value);
          if (path?.startsWith("/") && !path.startsWith("//")) {
            const ps = path.split("?")[0].split("/").filter((x) => x !== "");
            const whole = h.value.kind === "lit";
            const served = [...screens.values()].some((d) => d.route && ((r) => (whole ? r.length === ps.length : r.length >= ps.length) && ps.every((t, k) => r[k].startsWith(":") || r[k] === t || (!whole && k === ps.length - 1)))(String(d.route).split("/").filter((x) => x !== "")));
            const runtimePage = ["/_agents", "/llms.txt"].includes(path.split("?")[0]);   // the runtime serves these: no screen to link to
            if (runtimePage) { /* the runtime serves it */ }
            else if (whole && !served && !path.startsWith("/_")) err("HREF_INTERNAL", el.pos, `${el.name} href "${path}" is no screen's address`);
            else warn("HREF_INTERNAL", el.pos, `${el.name} href to ${path}… inside the app: link to the screen instead (to={screen(…)}), so the compiler checks it`);
          }
        }
        else if (!(h.bare && AMBIENT.has(h.name))) {
          const s = screens.get(h.name);
          if (!s) err("UNKNOWN_SCREEN", el.pos, `${el.name} to unknown screen ${h.name}${didYouMean(h.name, [...screens.keys(), "back", "home"])}`);
          else { checkArgs(s, h, "screen"); for (const a of [...h.args, ...Object.values(h.named)]) expr(a as Expr, sc); }
        }
        break;
      }
      case "button": {
        const a = targetAction(h, sc);
        if (a) {
          const given = new Set<string>([...a.params.slice(0, h.args.length).map((p: any) => p.name), ...Object.keys(h.named)]);
          for (const p of a.params) if (!given.has(p.name) && !(p.type.kind === "named" && p.type.optional)) err("MISSING_INPUT", el.pos, `button calls ${a.name} without its parameter ${p.name}`);
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
          for (const p of a.params) if (!given.has(p.name) && !(p.type.kind === "named" && p.type.optional)) err("MISSING_INPUT", el.pos, `form for ${a.name} has no field for its parameter ${p.name}`);
          return;
        }
        // an unknown action (its error said): still a form, whose fields aren't checked against it
        ui(el.children, child(sc), { action: { name: h.name, params: [], unknown: true } as any, given: new Set() }); return;
      }
      // plain HTML: nothing that could run script; inside a <Form>, a control's name is one of
      // the action's parameters, and fills it
      case "html": {
        const tag: string = h.tag;
        // a built-in's attribute on plain HTML: the old lowercase built-in, likely (<link to={…}>)
        const builtinAttr = Object.keys(el.attrs).find((a) => ["to", "of", "call"].includes(a) || (a === "action" && el.attrs[a] !== true && (el.attrs[a] as Expr).kind !== "lit"));
        if (builtinAttr) err("UI_HTML_BUILTIN", el.pos, `<${tag} ${builtinAttr}=…> is plain HTML, where ${builtinAttr} means nothing: ${TAG_OF[tag] ? `the built-in is <${TAG_OF[tag]}>` : "built-in elements start with a capital (<Link>, <Button>, <Form>, <List>)"}`);
        if (tag === "script") err("UI_HTML_SCRIPT", el.pos, `<script>: a page's script comes from the runtime and the app's widgets`);
        // an element and attributes HTML has (lang/std/html.crud); a tag with a hyphen is a web
        // component's, whatever it takes. A warning: HTML grows
        const known = HTML_ELEMENTS.get(tag), SVG = new Set(["svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]);
        if (!tag.includes("-") && tag !== "script" && tag !== "slot") {
          if (!known) warn("UI_HTML_UNKNOWN", el.pos, `<${tag}> is no HTML element${didYouMean(tag, HTML_ELEMENTS.keys()) || (TAG_OF[tag] ? "" : "; a web component's tag has a hyphen (<my-widget>)")}`);
          else for (const an of Object.keys(el.attrs)) {
            if (an in HTML_COMMON || an in known.attrs || /^(data|aria)-/.test(an) || /^on/i.test(an) || an === "srcdoc" || (SVG.has(tag) && an.includes("-"))) continue;
            warn("UI_HTML_ATTR_UNKNOWN", h.attrPos?.[an] ?? el.pos, `<${tag} ${an}>: HTML's <${tag}> has no attribute ${an}${REACT_ATTRS[an] ? `; did you mean ${REACT_ATTRS[an]}? (React's ${an})` : didYouMean(an, [...Object.keys(known.attrs), ...Object.keys(HTML_COMMON)])}`);
          }
        }
        if (tag === "form") warn("UI_HTML_FORM", el.pos, `a plain <form> can't run an action (the runtime signs a <Form>'s): use <Form action={…}>`);
        for (const [an, v] of Object.entries(el.attrs)) {
          const value = v === true ? undefined : (v as Expr);
          if (/^on/i.test(an)) err("UI_HTML_HANDLER", el.pos, `<${tag} ${an}>: a page's script comes from the runtime and the app's widgets, not attributes`);
          if (an === "srcdoc") err("UI_HTML_HANDLER", el.pos, `<${tag} srcdoc>: a document written into a page could run script`);
          if (an === "style" && value && value.kind !== "lit") err("UI_HTML_STYLE", el.pos, `<${tag} style={…}>: a style is written as it is; for one that varies, use class={…}`);
          if (value?.kind === "lit" && ["href", "src", "action", "formaction", "poster", "cite", "data", "srcset"].includes(an) && /^\s*(javascript|vbscript|data):/i.test(String(value.value)) && !(an === "src" && tag === "img" && /^\s*data:image\/(?!svg)/i.test(String(value.value))))
            err("UI_HTML_URL", el.pos, `<${tag} ${an}="${String(value.value).slice(0, 20)}…">: only relative, http(s), mailto and tel addresses (and data: images in an <img>)`);
        }
        const nm = el.attrs.name;
        if (form && !(form.action as any).unknown && ["input", "select", "textarea"].includes(tag) && nm && nm !== true && (nm as Expr).kind === "lit") {
          const n = String((nm as Expr).value);
          if (!form.action.params.some((p: any) => p.name === n)) err("FIELD_NOT_A_PARAMETER", el.pos, `${form.action.name} has no parameter ${n}`);
          else form.given.add(n);
        }
        break;
      }
      case "field": {
        if (!form) { err("FIELD_OUTSIDE_FORM", el.pos, `field ${h.name} outside a form`); break; }
        if ((form.action as any).unknown) break;
        const param = form.action.params.find((p: any) => p.name === h.name);
        if (!param) err("FIELD_NOT_A_PARAMETER", el.pos, `${form.action.name} has no parameter ${h.name}`);
        else {
          // the field's kind must fit the parameter's type
          const isSetParam = param.type.kind === "set";
          const isRowParam = param.type.kind === "named" && entities.has(param.type.name);
          if (h.kind === "users" && !isSetParam) err("FIELD_KIND_MISMATCH", el.pos, `field ${h.name} is a multi-select (users), but ${form.action.name}.${h.name} is not a set`);
          if (isSetParam && h.kind !== "users" && h.kind !== "hidden") err("FIELD_KIND_MISMATCH", el.pos, `${form.action.name}.${h.name} is a set; use a users field`);
          if (h.kind === "select" && !isRowParam) err("FIELD_KIND_MISMATCH", el.pos, `field ${h.name} is a select, but ${form.action.name}.${h.name} is not a row`);
          const isChoiceParam = param.type.kind === "named" && (enums.has(param.type.name) || param.type.name === "Bool");
          if (h.kind === "choice" && !isChoiceParam) err("FIELD_KIND_MISMATCH", el.pos, `field ${h.name} is a choice, but ${form.action.name}.${h.name} is neither an enum nor a Bool`);
          if (h.kind === "choice" && !el.attrs.from) err("FIELD_WITHOUT_CHOICES", el.pos, `field ${h.name} needs from [values]`);
          if ((h.kind === "datetime" || h.kind === "date") && !(param.type.kind === "named" && param.type.name === "Time")) err("FIELD_KIND_MISMATCH", el.pos, `field ${h.name} is a ${h.kind}, but ${form.action.name}.${h.name} is not a Time`);
          if (h.kind === "checkbox" && !(param.type.kind === "named" && param.type.name === "Bool")) err("FIELD_KIND_MISMATCH", el.pos, `field ${h.name} is a checkbox, but ${form.action.name}.${h.name} is not a Bool`);
          if (h.kind === "number" && !(param.type.kind === "named" && param.type.name === "Int")) err("FIELD_KIND_MISMATCH", el.pos, `field ${h.name} is a number, but ${form.action.name}.${h.name} is not an Int`);
          if ((h.kind === "users" || h.kind === "select") && !el.attrs.from && !el.attrs.autocomplete) err("FIELD_WITHOUT_CHOICES", el.pos, `field ${h.name} needs from or autocomplete`);
        }
        form.given.add(h.name);
        break;
      }
      case "on": if (form && !(form.action as any).unknown) sc = { ...sc, input: form.action.params.map((p: any) => p.name) }; for (const r of h.reactions) { if (r.kind === "go") uiEl({ kind: "el", name: "go", head: r.target, attrs: {}, children: [], pos: el.pos }, sc, form); else if (r.value) expr(r.value, { ...sc, vars: new Map([...sc.vars, ["result", ANY]]) }); } break;
      case "slot": break;
    }
    if (el.children.length && !["form", "if", "each", "list"].includes(el.name)) ui(el.children, sc, form);
  }

  for (const d of spec.decls) {
    where = `${d.kind} ${d.name}`;
    if (d.kind === "component") ui(d.body, paramScope(d.params));
    if (d.kind === "layout") {
      ui(d.body, { vars: new Map() });
      // the page's shell is the runtime's (nav, flash, main, footer, sidebar): a layout only names
      // its slots, so anything else in it isn't rendered
      const shell = new Set(["slot", "nav", "main", "footer", "aside", "sidebar", "title", "flash"]);
      const stray = (els: El[]): El[] => els.flatMap((x) => (shell.has(x.name) ? stray(x.children ?? []) : [x]));
      for (const x of stray(d.body)) {
        if (slotLike(x)) { err("UI_HTML_SLOT", x.pos, `layout ${d.name}: <${x.head.tag}> is plain HTML: the layout's ${x.head.tag} is <${TAG_OF[x.head.tag]}>`); continue; }
        warn("LAYOUT_NOT_RENDERED", x.pos, `layout ${d.name}: <${x.name === "html" ? x.head.tag : TAG_OF[x.name] ?? x.name}> isn't rendered: the page shell has only Nav, Flash, Main, Footer and Sidebar slots; put it in a screen's <Footer> or <Nav>, or a component the screens use`);
      }
    }
    if (d.kind === "screen" && (d as any).file) { checkExport(d as any, paramScope(d.params)); continue; }
    if (d.kind === "screen") {
      if (!layouts.has(d.layout)) err("UNKNOWN_LAYOUT", d.pos, `unknown layout ${d.layout}${didYouMean(d.layout, layouts.keys())}`);
      const sc = paramScope(d.params);
      for (const r of d.requires) { expr(r.cond, sc); if (r.go) uiEl({ kind: "el", name: "go", head: r.go, attrs: {}, children: [], pos: r.pos }, sc); if (r.flash) expr(r.flash, sc); }
      // a screen's parts fill the layout's slots: plain HTML there fills none
      const top = (els: El[]): El[] => els.flatMap((x) => (["if", "each", "let"].includes(x.name) ? top([...(x.children ?? []), ...(x.else ?? [])]) : [x]));
      for (const x of top(d.body)) if (x.name === "html")
        err("UI_HTML_SLOT", x.pos, slotLike(x) ? `<${x.head.tag}> is plain HTML, which fills no slot: write <${TAG_OF[x.head.tag]}> to fill the layout's ${x.head.tag}` : `<${x.head.tag}> fills no slot: a screen's parts are <Main>, <Nav>, <Footer>, <Sidebar> and <Title>, with the HTML inside them`);
      ui(d.body, sc);
    }
    if (d.kind === "theme") {
      for (const v of Object.values(d.props)) expr(v as Expr, { vars: new Map() });
      const cl: any = d.props.classes;
      if (cl && cl.kind !== "json") err("THEME_CLASSES", d.pos, "classes takes { kind: \"class\", … }");
      for (const k of Object.keys(cl?.fields ?? {})) if (!THEME_CLASSES.has(k) && !(opts.widgetClasses ?? []).includes(k))
        warn("THEME_CLASS_UNKNOWN", d.pos, `nothing reads the theme class ${k}: the runtime reads ${[...THEME_CLASSES].join(", ")}, and the app's widgets read ${(opts.widgetClasses ?? []).join(", ") || "none"}`);
    }
    if (d.kind === "invariant") {
      expr(d.cond, { vars: new Map() });
      // a fact about the data: it reads stored data only, never who asks, the request or the
      // time, in itself or in a function or predicate it calls
      const seen = new Set<string>(), ambient = new Set<string>();
      const walk = (x: any) => {
        if (!x || typeof x !== "object") return;
        if (Array.isArray(x)) { for (const y of x) walk(y); return; }
        if (x.kind === "now") ambient.add("now");
        if (x.kind === "name" && AMBIENT.has(x.name)) ambient.add(x.name);
        if (x.kind === "call" && !seen.has(x.name)) { seen.add(x.name); const f = spec.decls.find((g) => (g.kind === "fn" || g.kind === "predicate") && g.name === x.name); if (f) walk(f.body); }
        for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v);
      };
      walk(d.cond);
      if (ambient.size) err("INVARIANT_AMBIENT", d.pos, `invariant ${d.name} reads ${[...ambient].join(", ")}: an invariant is a fact about the stored data, true whoever asks and whenever`);
    }
    if (d.kind === "app") {
      if (actorEntity && !entities.has(actorEntity)) err("UNKNOWN_ENTITY", d.pos, `app actor ${actorEntity} is not an entity${didYouMean(actorEntity, entities.keys())}`);
      for (const k of ["sign_in", "setup"]) { const t = d.props[k]; if (t && !screens.has(t.name)) err("UNKNOWN_SCREEN", d.pos, `app ${k} names unknown screen ${t.name}${didYouMean(t.name, screens.keys())}`); }
      if (d.props.setup_when) expr(d.props.setup_when, { vars: new Map() });
      // indexes auto: the app has the indexes its queries want (lang/cost.ts); declared: only the declared ones
      const ix = d.props.indexes;
      if (ix && !(ix.kind === "name" && ["auto", "declared"].includes(ix.name))) err("APP_INDEXES", d.pos, "app indexes takes auto (the indexes the app's queries want, kept in step) or declared (only those the entities declare)");
    }
    if (d.kind === "avatar" || d.kind === "display") {
      if (!entities.has(d.entity)) err("UNKNOWN_ENTITY", d.pos, `${d.kind} for unknown entity ${d.entity}${didYouMean(d.entity, entities.keys())}`);
      else expr(d.value, { vars: new Map(), row: d.entity });
    }
  }

  // Routes: each :name in a screen's address is one of its parameters; and no screen's address is
  // one an earlier screen always takes first (the runtime tries them in the spec's order)
  const routed = [...screens.values()].filter((d) => d.route);
  const segs = (r: string) => r.split("/").filter((x) => x !== "");
  routed.forEach((d, i) => {
    where = `screen ${d.name}`;
    for (const m of String(d.route).matchAll(/:(\w+)/g)) if (!(d.params ?? []).some((p: any) => p.name === m[1])) err("ROUTE_PARAM", d.pos, `screen ${d.name}'s address ${d.route} names :${m[1]}, which isn't one of its parameters`);
    const mine = segs(d.route);
    const first = routed.slice(0, i).find((o) => { const theirs = segs(o.route); return theirs.length === mine.length && theirs.every((t, k) => t.startsWith(":") || t === mine[k]); });
    if (first) err("ROUTE_SHADOWED", d.pos, `screen ${d.name} (${d.route}) is never reached: screen ${first.name} (${first.route}), earlier, takes every address it does; put ${d.name} first, or change an address`);
  });

  // Reachability: every non-internal action is offered by a screen, the API or a channel.
  for (const a of actions.values()) {
    where = `action ${a.name}`;
    if (a.noPeople && referencedActions.has(a.name)) err("PEOPLE_NO_OFFERED", a.pos, `${a.name} says people no: only agents call it, but a screen, API route or channel offers it`);
    if (!a.internal && !a.noPeople && !referencedActions.has(a.name)) warn("ACTION_UNREACHABLE", a.pos, `no screen, API route or channel offers ${a.name}; the runtime generates /_auto/actions/${a.name} for it (cli scaffold prints it)`);
    if (a.internal && referencedActions.has(a.name) && ![...channels.values()].some((c) => [c.open, c.close, c.every?.target].some((t: any) => t?.name === a.name))) {
      warn("INTERNAL_ACTION_OFFERED", a.pos, `internal action ${a.name} is offered outside a channel`);
    }
  }

  // native components are the standard library's (lang/std/ui.crud), implemented by the compiler
  for (const d of spec.decls) if (d.kind === "native") { where = d.name; err("NATIVE_IN_APP", d.pos, `native ${d.name}: only the standard library declares native components; write a component instead`); }

  // Who may call: agents no / people no
  const agentsOn = [...identities.values()].some((d) => d.source === "token");
  for (const d of [...actions.values(), ...views.values()]) {
    where = `${d.kind} ${d.name}`;
    if (d.noAgents && d.noPeople) err("CALLERS_NONE", d.pos, `${d.name} says agents no and people no: no one could call it; make it an internal action`);
    else if (d.internal && (d.noAgents || d.noPeople)) warn("CALLERS_INTERNAL", d.pos, `${d.name} is internal: neither agents nor people call it, so ${d.noAgents ? "agents" : "people"} no says nothing`);
    else if (d.noPeople && !agentsOn) err("PEOPLE_NO_WITHOUT_AGENTS", d.pos, `${d.name} says people no, but the app has no agent identity (identity … from token), so no one could call it`);
  }
  // Agents: an app with token access says what each callable is for, and lets people find /_agents.
  if (agentsOn) {
    const withheld = describe(spec).withheld;
    for (const w of withheld) if (!w.stated) {
      const d = actions.get(w.name)!; where = `action ${w.name}`;
      warn("AGENTS_NO_UNSTATED", d.pos, `${w.name} ${w.why}, so agents can't call it; say agents no at the top of its body, so the spec shows it`);
    }
    if (opts.source !== undefined) {
      const lines = opts.source.split("\n");
      const documented = (d: Decl) => /^\s*\/\//.test(lines[d.pos.line - 2] ?? "");
      const hidden = new Set(withheld.map((w) => w.name));
      const bare = [...actions.values(), ...views.values()].filter((d) => !d.internal && !hidden.has(d.name) && !documented(d));
      where = "agents";
      if (bare.length) warn("AGENT_UNDOCUMENTED", bare[0].pos, `${bare.length} of the actions and views agents can call have no comment above them saying what they're for, which agents read as the description: ${bare.slice(0, 8).map((d) => d.name).join(", ")}${bare.length > 8 ? ", …" : ""}`);
    }
    const ui = JSON.stringify([...screens.values(), ...layouts.values(), ...components.values()]);
    where = "agents";
    if (!ui.includes('"/_agents"')) warn("AGENT_PAGE_UNLINKED", identities.get([...identities.values()].find((d) => d.source === "token")!.name)!.pos.line, `no screen links to /_agents, where people issue agent tokens; link it from an account or profile screen with <Link href="/_agents" label="…" />`);
  }
  // declarations nothing names: dead, or a use missing. Counted in the source without its
  // comments and strings; words in markup text count, so they can hide one, never report a used one
  if (opts.source !== undefined) {
    const code = opts.source.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/(^|[ \t])\/\/[^\n]*/g, "$1");
    const uses = new Map<string, number>();
    for (const m of code.matchAll(/[A-Za-z_]\w*/g)) uses.set(m[0], (uses.get(m[0]) ?? 0) + 1);
    const UNUSED_KINDS: Record<string, string> = { fn: "function", predicate: "predicate", component: "component", layout: "layout", widget: "widget", enum: "enum", data: "data shape", extern: "extern" };
    for (const d of spec.decls) if (UNUSED_KINDS[d.kind] && d.pos.line > 0 && !(d as any).std && (uses.get(d.name) ?? 0) <= 1) {
      where = `${d.kind} ${d.name}`;
      warn("DECL_UNUSED", d.pos, `${UNUSED_KINDS[d.kind]} ${d.name} is used nowhere: remove it, or use it where it was meant`);
    }
  }
  return out;
}

function snake(s: string): string { return s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(); }

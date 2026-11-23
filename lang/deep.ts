// Deep checks: what the spec's connections imply, beyond names and types. Run by
// `node lang/cli.ts check <spec> --deep` (after the type pass) and by `cli build`. Every finding
// is a warning (a likely mistake, or a choice worth stating), except those marked (an error).
//   ENUM_VALUE_UNREACHABLE  an enum field can never hold a value: no default, create, set or
//                           migration gives it, or every transition into it starts from a value
//                           the field can never hold (transitions are read from the requires
//                           and ifs that guard each set)
//   WRITE_UNCHECKED         an action changes or deletes a row the caller chooses, and nothing
//                           before the write checks the actor
//   ADMIN_ESCALATION        (an error) an action sets, or gives the caller's value to, a field the app's admin condition reads, without requiring an
//                           administrator first: only administrators make administrators
//   TRANSITION_UNPROVEN     (an error) a set to a state that the entity's transitions block does not allow from some state
//                           the set's guards leave open: require the state first, or declare the move
//   TRANSITION_NONE        (an error) a set of a field with transitions to none: none is no state
//   TRANSITION_DYNAMIC      a set to a value the check cannot read; the app refuses an undeclared move at run time
//   TRANSITION_UNUSED       a declared move no action makes
//   UNREACHABLE             a statement after reject, which ends the body: it never runs
//   SAME_SIDES              ==, !=, and or or with the same thing on both sides: always the same
//   SET_SELF                a field set to itself (set x.f = x.f): it changes nothing
//   SAME_BRANCHES           an if whose two branches are the same: its condition decides nothing
//   REQUIRE_CONSTANT        require true (checks nothing) or require false (always refuses)
//   GUARD_MISSING           an action leaves out a check on who acts that every other action
//                           doing the same to a row of that entity (three or more) makes, or
//                           on the row, every other action given one that writes (four or more)
//   SIGNED_OUT_UNLIMITED    an action open to signed-out callers writes, with no rate limit
//   SIGN_IN_BY_ADDRESS_ONLY a password check whose rate limits are all by request.ip: guesses from many addresses at one account
//   ROWS_UNRELATED          an action takes two rows inside the same container (a policy for rows in it) and never relates them
//   BLOCK_SELF_LIFT         an action lets the actor delete their own row of an entity whose rows restrict someone (not exists(E …))
//   TRIGGER_CYCLE           triggers that can set each other off, round and round
//   DELETE_RESTRICTED       a delete that a restricting reference can refuse, with no check first (a reference
//                           to the row, or to a row the delete cascades to)
//   LINK_NOT_UNIQUE         a row that only links two others, with no unique key over the pair
//   PATHS_DISAGREE          a field of a row and the same field of a row it requires, with no invariant that they agree
//   INVARIANT_SCANS         an entity invariant the app would check on every row of its entity after a write
//   PARENT_HIDDEN           a row whose policy admits rows whose required parent the parent's policy hides
//   UNIQUE_UNGUARDED        a create of a uniquely keyed row from the caller's values, with no
//                           `ensure` and no check for an existing row first
//   THE_NOT_UNIQUE          `the()` or `the_or_none()` query whose condition doesn't guarantee
//                           a unique key match: can fail at runtime with more than one row
//   FIELD_NEVER_READ        a field is written in creates/sets but never read in any expression
//   FIELD_READ_NEVER_SET    a field is read, but nothing sets it: it always holds its default, or none
//   FIELD_NEVER_WRITTEN     a field nothing reads or sets
//   WRITE_ONLY_READ         (an error) a field declared write_only is read somewhere: remove write_only, or the read
//   WORKFLOW_STALE_CHECK    a workflow step acts on a row whose field the emitting action set, without
//                           reading it again, though another body can change it meanwhile
//   LINK_NOT_ALLOWED        a link to a screen whose require on the viewer isn't known where the link is
//   SCREEN_UNREACHABLE      a screen no chain of links reaches from home, sign-in, setup, or mail and the like
//   OUTCOME_UNHANDLED       a form or button handles some outcomes with <on>, but not one that what
//                           is entered can bring about (a require on a field, a unique key unchecked)
import type { Decl, Expr, Spec, Stmt } from "./parser.ts";
import { facts, fieldUse, nodes, triggerLoops } from "./facts.ts";
import { impliesIn, substName } from "./rules.ts";
import { invariantDeps, scansAll } from "./invariant-deps.ts";

// an entity's invariants that say two of its paths are the same row (self.wiki == self.page.wiki):
// in e, about the row named row, the longer path is written as the shorter one
function sameVia(d: any, row: string, e: Expr): Expr {
  const strip = (x: any): string => JSON.stringify(x, (k, v) => (k === "pos" ? undefined : v));
  const chain = (x: any): boolean => x?.kind === "name" ? x.name === "self" : x?.kind === "field" && chain(x.target);
  const asRow = (x: any): any => x.kind === "name" ? { kind: "name", name: row } : { kind: "field", target: asRow(x.target), name: x.name };
  let out = e;
  for (const inv of d.invariants ?? []) {
    if (inv?.kind !== "binary" || inv.op !== "==" || !chain(inv.left) || !chain(inv.right)) continue;
    const [a, b] = [asRow(inv.left), asRow(inv.right)];
    const [long, short] = strip(a).length >= strip(b).length ? [a, b] : [b, a];
    const from = strip(long), to = short;
    const walk = (x: any): any => {
      if (!x || typeof x !== "object") return x;
      if (Array.isArray(x)) return x.map(walk);
      if (strip(x) === from) return { ...to, pos: x.pos };
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "pos" ? v : walk(v)]));
    };
    out = walk(out);
  }
  return out;
}

export type DeepFinding = { severity: "warning" | "error"; code: string; line: number; message: string };

// every form and button that calls an action, with the outcomes its <on> handlers take: a form's
// are its children, a button's the <on>s right after it (as the generator reads them)
export type CallSite = { action: string; where: string; line: number; handled: Set<string>; bound: Set<string> };
export function callSites(spec: Spec): CallSite[] {
  const out: CallSite[] = [];
  const walk = (els: any[], where: string) => {
    if (!Array.isArray(els)) return;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!el || typeof el !== "object") continue;
      if ((el.name === "form" || el.name === "button") && (el.head?.kind === "call" || el.head?.kind === "ref")) {
        const hs: any[] = el.name === "form" ? (el.children ?? []).filter((c: any) => c?.name === "on") : [];
        if (el.name === "button") for (let j = i + 1; els[j]?.name === "on"; j++) hs.push(els[j]);
        // the parameters the call gives (in order, or by name): the rest are the form's fields
        const act = spec.decls.find((x) => x.kind === "action" && x.name === el.head.name);
        const bound = new Set<string>([...(act?.params ?? []).slice(0, el.head.args?.length ?? 0).map((p: any) => p.name), ...Object.keys(el.head.named ?? {})]);
        out.push({ action: el.head.name, where: `${where} (line ${el.pos.line})`, line: el.pos.line, handled: new Set(hs.map((h) => h.head?.outcome)), bound });
      }
      walk(el.children, where); walk(el.else, where);
    }
  };
  for (const d of spec.decls) if (d.kind === "screen" || d.kind === "component" || d.kind === "layout") walk(d.body, `${d.kind} ${d.name}`);
  return out;
}
// the outcomes a call site's fields can bring about: a require or reject that depends on what the
// person entered, and invalid from a create or set that puts it in a unique key with no check for
// an existing row first (as UNIQUE_UNGUARDED). Outcomes about the row or who acts come from the
// screen's context, which shows the form only where it applies; sizes are kept by the form itself;
// a gate's apply to every action alike
const LOOKS = new Set(["count", "exists", "listq", "query"]);
export function inputOutcomes(spec: Spec, d: Decl, bound: Set<string>): string[] {
  const out = new Set<string>();
  const input = new Set<string>(d.params.map((p: any) => p.name).filter((n: string) => !bound.has(n)));
  const reads = (x: any) => nodes(x).some((n) => n.kind === "name" && input.has(n.name));
  const keyed = (en: string, f: string) => spec.decls.some((e) => e.kind === "entity" && e.name === en && (e.uniques ?? []).some((u: string[]) => u.includes(f)));
  const looked = (guards: any[]) => guards.some((g) => nodes(g).some((n) => LOOKS.has(n.kind) || (n.kind === "call" && (n.name === "exists" || n.name === "count"))));
  const walk = (ss: any[], inputGuard: boolean, guards: any[]) => {
    guards = [...guards];
    for (const x of ss ?? []) {
      if (!x || typeof x !== "object") continue;
      if (x.kind === "let" && reads(x.value)) input.add(x.name);
      if (x.kind === "require") { if (reads(x.cond)) out.add(x.outcome); guards.push(x.cond); }
      if (x.kind === "reject" && inputGuard) out.add(x.outcome);
      if (x.kind === "create" && !x.ensure && !looked(guards)) for (const f of x.fields ?? []) if (reads(f.value) && keyed(x.entity, f.name)) out.add("invalid");
      if (x.kind === "set" && reads(x.value) && !looked(guards) && spec.decls.some((e) => e.kind === "entity" && keyed(e.name, x.name))) out.add("invalid");
      if (x.kind === "if") { const g = inputGuard || reads(x.cond); walk(x.then, g, [...guards, x.cond]); walk(x.else, g, [...guards, x.cond]); }
      if (x.kind === "foreach" || x.kind === "foreachList") walk(x.body, inputGuard || reads(x.where ?? x.over), guards);
    }
  };
  walk(d.body, false, []);
  return [...out];
}

export function deepCheck(spec: Spec): DeepFinding[] {
  const found: DeepFinding[] = [];
  const warn = (code: string, line: number, message: string) => found.push({ severity: "warning", code, line, message });
  const error = (code: string, line: number, message: string) => found.push({ severity: "error", code, line, message });
  const decls = spec.decls;
  const of = (k: string) => decls.filter((d) => d.kind === k);
  const ents = new Map(decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => [d.name, d]));

  // fields declared `write_only`: the spec says nothing reads them; WRITE_ONLY_READ below verifies it
  const writeOnlyFields = new Set<string>();
  for (const [en, ent] of ents) {
    if (ent.kind === "entity") {
      for (const f of ent.fields) {
        if (f.writeOnly) {
          writeOnlyFields.add(`${en}.${f.name}`);
        }
      }
    }
  }
  const enums = new Map(of("enum").map((d) => [d.name, d.values as string[]]));
  const fnBodies = new Map([...of("fn"), ...of("predicate")].map((d) => [d.name, d.body]));
  const tname = (t: any) => (t?.kind === "named" ? t.name : undefined);
  // the bodies that write (actions, triggers, workflow steps, migrations), and the entities their
  // names and expressions hold: facts.ts
  const F = facts(spec), typed = F.typed;
  const bodies = F.bodies, entityNames = F.entityNames, entityOf = F.entityOf;
  // does a condition read the actor (directly, or through the functions and predicates it calls)?
  const readsActor = (x: any, seen = new Set<string>()): boolean => nodes(x).some((n) =>
    (n.kind === "name" && n.name === "actor") || n.kind === "actor" ||
    (n.kind === "call" && fnBodies.has(n.name) && !seen.has(n.name) && (seen.add(n.name), readsActor(fnBodies.get(n.name), seen))));
  // the statements before each statement in a body, with the conditions that guard it
  type At = { st: any; guards: Expr[] };
  const walk = (body: Stmt[], guards: Expr[] = [], out: At[] = []): At[] => {
    const gs = [...guards];
    for (const st of body as any[]) {
      out.push({ st, guards: [...gs] });
      if (st.kind === "require") gs.push(st.cond);
      if (st.kind === "if") { walk(st.then, [...gs, st.cond], out); if (st.else) walk(st.else, [...gs, { kind: "unary", op: "not", arg: st.cond } as any], out); }
      if (st.kind === "foreach" || st.kind === "foreachList") walk(st.body, [...gs, ...(st.where ? [st.where] : [])], out);
    }
    return out;
  };

  // ---- enum values a field can come to hold
  for (const [en, ent] of ents) {
    if (ent.kind !== "entity") continue;
    for (const f of ent.fields) {
      const values = enums.get(tname(f.type));
      if (!values) continue;
      const lit = (e: any): string | undefined => (e?.kind === "name" && values.includes(e.name) ? e.name : e?.kind === "lit" && values.includes(e.value) ? e.value : undefined);
      const start = new Set<string>(), edges: [string | "*", string][] = [];
      let any = false;
      if (f.default) { const v = lit(f.default); if (v) start.add(v); else any = true; }
      for (const b of bodies) {
        const names = entityNames(b);
        for (const { st, guards } of walk(b.body)) {
          if (st.kind === "create" && st.entity === en) {
            const a = st.fields.find((x: any) => x.name === f.name);
            if (a) { const v = lit(a.value); if (v) start.add(v); else any = true; }
          }
          if (st.kind === "set" && st.name === f.name && entityOf(st.target, names) === en) {
            const v = lit(st.value);
            if (!v) { any = true; continue; }
            // the values the guards allow it to come from: `x.f == v`, `x.f != v`, `x.f in [...]`
            let from: Set<string> | null = null;
            for (const g of guards) for (const n of nodes(g)) {
              if (n.kind !== "binary" || !["==", "!="].includes(n.op)) continue;
              const side = [n.left, n.right].find((s: any) => (s.kind === "field" || s.kind === "rowfield") && s.name === f.name);
              const val = lit(side === n.left ? n.right : n.left);
              if (!side || !val) continue;
              const allowed = n.op === "==" ? new Set([val]) : new Set(values.filter((x) => x !== val));
              from = from ? new Set([...from].filter((x) => allowed.has(x))) : allowed;
            }
            if (!from) edges.push(["*", v]); else for (const x of from) edges.push([x, v]);
          }
        }
      }
      if (any) continue;
      const reach = new Set(start);
      for (let changed = true; changed;) {
        changed = false;
        for (const [a, b] of edges) if ((a === "*" ? reach.size > 0 : reach.has(a)) && !reach.has(b)) { reach.add(b); changed = true; }
      }
      for (const v of values) if (!reach.has(v)) warn("ENUM_VALUE_UNREACHABLE", f.pos?.line ?? ent.pos.line, `${en}.${f.name} never holds ${v}: ${start.size ? `it starts as ${[...start].join(" or ")}` : "no create gives it a value"}${edges.some(([, b]) => b === v) ? `, and every set to ${v} is guarded by a value it never holds` : ` and nothing sets it to ${v}`}`);
    }
  }

  // ---- transitions f { a -> b }: every literal `set x.f = v` must be a declared move from every state
  // its guards leave open (TRANSITION_UNPROVEN, an error: add the require that names the state);
  // a value the check can't read is left to the app, which refuses an undeclared move at run time
  // (TRANSITION_DYNAMIC); a declared move nothing makes is dead (TRANSITION_UNUSED)
  for (const [en, ent] of ents) {
    if (ent.kind !== "entity") continue;
    for (const tr of ent.transitions ?? []) {
      const f = ent.fields.find((x: any) => x.name === tr.field);
      const values = enums.get(tname(f?.type));
      if (!f || !values) continue;
      const allowed = new Map<string, Set<string>>(tr.edges.map((e: any) => [e.from, new Set<string>(e.to)]));
      const may = (a: string, b: string) => a === b || !!allowed.get(a)?.has(b);
      const lit = (e: any): string | undefined => (e?.kind === "name" && values.includes(e.name) ? e.name : e?.kind === "lit" && values.includes(e.value) ? e.value : undefined);
      const key = (e: any) => JSON.stringify(e, (k, v) => (k === "pos" ? undefined : v));
      // the states a condition leaves open for the row: null when it says nothing the check can read
      type Row = { bind: string; entity: string };
      const open = (g: any, target: any, row: Row | null, neg = false): Set<string> | null => {
        const all = new Set(values);
        const isF = (x: any) => x?.name === f.name && ((x.kind === "field" && key(x.target) === key(target)) || (x.kind === "rowfield" && !!row && row.entity === en && target?.kind === "name" && target.name === row.bind));
        if (g?.kind === "unary" && g.op === "not") return open(g.arg, target, row, !neg);
        if (g?.kind === "binary" && (g.op === "and" || g.op === "or")) {
          const a = open(g.left, target, row, neg), b = open(g.right, target, row, neg);
          const both = (g.op === "and") !== neg;   // not (a or b) is not a and not b
          if (both) return a && b ? new Set([...a].filter((x) => b.has(x))) : a ?? b;
          return a && b ? new Set([...a, ...b]) : null;
        }
        if (g?.kind === "binary" && (g.op === "==" || g.op === "!=")) {
          const side = isF(g.left) ? g.right : isF(g.right) ? g.left : null, v = lit(side);
          if (!side || !v) return null;
          return (g.op === "==") !== neg ? new Set([v]) : new Set([...all].filter((x) => x !== v));
        }
        if (g?.kind === "binary" && g.op === "in" && isF(g.left) && ["setlit", "listlit"].includes(g.right?.kind)) {
          const vs = g.right.items.map(lit);
          if (vs.some((v: any) => !v)) return null;
          return neg ? new Set([...all].filter((x) => !vs.includes(x))) : new Set(vs);
        }
        return null;
      };
      const used = new Set<string>();
      let dynamic = false;
      // a body's statements, with the conditions that guard each, and the state the field was just set to
      const scan = (body: Stmt[], guards: { g: Expr; row: Row | null }[], line: number, start: { target: any; v: string } | null = null): void => {
        const gs = [...guards];
        let known: { target: any; v: string } | null = start;
        for (const st of body as any[]) {
          if (st.kind === "set" && st.name === f.name) {
            const names = entityNames(bodyOf);
            if (entityOf(st.target, names) === en) {
              const v = lit(st.value);
              if (st.value?.kind === "lit" && st.value.value === null) { found.push({ severity: "error", code: "TRANSITION_NONE", line: st.pos?.line ?? line, message: `${bodyOf.what} sets ${en}.${f.name} to none, which is no state: a field with transitions always holds one of its values` }); known = null; continue; }
              if (!v) { dynamic = true; warn("TRANSITION_DYNAMIC", st.pos?.line ?? line, `${bodyOf.what} sets ${en}.${f.name} to a value the check can't read: the app refuses a move transitions doesn't allow`); known = null; continue; }
              let from: Set<string> | null = null;
              if (known && key(known.target) === key(st.target)) from = new Set([known.v]);
              else for (const { g, row } of gs) { const o = open(g, st.target, row); if (o) from = from ? new Set([...from].filter((x) => o.has(x))) : o; }
              const sources = [...(from ?? values)];
              for (const s of sources) if (may(s, v)) used.add(`${s}>${v}`);
              const bad = sources.filter((s) => !may(s, v));
              if (bad.length) found.push({ severity: "error", code: "TRANSITION_UNPROVEN", line: st.pos?.line ?? line, message: `${bodyOf.what} sets ${en}.${f.name} to ${v}, which transitions doesn't allow from ${bad.join(", ")}${from ? "" : " (nothing before it says which state it is in)"}: add the line  require ${st.target?.kind === "name" ? st.target.name : "the row"}.${f.name} == ${[...allowed].filter(([, to]) => to.has(v)).map(([a]) => a)[0] ?? "<a state that moves to " + v + ">"} else invalid  before it (the states that move to ${v}: ${[...allowed].filter(([, to]) => to.has(v)).map(([a]) => a).join(", ") || "none"}), or declare the move in transitions` });
              known = { target: st.target, v };
            }
            continue;
          }
          if (st.kind === "require") { gs.push({ g: st.cond, row: null }); continue; }
          if (st.kind === "let") continue;   // reads, writes nothing: the state the row was left in is still its state
          // a set of another field changes nothing of this one, unless a trigger on the entity's updates could
          if (st.kind === "set" && st.name !== f.name && !decls.some((t) => t.kind === "trigger" && t.on?.kind === "update" && t.on.entity === en)) continue;
          // an if's branches start in the state before it, and what follows it knows nothing of the state
          const before = known;
          known = null;
          if (st.kind === "if") { scan(st.then, [...gs, { g: st.cond, row: null }], line, before); if (st.else) scan(st.else, [...gs, { g: { kind: "unary", op: "not", arg: st.cond } as any, row: null }], line, before); }
          if (st.kind === "foreach") scan(st.body, [...gs, ...(st.where ? [{ g: st.where, row: { bind: st.bind, entity: st.entity } }] : [])], line);
          if (st.kind === "foreachList") scan(st.body, gs, line);
        }
      };
      let bodyOf!: (typeof bodies)[number];
      for (const b of bodies) { if ((b.d as any).kind === "migration") continue; bodyOf = b; scan(b.body, [], (b.d as any).pos?.line ?? 0); }
      if (dynamic) continue;
      for (const e of tr.edges) for (const to of e.to) if (!used.has(`${e.from}>${to}`)) warn("TRANSITION_UNUSED", e.pos?.line ?? tr.pos.line, `${en}.${f.name} may move ${e.from} -> ${to}, but nothing does: no action sets it to ${to} in a state that allows it`);
    }
  }

  // ---- ADMIN_ESCALATION: only administrators make administrators. The fields the app's admin
  // condition reads (through the predicates it calls) decide who one is; a set of one, or a create
  // that gives one a value from the caller, needs the admin condition required first
  {
    const app = decls.find((d) => d.kind === "app"), cond = app?.props.admin, actorEntity = app?.props.actor?.name;
    if (cond && actorEntity) {
      const key = (e: any) => JSON.stringify(e, (k, v) => (k === "pos" ? undefined : v));
      const decides = new Set<string>();
      const read = (e: any, bound: Set<string>, seen: Set<string>): void => {
        for (const n of nodes(e)) {
          if (n.kind === "field" && n.target?.kind === "name" && bound.has(n.target.name)) decides.add(n.name);
          if (n.kind === "call" && fnBodies.has(n.name) && !seen.has(n.name)) {
            const d = decls.find((x) => (x.kind === "fn" || x.kind === "predicate") && x.name === n.name);
            const inner = new Set<string>();
            (d?.params ?? []).forEach((p: any, i: number) => { const a = n.args?.[i]; if (a?.kind === "name" && bound.has(a.name)) inner.add(p.name); });
            if (inner.size) read(d.body, inner, new Set([...seen, n.name]));
          }
        }
      };
      read(cond, new Set(["actor"]), new Set());
      // the names the condition (and what it calls) compares with: the value that makes an administrator is among them
      const adminNames = new Set<string>();
      const names = (e: any, seen: Set<string>): void => { for (const n of nodes(e)) { if (n.kind === "name") adminNames.add(n.name); if (n.kind === "call" && !seen.has(n.name)) { const d = decls.find((x) => (x.kind === "fn" || x.kind === "predicate") && x.name === n.name); if (d) names(d.body, new Set([...seen, n.name])); } } };
      names(cond, new Set());
      const guarded = (guards: Expr[]) => guards.some((g) => nodes(g).some((n) => key(n) === key(cond)));
      for (const b of bodies) {
        if ((b.d as any).generated || (b.d as any).kind === "migration") continue;
        const names = entityNames(b);
        for (const { st, guards } of walk(b.body)) {
          if (guarded(guards)) continue;
          const what = (field: string, how: string) => found.push({ severity: "error", code: "ADMIN_ESCALATION", line: st.pos?.line ?? (b.d as any).pos?.line ?? 0, message: `${b.what} ${how} ${actorEntity}.${field}, which decides who an administrator is (app admin), without requiring an administrator first: only administrators make administrators` });
          if (st.kind === "set" && decides.has(st.name) && entityOf(st.target, names) === actorEntity) what(st.name, "sets");
          // a create gives the field a value from the caller, or the very value that makes an administrator; only while there is no administrator yet (the first run) may it
          const firstRun = guards.some((g) => nodes(g).some((n) => n.kind === "unary" && n.op === "not" && n.arg?.kind === "query" && n.arg.op === "exists" && n.arg.entity === actorEntity));
          if (st.kind === "create" && st.entity === actorEntity && !firstRun) for (const a of st.fields) {
            if (!decides.has(a.name)) continue;
            const literal = a.value?.kind === "lit" || (a.value?.kind === "name" && enums.get(tname(typed.types.get(a.value) as any)) !== undefined) || (a.value?.kind === "name" && [...enums.values()].some((vs) => vs.includes(a.value.name)));
            if (!literal) what(a.name, "gives a value from the caller to");
            else if (a.value?.kind === "name" && adminNames.has(a.value.name)) what(a.name, "makes an administrator by setting");
          }
        }
      }
    }
  }

  // ---- writes to rows the caller chooses, with no check of the actor first
  for (const a of of("action")) {
    if (a.internal) continue;
    const b = bodies.find((x) => x.d === a)!;
    const chosen = new Map(a.params.filter((p: any) => ents.get(tname(p.type))?.kind === "entity").map((p: any) => [p.name, tname(p.type)]));
    const reported = new Set<string>();
    for (const { st, guards } of walk(a.body)) {
      const target = st.kind === "set" || st.kind === "delete" || st.kind === "touch" ? st.target : undefined;
      if (!target) continue;
      // the row written: a parameter itself, or a row reached from one
      let root: any = target; while (root?.kind === "field") root = root.target;
      if (root?.kind !== "name" || !chosen.has(root.name)) continue;
      if (guards.some((g) => readsActor(g)) || reported.has(root.name)) continue;
      reported.add(root.name);
      warn("WRITE_UNCHECKED", st.pos?.line ?? a.pos.line, `${a.name} ${st.kind === "delete" ? "deletes" : "changes"} the ${chosen.get(root.name)} it is given (${root.name}) with no require on the actor before it: anyone who can call it can do this to any ${chosen.get(root.name)}`);
    }
  }

  // ---- signed-out callers, writing without a rate limit
  for (const a of of("action")) {
    if (a.internal || !(a.skips ?? []).includes("signed_in")) continue;
    const ns = nodes(a.body);
    if (ns.some((n) => n.kind === "rate_limit")) continue;
    if (!ns.some((n) => ["create", "set", "delete", "deleteWhere"].includes(n.kind))) continue;
    warn("SIGNED_OUT_UNLIMITED", a.pos.line, `${a.name} is open to signed-out callers and writes rows, but has no rate_limit`);
  }

  // ---- a sign-in limited only by address: from many addresses (or one that changes), the
  // guesses at one account go on without end
  const byIp = (b: any) => b?.kind === "field" && b.name === "ip" && b.target?.kind === "name" && b.target.name === "request";
  for (const a of of("action")) {
    if (a.internal) continue;
    const ns = nodes(a.body);
    if (!ns.some((n) => n.kind === "call" && n.name === "authenticates")) continue;
    const limits = ns.filter((n) => n.kind === "rate_limit");
    if (limits.length && limits.every((l) => byIp(l.by))) error("SIGN_IN_BY_ADDRESS_ONLY", limits[0].pos?.line ?? a.pos.line, `${a.name} checks a password and limits tries only by request.ip: guesses at one account from many addresses go on without end. Limit by the account too: rate_limit 20 per Duration.minutes(15) by lower(trim(email)) else blocked`);
  }

  // ---- two rows inside the same container (a policy for rows in it), never related: a row of one
  // tenant could be used with a row of another (another wiki's template on this wiki's page)
  const snakeOf = (n: string) => n.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const container = new Map<string, string>();
  for (const rp of of("rowpolicy")) if (rp.container) for (const e of rp.covers ?? []) container.set(e, rp.container);
  const rootOf = (x: any): string | undefined => { while (x?.kind === "field") x = x.target; return x?.kind === "name" ? x.name : undefined; };
  for (const a of of("action")) {
    if (a.internal || a.scheduled) continue;
    const ps = (a.params ?? []).filter((p: any) => p.type?.kind === "named" && container.has(p.type.name));
    if (ps.length < 2) continue;
    const ns = nodes(a.body);
    const related = (x: string, y: string) => ns.some((n) =>
      (n.kind === "binary" && (n.op === "==" || n.op === "!=") && ((rootOf(n.left) === x && rootOf(n.right) === y) || (rootOf(n.left) === y && rootOf(n.right) === x))) ||
      (n.kind === "call" && (n.args ?? []).some((g: any) => rootOf(g) === x) && (n.args ?? []).some((g: any) => rootOf(g) === y)));
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const [p, q] = [ps[i], ps[j]], c = container.get(p.type.name);
      if (c !== container.get(q.type.name) || related(p.name, q.name)) continue;
      warn("ROWS_UNRELATED", a.pos.line, `${a.name} takes ${p.name} (${p.type.name}) and ${q.name} (${q.type.name}), both inside a ${c}, and nothing requires they are in the same one: a caller could pass rows of two. Require it: require ${q.name}.${snakeOf(c)} == ${p.name}.${snakeOf(c)} else invalid (or the path between them)`);
    }
  }

  // ---- a block its subject can lift: a row restricts someone (a condition reads not exists(E where …),
  // itself or through a function), and an action deletes such a row where the actor may be the row's
  // own (a require admits row.user == actor) without reading the field the restriction tests
  const restricts = new Map<string, Set<string>>();   // entity -> the fields a restriction tests
  const existsIn = (x: any, seen = new Set<string>()): any[] => {
    if (x?.kind === "query" && x.op === "exists") return [x];
    if (x?.kind === "call" && fnBodies.has(x.name) && !seen.has(x.name)) { seen.add(x.name); return existsIn(fnBodies.get(x.name), seen); }
    if (x?.kind === "binary" && (x.op === "and" || x.op === "or")) return [...existsIn(x.left, seen), ...existsIn(x.right, seen)];
    return [];
  };
  for (const d of decls as any[]) for (const n of nodes([d.body, d.cond, d.requires, d.params])) {
    if (n.kind !== "unary" || n.op !== "not") continue;
    for (const q of existsIn(n.arg)) {
      const refs = new Set((ents.get(q.entity)?.fields ?? []).filter((f: any) => ents.has(tname(f.type))).map((f: any) => f.name));
      const tested = nodes(q.where).filter((m) => m.kind === "rowfield" && !refs.has(m.name)).map((m) => m.name);
      if (!tested.length) continue;
      const s = restricts.get(q.entity) ?? new Set<string>(); tested.forEach((t: string) => s.add(t)); restricts.set(q.entity, s);
    }
  }
  for (const a of of("action")) {
    if (a.internal) continue;
    const env = new Map<string, string>();
    for (const p of a.params ?? []) if (tname(p.type) && ents.has(tname(p.type))) env.set(p.name, tname(p.type));
    for (const n of nodes(a.body)) if (n.kind === "foreach" && n.bind) env.set(n.bind, n.entity);
    const reqs = nodes(a.body).filter((n) => n.kind === "require").map((r) => r.cond);
    for (const st of nodes(a.body)) {
      if (st.kind !== "delete" || st.target?.kind !== "name") continue;
      const row = st.target.name, en = env.get(row), fields = en ? restricts.get(en) : undefined;
      if (!fields) continue;
      const own = reqs.some((c) => nodes(c).some((m) => m.kind === "binary" && m.op === "==" && ((rootOf(m.left) === row && m.left.kind === "field" && m.right?.kind === "name" && m.right.name === "actor") || (rootOf(m.right) === row && m.right.kind === "field" && m.left?.kind === "name" && m.left.name === "actor"))));
      if (!own) continue;
      const reads = reqs.some((c) => nodes(c).some((m) => m.kind === "field" && rootOf(m) === row && fields.has(m.name)));
      if (reads) continue;
      warn("BLOCK_SELF_LIFT", st.pos?.line ?? a.pos.line, `${a.name} lets the actor delete their own ${en} (${row}), and a ${en} can restrict someone (a condition reads not exists(${en} where … .${[...fields].join(", .")} …)): deleting it would lift it. Say who may delete a restricting one: policy …: .${[...fields][0]} != … or <admin> else forbidden for deletes of ${en}`);
    }
  }

  // ---- triggers setting each other off (lang/facts.ts triggerLoops)
  for (const path of triggerLoops(F)) {
    const lines = path.map((id) => F.decl.get(id).pos.line as number);
    warn("TRIGGER_CYCLE", lines[0], `triggers can set each other off in a loop: ${lines.map((l) => `line ${l}`).join(" -> ")}; make sure a when condition stops it`);
  }

  // ---- deletes a restricting reference can refuse: one to the row deleted, or to a row the delete cascades to
  // (deleting a room deletes its messages; an invoice that restricts deleting a message refuses the room's delete)
  const cascadeReach = (e: string): Map<string, string> => {
    const out = new Map<string, string>([[e, e]]), todo = [e];
    while (todo.length) { const x = todo.pop()!; for (const [n, d] of ents) if (d.kind === "entity" && !out.has(n)) for (const f of d.fields) if (tname(f.type) === x && f.onDelete === "cascade") { out.set(n, `${out.get(x)} -> ${n}`); todo.push(n); break; } }
    return out;
  };
  const restricting = (e: string) => { const reach = cascadeReach(e); return [...ents].filter(([n, d]) => d.kind === "entity" && !reach.has(n)).flatMap(([n, d]) => d.fields.filter((f: any) => reach.has(tname(f.type)) && f.onDelete === "restrict").map((f: any) => `${n}.${f.name}${tname(f.type) === e ? "" : ` (through ${reach.get(tname(f.type))})`}`)); };
  for (const b of bodies) {
    const names = entityNames(b);
    for (const { st, guards } of walk(b.body)) {
      const e = st.kind === "delete" ? entityOf(st.target, names) : st.kind === "deleteWhere" ? st.entity : undefined;
      if (!e) continue;
      const refs = restricting(e);
      if (!refs.length) continue;
      const checked = refs.filter((r) => guards.some((g) => nodes(g).some((n) => (n.kind === "count" || n.kind === "exists" || n.kind === "listq" || n.kind === "query") && n.entity === r.split(".")[0])));
      // rows of the referring entity deleted first, in the same body, count as handled
      const cleared = refs.filter((r) => nodes(b.body).some((n) => n.kind === "deleteWhere" && n.entity === r.split(".")[0]));
      const open = refs.filter((r) => !checked.includes(r) && !cleared.includes(r));
      if (open.length) warn("DELETE_RESTRICTED", st.pos?.line ?? b.d.pos.line, `${b.what} deletes a ${e}, which ${open.join(", ")} restrict${open.length === 1 ? "s" : ""} (on delete restrict, the default): it is refused while such rows exist. Check first, or declare on delete cascade or nullify`);
    }
  }

  // ---- creates of uniquely keyed rows from the caller's values
  for (const a of of("action")) {
    const params = new Set(a.params.map((p: any) => p.name));
    for (const { st, guards } of walk(a.body)) {
      if (st.kind !== "create" || st.ensure) continue;
      const ent = ents.get(st.entity);
      for (const cols of ent?.uniques ?? []) {
        const given = cols.map((c: string) => st.fields.find((x: any) => x.name === c));
        if (given.some((g: any) => !g)) continue;
        if (!given.some((g: any) => nodes(g.value).some((n) => n.kind === "name" && params.has(n.name)))) continue;
        // handled: a check for existing rows first (of any entity: the spec may know that none
        // exist when another doesn't), or the old row deleted earlier in the body
        // (a query of the spec's own that reads the entity counts: require page_named(w, title) == none)
        if (guards.some((g) => nodes(g).some((n) => n.kind === "count" || n.kind === "exists" || n.kind === "listq" || n.kind === "query" || (n.kind === "call" && (n.name === "exists" || n.name === "count" || decls.some((x: any) => (x.kind === "fn" || x.kind === "predicate") && x.queries && x.name === n.name && nodes(x.body).some((y: any) => y.entity === st.entity))))))) continue;
        if (nodes(a.body).some((n) => n.kind === "deleteWhere" && n.entity === st.entity && (n.pos?.line ?? 0) <= (st.pos?.line ?? 0))) continue;
        warn("UNIQUE_UNGUARDED", st.pos?.line ?? a.pos.line, `${a.name} creates a ${st.entity} keyed (${cols.join(", ")}) from its arguments; a duplicate is refused as invalid. Use ensure, or check first if a duplicate should get its own outcome`);
      }
    }
  }

  // ---- the() and the_or_none() queries that don't pin a unique key
  const pinsKey = (whereExpr: any, entityName: string, uniqueKeys: string[][]): boolean => {
    if (!whereExpr) return false;
    // Collect all equality comparisons
    const equals = new Map<string, boolean>(); // field -> is pinned
    for (const n of nodes(whereExpr)) {
      if (n.kind === "binary" && n.op === "==") {
        // `it == x`: the row itself, by its id
        if (n.left?.kind === "it" || n.right?.kind === "it") { equals.set("id", true); continue; }
        const fieldNode = (n.left?.kind === "rowfield" || n.left?.kind === "field") ? n.left : (n.right?.kind === "rowfield" || n.right?.kind === "field") ? n.right : null;
        if (fieldNode && fieldNode.name) {
          equals.set(fieldNode.name, true);
        }
      }
    }
    // Check if all columns of any unique key are pinned
    for (const cols of uniqueKeys) {
      if (cols.every((c) => equals.has(c))) return true;
    }
    // Check if id is pinned
    if (equals.has("id")) return true;
    return false;
  };

  for (const b of bodies) {
    for (const n of nodes(b.body)) {
      if (n.kind === "query" && ["the", "the_or_none"].includes(n.op)) {
        const ent = ents.get(n.entity);
        if (!ent || ent.singleton) continue; // Singletons always have exactly one row
        if (!pinsKey(n.where, n.entity, ent.uniques ?? [])) {
          warn("THE_NOT_UNIQUE", n.pos?.line, `${n.op}(${n.entity} where …) condition doesn't pin a unique key or id: can fail at runtime with more than one match`);
        }
      }
    }
  }

  // Note: identity where clauses don't need to pin a unique key, because identities are keyed
  // by their source (param, cookie, token, etc.), not by the where clause alone.

  // ---- how the entities refer to each other
  {
    const isEnt = (n: string | undefined) => !!n && ents.get(n)?.kind === "entity";
    const required = (d: any) => (d.fields ?? []).filter((f: any) => f.type?.kind === "named" && !f.type.optional && isEnt(f.type.name));
    for (const [n, d] of ents) {
      if (d.kind !== "entity") continue;
      const refs = required(d);
      // LINK_NOT_UNIQUE: a row that only links two others (its other fields optional or defaulted), with nothing
      // keeping one link per pair: two Memberships of one user in one room
      const rest = d.fields.filter((f: any) => !refs.includes(f));
      if (refs.length === 2 && rest.every((f: any) => f.type?.optional || f.default || f.stamped) && !(d.uniques ?? []).some((u: string[]) => refs.every((r: any) => u.includes(r.name))))
        warn("LINK_NOT_UNIQUE", d.pos.line, `${n} links a ${refs[0].type.name} and a ${refs[1].type.name}, and nothing keeps one ${n} per pair: two can link the same ones. Add unique (${refs[0].name}, ${refs[1].name}) if a pair links once`);
      // PATHS_DISAGREE: two ways to the same row, a field of the row's own and the same field of a row it refers to,
      // with nothing saying they agree (an invoice's customer, and its project's customer)
      // (only for a field named after its entity, customer: Customer: the one customer, in both. A creator of a
      // message and of its room are two people)
      for (const f of refs) for (const g of refs) {
        if (f === g || f.name !== f.type.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()) continue;
        const via = ents.get(g.type.name);
        const h = via?.fields?.find((x: any) => x.name === f.name && x.type?.kind === "named" && !x.type.optional && x.type.name === f.type.name);
        if (!h) continue;
        const said = (d.invariants ?? []).some((inv: any) => { const t = JSON.stringify(inv, (k, v) => (k === "pos" ? undefined : v)); return t.includes(`"name":"${g.name}"`) && t.split(`"name":"${f.name}"`).length > 2; });
        if (!said) warn("PATHS_DISAGREE", f.pos?.line ?? d.pos.line, `${n} reaches a ${f.type.name} two ways, .${f.name} and .${g.name}.${f.name}, and nothing says they are the same one: if they must be, say so with invariant self.${f.name} == self.${g.name}.${f.name}`);
      }
    }
    // INVARIANT_SCANS: an entity invariant the app would check on every row of its entity after a write
    // (it reads past a chain of references from self: a query, a function of another row), so one write
    // costs a read of the whole table. On a big one, every write is slow (invariant-deps.ts)
    for (const [n, d] of ents) {
      if (d.kind !== "entity") continue;
      for (const inv of (d.invariants ?? []) as any[]) {
        const scans = scansAll(decls, n, invariantDeps(decls, n, inv));
        if (scans.length) found.push({ severity: "error", code: "INVARIANT_SCANS", line: inv.pos?.line ?? d.pos.line, message: `this invariant of ${n} would check every ${n} after any write to ${scans.length > 4 ? `${scans.slice(0, 4).join(", ")} and ${scans.length - 4} more` : scans.join(", ")}: it reads more than self and the rows its references reach (self.a.b), so the app can't tell which rows a change affects. Write it over self's references only, or check it in the actions that write those rows (a require)` });
      }
    }
    // PARENT_HIDDEN: a row that may be seen while the row it requires may not (a boost of a message you can't
    // see): what it shows of that row shows what the row's own policy hides
    const perms = new Map(decls.filter((x: any) => x.kind === "permission").map((x: any) => [x.entity, x]));
    for (const [n, d] of ents) {
      const pc: any = perms.get(n);
      if (d.kind !== "entity" || !pc) continue;
      const row = n.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      for (const f of required(d)) {
        const pp: any = perms.get(f.type.name);
        if (!pp) continue;
        const parent = f.type.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
        let theirs = substName(pp.cond, parent, { kind: "field", target: { kind: "name", name: row, pos: d.pos }, name: f.name, pos: d.pos });
        // what the row's invariants say are the same is the same: with invariant self.wiki ==
        // self.page.wiki, the page's wiki is the row's own (row.page.wiki is row.wiki)
        theirs = sameVia(d, row, theirs);
        if (!impliesIn(decls, pc.cond, theirs)) warn("PARENT_HIDDEN", f.pos?.line ?? d.pos.line, `a ${n} may be seen where its ${f.name}, a ${f.type.name}, may not: its policy doesn't say ${f.type.name}'s for the ${f.name}, so what a page shows of ${row}.${f.name} would show what ${f.type.name}'s policy hides. Put ${f.type.name}'s condition in ${n}'s, or both in a policy for rows in ${f.type.name}`);
      }
    }
  }

  // ---- how each field is used, from the facts (lang/facts.ts): FIELD_NEVER_READ (written but
  // never read), WRITE_ONLY_READ (an error: `write_only` says nothing reads it, and something
  // does), FIELD_READ_NEVER_SET and FIELD_NEVER_WRITTEN (nothing sets it: no create gives it, no
  // set, touch or migration writes it, so it always holds its default, or none)
  const use = new Map(fieldUse(F).map((u) => [u.field, u]));
  const listed = (ids: string[]) => { const xs = ids.filter((x) => x !== "runtime"); return xs.length ? xs.slice(0, 3).join(", ") + (xs.length > 3 ? ` and ${xs.length - 3} more` : "") : ""; };
  for (const [en, ent] of ents) {
    if (ent.kind !== "entity") continue;
    for (const f of ent.fields) {
      const key = `${en}.${f.name}`, u = use.get(key)!, line = f.pos?.line ?? ent.pos.line;
      // (id, created, updated, and a stamp's field, are set by the runtime or the compiler on every write: kept for whoever looks)
      const runtime = ["id", "created", "updated"].includes(f.name) || !!f.stamped;
      if (u.written && !u.read && !runtime && !writeOnlyFields.has(key)) warn("FIELD_NEVER_READ", line, `${key} is written but never read: dead data or incomplete feature`);
      if (writeOnlyFields.has(key) && u.read) found.push({ severity: "error", code: "WRITE_ONLY_READ", line, message: `${key} is marked write_only, but ${listed(u.readers) || "the app"} read${u.readers.length === 1 ? "s" : ""} it: remove write_only, or the read` });
      if (runtime || u.written) continue;
      const optional = f.type.kind === "named" && f.type.optional;
      if (!f.default && !optional) continue;   // a required field nothing gives: the type pass's to report
      // a default worked out for each row (token(24), now) gives each row its own value
      if (f.default && nodes(f.default).some((n) => n.kind === "now" || n.kind === "call")) continue;
      const always = f.default ? "it always holds its default" : "it is always none";
      if (u.read) warn("FIELD_READ_NEVER_SET", line, `${key} is read${u.readers.length ? ` by ${listed(u.readers)}` : ""}, but nothing sets it: ${always}. Set it somewhere, or drop the field and its reads`);
      else warn("FIELD_NEVER_WRITTEN", line, `${key} is never written${f.default ? " after its default" : ""}: ${always}`);
    }
  }

  // ---- OUTCOME_UNHANDLED: a form or button that handles some of its action's outcomes with <on>
  // but not one its fields can bring about (inputOutcomes); that one gets the default (back, with the outcome's text)
  // while the others get what the author wrote. One with no <on> at all leaves them all to the default
  const actionDecls = new Map(of("action").map((d) => [d.name, d]));
  for (const c of callSites(spec)) {
    const d = actionDecls.get(c.action);
    if (!d || ![...c.handled].some((o) => o !== "ok")) continue;
    const missing = inputOutcomes(spec, d, c.bound).filter((o) => o !== "ok" && !c.handled.has(o));
    if (missing.length) warn("OUTCOME_UNHANDLED", c.line, `${c.where} calls ${c.action} and handles ${[...c.handled].join(", ")}, but not ${missing.join(", ")}, which what is entered can bring about: ${missing.length > 1 ? "those get" : "it gets"} the default (back, with the outcome's text)`);
  }

  // ---- WORKFLOW_STALE_CHECK: an action makes a fact about a row (sets its field), then emits an
  // event with the row: the event says it happened. (A require on the row before is often a guard
  // the workflow doesn't rely on, so only what the action set counts); the workflow runs later, in its own
  // transaction. A step that acts (writes, mails, calls out) without reading that field again
  // acts on what was true then: another body can have changed the field in between
  const externEffect = new Map(of("extern").map((d) => [d.name, d.effect]));
  const acts = (ss: any[]) => nodes(ss).some((n) => ["create", "set", "delete", "deleteWhere", "sendmail"].includes(n.kind) || (n.kind === "extern" && !["pure", "fetch"].includes(externEffect.get(n.name) ?? "")));
  const setsOf = (b: (typeof bodies)[number]) => {
    const names = entityNames(b), out = new Set<string>();
    for (const n of nodes(b.body)) if (n.kind === "set") { const t: any = typed.types.get(n.target); const e = t?.k === "ref" ? t.e : entityOf(n.target, names); if (e) out.add(`${e}.${n.name}`); }
    return out;
  };
  const bodySets = bodies.map((b) => ({ b, sets: setsOf(b) }));
  const fieldsOn = (x: any, v: string) => nodes(x).filter((n) => n.kind === "field" && n.target?.kind === "name" && n.target.name === v).map((n) => n.name as string);
  for (const b of bodies) {
    if (b.d.kind === "workflow") continue;
    const names = entityNames(b);
    for (const { st, guards } of walk(b.body)) {
      if (st.kind !== "emit" || st.args?.[0]?.kind !== "name") continue;
      const v = st.args[0].name, ent = names.get(v);
      if (!ent) continue;
      // what the body knows of the row when it emits: the fields its checks read, and the ones it set
      const facts = new Map<string, string>();
      for (const { st: x } of walk(b.body)) { if (x === st) break; if (x.kind === "set" && x.target?.kind === "name" && x.target.name === v) facts.set(x.name, `set to ${x.value?.kind === "name" ? x.value.name : "a value"}`); }
      for (const w of of("workflow").filter((w) => w.event === st.event)) {
        for (const step of w.steps ?? []) {
          if (!acts(step.body)) continue;
          const reread = new Set(fieldsOn(step.body, w.bind));
          for (const [f, how] of facts) {
            if (reread.has(f)) continue;
            const others = bodySets.filter((o) => o.b !== b && o.b.d !== w && o.sets.has(`${ent}.${f}`)).map((o) => o.b.what);
            if (!others.length) continue;
            warn("WORKFLOW_STALE_CHECK", step.body[0]?.pos?.line ?? w.pos.line, `${w.name}, step ${step.name}, acts on ${w.bind} later, after ${b.what} ${how === "checked" ? `checked ${v}.${f}` : `set ${v}.${f} ${how.replace("set ", "")}`} and emitted ${st.event}; ${others.slice(0, 2).join(" or ")}${others.length > 2 ? ` (and ${others.length - 2} more)` : ""} can change ${f} before the step runs. Read ${w.bind}.${f} in the step to check it still holds`);
          }
        }
      }
    }
  }

  // ---- LINK_NOT_ALLOWED: a link to a screen that refuses whoever follows it. A screen's require on
  // who views it (it reads the actor, and none of the screen's parameters), with an outcome (not a
  // go elsewhere), must be known where the link is: in the linking screen's own requires, an if
  // around the link, or, in a component or layout, the requires of every screen that shows it
  const screens = new Map(of("screen").map((d) => [d.name, d]));
  const canon = (x: any) => JSON.stringify(x, (k, v) => (k === "pos" ? undefined : v));
  const conj = (x: any): any[] => (x?.kind === "binary" && x.op === "and" ? [...conj(x.left), ...conj(x.right)] : x ? [x] : []);
  const paramNames = (d: Decl) => new Set<string>((d.params ?? []).map((p: any) => p.name));
  const needs = (t: Decl) => (t.requires ?? []).filter((r: any) => r.outcome && readsActor(r.cond)).flatMap((r: any) => conj(r.cond).filter((c) => readsActor(c) && !nodes(c).some((n) => n.kind === "name" && paramNames(t).has(n.name))).map((c) => ({ c, outcome: r.outcome })));
  const ownFacts = (d: Decl) => new Map<string, any>((d.requires ?? []).flatMap((r: any) => conj(r.cond)).map((c: any) => [canon(c), c]));
  // the facts every screen that shows a component or layout knows (none known: no screen shows it)
  const shows = (body: any, name: string) => nodes(body).some((n) => n.kind === "el" && (n.name === name || (n.name === "use" && n.head?.name === name)));
  const users = (name: string) => of("screen").filter((sc) => sc.layout === name || shows(sc.body, name));
  const declFacts = (d: Decl, seen = new Set<string>()): Map<string, any> => {
    if (d.kind === "screen") return ownFacts(d);
    if (seen.has(d.name)) return new Map();
    seen.add(d.name);
    const us = [...users(d.name), ...of("component").filter((c) => c !== d && shows(c.body, d.name))];
    if (!us.length) return new Map([["__unshown", true]]);
    const sets = us.map((u) => declFacts(u, seen));
    return new Map([...sets[0]].filter(([k]) => sets.every((x) => x.has(k))));
  };
  // a predicate or function call, as its body with the arguments put in (a few levels deep)
  const preds = new Map([...of("predicate"), ...of("fn")].map((d) => [d.name, d]));
  const inline = (x: any, depth = 0): any => {
    if (!x || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map((y) => inline(y, depth));
    if (x.kind === "call" && preds.has(x.name) && depth < 4) {
      const d: any = preds.get(x.name);
      const env = new Map<string, any>(d.params.map((p: any, i: number) => [p.name, x.args?.[i] ?? x.named?.[p.name] ?? { kind: "lit", value: null }]));
      const sub = (y: any): any => (!y || typeof y !== "object" ? y : Array.isArray(y) ? y.map(sub) : y.kind === "name" && env.has(y.name) ? env.get(y.name) : Object.fromEntries(Object.entries(y).map(([k, v]) => [k, k === "pos" ? v : sub(v)])));
      return inline(sub(d.body), depth + 1);
    }
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "pos" ? v : inline(v, depth)]));
  };
  const disj = (x: any): any[] => (x?.kind === "binary" && x.op === "or" ? [...disj(x.left), ...disj(x.right)] : [x]);
  // a fact known where the link is covers a need: the same condition, or one of the need's or-branches
  const covers = (facts: any[], need: any) => {
    const n = inline(need), alts = new Set(disj(n).map(canon));
    return facts.some((f) => { const g = inline(f); return canon(g) === canon(n) || alts.has(canon(g)) || conj(g).some((h) => canon(h) === canon(n) || alts.has(canon(h))); });
  };
  const show = (x: any): string => {
    if (!x) return "?";
    switch (x.kind) {
      case "name": return x.name;
      case "lit": return x.value === null ? "none" : typeof x.value === "string" ? JSON.stringify(x.value) : String(x.value);
      case "field": return `${show(x.target)}.${x.name}`;
      case "rowfield": return `.${x.name}`;
      case "call": return `${x.name}(${(x.args ?? []).map(show).join(", ")})`;
      case "unary": return `${x.op} ${show(x.arg)}`;
      case "binary": return `${show(x.left)} ${x.op} ${show(x.right)}`;
      case "none": return "none";
      default: return x.kind;
    }
  };
  for (const d of [...of("screen"), ...of("component"), ...of("layout")]) {
    const base = declFacts(d);
    if (base.has("__unshown")) continue;   // no screen shows it: no one follows its links
    const visit = (els: any[], facts: Map<string, any>) => {
      for (const el of els ?? []) {
        if (!el || typeof el !== "object") continue;
        if (el.name === "if") {
          visit(el.children, new Map([...facts, ...conj(el.head).map((c: any) => [canon(c), c] as [string, any])]));
          visit(el.else, facts);
          continue;
        }
        // a link's target: its head (<Link to={…}> is read into it), or a to= or go= attribute
        const targets: any[] = [...(el.head?.kind === "ref" ? [el.head] : []), ...Object.entries(el.attrs ?? {}).filter(([k]) => ["to", "go"].includes(k)).map(([, v]) => v)];
        for (const tgt of targets) {
          const t = (tgt?.kind === "call" || tgt?.kind === "name" || tgt?.kind === "ref") ? screens.get(tgt.name) : undefined;
          if (!t || t === d) continue;
          const missing = needs(t).filter(({ c }) => !covers([...facts.values()], c));
          if (missing.length) warn("LINK_NOT_ALLOWED", el.pos?.line ?? d.pos.line, `${d.kind} ${d.name} links to screen ${t.name}, which needs ${missing.map(({ c, outcome }) => `${show(c)} (else ${outcome})`).join(" and ")}, but shows the link to anyone who can see ${d.kind === "screen" ? "it" : "where it is used"}: put it in if ${missing.map(({ c }) => show(c)).join(" and ")} { … }, or require it of the ${d.kind}`);
        }
        visit(el.children, facts); visit(el.else, facts);
      }
    };
    visit(d.body, base);
  }

  // ---- SCREEN_UNREACHABLE: a screen no chain of links reaches. It starts from the screen at "/"
  // (home), the app's sign_in and setup screens, and every screen named outside the UI (a mail, a
  // push's url_of, an action, a view); a screen reaches what it, its layout and the components it
  // shows name. One nothing reaches is opened only by its address typed in: dead, or a missing link
  const uiKinds = new Set(["screen", "component", "layout"]);
  const named = (x: any) => new Set(nodes(x).filter((n) => (n.kind === "ref" || n.kind === "call" || n.kind === "name") && screens.has(n.name)).map((n) => n.name as string));
  const comps = new Map([...of("component"), ...of("layout")].map((d) => [d.name, d]));
  const shown = (body: any) => nodes(body).filter((n) => n.kind === "el").map((n) => (n.name === "use" ? n.head?.name : n.name)).filter((n) => comps.has(n));
  const reachFrom = (d: Decl, seen = new Set<string>()): Set<string> => {
    const out = named([d.body, d.requires]);
    const inner = [...shown(d.body), ...(d.layout ? [d.layout] : [])];
    for (const c of inner) if (!seen.has(c) && comps.has(c)) { seen.add(c); for (const n of reachFrom(comps.get(c)!, seen)) out.add(n); }
    return out;
  };
  const appDecl = decls.find((d) => d.kind === "app");
  const roots = new Set<string>([
    ...of("screen").filter((sc) => sc.route === "/").map((sc) => sc.name),
    ...["sign_in_screen", "setup_screen"].map((k) => appDecl?.props?.[k]?.name).filter((n): n is string => !!n && screens.has(n)),
    ...decls.filter((d) => !uiKinds.has(d.kind)).flatMap((d) => [...named(d)]),
  ]);
  // home (go={home}) is the screen at "/"
  const reached = new Set<string>(), queue = [...roots];
  while (queue.length) {
    const n = queue.pop()!;
    if (reached.has(n)) continue;
    reached.add(n);
    for (const m of reachFrom(screens.get(n)!)) if (!reached.has(m)) queue.push(m);
  }
  // (the scaffold's screens, under /_auto, are opened by their address: that is what they are for)
  for (const sc of of("screen")) if (!reached.has(sc.name) && !sc.file && !String(sc.route ?? "").startsWith("/_auto")) warn("SCREEN_UNREACHABLE", sc.pos.line, `screen ${sc.name} (${sc.route}) is linked from no screen that can be reached (from ${[...roots].length ? "home, sign-in, setup and what mail, actions and workflows name" : "home"}): only its address typed in opens it. Link to it, or remove it`);

  // ---- slips that change nothing, or always the same: a statement after reject (it ends the
  // action, so the statement never runs); a comparison of a thing with itself; a field set to itself
  {
    const sameText = (x: any) => JSON.stringify(x, (k, v) => (k === "pos" ? undefined : v));
    const blocks = (x: any, visit: (ss: any[]) => void): void => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) { if (x.length && x.every((s) => s && typeof s === "object" && typeof s.kind === "string" && "pos" in s)) visit(x); x.forEach((y) => blocks(y, visit)); return; }
      for (const [k, v] of Object.entries(x)) if (k !== "pos") blocks(v, visit);
    };
    for (const d of decls) {
      if (d.pos.line <= 0) continue;
      blocks(d, (ss) => {
        const i = ss.findIndex((s: any) => s.kind === "reject");
        if (i >= 0 && i < ss.length - 1 && ss[i + 1].pos?.line > 0) error("UNREACHABLE", ss[i + 1].pos.line, `${d.kind} ${d.name}: this never runs, after reject (line ${ss[i].pos.line}), which ends the ${d.kind}`);
        for (const s of ss) if (s.kind === "set" && s.value && sameText(s.value) === sameText({ kind: "field", target: s.target, name: s.name })) error("SET_SELF", s.pos.line, `${d.kind} ${d.name}: set ${show(s.target)}.${s.name} to itself, which changes nothing`);
      });
      for (const n of nodes(d)) {
        // an if whose two branches are the same: the condition decides nothing
        if (n.kind === "if" && n.then && n.else && !(n as any).__fromMatch && !(n as any).__match && sameText(n.then) === sameText(n.else) && (Array.isArray(n.then) ? n.then.length : true))
          error("SAME_BRANCHES", n.pos?.line ?? d.pos.line, `${d.kind} ${d.name}: both branches of this if are the same, so its condition decides nothing`);
        // a require of true checks nothing; of false, always refuses (one a policy put there is the
        // policy's: policy p: true … says anyone may, and every action it covers gets require true)
        if (n.kind === "require" && !(n as any).fromPolicy && n.cond?.kind === "lit" && typeof n.cond.value === "boolean")
          error("REQUIRE_CONSTANT", n.pos?.line ?? d.pos.line, `${d.kind} ${d.name}: require ${n.cond.value} ${n.cond.value ? "checks nothing" : "always refuses"}`);
      }
      // (not in a require a policy put there: substituting the row can make both sides the same)
      const woven = new Set(nodes(d).filter((n: any) => n.kind === "require" && n.fromPolicy).flatMap((n: any) => nodes(n.cond)));
      for (const n of nodes(d)) if (n.kind === "binary" && !woven.has(n) && ["==", "!=", "and", "or"].includes(n.op) && n.left && sameText(n.left) === sameText(n.right) && !nodes(n.left).some((m: any) => m.kind === "now"))
        error("SAME_SIDES", n.pos?.line ?? d.pos.line, `${d.kind} ${d.name}: both sides of ${n.op} are the same, so it is always ${n.op === "!=" ? "false" : n.op === "==" ? "true" : "the one side"}: is one meant to be something else?`);
    }
  }

  // ---- GUARD_MISSING: actions that do the same to a row they're given (change or delete it; or
  // add rows to it, rows that point to it) check the same things about who acts, on it
  // (member(actor, room), can_administer(actor, room.creator)). With three or more such actions,
  // one that leaves out a check every other one makes is likely missing it, unless it says it is
  // a case of its own, with a condition on the row no other makes (room.type == direct)
  {
    const SAME = "\u0000row";   // the row the action is given, whatever its parameter is called
    const keyOf = (c: any, p: string) => JSON.stringify(c, (k, v) => (k === "pos" ? undefined : v?.kind === "name" && v.name === p ? { kind: "name", name: SAME } : v));
    const rootName = (t: any) => { while (t?.kind === "field") t = t.target; return t?.kind === "name" ? t.name : undefined; };
    // what an action does to the row a parameter names: changes it, or adds to it
    // (a write only under an if on who acts, if actor.role == customer { … }, is checked there: a
    // case of its own, so it doesn't count)
    const does = (a: Decl, p: string): string[] => {
      const out = new Set<string>();
      const visit = (ss: any[]) => { for (const n of ss ?? []) {
        if ((n.kind === "set" || n.kind === "delete" || n.kind === "touch") && rootName(n.target) === p) out.add("changes");
        if (n.kind === "create" && n.fields.some((f: any) => f.value?.kind === "name" && f.value.name === p)) out.add("adds to");
        if (n.kind === "if" && !readsActor(n.cond)) { visit(n.then); visit(n.else); }
        if (n.kind === "foreach" || n.kind === "foreachList") visit(n.body);
      } };
      visit(a.body);
      return [...out];
    };
    const groups = new Map<string, { a: Decl; p: string; checks: Map<string, any>; conds: Set<string> }[]>();
    for (const a of of("action")) {
      if (a.internal) continue;
      for (const p of a.params) {
        const e = tname(p.type);
        if (ents.get(e)?.kind !== "entity") continue;
        // the checks on who acts: on the row (member(actor, room)), or on the actor alone
        // (actor.role == staff), which no parameter is in
        const checks = new Map<string, any>(), conds = new Set<string>(), names = new Set(a.params.map((q: any) => q.name));
        for (const st of nodes(a.body)) if (st.kind === "require")
          for (const c of conj(st.cond)) {
            const onRow = nodes(c).some((n) => n.kind === "name" && n.name === p.name);
            // a case of its own is a condition on the row's state alone (room.type == direct): not on
            // who acts, nor on what else the action is given
            if (onRow && !readsActor(c) && !nodes(c).some((n) => n.kind === "name" && n.name !== p.name && names.has(n.name))) conds.add(keyOf(c, p.name));
            if (readsActor(c) && (onRow || !nodes(c).some((n) => n.kind === "name" && names.has(n.name)))) checks.set(keyOf(c, p.name), c);
          }
        for (const what of does(a, p.name)) groups.set(`${what} ${e}`, [...(groups.get(`${what} ${e}`) ?? []), { a, p: p.name, checks, conds }]);
        // and every action given a row of the entity that writes anything: what they all check
        if (nodes(a.body).some((n) => ["set", "create", "delete", "deleteWhere", "touch"].includes(n.kind))) groups.set(`given ${e}`, [...(groups.get(`given ${e}`) ?? []), { a, p: p.name, checks, conds }]);
      }
    }
    const said = new Set<string>();
    for (const [g, all] of [...groups].sort(([a], [b]) => Number(a.startsWith("given ")) - Number(b.startsWith("given ")))) {
      // a case of its own is left out of the comparison, both ways
      const own = (x: (typeof all)[number]) => [...x.conds].some((k) => !all.some((y) => y !== x && y.conds.has(k)));
      const list = all.filter((x) => !own(x));
      // the broad group (given a row, doing anything) is mixed: four or more, and only checks on the row
      if (list.length < (g.startsWith("given ") ? 4 : 3)) continue;
      const [what, e] = [g.slice(0, g.lastIndexOf(" ")), g.slice(g.lastIndexOf(" ") + 1)];
      for (const x of list) {
        const others = list.filter((y) => y !== x);
        for (const k of others[0].checks.keys()) {
          if (x.checks.has(k) || !others.every((y) => y.checks.has(k))) continue;
          const c = JSON.parse(k.split(JSON.stringify(SAME)).join(JSON.stringify(x.p)));
          if (said.has(`${x.a.name}|${show(c)}`) || (what === "given" && !k.includes(JSON.stringify(SAME)))) continue;
          said.add(`${x.a.name}|${show(c)}`);
          if (what === "given") { warn("GUARD_MISSING", x.a.pos.line, `${x.a.name} is given a ${e} (${x.p}) and doesn't check ${show(c)}, which the ${others.length} other actions given a ${e} that write check (${others.slice(0, 3).map((y) => y.a.name).join(", ")}${others.length > 3 ? ", …" : ""}): add require ${show(c)} else …, if it applies here too`); continue; }
          warn("GUARD_MISSING", x.a.pos.line, `${x.a.name} ${what === "changes" ? "changes" : "adds to"} the ${e} it is given (${x.p}) without checking ${show(c)}, which the ${others.length} other actions that ${what === "changes" ? "change" : "add to"} a ${e} check (${others.slice(0, 3).map((y) => y.a.name).join(", ")}${others.length > 3 ? ", …" : ""}): add require ${show(c)} else …, if it applies here too`);
        }
      }
    }
  }

  return found;
}

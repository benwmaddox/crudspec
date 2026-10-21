// How a condition changed from one version of a spec to the next: whether the new one holds in
// fewer cases, more, the same or other ones. Conditions are compared as propositions: each
// comparison, call or field inside them is one unknown, and every assignment of the unknowns is
// tried, so `a or b` -> `a` holds in fewer cases and `x` -> `true` in more, whatever a, b and x are.
// What it can't see into (x > 3 -> x > 5) it reports as other cases.
import type { Decl, Spec } from "./parser.ts";
import { showExpr } from "./review.ts";

type Prop = { t: "and" | "or"; a: Prop; b: Prop } | { t: "not"; a: Prop } | { t: "atom"; k: string } | { t: "const"; v: boolean };
export type Relation = "same" | "fewer" | "more" | "other";

// a comparison's two sides in one order, so a == b and b == a are one unknown
const atomKey = (x: any): string => {
  if (x?.kind === "binary" && x.op === "==") { const [l, r] = [showExpr(x.left), showExpr(x.right)].sort(); return `${l} == ${r}`; }
  return showExpr(x);
};
function prop(x: any): Prop {
  if (x?.kind === "lit" && typeof x.value === "boolean") return { t: "const", v: x.value };
  if (x?.kind === "unary" && x.op === "not") return { t: "not", a: prop(x.arg) };
  if (x?.kind === "binary") {
    if (x.op === "and" || x.op === "or") return { t: x.op, a: prop(x.left), b: prop(x.right) };
    if (x.op === "implies") return { t: "or", a: { t: "not", a: prop(x.left) }, b: prop(x.right) };
    if (x.op === "!=") return { t: "not", a: { t: "atom", k: atomKey({ ...x, op: "==" }) } };
  }
  if (x?.kind === "if" && x.else) { const c = prop(x.cond); return { t: "or", a: { t: "and", a: c, b: prop(x.then) }, b: { t: "and", a: { t: "not", a: c }, b: prop(x.else) } }; }
  return { t: "atom", k: atomKey(x) };
}
const atoms = (p: Prop, out = new Set<string>()): Set<string> => {
  if (p.t === "atom") out.add(p.k); else if (p.t === "not") atoms(p.a, out); else if (p.t === "and" || p.t === "or") { atoms(p.a, out); atoms(p.b, out); }
  return out;
};
const holds = (p: Prop, v: Map<string, boolean>): boolean =>
  p.t === "const" ? p.v : p.t === "atom" ? v.get(p.k)! : p.t === "not" ? !holds(p.a, v) : p.t === "and" ? holds(p.a, v) && holds(p.b, v) : holds(p.a, v) || holds(p.b, v);

// the new condition against the old: holds in the same cases, fewer, more, or other ones
export function relate(oldX: any, newX: any): Relation {
  const a = prop(oldX ?? { kind: "lit", value: true }), b = prop(newX ?? { kind: "lit", value: true });
  const names = [...new Set([...atoms(a), ...atoms(b)])];
  if (names.length > 14) return "other";
  let gained = false, lost = false;
  for (let i = 0; i < 1 << names.length; i++) {
    const v = new Map(names.map((n, j) => [n, ((i >> j) & 1) === 1]));
    const was = holds(a, v), now = holds(b, v);
    if (now && !was) gained = true;
    if (was && !now) lost = true;
    if (gained && lost) return "other";
  }
  return gained ? "more" : lost ? "fewer" : "same";
}
// the conjunction of several conditions (none: always)
export const all = (xs: any[]) => xs.reduce((l, r) => (l ? { kind: "binary", op: "and", left: l, right: r } : r), null) ?? { kind: "lit", value: true };

// a condition with the predicates it calls written out (their parameters given the call's
// arguments), so member(actor, room) and the exists(…) it stands for compare as the same
// a declaration's own parameters by position, so a predicate's renamed ones compare the same
export function positional(x: any, d: Decl): any {
  const at = new Map<string, number>((d.params ?? []).map((q: any, i: number) => [q.name, i]));
  if (!at.size) return x;
  const sub = (y: any): any => (!y || typeof y !== "object" ? y : Array.isArray(y) ? y.map(sub) : y.kind === "name" && at.has(y.name) ? { ...y, name: `#${at.get(y.name)}` } : Object.fromEntries(Object.entries(y).map(([k, v]) => [k, k === "pos" ? v : sub(v)])));
  return sub(x);
}
export function inline(x: any, spec: Spec, depth = 0): any {
  if (!x || typeof x !== "object" || depth > 6) return x;
  if (Array.isArray(x)) return x.map((y) => inline(y, spec, depth));
  if (x.kind === "call") {
    const p = spec.decls.find((d) => d.kind === "predicate" && d.name === x.name);
    if (p && p.params.length === (x.args ?? []).length) {
      const by = new Map<string, any>(p.params.map((q: any, i: number) => [q.name, x.args[i]]));
      const sub = (y: any): any => (!y || typeof y !== "object" ? y : Array.isArray(y) ? y.map(sub) : y.kind === "name" && by.has(y.name) ? by.get(y.name) : Object.fromEntries(Object.entries(y).map(([k, v]) => [k, k === "pos" ? v : sub(v)])));
      return inline(sub(p.body), spec, depth + 1);
    }
  }
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "pos" ? v : inline(v, spec, depth)]));
}

// ---- each declaration's conditions, before and after
type Site = { role: "admits" | "blocks" | "selects" | "runs" | "branches"; where: string; x: any };
// a declaration as both versions call it (a trigger by what it's on, a workflow by its event)
const keyOf = (d: Decl) =>
  d.kind === "trigger" ? `trigger on ${d.on.kind === "event" ? d.on.event : `${d.on.kind} ${d.on.entity}${d.on.field ? `.${d.on.field}` : ""}`}` : d.kind === "workflow" ? d.name : `${d.kind} ${d.name}`;
const KINDS = new Set(["predicate", "gate", "permission", "action", "view", "screen", "component", "layout", "trigger", "workflow", "fn"]);
function sites(d: Decl): Site[] {
  const out: Site[] = [];
  if (d.kind === "predicate") out.push({ role: "admits", where: "", x: d.body });
  if (d.kind === "gate") out.push({ role: "blocks", where: "", x: d.cond });
  if (d.kind === "permission") out.push({ role: "admits", where: "", x: d.cond });
  if (d.kind === "trigger" && d.when) out.push({ role: "runs", where: "", x: d.when });
  for (const r of d.requires ?? []) if (r?.cond) out.push({ role: "admits", where: "require", x: r.cond });
  const walk = (x: any): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.kind === "require" && x.cond) out.push({ role: "admits", where: "require", x: x.cond });
    else if (x.kind === "if" && x.cond) out.push({ role: "branches", where: "if", x: x.cond });
    else if (x.where && typeof x.where === "object" && x.entity) out.push({ role: "selects", where: `${x.kind === "deleteWhere" ? "delete" : x.kind === "query" ? x.op : "rows"} ${x.entity}`, x: x.where });
    for (const [k, v] of Object.entries(x)) if (k !== "pos" && k !== "cond" && k !== "where") walk(v);
    if (x.kind === "if" && x.cond) walk(x.cond);
  };
  walk(d.kind === "predicate" || d.kind === "gate" || d.kind === "permission" ? null : d.kind === "workflow" ? d.steps : d.body);
  return out;
}
// where two versions of a declaration first differ: the path to the smallest part that does, and
// the part before and after (an expression as the spec writes it)
function whatChanged(a: any, b: any): string {
  const strip = (x: any) => JSON.stringify(x, (k, v) => (k === "pos" ? undefined : v));
  const show = (x: any) => (x && typeof x === "object" && typeof x.kind === "string" && x.kind !== "el" ? showExpr(x) : typeof x === "object" ? (Array.isArray(x) ? `${x.length} item(s)` : "…") : JSON.stringify(x));
  const path: string[] = [];
  for (let i = 0; i < 40; i++) {
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) break;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== "pos" && strip(a[k]) !== strip(b[k]));
    if (Array.isArray(a) && a.length !== b.length) return `${path.slice(-3).join(".") || "items"}: ${a.length} -> ${b.length} items`;
    if (Array.isArray(a) && keys.length > 1) return `${path.slice(-3).join(".") || "items"}: items ${keys.map((k) => Number(k) + 1).join(", ")} changed`;
    if (keys.length !== 1) break;
    const k = keys[0];
    if (!Array.isArray(a)) path.push(k);
    a = a[k]; b = b[k];
  }
  const shown = (x: any) => { const t = show(x); return t.length > 60 ? `${t.slice(0, 57)}…` : t; };
  return `${path.length ? `${path.slice(-3).join(".")}: ` : ""}${shown(a)} -> ${shown(b)}`;
}
const canon = (d: Decl) => JSON.stringify(d, (k, v) => (k === "pos" || (k === "name" && typeof v === "string" && v.startsWith("trigger@")) ? undefined : v));

// what each change to a condition means, and whether it widens access: a guard (a predicate, a
// permission, a require) that holds in more cases or other ones, or a gate that blocks in fewer
// or other ones
export function logicDiff(oldSpec: Spec, newSpec: Spec): { lines: string[]; widened: boolean } {
  const lines: string[] = [];
  let widened = false;
  const byKey = (s: Spec) => {
    const m = new Map<string, Decl>(), seen = new Map<string, number>();
    for (const d of s.decls) if (KINDS.has(d.kind)) { let k = keyOf(d); const n = seen.get(k) ?? 0; seen.set(k, n + 1); if (n) k += ` (${n + 1})`; m.set(k, d); }
    return m;
  };
  const a = byKey(oldSpec), b = byKey(newSpec);
  // who calls a predicate or function, in the new version
  const callers = (name: string) => newSpec.decls.filter((d) => d.name !== name && JSON.stringify(d.body ?? d.cond ?? d.requires ?? d.steps ?? null).includes(`"kind":"call","name":"${name}"`) || (d.requires && JSON.stringify(d.requires).includes(`"name":"${name}"`))).map(keyOf);
  const otherwise: string[] = [];
  for (const [k, was] of a) {
    const now = b.get(k);
    if (!now || canon(was) === canon(now)) continue;
    const s0 = sites(was), s1 = sites(now);
    let said = false;
    const roles = [...new Set([...s0, ...s1].map((s) => `${s.role}|${s.where}`))];
    for (const rw of roles) {
      const xs = s0.filter((s) => `${s.role}|${s.where}` === rw), ys = s1.filter((s) => `${s.role}|${s.where}` === rw);
      const [role, where] = rw.split("|") as [Site["role"], string];
      const at = where ? `${k}, ${where}` : k;
      // a declaration's requires all hold at once: compared joined, shown by the ones that differ.
      // Others: the ones unchanged set aside, the rest each against its own (by order), or, if
      // their number changed, listed as gone and new
      const shownOf = (s: Site[]) => s.map((x) => showExpr(x.x));
      if (where === "require") {
        const r = relate(positional(inline(all(xs.map((x) => x.x)), oldSpec), was), positional(inline(all(ys.map((y) => y.x)), newSpec), now));
        const [tx, ty] = [shownOf(xs), shownOf(ys)];
        const gone = tx.filter((t) => !ty.includes(t)), added = ty.filter((t) => !tx.includes(t));
        if (!gone.length && !added.length) continue;
        said = true;
        if (r === "same") { lines.push(`${at}s hold in the same cases, written another way: was ${gone.join("; ") || "none"}, now ${added.join("; ") || "none"}`); continue; }
        if (r !== "fewer") widened = true;
        lines.push(`${r !== "fewer" ? "WIDER   " : ""}${at}s admit ${r === "fewer" ? "fewer" : r === "more" ? "more" : "others"}: ${gone.length ? `was ${gone.join("; ")}` : "none removed"}, ${added.length ? `now ${added.join("; ")}` : "none added"}`);
        continue;
      }
      const tys = shownOf(ys), txs = shownOf(xs);
      const xs2 = xs.filter((x, i) => { const j = tys.indexOf(txs[i]); if (j < 0) return true; tys[j] = "\u0000"; return false; });
      const tx2 = shownOf(xs), ys2 = ys.filter((y) => { const j = tx2.indexOf(showExpr(y.x)); if (j < 0) return true; tx2[j] = "\u0000"; return false; });
      if (!xs2.length && !ys2.length) continue;
      const pairs: [any, any][] = xs2.length === ys2.length ? xs2.map((x, i) => [x.x, ys2[i].x]) : [[all(xs2.map((x) => x.x)), all(ys2.map((y) => y.x))]];
      if (xs2.length !== ys2.length && role !== "admits" && role !== "blocks") { said = true; const gone = xs2, added = ys2;
        for (const x of gone) lines.push(`${at}: no longer ${where === "if" ? "an if on" : "where"} ${showExpr(x.x)}`);
        for (const y of added) lines.push(`${at}: new ${where === "if" ? "if on" : "where"} ${showExpr(y.x)}`);
        continue; }
      for (const [x, y] of pairs) {
        const tx = showExpr(x), ty = showExpr(y);
        if (tx === ty) continue;
        const r = relate(positional(inline(x, oldSpec), was), positional(inline(y, newSpec), now));
        said = true;
        if (r === "same") { lines.push(`${at} holds in the same cases, written another way: was ${tx}, now ${ty}`); continue; }
        const was_now = `was ${tx}, now ${ty}`;
        const how = { admits: { fewer: "admits fewer", more: "admits more", other: "admits others" }, blocks: { fewer: "blocks fewer", more: "blocks more", other: "blocks others" }, selects: { fewer: "selects fewer rows", more: "selects more rows", other: "selects other rows" }, runs: { fewer: "runs for fewer", more: "runs for more", other: "runs for others" }, branches: { fewer: "takes this branch in fewer cases", more: "takes this branch in more cases", other: "takes this branch in other cases" } }[role][r];
        const wider = (role === "admits" && r !== "fewer") || (role === "blocks" && r !== "more");
        if (wider) widened = true;
        const users = was.kind === "predicate" ? callers(was.name) : [];
        const guards = users.length ? ` (it guards ${users.slice(0, 4).join(", ")}${users.length > 4 ? ` and ${users.length - 4} more` : ""})` : "";
        lines.push(`${wider ? "WIDER   " : ""}${at} ${how}: ${was_now}${guards}`);
      }
    }
    if (!said) otherwise.push(`${k} (${whatChanged(was, now)})`);
  }
  for (const o of otherwise) lines.push(`changed, no condition: ${o}`);
  return { lines, widened };
}

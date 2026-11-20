// Tests (docs/testing.md): what the parser makes of `test "…" { … }`. Each `expect <condition>` and
// `wait <duration>` becomes a query function of the rows the test made before it (__test_<t>_<s>),
// so the checks, the types and the loading rules read it as any other code, and the app is
// compiled with it; the runner (lang/spectest.ts) calls it through the app's /_test/spec. The
// names a test makes are typed by what made them: a create by its entity, a run's `as x` by the
// action's result (the row its `result` names) or the type written after it (`as w: Wiki`).
type Decl = { kind: string; name: string; pos: any; [k: string]: any };

const named = (name: string) => ({ kind: "named", name, optional: false });

// the type of what an action's `result` gives, when it names a row the action created or a parameter
export function resultType(action: Decl): any | undefined {
  const created = new Map<string, string>();
  const results: any[] = [];
  const walk = (x: any): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.kind === "create" && x.as) created.set(x.as, x.entity);
    if (x.kind === "result") results.push(x.value);
    for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v);
  };
  walk(action.body);
  const types = new Set<string>();
  for (const r of results) {
    if (r?.kind !== "name") return undefined;
    const p = (action.params ?? []).find((q: any) => q.name === r.name);
    const t = created.get(r.name) ?? (p?.type?.kind === "named" ? p.type.name : undefined);
    if (!t) return undefined;
    types.add(t);
  }
  return types.size === 1 ? named([...types][0]) : undefined;
}

// the names an expression reads (not .fields, not a query's own rows)
function namesIn(x: any, out = new Set<string>()): Set<string> {
  if (!x || typeof x !== "object") return out;
  if (Array.isArray(x)) { x.forEach((y) => namesIn(y, out)); return out; }
  if (x.kind === "name" && typeof x.name === "string") out.add(x.name);
  for (const [k, v] of Object.entries(x)) if (k !== "pos") namesIn(v, out);
  return out;
}

export function testDecls(decls: Decl[]): Decl[] {
  const out: Decl[] = [];
  const actions = new Map(decls.filter((d) => d.kind === "action").map((d) => [d.name, d]));
  decls.filter((d) => d.kind === "test").forEach((t, ti) => {
    const types = new Map<string, any>();
    t.steps.forEach((s: any, si: number) => {
      if (s.kind === "create") types.set(s.save, named(s.entity));
      if (s.kind === "run" && s.save) {
        const ty = s.saveType ?? (actions.has(s.call) ? resultType(actions.get(s.call)!) : undefined);
        if (ty) { types.set(s.save, { ...ty, optional: false }); s.savedEntity = ty.name; }
        else s.untyped = true;   // check: TEST_RESULT_TYPE
      }
      if (s.kind === "expect" || s.kind === "wait") {
        const body = s.kind === "expect" ? s.cond : s.value;
        const used = [...namesIn(body)].filter((n) => types.has(n));
        s.fn = `__test_${ti}_${si}`;
        s.refs = used;
        const params = used.map((n) => ({ name: n, type: types.get(n), pos: s.pos }));
        out.push(s.kind === "expect"
          ? { kind: "predicate", name: s.fn, params, body, queries: true, test: t.name, pos: s.pos }
          : { kind: "fn", name: s.fn, params, returns: named("Duration"), body, queries: true, test: t.name, pos: s.pos });
      }
    });
  });
  return out;
}

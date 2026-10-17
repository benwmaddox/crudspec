// Sizes: how long a text value may be. Declared once (`name: Text max 80 min 1`, on a field
// or a parameter) and used everywhere: the interpreter and the compiled app refuse a value
// that doesn't fit, the database refuses it too, the agent API's schemas say so, and the UI's
// inputs get the same maxlength. Lengths count characters (Unicode code points), as SQLite's
// length() does, so the app and the database always agree. A browser's maxlength counts UTF-16
// units, which is never less: the form can only be the stricter one.
import type { Decl, Spec } from "./parser.ts";

// sizes a type has unless the spec says otherwise (the standards' limits)
export const DEFAULT_MAX: Record<string, number> = { Email: 254, Url: 2048, Ip: 45 };
const SIZED = new Set(["Text", "Email", "Url", "Ip", "Password", "RichText"]);

export type Size = { max?: number; min?: number };

export const textLength = (s: string): number => { let n = 0; for (const _ of s) n++; return n; };   // code points, as SQLite's length()

export function fieldSize(f: any): Size {
  if (f?.type?.kind !== "named" || !SIZED.has(f.type.name)) return {};
  return { max: f.max ?? DEFAULT_MAX[f.type.name], min: f.min };
}

// A parameter's size: what it declares, else the tightest of the fields it is stored into
// directly (`create E { f: p }`, `set x.f = p`), else its type's default.
export function paramSizes(spec: Spec): Map<Decl, Map<string, Size>> {
  const ents = new Map(spec.decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => [d.name, d]));
  const out = new Map<Decl, Map<string, Size>>();
  for (const a of spec.decls.filter((d) => d.kind === "action")) {
    const m = new Map<string, Size>();
    for (const p of a.params) if (p.type.kind === "named" && SIZED.has(p.type.name)) m.set(p.name, { max: p.max ?? DEFAULT_MAX[p.type.name], min: p.min });
    const tighten = (pn: string, s: Size) => {
      const p = a.params.find((x: any) => x.name === pn);
      if (!p || p.max !== undefined || !m.has(pn)) return;
      const cur = m.get(pn)!;
      m.set(pn, { max: s.max === undefined ? cur.max : cur.max === undefined ? s.max : Math.min(cur.max, s.max), min: s.min === undefined ? cur.min : Math.max(cur.min ?? 0, s.min) });
    };
    const walk = (ss: any[]) => { for (const st of ss ?? []) {
      if (st.kind === "create") { const e = ents.get(st.entity); for (const f of st.fields) if (f.value.kind === "name") { const fd = e?.fields.find((x: any) => x.name === f.name); if (fd) tighten(f.value.name, fieldSize(fd)); } }
      if (st.kind === "set" && st.value.kind === "name") {
        // the target's entity, when it is a parameter, a create's `as` or a singleton
        const t = st.target;
        const ent = t.kind === "name" ? (ents.has(t.name) ? t.name : (a.params.find((p: any) => p.name === t.name)?.type?.name)) : undefined;
        const fd = ent ? ents.get(ent)?.fields.find((x: any) => x.name === st.name) : undefined;
        if (fd) tighten(st.value.name, fieldSize(fd));
      }
      if (st.then) walk(st.then); if (st.else) walk(st.else); if (st.body) walk(st.body);
    } };
    walk(a.body);
    out.set(a, m);
  }
  return out;
}

// what is wrong with a value for a size, or null
export function sizeProblem(v: unknown, s: Size, what: string): string | null {
  if (v === null || v === undefined) return null;
  const text = typeof v === "string" ? v : typeof v === "object" && v !== null && "rich" in v ? String((v as any).rich) : null;
  if (text === null) return null;
  const n = textLength(text);
  if (s.max !== undefined && n > s.max) return `${what} is longer than ${s.max} characters`;
  if (s.min !== undefined && n < s.min) return `${what} is shorter than ${s.min} characters`;
  return null;
}

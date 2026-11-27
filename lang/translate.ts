// Translation (app { languages ["en", "es"] } and translations "es" { "Sign in": "Iniciar sesión" }):
// the text a person reads on a page, found here, keyed by the text as the spec writes it. The first
// language is the spec's own; each other is the same app under /<lang>/ (gogen/rt/translate.go).
//
// What is translated is text in places people read it, written literally in the spec:
//   - an element's text, and <Title> and <Description> (with {…} in it a template: "Hello {n}!");
//   - the attributes label, placeholder, title, alt, aria-label, text and confirm;
//   - an <On …>'s flash.
// Other strings (a class, a comparison such as sort == "title", a route) aren't text people read,
// and aren't translated. The generated /_admin isn't either: it is for whoever runs the app.
import type { Spec } from "./parser.ts";
import { showExpr } from "./review.ts";
import { ADMIN } from "./admin.ts";

export const TRANSLATED_ATTRS = new Set(["label", "placeholder", "title", "alt", "aria-label", "text", "confirm"]);

// the runtime's own words a page may show, translated by the same blocks (rt/translate.go)
export const RUNTIME_TEXT = [
  "Next", "Back to the start", "Leave this empty", "No changes yet.", "the app", "created it", "deleted it", "set", "from", "to", "nothing", "(private)", "(a new password)",
  "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "AM", "PM",
];

export type Piece = { key: string; node: any; kind: "lit" | "interp"; pos: any; decl: string };

// the app's languages, the spec's own first; [] when it says none
export function languagesOf(spec: Spec): string[] {
  const app: any = spec.decls.find((d) => d.kind === "app");
  const l: any = app?.props.languages;
  if (!l || l.kind !== "listlit") return [];
  return l.items.filter((x: any) => x.kind === "lit" && typeof x.value === "string").map((x: any) => x.value);
}

const hasWords = (t: string) => /\p{L}/u.test(t);

// a template's key: its text with each {…} as the spec writes it
export function templateKey(parts: any[]): string {
  // ({…} in a quoted string is text(…) of the code: shown as the code)
  const code = (p: any) => (p.kind === "call" && p.name === "text" && p.interp ? p.args[0] : p);
  return parts.map((p: any) => (p.kind === "lit" && typeof p.value === "string" ? p.value : `{${showExpr(code(p))}}`)).join("");
}
// a translation's side as its key: the text, with each {…} as code
export const exprKey = (e: any): string => {
  if (e?.kind === "interp") return templateKey(e.parts);
  if (e?.kind === "binary" && e.op === "+") { const p = flatParts(e); if (p) return templateKey(p); }
  return String(e?.value ?? "");
};
// "a {x} b" in quotes, as the parser gives it (a + of its pieces): the pieces, or null for another +
export function flatParts(e: any): any[] | null {
  if (e?.kind === "binary" && e.op === "+") { const l = flatParts(e.left), r = flatParts(e.right); return l && r ? [...l, ...r] : null; }
  if (e?.kind === "lit" && typeof e.value === "string") return [e];
  if (e?.kind === "call" && e.name === "text" && e.interp) return [e];
  return null;
}
export const placeholders = (t: string) => [...t.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]).sort();

// every piece of text a person reads, in the app's screens, components and layouts (and the
// account and invitation screens it is given), each with the node the generator translates
export function translatable(decls: any[]): Piece[] {
  const out: Piece[] = [];
  const take = (v: any, decl: string) => {
    if (!v || typeof v !== "object") return;
    if (v.kind === "lit" && typeof v.value === "string" && hasWords(v.value)) out.push({ key: v.value, node: v, kind: "lit", pos: v.pos, decl });
    else if (v.kind === "interp" && v.parts?.some((p: any) => p.kind === "lit" && typeof p.value === "string" && hasWords(p.value))) out.push({ key: templateKey(v.parts), node: v, kind: "interp", pos: v.pos, decl });
  };
  const walk = (x: any, decl: string): void => {
    if (Array.isArray(x)) { for (const y of x) walk(y, decl); return; }
    if (!x || typeof x !== "object") return;
    if (x.kind === "el") {
      if (x.name === "text" || x.name === "title" || x.name === "description") take(x.head, decl);
      for (const [k, v] of Object.entries(x.attrs ?? {})) if (TRANSLATED_ATTRS.has(k)) take(v, decl);
      if (x.name === "on") for (const r of x.head?.reactions ?? []) if (r.kind === "flash") take(r.value, decl);
    }
    for (const [k, v] of Object.entries(x)) if (k !== "pos" && k !== "head" && k !== "attrs") walk(v, decl);
    // an element's head may hold content (an if's branches are its children): walk what isn't a piece
    if (x.kind === "el" && x.head && typeof x.head === "object" && !["text", "title", "description"].includes(x.name)) walk(x.head, decl);
  };
  for (const d of decls) {
    if (!["screen", "component", "layout"].includes(d.kind) || d.generated === ADMIN) continue;
    walk(d.body, `${d.kind} ${d.name}`);
  }
  return out;
}

// the translations each language has: language -> key -> text
export function translationsOf(spec: Spec): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const d of spec.decls as any[]) {
    if (d.kind !== "translations") continue;
    const m = out.get(d.lang) ?? new Map<string, string>();
    for (const e of d.entries) m.set(exprKey(e.key), exprKey(e.value));
    out.set(d.lang, m);
  }
  return out;
}

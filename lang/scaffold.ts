// Default screens for what an app's own screens don't cover, written as ordinary crudspec UI
// source. The runtime adds them at start, under /_auto, so a new action or view works in the
// UI with no UI code; `cli scaffold` prints the same source to copy into the spec and edit.
//   - every action no screen, API route or channel offers: a form, one field per parameter;
//   - every row view no screen lists: a list of its rows;
//   - /_auto: an index of them.
import type { Spec, Decl } from "./parser.ts";
import { check } from "./check.ts";

const human = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const q = (s: string) => JSON.stringify(s);

export function scaffold(spec: Spec): string {
  const decls = spec.decls;
  const layout = decls.find((d) => d.kind === "layout");
  if (!layout) return "";
  const slots: string[] = [];
  const walk = (x: any): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk); if (x.name === "slot" && x.head) slots.push(typeof x.head === "string" ? x.head : x.head.name); for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v); };
  walk(layout.body);
  const slot = slots.includes("main") ? "main" : slots[0];
  if (!slot) return "";
  const entities = new Set(decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => d.name));
  const enums = new Map(decls.filter((d) => d.kind === "enum").map((d) => [d.name, d.values as string[]]));
  const used = new Set(decls.filter((d) => d.kind === "screen").map((d) => d.name));
  const uncovered = new Set(check(spec).filter((f) => f.code === "ACTION_UNREACHABLE").map((f) => f.where.replace(/^action /, "")));
  // theme classes { generated_section: "card" }: the class generated sections get
  const theme = decls.find((d) => d.kind === "theme");
  const sectionClass = theme?.props?.classes?.fields?.generated_section?.value;
  const section = typeof sectionClass === "string" ? `section class=${q(sectionClass)}` : "section";
  const ui = JSON.stringify(decls.filter((d) => ["screen", "component", "layout"].includes(d.kind)), (k, v) => (k === "pos" ? undefined : v));

  const field = (p: any): string => `<field ${fieldBody(p)} label=${q(human(p.name))} />`;
  const fieldBody = (p: any): string => {
    const t = p.type, opt = t.kind === "named" && t.optional, req = opt ? "" : " required";
    const lbl = ` placeholder=${q(human(p.name))}`;
    const f = (kind: string) => `name=${p.name} kind=${kind}`;
    if (t.kind === "set") return `${f("users")} from={list(it for ${t.of} where true)}`;
    if (entities.has(t.name)) return `${f("select")} from={list(it for ${t.name} where true)}${req}`;
    if (enums.has(t.name)) return `${f("choice")} from={[${enums.get(t.name)!.join(", ")}]}${req}`;
    switch (t.name) {
      case "Bool": return `${f("choice")} from={[true, false]}`;
      case "Int": return `${f("number")}${lbl}${req}`;
      case "Time": return `${f("datetime")}${lbl}${req}`;
      case "Email": return `${f("email")}${lbl}${req}`;
      case "Url": return `${f("url")}${lbl}${req}`;
      case "Password": return `${f("password")}${lbl}${req}`;
      case "RichText": return `${f("textarea")}${lbl}${req}`;
      case "File": return f("file");
      default: return `${f("text")}${lbl}${req}`;
    }
  };

  const out: string[] = [];
  const index: string[] = [];
  for (const a of decls.filter((d) => d.kind === "action" && uncovered.has(d.name))) {
    const name = `auto_${a.name}`;
    if (used.has(name)) continue;
    index.push(`      <link to={${name}()}><text>{${q(human(a.name))}}</text></link>`);
    out.push(`screen ${name} "/_auto/actions/${a.name}" layout ${layout.name} {
  <title>{${q(human(a.name))}}</title>
  <${slot}>
    <${section}>
      <heading>{${q(human(a.name))}}</heading>
      <form action={${a.name}}>
${a.params.map((p: any) => `        ${field(p)}`).join("\n")}
        <submit label=${q(human(a.name))} />
        <on ok stay flash="Done." />
      </form>
    </section>
  </${slot}>
}`);
  }
  const views: string[] = [];
  for (const v of decls.filter((d) => d.kind === "view" && d.rows && !ui.includes(`"name":${q(d.name)}`))) {
    const name = `auto_view_${v.name}`;
    if (used.has(name)) continue;
    const params = v.params.map((p: any) => `${p.name}: ${p.type.kind === "set" ? `set of ${p.type.of}` : p.type.name + (p.type.optional ? "?" : "")}`);
    const required = v.params.filter((p: any) => !(p.type.kind === "named" && p.type.optional));
    if (!required.length) views.push(`      <link to={${name}()}><text>{${q(human(v.name))}}</text></link>`);
    else views.push(`      <text>{${q(`${human(v.name)}: open with ${required.map((p: any) => p.name).join(", ")} (/_auto/views/${v.name}/…)`)}}</text>`);
    const route = `/_auto/views/${v.name}${required.map((p: any) => `/:${p.name}`).join("")}`;
    out.push(`screen ${name} ${q(route)}${params.length ? ` (${params.join(", ")})` : ""} layout ${layout.name} {
  <title>{${q(human(v.name))}}</title>
  <${slot}>
    <${section}>
      <heading>{${q(human(v.name))}}</heading>
      <list of={${v.name}(${v.params.map((p: any) => p.name).join(", ")})} as=r>
        <row><text>{r}</text></row>
      </list>
    </section>
  </${slot}>
}`);
  }
  if (!out.length) return "";
  out.push(`screen auto_index "/_auto" layout ${layout.name} {
  <title>Everything else</title>
  <${slot}>
    <${section}>
      <heading>Actions without a screen of their own</heading>
${index.join("\n") || `      <text>None</text>`}
      <heading>Views without a screen of their own</heading>
${views.join("\n") || `      <text>None</text>`}
    </section>
  </${slot}>
}`);
  return `// Generated by crudspec (lang/scaffold.ts): default screens for what the spec's own screens\n// don't cover. Copy any of them into the spec to customise it.\n\n${out.join("\n\n")}\n`;
}

// Adds the generated screens to a parsed spec, with the app's own navigation: the home
// screen's other slots (nav, sidebar, …) are copied into each generated screen.
export function withGenerated(spec: Spec, parse: (src: string) => Spec): Spec {
  const src = scaffold(spec);
  if (!src) return spec;
  const generated = parse(src).decls;
  const home = spec.decls.find((d) => d.kind === "screen" && d.route === "/" && !(d.params ?? []).length);
  for (const g of generated) {
    if (g.kind !== "screen" || !home) continue;
    const have = new Set(g.body.map((e: any) => e.name));
    for (const e of home.body) if (e.kind === "el" && e.name !== "title" && !have.has(e.name)) g.body.unshift(structuredClone(e));
  }
  spec.decls.push(...generated);
  return spec;
}

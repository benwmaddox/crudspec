// Default screens for what an app's own screens don't cover, written as ordinary crudspec UI
// source. The runtime adds them at start, under /_auto, so a new action or view works in the
// UI with no UI code; `cli scaffold` prints the same source to copy into the spec and edit.
//   - every action no screen, API route or channel offers (callers api aside): a form, one field per parameter;
//   - every row view no screen lists (callers api aside: those are for agents): a list of its rows;
//   - /_auto: an index of them.
import type { Spec, Decl } from "./parser.ts";
import { check } from "./check.ts";
import { TAG_OF, pascal } from "./parser.ts";
import { withAdmin } from "./admin.ts";

const human = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const q = (s: string) => JSON.stringify(s);

// A form field for a parameter of this type: the kind and the choices a person fills it in with.
export function formField(p: any, entities: Set<string>, enums: Map<string, string[]>, extra = ""): string {
  return `<Field ${fieldBody(p, entities, enums)}${extra} label=${q(human(p.name))} />`;
}
function fieldBody(p: any, entities: Set<string>, enums: Map<string, string[]>): string {
  const t = p.type, opt = t.kind === "named" && t.optional, req = opt ? "" : " required";
  const f = (kind: string) => `name=${p.name} kind=${kind}`;
  if (t.kind === "set") return `${f("users")} from={list(it for ${t.of} where true)}`;
  if (entities.has(t.name)) return `${f("select")} from={list(it for ${t.name} where true)}${req}`;
  if (enums.has(t.name)) return `${f("choice")} from={[${enums.get(t.name)!.join(", ")}]}${req}`;
  switch (t.name) {
    case "Bool": return f("checkbox");
    case "Int": return `${f("number")}${req}`;
    case "Time": return `${f("datetime")}${req}`;
    case "Email": return `${f("email")}${req}`;
    case "Url": return `${f("url")}${req}`;
    case "Password": return `${f("password")}${req}`;
    case "RichText": return `${f("textarea")}${req}`;
    case "File": return f("file");
    default: return `${f("text")}${req}`;
  }
}

// The layout and slot generated screens use, and the class their sections get; null when the app has no layout with a slot.
export function shell(spec: Spec): { layout: string; slotTag: string; section: string } | null {
  const layout = spec.decls.find((d) => d.kind === "layout");
  if (!layout) return null;
  const slots: string[] = [];
  const walk = (x: any): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk); if (x.name === "slot" && x.head) slots.push(typeof x.head === "string" ? x.head : x.head.name); for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v); };
  walk(layout.body);
  const slot = slots.includes("main") ? "main" : slots[0];
  if (!slot) return null;
  const theme = spec.decls.find((d) => d.kind === "theme");
  const sectionClass = theme?.props?.classes?.fields?.generated_section?.value;
  return { layout: layout.name, slotTag: `Fill name=${slot}`, section: typeof sectionClass === "string" ? `section class=${q(sectionClass)}` : "section" };
}
export { human };

export function scaffold(spec: Spec): string {
  const decls = spec.decls;
  const layout = decls.find((d) => d.kind === "layout");
  if (!layout) return "";
  const slots: string[] = [];
  const walk = (x: any): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) return x.forEach(walk); if (x.name === "slot" && x.head) slots.push(typeof x.head === "string" ? x.head : x.head.name); for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v); };
  walk(layout.body);
  const slot = slots.includes("main") ? "main" : slots[0];
  if (!slot) return "";
  const slotTag = `Fill name=${slot}`;   // a screen fills a slot with <Fill name=main>
  const entities = new Set(decls.filter((d) => d.kind === "entity" || d.kind === "data").map((d) => d.name));
  const enums = new Map(decls.filter((d) => d.kind === "enum").map((d) => [d.name, d.values as string[]]));
  const used = new Set(decls.filter((d) => d.kind === "screen").map((d) => d.name));
  const uncovered = new Set(check(spec).filter((f) => f.code === "ACTION_UNREACHABLE").map((f) => f.where.replace(/^action /, "")));
  // theme classes { generated_section: "card" }: the class generated sections get
  const theme = decls.find((d) => d.kind === "theme");
  const sectionClass = theme?.props?.classes?.fields?.generated_section?.value;
  const section = typeof sectionClass === "string" ? `section class=${q(sectionClass)}` : "section";
  const ui = JSON.stringify(decls.filter((d) => ["screen", "component", "layout"].includes(d.kind)), (k, v) => (k === "pos" ? undefined : v));

  const field = (p: any): string => formField(p, entities, enums);

  const out: string[] = [];
  const index: string[] = [];
  for (const a of decls.filter((d) => d.kind === "action" && uncovered.has(d.name))) {
    const name = `auto_${a.name}`;
    if (used.has(name)) continue;
    index.push(`      <Link to={${name}()}><span>{${q(human(a.name))}}</span></Link>`);
    out.push(`screen ${name} {
  route "/_auto/actions/${a.name}"
  layout ${layout.name}
  <Title>{${q(human(a.name))}}</Title>
  <${slotTag}>
    <${section}>
      <h1>{${q(human(a.name))}}</h1>
      <Form action={${a.name}}>
${a.params.map((p: any) => `        ${field(p)}`).join("\n")}
        <Submit label=${q(human(a.name))} />
        <On ok stay flash="Done." />
      </Form>
    </section>
  </Fill>
}`);
  }
  const views: string[] = [];
  for (const v of decls.filter((d) => d.kind === "view" && d.rows && !d.noPeople && !ui.includes(`"name":${q(d.name)}`))) {   // callers api: agents only, so no screen
    const name = `auto_view_${v.name}`;
    if (used.has(name)) continue;
    const params = v.params.map((p: any) => `${p.name}: ${p.type.kind === "set" ? `set of ${p.type.of}` : p.type.name + (p.type.optional ? "?" : "")}`);
    const required = v.params.filter((p: any) => !(p.type.kind === "named" && p.type.optional));
    if (!required.length) views.push(`      <Link to={${name}()}><span>{${q(human(v.name))}}</span></Link>`);
    else views.push(`      <span>{${q(`${human(v.name)}: open with ${required.map((p: any) => p.name).join(", ")} (/_auto/views/${v.name}/…)`)}}</span>`);
    const route = `/_auto/views/${v.name}${required.map((p: any) => `/:${p.name}`).join("")}`;
    out.push(`screen ${name}${params.length ? `(${params.join(", ")})` : ""} {
  route ${q(route)}
  layout ${layout.name}
  <Title>{${q(human(v.name))}}</Title>
  <${slotTag}>
    <${section}>
      <h1>{${q(human(v.name))}}</h1>
      <List of={${v.name}(${v.params.map((p: any) => p.name).join(", ")})} as=r>
        <div><span>{r}</span></div>
      </List>
    </section>
  </Fill>
}`);
  }
  if (!out.length) return "";
  out.push(`screen auto_index {
  route "/_auto"
  layout ${layout.name}
  <Title>Everything else</Title>
  <${slotTag}>
    <${section}>
      <h1>Actions without a screen of their own</h1>
${index.join("\n") || `      <span>None</span>`}
      <h1>Views without a screen of their own</h1>
${views.join("\n") || `      <span>None</span>`}
    </section>
  </Fill>
}`);
  return `// Generated by crudspec (lang/scaffold.ts): default screens for what the spec's own screens\n// don't cover. Copy any of them into the spec to customise it.\n\n${out.join("\n\n")}\n`;
}

// Adds the generated screens to a parsed spec, with the app's own navigation: the home
// screen's other slots (nav, sidebar, …) are copied into each generated screen.
export function withGenerated(spec: Spec, parse: (src: string) => Spec): Spec {
  // the admin section first (when the app has one): the default screens then see its actions as offered
  const admin = withAdmin(spec, parse);
  spec.decls.push(...admin);
  const src = scaffold(spec);
  const generated = [...admin, ...(src ? parse(src).decls : [])];
  const home = spec.decls.find((d) => d.kind === "screen" && d.route === "/" && !(d.params ?? []).length);
  for (const g of generated) {
    if (g.kind !== "screen" || !home) continue;
    const have = new Set(g.body.map((e: any) => e.name));
    for (const e of home.body) if (e.kind === "el" && e.name !== "title" && !have.has(e.name)) g.body.unshift(structuredClone(e));
  }
  spec.decls.push(...generated.filter((g) => !admin.includes(g)));
  return spec;
}

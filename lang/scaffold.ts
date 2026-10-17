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
  // theme classes json { generated_section: "card" }: the class generated sections get
  const theme = decls.find((d) => d.kind === "theme");
  const sectionClass = theme?.props?.classes?.fields?.generated_section?.value;
  const section = typeof sectionClass === "string" ? `section class ${q(sectionClass)}` : "section";
  const ui = JSON.stringify(decls.filter((d) => ["screen", "component", "layout"].includes(d.kind)), (k, v) => (k === "pos" ? undefined : v));

  const field = (p: any): string => `${fieldBody(p)} label ${q(human(p.name))}`;
  const fieldBody = (p: any): string => {
    const t = p.type, opt = t.kind === "named" && t.optional, req = opt ? "" : " required";
    const lbl = ` placeholder ${q(human(p.name))}`;
    if (t.kind === "set") return `field ${p.name} users from list(${t.of} where true : it)`;
    if (entities.has(t.name)) return `field ${p.name} select from list(${t.name} where true : it)${req}`;
    if (enums.has(t.name)) return `field ${p.name} choice from [${enums.get(t.name)!.join(", ")}]${req}`;
    switch (t.name) {
      case "Bool": return `field ${p.name} choice from [true, false]`;
      case "Int": return `field ${p.name} number${lbl}${req}`;
      case "Email": return `field ${p.name} email${lbl}${req}`;
      case "Url": return `field ${p.name} url${lbl}${req}`;
      case "Password": return `field ${p.name} password${lbl}${req}`;
      case "RichText": return `field ${p.name} textarea${lbl}${req}`;
      case "File": return `field ${p.name} file`;
      default: return `field ${p.name} text${lbl}${req}`;
    }
  };

  const out: string[] = [];
  const index: string[] = [];
  for (const a of decls.filter((d) => d.kind === "action" && uncovered.has(d.name))) {
    const name = `auto_${a.name}`;
    if (used.has(name)) continue;
    index.push(`      link ${name}() { text ${q(human(a.name))} }`);
    out.push(`screen ${name} "/_auto/actions/${a.name}" layout ${layout.name} {
  title ${q(human(a.name))}
  ${slot} {
    ${section} {
      heading ${q(human(a.name))}
      form ${a.name} {
${a.params.map((p: any) => `        ${field(p)}`).join("\n")}
        submit label ${q(human(a.name))}
        on ok stay flash "Done."
      }
    }
  }
}`);
  }
  const views: string[] = [];
  for (const v of decls.filter((d) => d.kind === "view" && d.rows && !ui.includes(`"name":${q(d.name)}`))) {
    const name = `auto_view_${v.name}`;
    if (used.has(name)) continue;
    const params = v.params.map((p: any) => `${p.name}: ${p.type.kind === "set" ? `set of ${p.type.of}` : p.type.name + (p.type.optional ? "?" : "")}`);
    const required = v.params.filter((p: any) => !(p.type.kind === "named" && p.type.optional));
    if (!required.length) views.push(`      link ${name}() { text ${q(human(v.name))} }`);
    else views.push(`      text ${q(`${human(v.name)}: open with ${required.map((p: any) => p.name).join(", ")} (/_auto/views/${v.name}/…)`)}`);
    const route = `/_auto/views/${v.name}${required.map((p: any) => `/:${p.name}`).join("")}`;
    out.push(`screen ${name} ${q(route)}${params.length ? ` (${params.join(", ")})` : ""} layout ${layout.name} {
  title ${q(human(v.name))}
  ${slot} {
    ${section} {
      heading ${q(human(v.name))}
      list ${v.name}(${v.params.map((p: any) => p.name).join(", ")}) as r {
        row { text r }
      }
    }
  }
}`);
  }
  if (!out.length) return "";
  out.push(`screen auto_index "/_auto" layout ${layout.name} {
  title "Everything else"
  ${slot} {
    ${section} {
      heading "Actions without a screen of their own"
${index.join("\n") || `      text "None"`}
      heading "Views without a screen of their own"
${views.join("\n") || `      text "None"`}
    }
  }
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

// What the editor offers about a place in a spec: what it is (hover), where it is declared
// (definition), and what can be written there (completion). It reads the app's declarations
// from its files' text, and the language's elements, attributes, field kinds, outcomes and
// builtins from `cli.ts reference --json`; no VS Code here, so lang/test/editor.test.ts runs it.
"use strict";
const { tokens } = require("./highlight");

const DECL = /^[ \t]*(?:internal[ \t]+|native[ \t]+)?(entity|singleton|data|enum|action|view|screen|component|layout|fn|predicate|widget|extern[ \t]+fn|signal|channel|gate|identity|workflow[ \t]+on|theme|api)[ \t]+([A-Za-z_]\w*)/;

// the app's declarations: kind, name, file, line (0-based), its first line, and the comment above it
function declarations(files) {
  const out = [];
  for (const [file, text] of files) {
    const lines = text.split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = DECL.exec(l);
      if (!m) return;
      const doc = [];
      for (let j = i - 1; j >= 0 && /^\s*\/\//.test(lines[j]); j--) doc.unshift(lines[j].replace(/^\s*\/\/\s?/, ""));
      out.push({ kind: m[1].replace(/\s+/g, " "), name: m[2], file, line: i, col: l.indexOf(m[2]), signature: l.replace(/\s*\/\/.*$/, "").replace(/\s*\{\s*$/, "").trim(), doc: doc.join(" ") });
    });
  }
  return out;
}

// the token at an offset, and the tag it is in (for an attribute)
function at(src, offset) {
  const ts = tokens(src);
  const t = ts.find((x) => x.start <= offset && offset <= x.end && x.kind !== "br" && x.kind !== "p");
  if (!t) return undefined;
  let tag;
  if (t.kind === "attr" || (t.kind === "name" && src[t.start - 1] === "=")) {
    for (let i = ts.indexOf(t) - 1; i >= 0; i--) if (ts[i].kind === "tag" || ts[i].kind === "html") { tag = src.slice(ts[i].start, ts[i].end); break; }
  }
  return { ...t, word: src.slice(t.start, t.end), tag };
}

const elementOf = (ref, name) => ref?.elements?.find((e) => e.name === name);
const attrOf = (ref, tag, name) => elementOf(ref, tag)?.attributes.find((a) => a.name === name) ?? ref?.common_attributes?.find((a) => a.name === name);

// markdown for what is at offset, or undefined
function hover(src, offset, ref, decls) {
  const t = at(src, offset);
  if (!t) return undefined;
  if (t.kind === "tag") {
    const el = elementOf(ref, t.word);
    if (el) return `**<${el.name}>** — ${el.about}${el.attributes.length ? `\n\n${el.attributes.map((a) => `- \`${a.name}\`${a.flag ? " (bare)" : ""}: ${a.about}`).join("\n")}` : ""}`;
    const c = ref?.std_components?.find((x) => x.name === t.word);
    if (c) return `**<${c.name}>** — ${c.about} (standard library)`;
  }
  if (t.kind === "attr" && t.tag) {
    const a = attrOf(ref, t.tag, t.word);
    if (a) return `**${t.word}** on <${t.tag}>${a.flag ? " (bare)" : ""}: ${a.about}`;
  }
  if (t.kind === "name" && t.tag && /\bkind=$/.test(src.slice(Math.max(0, t.start - 5), t.start))) {
    const k = ref?.field_kinds?.find((x) => x.name === t.word);
    if (k) return `**${k.name}** field: ${k.about}`;
  }
  const d = decls.find((x) => x.name === t.word);
  if (d) return "```crudspec\n" + d.signature + "\n```" + (d.doc ? `\n\n${d.doc}` : "");
  const b = ref?.builtins?.find((x) => x.name === t.word);
  if (b) return `**${b.name}** (builtin): ${b.about}`;
  const o = ref?.outcomes?.find((x) => x.name === t.word);
  if (o && /\belse\s+$/.test(src.slice(Math.max(0, t.start - 8), t.start))) return `**${o.name}** outcome: ${o.about}`;
  if (t.kind === "tag") {   // a component the app declares
    const c = decls.find((x) => x.kind === "component" && x.name === t.word);
    if (c) return "```crudspec\n" + c.signature + "\n```" + (c.doc ? `\n\n${c.doc}` : "");
  }
  return undefined;
}

// where the name at offset is declared: { file, line, col }, or undefined
function definition(src, offset, decls) {
  const t = at(src, offset);
  if (!t || !["tag", "fn", "type", "name", "attr"].includes(t.kind)) return undefined;
  const d = decls.find((x) => x.name === t.word);
  return d && { file: d.file, line: d.line, col: d.col };
}

// what can be written at offset: [{ label, kind, detail }], kind one of element, attribute,
// value, outcome, declaration, builtin
function completions(src, offset, ref, decls) {
  const before = src.slice(Math.max(0, src.lastIndexOf("\n", offset - 1) + 1), offset);
  const tagStart = /<\/?([A-Za-z]*)$/.exec(before);
  if (tagStart) {   // a tag: built-ins and components (capitalised), and HTML's (lowercase)
    const html = (ref?.html_elements ?? []).map((e) => ({ label: e.name, kind: "element", detail: `HTML <${e.name}>${e.void ? " (void)" : ""}` }));
    if (/^[a-z]/.test(tagStart[1])) return html;
    return [
      ...(ref?.elements ?? []).map((e) => ({ label: e.name, kind: "element", detail: e.about })),
      ...(ref?.std_components ?? []).map((c) => ({ label: c.name, kind: "element", detail: c.about })),
      ...decls.filter((d) => d.kind === "component" || d.kind === "layout").map((d) => ({ label: d.name, kind: "element", detail: d.doc || d.signature })),
      ...(tagStart[1] ? [] : html),
    ];
  }
  // inside an HTML tag, after a space: its attributes and HTML's global ones
  const openHtml = /<([a-z][\w-]*)\b(?:[^<>{}"]|"[^"]*"|\{[^{}]*\})*\s[a-z_-]*$/.exec(before);
  if (openHtml) {
    const el = (ref?.html_elements ?? []).find((e) => e.name === openHtml[1]);
    return [...(el?.attributes ?? []), ...(ref?.html_common_attributes ?? [])].map((a) => ({ label: a.name, kind: "attribute", detail: `HTML <${openHtml[1]}>${a.flag ? " (bare)" : ""}` }));
  }
  if (/\bkind=[a-z_]*$/.test(before)) return (ref?.field_kinds ?? []).map((k) => ({ label: k.name, kind: "value", detail: k.about }));
  if (/\belse\s+[a-z_]*$/.test(before)) return (ref?.outcomes ?? []).map((o) => ({ label: o.name, kind: "outcome", detail: o.about }));
  // inside a tag, after a space: its attributes
  const open = /<([A-Z][\w-]*)\b(?:[^<>{}"]|"[^"]*"|\{[^{}]*\})*\s[a-z_]*$/.exec(before);
  if (open) {
    const el = elementOf(ref, open[1]);
    const comp = decls.find((d) => d.kind === "component" && d.name === open[1]);
    const params = comp ? [...comp.signature.matchAll(/([a-z_]\w*)\s*:/g)].map((m) => ({ label: m[1], kind: "attribute", detail: `${comp.name}'s parameter` })) : [];
    return [...(el?.attributes ?? []).map((a) => ({ label: a.name, kind: "attribute", detail: a.about })), ...params, ...(ref?.common_attributes ?? []).map((a) => ({ label: a.name, kind: "attribute", detail: a.about }))];
  }
  return [
    ...decls.filter((d) => !["theme", "api", "workflow on"].includes(d.kind)).map((d) => ({ label: d.name, kind: "declaration", detail: d.signature })),
    ...(ref?.builtins ?? []).map((b) => ({ label: b.name, kind: "builtin", detail: b.about })),
  ];
}

// the fixes a finding offers: { title, edits: [{ line, start, end, text }] } (replace columns
// start..end of that line with text). A "did you mean X?" names its fix (for a tag, its closing
// tag too); so do a few findings that say what to add. lines: the file's lines
function quickFixes(p, lines) {
  const out = [], lineText = lines[p.line] ?? "";
  const m = /did you mean (?:\{)?([A-Za-z_][\w]*)(?: …\})?\?/.exec(p.message);
  if (m && p.end > p.start) {
    const word = lineText.slice(p.start, p.end), lead = /^[<.]/.test(word) ? 1 : 0, name = word.slice(lead);
    const edits = [{ line: p.line, start: p.start + lead, end: p.end, text: m[1] }];
    // a tag: its closing tag, the first </name> after it that closes it (counting ones opened between)
    if (lead || lineText[p.start - 1] === "<") {
      let depth = 0;
      for (let l = p.line, c = p.end; l < lines.length && depth >= 0; l++, c = 0) {
        const re = new RegExp("<(/?)" + name + "(?![\w-])", "g"); re.lastIndex = c;
        for (let t; (t = re.exec(lines[l])); ) {
          if (!t[1]) { if (!/\/>/.test(lines[l].slice(t.index, lines[l].indexOf(">", t.index) + 1))) depth++; continue; }
          if (depth-- === 0) { edits.push({ line: l, start: t.index + 2, end: t.index + 2 + name.length, text: m[1] }); break; }
        }
      }
    }
    out.push({ title: "Change to " + m[1], edits });
  }
  if (p.code === "AGENTS_NO_UNSTATED") {
    // after the action's {, on a line of its own
    for (let l = p.line; l < Math.min(lines.length, p.line + 3); l++) {
      const brace = lines[l].indexOf("{");
      if (brace < 0) continue;
      const indent = /^\s*/.exec(lines[p.line])[0] + "  ";
      out.push({ title: "Add agents no", edits: [{ line: l, start: brace + 1, end: brace + 1, text: "\n" + indent + "agents no" }] });
      break;
    }
  }
  return out;
}

module.exports = { declarations, hover, definition, completions, at, quickFixes };

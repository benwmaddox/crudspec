// Converts a spec's UI from the old line-based syntax to TSX-style markup. Expressions are
// copied as written (their source text, recorded by old-parser.ts); comments in UI blocks are
// kept. Then the new parser must give the same nodes as the old one did.
//   node .scratch/conv/convert.ts <spec.crud> [--write]
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseOld, lex } from "./old-parser.ts";
import { parse as parseNew } from "../../lang/parser.ts";

const [file, flag] = process.argv.slice(2);
const src = readFileSync(file, "utf8");
const spec = parseOld(src);
const comps = new Map(spec.decls.filter((d: any) => d.kind === "component").map((d: any) => [d.name, d]));

const HEAD: Record<string, string> = {};
for (const n of ["heading", "text", "strong", "richtext", "time", "image", "icon", "avatar", "avatars", "field_display"]) HEAD[n] = "expr";
for (const n of ["link", "go"]) HEAD[n] = "to";
for (const n of ["button", "form"]) HEAD[n] = "action";
for (const n of ["use", "widget", "channel", "signal"]) HEAD[n] = "call";
Object.assign(HEAD, { title: "expr?", field: "field", on: "on", list: "list", each: "each", if: "if", let: "let", slot: "name", aside: "name?" });

// comments, by line
const lines = src.split("\n");
const comments = new Map<number, { text: string; alone: boolean }>();
lines.forEach((l, i) => {
  let q = false;
  for (let j = 0; j < l.length - 1; j++) {
    if (l[j] === '"' && l[j - 1] !== "\\") q = !q;
    if (!q && l[j] === "/" && l[j + 1] === "/") { comments.set(i + 1, { text: l.slice(j).trimEnd(), alone: l.slice(0, j).trim() === "" }); break; }
  }
});
const used = new Set<number>();
const out: string[] = [];
const commentsBefore = (line: number, ind: string, from: number) => {
  for (let l = from; l < line; l++) { const c = comments.get(l); if (c && c.alone && !used.has(l)) { used.add(l); out.push(ind + c.text); } }
};

const S = (e: any) => { if (e?.__src === undefined) throw new Error("no source for " + JSON.stringify(e).slice(0, 120)); return e.__src; };
const attr = (name: string, v: any) => v === true ? name : v.kind === "lit" && typeof v.value === "string" ? `${name}=${S(v)}` : `${name}={${S(v)}}`;

function element(el: any, ind: string): void {
  const kind = HEAD[el.name] ?? "none";
  let tag = el.name;
  const a: string[] = [];
  let content: string | undefined;
  const h = el.head;
  switch (kind) {
    case "expr": content = S(h); break;
    case "expr?": if (h) content = S(h); break;
    case "to": a.push(h.kind === "url" ? `href={${S(h.value)}}` : `to={${S(h)}}`); break;
    case "action": a.push(`action={${S(h)}}`); break;
    case "field": a.push(`name="${h.name}"`, `kind="${h.kind}"`); break;
    case "on":
      a.push(h.outcome);
      for (const r of h.reactions) a.push(r.kind === "go" ? `go={${S(r.target)}}` : r.value ? attr(r.kind, r.value) : r.kind);
      break;
    case "list":
      a.push(`of={${S(h.source)}}`, `as="${h.bind}"`);
      if (h.where) a.push(`where={${S(h.where)}}`);
      if (h.order) a.push(`order={${S(h.order)}}`);
      if (h.desc) a.push("desc");
      break;
    case "each": a.push(`as="${h.bind}"`, `in={${S(h.over)}}`); break;
    case "if": a.push(`test={${S(h)}}`); break;
    case "let": a.push(`name="${h.name}"`, `value={${S(h.value)}}`); break;
    case "name": a.push(`name="${h}"`); break;
    case "name?": if (h) a.push(`name="${h}"`); break;
    case "call":
      if (el.name === "use") {
        tag = h.name;
        const c: any = comps.get(h.name);
        if (!c) throw new Error("unknown component " + h.name);
        h.args.forEach((x: any, i: number) => a.push(`${c.params[i].name}={${S(x)}}`));
        for (const [k, v] of Object.entries(h.named)) a.push(`${k}={${S(v)}}`);
      } else a.push(`call={${S(h)}}`);
      break;
  }
  for (const [k, v] of Object.entries(el.attrs)) a.push(attr(k, v));
  const c = comments.get(el.pos.line);
  const trail = c && !c.alone && !used.has(el.pos.line) ? (used.add(el.pos.line), "  " + c.text) : "";
  const open = `<${tag}${a.length ? " " + a.join(" ") : ""}`;
  if (content !== undefined) { out.push(`${ind}${open}>{${content}}</${tag}>${trail}`); }
  else if (!el.children.length) out.push(`${ind}${open} />${trail}`);
  else {
    out.push(`${ind}${open}>${trail}`);
    block(el.children, ind + "  ");
    out.push(`${ind}</${tag}>`);
  }
  if (el.name === "if" && el.else) elses(el.else, ind);
}
function elses(alt: any[], ind: string) {
  if (alt.length === 1 && alt[0].name === "if" && !Object.keys(alt[0].attrs).length) {
    const e = alt[0];
    const c = comments.get(e.pos.line);
    const trail = c && !c.alone && !used.has(e.pos.line) ? (used.add(e.pos.line), "  " + c.text) : "";
    out.push(`${ind}<else test={${S(e.head)}}>${trail}`); block(e.children, ind + "  "); out.push(`${ind}</else>`);
    if (e.else) elses(e.else, ind);
  } else { out.push(`${ind}<else>`); block(alt, ind + "  "); out.push(`${ind}</else>`); }
}
let lastLine = 0;
function block(els: any[], ind: string) {
  for (const el of els) { commentsBefore(el.pos.line, ind, lastLine + 1); lastLine = Math.max(lastLine, el.pos.line); element(el, ind); }
}

// each UI body: from its "{" to the matching "}"
const toks: any[] = lex(src);
const edits: { s: number; e: number; text: string }[] = [];
for (const d of spec.decls as any[]) {
  if (!["screen", "component", "layout"].includes(d.kind)) continue;
  let i = toks.findIndex((t) => t.pos.line === d.pos.line && t.pos.col === d.pos.col);
  while (!(toks[i].t === "p" && toks[i].v === "{")) i++;
  let depth = 0, j = i;
  for (; j < toks.length; j++) { if (toks[j].t === "p" && toks[j].v === "{") depth++; if (toks[j].t === "p" && toks[j].v === "}" && --depth === 0) break; }
  const s = toks[i].pos.off, e = toks[j].pos.end, endLine = toks[j].pos.line;
  out.length = 0; lastLine = toks[i].pos.line;
  for (const r of d.requires ?? []) {
    out.push(`  require ${S(r.cond)} else ${r.go ? `go ${S(r.go)}${r.flash ? ` flash ${S(r.flash)}` : ""}` : r.outcome}`);
    lastLine = Math.max(lastLine, r.pos.line);
  }
  block(d.body, "  ");
  commentsBefore(endLine, "  ", lastLine + 1);
  const oc = comments.get(toks[i].pos.line);
  const openTrail = oc && !oc.alone && !used.has(toks[i].pos.line) ? (used.add(toks[i].pos.line), "  " + oc.text) : "";
  edits.push({ s, e, text: "{" + openTrail + "\n" + out.join("\n") + "\n}" });
}
let next = src;
for (const ed of edits.sort((x, y) => y.s - x.s)) next = next.slice(0, ed.s) + ed.text + next.slice(ed.e);

writeFileSync(file + ".converted", next);
// the same nodes, from the new parser
const strip = (x: any) => JSON.stringify(x, (k, v) => (k === "pos" ? undefined : v));
const before = strip(spec.decls), after = strip(parseNew(next).decls);
if (before !== after) {
  let i = 0; while (i < before.length && before[i] === after[i]) i++;
  console.error("DIFFERENT NODES at " + i + ":\n old " + before.slice(i - 200, i + 200) + "\n new " + after.slice(i - 200, i + 200));
  writeFileSync(file + ".converted", next);
  process.exit(1);
}
const lost = [...comments.keys()].filter((l) => !used.has(l) && comments.get(l)!.alone === false && edits.some(() => true)).length;
console.log(`${file}: same nodes; ${edits.length} UI bodies converted; ${src.length} -> ${next.length} chars`);
if (flag === "--write") writeFileSync(file, next); else writeFileSync(file + ".converted", next);

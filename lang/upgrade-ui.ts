// The UI pass of upgrade-syntax. Before v3 the built-in wrapper elements were written capitalised
// (<Row>, <Text>, …), screens filled layouts with <Main>, <Nav>, <Footer>, <Sidebar>, and a layout's
// holes were <Content>. Current specs write plain HTML, <Fill name=…> and <Slot name=…>:
//   <Row>, <Column>, <Heading>, <Menu>, <Dialog>, <Frame>, <Section>, <Strong>, <Text>
//                                     -> the HTML tag, class from the theme's classes { row, … } when it has one
//   <Dialog banned={c}>               -> class={"…" + (if c { " banned" } else { "" })}
//   <Dialog legend={x}>               -> <fieldset>… <legend><strong>{x}</strong></legend> …</fieldset>
//   in a screen:  <Main>…</Main>      -> <Fill name=main>…</Fill>   (also Nav, Footer, Sidebar)
//   in a layout:  <Main>, <Nav>, <Footer>, <Sidebar>, <Aside>  -> <main>, <nav>, <footer>, <aside>, <aside>
//   <Content name=x /> and <Content /> -> <Slot name=x /> and <Slot />
// A tag it cannot rewrite is reported with its file and line, and the text is left as it was.
// It runs on the joined text of a directory (cli.ts marks where each file starts), so a theme's
// classes come from any file in it.

export type Finding = { where: string; message: string };
export type UiUpgraded = { text: string; counts: Record<string, number>; unsupported: Finding[]; notes: string[] };
type Counts = Record<string, number>;
type Ctx = { theme: Map<string, string>; own: Set<string>; report: (off: number, message: string) => void };

class UiError extends Error {
  off: number;
  constructor(message: string, off: number) { super(message); this.off = off; }
}

// the built-in element -> [HTML tag, theme class key]
const WRAP: Record<string, [string, string | null]> = {
  Text: ["span", null], Row: ["div", "row"], Column: ["div", "column"], Heading: ["h1", "heading"],
  Strong: ["strong", null], Section: ["section", null], Dialog: ["div", null], Frame: ["div", null], Menu: ["menu", "menu"],
};
const WRAP_ATTRS = ["class", "id", "banned", "legend", "title"];
const SCREEN_SLOTS: Record<string, string> = { Main: "main", Nav: "nav", Footer: "footer", Sidebar: "sidebar" };
const LAYOUT_TAGS: Record<string, string> = { Main: "main", Nav: "nav", Footer: "footer", Sidebar: "aside", Aside: "aside" };
const MARK = /^\/\/ @@crudspec-upgrade-file (\d+)\s*$/;

// "file 2, line 14" for an offset in the joined text (line 1 is the first line after a file's marker)
function locator(src: string): (off: number) => string {
  const marks: { off: number; file: number; line: number }[] = [];
  let off = 0;
  src.split("\n").forEach((ln, i) => {
    const m = MARK.exec(ln);
    if (m) marks.push({ off, file: Number(m[1]), line: i + 1 });
    off += ln.length + 1;
  });
  return (at) => {
    const line = src.slice(0, at).split("\n").length;
    let mk: { file: number; line: number } | null = null;
    for (const x of marks) if (x.off <= at) mk = x;
    return mk ? `file ${mk.file}, line ${line - mk.line}` : `line ${line}`;
  };
}

// the index of the "}" that closes the "{" at i, or -1
function closeBrace(s: string, i: number): number {
  let d = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === "{") d++;
    else if (s[k] === "}") { d--; if (d === 0) return k; }
  }
  return -1;
}

// the index of the ">" that ends the tag whose attributes start at i (quotes and braces skipped)
function tagEnd(s: string, i: number): number {
  let depth = 0, str = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (str) { if (c === "\\") k++; else if (c === '"') str = false; continue; }
    if (c === '"') { str = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return k;
  }
  throw new UiError("the tag is not closed", i);
}

type Attr = { name: string; value: string | null; from: number; to: number };
// the attributes of a tag's text: value as written ("…" or {…}), null for a flag
function attrsOf(t: string, off: number): Attr[] {
  const out: Attr[] = [];
  let i = 0;
  while (i < t.length) {
    if (/\s/.test(t[i]) || t[i] === "/") { i++; continue; }
    const from = i;
    while (i < t.length && /[A-Za-z0-9_-]/.test(t[i])) i++;
    const name = t.slice(from, i);
    if (!name) throw new UiError(`cannot read the attribute at ${JSON.stringify(t.slice(from, from + 20))}`, off + from);
    let value: string | null = null;
    if (t[i] === "=") {
      i++;
      if (t[i] === '"') {
        const a = i; i++;
        while (i < t.length && t[i] !== '"') { if (t[i] === "\\") i++; i++; }
        i++; value = t.slice(a, i);
      } else if (t[i] === "{") {
        const a = i; let d = 0, st = false;
        for (; i < t.length; i++) {
          const c = t[i];
          if (st) { if (c === "\\") i++; else if (c === '"') st = false; continue; }
          if (c === '"') st = true;
          else if (c === "{") d++;
          else if (c === "}") { d--; if (d === 0) { i++; break; } }
        }
        value = t.slice(a, i);
      } else throw new UiError(`the value of ${name} is not "…" or {…}`, off + i);
    }
    out.push({ name, value, from, to: i });
  }
  return out;
}
const braceInner = (v: string) => (v.startsWith("{") ? v.slice(1, -1) : v);   // {expr} -> expr

// <Row> … </Row> and the rest of the built-in elements
function wrapPass(s: string, ctx: Ctx): { text: string; counts: Counts } {
  const counts: Counts = {};
  const re = new RegExp(`<(/?)(${Object.keys(WRAP).join("|")})(?![A-Za-z0-9_])`, "g");
  const stack: { name: string; close: string | null; off: number }[] = [];
  let out = "", pos = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    const name = m[2];
    if (ctx.own.has(name)) continue;   // the app's own component of that name, not the old built-in
    if (m[1]) {
      const end = s.indexOf(">", m.index);
      const top = stack.pop();
      if (!top || top.name !== name) throw new UiError(`</${name}> does not match ${top ? `<${top.name}>` : "any open tag"}`, m.index);
      out += s.slice(pos, m.index) + (top.close ?? s.slice(m.index, end + 1));
      pos = end + 1; re.lastIndex = pos;
      continue;
    }
    const e = tagEnd(s, m.index + m[0].length);
    const selfClose = s[e - 1] === "/";
    const attrText = s.slice(m.index + m[0].length, selfClose ? e - 1 : e);
    const attrs = attrsOf(attrText, m.index + m[0].length);
    const unknown = attrs.find((a) => !WRAP_ATTRS.includes(a.name) && !a.name.startsWith("data-"));
    if (unknown) {
      // keep this tag as it is; the rest of the file still gets its rewrites
      ctx.report(m.index, `<${name} ${unknown.name}=…> has no rewrite; write the HTML by hand`);
      out += s.slice(pos, e + 1); pos = e + 1; re.lastIndex = pos;
      if (!selfClose) stack.push({ name, close: null, off: m.index });
      continue;
    }
    const get = (n: string) => attrs.find((a) => a.name === n);
    const cls = get("class"), banned = get("banned"), legend = get("legend");
    for (const a of [cls, banned, legend]) if (a && a.value === null) throw new UiError(`${a.name} needs a value`, m.index);
    if (banned && banned.value!.startsWith('"')) throw new UiError(`banned="…" is a quoted literal; write banned={…}`, m.index);
    const [tag, key] = WRAP[name];
    const base = cls ? cls.value! : key && ctx.theme.has(key) ? JSON.stringify(ctx.theme.get(key)) : null;
    let classAttr = "";
    if (banned) classAttr = ` class={${base ? braceInner(base) : '""'} + (if ${braceInner(banned.value!)} { " banned" } else { "" })}`;
    else if (base) classAttr = ` class=${base}`;
    const rest = attrs.filter((a) => !["class", "banned", "legend"].includes(a.name)).map((a) => ` ${attrText.slice(a.from, a.to)}`).join("");
    const outTag = legend ? "fieldset" : tag;
    const legendHtml = legend ? `<legend><strong>{${braceInner(legend.value!)}}</strong></legend>` : "";
    counts[name] = (counts[name] ?? 0) + 1;
    out += s.slice(pos, m.index);
    if (selfClose) {
      out += legend ? `<${outTag}${classAttr}${rest}>${legendHtml}</${outTag}>` : `<${outTag}${classAttr}${rest} />`;
      pos = e + 1; re.lastIndex = pos;
      continue;
    }
    out += `<${outTag}${classAttr}${rest}>${legendHtml}`; pos = e + 1; re.lastIndex = pos;
    stack.push({ name, close: `</${outTag}>`, off: m.index });
  }
  if (stack.length) { const top = stack[stack.length - 1]; throw new UiError(`<${top.name}> is never closed`, top.off); }
  out += s.slice(pos);
  return { text: out, counts };
}

// <Main>, <Nav>, <Footer>, <Sidebar>, <Aside>: fills in a screen, HTML tags in a layout
function slotPass(s: string, ctx: Ctx): { text: string; counts: Counts } {
  const counts: Counts = {};
  const layouts: [number, number][] = [];
  for (const m of s.matchAll(/^[ \t]*layout [A-Za-z_]\w* \{/gm)) {
    const end = closeBrace(s, m.index + m[0].length - 1);
    if (end < 0) throw new UiError("the layout is not closed", m.index);
    layouts.push([m.index, end]);
  }
  const inLayout = (p: number) => layouts.some(([a, b]) => p >= a && p <= b);
  const re = /<(\/?)(Main|Nav|Footer|Sidebar|Aside)(?![A-Za-z0-9_])/g;
  let out = "", pos = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    const [whole, slash, name] = m;
    if (ctx.own.has(name)) continue;
    const lay = inLayout(m.index);
    if (name === "Aside" && !lay) continue;   // a screen's Aside is a component; left alone
    let end: number, rest = "", selfClose = false;
    if (slash) end = s.indexOf(">", m.index);
    else {
      end = tagEnd(s, m.index + whole.length);
      selfClose = s[end - 1] === "/";
      rest = s.slice(m.index + whole.length, end);   // includes the " /" of a self-closing tag
      if (name === "Aside" && !/^\s*(name=[A-Za-z_]\w*)?\s*\/?\s*$/.test(rest)) throw new UiError("<Aside …> in a layout takes only name=…; write <aside> by hand", m.index);
      counts[name] = (counts[name] ?? 0) + 1;
    }
    let rep: string;
    if (lay) rep = slash ? `</${LAYOUT_TAGS[name]}>` : `<${LAYOUT_TAGS[name]}${name === "Aside" ? (selfClose ? " /" : "") : rest}>`;
    else rep = slash ? "</Fill>" : `<Fill name=${SCREEN_SLOTS[name]}${rest}>`;
    out += s.slice(pos, m.index) + rep;
    pos = end + 1; re.lastIndex = pos;
  }
  out += s.slice(pos);
  return { text: out, counts };
}

// <Content name=x /> and <Content /> (the holes of an old layout) -> <Slot …>
function contentPass(s: string, ctx: Ctx): { text: string; counts: Counts } {
  const counts: Counts = {};
  const re = /<(\/?)Content(?![A-Za-z0-9_])/g;
  let out = "", pos = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    if (m[1]) continue;   // a closing tag belongs to an opening tag reported below
    const end = tagEnd(s, m.index + m[0].length);
    if (s[end - 1] !== "/") { ctx.report(m.index, "<Content> with children has no rewrite; write <Slot name=…> by hand"); continue; }
    counts.Content = (counts.Content ?? 0) + 1;
    out += s.slice(pos, m.index) + "<Slot";
    pos = m.index + m[0].length;
    re.lastIndex = pos;
  }
  out += s.slice(pos);
  return { text: out, counts };
}

export function upgradeUi(src: string): UiUpgraded {
  const where = locator(src);
  const unsupported: Finding[] = [];
  const report = (off: number, message: string) => unsupported.push({ where: where(off), message });
  const theme = new Map<string, string>();
  for (const m of src.matchAll(/\bclasses \{/g)) {
    const j = m.index + "classes ".length;
    const k = closeBrace(src, j);
    if (k < 0) { report(m.index, "classes { … } is not closed"); continue; }
    for (const [, key, val] of src.slice(j, k).matchAll(/([a-z_]+):\s*"([^"]*)"/g)) {
      const had = theme.get(key);
      if (had !== undefined && had !== val) report(m.index, `classes { ${key}: "${val}" } differs from "${had}" in an earlier block; make them the same`);
      else theme.set(key, val);
    }
  }
  const own = new Set([...src.matchAll(/component ([A-Z]w*)/g)].map((m) => m[1]));
  const ctx: Ctx = { theme, own, report };
  const counts: Counts = {};
  let text = src;
  for (const pass of [wrapPass, slotPass, contentPass]) {
    try {
      const r = pass(text, ctx);
      text = r.text;
      for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
    } catch (e) {
      if (!(e instanceof UiError)) throw e;
      report(e.off, e.message);   // this pass changes nothing; the others still run
    }
  }
  // the theme classes of kinds that are plain HTML now (heading, column, menu) are refused by the checker: dropped (row stays: Switch uses it)
  if (!unsupported.length) text = text.replace(/(classes \{[^}]*})/g, (blk) => blk.replace(/\s*(heading|column|menu):\s*"[^"]*",?/g, ""));
  const notes: string[] = [];
  if (counts.Text) notes.push(`${counts.Text} <Text> became <span>. A Text showed nothing for a value that is none; a span shows an empty element: wrap an optional value as {if x != none { <span>{x}</span> }}. A quoted word inside {if …} blocks of a former Text now shows its quotes (the checker warns UI_TEXT_QUOTED): write it bare.`);
  return { text: unsupported.length ? src : text, counts, unsupported, notes };
}

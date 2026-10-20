// What a generated statement reads, for live pages, worked out when the app is generated: the
// same answer rt's parseWhere (live.go) gives for `SELECT … FROM table t0 WHERE <where>`, so a
// statement function records its reads with typed calls instead of parsing its SQL at run time.
// The app checks the two agree for every statement when it starts in test mode
// (rt.CheckLiveKeys).
export type LiveKey = { table: string; col: string; arg: number; cols?: string[] };

const isWord = (c: string | undefined) => !!c && /[_a-zA-Z0-9".]/.test(c);
const isWordStart = (s: string, i: number) => /[_a-zA-Z]/.test(s[i]) && (i === 0 || !isWord(s[i - 1]));
const metaCol = (s: string) => {
  for (const c of ["seq", "created", "updated"]) if (s.startsWith("." + c) && (s.length === c.length + 1 || !isWord(s[c.length + 1]))) return c;
  return "";
};
const negated = (src: string, i: number) => {
  let j = i;
  while (j > 0 && src[j - 1] === " ") j--;
  return j >= 3 && src.slice(j - 3, j).toUpperCase() === "NOT" && (j === 3 || !isWord(src[j - 4]));
};

export function liveKeys(table: string, where: string): LiveKey[] {
  type Group = { parent: Group | null; or: boolean; neg: boolean };
  type Frame = { alias: string; table: string; base: Group; cands: { key: LiveKey; g: Group }[]; col: string; lookup: LiveKey | null; self: boolean; cols: string[] };
  const root: Group = { parent: null, or: false, neg: false };
  const frames: Frame[] = [{ alias: "t0", table, base: root, cands: [], col: "", lookup: null, self: false, cols: [] }];
  let g = root, arg = 0;
  const src = where;
  const byAlias = (a: string) => { for (let i = frames.length - 1; i >= 0; i--) if (frames[i].alias === a) return frames[i]; return null; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'") {
      for (i++; i < src.length; i++) { if (src[i] === "'") { if (src[i + 1] === "'") { i++; continue; } break; } }
    } else if (ch === "(") {
      g = { parent: g, or: false, neg: negated(src, i) };
    } else if (ch === ")") {
      for (const f of frames) if (f.base === g && f.col !== "" && (src.startsWith(" IS ?", i + 1) || src.startsWith(" = ?", i + 1))) f.lookup = { table: f.table, col: f.col, arg };
      if (g.parent) g = g.parent;
    } else if (ch === "?") {
      arg++;
    } else if (src.startsWith('FROM "', i)) {
      const j = src.indexOf('"', i + 6) - (i + 6);
      if (j < 0) continue;
      const name = src.slice(i + 6, i + 6 + j);
      const rest = src.slice(i + 6 + j + 1).replace(/^ +/, "");
      const k0 = rest.search(/[ )]/);
      const alias = k0 >= 0 ? rest.slice(0, k0) : rest;
      const f: Frame = { alias, table: name, base: g, cands: [], col: "", lookup: null, self: false, cols: [] };
      const before = src.slice(0, i), k = before.lastIndexOf('(SELECT "');
      if (k >= 0 && before.endsWith('" ')) { const c = src.slice(k + 9, i - 2); if (!/[" (),]/.test(c)) f.col = c; }
      frames.push(f);
      i += 6 + j;
    } else if (src.startsWith(" OR ", i)) {
      g.or = true;
      i += 3;
    } else if (isWordStart(src, i)) {
      let j = i;
      while (j < src.length && /[_a-zA-Z0-9]/.test(src[j])) j++;
      const alias = src.slice(i, j);
      let col: string, end: number;
      if (src.startsWith('."', j)) {
        const k = src.indexOf('"', j + 2) - (j + 2);
        if (k < 0) { i = j - 1; continue; }
        col = src.slice(j + 2, j + 2 + k); end = j + 2 + k + 1;
      } else if (src.startsWith(".id", j) && (j + 3 === src.length || !isWord(src[j + 3]))) {
        col = "id"; end = j + 3;
      } else if (metaCol(src.slice(j)) !== "") {
        col = metaCol(src.slice(j)); end = j + 1 + col.length;
      } else { i = j - 1; continue; }
      const f = byAlias(alias);
      if (f && !f.cols.includes(col)) f.cols.push(col);
      const after = src.slice(end);
      if (!f) { /* another query's alias */ }
      else if (after.startsWith(" = ?") || after.startsWith(" IS ?")) f.cands.push({ key: { table: f.table, col, arg }, g });
      else if (col === "id" && after.startsWith(" IN (SELECT value FROM json_each(?))")) f.cands.push({ key: { table: f.table, col: "id[]", arg }, g });
      else if (col === "id" && (after.startsWith(" = ") || after.startsWith(" IS "))) {
        const rhs = after.startsWith(" = ") ? after.slice(3) : after.slice(4);
        const k = rhs.indexOf(".id");
        if (k > 0 && (k + 3 === rhs.length || !isWord(rhs[k + 3]))) {
          const o = byAlias(rhs.slice(0, k));
          if (o && o !== f && o.table === f.table && !/[ ()]/.test(rhs.slice(0, k))) {
            f.self = true;
            if (f.col !== "" && !o.cols.includes(f.col)) o.cols.push(f.col);
          }
        }
      }
      i = end - 1;
    }
  }
  const out: LiveKey[] = [];
  for (const f of frames) {
    if (f.self) continue;
    if (f.lookup) { out.push(f.lookup); continue; }
    let found: LiveKey | null = null;
    for (const c of f.cands) {
      let ok = true;
      for (let x: Group = c.g; ; x = x.parent!) {
        if (x.or || (x.neg && x !== f.base)) { ok = false; break; }
        if (x === f.base || !x.parent) break;
      }
      if (ok) { found = { ...c.key }; break; }
    }
    if (!found) {
      let cols: string[] | undefined = f.cols;
      if ((f === frames[0] && where === "") || f.col !== "") cols = undefined;
      if (f.col !== "") cols = [...f.cols, f.col];
      out.push({ table: f.table, col: "", arg: 0, cols });
    } else out.push(found);
  }
  return out;
}

// as rt.liveKeysText writes a parse, for the startup check
export const liveKeysText = (ks: LiveKey[]) => ks.map((k) => (k.col ? `${k.table}.${k.col}@${k.arg}` : `${k.table}[${(k.cols ?? []).join(",")}]`)).join(";");

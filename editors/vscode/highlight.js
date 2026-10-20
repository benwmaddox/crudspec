// What each part of a crudspec spec is, for colouring: the editor extension's semantic tokens
// and the README picture (docs/readme/render.mjs) both read it, so the two colour alike.
// A small reader of the spec as it is written: code, markup tags, the text between tags, and
// the {…} inside text, which is code again.
//   tokens(src) -> [{ start, end, kind }], in order; what no token covers is plain
// kinds: kw (declaration and statement keywords), ctl (control flow), type (a capitalised name in
// code), fn (a call), name, field (.name), str, num, com, tag (a component's or built-in's tag),
// html (an HTML tag), attr, p (a tag's < > / and =), br (braces), txt (text shown as written)
"use strict";

const KEYWORDS = new Set(["app", "entity", "enum", "data", "permission", "read", "action", "view", "screen", "component", "layout", "route", "access",
  "create", "set", "delete", "require", "else", "if", "for", "each", "in", "let", "match", "rows", "where", "order", "by", "desc", "and", "or", "not",
  "result", "emit", "trigger", "on", "max", "min", "agents", "people", "no", "true", "false", "none",
  "singleton", "identity", "from", "gate", "skip", "predicate", "fn", "extern", "effect", "widget", "signal", "channel", "api", "theme", "workflow",
  "step", "invariant", "display", "avatar", "internal", "native", "migration", "drop", "was", "index", "unique", "rate_limit", "per", "window",
  "limit", "updates", "live", "schedule", "every", "call", "ensure", "touch", "send", "mail", "to", "carries", "requires", "as", "of", "list", "get", "post",
  "put", "patch", "import", "go", "private", "write_only", "implies", "exists", "all", "unless", "around", "first", "last"]);
// the control flow, coloured apart as VS Code colours if and for
const CONTROL = new Set(["if", "else", "for", "each", "in", "match", "require", "result", "emit", "unless"]);
// words that are operators: before a ( they are still keywords, not calls
const OPERATORS = new Set(["and", "or", "not", "implies"]);

function tokens(s) {
  const out = [];
  const tok = (start, end, kind) => { if (end > start) out.push({ start, end, kind }); };
  let i = 0;
  const modes = ["code"];   // code | text (between tags)
  const depth = [];         // brace depth at which each {…} in text began
  let braces = 0;
  const mode = () => modes[modes.length - 1];
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if (mode() === "text") {
      if (rest[0] === "<") { modes.pop(); continue; }                       // a tag: read as code
      if (rest[0] === "{") { tok(i, i + 1, "br"); braces++; depth.push(braces); modes.push("code"); i++; continue; }
      if (rest[0] === "}") { modes.pop(); continue; }
      m = /^[^<{}]+/.exec(rest);
      // a comment in text: // at the start of a line or after a space
      const c = /(^|[ \t])\/\/[^\n]*/.exec(m[0]);
      if (c) { const at = c.index + c[1].length; tokText(i, i + at); tok(i + at, i + c.index + c[0].length, "com"); i += c.index + c[0].length; continue; }
      tokText(i, i + m[0].length); i += m[0].length; continue;
    }
    if ((m = /^\/\/[^\n]*/.exec(rest))) { tok(i, i + m[0].length, "com"); i += m[0].length; continue; }
    if ((m = /^"(?:[^"\\\n]|\\.)*"?/.exec(rest))) { tok(i, i + m[0].length, "str"); i += m[0].length; continue; }
    if ((m = /^<\/?([A-Za-z][\w-]*)/.exec(rest)) && tagAt(s, i)) {
      // a tag and its attributes, up to its ">"
      const closing = m[0].startsWith("</"), lt = closing ? 2 : 1;
      tok(i, i + lt, "p"); tok(i + lt, i + m[0].length, /^[A-Z]/.test(m[1]) ? "tag" : "html"); i += m[0].length;
      for (;;) {
        const r = s.slice(i);
        let a;
        if (!r.length) break;
        if ((a = /^\s+/.exec(r))) { i += a[0].length; continue; }
        if ((a = /^\/?>/.exec(r))) { tok(i, i + a[0].length, "p"); i += a[0].length; if (a[0] === ">" && !closing) modes.push("text"); break; }
        if ((a = /^=[A-Za-z_]\w*/.exec(r))) { tok(i, i + 1, "p"); tok(i + 1, i + a[0].length, "name"); i += a[0].length; continue; }   // a bare name as the value
        if ((a = /^[\w-]+/.exec(r))) { tok(i, i + a[0].length, "attr"); i += a[0].length; continue; }
        if (r[0] === "=") { tok(i, i + 1, "p"); i++; continue; }
        if ((a = /^"(?:[^"\\\n]|\\.)*"?/.exec(r))) { tok(i, i + a[0].length, "str"); i += a[0].length; continue; }
        if (r[0] === "{") {   // a value: code up to its matching }
          let d = 0, j = 0;
          for (; j < r.length; j++) { if (r[j] === "{") d++; else if (r[j] === "}" && --d === 0) break; }
          tok(i, i + 1, "br"); for (const t of tokens(r.slice(1, j))) tok(i + 1 + t.start, i + 1 + t.end, t.kind); tok(i + j, i + j + 1, "br"); i += j + 1; continue;
        }
        i++;
      }
      continue;
    }
    if (rest[0] === "{") { braces++; tok(i, i + 1, "br"); i++; continue; }
    if (rest[0] === "}") {
      if (depth.length && depth[depth.length - 1] === braces) { depth.pop(); braces--; modes.pop(); tok(i, i + 1, "br"); i++; continue; }
      braces--; tok(i, i + 1, "br"); i++; continue;
    }
    const chunk = /^[^"<{}\/]+|^./.exec(rest)[0];
    code(i, chunk); i += chunk.length;
  }
  return out;

  // text as written, without the spaces around it (so a run of layout is no token)
  function tokText(a, b) {
    const t = s.slice(a, b), lead = /^\s*/.exec(t)[0].length, trail = /\s*$/.exec(t)[0].length;
    if (lead < t.length) tok(a + lead, b - trail, "txt");
  }
  // code without tags or braces: keywords, types, numbers, names
  function code(at, c) {
    const re = /\b(\d+)\b|(\.?)\b([A-Za-z_]\w*)\b(?=(\s*\()?)/g;
    let m;
    while ((m = re.exec(c))) {
      const [all, num, dotted, word, call] = m, st = at + m.index;
      if (num) { tok(st, st + all.length, "num"); continue; }
      const w0 = st + dotted.length, w1 = w0 + word.length;
      if (dotted) tok(w0, w1, "field");
      else if (call !== undefined && !CONTROL.has(word) && !OPERATORS.has(word)) tok(w0, w1, "fn");   // a call, or a declared function
      else if (CONTROL.has(word)) tok(w0, w1, "ctl");
      else if (KEYWORDS.has(word)) tok(w0, w1, "kw");
      else if (/^[A-Z]/.test(word)) tok(w0, w1, "type");
      else tok(w0, w1, "name");
    }
  }
}
// "<" starts a tag where a tag can be: not a comparison (a < b), which has a space after it
function tagAt(s, i) { return s[i] === "<" && /[A-Za-z\/]/.test(s[i + 1] ?? ""); }

module.exports = { tokens, KEYWORDS, CONTROL };

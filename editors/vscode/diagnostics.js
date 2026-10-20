// check --json's findings, placed for an editor: per file, a zero-based line and the columns of
// the name the finding is at (or the line's text, when it has no column).
"use strict";
const fs = require("fs");
const path = require("path");

// { [file]: [{ line, start, end, severity, code, message }] }; a finding with no place goes on
// the first line of the app's first file
function place(result, firstFile) {
  const out = {};
  const texts = new Map();
  const lineOf = (file, n) => {
    if (!texts.has(file)) { try { texts.set(file, fs.readFileSync(file, "utf8").split(/\r?\n/)); } catch { texts.set(file, []); } }
    return texts.get(file)[n] ?? "";
  };
  for (const f of result.findings ?? []) {
    const file = f.file ? path.resolve(f.file) : firstFile;
    const line = Math.max(0, (f.fileLine ?? f.line ?? 1) - 1);
    const text = lineOf(file, line);
    let start, end;
    if (f.col) {
      start = f.col - 1;
      // the name there (with a tag's < or a field's .), or one character
      const m = /^[<.]?[A-Za-z_][\w-]*/.exec(text.slice(start));
      end = start + (m ? m[0].length : 1);
    } else {
      start = text.length - text.trimStart().length;
      end = Math.max(start + 1, text.trimEnd().length);
    }
    (out[file] ??= []).push({ line, start, end, severity: f.severity === "error" ? "error" : "warning", code: f.code, message: f.message });
  }
  return out;
}

module.exports = { place };

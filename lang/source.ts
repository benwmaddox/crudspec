// An app's source: every .crud file in its directory, joined in name order. There are no
// imports: a declaration in one file is seen in all of them. A path to one of the files, or to
// the directory, names the app. A one-file app's source is exactly its file, so its line numbers
// are its file's; with more files, at() turns a line of the joined source back into file:line.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type Source = { text: string; files: { path: string; first: number; lines: number }[] };

// the .crud files of the app a path names, in order
export function specFiles(path: string): string[] {
  const dir = statSync(path).isDirectory() ? path : dirname(path);
  const files = readdirSync(dir).filter((f) => f.endsWith(".crud")).sort().map((f) => join(dir, f));
  if (!files.length) throw new Error(`${path}: no .crud files`);
  return files;
}

export function readSource(path: string): Source {
  const files: Source["files"] = [];
  const parts: string[] = [];
  let line = 1;
  for (const f of specFiles(path)) {
    const text = readFileSync(f, "utf8").replace(/\r?\n$/, "");
    const n = text.split("\n").length;
    files.push({ path: f, first: line, lines: n });
    parts.push(text);
    line += n;
  }
  const one = files.length === 1;
  return { text: one ? readFileSync(files[0].path, "utf8") : parts.join("\n") + "\n", files };
}

// the app's source text, as one spec
export function readSpec(path: string): string { return readSource(path).text; }

// where a line of the joined source is: "file.crud:12" (just "12" for a one-file app)
export function at(src: Source, line: number): string {
  if (src.files.length === 1) return String(line);
  const f = src.files.find((x) => line >= x.first && line < x.first + x.lines) ?? src.files[src.files.length - 1];
  return `${basename(f.path)}:${line - f.first + 1}`;
}

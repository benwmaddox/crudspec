// The guide is an index (lang/LANGUAGE.md) and topic files (lang/docs/): every relative markdown link in them, in lang/README.md
// and in the top README.md resolves to a file, and to a heading in it when it names an anchor.
//   node lang/test/docs-links.test.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(String(detail).slice(0, 300)); } };

const root = resolve(import.meta.dirname, "../..");
const files = ["README.md", "lang/README.md", "lang/LANGUAGE.md", ...readdirSync(join(root, "lang/docs")).map((f) => `lang/docs/${f}`)];
const slug = (h: string) => h.toLowerCase().replace(/[`*_]/g, "").replace(/[^a-z0-9 \-]/g, "").trim().replace(/ /g, "-");
const anchors = (path: string): Set<string> => {
  const out = new Set<string>(); let fence = false;
  for (const l of readFileSync(path, "utf8").split("\n")) { if (/^```/.test(l)) fence = !fence; const m = !fence && /^#{1,6} (.*)$/.exec(l); if (m) out.add(slug(m[1])); }
  return out;
};

let checked = 0;
for (const f of files) {
  const path = join(root, f); let fence = false; const bad: string[] = [];
  readFileSync(path, "utf8").split("\n").forEach((l, i) => {
    if (/^```/.test(l)) fence = !fence;
    if (fence) return;
    for (const m of l.replace(/`[^`]*`/g, "").matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [file, anchor] = href.split("#");
      const target = file ? resolve(dirname(path), file) : path;
      checked++;
      if (!existsSync(target)) { bad.push(`${f}:${i + 1} ${href}: no such file`); continue; }
      if (anchor && target.endsWith(".md") && !anchors(target).has(anchor)) bad.push(`${f}:${i + 1} ${href}: no such heading`);
    }
  });
  ok(`${f}: its relative links resolve`, bad.length === 0, bad.slice(0, 5).join(" | "));
}
ok("some links were checked", checked > 15, checked);
process.exit(failed ? 1 : 0);

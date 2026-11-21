// A screen's address parameters arrive decoded once: the server hands routes the decoded path,
// so a title with a % in it ("100% sure"), or one with "%20" in its text, reaches the screen as it
// is, and a link built for it (url_of) comes back to the same title.
//   node lang/test/route-decode.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T" }
layout l { <main><Slot name=main /></main> }
screen doc(path: Text) { route "/docs/:path*"  layout l  require public  <Fill name=main><h1>[{path}]</h1><a class="self" href={url_of(doc(path))}>self</a></Fill> }
`;
const dir = mkdtempSync(join(tmpdir(), "route-decode-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 14051);
const title = async (path: string) => {
  const html = await (await fetch(`${app.base}${path}`)).text();
  return { h1: html.match(/<h1>\[(.*?)\]<\/h1>/)?.[1], self: html.match(/class="self" href="([^"]*)"/)?.[1] };
};
try {
  const plain = await title("/docs/Guides/Getting%20started");
  ok("a title with a space and a slash", plain.h1 === "Guides/Getting started", plain);
  const pct = await title("/docs/Guides/100%25%20AFK");
  ok("a title with a %: as it is, not empty", pct.h1 === "Guides/100% AFK", pct);
  const lit = await title("/docs/a%2520b");
  ok('a title with "%20" in its text keeps it', lit.h1 === "a%20b", lit);
  ok("... and its own link comes back to it", lit.self !== undefined && (await title(lit.self!.replace(/&amp;/g, "&").replace(/^https?:\/\/[^/]+/, ""))).h1 === "a%20b", lit);
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);

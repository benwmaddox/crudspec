// The skip link ("Skip to main content") and the <nav>: written only when the layout fills the
// navigation, so a page with nothing to skip has neither; the link's class is the theme's
// skip_link (Campfire's: skip-navigation btn), not one the runtime picks.
//   node lang/test/skip-link.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T" }
theme t { classes { skip_link: "skip-navigation btn" } }
layout with_nav { <nav><Slot name=nav /></nav> <main><Slot name=main /></main> }
layout plain { <main><Slot name=main /></main> }
screen home { route "/"  layout with_nav  require public  <Fill name=nav><a href="/other">Other</a></Fill> <Fill name=main><p>home</p></Fill> }
screen other { route "/other"  layout plain  require public  <Fill name=main><p>other</p></Fill> }
`;
const dir = mkdtempSync(join(tmpdir(), "skip-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 14006);
try {
  const home = await (await fetch(`${app.base}/`)).text();
  ok("a page with navigation: the skip link, with the theme's class, then the nav", home.includes(`<a href="#main-content" class="skip-navigation btn">Skip to main content</a>`) && home.includes(`<nav id="nav">`) && home.indexOf("Skip to main content") < home.indexOf(`<nav id="nav">`), home.slice(0, 900));
  const other = await (await fetch(`${app.base}/other`)).text();
  ok("a page without: neither (nothing to skip)", !other.includes("Skip to main content") && !other.includes(`<nav id="nav">`) && other.includes(`<main id="main-content">`), other.slice(0, 900));
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);

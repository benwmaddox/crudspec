// Translation (lang/translate.ts, gogen/rt/translate.go): an app with languages ["en", "es"] is
// itself at its own addresses and in Spanish under /es/: the text a person reads in its pages (an
// element's, a template's with its {…} where the translation puts them, an attribute's, a flash) is
// the translation, as are the runtime's own words; links, paging, sorting and a form's return stay
// in the language; the page cache keeps each language's page apart.
//   node lang/test/translation.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", typeof detail === "string" ? detail.slice(0, 700) : JSON.stringify(detail)?.slice(0, 700)); } };

const APP = `
app t { name "T"  actor User  languages ["en", "es"] }
entity User { name: Text  token: Text?  unique (token) }
identity login: User.token from cookie "login"
identity agent: User from token
policy user_rows: true for rows of User
entity Note { body: Text max 200 }
policy note_rows: true for rows of Note
layout l { <main><Slot name=main /></main><Flash /> }
// The notes, two a page, by their text if asked.
view notes(sort: Text?) { rows Note where true  order by created desc  sortable body  page 2 }
screen home(sort: Text?) {
  route "/"
  layout l
  require public
  <Title>Notes</Title>
  <Fill name=main>
    <h1>Your notes</h1>
    <p class="count">You have {count(Note where true)} notes.</p>
    <Link to={home(toggle_sort(sort, "body"))} title="Sort them" class="sort"><span>By text</span></Link>
    <Link to={about} class="about"><span>About</span></Link>
    <List of={notes(sort)} as=n class="list"><span class="t">{n.body}</span><Time as={date}>{n.created}</Time></List>
    <Button action={clear()} text="Clear all" confirm="Clear every note?" />
    <Form action={add}>
      <Field name=body kind=text label="Note" placeholder="Write one" required />
      <Submit label="Add" />
      <On ok stay flash="Added." />
    </Form>
  </Fill>
}
screen about { route "/about"  layout l  require public  <Fill name=main><h1>About</h1></Fill> }
// Adds a note.
action add(body: Text) { callers people  create Note { body: body } }
// Clears the notes.
action clear() { callers people  delete Note where true }
`;
const ES = `
translations "es" {
  "Notes": "Notas",
  "Your notes": "Tus notas",
  "You have {count(Note where true)} notes.": "Notas: {count(Note where true)}.",
  "Sort them": "Ordenarlas",
  "By text": "Por texto",
  "About": "Acerca de",
  "Note": "Nota",
  "Write one": "Escribe una",
  "Add": "Añadir",
  "Added.": "Añadida.",
  "Clear all": "Borrar todo",
  "Clear every note?": "¿Borrar todas las notas?",
  "Wed": "mié",
  "Dec": "dic",
  "Next": "Siguiente",
  "Back to the start": "Al principio"
}
`;
const errs = (src: string) => check(parse(src)).filter((f) => f.severity === "error").map((f) => f.code);
const warns = (src: string) => check(parse(src)).filter((f) => f.severity === "warning").map((f) => f.code);
ok("the app and its translations check clean", errs(APP + ES).length === 0 && !warns(APP + ES).includes("TRANSLATION_MISSING"), check(parse(APP + ES)).filter((f) => f.severity !== "info"));
ok("a text left untranslated is said", warns(APP + ES.replace(`  "About": "Acerca de",\n`, "")).includes("TRANSLATION_MISSING"));
ok("a translation of text no page shows is said", warns(APP + ES.replace(`"Notes": "Notas",`, `"Notes": "Notas",\n  "Gone": "Ido",`)).includes("TRANSLATION_UNUSED"));
ok("a translation that drops a {…} is an error", errs(APP + ES.replace("Notas: {count(Note where true)}.", "Notas.")).includes("TRANSLATION_PLACEHOLDERS"));
ok("translations into a language the app hasn't are an error", errs(APP + ES.replace(`translations "es"`, `translations "fr"`)).includes("TRANSLATIONS_LANGUAGE"));
ok("a language code that isn't one is an error", errs(APP.replace(`["en", "es"]`, `["en", "Spanish"]`)).includes("LANGUAGES"));

const dir = mkdtempSync(join(tmpdir(), "translation-"));
writeFileSync(join(dir, "app.crud"), APP);
writeFileSync(join(dir, "es.crud"), ES);
const app = await startApp(join(dir, "app.crud"), 14011);
try {
  const rows = ["pear", "apple", "fig"].map((b, i) => ({ id: i + 1, seq: i + 1, created: (i + 1) * 1000, updated: 0, fields: { body: b } }));
  await app.post("/_test/load", { clock: 10_000, rows: { Note: rows, User: [{ id: 9, seq: 9, created: 0, updated: 0, fields: { name: "Ada", token: "ada" } }] } });
  const get = async (path: string, cache = false) => { const r = await fetch(app.base + path, { headers: cache ? {} : { "X-No-Cache": "1" }, redirect: "manual" }); return { status: r.status, text: await r.text(), location: r.headers.get("location") }; };
  const txt = (h: string, cls: string) => new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</`).exec(h)?.[1]?.replace(/<[^>]+>/g, "").trim();
  const href = (h: string, cls: string) => new RegExp(`<a href="([^"]*)"[^>]*class="${cls}"`).exec(h)?.[1]?.replace(/&amp;/g, "&");
  const en = (await get("/")).text, es = (await get("/es/")).text;
  ok("the spec's language is the page as written", en.includes("<h1>Your notes</h1>") && en.includes("<title>Notes") && /<html lang="en"/.test(en), en.slice(0, 300));
  ok("/es/ is the page in Spanish: its heading, its title, its html lang", es.includes("<h1>Tus notas</h1>") && es.includes("<title>Notas") && /<html lang="es"/.test(es), es.slice(0, 400));
  ok("... a template, with its value where the translation puts it", txt(es, "count") === "Notas: 3." && txt(en, "count") === "You have 3 notes.", { es: txt(es, "count"), en: txt(en, "count") });
  ok("... attributes: a link's title, a field's label and placeholder, a button's label", es.includes(`title="Ordenarlas"`) && es.includes("Nota") && es.includes(`placeholder="Escribe una"`) && es.includes("Añadir"), es.slice(0, 2000));
  ok("... links stay in Spanish", href(es, "about") === "/es/about" && href(en, "about") === "/about" && /^\/es\/\?sort=body/.test(href(es, "sort") ?? ""), { es: href(es, "about"), sort: href(es, "sort") });
  ok("... and the pager's words are the runtime's, translated, its link in Spanish", /rel="next">Siguiente</.test(es) && /href="\/es\/\?after/.test(es), es.slice(es.indexOf("<nav"), es.indexOf("<nav") + 300));
  const signedIn = async (path: string) => await (await fetch(app.base + path, { headers: { Cookie: "login=ada", "X-No-Cache": "1" } })).text();
  const esIn = await signedIn("/es/"), enIn = await signedIn("/");
  ok("a button's literal text and confirm are translated (not made once in the spec's language)", esIn.includes("Borrar todo") && /onsubmit="return confirm\(&#34;(¿|\u00bf)Borrar todas/.test(esIn.replace(/&quot;/g, "&#34;")) && enIn.includes("Clear all"), esIn.slice(esIn.indexOf("/_do/clear") - 50, esIn.indexOf("/_do/clear") + 400));
  ok("a date's day and month names are the language's", /mié dic 31 1969/.test(es) && /Wed Dec 31 1969/.test(en), es.slice(es.indexOf("<time"), es.indexOf("<time") + 120));
  const fid = /<!--f:([0-9a-f]+)-->/.exec(es)?.[1];
  const live = fid ? await (await fetch(app.base + "/es/", { headers: { "X-Live": "frags", "X-Live-Frags": fid, "X-No-Cache": "1" } })).text() : "";
  ok("a live page's refresh of a fragment of /es/ is in Spanish", !!fid && /mié dic|Siguiente/.test(live) && !/Wed Dec|>Next</.test(live), live.slice(0, 400));
  const sorted = (await get("/es/?sort=body")).text;
  ok("sorting under /es/ sorts, and its next page stays in Spanish with the sort", [...sorted.matchAll(/class="t">([^<]*)</g)].map((m) => m[1]).join() === "apple,fig" && /href="\/es\/\?(after[^"]*sort=body|sort=body[^"]*after)/.test(sorted.replace(/&amp;/g, "&")), sorted.slice(sorted.indexOf("<nav"), sorted.indexOf("<nav") + 300));
  const agentsEs = (await get("/es/_agents")).text, agentsEn = (await get("/_agents")).text;
  ok("the runtime's own pages (/_agents) under /es/ say es, and link home in Spanish", /<html lang="es"/.test(agentsEs) && /<a href="\/es\/"/.test(agentsEs) && /<html lang="en"/.test(agentsEn) && /<a href="\/"/.test(agentsEn), agentsEs.slice(0, 300));
  ok("an untranslated page is in the spec's language, under /es/ too", (await get("/es/about")).text.includes("<h1>Acerca de</h1>"));
  // the cache: each language's page is its own
  const c1 = (await get("/", true)).text, c2 = (await get("/es/", true)).text, c3 = (await get("/", true)).text, c4 = (await get("/es/", true)).text;
  ok("fetched without X-No-Cache, alternating, each language gets its own page", c1.includes("Your notes") && c3.includes("Your notes") && c2.includes("Tus notas") && c4.includes("Tus notas"));
  // a form under /es/ goes back to the Spanish page, with the Spanish flash
  const h = /name="__h" value="([^"]+)"/.exec(es)?.[1] ?? "";
  const r = await fetch(`${app.base}/_do/add`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: app.base }, body: new URLSearchParams({ __h: h, body: "kiwi" }), redirect: "manual" });
  const flash = decodeURIComponent((r.headers.getSetCookie().find((c) => c.startsWith("flash=")) ?? "").split(";")[0].slice(6));
  ok("a form on the Spanish page goes back to it, with its flash in Spanish", (r.headers.get("location") ?? "").startsWith("/es/") && flash === "Añadida.", { location: r.headers.get("location"), flash });
} finally { app.stop(); }

// an app of one language is built as before: nothing looked up, nothing prefixed
const one = mkdtempSync(join(tmpdir(), "translation1-"));
writeFileSync(join(one, "app.crud"), APP.replace(`  languages ["en", "es"] `, " "));
const app1 = await startApp(join(one, "app.crud"), 14012);
try {
  const p = await (await fetch(app1.base + "/", { headers: { "X-No-Cache": "1" } })).text();
  ok("an app of one language is as it was", p.includes("<h1>Your notes</h1>") && /<a href="\/about"/.test(p) && (await fetch(app1.base + "/es/", { redirect: "manual" })).status === 404);
} finally { app1.stop(); }
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all passed");

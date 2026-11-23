// <Markdown known={doc_exists(_)}>: a [[link]] to a name no row has is marked, asked for each name
// the text links to, so the page reads only those names. The page cache follows them by key:
// changing a row the page doesn't link to keeps the page; creating a name it links to drops it.
//   node lang/test/known-lookup.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T" }
entity Doc { name: Text  body: Text }
policy doc_rows: true for rows of Doc
query doc_exists(name: Text): Bool = exists(Doc where .name == name)
query other_doc(d: Doc, name: Text): Bool = exists(Doc where .name == name and it != d)
query docs_like(typed: Text): list of Text = list("/f/" + .name + "|" + .name for Doc where contains(lower(.name), lower(trim(typed))) order by created desc limit 10)
query doc_file(name: Text): Text? = first(list("/f/" + .name for Doc where .name == name))
action add(name: Text) { create Doc { name: name, body: "new" } }
action edit(d: Doc, body: Text) { set d.body = body }
layout l { <main><Slot name=main /></main> }
screen doc(d: Doc) { route "/d/:d"  layout l  require public
  <Fill name=main><Markdown links="/n/" known={doc_exists(_)}>{d.body}</Markdown></Fill>
}
screen write(d: Doc) { route "/d/:d/edit"  layout l  require public
  <Fill name=main>
    <Form action={edit(d)}>
      <MarkdownEditor links="/n/" known={other_doc(d, _)} images={docs_like(_)} files={doc_file(_)} />
      <Field name=body kind=textarea value={d.body} />
      <Submit label="Save" />
    </Form>
  </Fill>
}
`;
const dir = mkdtempSync(join(tmpdir(), "known-lookup-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 14061);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  await app.post("/_test/load", { clock: 1000, rows: { Doc: [row(1, { name: "Home", body: "See [[Sword]] and [[Shield]]." }), row(2, { name: "Shield", body: "s" }), row(3, { name: "Other", body: "o" })] } });
  const page = async () => await (await fetch(`${app.base}/d/1`)).text();
  const missing = (html: string) => [...html.matchAll(/<a class="new"[^>]*href="\/n\/([^"]+)"/g)].map((m) => m[1]).join(",");
  const hits = async () => (await app.post("/_test/cache-check", {})).page_hits as number;
  const act = async (name: string, body: Record<string, string>) =>
    (await fetch(`${app.base}/_do/${name}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), redirect: "manual" })).headers.get("X-Crudspec-Outcome");

  const first = await page();
  ok("a link to a name no row has is marked; one that exists isn't", missing(first) === "Sword", missing(first));
  const h0 = await hits();
  await page();
  ok("the page is kept", (await hits()) === h0 + 1);
  ok("a change to a row the page doesn't link to", (await act("edit", { d: "3", body: "changed" })) === "ok");
  const h1 = await hits();
  await page();
  ok("... keeps the page", (await hits()) === h1 + 1, { h1, now: await hits() });
  ok("creating a name the page links to", (await act("add", { name: "Sword" })) === "ok");
  const h2 = await hits();
  const after = await page();
  ok("... drops it, and the link isn't marked now", (await hits()) === h2 && missing(after) === "", { h2, now: await hits(), missing: missing(after) });

  // <MarkdownEditor known={other_doc(d, _)}>: the page carries the lookup, signed, not the names;
  // the preview asks it of each name the text links to
  const edit = await (await fetch(`${app.base}/d/1/edit`)).text();
  const token = edit.match(/data-known-lookup="([^"]+)"/)?.[1]?.replace(/&#34;/g, '"') ?? "";
  ok("the editor's page carries a signed lookup, and no list of names", token.includes(".") && !/data-known="/.test(edit), edit.match(/<cs-markdown-editor[^>]*>/)?.[0]);
  const preview = (tok: string) => fetch(`${app.base}/_markdown`, { method: "POST", headers: { "Content-Type": "application/json", Origin: app.base }, body: JSON.stringify({ text: "[[Home]] [[Shield]] [[Bow]]", links: "/n/", known_lookup: tok }) });
  const shown = await preview(token);
  const html = await shown.text();
  ok("the preview marks the names the lookup says no other doc has (its own, and one nothing has)", shown.status === 200 && missing(html).split(",").sort().join(",") === "Bow,Home", { status: shown.status, missing: missing(html) });
  const forged = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
  ok("... and a lookup the app didn't sign is refused", (await preview(forged)).status === 400);

  // images={docs_like(_)}: the picker asks /_lookup with what's typed; files={doc_file(_)}: the
  // preview asks it for a [[File:Name]]'s address
  const attr = (name: string) => edit.match(new RegExp(`data-${name}="([^"]*)"`))?.[1]?.replace(/&#34;/g, '"') ?? "";
  const images = attr("images-lookup"), files = attr("files-lookup");
  ok("the editor's page carries the picker's and the preview's lookups, signed", images.includes(".") && files.includes(".") && !/data-images="/.test(edit));
  const ask = (lookup: string, name: string) => fetch(`${app.base}/_lookup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: app.base }, body: JSON.stringify({ lookup, name }) });
  const found = await (await ask(images, "SHI")).json();
  ok("the picker asks with what's typed, and gets what matches", JSON.stringify(found.value) === JSON.stringify(["/f/Shield|Shield"]), found);
  ok("... a lookup the app didn't sign is refused", (await ask(images.slice(0, -2) + (images.endsWith("AA") ? "BB" : "AA"), "s")).status === 400);
  ok("... and so is one from another site", (await fetch(`${app.base}/_lookup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://elsewhere.test" }, body: JSON.stringify({ lookup: images, name: "s" }) })).status === 403);
  const withFile = await (await fetch(`${app.base}/_markdown`, { method: "POST", headers: { "Content-Type": "application/json", Origin: app.base }, body: JSON.stringify({ text: "[[File:Shield]]", links: "/n/", files_lookup: files }) })).text();
  ok("the preview finds a [[File:Name]]'s address with the files lookup", withFile.includes('src="/f/Shield'), withFile.slice(0, 300));
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);

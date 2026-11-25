// IndexNow: with CRUDSPEC_INDEXNOW_KEY set, the app serves its key at /<key>.txt and, each pass,
// sends search engines the addresses in its sitemaps that are new or changed: the public ones
// only (the sitemaps are read as a signed-out visitor), and nothing when nothing changed. In
// --test nothing goes out: POST /_test/indexnow runs a pass and lists what it would have sent.
//   node lang/test/indexnow.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail).slice(0, 900)); } };
const SPEC = `
app t { name "T" }
entity Book { slug: Text  title: Text  public: Bool = true  address slug  unique (slug) }
policy book_rows: .public for rows of Book
layout page {
  <Title />
  <main><Slot name=main /></main>
}
// The public books, for the sitemap.
view books() {
  rows Book where .public
  order by .slug
  limit 100
}
screen book_screen(book: Book) {
  route "/books/:book"
  layout page
  require public
  <Title>{book.title}</Title>
  <Fill name=main><h1>{book.title}</h1></Fill>
}
export books_map { route "/sitemap.xml"  format sitemap  of books()
  url: url_of(book_screen(it)), changed: .updated
}
`;

const KEY = "a1b2c3d4e5f6a7b8";
const dir = mkdtempSync(join(tmpdir(), "indexnow-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13898, { args: ["--base-url", "https://books.example"], env: { CRUDSPEC_INDEXNOW_KEY: KEY } });
const pass = async (): Promise<string[][]> => (await app.post("/_test/indexnow", {})).sent;
try {
  const T = Date.UTC(2026, 0, 5, 12, 0);
  const row = (id: number, fields: any, updated = T) => ({ id, seq: id, created: T, updated, fields });
  await app.post("/_test/load", { clock: T + 10_000, rows: { Book: [row(1, { slug: "a", title: "A", public: true }), row(2, { slug: "b", title: "B", public: true }), row(3, { slug: "hidden", title: "H", public: false })] } });
  const keyFile = await fetch(app.base + `/${KEY}.txt`);
  ok("the key is served at /<key>.txt", keyFile.status === 200 && (await keyFile.text()) === KEY);
  ok("another .txt address isn't", (await fetch(app.base + "/nope.txt")).status === 404);

  let sent = await pass();
  ok("the first pass sends the sitemap's addresses", sent.length === 1 && JSON.stringify([...sent[0]].sort()) === JSON.stringify(["https://books.example/books/a", "https://books.example/books/b"]), sent);
  ok("never a private row", !JSON.stringify(sent).includes("hidden"));
  sent = await pass();
  ok("nothing new: nothing sent", sent.length === 1, sent);

  await app.post("/_test/load", { clock: T + 20_000, rows: { Book: [row(1, { slug: "a", title: "A", public: true }), row(2, { slug: "b", title: "B, again", public: true }, T + 15_000), row(3, { slug: "hidden", title: "H", public: false })] } });
  sent = await pass();
  ok("a changed row is sent again, alone", sent.length === 2 && JSON.stringify(sent[1]) === JSON.stringify(["https://books.example/books/b"]), sent);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);

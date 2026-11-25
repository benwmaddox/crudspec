// For search engines: <Canonical> and <Robots> in a page's head, sitemaps (export … format sitemap
// and sitemap_index) and the robots.txt the runtime serves when the app has none. A sitemap runs
// its view as whoever asks, so a crawler (signed out) never sees a private row.
//   node lang/test/seo.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail).slice(0, 900)); } };
const errors = (src: string) => check(parse(src)).filter((f) => f.severity === "error");
const BASE = `
app t { name "T" }
entity Book { slug: Text  title: Text  public: Bool = true  secret: Text? private  address slug  unique (slug) }
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
// The book index's one row: the shelf.
view shelf() {
  rows Book where .slug == "a"
  limit 1
}
screen book_screen(book: Book) {
  route "/books/:book"
  layout page
  require public
  <Title>{book.title}</Title>
  <Canonical>{url_of(book_screen(book))}</Canonical>
  <Fill name=main><h1>{book.title}</h1></Fill>
}
screen book_edit(book: Book) {
  route "/books/:book/edit"
  layout page
  require public
  <Title>Edit {book.title}</Title>
  <Robots>noindex</Robots>
  <Fill name=main><h1>Editing</h1></Fill>
}
`;
const SPEC = BASE + `
export books_map { route "/sitemaps/books.xml"  format sitemap  of books() as b
  url: url_of(book_screen(b)), changed: .updated
}
export site_map { route "/sitemap.xml"  format sitemap_index  of shelf()
  url: url_of(books_map())
}
`;

ok("the spec checks", !errors(SPEC).length, errors(SPEC));
ok("a sitemap's columns are url and changed", errors(BASE + `export x { route "/x.xml"  format sitemap  of books()  url: .title, name: .title }`).some((f) => f.code === "EXPORT_COLUMN"));
ok("a sitemap needs a url", errors(BASE + `export x { route "/x.xml"  format sitemap  of books()  changed: .updated }`).some((f) => f.code === "EXPORT_COLUMN"));
ok("no private field in a sitemap", errors(BASE + `export x { route "/x.xml"  format sitemap  of books()  url: .secret }`).some((f) => f.code === "PRIVATE_FIELD"));

const dir = mkdtempSync(join(tmpdir(), "seo-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13897, { args: ["--base-url", "https://books.example"] });
try {
  const T = Date.UTC(2026, 0, 5, 12, 0);
  const row = (id: number, fields: any) => ({ id, seq: id, created: T, updated: T + id * 1000, fields });
  await app.post("/_test/load", { clock: T + 10_000, rows: {
    Book: [row(1, { slug: "a", title: "A & B", public: true }), row(2, { slug: "b", title: "Bee", public: true }), row(3, { slug: "hidden", title: "Shh", public: false, secret: "s" })],
  } });
  const get = (path: string) => fetch(app.base + path, { redirect: "manual" });

  const page = await (await get("/books/a")).text();
  ok("a canonical link, absolute with --base-url", page.includes(`<link rel="canonical" href="https://books.example/books/a">`), page.slice(0, 900));
  ok("and the same og:url", page.includes(`<meta property="og:url" content="https://books.example/books/a">`));
  ok("no robots meta unless asked", !page.includes(`name="robots"`));
  const edit = await (await get("/books/a/edit")).text();
  ok("<Robots>noindex</Robots>", edit.includes(`<meta name="robots" content="noindex">`), edit.slice(0, 900));

  const sm = await get("/sitemaps/books.xml");
  const xml = await sm.text();
  ok("the sitemap is XML, shown inline", sm.status === 200 && sm.headers.get("content-type")?.startsWith("application/xml") === true && sm.headers.get("content-disposition") === "inline", { status: sm.status, ct: sm.headers.get("content-type"), cd: sm.headers.get("content-disposition") });
  ok("cacheable for a signed-out visitor", sm.headers.get("cache-control") === "public, max-age=600", sm.headers.get("cache-control"));
  ok("a urlset, its rows' absolute addresses and when they changed", xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`) && xml.includes(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`) && xml.includes(`<url><loc>https://books.example/books/a</loc><lastmod>2026-01-05T12:00:01.000Z</lastmod></url>`) && xml.includes("https://books.example/books/b"), xml);
  ok("a private row isn't in it (the view's rows, as the visitor sees them)", !xml.includes("hidden"), xml);

  const ix = await (await get("/sitemap.xml")).text();
  ok("an index of sitemaps, a path made absolute", ix.includes(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`) && ix.includes(`<sitemap><loc>https://books.example/sitemaps/books.xml</loc></sitemap>`), ix);

  const robots = await get("/robots.txt");
  const rt = await robots.text();
  ok("robots.txt: everything but the runtime's pages, and the sitemaps, the index first", robots.status === 200 && rt === "User-agent: *\nDisallow: /_\nSitemap: https://books.example/sitemap.xml\nSitemap: https://books.example/sitemaps/books.xml\n", rt);
} finally { app.stop(); }
process.exit(failed ? 1 : 0);

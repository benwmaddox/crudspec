// A comparison of text (<, <=, >, >=) is SQL: the app compares text byte by byte (strings.Compare of
// UTF-8), and SQLite compares it so too (BINARY, no column declares a collation), so a query's rows
// are the ones the app's own comparison would keep. Checked against the bytes, for every pair of a
// set of words where an order by letters would differ (case, accents, ß, CJK, an emoji, a space,
// the empty text); a field that may be none is none of them, as the language has it.
//   node lang/test/text-order.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../gogen/gen.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };

const SPEC = `app t { name "T"  actor User  agents_anonymous true  indexes auto }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
identity agent: User from token
entity Word { text: Text  note: Text? }
policy word_rows: true for rows of Word
// the words after one, in text order
view after(from: Text) { rows Word where .text > from  order by created  limit 100 }
// the words up to one
view up_to(to: Text) { rows Word where .text <= to  order by created  limit 100 }
// the words whose note isn't after one (a word with no note among them)
view note_not_after(n: Text) { rows Word where not (.note > n)  order by created  limit 100 }
`;
const dir = mkdtempSync(join(tmpdir(), "text-order-"));
writeFileSync(join(dir, "app.crud"), SPEC);

const go = generate(join(dir, "app.crud"))["app.go"];
ok("a text comparison is SQL, nothing left for the app to test", /t0\.\\"text\\" > \?/.test(go) && /t0\.\\"text\\" <= \?/.test(go) && !/Residual: func[^\n]*text/.test(go), go.match(/VRows_after[^\n]*\n[^\n]*\n[^\n]*/)?.[0]);

const WORDS = ["", "A", "B", "Z", "a", "aa", "a b", "ab", "b", "e", "é", "f", "ß", "ss", "z", "日本", "😀", "Ab", "á"];
const bytes = (s: string) => Buffer.from(s, "utf8");
const after = (x: string) => WORDS.filter((w) => Buffer.compare(bytes(w), bytes(x)) > 0).sort();
const upTo = (x: string) => WORDS.filter((w) => Buffer.compare(bytes(w), bytes(x)) <= 0).sort();

const app = await startApp(join(dir, "app.crud"), 14111);
try {
  const row = (id: number, text: string, note: string | null) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields: { text, note } });
  await app.post("/_test/load", { clock: 1000, rows: { Word: WORDS.map((w, i) => row(i + 1, w, i % 3 === 0 ? null : w)) } });
  const call = async (view: string, args: Record<string, string>) => {
    const r = await (await fetch(`${app.base}/_agent/call/${view}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ args }) })).json();
    return ((r.rows ?? []) as any[]).map((x) => x.text ?? x.fields?.text).sort();
  };
  const wrong: unknown[] = [];
  for (const x of WORDS) {
    const got = await call("after", { from: x }), want = after(x);
    if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push({ op: ">", x, got, want });
    const got2 = await call("up_to", { to: x }), want2 = upTo(x);
    if (JSON.stringify(got2) !== JSON.stringify(want2)) wrong.push({ op: "<=", x, got: got2, want: want2 });
  }
  ok(`SQL keeps the words the app's byte order would, for each of ${WORDS.length} words, both ways`, wrong.length === 0, wrong.slice(0, 3));
  // a note that's none is no text: not after anything, so among what isn't after one
  const noNote = WORDS.filter((_, i) => i % 3 === 0);
  const notAfter = await call("note_not_after", { n: "m" });
  const want3 = WORDS.filter((w, i) => i % 3 === 0 || Buffer.compare(bytes(w), bytes("m")) <= 0).sort();
  ok("a field that's none compares as none: not after the text, so kept under not", JSON.stringify(notAfter) === JSON.stringify(want3) && noNote.every((w) => notAfter.includes(w)), { got: notAfter, want: want3 });
} finally { app.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);

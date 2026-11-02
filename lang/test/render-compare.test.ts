// Tests for tools/render-compare.ts: the pure normalizer and argument parsing only.
// No worktrees, builds or servers. Not part of the 15-minute suite.
//   node lang/test/render-compare.test.ts
import { normalize, splitTags, parseArgs } from "../../tools/render-compare.ts";

let failed = 0;
function ok(what: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "ok  " : "FAIL"} ${what}${!pass && detail ? `\n     ${detail}` : ""}`);
  if (!pass) failed++;
}

// normalization
{
  const html = '<div id="" class="" title="">x</div>';
  ok("empty id/class/title attributes are removed", normalize(html) === "<div>x</div>", normalize(html));
}
{
  const html = '<div id="main" class="card">x</div>';
  ok("non-empty attributes are kept", normalize(html) === html, normalize(html));
}
{
  const html = "<!--f:screen-->\n<p>a</p><!--/f:screen-->";
  ok("fragment markers are removed", normalize(html) === "\n<p>a</p>", normalize(html));
}
{
  const html = "<!-- note --><p>a</p><!--\nmultiline\n-->";
  ok("other comments are removed", normalize(html) === "<p>a</p>", normalize(html));
}
{
  const html = '<script>{"d":["abc123-XYZ"]}</script>';
  ok("page ids in d arrays become <ID>", normalize(html) === '<script>{"d":["<ID>"]}</script>', normalize(html));
}
{
  const html = '<input name="__h" value="abc_123-def.sig99">';
  ok("form token becomes <H>.", normalize(html) === '<input name="__h" value="<H>.sig99">', normalize(html));
}
{
  const token = "a".repeat(40);
  ok("a 40-character run becomes <TOKEN>", normalize(`cookie=${token};`) === "cookie=<TOKEN>;", normalize(`cookie=${token};`));
  const short = "a".repeat(39);
  ok("a 39-character run is kept", normalize(short) === short, normalize(short));
  ok("a port on 127.0.0.1 becomes <PORT>", normalize('<a href="http://127.0.0.1:13600/x">') === normalize('<a href="http://127.0.0.1:13601/x">'));
}
{
  const html = "saved 2026-11-02T10:00:00Z and 2026-11-02T10:00:00.123Z";
  ok("ISO timestamps become <TS>", normalize(html) === "saved <TS> and <TS>", normalize(html));
}
{
  const html = "<p>same</p>";
  ok("normalize is idempotent", normalize(normalize(html)) === normalize(html));
}
{
  ok("splitTags puts one tag per line", splitTags("<a><b>x</b></a>") === "<a>\n<b>x</b>\n</a>", splitTags("<a><b>x</b></a>"));
}

// argument parsing
{
  const a = parseArgs(["--before", "v1", "--after", "v2"]);
  ok("defaults: no apps, 3 diffs, port 13600", a.before === "v1" && a.after === "v2" && a.apps.length === 0 && a.diffs === 3 && a.port === 13600, JSON.stringify(a));
}
{
  const a = parseArgs(["--after", "b", "--before", "a", "--app", "apps/tasks/", "--app", "apps/campfire", "--diffs", "5", "--port", "14000"]);
  ok("flags in any order, repeatable --app, trailing slash stripped", a.before === "a" && a.after === "b" && a.apps.join(",") === "apps/tasks,apps/campfire" && a.diffs === 5 && a.port === 14000, JSON.stringify(a));
}
{
  let msg = "";
  try { parseArgs(["--before", "a"]); } catch (e) { msg = String(e); }
  ok("missing --after is an error", msg.includes("--before and --after are required"), msg);
}
{
  let msg = "";
  try { parseArgs(["--before", "--after", "b"]); } catch (e) { msg = String(e); }
  ok("a flag without a value is an error", msg.includes("--before needs a value"), msg);
}
{
  let msg = "";
  try { parseArgs(["--before", "a", "--after", "b", "--bogus"]); } catch (e) { msg = String(e); }
  ok("unknown flags are an error", msg.includes("unknown argument --bogus"), msg);
}
{
  let msg = "";
  try { parseArgs(["--before", "a", "--after", "b", "--diffs", "0"]); } catch (e) { msg = String(e); }
  ok("--diffs must be a whole number above 0", msg.includes("--diffs needs a whole number above 0"), msg);
}
{
  let msg = "";
  try { parseArgs(["--before", "a", "--after", "b", "--port", "1.5"]); } catch (e) { msg = String(e); }
  ok("--port must be a whole number", msg.includes("--port needs a whole number"), msg);
}

if (failed > 0) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nall render-compare tests passed");

// bot_check (gogen/rt/botcheck.go): an action that says it gets a field a person leaves empty and a
// signed time in its forms; a post with the field filled, sent within 2 seconds of the page, or
// without a good stamp is refused as blocked, before the action runs. Other actions are as they were.
//   node lang/test/botcheck.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", typeof detail === "string" ? detail.slice(0, 600) : JSON.stringify(detail)); } };

const SPEC = `
app t { name "T" }
entity Note { body: Text max 200 }
policy note_rows: true for rows of Note
layout l { <main><Slot name=main /></main><Flash /> }
screen home {
  route "/"
  layout l
  require public
  <Fill name=main>
    <Form action={contact}>
      <Field name=body kind=text label="Message" required />
      <Submit label="Send" />
      <On ok stay flash="Sent." />
      <On blocked flash="That looked like a bot." />
    </Form>
    <Form action={plain}>
      <Field name=body kind=text label="Plain" required />
      <Submit label="Send" />
    </Form>
  </Fill>
}
// Sends a message, from anyone.
action contact(body: Text) {
  callers people
  bot_check
  create Note { body: body }
}
// Sends a message without the check.
action plain(body: Text) {
  callers people
  create Note { body: body }
}
`;
ok("the spec checks clean", check(parse(SPEC)).filter((f) => f.severity === "error").length === 0, check(parse(SPEC)).filter((f) => f.severity === "error"));
ok("bot_check twice is refused", (() => { try { parse(SPEC.replace("  bot_check\n", "  bot_check\n  bot_check\n")); return false; } catch (e: any) { return e.code === "OPTION_REPEATED"; } })());

const dir = mkdtempSync(join(tmpdir(), "botcheck-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13981);
try {
  const count = async () => ((await app.post("/_test/dump", {})).rows.Note ?? []).length;
  const page = await (await fetch(app.base + "/")).text();
  const forms = page.split("<form").slice(1);
  const contactForm = forms.find((f) => f.includes("/_do/contact")) ?? "", plainForm = forms.find((f) => f.includes("/_do/plain")) ?? "";
  const stamp = /name="__bt" value="([^"]+)"/.exec(contactForm)?.[1];
  ok("the checked form has the field to leave empty, out of sight, and a stamp", /name="__hp"/.test(contactForm) && /aria-hidden="true"/.test(contactForm) && !!stamp, contactForm.slice(0, 400));
  ok("... the other form has neither", !/__hp|__bt/.test(plainForm));
  const send = async (action: string, fields: Record<string, string>) => {
    const h = /name="__h" value="([^"]+)"/.exec(action === "contact" ? contactForm : plainForm)?.[1] ?? "";
    const r = await fetch(`${app.base}/_do/${action}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: app.base }, body: new URLSearchParams({ __h: h, ...fields }), redirect: "manual" });
    return r.headers.get("X-Crudspec-Outcome");
  };
  ok("sent at once (faster than a person) it's blocked", (await send("contact", { body: "hi", __hp: "", __bt: stamp! })) === "blocked");
  ok("... and nothing was written", (await count()) === 0);
  await new Promise((r) => setTimeout(r, 2200));
  ok("with the field filled it's blocked", (await send("contact", { body: "hi", __hp: "http://spam.example", __bt: stamp! })) === "blocked");
  ok("without the stamp it's blocked", (await send("contact", { body: "hi", __hp: "" })) === "blocked");
  ok("with a forged stamp it's blocked", (await send("contact", { body: "hi", __hp: "", __bt: stamp!.replace(/\..*$/, ".forged") })) === "blocked");
  ok("an earlier time, signed by nobody, is blocked too", (await send("contact", { body: "hi", __hp: "", __bt: "1." + stamp!.split(".")[1] })) === "blocked");
  ok("as a person sends it, it's taken", (await send("contact", { body: "hi", __hp: "", __bt: stamp! })) === "ok" && (await count()) === 1);
  ok("an action without bot_check is as it was", (await send("plain", { body: "x" })) === "ok" && (await count()) === 2);
} finally { app.stop(); }
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all passed");

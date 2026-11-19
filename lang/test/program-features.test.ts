// What a generated program brings in: only the standard packages its code uses, and only the
// runtime's heavy features its spec uses (QR codes, the runtime's externs, push keys, password
// hashing, SMTP), through the hooks in lang/gogen/rt the program fills in init(). The Go linker
// then leaves the rest out (TodoMVC carries no scrypt, SMTP, QR drawing or HTTP client for externs).
//   node lang/test/program-features.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../gogen/gen.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log("     ", JSON.stringify(detail)); } };
const prog = (path: string) => generate(path)["app.go"];
const imports = (src: string) => (/import \(\n([\s\S]*?)\)/.exec(src)?.[1] ?? "").split("\n").map((l) => l.trim().replace(/"/g, "")).filter(Boolean);
const hooks = (src: string) => (/func init\(\) \{\n([\s\S]*?)\n\}/.exec(src)?.[1] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

const todo = prog("apps/todomvc/todomvc.crud"), camp = prog("apps/campfire/campfire.crud"), tasks = prog("apps/tasks/tasks.crud");
ok("TodoMVC: no runtime features to fill, no placeholder imports (var _ = …)", hooks(todo).length === 0 && !/^var _ /m.test(todo), hooks(todo));
ok("an import only for a package the code uses (TodoMVC uses no strconv)", !imports(todo).includes("strconv") && imports(todo).includes("crudspec/gogen/rt"), imports(todo));
ok("Tasks has passwords: PasswordHash only", JSON.stringify(hooks(tasks)) === JSON.stringify(["rt.PasswordHash = rt.Hash"]), hooks(tasks));
ok("Campfire: its QR widget, its three externs, push keys and passwords", ["rt.QRDraw = rt.QRSVG", `rt.UseExtern("web_push", rt.ExternWebPush)`, `rt.UseExtern("post_json", rt.ExternPostJSON)`, `rt.UseExtern("opengraph", rt.ExternOpenGraph)`, "rt.LoadPushKeys = rt.LoadVapid", "rt.PasswordHash = rt.Hash"].every((h) => hooks(camp).includes(h)) && !hooks(camp).some((h) => h.includes("SMTP")), hooks(camp));

const dir = mkdtempSync(join(tmpdir(), "features-"));
writeFileSync(join(dir, "app.crud"), `app t { name "T" actor User }
entity User { name: Text  email: Email  token: Text?  unique (token) }
identity v: User.token from cookie "t"
policy pu: true for rows of User
action greet(u: User) { callers people  send mail { to: u.email, subject: "Hi", text: "Hello {u.name}" } }
`);
ok("a spec that sends mail: SMTPMailer, and nothing else", JSON.stringify(hooks(prog(join(dir, "app.crud")))) === JSON.stringify(["rt.SMTPMailer = rt.NewSMTPMailer"]), hooks(prog(join(dir, "app.crud"))));
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

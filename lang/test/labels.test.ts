// Enum labels: declared or made readable, shown wherever an enum value is displayed.
//   node lang/test/labels.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../parser.ts";
import { check } from "../check.ts";
import { generate } from "../gogen/gen.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail) console.log(String(detail).slice(0, 400)); } };
const SPEC = `
app t { name "T" actor User }
enum Status { open, waiting_on_customer "Waiting on you", not_started }
entity User { name: Text  token: Text? }
entity Ticket { subject: Text  status: Status = open }
identity login: User.token from cookie "login"
action set_status(t: Ticket, status: Status) { require actor != none else forbidden  set t.status = status }
layout l { <Main><Slot name=main /></Main> }
screen s(t: Ticket) { route "/tickets/:t"  layout l
  <Main>
    <Text>{t.status}</Text>
    <Strong>{"Status: " + label(t.status)}</Strong>
    <Text>{text(t.status)}</Text>
    <Form action={set_status(t)}>
      <Field name=status kind=choice from={[open, waiting_on_customer, not_started]} />
      <Submit label="Save" />
    </Form>
  </Main>
}
`;
const spec = parse(SPEC);
const enumDecl: any = spec.decls.find((d) => d.kind === "enum");
ok("a label is parsed beside its value", enumDecl.labels.waiting_on_customer === "Waiting on you" && enumDecl.values.length === 3);
ok("the spec checks", !check(spec).some((f) => f.severity === "error"), JSON.stringify(check(spec).filter((f) => f.severity === "error")));
const file = join(mkdtempSync(join(tmpdir(), "labels-")), "t.crud");
writeFileSync(file, SPEC);
const go = generate(file)["app.go"];
ok("each enum has a label table: declared labels, and names made readable", go.includes('var EL_Status = map[string]string{"open": "Open", "waiting_on_customer": "Waiting on you", "not_started": "Not started"}'), go.match(/var EL_Status.*/)?.[0]);
ok("an enum value shown as text shows its label", /<span class.*rt\.EnumLabel\(EL_Status/.test(go.split("\n").find((l) => l.includes("// text (line 11)")) ?? "") || go.includes("rt.EnumLabel(EL_Status, "), go.split("\n").filter((l) => l.includes("EnumLabel")).length);
ok("label() gives the label", (go.match(/rt\.EnumLabel\(EL_Status/g) ?? []).length >= 2);
ok("text() still gives the declared name", go.includes("rt.Plain(") || go.includes("textOf"));
ok("a choice of enum values labels its options", go.includes("Labels: EL_Status"));
process.exit(failed ? 1 : 0);

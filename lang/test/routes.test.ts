// Links and addresses (lang/check.ts): a link to a screen gives each parameter its address needs;
// each :name in an address is a parameter; no address is one an earlier screen always takes
// (the runtime tries screens in order); an href inside the app is a link the compiler can't
// check, and one to no screen's address is an error.
//   node lang/test/routes.test.ts
import { readFileSync } from "node:fs";
import { parse } from "../parser.ts";
import { check } from "../check.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail, null, 2)); } };
const app = `app t { name "T"  actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Room { name: Text }
policy room_rows: true for rows of Room
layout l { <Main><Slot name=main /></Main> }
screen room(room: Room, tab: Text?) { route "/rooms/:room"  layout l <Main><span>{room.name}</span></Main> }
`;
const found = (extra: string) => check(parse(app + extra)).map((f) => `${f.code}: ${f.message}`);
const has = (fs: string[], code: string, text = "") => fs.some((f) => f.startsWith(code) && f.includes(text));
const at = (body: string) => found(`screen s { route "/s"  layout l <Main>${body}</Main> }`);

ok("a link with the screen's parameters: fine", !at(`<Link to={room(r)}><span>x</span></Link>`.replace("r)", "the(Room where true))")).some((f) => /LINK_ARGS|ROUTE|HREF/.test(f)));
ok("a link without a parameter its address needs: LINK_ARGS", has(at(`<Link to={room()}><span>x</span></Link>`), "LINK_ARGS", "room"));
ok("an optional parameter may be left out", !has(at(`<Link to={room(the(Room where true))}><span>x</span></Link>`), "LINK_ARGS"));
ok("url_of checks it too", has(found(`fn u(): Text = url_of(room())`), "LINK_ARGS"));
ok("an address naming no parameter: ROUTE_PARAM", has(found(`screen t { route "/t/:x"  layout l <Main><span>t</span></Main> }`), "ROUTE_PARAM", ":x"));
ok("an address an earlier screen always takes: ROUTE_SHADOWED", has(found(`screen n { route "/rooms/new"  layout l <Main><span>n</span></Main> }`), "ROUTE_SHADOWED", "screen room"));
ok("a literal address before a pattern is fine", !has(check(parse(app.replace(`screen room`, `screen n { route "/rooms/new"  layout l <Main><span>n</span></Main> }\nscreen room`))).map((f) => f.code), "ROUTE_SHADOWED"));
ok("an href to no screen's address: HREF_INTERNAL error", check(parse(app + `screen s { route "/s"  layout l <Main><Link href={"/nowhere"}><span>x</span></Link></Main> }`)).some((f) => f.code === "HREF_INTERNAL" && f.severity === "error"));
ok("an href built from a path inside the app: HREF_INTERNAL warning", check(parse(app + `screen s { route "/s"  layout l <Main><Link href={"/rooms/" + "1"}><span>x</span></Link></Main> }`)).some((f) => f.code === "HREF_INTERNAL" && f.severity === "warning"));
ok("an href outside the app is fine", !has(at(`<Link href={"https://example.com"}><span>x</span></Link>`), "HREF_INTERNAL"));
for (const f of ["apps/campfire/campfire.crud", "apps/todomvc/todomvc.crud", "apps/tasks/tasks.crud", "app3/desk.crud"])
  ok(`${f}: no link or address findings`, !check(parse(readFileSync(f, "utf8"))).some((x) => /LINK_ARGS|ROUTE_|HREF_INTERNAL/.test(x.code)));
process.exit(failed ? 1 : 0);

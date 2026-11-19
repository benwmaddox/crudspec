// Write policies in a compiled app, over HTTP: `policy owner: recipe.owner == actor else forbidden
// for writes to Recipe` guards every set, touch and delete of a Recipe in every action that makes one.
// The owner's changes go through; another user's are refused 403 and change nothing; `skip policy`
// lets an action through; a for-each that changes several rows is refused as a whole when the caller
// owns only some of them; a schedule's changes run (schedules skip write policies); and an action on
// another entity is unaffected.
//   node lang/test/writepolicy-app.test.ts
process.removeAllListeners("warning");
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };

const SPEC = `app kitchen { name "Kitchen" actor User }
entity User { name: Text  token: Text? }
identity login: User.token from cookie "login"
entity Recipe { title: Text  owner: User  stars: Int  retire_at: Time }
entity Note { text: Text  owner: User }
policy user_rows: true for rows of User
policy recipe_rows: true for rows of Recipe
policy note_rows: true for rows of Note
policy owner: .owner == actor else forbidden for writes to Recipe
action rename(r: Recipe, title: Text) { set r.title = title }
action bump(r: Recipe) { touch r }
action drop(r: Recipe) { delete r }
action force_rename(r: Recipe, title: Text) { skip policy owner  set r.title = title }
action star_all(u: User, n: Int) { for each r in Recipe where r.owner == u { set r.stars = n } }
action note_it(n: Note, text: Text) { set n.text = text }
schedule retire for r in Recipe where r.stars < 0 { at r.retire_at  if missed run  set r.stars = 0 }
identity who: User from param who as "{id}"
api recipes {
  route "/api/:who/recipes/:r"
  identity who
  post "rename" -> rename(r, title: query.title)
}
`;

const dir = mkdtempSync(join(tmpdir(), "writepolicy-app-"));
writeFileSync(join(dir, "app.crud"), SPEC);
const app = await startApp(join(dir, "app.crud"), 13955);
try {
  const row = (id: number, fields: Record<string, unknown>) => ({ id, seq: id, created: 100 + id, updated: 100 + id, fields });
  const RETIRE = 1000 + 60_000; // not due at load; the clock is advanced past it below
  await app.post("/_test/load", { clock: 1000, rows: {
    User: [row(1, { name: "ada", token: null }), row(2, { name: "bob", token: null })],
    Recipe: [
      row(1, { title: "soup", owner: { ref: "User", id: 1 }, stars: 0, retire_at: RETIRE }),
      row(2, { title: "stew", owner: { ref: "User", id: 1 }, stars: 0, retire_at: RETIRE }),
      row(3, { title: "pie", owner: { ref: "User", id: 1 }, stars: 0, retire_at: RETIRE }),
      row(4, { title: "bun", owner: { ref: "User", id: 2 }, stars: -1, retire_at: RETIRE }),
    ],
    Note: [row(1, { text: "hi", owner: { ref: "User", id: 1 } })],
  } });

  // Calls an action as the given user; returns the outcome the app reported and the HTTP status.
  const call = async (who: number, action: string, args: Record<string, string>) => {
    const r = await fetch(app.base + "/_do/" + action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Actor": `User:${who}` }, body: new URLSearchParams(args), redirect: "manual" });
    return { outcome: r.headers.get("X-Crudspec-Outcome"), status: r.status };
  };
  const rows = async (entity: string) => ((await app.post("/_test/dump", {})).rows[entity] as any[]);
  const recipe = async (id: number) => (await rows("Recipe")).find((r) => r.id === id)?.fields;

  // the owner's change
  let c = await call(1, "rename", { r: "1", title: "soup!" });
  ok("the owner (ada) may rename her recipe: ok", c.outcome === "ok", c);
  ok("... and the title changed", (await recipe(1))?.title === "soup!", await recipe(1));

  // another user's change: refused, row unchanged
  c = await call(2, "rename", { r: "1", title: "hacked" });
  // a form post that is refused redirects (303) with a flash message; the outcome header says why
  ok("bob's rename of ada's recipe is refused (form post)", c.outcome === "forbidden", c);
  ok("... and the row is unchanged", (await recipe(1))?.title === "soup!", await recipe(1));

  // touch is a change too
  c = await call(1, "bump", { r: "1" });
  ok("the owner may touch her recipe: ok", c.outcome === "ok", c);
  c = await call(2, "bump", { r: "1" });
  ok("bob's touch of ada's recipe is refused", c.outcome === "forbidden", c);

  // the bot API maps forbidden to 403
  const api = async (who: number, r: number, title: string) => {
    const res = await fetch(`${app.base}/api/${who}/recipes/${r}/rename?title=${encodeURIComponent(title)}`, { method: "POST" });
    return { status: res.status, body: await res.text() };
  };
  c = await api(2, 1, "api-hacked");
  ok("bob's API rename of ada's recipe is 403", c.status === 403, c);
  ok("... and the row is unchanged", (await recipe(1))?.title === "soup!", await recipe(1));
  c = await api(1, 1, "api-soup");
  ok("ada's API rename of her recipe is 200", c.status === 200, c);
  ok("... and the title changed", (await recipe(1))?.title === "api-soup", await recipe(1));

  // delete: non-owner refused, row remains; owner's delete goes through
  c = await call(2, "drop", { r: "2" });
  ok("bob's delete of ada's recipe is refused", c.outcome === "forbidden", c);
  ok("... and the row remains", (await rows("Recipe")).some((r) => r.id === 2));
  c = await call(1, "drop", { r: "3" });
  ok("the owner's delete goes through: ok", c.outcome === "ok", c);
  ok("... and the row is gone", !(await rows("Recipe")).some((r) => r.id === 3));

  // skip policy lets bob through
  c = await call(2, "force_rename", { r: "1", title: "forced" });
  ok("skip policy owner lets bob rename ada's recipe: ok", c.outcome === "ok", c);
  ok("... and the title changed", (await recipe(1))?.title === "forced", await recipe(1));

  // a for-each over several rows: refused for bob, nothing changes
  c = await call(2, "star_all", { u: "1", n: "5" });
  ok("bob's for-each over ada's recipes is refused", c.outcome === "forbidden", c);
  ok("... and none of them changed", (await recipe(1))?.stars === 0 && (await recipe(2))?.stars === 0, [await recipe(1), await recipe(2)]);

  // a for-each over several rows: ada owns all of them, so all change
  c = await call(1, "star_all", { u: "1", n: "5" });
  ok("the owner's for-each over her recipes: ok", c.outcome === "ok", c);
  ok("... and every row it matched changed", (await recipe(1))?.stars === 5 && (await recipe(2))?.stars === 5, [await recipe(1), await recipe(2)]);

  // another entity is unaffected by the Recipe policy
  c = await call(2, "note_it", { n: "1", text: "edited by bob" });
  ok("bob may change ada's note: the policy is for Recipe only", c.outcome === "ok", c);
  ok("... and the note changed", (await rows("Note")).find((n) => n.id === 1)?.fields.text === "edited by bob");

  // a schedule runs its changes with no actor: schedules skip write policies
  await app.post("/_test/clock", { advance_ms: 120_000 });
  ok("a schedule's change runs: bob's bun (stars -1) is reset to 0 with no actor", (await recipe(4))?.stars === 0, await recipe(4));
} finally {
  app.stop();
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);

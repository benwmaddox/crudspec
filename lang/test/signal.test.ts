// Signals (gogen/rt/signal.go), on the compiled Campfire over HTTP: Bob typing in Planning
// reaches Ada's page there, with who sent it added by the runtime; not Bob's own, and not Cy,
// who isn't in the room (Cy can neither hear it nor send it). A field the signal doesn't carry
// is dropped, and the room page shows the indicator.
//   node lang/test/signal.test.ts
import { readFileSync } from "node:fs";
import { startApp } from "./go-app.ts";

let failed = 0;
const ok = (what: string, pass: boolean, detail?: unknown) => { console.log(`${pass ? "ok  " : "FAIL"} ${what}`); if (!pass) { failed++; if (detail !== undefined) console.log(JSON.stringify(detail)); } };

const app = await startApp("apps/campfire/campfire.crud", 13842);
try {
  const fixture = JSON.parse(readFileSync("apps/campfire/ui/fixture.json", "utf8"));
  const fx = await (await fetch(app.base + "/_test/fixture", { method: "POST", body: JSON.stringify(fixture) })).json();
  const id = (k: string) => fx.keys[k].id ?? fx.keys[k].ID;
  const as = (who: string) => ({ "X-Test-Actor": `User:${id(who)}` });
  const key = `typing:${id("planning")}`;
  // what a page's stream hears of key in ms: the signal messages
  const listen = (who: string, ms: number) => {
    const ac = new AbortController(), got: any[] = [];
    const done = (async () => {
      try {
        const r = await fetch(`${app.base}/_events?signals=${encodeURIComponent(key)}`, { headers: as(who), signal: ac.signal });
        const rd = r.body!.getReader(), dec = new TextDecoder(); let buf = "";
        for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value);
          let i; while ((i = buf.indexOf("\n\n")) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); if (ev.startsWith("event: signal\n")) got.push(JSON.parse(ev.split("\ndata: ")[1])); } }
      } catch { /* aborted */ }
    })();
    return { got, stop: async () => { await new Promise((r) => setTimeout(r, ms)); ac.abort(); await done; return got; } };
  };
  const send = (who: string, body: unknown) => fetch(`${app.base}/_signal/${key}`, { method: "POST", headers: { ...as(who), Origin: app.base, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const ada = listen("ada", 1500), bob = listen("bob", 1500), cy = listen("cy", 1500);
  await new Promise((r) => setTimeout(r, 300));   // the streams subscribed
  const sent = await send("bob", { action: "start", name: "Not Bob" });
  const cySent = await send("cy", { action: "start" });
  const [a, b, c] = await Promise.all([ada.stop(), bob.stop(), cy.stop()]);
  ok("Bob, in the room, may send it", sent.status === 204, sent.status);
  ok("Ada's page hears Bob start typing, from the runtime's Bob", a.length === 1 && a[0].data.action === "start" && a[0].from.id === id("bob") && a[0].from.name === "Bob Kahn", a);
  ok("... with only what the signal carries (a made-up name is dropped)", a.length === 1 && Object.keys(a[0].data).join() === "action", a[0]?.data);
  ok("Bob's own page doesn't hear his", b.length === 0, b);
  ok("Cy, not in Planning, hears nothing", c.length === 0, c);
  ok("... and may not send it", cySent.status === 403, cySent.status);
  const bad = await send("bob", { action: 5 });
  ok("a field of the wrong type is refused", bad.status === 422, bad.status);
  const html = await (await fetch(`${app.base}/rooms/${id("planning")}`, { headers: as("ada") })).text();
  ok("the room page shows the indicator, with the theme's classes", html.includes(`data-signal="${key}" data-indicator data-active-class="typing-indicator--active"`) && html.includes(`class="typing-indicator__author spinner"`));
} finally { app.stop(); }
process.exit(failed ? 1 : 0);

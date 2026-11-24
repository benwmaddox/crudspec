// `app backup` (rt/backup.go): a checked copy, kept in <data>/backups and sent to the backup
// bucket with the files not sent before; old copies removed; and every upgrade a checkpoint:
// backed up and sent before the database is replaced, or not upgraded at all.
//   node lang/test/backup.test.ts      (needs Go: on Windows, in WSL)
process.removeAllListeners("warning");
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compiledApp, type Program } from "../gogen/program.ts";

let failed = 0;
const ok = (name: string, cond: boolean, info?: unknown) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) { failed++; console.log(typeof info === "string" ? info : JSON.stringify(info, null, 1)); } };
const wsl = process.platform === "win32";

const V1 = `entity Note { text: Text }
policy notes: true for rows of Note
// Adds a note.
action add(text: Text) { create Note { text: text } }
`;
const V2 = V1.replace("entity Note { text: Text }", "entity Note { text: Text  pinned: Bool = false }");

const work = mkdtempSync(join(tmpdir(), "backup-test-"));
const program = (name: string, src: string): Program => { const f = join(mkdtempSync(join(work, name + "-")), "app.crud"); writeFileSync(f, src); return compiledApp(f); };
const v1 = program("v1", V1), v2 = program("v2", V2);
const data = join(work, "data"), s3dir = join(work, "s3");
mkdirSync(s3dir, { recursive: true });
const port = 13971;
const env = (p: number) => `CRUDSPEC_BACKUP_BUCKET=bk CRUDSPEC_S3_ENDPOINT=http://127.0.0.1:${p} CRUDSPEC_S3_ACCESS_KEY_ID=k CRUDSPEC_S3_SECRET_ACCESS_KEY=s`;
// the app's command, with the backup bucket set (the stand-in at port p)
const run = (p: Program, args: string[], s3port = port) => {
  const cmd = `${env(s3port)} ${p.binary()} ${args.map((a) => `'${a}'`).join(" ")}`;
  const r = wsl ? spawnSync("wsl", ["-e", "bash", "-c", cmd], { encoding: "utf8" }) : spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  let json: any = null;
  try { json = JSON.parse(r.stdout.trim().split("\n").pop()!); } catch { /* not JSON */ }
  return { status: r.status, out: r.stdout + r.stderr, json };
};
const objects = (prefix: string) => { const d = join(s3dir, "bk", prefix); return existsSync(d) ? readdirSync(d) : []; };
const version = () => { const d = new DatabaseSync(join(data, "app.sqlite"), { readOnly: true }); const v = (d.prepare(`select max(version) v from crudspec_versions`).get() as any).v; d.close(); return v; };

// the stand-in bucket service
const fake = resolve(import.meta.dirname, "fake-s3.mjs");
const server = wsl ? spawn("wsl", ["-e", "node", v1.path(fake), String(port), v1.path(s3dir)]) : spawn(process.execPath, [fake, String(port), s3dir]);
await new Promise<void>((done) => server.stdout!.on("data", (b) => { if (String(b).includes("ready")) done(); }));
try {
  // a database (made by app migrate), a row and an uploaded file
  const made = run(v1, ["migrate", "--data", v1.path(data)]);
  ok("app migrate makes a new database", made.status === 0 && version() === 1, made.out);
  const d = new DatabaseSync(join(data, "app.sqlite"));
  d.prepare(`insert into Note (id, seq, created, updated, text) values (1, 1, 1, 1, 'hello')`).run(); d.close();
  mkdirSync(join(data, "files"), { recursive: true });
  writeFileSync(join(data, "files", "a1b2c3.png"), "png bytes");

  const b1 = run(v1, ["backup", "--data", v1.path(data)]);
  ok("backup: a checked copy in data/backups, sent to the bucket with the files", b1.status === 0 && /backups[\\/]app-\d{8}T\d{6}Z\.sqlite$/.test(b1.json?.out ?? "") && objects("db").length === 1 && objects("files").join() === "a1b2c3.png" && b1.json.files_sent === 1, b1.out);
  await new Promise((r) => setTimeout(r, 1100));   // a backup's name is to the second
  const b2 = run(v1, ["backup", "--data", v1.path(data), "--to", v1.path(join(work, "nightly"))]);
  ok("a second backup sends only what's new (no files)", b2.status === 0 && b2.json.files_sent === 0 && objects("db").length === 2, b2.out);

  // --keep: an old copy removed (the newest always stays)
  const old = join(work, "nightly", "app-20200101T000000Z.sqlite");
  writeFileSync(old, ""); utimesSync(old, new Date("2020-01-01"), new Date("2020-01-01"));
  await new Promise((r) => setTimeout(r, 1100));   // a backup's name is to the second
  const b3 = run(v1, ["backup", "--data", v1.path(data), "--to", v1.path(join(work, "nightly")), "--keep", "14"]);
  ok("--keep removes copies older than that, keeps the rest", b3.status === 0 && !existsSync(old) && readdirSync(join(work, "nightly")).length === 2, b3.out);

  // an upgrade whose backup can't be sent: refused, the database as it was
  const bad = run(v2, ["migrate", "--data", v2.path(data), "--json"], port + 1);
  ok("upgrade with the backup bucket unreachable: refused (exit 3), nothing changed", bad.status === 3 && /backup before it/.test(bad.out) && version() === 1 && !readdirSync(data).some((f) => f.includes(".upgrade-")), bad.out);
  // ... and with it reachable: the checkpoint is in the bucket, then the upgrade
  const good = run(v2, ["migrate", "--data", v2.path(data), "--json"]);
  ok("upgrade: the version before backed up and sent, then upgraded", good.status === 0 && version() === 2 && objects("db").some((f) => /^app-v1-\d+\.sqlite$/.test(f)), { out: good.out, db: objects("db") });

  // a backup that isn't this build's: refused rather than kept as if it were
  const stale = run(v1, ["backup", "--data", v1.path(data)]);
  ok("backup by a build the database was upgraded past: refused", stale.status === 1 && /schema/.test(stale.json?.error ?? ""), stale.out);
} finally {
  if (wsl) spawnSync("wsl", ["-e", "bash", "-c", `pkill -f "fake-s3.mjs ${port}" || true`]);
  server.kill();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);

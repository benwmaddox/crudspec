// a Tasks database for the pruning benchmark (bench/README.md, Column pruning):
//   node bench/tasks-bench-data.mjs <data dir>/app.sqlite   (after the app has made the schema once)
// it holds: one person signed in (cookie login=benchtoken0123456789abcd),
// one project, 200 tasks with 4 KB of notes each (the project page lists tasks without their notes)
import { DatabaseSync } from "node:sqlite";
const d = new DatabaseSync(process.argv[2]);
const T = 1_800_000_000_000;
let seq = 1;
const row = (t, cols, vals) => d.prepare(`INSERT INTO "${t}" (id, seq, created, updated, ${cols.map((c) => `"${c}"`).join(", ")}) VALUES (?, ?, ?, ?, ${cols.map(() => "?").join(", ")})`).run(vals[0], seq++, T, T, ...vals.slice(1));
d.exec("BEGIN");
row("Person", ["name", "email", "password"], [1, "Ada Lovelace", "ada@example.com", "x"]);
row("Login", ["person", "token"], [1, 1, "benchtoken0123456789abcd"]);
row("Project", ["name", "owner"], [1, "Engine", 1]);
row("Membership", ["project", "person"], [1, 1, 1]);
const notes = "Notes on the analytical engine. ".repeat(125);   // 4,000 characters
for (let i = 1; i <= 200; i++) {
  const done = i % 2 === 0;
  row("Task", ["project", "title", "notes", "status", "assignee", "finished_by", "finished_at", "finished_at__seq"], [i, 1, `Task number ${i}`, notes, done ? "done" : "open", 1, done ? 1 : null, done ? T + i : null, done ? i : null]);
}
d.exec("COMMIT");
console.log("tasks:", d.prepare("select count(*) n, sum(length(notes)) b from Task").get());

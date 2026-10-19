// One part of the invariant proofs (lang/invariants.ts proveAll), in a process of its own.
//   node --expose-gc lang/invariants-worker.ts <spec> <from> <to> <timeout ms>
import { readFileSync } from "node:fs";
import { parse } from "./parser.ts";
import { proveInvariants } from "./invariants.ts";
const [spec, from, to, timeout] = process.argv.slice(2);
const rs = await proveInvariants(parse(readFileSync(spec, "utf8")), { part: [Number(from), Number(to)], timeoutMs: Number(timeout) });
process.stdout.write(JSON.stringify(rs), () => process.exit(0));

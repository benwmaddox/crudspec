// Campfire's test harness for the runtime's --test mode: builds a scenario's setup the same
// way the Rails oracle does, and normalizes state into the oracle's golden format.
//   node lang/runtime/server.ts apps/campfire/campfire.crud --test --harness apps/campfire/test/harness.ts …
import type { Interpreter } from "../../../lang/interp.ts";
import { Keys, setup, normalized } from "./scenario.ts";

let keys = new Keys();
let tokens = new Map<number, string | null>();

export default {
  reset(it: Interpreter, s: unknown) {
    keys = new Keys();
    setup(it, s, keys);
    tokens = new Map(it.store.rows("User").map((u) => [u.id, u.fields.bot_token]));
    return { keys: Object.fromEntries([...keys.by].map(([k, m]) => [k, Object.fromEntries(m)])) };
  },
  name(kind: string, key: string, id: number) { keys.set(kind, key, id); },
  state(it: Interpreter, body: { v2?: boolean }) { return normalized(it, keys, !!body.v2, tokens); },
};

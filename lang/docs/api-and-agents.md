[← the language guide](../LANGUAGE.md)

## The API and agents

```
api bot_messages {
  route "/rooms/:room/:bot_key/messages"
  identity bot_key
  get "" -> room_messages(room, before: query.before) as json message_json
  post "" -> post_message(room, body: rich(request.text)) status 201
}
```

**An `api`** maps HTTP routes to actions and views: each line is a method, a path under the API's `route` (`""` for the route itself), and a call with its arguments bound from the path, `query.x`, `request.text` and `request_file(name)`. A view's rows are given `as json`, through a function that makes each row's JSON. `as text` sends one value as plain text instead: a view's `value`, or an action's result, for files a site serves at a fixed address (`get "" -> ads_txt() as text` at `route "/ads.txt"`). It's `text/plain` unless the route's `headers` give a `Content-Type` (`headers { "Content-Type": "application/xml" }` for a sitemap). An API's `identity` is read from its address (a `param` identity); with any other (a cookie), its calls run as someone signed out. `headers { … }` and `status n` set the reply's. Outcomes map to statuses:

| Outcome | Status |
| --- | --- |
| `ok` | 200, or the status given |
| `unauthenticated` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict` | 409 |
| `invalid` | 422 |
| `blocked` | 429 |

**Agents** (an identity `from token`). A person issues and revokes tokens at `/_agents`, full or read-only, and an agent acts as that person, with no more permissions. Link `/_agents` from an account or profile screen (`<Link href="/_agents" label="…" />`; `check` warns when nothing does). Every action and view is callable, with the same rules as the UI:
- `GET /llms.txt`, public, says what the app is (`about`) and how an agent gets a token; every page links it in its head;
- `GET /_agent/describe` lists them, with their parameters as JSON Schema, their outcomes, rules, effects and annotations, and an overview;
- `POST /_agent/call/<name>` takes `{"args", "dry_run"?, "confirm"?, "idempotency_key"?}`;
- `POST /_mcp` is an MCP server; `initialize` returns the overview as its instructions: the records, the rules the refusals name, how calls work, and who the token acts as.

How calls work:
- **Derived, not written:** effects and MCP annotations come from the statements, triggers, cascades and workflows: `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. The description is the comment above the declaration (`check` warns about callables without one), then what it changes, returns and refuses.
- **Dry runs** report the rows a call would change, then roll back.
- **Confirmation:** an action that deletes rows of a kind it doesn't create needs a `confirm`. Called without one it runs as a dry run: a refusal comes back as usual, and otherwise `confirm_required` with the changes and the confirm value that applies them. The confirm is bound to the token, the arguments and the data version.
- **Files** are sent inline: `{"filename", "content_type"?, "data": "<base64>"}`, stored as a form's upload is (a dry run's isn't written). Rows show them as `{filename, content_type, size, url}`.
- **Idempotency keys** replay the first result for 24 hours.
- **Never sent to agents:** passwords, identity-matched fields, and `private` fields.
- **Audit:** every call is recorded.
- **Withheld from agents:** actions and views that say `callers people`, and actions that manage browser sessions (create the cookie identity's rows, or read `session_token`); `check` asks those to say `callers people` (`AGENTS_NO_UNSTATED`). Withheld callables aren't in `describe` or MCP; calling one is `unknown`. `review` reports a callable agents gain or lose.

### The app's controls

```
app wiki {
  …
  agents_when Site.agents_enabled                 // the interface answers only while this holds
  agents_anonymous Site.agents_read_without_token // agents may call the views with no token
  agent_calls_per_minute 60                       // a token's calls (an address's, without one)
  agent_writes_per_minute 10                      // a token's actions
}
```

Each is an expression read on each call, so the app's own data can hold the switch (a site administrator's settings screen sets it).
- **`agents_when`:** while it doesn't hold, `/_agent/…` and `/_mcp` answer 503 (`unavailable`) and `/llms.txt` says the interface is off. People's `/_agents` pages stay, to see and revoke their tokens.
- **`agents_anonymous`:** a call with no `Authorization` header is a caller with no token: it may call the views (`describe` and MCP list only those), as a signed-out visitor, under the same read policies and requires, and never an action (`unauthenticated`). Its calls are counted by address, `agent_calls_per_minute` or 60 when that isn't set, and aren't recorded in the audit (a public site would write a row for every read).
- **`agent_calls_per_minute`, `agent_writes_per_minute`:** a token's calls, and its actions, in each minute; past either the call is refused `blocked` (429), saying which. Not set: no limit (an action's own `rate_limit` still applies).
- **`/_agents/all`:** for administrators (the app's `admin` condition, 404 to anyone else), every token on the site with whom it acts for, any of which they may revoke, and the latest agent calls.

From a shell: `node lang/cli.ts describe <url>` and `call <url> <name> p=v … [--file p=path] [--dry-run] [--confirm v] [--key k]` (`describe --overview` prints the overview too), with the token in `CRUDSPEC_TOKEN`. Exit codes 3–9 are the outcomes.

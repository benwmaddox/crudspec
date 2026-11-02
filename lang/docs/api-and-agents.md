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

**An `api`** maps HTTP routes to actions and views: each line is a method, a path under the API's `route` (`""` for the route itself), and a call with its arguments bound from the path, `query.x`, `request.text` and `request_file(name)`. A view's rows are given `as json`, through a function that makes each row's JSON; `headers { … }` and `status n` set the reply's. Outcomes map to statuses:

| Outcome | Status |
| --- | --- |
| `ok` | 200, or the status given |
| `unauthenticated` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
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

From a shell: `node lang/cli.ts describe <url>` and `call <url> <name> p=v … [--file p=path] [--dry-run] [--confirm v] [--key k]` (`describe --overview` prints the overview too), with the token in `CRUDSPEC_TOKEN`. Exit codes 3–9 are the outcomes.

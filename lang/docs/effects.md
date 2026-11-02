[← the language guide](../LANGUAGE.md)

## Effects outside the app

### Externs and workflows

```
extern fn web_push(endpoint: Url, p256dh: Text?, auth: Text?, title: Text, body: Text, path: Url, badge: Int): Text effect push
extern fn post_json(url: Url, body: Json, timeout: Duration): HttpReply effect http

after commit on MessagePosted(m) {
  step push:
    for each sub in PushSubscription where member(.user, m.room) and .user != m.creator {
      let sent = call web_push(sub.endpoint, sub.p256dh_key, sub.auth_key, title: m.room.name, body: plain(m.body), path: url_of(room_screen(m.room)), badge: 1)
      if sent == "expired" { delete sub }
    }
}
```

- **An `extern`** declares a host function and its effect.
  - One whose effect isn't `pure` or `fetch` may be called only in a workflow step.
  - A `fetch` extern reads from outside without changing anything, so a value view may call it.
  - A `pure` one gives the same result for the same arguments and touches nothing outside, so it may be called anywhere.
  - Migrations call none.
- **The runtime's externs:**
  - `post_json(url, body, timeout)`;
  - `opengraph(url)`, which reads a page's card through a guard that refuses private and loopback addresses on every redirect;
  - `web_push(…)`, which encrypts and signs a notification and returns `"sent"`, `"expired"` or `"failed"`.

  An extern without `= go` is one of these, declared as above; `check` refuses any other name (`EXTERN_UNKNOWN`: it would do nothing and give none), and a different number of parameters or a different result (`EXTERN_SIGNATURE`).
- **A workflow** runs after the action that emitted its event commits, a step at a time. Each step's writes apply directly, outside a transaction. A step is retried until it succeeds, so it must be safe to run twice.

**Go bindings.** An extern can call a Go function:

```
import go "github.com/google/uuid@v1.6.0"
extern fn shout(t: Text): Text effect pure = go "strings".ToUpper
extern fn valid_id(t: Text): Text? effect pure = go "github.com/google/uuid".Validate
extern fn send_mail(server: Text, from: Email, to: list of Text, subject: Text, body: Text): Text? effect mail = go SendMail   // ext.go beside the spec
```

- **Generating the lines:** `node lang/cli.ts bind <package | app dir>` prints the extern lines for a package's functions, and why the others can't be bound. It writes `effect TODO`, which the checker refuses until a person chooses the effect.
- **Types:**
  - `Text`, `Email` and `Url` are Go `string` or `[]byte`;
  - `Int` is any int type (a value that doesn't fit is refused);
  - `Bool`, `Time` and `Duration` are `bool`, `time.Time` and `time.Duration`;
  - `list of Text` is `[]string`.
- **Results:**
  - none, or one value;
  - an `error`, seen as `Text?`;
  - a `(value, error)`, seen as the value made optional.

  Anything else needs a small wrapper in `ext.go`.
- **Checked twice:** the compiled app checks every binding's Go signature against the spec when it starts, naming the spec's line.
- **Modules:** `build` fetches each `import go` module at its pinned version and keeps `go.sum` beside the spec.
- **Offline:** with `--offline`, a binding whose effect isn't `pure` or `fetch` isn't called, and gives none.

### Schedules

```
schedule send_due for m in ScheduledMessage where not m.cancelled {
  at m.send_at
  if missed run
  create Message { room: m.room, author: m.author, body: m.body }  delete m
}
schedule morning { every day at "08:00" in "America/New_York"  emit morning() }
schedule sweep { every 15 min  delete Session where .expires < now }
```

- **For rows:** `at x.field [± duration]`. In its `where`, the row is the loop's variable: `for m in Message where m.status == draft` (not `.status`, which only a query's `where` understands).
- **Durations** are a count and one unit, singular: `500 ms`, `30 s`, `15 min`, `2 h`, `365 day`.
  - A row runs once for each value of its time; moving the time makes it due again.
  - The `where` is read when the time comes.
  - `if missed run|skip` is required. It says whether the first deploy runs the rows already due; `review --data` says how many that is.
- **Every period:** `every day at "HH:MM" [in "Zone"]`, or `every <duration>` (1 min at least). After a gap, only the latest period runs.
- **Each run is a transaction.** A refused run is logged and not tried again for that time. At most 100 rows run per schedule per pass.
- **No request comes with a run**, so `actor`, `request`, `cookie()`, `rate_limit` and every-action policies don't apply. The checker refuses them.
- In `--test`, `/_test/clock {"advance_ms": n}` runs whatever the new time makes due.

### Mail

```
schedule digest {
  every day at "08:00" in "America/New_York"
  for each u in User where .digest_on {
    send mail { to: u.email, subject: "Your digest", text: digest_text(u), unsubscribe: url_of(unsubscribe_screen(signed(u, "unsubscribe", 30 day))) }
  }
}
```

- **Where:** it may be written wherever writes are. The message goes into the outbox in the same transaction, so a refused action sends nothing.
- **Checks:**
  - `to` is an address, and `to`, `subject` and `text` are required;
  - no `private` field may appear in it;
  - mail a schedule sends needs `unsubscribe`, which becomes a one-click `List-Unsubscribe` header.
- **Delivery:** over SMTP (`CRUDSPEC_SMTP`, `CRUDSPEC_MAIL_FROM`; credentials only over TLS or to localhost), retried six times.
- **Links:** absolute links use `--base-url`, never a request's Host header.
- **Tests:** `/_test/outbox` lists the outbox.

### Exports

```
export room_csv(room: Room) {
  route "/rooms/:room/export.csv"
  format csv
  of room_messages(room) as m
  named room.name + " messages"
  "Timestamp": .created, "Author": .author, "Message": plain(.body), "Reactions": list(.content for Boost where .message == m)
}
```

- **What it is:** a download of a view's rows, run as the person asking, so it never shows more than the view does.
- **CSV** follows RFC 4180, and a cell a spreadsheet would run as a formula gets a leading `'`.
- **JSON** is an array of objects.
- **Checks:** no `private` field may be exported.

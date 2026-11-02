[← the language guide](../LANGUAGE.md)

## Actions

An action is the only way stored data changes, and runs in one transaction with the triggers it sets off: it keeps all of its writes or none.

```
action edit_message(message: Message, body: RichText) {
  require member(actor, message.room) else not_found
  require can_administer(actor, message.creator) else forbidden
  set message.body = body
}
action sign_in(email: Email, password: Text) {
  skip policy signed_in
  rate_limit 10 per 3 min by request.ip else blocked
  let user = the_or_none(User where .email == email and .status == active)
  require user != none and authenticates(user.password, password) else unauthenticated
  create Session { user: user, ip: request.ip } as s
  result s
}
```

- **Parameters** are typed and resolve lazily. A reference to a row that doesn't exist ends the action with `not_found` when first used; an enum value outside its enum, `invalid`. `name: E?` may be none. Because of lazy resolution, the order of the requires decides which refusal someone gets.
- **Settings** come first, a line each:
  - `skip policy <name>` lets the action run where an every-action policy would refuse it.
  - `callers people`: agents and the API can't call it, and aren't told of it (a view takes it too).
  - `callers api`: people can't call it; agents and the API only. No screen, API route or channel may offer it (`PEOPLE_NO_OFFERED`), none is generated for it, and a person's request for it is a 404. It needs an agent identity; make it `callers internal` if nobody outside should call it.
- **Statements:**
  - `require <condition> else <outcome> ["reason"]` ends the action with that outcome when the condition is false. Nothing written is kept. Agents are told why: the reason when given, else the condition, with the predicates it calls spelled out for the call (`this needs can_edit(actor, doc)`; hint `can_edit(actor, doc) means doc.owner == actor`). A `not_found` says only what a missing row would (`Doc 4 does not exist`), so it never reveals that a hidden row exists.
  - `reject <outcome> ["reason"]` does the same, unconditionally (in an `if`, or a trigger guarding a transition).
  - `let x = e` names a value for the rest of the block.
  - `create E { f: e, … } [as x]` inserts a row (omitted fields take their defaults); `ensure E { … }` does nothing if a row with the same unique key exists.
  - `set x.f = e` updates a field; a password is hashed. `touch x` sets `x.updated = now`.
  - `delete x` deletes a row, and `delete E where p` every matching row, each applying the `on delete` of rows that refer to it.
  - `for each x in E where p { … }` repeats over the rows matching when the loop starts; `for each x in list { … }` over a list.
  - `if c { … } else { … }`.
  - `emit Event(args)` starts the event's workflows after the action commits.
  - `send mail { … }` (below); `rate_limit n per d by e else outcome` (a fixed window: the first attempt starts it, every attempt in it counts, refused ones too, and it ends `d` after it started); `result e`, what the action produced, for screens and the API.
- **Outcomes** are `ok`, `forbidden`, `not_found`, `blocked`, `invalid` and `unauthenticated`. An action that reaches its end is `ok`. A unique key, an entity invariant, a size or a restricting delete that fails ends it `invalid`.
- **`callers internal`** (the one setting for who may call: `people`, `api` or `internal`) means the action can't be called from outside: screens, the API and agents don't see it (a channel or a schedule can call it).

### Gates

```
policy blocked_ip: request.method != write or not exists(Ban where .ip == request.ip) else blocked for every action
policy signed_in: actor != none else unauthenticated for every action
policy deny_bots: request.identity != bot_key else forbidden for every action
```

**`for rows of <Entity>`** takes no `else`: it is who may see a row, wherever rows of the entity are shown (views, screens, exports, agents). The row is called by the entity's name in lower case (`recipe.status`, not `.status`), and every entity that is listed needs one, a child entity too (`policy ingredient_rows: ingredient.recipe.status == published or ingredient.recipe.owner == actor for rows of Ingredient`).

**`else <outcome> for writes to <Entity>`** is the rule of an entity: `policy owner: recipe.owner == actor else forbidden for writes to Recipe`. Every action that changes a row of it (`set r.f = …`, `touch r`, `delete r`) gets the rule as a `require` right before the change, with `recipe` replaced by the row being changed (once for the same row), so an owner check can't be forgotten in one action. The row's entity is known from a typed parameter, a loop, a `create … as`, or a `let x = the(E where …)`; where it isn't, `check` warns (`WRITE_POLICY_UNRESOLVED`). An action opts out with `skip policy <name>`; a schedule skips every one; `delete E where …` of an entity with a write policy is refused (`WRITE_POLICY_BULK`: loop over the rows and delete each, or skip the policy). Creating a row is not a write for this: its rule is whatever the action requires.

A policy that says `for every action` applies to every action, in order, before its body; the first that fails ends the action with its outcome. An action opts out with `skip policy <name>`. (Before, this was a `gate`, written the other way round: `gate g: c -> outcome` is `policy g: not c else outcome for every action`.)

### Triggers

```
on create Message as m {
  for each ms in Membership where .room == m.room and .user != m.creator { set ms.unread_since = m.created }
}
on update Room.type as r when old.type == direct and r.type != direct { reject invalid }
on delete Membership as m { emit Disconnect(m.user) }
```

A trigger runs inside the action's transaction, right after the write that sets it off: `on create E as x`, `on update E.f as x [when …]` (with `old`), `on delete E as x`. It can't reach outside the app. Triggers that could set each other off round and round are reported (`TRIGGER_CYCLE`).

### Who may read

```
policy message_rows: member(actor, message.room) for rows of Message
```

A read permission limits which rows any view, screen, export or agent call may show, for every viewer, every time. Every entity a view returns needs one.

### Identity and the app

```
app campfire {
  name "Campfire"
  about "Group chat for one team"   // what agents are told the app is (/llms.txt, MCP)
  actor User                     // who signs in and acts: the type of `actor`
  sign_in_screen sign_in         // where a signed-out visitor is sent
  setup_screen first_run         // … or here, while setup_when holds
  setup_when not exists(User)
  indexes auto
}
identity session: Session.token from cookie "session_token"
identity bot_key: User from path bot_key as "{id}-{bot_token}" where .role == bot and .status == active
identity agent: User from token where .status == active and .role != bot
show User {
  label: .name                   // how pickers and lists label a row
  picture: if .avatar != none { .avatar } else { initials(.name) }
}
```

- `actor` is the row the first matching identity names. `request.identity` is that identity's name.
- **Identity sources:** a `cookie` (sessions), a `path` segment in a format, or a `token` (agents).
- `display` labels rows in pickers and lists.
- `avatar` gives an image per row: a `File`, an asset name, or text drawn as initials. It's served at `/avatars/E/<id>`.

### The admin section

```
app freestore {
  actor Staff
  admin actor.role == admin       // who may use it: a condition about the actor
}
```

An app that says who its administrators are gets an admin section at `/_admin`, written as ordinary crudspec (like the default screens under `/_auto`; `cli scaffold` prints the rest):
- **An index** of the entities with how many rows each has (`data` tables are left out), a **table** for each (`/_admin/<entity>`, its newest 200 rows, each linking to its form), a **form** to create a row (`/_admin/<entity>/new`) and one to edit or delete it (`/_admin/<entity>/<id>`). A `singleton` has just its form. Link to it from your own screens with `<Link href="/_admin" label="Admin" />`.
- **Who:** only when the `admin` condition holds for the actor (a signed-out visitor is not an administrator; anyone else is sent to the sign-in screen, or the first screen without parameters, with "Administrators only."). **Allowing users to be administrators** is editing the field the condition reads: an administrator opens the user's form and sets it, and that user is one from then on. `admin` is yours to write: `actor.is_admin`, `actor.role == admin`, `exists(Grant where .user == actor and .name == "admin")`. With no `admin` line there is no section.
- **What it does is what the app's own rules say.** Each form runs a generated action (`admin_create_<entity>`, `admin_update_<entity>`, `admin_delete_<entity>`, `callers people`), so a size, a `unique` key, an entity `invariant` and a restricting delete hold as everywhere (`invalid`), and so do an enum field's `transitions`: an administrator can't take a completed visit back to waiting. A row may be *created* in any state of such a field, since the form says where it starts.
- **Fields:** one form field for each of type `Text`, `Int`, `Bool`, `Time`, `Email`, `Url`, `Ip`, `Password`, `RichText`, an enum, or a reference. A `Password` is never shown, and left empty on an edit it is kept. A field with a default may be left empty on a create and takes its default. A field of another type (`File`, `Json`, `Duration`, a set) is left out of the forms and kept as it is on an edit. An entity that needs one to be created can be edited and deleted but not created.
- **Only administrators make administrators.** The compiler holds the whole app to it, not just the section: an action that sets a field the `admin` condition reads (through the predicates it calls), or creates a row giving one a value from the caller or the administrator's own value, must require the `admin` condition first (`ADMIN_ESCALATION`, an error). A create that makes the first administrator is allowed while `not exists(<the actor's entity>)` is required.
- **Reading:** the lists show every entity, so an administrator may read each (an entity's own `permission read` still decides for everyone else, and one with none is readable by administrators and no one else). This reaches agents and the API too: an administrator's token sees what an administrator sees.
- **What it does not do:** it doesn't bypass anything, so there is no "force". To correct a row the entity's rules won't let you, change the rules (a migration, or a `transitions` move) or write an action for it. The deep checks that ask whether a field is ever written or read (`FIELD_NEVER_WRITTEN`, …) look at the app's own actions and screens, not at the admin section.

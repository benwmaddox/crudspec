# crudspec reference

Generated from the parser, checker and type pass (`node lang/cli.ts reference`). Don't edit: `lang/std/ui.crud` describes the elements and field kinds, `lang/reference.ts` the rest. `LANGUAGE.md` explains the language; this lists everything in it.

## UI elements

`<name attr="text" attr={expression} flag>children</name>`, or `<name … />`. An attribute shown as `name={…}` takes a value (`"text"` or `{expression}`); one shown bare is a flag.

### `<Heading>`

A page or section heading.

- **Head:** its text as content: raw text and `{expression}`, as `<Text>{n} items left</Text>` (spaces and line breaks show as one space; write `{"{"}`, `{"}"}` and `{"<"}` for those characters).
- **Children:** no.

### `<Text>`

A piece of text; a row shows its entity's display, an enum value its label.

- **Head:** its text as content: raw text and `{expression}`, as `<Text>{n} items left</Text>` (spaces and line breaks show as one space; write `{"{"}`, `{"}"}` and `{"<"}` for those characters).
- **Children:** no.

### `<Strong>`

Emphasised text.

- **Head:** its text as content: raw text and `{expression}`, as `<Text>{n} items left</Text>` (spaces and line breaks show as one space; write `{"{"}`, `{"}"}` and `{"<"}` for those characters).
- **Children:** no.

### `<RichText>`

Formatted text (a RichText value).

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `autolink` links addresses in the text.

### `<Time>`

A time, as a date or a time of day.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `as={…}` how a time shows: `{date}` (Mon Jan 02 2006) or `{time}` (3:04 PM, the default).

### `<Image>`

An image from a file or a path under the assets.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `width={…}` the image's width; `height={…}` the image's height.

### `<Icon>`

An icon by name, from the assets' images.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.

### `<Avatar>`

A person's avatar.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `large` a large avatar; `bare` its image alone (inside a link that is the avatar).

### `<Avatars>`

A row of avatars, for a set of people.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.

### `<FieldDisplay>`

A label and a value, read only.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `readonly` shown read only; `label={…}` its label: visible text on a link, button or submit without an icon or text; otherwise read out by screen readers.

### `<Link>`

A link to a screen or an address.

- **Head:** where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms.
- **Children:** yes.
- **Attributes:** `unread={…}` marks the link unread when this holds.

### `<Button>`

A button that runs an action (a one-button form).

- **Head:** where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms.
- **Children:** yes.
- **Attributes:** `text={…}` the button's visible text; `confirm={…}` asks for confirmation first, with this question; `reveal` reveals the button's children instead of submitting at once; `selected={…}` shows the button as selected when this holds; `checked={…}` a setting the button changes: shows its state (on when this holds), a checkbox to assistive technology.

### `<Form>`

A form for an action; its fields are the action's parameters.

- **Head:** where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms.
- **Children:** yes.
- **Attributes:** `auto_submit` submits when a field changes; `readonly_unless={…}` the form is read only unless this holds; `disabled={…}` the form is disabled when this holds; `submit_on={…}` submits on this key (`"enter"`); `bare` its fields laid out by the form's own class.

### `<Field>`

A form field for one of the action's parameters.

- **Head:** `name=parameter` (one of the form's action parameters) and `kind=…` (see field kinds).
- **Children:** no.
- **Attributes:** `value={…}` the field's starting value; `placeholder={…}` the field's placeholder; `required` the field must be filled in; `maxlength={…}` the field's longest value (a sized field or parameter gets one by itself); `multiple` a file field takes several files; `preview={…}` a file field previews its image here; `from={…}` a choice, select or users field's choices: a list; `filter_over={…}` a users field filters its choices past this many; `autocomplete={…}` a field picks from a view's rows as you type; `mentions={…}` a rich-text field offers @mentions from a view; `unfurl={…}` a rich-text field previews pasted links with a value view; `drafts` a rich-text field keeps a draft in the browser; `rows={…}` a textarea's height in lines; `role={…}` the field's ARIA role; `accept={…}` the file types a file field takes (`"image/*"`); `label_hidden` its label is read out by screen readers but not shown (a field with an icon or a placeholder, say).

### `<Switch>`

An on/off switch.

- **Head:** nothing: just its attributes and children.
- **Children:** no.
- **Attributes:** `on` the switch starts on; `off` the switch starts off; `value={…}` the field's starting value: on when this holds; `link={…}` the switch goes to this screen when changed; `auto_submit` submits when a field changes.

### `<Submit>`

The form's submit button.

- **Head:** nothing: just its attributes and children.
- **Children:** no.

### `<On>`

What happens after a form or button's action ends with an outcome.

- **Head:** an outcome (`ok`, `invalid`, …) and what then happens: `go={screen(args)}`, `flash="…"`, `sign_in={user}`, `stay`, `clear_form`, `shake`.
- **Children:** no.

### `<List>`

The rows of a view or a query, each shown by the children with the row bound to `as`.

- **Head:** `of={view(args)}` or `of={Entity where …}`, `as=name`, and optionally `where={…}`, `order={…}`, `desc`.
- **Children:** yes.

### `<Use>`

A component (written as the component's own tag: `<MessageItem m={m} />`).

- **Head:** `call={name(args)}`.
- **Children:** no.

### `<Widget>`

A runtime or app widget (`copy_button`, `share_button`, `qr_link`, `lightbox`, `autocomplete`, `push_permission`, or one the app declares).

- **Head:** `call={name(args)}`.
- **Children:** no.
- **Attributes:** `caption={…}` a widget's caption.

### `<Channel>`

Keeps a declared channel open while the page is.

- **Head:** `call={name(args)}`.
- **Children:** no.

### `<Signal>`

Shows a declared signal (typing indicators and the like).

- **Head:** `call={name(args)}`.
- **Children:** no.
- **Attributes:** `indicator` shows a signal as an indicator.

### `<Section>`

A section, optionally with a legend.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.
- **Attributes:** `legend={…}` a section's legend; `banned={…}` marks a row or section banned when this holds.

### `<Row>`

A horizontal group.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.
- **Attributes:** `banned={…}` marks a row or section banned when this holds.

### `<Column>`

A vertical group.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<Menu>`

A menu of links and buttons.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<Popup>`

A button that opens a panel.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.
- **Attributes:** `panel={…}` the class of a popup's panel.

### `<Dialog>`

A dialog.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<Frame>`

A frame (a group the page refreshes on its own).

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<Go>`

Goes to a screen at once (in a screen's if: a redirect).

- **Head:** where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms.
- **Children:** no.

### `<Title>`

The page's title.

- **Head:** its text as content: raw text and `{expression}`, as `<Text>{n} items left</Text>` (spaces and line breaks show as one space; write `{"{"}`, `{"}"}` and `{"<"}` for those characters).
- **Children:** no.

### `<Slot>`

Where a screen's part goes, in a layout.

- **Head:** `name=…`.
- **Children:** no.

### `<Flash>`

Where flash messages show, in a layout.

- **Head:** nothing: just its attributes and children.
- **Children:** no.

### `<Nav>`

The screen's navigation part (a layout slot).

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<Main>`

The screen's main part (a layout slot).

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<Footer>`

The screen's footer part (a layout slot).

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<Aside>`

An aside, optionally a named slot.

- **Head:** optionally `name=…`.
- **Children:** yes.

### `<Sidebar>`

The screen's sidebar part (a layout slot).

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### On every element

- `class={…}` the element's classes, for the theme (instead of the theme's classes for its kind)
- `id={…}` the element's HTML id
- `label={…}` its label: visible text on a link, button or submit without an icon or text; otherwise read out by screen readers
- `icon={…}` an icon shown with it
- `title={…}` a tooltip; a link's name when it has no label
- `data={…}` data attributes, from a json value
- `if={…}` shows the element only when this holds

### Content

An element's content, and a block's, is text as it shows, `{expression}` (its value, as text) and elements: `<p>Hello {u.name}!</p>`. A run of only spaces and line breaks is nothing (write a space between two elements `{" "}`); other line breaks and the spaces around them show as one space. `//` at the start of a line or after a space starts a comment. Write `{"{"}`, `{"}"}` and `{"<"}` for those characters. Code goes in braces, its blocks content again:

- `{if c { … } else if d { … } else { … }}`: the block, only when the condition holds.
- `{let name = value}`: names a value for the rest of the block.
- `{for each x in xs { … }}`: the items of a list, each shown by the block.
- `{match e { a { … } b, c { … } none { … } }}`: the block of the arm for e's value. e is an enum value (optional or not); each of the enum's values has exactly one arm, and `none` one too when e is optional. A match has no else, so a value added to the enum later has to be handled too.

### Components

A component is used by its own tag, its parameters as props in order from the first: `<MessageItem m={m} />` (a component is named with a capital, as its tag is).

The standard library's components (`lang/std/components.crud`), which an app has without declaring them, and which are compiled only when its UI uses them:

- `<Separator />`: A horizontal rule.

## Field kinds

- `text`: one line of text
- `email`: an email address
- `password`: a password
- `richtext`: formatted text with mentions and attachments
- `file`: a file upload
- `textarea`: several lines of text
- `users`: a set of people (from `from` or `autocomplete`)
- `select`: one row, from `from`
- `hidden`: a hidden value
- `url`: an address
- `code`: a short code
- `number`: a whole number (an Int)
- `choice`: one of a list: an enum's values (shown by their labels) or true/false
- `datetime`: a date and time (a Time), picked in the person's own time zone (their browser's), which the form sends along
- `date`: a date (a Time: its midnight, in the person's time zone)
- `time`: a time of day, as text ("08:30")
- `checkbox`: an on/off box (a Bool): checked when its value is true

## Outcomes

- `ok`: it worked
- `forbidden`: not allowed (403)
- `not_found`: no such row, or not one the person may see (404)
- `blocked`: a rate limit (429)
- `invalid`: a value doesn't fit: a size, a unique key, an invariant, a require (422)
- `unauthenticated`: not signed in (401)

## Builtin functions

- `plain` (1 argument): plain(x): the text of a value (a RichText's text)
- `mentions` (1 argument): mentions(rich): the set of people it mentions
- `blank` (1 argument): blank(x): true when it's none or empty
- `present` (1 argument): present(x): true when it isn't blank
- `authenticates` (2 arguments): authenticates(stored, given): whether a password matches
- `token` (1 argument): token(n): a random alphanumeric text of length n
- `signed` (3 arguments): signed(row, purpose, expires): a tamper-proof reference to a row
- `verify` (3 arguments): verify(Entity, text, purpose): the row a signed reference names, or none
- `join` (2 arguments): join(list, separator): a list's texts joined
- `split` (1-2 arguments): split(text) the list of its words; split(text, sep) its parts
- `chunks` (2 arguments): chunks(text, n): the text in pieces of n characters
- `sentence` (1 argument): sentence(list): "a, b and c"
- `any` (1 argument): any(list): whether a list of conditions has a true one
- `count` (1 argument): count(list or query): how many
- `first` (1-2 arguments): first(list) the first item, or none; first(list, n) the first n
- `last` (1-2 arguments): last(list) the last item, or none; last(list, n) the last n
- `distinct` (1 argument): distinct(list): without repeats
- `words` (1 argument): words(text): the number of words
- `initials` (1 argument): initials(text): the first letters of its words
- `first_word` (1 argument): first_word(text): its first word
- `label` (1 argument): label(e): an enum value's label
- `after` (2 arguments): after(text, prefix): the text after the prefix
- `lower` (1 argument): lower(text): in lower case
- `upper` (1 argument): upper(text): in upper case
- `trim` (1 argument): trim(text): without surrounding spaces
- `length` (1 argument): length(text): its length in characters
- `contains` (2 arguments): contains(text, part): whether it contains the part
- `starts_with` (2 arguments): starts_with(text, prefix): whether it starts with the prefix
- `replace` (3 arguments): replace(text, old, new): with each old replaced
- `public_ip` (1 argument): public_ip(address): whether an IP address is public
- `scheme` (1 argument): scheme(url): its scheme (`https`)
- `port` (1 argument): port(url): its port
- `host_within` (2 arguments): host_within(url, domain): whether its host is the domain or under it
- `url` (1 argument): url(text): text as an address
- `url_of` (1 argument): url_of(file): a file's address
- `host` (1 argument): host(url): its host
- `path` (1 argument): path(url): its path
- `with_host` (2 arguments): with_host(url, host): with another host
- `text` (1 argument): text(x): a value as text (an enum value: its declared name)
- `rich` (1 argument): rich(text): text as RichText
- `html` (1 argument): html(x): rich text as HTML
- `file` (3 arguments): file(bytes, name, content_type): a file
- `request_file` (1 argument): request_file(name): a file uploaded with the request, or none
- `words_only` (1 argument): words_only(text): with punctuation removed
- `max` (2 arguments): max(a, b): the larger
- `min` (2 arguments): min(a, b): the smaller
- `cookie` (1 argument): cookie(name): a cookie's value, or none
- `download` (1 argument): download(file): a file's download address
- `matches` (2 arguments): matches(text, pattern): whether it matches a pattern
- `set` (1 argument): set(x): a set of rows, from rows or a list

## Built-in widgets

`copy_button`, `share_button`, `qr_link`, `lightbox`, `autocomplete`, `push_permission`

## Externs and Go bindings

`extern fn name(params): Result effect E`, optionally ending `= go "pkg".Func` (a Go package's function) or `= go Func` (one in the app's `ext.go`). A module outside the standard library is pinned with `import go "module@version"`. `node lang/cli.ts bind <package>` prints the lines for a package.

- **Effects:** `pure` (the same arguments give the same result; reads and changes nothing outside the app) may be called anywhere. `fetch` (only reads from outside) may be called in workflow steps and value views. Any other name (`mail`, `http`, …) may be called in workflow steps only.
- **Results from Go:** none; a value; `error`, seen as `Text?` (the message, none when it worked); `(value, error)`, seen as the value made optional.

| Spec type | Go type |
| --- | --- |
| `Text` | string or []byte |
| `Email` | string or []byte |
| `Url` | string or []byte |
| `Int` | int, int8…int64, uint…uint64 (a value that doesn't fit is refused) |
| `Bool` | bool |
| `Time` | time.Time |
| `Duration` | time.Duration |
| `list of Text` | []string |

## Checks

What `check` (and `--deep`, and `build`) reports, by code: an error stops the build; a warning names a likely mistake. Read from the checkers' own source, with what each message says (… is a name or value the message fills in). `LANGUAGE.md` explains the deep ones.

| Code | | Pass | Says |
| --- | --- | --- | --- |
| `ACTION_UNREACHABLE` | warning | check | no screen, API route or channel offers …; the runtime generates /_auto/actions/… for it (cli scaffold prints it) |
| `AGENT_PAGE_UNLINKED` | warning | check | no screen links to /_agents, where people issue agent tokens; link it from an account or profile screen with <Link href="/_agents" label="…" /> |
| `AGENT_UNDOCUMENTED` | warning | check | … of the actions and views agents can call have no comment above them saying what they're for, which agents read as the description: … |
| `AGENTS_NO_UNSTATED` | warning | check | …, so agents can't call it; say agents no at the top of its body, so the spec shows it |
| `APP_INDEXES` | error | check | app indexes takes auto (the indexes the app's queries want, kept in step) or declared (only those the entities declare) |
| `ARITY` | error | check | … takes … arguments, given … |
| `AVATAR_UNDECLARED` | error | types | <…> of a …, which has no avatar: declare one, avatar …: initials(.name) |
| `BUILTIN_ARGUMENT` | error | check | … takes a list first: …(list…), given a … |
| `CALLERS_INTERNAL` | warning | check | … is internal: neither agents nor people call it, so … no says nothing |
| `CALLERS_NONE` | error | check | … says agents no and people no: no one could call it; make it an internal action |
| `DELETE_RESTRICTED` | warning | deep | a delete that a restricting reference can refuse, with no check first |
| `DROP_DECLARED` | error | check | drop entity …, but … is still declared |
| `DUPLICATE` | error | check | … is declared twice |
| `DUPLICATE_FIELD` | error | check | … is given twice |
| `ENUM_VALUE_UNREACHABLE` | warning | deep | an enum field can never hold a value: no default, create, set or migration gives it, or every transition into it starts from a value the field can never hold (transitions are read from the requires and ifs that guard each set) |
| `EXPORT_COLUMN` | error | check | export … has column "…" twice |
| `EXPORT_SOURCE` | error | check | export … is of a view's rows: … of <view>(…)… |
| `EXTERN_OUTSIDE_WORKFLOW` | error | check | extern … (effect …) called outside a workflow step |
| `FIELD_KIND_MISMATCH` | error | check | field … is a multi-select (users), but ….… is not a set |
| `FIELD_NEVER_READ` | warning | deep | a field is written in creates/sets but never read in any expression |
| `FIELD_NEVER_WRITTEN` | warning | deep | a field nothing reads or sets |
| `FIELD_NOT_A_PARAMETER` | error | check | … has no parameter … |
| `FIELD_OUTSIDE_FORM` | error | check | field … outside a form |
| `FIELD_READ_NEVER_SET` | warning | deep | a field is read, but nothing sets it: it always holds its default, or none |
| `FIELD_WITHOUT_CHOICES` | error | check | field … needs from [values] |
| `GO_EFFECT` | error | check | extern …: choose its effect (lang/cli.ts bind leaves TODO): pure when the same arguments always give the same result and it reads and changes nothing outside the app (not the clock or randomness), fetch when it only reads from outside, otherwise a name for what it does (mail, http, …) |
| `GO_IMPORT` | error | check | extern … binds to "…", which isn't the standard library: add import go "<module>@<version>" |
| `GO_TYPE` | error | check | extern …: parameter … can't be passed to Go; the types a binding takes: …, list of Text (not optional) |
| `GUARD_MISSING` | warning | deep | an action leaves out a check on who acts that every other action doing the same to a row of that entity (three or more) makes |
| `HREF_INTERNAL` | error | check | … href "…" is no screen's address |
| `INDEX_UNUSED` | warning | cost | an index the spec declares that no query's plan uses: it costs every write and serves no read |
| `INTERNAL_ACTION_OFFERED` | warning | check | internal action … is offered outside a channel |
| `INVARIANT_AMBIENT` | error | check | invariant … reads …: an invariant is a fact about the stored data, true whoever asks and whenever |
| `INVARIANT_BROKEN` | error | build | an action or workflow step can break an invariant: the proof's counterexample |
| `IT_OUTSIDE_WHERE` | error | check | 'it' outside a where |
| `LAYOUT_NOT_RENDERED` | warning | check | layout …: <…> isn't rendered: the page shell has only Nav, Flash, Main, Footer and Sidebar slots; put it in a screen's <Footer> or <Nav>, or a component the screens use |
| `LINK_ARGS` | error | check | a link to screen … without its parameter … |
| `LINK_NOT_ALLOWED` | warning | deep | a link to a screen whose require on the viewer isn't known where the link is |
| `MAIL_FIELD` | error | check | send mail has no …; it takes: … |
| `MAIL_TO` | error | check | send mail's to is an Email, not … |
| `MAIL_UNSUBSCRIBE` | error | check | schedule … sends mail on its own, so the mail needs an unsubscribe link: send mail { …, unsubscribe: url_of(…) } |
| `MATCH_DUPLICATE` | error | types | … has two arms |
| `MATCH_ELSE` | error | parse | a match has no else: give each value its arm, so a value added to the enum later has to be handled too |
| `MATCH_EMPTY` | error | parse | a match needs an arm for each value |
| `MATCH_MISSING` | error | types | the match has no arm for …: every value of … needs one |
| `MATCH_NOT_ENUM` | error | types | match takes an enum value; this is … |
| `MATCH_UNKNOWN` | error | types | … here is never none |
| `MATCHES_UNSEARCHABLE` | warning | check | matches searches ….…, which isn't marked searchable: mark it (…: … searchable), so the spec says it is searched |
| `MIGRATION_EFFECT` | error | check | migration "…" can't send mail |
| `MISSING_FIELD` | error | check | create … without required field … |
| `MISSING_INPUT` | error | check | button calls … without its parameter … |
| `NATIVE_IN_APP` | error | check | native …: only the standard library declares native components; write a component instead |
| `OPTION_REPEATED` | error | parse | … is set twice |
| `OPTION_VALUE` | error | parse | … takes …, not '…' |
| `OUTCOME_UNHANDLED` | warning | deep | a form or button handles some outcomes with <on>, but not one that what is entered can bring about (a require on a field, a unique key unchecked) |
| `PARSE_API` | error | parse | route takes the address in quotes |
| `PARSE_DECL` | error | parse | expected a declaration, found '…' |
| `PARSE_EXPECTED` | error | parse | expected '…', found '…' |
| `PARSE_EXPORT` | error | parse | route takes the address in quotes: route "/rooms/:room/export.csv" |
| `PARSE_EXPR` | error | parse | expected an expression, found '…' |
| `PARSE_FIELD` | error | parse | write on change touch |
| `PARSE_IF` | error | parse | write an expression's if as if c { a } else { b } |
| `PARSE_IMPORT` | error | parse | import go takes a quoted module path with its version: import go "github.com/owner/mod@v1.2.3" |
| `PARSE_MIGRATION` | error | parse | a migration needs a quoted name |
| `PARSE_OPTION` | error | parse | … takes no (… no); did you mean no? |
| `PARSE_OPTIONS` | error | parse | write skip gate … as the first line of the action's body |
| `PARSE_OUTCOME` | error | parse | unknown outcome '…'… |
| `PARSE_PROJECTION` | error | parse | write …(<…> for … where …) |
| `PARSE_SCHEDULE` | error | parse | every day at takes a quoted time of day: every day at "08:00" |
| `PARSE_SCREEN` | error | parse | route takes the address in quotes: route "/rooms/:room" |
| `PARSE_SET` | error | parse | set needs a field: set x.f = value |
| `PARSE_SIGNAL` | error | parse | signal … needs to … (who gets it) and carries { … } (what it sends) |
| `PARSE_STMT` | error | parse | expected a statement, found '…' |
| `PARSE_THEME` | error | parse | write classes { button: "…", … }, without json |
| `PARSE_VIEW` | error | parse | unexpected '…' in view |
| `PARSE_WINDOW` | error | parse | a window ends first or last, not … |
| `PEOPLE_NO_OFFERED` | error | check | view … says people no: only agents call it, so no screen shows it |
| `PEOPLE_NO_WITHOUT_AGENTS` | error | check | … says people no, but the app has no agent identity (identity … from token), so no one could call it |
| `PRIVATE_FIELD` | error | check | ….… is private, so it can't go in … |
| `QUERY_SORTED` | warning | cost | the plan sorts every match to keep a few (USE TEMP B-TREE FOR ORDER BY, with a LIMIT): an index in that order would read just those |
| `QUERY_UNINDEXED` | warning | cost | the plan reads the whole table (SCAN): no index serves the condition |
| `ROUTE_PARAM` | error | check | screen …'s address … names :…, which isn't one of its parameters |
| `ROUTE_SHADOWED` | error | check | screen … (…) is never reached: screen … (…), earlier, takes every address it does; put … first, or change an address |
| `ROW_NAME_SHADOWS` | error | check | the loop variable … is also a … value: name the row differently (for each …_row in …) |
| `ROW_NAMED` | error | parse | the row is named … here: write …, not it |
| `ROWFIELD_OUTSIDE_WHERE` | error | check | .… outside a where |
| `SCHEDULE_AT` | error | check | schedule …: at takes a Time field of …, optionally plus or minus a duration: at ….send_at, at ….updated + 30 day |
| `SCHEDULE_CONTEXT` | error | check | schedule … runs with no request, so it can't use … |
| `SCHEDULE_PERIOD` | error | check | schedule …: every … is too often; the shortest period is 1 min |
| `SCHEDULE_ZONE` | error | check | schedule …: unknown time zone "…" (an IANA name, like "America/New_York") |
| `SCREEN_SHOWS_UNPERMITTED` | error | check | a list shows … rows, which have no read permission |
| `SCREEN_UNREACHABLE` | warning | deep | a screen no chain of links reaches from home, sign-in, setup, or mail and the like |
| `SIGNAL_NOT_SENT` | warning | check | signal … is checked, but the compiled app doesn't send signals yet: <Signal …(…)> shows nothing, and no page hears it |
| `SIGNED_OUT_UNLIMITED` | warning | deep | an action open to signed-out callers writes, with no rate limit |
| `SIZE_FORM_LONGER` | warning | types | the form lets … take … characters, but … accepts at most … |
| `SIZE_LITERAL` | error | types | "…" doesn't fit ….… (…) |
| `STORED_COLLECTION` | error | check | ….… is a … of …; a stored field holds one value. Keep the collection as rows: an entity with a reference to … (and one to each member), or a view over them |
| `THE_NOT_UNIQUE` | warning | deep | `the()` or `the_or_none()` query whose condition doesn't guarantee a unique key match: can fail at runtime with more than one row |
| `THEME_CLASS_UNKNOWN` | warning | check | nothing reads the theme class …: the runtime reads …, and the app's widgets read … |
| `THEME_CLASSES` | error | check | classes takes { kind: "class", … } |
| `TRIGGER_CYCLE` | warning | deep | triggers that can set each other off, round and round |
| `TYPE_ENUM_TEXT` | warning | types | a … compared with the text field …: is a … field meant? (equal only when … holds a value's name, such as …) |
| `TYPE_FIELD_OF_NONE` | warning | types | .… of none is always none |
| `TYPE_MAYBE_NONE` | warning | types | … is required, but the value may be none |
| `TYPE_MISMATCH` | error | check | … compared with … |
| `TYPE_NEVER_EQUAL` | error | types | a Password is stored hashed, so … never compares what was typed: check it with authenticates(password, typed) |
| `TYPE_NEVER_NONE` | warning | types | … is never none, so … none is always … |
| `TYPE_NO_FIELD` | error | types | … has no field … |
| `TYPE_NONE` | error | types | … can't be none |
| `TYPE_NOT_BOOL` | error | types | … is …, not a Bool; it is never true |
| `TYPE_OPTIONAL_ARITHMETIC` | warning | types | a number that may be none counts as 0 |
| `TYPE_OPTIONAL_BOOL` | warning | types | … may be none, which counts as false |
| `UI_ATTR` | error | parse | …'s … is given twice |
| `UI_ATTR_FLAG` | error | parse | … is a flag: write it alone |
| `UI_ATTR_VALUE` | error | parse | … needs a value: …="…" or …={…} |
| `UI_CHILDREN` | error | parse | … has no children |
| `UI_CLOSE` | error | parse | expected </…>, found </…> |
| `UI_CODE` | error | parse | {…}: unknown code; did you mean …? |
| `UI_ELSE` | error | parse | <else> must follow an <if> |
| `UI_EXPECTED` | error | parse | a screen's parts are elements, {if …}, {let …}, {for each …} or {match …}: text goes in an element… |
| `UI_FIELD_KIND` | error | parse | unknown field kind '…'… |
| `UI_HEAD` | error | parse | … needs … |
| `UI_HTML_ATTR` | error | parse | …=…: an HTML attribute's value is "text" or {value}… |
| `UI_HTML_ATTR_UNKNOWN` | warning | check | <…>: HTML's <…> has no attribute … |
| `UI_HTML_BUILTIN` | error | check | <…=…> is plain HTML, where … means nothing: … |
| `UI_HTML_FORM` | warning | check | a plain <form> can't run an action (the runtime signs a <Form>'s): use <Form action={…}> |
| `UI_HTML_HANDLER` | error | check | <…>: a page's script comes from the runtime and the app's widgets, not attributes |
| `UI_HTML_SCRIPT` | error | check | <script>: a page's script comes from the runtime and the app's widgets |
| `UI_HTML_SLOT` | error | check | layout …: <…> is plain HTML: the layout's … is <…> |
| `UI_HTML_STYLE` | error | parse | <style>: styles go in the theme's stylesheets (theme t { stylesheets ["app.css"] }), and elements take a class |
| `UI_HTML_UNKNOWN` | warning | check | <…> is no HTML element… |
| `UI_HTML_URL` | error | check | <…="…">: only relative, http(s), mailto and tel addresses (and data: images in an <img>) |
| `UI_NAME` | error | parse | … takes a name, not text: …=… |
| `UI_OLD_FORM` | error | parse | write {if c { … } else { … }} among the elements |
| `UI_REACTION` | error | parse | write clear_form |
| `UI_TAG_CASE` | error | parse | <…>: write <…> (built-in elements and components start with a capital) |
| `UI_TEXT` | error | parse | … holds text and {…}, not elements |
| `UI_TEXT_CODE` | warning | check | "…" shows as text: code among elements goes in braces, {…} |
| `UI_TEXT_QUOTED` | warning | check | … shows with its quotes: in a block, text is written as it shows (…), or as {…} |
| `UNIQUE_UNGUARDED` | warning | deep | a create of a uniquely keyed row from the caller's values, with no `ensure` and no check for an existing row first |
| `UNKNOWN_ACTION` | error | check | unknown action … |
| `UNKNOWN_ARGUMENT` | error | check | … has no parameter … |
| `UNKNOWN_CHANNEL` | error | check | unknown channel … |
| `UNKNOWN_COMPONENT` | error | check | unknown component … |
| `UNKNOWN_ENTITY` | error | check | unknown entity … |
| `UNKNOWN_EXTERN` | error | check | unknown extern … |
| `UNKNOWN_FIELD` | error | check | … has no field … |
| `UNKNOWN_FUNCTION` | error | check | unknown function … |
| `UNKNOWN_GATE` | error | check | skip of unknown gate … |
| `UNKNOWN_LAYOUT` | error | check | unknown layout … |
| `UNKNOWN_NAME` | error | check | unknown name … |
| `UNKNOWN_SCREEN` | error | check | … to unknown screen … |
| `UNKNOWN_SIGNAL` | error | check | unknown signal … |
| `UNKNOWN_TARGET` | error | check | api route calls unknown action or view … |
| `UNKNOWN_TYPE` | error | check | unknown type … |
| `UNKNOWN_VIEW` | error | check | list of unknown view … |
| `UNKNOWN_WIDGET` | error | check | unknown widget …; declare it with "widget …(…)" and implement it in the app's widget module |
| `UPGRADE_UNSUPPORTED` | error | parse | <…> with …: rewrite it by hand |
| `URL_OF_CALL` | error | check | url_of takes … with its arguments: url_of(…(…)) |
| `VIEW_WITHOUT_PERMISSION` | error | check | … returns … rows, which have no read permission |
| `WAS_CONFLICT` | error | check | … was …, but … is still declared |
| `WORKFLOW_NEVER_RUNS` | warning | check | nothing emits … |
| `WORKFLOW_STALE_CHECK` | warning | deep | a workflow step acts on a row whose field the emitting action set, without reading it again, though another body can change it meanwhile |
| `WRITE_ONLY_READ` | error | deep | (an error) a field declared write_only is read somewhere: remove write_only, or the read |
| `WRITE_UNCHECKED` | warning | deep | an action changes or deletes a row the caller chooses, and nothing before the write checks the actor |


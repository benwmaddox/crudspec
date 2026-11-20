# crudspec reference

Generated from the parser, checker and type pass (`node lang/cli.ts reference`). Don't edit: `lang/std/ui.crud` describes the elements and field kinds, `lang/reference.ts` the rest. `LANGUAGE.md` explains the language; this lists everything in it.

## UI elements

`<name attr="text" attr={expression} flag>children</name>`, or `<name … />`. An attribute shown as `name={…}` takes a value (`"text"` or `{expression}`); one shown bare is a flag.

### `<RichText>`

Formatted text (a RichText value).

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `autolink` links addresses in the text.

### `<Markdown>`

Text written in Markdown, as HTML: headings, lists, tables, links, images, code. HTML in the text shows as text, and a link or image keeps to relative, http(s) and mailto addresses. [[Name]] and [[Name|shown]] link to the `links` address with the name appended.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `links={…}` where [[Name]] links go: the name is appended to this address ("/pages/"); `known={…}` the names that exist (a list of text, in any case): a [[link]] to any other gets class="new"; `toc` a list of contents before the text, when it has three or more headings (h2, h3); `sortable` its tables sort by a column when its heading is clicked (th[data-sort] says which, for the stylesheet); `include={…}` {{Name}} in the text is this lookup's text, rendered there: a call with _ for the name (include={page_text(w, _)}); {{Name|a=1}} fills {{{a}}} in it; `files={…}` [[File:Name.png|caption|200px]] in the text is an image at this lookup's address: a call with _ for the name (files={image_url(w, _)}).

### `<ThemeToggle>`

A button between the app's two themes: it sets html[data-theme] to the other one, and the browser remembers it. The stylesheet styles :root as the default theme and :root[data-theme=…] as the other.

- **Head:** nothing: just its attributes and children.
- **Children:** no.
- **Attributes:** `default={…}` the theme the stylesheet shows with no data-theme: "dark" (when not said) or "light".

### `<MarkdownEditor>`

Formatting buttons, an image picker and a live preview for the next Markdown text field (a textarea) in its form, with the preview as <Markdown> shows it.

- **Head:** nothing: just its attributes and children.
- **Children:** no.
- **Attributes:** `links={…}` where [[Name]] links go, as <Markdown links> (none: no page-link button); `known={…}` the names that exist (a list of text): the preview marks links to others as <Markdown known> does; `images={…}` images the picker offers: a list of "address|caption" texts; `files` the picker inserts an image by its name, [[File:caption]], for a <Markdown files={…}> (each image's caption is its name).

### `<Time>`

A time, as a date or a time of day.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `as={…}` how a time shows: `{date}` (Mon Jan 02 2006) or `{time}` (3:04 PM, the default).

### `<Image>`

An image from a file or a path under the assets.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `width={…}` the image's width; `height={…}` the image's height; `thumb={…}` an uploaded image at most this many pixels wide: a thumbnail the app makes and keeps (100, 200, 400, 800 or 1600; rounded up).

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

One of the runtime's widgets (`copy_button`, `share_button`, `qr_link`, `lightbox`, `autocomplete`, `push_permission`). For your own: behaviors, or a declared element.

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

### `<Popup>`

A button that opens a panel.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.
- **Attributes:** `panel={…}` the class of a popup's panel.

### `<Go>`

Goes to a screen at once (in a screen's if: a redirect).

- **Head:** where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms.
- **Children:** no.

### `<Title>`

The page's title.

- **Head:** its text as content: raw text and `{expression}`, as `<Title>{n} items left</Title>` (spaces and line breaks show as one space; write `{"{"}`, `{"}"}` and `{"<"}` for those characters).
- **Children:** no.

### `<Description>`

What the page is about, in a sentence or two: its <meta name="description">, which search engines and link previews show.

- **Head:** its text as content: raw text and `{expression}`, as `<Title>{n} items left</Title>` (spaces and line breaks show as one space; write `{"{"}`, `{"}"}` and `{"<"}` for those characters).
- **Children:** no.

### `<Slot>`

A place something goes: in a layout, where a screen's part goes (named); in a component, where what its user writes between its tags goes (named, or none for everything but the fills).

- **Head:** optionally `name=…`.
- **Children:** no.

### `<Flash>`

Where flash messages show, in a layout.

- **Head:** nothing: just its attributes and children.
- **Children:** no.

### `<Fill>`

A part of a component's content, by name, written between the component's tags (the component has a <Slot name=…> for it).

- **Head:** `name=…`.
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
- `conflict`: the row changed since the person read it, such as a save over a newer revision (409)
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
- `before_last` (2 arguments): before_last(text, sep): the text before the last sep ("" without one): before_last("Damage/Cost", "/") is "Damage"
- `after_last` (2 arguments): after_last(text, sep): the text after the last sep (all of it without one): after_last("Damage/Cost", "/") is "Cost"
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
- `max` (2 arguments): max(a, b): the larger (Ints or Decimals)
- `min` (2 arguments): min(a, b): the smaller
- `round` (1-2 arguments): round(x): the Int nearest, half to even; round(x, places): a Decimal kept to them
- `floor` (1 argument): floor(x): the Int at or below x
- `ceil` (1 argument): ceil(x): the Int at or above x
- `abs` (1 argument): abs(x): x without its sign
- `today` (0 arguments): today(): today's Date in the app's time zone
- `date` (3 arguments): date(year, month, day): a Date (an impossible day refuses)
- `to_date` (1 argument): to_date(text): a Date from 2026-11-18, or none
- `date_of` (1 argument): date_of(time): the Date an instant falls on in the app's time zone
- `year` (1 argument): year(date): its year
- `month` (1 argument): month(date): its month, 1 to 12
- `day` (1 argument): day(date): its day of the month
- `weekday` (1 argument): weekday(date): 1 Monday to 7 Sunday
- `add_days` (2 arguments): add_days(date, n): n days later (earlier when negative)
- `add_months` (2 arguments): add_months(date, n): n months later, a missing day becoming the month's last
- `add_years` (2 arguments): add_years(date, n): n years later (Feb 29 becomes Feb 28)
- `days_between` (2 arguments): days_between(a, b): the days from a to b
- `months_between` (2 arguments): months_between(a, b): the whole months from a to b
- `years_between` (2 arguments): years_between(a, b): the whole years from a to b (an age)
- `start_of_month` (1 argument): start_of_month(date): the month's first day
- `end_of_month` (1 argument): end_of_month(date): the month's last day
- `start_of_day` (1 argument): start_of_day(date): the Time it starts, in the app's time zone
- `end_of_day` (1 argument): end_of_day(date): the last Time of it, in the app's time zone
- `format_date` (2 arguments): format_date(date, pattern): as text, e.g. "MM/DD/YYYY" or "dddd, MMMM D"
- `to_email` (1 argument): to_email(text): the text as an Email, or none when it isn't one
- `to_url` (1 argument): to_url(text): the text as a Url (http or https, with a host), or none
- `to_ip` (1 argument): to_ip(text): the text as an Ip (v4 or v6), or none
- `to_decimal` (1 argument): to_decimal(n): an Int as a Decimal (no places)
- `default` (1-2 arguments): default(x, fallback): x, or the fallback when x is none; default(x) falls back on 0, "" or false
- `in_app` (1 argument): in_app(x): x, worked out in the app rather than the database: the opt-in for a part of a query that SQL can't do (Item where .shop == s and in_app(f(.name))); without it, such a part is an error (QUERY_IN_APP)
- `when` (2 arguments): when(condition, text): the text when the condition holds, else none (class={["todo", when(done, "completed")]})
- `join_classes` (1 argument): join_classes(list): the entries that aren't none, joined with a space between each (what class={[…]} is)
- `in_hours` (1 argument): in_hours(duration): its hours, as a Decimal (d.in_hours())
- `in_minutes` (1 argument): in_minutes(duration): its minutes, as a Decimal (d.in_minutes())
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
| `ADDRESS_FIELD` | error | check | address …: … has no field … |
| `ADDRESS_UNIQUE` | error | check | address …: two rows can't share an address; add unique (…) |
| `ADMIN_ESCALATION` | error | deep | (an error) an action sets, or gives the caller's value to, a field the app's admin condition reads, without requiring an administrator first: only administrators make administrators |
| `ADMIN_NO_ACTOR` | error | check | admin says which actor is an administrator, so the app needs an actor: actor <Entity> |
| `AGENT_PAGE_UNLINKED` | warning | check | no screen links to /_agents, where people issue agent tokens; link it from an account or profile screen with <Link href="/_agents" label="…" /> |
| `AGENT_UNDOCUMENTED` | warning | check | … of the actions and views agents can call have no comment above them saying what they're for, which agents read as the description: … |
| `AGENTS_NO_UNSTATED` | warning | check | …, so agents can't call it; say callers people at the top of its body, so the spec shows it |
| `API_IDENTITY` | error | check | api …: identity … comes from a …, but an API's caller comes from its address: use a parameter identity (identity key: Bot from param key), or leave identity out for calls that are anyone's |
| `API_TEXT` | error | check | …: as text sends one value as plain text: a view with value …, or an action's result, and not as json too |
| `APP_AGENT_LIMIT` | error | check | … is a number of calls a minute, more than 0: … 60 |
| `APP_AGENTS_OFF` | warning | check | the app sets how agents call, but has no agent identity (identity agent: User from token), so there is no agent interface |
| `APP_INDEXES` | error | check | app indexes takes auto (the indexes the app's queries want, kept in step) or declared (only those the entities declare) |
| `APP_SETTING_UNKNOWN` | error | check | app … has no setting …; the settings: … |
| `APP_TIME_ZONE` | error | check | time_zone takes a zone's name: time_zone "America/New_York"… |
| `APP_WARNINGS` | error | check | app warnings takes error: warnings error makes every warning an error, so check and verify fail on any |
| `ARITY` | error | check | … takes … arguments, given … |
| `AUTH_IN_LOOP` | warning | check | … checks a password inside a for each: if no row matches (an unknown email), the loop body never runs and the action ends ok. Look the row up with the_or_none(…) and write require user != none and authenticates(user.password, password) else unauthenticated |
| `AVATAR_UNDECLARED` | error | types | <…> of a …, which has no avatar: declare one, avatar …: initials(.name) |
| `BEHAVIOR_FIELD_KIND` | error | check | a … field takes no cs:ref or behaviors; they go on fields people type in (…) |
| `BEHAVIOR_PREFIX` | error | parse | <…>: write cs:… (a behavior or ref is crudspec's, so it carries cs:) |
| `BEHAVIOR_REF_UNKNOWN` | error | check | no element has cs:ref=… |
| `BEHAVIOR_UNKNOWN` | error | parse | <… cs:…>: no behavior … |
| `BLOCK_SELF_LIFT` | warning | deep | an action lets the actor delete their own row of an entity whose rows restrict someone (not exists(E …)) |
| `BUILTIN_ARGUMENT` | error | check | … takes a list first: …(list…), given a … |
| `CHANNEL_EVERY` | error | check | channel …: every … is no interval; the page calls it this often (every Duration.seconds(50)) |
| `DECL_UNUSED` | warning | check | … is used nowhere: remove it, or use it where it was meant |
| `DEFAULT_NEVER_NONE` | warning | types | … is never none, so default() gives it as it is: remove the default |
| `DEFAULT_NO_EMPTY` | error | types | … has no empty value to fall back on: say which, default(x, …) |
| `DELETE_RESTRICTED` | warning | deep | a delete that a restricting reference can refuse, with no check first (a reference to the row, or to a row the delete cascades to) |
| `DROP_DECLARED` | error | check | drop entity …, but … is still declared |
| `DUPLICATE` | error | check | … is declared twice… |
| `DUPLICATE_FIELD` | error | check | … has two fields named … |
| `DUPLICATE_PARAM` | error | check | … has two parameters named … |
| `ELEMENT_ATTR_MISSING` | error | check | <…> needs …={…} (element … declares it) |
| `ELEMENT_ATTR_UNKNOWN` | error | check | <…> has no attribute … |
| `ELEMENT_NAME` | error | parse | element …: a web component's tag has a hyphen (…-view) |
| `ELEMENT_PARAM_TYPE` | error | check | element …'s …: an attribute carries Text, Url, Email, Int, Bool or an enum value, not … |
| `ELEMENT_SCRIPT` | error | check | element …'s script is a .js file beside the spec: from "….js" |
| `ENUM_DUPLICATE` | error | check | enum … has … twice |
| `ENUM_VALUE_UNREACHABLE` | warning | deep | an enum field can never hold a value: no default, create, set or migration gives it, or every transition into it starts from a value the field can never hold (transitions are read from the requires and ifs that guard each set) |
| `EXPORT_COLUMN` | error | check | export … has column "…" twice |
| `EXPORT_SOURCE` | error | check | export … is of a view's rows: … of <view>(…)… |
| `EXTERN_OUTSIDE_WORKFLOW` | error | check | extern … (effect …) called outside a workflow step |
| `EXTERN_SIGNATURE` | error | check | the runtime's … takes … argument…, not …: … |
| `EXTERN_UNKNOWN` | error | check | the runtime has no extern … |
| `FIELD_KIND_MISMATCH` | error | check | field … is a multi-select (users), but ….… is not a set |
| `FIELD_NEVER_READ` | warning | deep | a field is written in creates/sets but never read in any expression |
| `FIELD_NEVER_WRITTEN` | warning | deep | a field nothing reads or sets |
| `FIELD_NOT_A_PARAMETER` | error | check | … has no parameter … |
| `FIELD_OUTSIDE_FORM` | error | check | field … outside a form |
| `FIELD_READ_NEVER_SET` | warning | deep | a field is read, but nothing sets it: it always holds its default, or none |
| `FIELD_WITHOUT_CHOICES` | error | check | field … needs from [values] |
| `FN_BODY` | error | parse | fn …'s body ends with the value it gives: after its lets, an expression |
| `FN_LET_NAME` | error | parse | let …: … has a parameter …; give the let another name |
| `FN_OVERLOAD` | error | types | … is declared for …: … |
| `FN_QUERIES` | error | check | … reads the database (…): declare it query …(…), as a fn is pure (did you mean query?) |
| `FORM_TO_ARGUMENT` | error | check | <Form to={…(…)}> gives …, which is not part of the screen's address (…): only an address part can be fixed in the call; the form's fields fill the others |
| `FORM_TO_ON` | error | check | a form that navigates has no outcomes: it goes to the screen. <On> belongs to a form that runs an action |
| `FORM_TO_ROUTE` | error | check | … is part of …'s address (…), so a form can't fill it: give it in the call, or take it out of the route so that it travels in the query |
| `FORM_TO_TYPE` | error | check | …'s … can't come from a form's field: a form that navigates fills text, numbers, yes/no, choices and references |
| `GO_EFFECT` | error | check | extern …: choose its effect (lang/cli.ts bind leaves TODO): pure when the same arguments always give the same result and it reads and changes nothing outside the app (not the clock or randomness), fetch when it only reads from outside, otherwise a name for what it does (mail, http, …) |
| `GO_IMPORT` | error | check | extern … binds to "…", which isn't the standard library: add import go "<module>@<version>" |
| `GO_TYPE` | error | check | extern …: parameter … can't be passed to Go; the types a binding takes: …, list of Text (not optional) |
| `GUARD_MISSING` | warning | deep | an action leaves out a check on who acts that every other action doing the same to a row of that entity (three or more) makes, or on the row, every other action given one that writes (four or more) |
| `HREF_INTERNAL` | error | check | … href "…" is no screen's address |
| `INDEX_UNUSED` | warning | cost | an index the spec declares that no query's plan uses: it costs every write and serves no read |
| `INTERNAL_ACTION_OFFERED` | warning | check | internal action … is offered outside a channel |
| `INVARIANT_AMBIENT` | error | check | invariant … reads …: an invariant is a fact about the stored data, true whoever asks and whenever |
| `INVARIANT_BROKEN` | error | build | an action or workflow step can break an invariant: the proof's counterexample |
| `IT_OUTSIDE_WHERE` | error | check | 'it' outside a where |
| `LAYOUT_NOT_RENDERED` | warning | check | layout …: <…> isn't rendered: the page shell has only nav, flash, main, footer and aside places; put it in a screen's <Fill name=footer> or <Fill name=nav>, or a component the screens use |
| `LET_UNUSED` | warning | check | let … in … is read nowhere: remove it, or use it where it was meant |
| `LEX_CHAR` | error | parse | unexpected character '…'… |
| `LEX_STRING` | error | parse | unterminated string |
| `LINK_ARGS` | error | check | a link to screen … without its parameter … |
| `LINK_NOT_ALLOWED` | warning | deep | a link to a screen whose require on the viewer isn't known where the link is |
| `LINK_NOT_UNIQUE` | warning | deep | a row that only links two others, with no unique key over the pair |
| `LINK_TEXT` | warning | check | "…" builds an address of screen … by hand: write url_of(…(…)) (path(url_of(…)) for a path) so the compiler checks it, and it follows the route |
| `LOOKUP` | error | check | <Markdown …={…}> is a call of a function or query of the spec with _ as its last argument, where each name goes: …={…(p.wiki, _)} |
| `LOOKUP_NOT_UNIQUE` | warning | check | the_or_none(… where …) can match more than one …, and is none when it does, as when none matches: match … with ==, or say which row you mean with first_or_none, or ask exists(…) |
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
| `NOT_LOADED` | error | loading | a field of a row that wasn't loaded (only its id is there): add with .ref to the query or parameter it comes from (no lazy loading: docs/design/explicit-loading.md) |
| `NULLIFY_REQUIRED` | error | check | ….…: on delete nullify leaves the field none, so its type must be optional (…?) |
| `ON_DELETE_UNKNOWN` | error | check | ….…: on delete … isn't a rule: cascade, restrict or nullify… |
| `OPTION_REPEATED` | error | parse | … is set twice |
| `OPTION_VALUE` | error | parse | … takes …, not '…' |
| `ORDER_BY_ROW` | warning | types | ordered by a …, which orders by its id (the order they were made in)… |
| `OUTCOME_UNHANDLED` | warning | deep | a form or button handles some outcomes with <on>, but not one that what is entered can bring about (a require on a field, a unique key unchecked) |
| `PARENT_HIDDEN` | warning | deep | a row whose policy admits rows whose required parent the parent's policy hides |
| `PARSE_AGGREGATE` | error | parse | expected for: …(<value> for Entity where …) |
| `PARSE_API` | error | parse | route takes the address in quotes |
| `PARSE_APP` | error | parse | write …_screen: it names a screen (… is the old spelling) |
| `PARSE_DECL` | error | parse | a predicate is a fn that returns Bool: fn <name>(params): Bool = <condition> |
| `PARSE_DURATION` | error | parse | write Duration.…(…) for … (a Duration is made by Duration.milliseconds, seconds, minutes, hours or days) |
| `PARSE_ENUM` | error | parse | an enum's values are written in braces: enum … { a, b, c } |
| `PARSE_EXPECTED` | error | parse | expected '…', found '…' |
| `PARSE_EXPORT` | error | parse | route takes the address in quotes: route "/rooms/:room/export.csv" |
| `PARSE_EXPR` | error | parse | expected an expression…, found '…' |
| `PARSE_FIELD` | error | parse | PARSE_EXPECTED |
| `PARSE_IF` | error | parse | write an expression's if as if c { a } else { b } |
| `PARSE_IMPORT` | error | parse | import go takes a quoted module path with its version: import go "github.com/owner/mod@v1.2.3" |
| `PARSE_MIGRATION` | error | parse | a migration needs a quoted name |
| `PARSE_OPTION` | error | parse | skip takes policy and the policy's name (skip policy signed_in); did you mean policy? |
| `PARSE_OPTIONS` | error | parse | write skip policy … as the first line of the action's body |
| `PARSE_OUTCOME` | error | parse | unknown outcome '…'… |
| `PARSE_POLICY` | error | parse | after the condition comes else <outcome>, or for rows of <Entity> or for rows in <Entity>… |
| `PARSE_PROJECTION` | error | parse | write …(<…> for … where …) |
| `PARSE_ROUTE` | error | parse | an address starts with a slash: route "/…" |
| `PARSE_SCHEDULE` | error | parse | every day at takes a quoted time of day: every day at "08:00" |
| `PARSE_SCREEN` | error | parse | route takes the address in quotes: route "/rooms/:room" |
| `PARSE_SET` | error | parse | set needs a field: set x.f = value |
| `PARSE_SIGNAL` | error | parse | signal … needs to … (who gets it) and carries { … } (what it sends) |
| `PARSE_STAMP` | error | parse | a stamp is set on create or on change… |
| `PARSE_STMT` | error | parse | a delete names the row, or the entity and its where: delete n, or delete Note where .done |
| `PARSE_SUBSET` | error | parse | a subset is written subset … = … where <condition> |
| `PARSE_TEST` | error | parse | a test is named by a quoted sentence: test "a stranger can't read a private wiki" { … } |
| `PARSE_THEME` | error | parse | write classes { button: "…", … }, without json |
| `PARSE_VIEW` | error | parse | write page n first\|last [unless c]: window is the old spelling |
| `PARSE_WINDOW` | error | parse | page n takes first, last or around, not … |
| `PARSE_WITH` | error | parse | with names the references to load: with .creator, .room.owner |
| `PATHS_DISAGREE` | warning | deep | a field of a row and the same field of a row it requires, with no invariant that they agree |
| `PEOPLE_NO_OFFERED` | error | check | view … says callers api: only agents call it, so no screen shows it |
| `PEOPLE_NO_WITHOUT_AGENTS` | error | check | … says callers api, but the app has no agent identity (identity … from token), so no one could call it |
| `POLICY_UNKNOWN` | error | check | screen … says require …, but there is no policy of that name…: require public, require signed_in, or a policy (policy …: <condition> else go <screen>) |
| `PRIVATE_FIELD` | error | check | ….… is private, so it can't go in … |
| `QUERY_IN_APP` | error | build | a part of a query the database can't do (a condition, an order, a sum, a reduction of a query's list): write it so SQL can, or mark it in_app(…) to run it in the app (check --deep says it too) |
| `QUERY_PURE` | warning | check | query … reads nothing from the database: declare it fn …(…) (did you mean fn?) |
| `QUERY_SORTED` | warning | cost | the plan sorts every match to keep a few (USE TEMP B-TREE FOR ORDER BY, with a LIMIT): an index in that order would read just those |
| `QUERY_UNINDEXED` | warning | cost | the plan reads the whole table (SCAN): no index serves the condition |
| `RATE_LIMIT_NEVER` | error | check | rate_limit … per …: no call is ever let through; the limit is how many calls a period allows (1 or more) |
| `RATE_LIMIT_PERIOD` | error | check | rate_limit … per takes a period as written (per Duration.minutes(3), per Duration.hours(1)) |
| `REF_CYCLE_REQUIRED` | error | check | required references go round: …, so no row of them can be created first. Make one of them optional (T?) |
| `REQUIRE_CONSTANT` | warning | deep | require true (checks nothing) or require false (always refuses) |
| `ROUTE_PARAM` | error | check | api …'s address …/…: a parameter in an address is written :…, not … |
| `ROUTE_SHADOWED` | error | check | screen … (…) is never reached: screen … (…), earlier, takes every address it does; put … first, or change an address |
| `ROW_NAME_SHADOWS` | error | check | the loop variable … is also a … value: name the row differently (for each …_row in …) |
| `ROW_NAMED` | error | parse | the row is named … here: write …, not it |
| `ROW_POLICY_NAME` | error | parse | the row of a policy is .…, as in a where: write .…, not ….… |
| `ROWFIELD_OUTSIDE_WHERE` | error | check | .… is a field of the row in a where (Note where .… == …); here there is no such row: name it, as in … |
| `ROWS_IN_AMBIGUOUS` | error | parse | policy … is for rows in …, and … reaches a … two ways: …. Make one of the references optional, or give … a policy of its own and leave it out of … by making the path optional |
| `ROWS_IN_EMPTY` | warning | check | policy … is for rows in …, but no other entity's required references lead to a …: write for rows of … |
| `ROWS_IN_ROW` | error | parse | policy … is for rows in …: the condition names the … as … (.f and it would be different rows for each entity in it) |
| `ROWS_UNRELATED` | warning | deep | an action takes two rows inside the same container (a policy for rows in it) and never relates them |
| `SAME_BRANCHES` | warning | deep | an if whose two branches are the same: its condition decides nothing |
| `SAME_SIDES` | warning | deep | ==, !=, and or or with the same thing on both sides: always the same |
| `SCHEDULE_AT` | error | check | schedule …: at takes a Time field of …, optionally plus or minus a duration: at ….send_at, at ….updated + Duration.days(30) |
| `SCHEDULE_CONTEXT` | error | check | schedule … runs with no request, so it can't use … |
| `SCHEDULE_PERIOD` | error | check | schedule …: every … is too often; the shortest period is Duration.minutes(1) |
| `SCHEDULE_ZONE` | error | check | schedule …: unknown time zone "…" (an IANA name, like "America/New_York") |
| `SCREEN_SHOWS_UNPERMITTED` | error | check | a list shows … rows, which have no read permission |
| `SCREEN_UNREACHABLE` | warning | deep | a screen no chain of links reaches from home, sign-in, setup, or mail and the like |
| `SET_SELF` | warning | deep | a field set to itself (set x.f = x.f): it changes nothing |
| `SIGN_IN_BY_ADDRESS_ONLY` | warning | deep | … checks a password and limits tries only by request.ip: guesses at one account from many addresses go on without end. Limit by the account too: rate_limit 20 per Duration.minutes(15) by lower(trim(email)) else blocked |
| `SIGNAL_CARRIES` | error | check | signal … carries …: write its type (Text, Int or Bool) |
| `SIGNED_OUT_UNLIMITED` | warning | deep | an action open to signed-out callers writes, with no rate limit |
| `SIZE_FORM_LONGER` | warning | types | the form lets … take … characters, but … accepts at most … |
| `SIZE_IMPOSSIBLE` | error | check | … max …: no text but the empty one fits |
| `SIZE_LITERAL` | error | check | ….…'s default "…" is longer than its max … |
| `SIZE_NOT_TEXT` | error | check | … is …: max and min size text (characters), and mean nothing here… |
| `SKIP_UNNEEDED` | error | parse | … skips policy …, but takes no row it covers |
| `STAMP_FIELD_CLASH` | error | parse | stamp … is a field of … the stamp adds, but … declares … already: leave it out of …, or give the stamp another name |
| `STAMP_NOT_OPTIONAL` | error | parse | stamp …: … must be optional (…?): rows stored before the stamp, and writes with no one acting, have none |
| `STAMP_TWICE` | error | parse | ….… is stamped twice (stamp … at line … and line …) |
| `STAMPED_SET` | error | parse | ….… is set by stamp …, on every …, and by nothing else |
| `STORED_COLLECTION` | error | check | ….… is a … of …; a stored field holds one value. Keep the collection as rows: an entity with a reference to … (and one to each member), or a view over them |
| `SUBSET_BASE` | error | parse | subset … = … where …: … |
| `SUBSET_CYCLE` | error | parse | subsets defined by each other: … |
| `SUBSET_FN_PARAM` | error | parse | …(…: …): only an action, view, screen, channel or signal can refuse a row outside a subset; take a … |
| `SUBSET_NAME` | error | parse | subset … has an entity's name |
| `SUBSET_NOT_ROWS` | error | parse | … is a subset of …, rows to read; … takes the entity: … |
| `SUBSET_SET` | error | parse | …: set of … isn't a type; take set of … and read … where it in … |
| `SUBSET_STORED` | error | parse | ….…: a stored field can't have the subset … as its type, as the row can leave the subset after it is stored; store a …, and say what must hold with an invariant |
| `TEST_ACTOR` | error | check | by …: who runs it is a …, and … is a … |
| `TEST_ARG` | error | check | … is a value as written ("text", 12, true, none, an enum value) or a row this test made: work anything else out in an expect |
| `TEST_CALL` | error | check | run …: no action or view is called … |
| `TEST_DUPLICATE` | error | check | two tests are called "…": name each by what it shows |
| `TEST_ENTITY` | error | check | create …: no entity is called … |
| `TEST_FIELD` | error | check | … has no field … |
| `TEST_NAME` | error | check | …: … isn't a row this test made before it, nor an enum value… |
| `TEST_NAME_TWICE` | error | check | … is made twice in this test: name the second differently |
| `TEST_OUTCOME` | error | check | expect …: an outcome is …, written on the run's line… |
| `TEST_RESULT_TYPE` | error | check | as …: what … gives isn't a row the test can tell the type of; write it: as …: <Entity> |
| `TEST_ROWS` | error | check | expect … rows is for a view that gives rows; … doesn't |
| `TEXT_ROW` | error | types | a row in text: write the field to show, as {….name} |
| `THE_NOT_UNIQUE` | warning | deep | `the()` or `the_or_none()` query whose condition doesn't guarantee a unique key match: can fail at runtime with more than one row |
| `THEME_CLASS_UNKNOWN` | warning | check | nothing reads the theme class …: the runtime reads … |
| `THEME_CLASSES` | error | check | classes takes { kind: "class", … } |
| `THEME_PROP_UNKNOWN` | error | check | theme … has no …: a theme has … |
| `TRANSITION_DYNAMIC` | warning | deep | a set to a value the check cannot read; the app refuses an undeclared move at run time |
| `TRANSITION_NONE` | error | deep | (an error) a set of a field with transitions to none: none is no state |
| `TRANSITION_UNPROVEN` | error | deep | (an error) a set to a state that the entity's transitions block does not allow from some state the set's guards leave open: require the state first, or declare the move |
| `TRANSITION_UNUSED` | warning | deep | a declared move no action makes |
| `TRANSITIONS_DUPLICATE` | error | check | ….… has two transitions blocks: put every move in one |
| `TRANSITIONS_FIELD` | error | check | transitions on unknown field … |
| `TRANSITIONS_SELF` | error | check | … -> … says nothing: setting a field to the value it has is always allowed |
| `TRANSITIONS_VALUE` | error | check | … is no value of … |
| `TRIGGER_CYCLE` | warning | deep | triggers that can set each other off, round and round |
| `TYPE_ENUM_TEXT` | warning | types | the text field … among … values: is a … field meant? |
| `TYPE_FIELD_OF_NONE` | warning | types | .… of none is always none |
| `TYPE_FORMAT_TEXT` | warning | types | … compared with the text field …: did you mean …? |
| `TYPE_MAYBE_NONE` | error | types | text that may be none, in +: say what none means with t.default(""), or write it in the text ("…{t}…" shows none as nothing) |
| `TYPE_MISMATCH` | error | check | … compared with … |
| `TYPE_NEVER_EQUAL` | error | types | a Password is stored hashed, so … never compares what was typed: check it with authenticates(password, typed) |
| `TYPE_NEVER_NONE` | warning | types | … is never none, so … none is always … |
| `TYPE_NO_FIELD` | error | types | … has no field … |
| `TYPE_NONE` | error | types | … can't be none |
| `TYPE_NOT_BOOL` | error | types | … is …, not a Bool; it is never true |
| `TYPE_OPTIONAL_ARITHMETIC` | error | types | a number that may be none, in …: say what none means with n.default(0), or check it first (if n != none { … }) |
| `TYPE_OPTIONAL_BOOL` | warning | types | … may be none, which counts as false |
| `TYPE_PASSWORD_SHOWN` | error | types | … shows a Password: it is stored hashed, and never shown |
| `TYPE_PLACES` | error | parse | a Decimal keeps 0 to 6 places: Decimal places 2 |
| `UI_ATTR` | error | parse | is a " missing in "…{" before it? (the text holds the tag's >, and its { starts a value) |
| `UI_ATTR_FLAG` | error | parse | … is a flag: write it alone |
| `UI_ATTR_VALUE` | error | parse | … and its value need an = between them: …="…" or …={…} |
| `UI_CHILDREN` | error | parse | … has no children |
| `UI_CLASS_UNKNOWN` | warning | check | class … isn't in the app's stylesheets (…)… |
| `UI_CLOSE` | error | parse | expected </…> (for the <…> at line …), found </…> |
| `UI_CODE` | error | parse | {…}: unknown code; did you mean …? |
| `UI_COMPONENT_RECURSION` | error | parse | component … uses itself, directly or through another: a component's content is written out where it is used, so it can't contain itself |
| `UI_ELEMENT` | error | parse | <…> is plain HTML now: write <…>, with a class for its style (an uppercase tag is a built-in or one of your own components) |
| `UI_ELSE` | error | parse | <else> must follow an <if> |
| `UI_EXPECTED` | error | parse | a screen's parts are elements, {if …}, {let …}, {for each …} or {match …}: text goes in an element… |
| `UI_FIELD_KIND` | error | parse | unknown field kind '…'… |
| `UI_FILL` | error | check | <Fill> belongs between a component's tags, to fill one of its <Slot name=…>s, or at the top of a screen, to fill the page's main, nav, footer or sidebar |
| `UI_HEAD` | error | parse | … needs … |
| `UI_HTML_ATTR` | error | parse | …=…: an HTML attribute's value is "text" or {value}… |
| `UI_HTML_ATTR_UNKNOWN` | warning | check | <…>: HTML's <…> has no attribute … |
| `UI_HTML_BUILTIN` | error | check | <…=…> is plain HTML, where … means nothing: … |
| `UI_HTML_FORM` | warning | check | a plain <form> can't run an action (the runtime signs a <Form>'s): use <Form action={…}> |
| `UI_HTML_HANDLER` | error | check | <…>: a page's script comes from the runtime, not attributes: a behavior (cs:…={…}, lang/docs/ui.md) or a declared element |
| `UI_HTML_SCRIPT` | error | check | <script>: a page's script comes from the runtime: its behaviors (cs:click={…}, …) and the app's declared elements |
| `UI_HTML_SLOT` | error | check | <…> fills no slot: a screen's parts are <Fill name=main>, <Fill name=nav>, <Fill name=footer>, <Fill name=sidebar> and <Title>, with the HTML inside them |
| `UI_HTML_STYLE` | error | parse | <style>: styles go in the theme's stylesheets (theme t { stylesheets ["app.css"] }), and elements take a class |
| `UI_HTML_UNKNOWN` | warning | check | <…> is no HTML element… |
| `UI_HTML_URL` | error | check | <…="…">: only relative, http(s), mailto and tel addresses (and data: images in an <img>) |
| `UI_NAME` | error | parse | cs:ref takes a name: cs:ref=… |
| `UI_OLD_FORM` | error | parse | write {if c { … } else { … }} among the elements |
| `UI_PROP` | error | parse | … has no parameter '…'… |
| `UI_REACTION` | error | parse | write clear_form |
| `UI_ROWS_SCREEN_ONLY` | warning | check | <List of={… where …}> is a query only … runs, so agents can't get these rows: declare a view for it and list of={view(…)} |
| `UI_SLOT` | error | check | <Slot> in screen …: a slot is a place in a layout (for a screen's part) or in a component's body (for what its user writes between its tags) |
| `UI_TAG_CASE` | error | parse | <…>: write <…> (built-in elements and components start with a capital) |
| `UI_TAG_CLASH` | error | parse | component … has a built-in element's name: <…> would be the element; name it something else |
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
| `UNKNOWN_FUNCTION` | error | check | … is an action, not a function: a page calls it with <Button action={…(…)}> or <Form action={…(…)}>, and an agent through the API |
| `UNKNOWN_GATE` | error | check | skip of unknown every-action policy … |
| `UNKNOWN_LAYOUT` | error | check | unknown layout … |
| `UNKNOWN_NAME` | error | check | query is an API route's (its address's query); a screen takes its address's values as its parameters |
| `UNKNOWN_SCREEN` | error | check | … to unknown screen … |
| `UNKNOWN_SIGNAL` | error | check | unknown signal … |
| `UNKNOWN_TARGET` | error | check | api route calls unknown action or view … |
| `UNKNOWN_TYPE` | error | check | unknown type … |
| `UNKNOWN_VIEW` | error | check | list of unknown view … |
| `UNKNOWN_WIDGET` | error | check | unknown widget … (for your own, give elements behaviors or declare an element: lang/docs/ui.md) |
| `UNREACHABLE` | warning | deep | a statement after reject, which ends the body: it never runs |
| `UPGRADE_UNSUPPORTED` | error | parse | <…> with …: rewrite it by hand |
| `URL_OF_CALL` | error | check | url_of takes … with its arguments: url_of(…(…)) |
| `VIEW_WITHOUT_PERMISSION` | error | check | … returns … rows, which have no read permission |
| `WAS_CONFLICT` | error | check | … was …, but … is still declared |
| `WIDGET_REMOVED` | error | parse | an app's own widget (Go in widgets.go) is gone: for what a page does in the browser, give an element behaviors (cs:click={focus(name)}, cs:key_escape={go(url)}, …), and for your own script declare an element: element my-tag(param: Text) from "my-tag.js" (lang/docs/ui.md) |
| `WINDOW_EMPTY` | error | check | page …: the view shows no rows; a window is how many it shows (1 or more) |
| `WITH_UNKNOWN` | error | loading | a with names a field that isn't a reference (with .ref, .ref.ref: each a reference of the row before) |
| `WORKFLOW_NEVER_RUNS` | warning | check | nothing emits … |
| `WORKFLOW_STALE_CHECK` | warning | deep | a workflow step acts on a row whose field the emitting action set, without reading it again, though another body can change it meanwhile |
| `WRITE_ONLY_READ` | error | deep | (an error) a field declared write_only is read somewhere: remove write_only, or the read |
| `WRITE_POLICY_BULK` | error | parse | delete … where …: removes many rows at once, so the policy … (for …) can't check each. Loop over them: for each x in … where … { delete x }, or say skip policy … in this action |
| `WRITE_POLICY_UNRESOLVED` | warning | check | … changes a row whose entity the check can't tell, so the policies for writes to an entity may not apply to it: give the row a typed parameter, loop over it, or read it with the(E where …) |
| `WRITE_UNCHECKED` | warning | deep | an action changes or deletes a row the caller chooses, and nothing before the write checks the actor |


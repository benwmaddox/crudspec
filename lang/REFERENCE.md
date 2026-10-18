# crudspec reference

Generated from the parser, checker and type pass (`node lang/cli.ts reference`). Don't edit: `lang/reference.ts` holds the descriptions. `LANGUAGE.md` explains the language; this lists everything in it.

## UI elements

`<name attr="text" attr={expression} flag>children</name>`, or `<name … />`. An attribute shown as `name={…}` takes a value (`"text"` or `{expression}`); one shown bare is a flag.

### `<heading>`

A page or section heading.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.

### `<text>`

A piece of text; a row shows its entity's display, an enum value its label.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.

### `<strong>`

Emphasised text.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.

### `<richtext>`

Formatted text (a RichText value).

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `autolink` links addresses in the text.

### `<time>`

A time, as a date, a time of day or relative.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `as={…}` how a time shows: `{date}`, `{time}` or `{relative}`.

### `<image>`

An image from a file or a path under the assets.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `width={…}` the image's width; `height={…}` the image's height.

### `<icon>`

An icon by name, from the assets' images.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.

### `<avatar>`

A person's avatar.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `large` a large avatar.

### `<avatars>`

A row of avatars, for a set of people.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.

### `<separator>`

A horizontal rule.

- **Head:** nothing: just its attributes and children.
- **Children:** no.

### `<field_display>`

A label and a value, read only.

- **Head:** its value as content: `<x>{expression}</x>`.
- **Children:** no.
- **Attributes:** `readonly` shown read only; `label={…}` its label: visible text on a link, button or submit without an icon or text; otherwise read out by screen readers.

### `<link>`

A link to a screen or an address.

- **Head:** where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms.
- **Children:** yes.
- **Attributes:** `unread={…}` marks the link unread when this holds.

### `<button>`

A button that runs an action (a one-button form).

- **Head:** where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms.
- **Children:** yes.
- **Attributes:** `text={…}` the button's visible text; `confirm={…}` asks for confirmation first, with this question; `reveal` reveals the button's children instead of submitting at once; `selected={…}` shows the button as selected when this holds.

### `<form>`

A form for an action; its fields are the action's parameters.

- **Head:** where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms.
- **Children:** yes.
- **Attributes:** `auto_submit` submits when a field changes; `readonly_unless={…}` the form is read only unless this holds; `disabled={…}` the form is disabled when this holds; `submit_on={…}` submits on this key (`"enter"`).

### `<field>`

A form field for one of the action's parameters.

- **Head:** `name="parameter"` (one of the form's action parameters) and `kind="…"` (see field kinds).
- **Children:** no.
- **Attributes:** `value={…}` the field's starting value; `placeholder={…}` the field's placeholder; `required` the field must be filled in; `maxlength={…}` the field's longest value (a sized field or parameter gets one by itself); `multiple` a file field takes several files; `preview={…}` a file field previews its image here; `from={…}` a choice, select or users field's choices: a list; `filter_over={…}` a users field filters its choices past this many; `autocomplete={…}` a field picks from a view's rows as you type; `mentions={…}` a rich-text field offers @mentions from a view; `unfurl={…}` a rich-text field previews pasted links with a value view; `drafts` a rich-text field keeps a draft in the browser; `rows={…}` a textarea's height in lines; `role={…}` the field's ARIA role; `accept={…}` the file types a file field takes (`"image/*"`).

### `<switch>`

An on/off switch.

- **Head:** nothing: just its attributes and children.
- **Children:** no.
- **Attributes:** `on` the switch starts on; `off` the switch starts off; `value={…}` the field's starting value; `link={…}` the switch goes to this screen when changed; `auto_submit` submits when a field changes.

### `<submit>`

The form's submit button.

- **Head:** nothing: just its attributes and children.
- **Children:** no.

### `<on>`

What happens after a form or button's action ends with an outcome.

- **Head:** an outcome (`ok`, `invalid`, …) and what then happens: `go={screen(args)}`, `flash="…"`, `sign_in_as={user}`, `stay`, `clear`, `shake`.
- **Children:** no.

### `<list>`

The rows of a view or a query, each shown by the children with the row bound to `as`.

- **Head:** `of={view(args)}` or `of={Entity where …}`, `as="name"`, and optionally `where={…}`, `order={…}`, `desc`.
- **Children:** yes.

### `<each>`

The items of a list, each shown by the children.

- **Head:** `as="name"` and `in={list}`.
- **Children:** yes.

### `<if>`

The children, only when the test holds.

- **Head:** `test={condition}`; may be followed by `<else test={…}>` and `<else>`.
- **Children:** yes.

### `<let>`

Names a value for the rest of the block.

- **Head:** `name="x"` and `value={…}`.
- **Children:** no.

### `<use>`

A component (written as the component's own tag: `<message_item m={m} />`).

- **Head:** `call={name(args)}`.
- **Children:** no.

### `<widget>`

A runtime or app widget (`copy_button`, `share_button`, `qr_link`, `lightbox`, `autocomplete`, `push_permission`, or one the app declares).

- **Head:** `call={name(args)}`.
- **Children:** no.
- **Attributes:** `caption={…}` a widget's caption.

### `<channel>`

Keeps a declared channel open while the page is.

- **Head:** `call={name(args)}`.
- **Children:** no.

### `<signal>`

Shows a declared signal (typing indicators and the like).

- **Head:** `call={name(args)}`.
- **Children:** no.
- **Attributes:** `indicator` shows a signal as an indicator.

### `<section>`

A section, optionally with a legend.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.
- **Attributes:** `legend={…}` a section's legend; `banned={…}` marks a row or section banned when this holds.

### `<row>`

A horizontal group.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.
- **Attributes:** `banned={…}` marks a row or section banned when this holds.

### `<column>`

A vertical group.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<menu>`

A menu of links and buttons.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<popup>`

A button that opens a panel.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.
- **Attributes:** `panel={…}` the class of a popup's panel.

### `<dialog>`

A dialog.

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<frame>`

A frame (a group the page refreshes on its own).

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<go>`

Goes to a screen at once (in a screen's if: a redirect).

- **Head:** where it goes or what it does: `to={screen(args)}` / `href={url}` on links, `action={action(args)}` on buttons and forms.
- **Children:** no.

### `<title>`

The page's title.

- **Head:** optionally, its value as content: `<x>{expression}</x>` or `<x />`.
- **Children:** no.

### `<slot>`

Where a screen's part goes, in a layout.

- **Head:** `name="…"`.
- **Children:** no.

### `<flash>`

Where flash messages show, in a layout.

- **Head:** nothing: just its attributes and children.
- **Children:** no.

### `<nav>`

The screen's navigation part (a layout slot).

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<main>`

The screen's main part (a layout slot).

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<footer>`

The screen's footer part (a layout slot).

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### `<aside>`

An aside, optionally a named slot.

- **Head:** optionally `name="…"`.
- **Children:** yes.

### `<sidebar>`

The screen's sidebar part (a layout slot).

- **Head:** nothing: just its attributes and children.
- **Children:** yes.

### On every element

- `class={…}` a styling hint for the theme
- `id={…}` the element's HTML id
- `label={…}` its label: visible text on a link, button or submit without an icon or text; otherwise read out by screen readers
- `icon={…}` an icon shown with it
- `title={…}` a tooltip
- `data={…}` data attributes, from a json value
- `if={…}` shows the element only when this holds

### Components

A component is used by its own tag, its parameters as props in order from the first: `<message_item m={m} />`.

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


[← the language guide](../LANGUAGE.md)

## Views, screens and the UI

### Views

```
view room_messages(room: Room, before: Message?, after: Message?) {
  updates live
  require member(actor, room) else not_found
  rows Message where .room == room and (before == none or .created < before.created) and (after == none or .created > after.created)
  order by created
  page 40 last unless after != none
}
view unfurl_link(link: Url) { value call opengraph(link) }
```

- **A view returns rows in an order** (`rows … order by … [desc] [limit n]`), or a single value (`value e`).
- **Windows:** `page n last` keeps the newest `n`, and `page n first` the oldest. `unless c` switches between them, and `page n around x` gives the rows on both sides of one. (`page n` alone is a page size.)
- **`updates live`** keeps the rows current on every page showing them. The runtime sends what changed, and read permissions apply to every update.
- Views are what screens list, the API returns and agents read.

### Screens, layouts, components

```
layout app {
  <nav><Slot name=nav /></nav>
  <main><Slot name=main /></main>
  <Flash />
}
screen room_screen(room: Room) {
  route "/rooms/:room"
  layout app
  require member(actor, room) else go home flash "Room not found or inaccessible"
  <Title>{display_name(room, actor)}</Title>
  <Fill name=nav><h1>{display_name(room, actor)}</h1> <Link to={edit_room(room)} icon="menu" label="Settings" /></Fill>
  <Fill name=main>
    <List of={room_messages(room)} as=m><MessageItem m={m} /></List>
    <Form action={post_message(room)}>
      <Field name=body kind=richtext />
      <Submit icon="arrow-up" label="Send" />
      <On ok stay />
    </Form>
  </Fill>
}
component MessageItem(m: Message) { <div><Avatar>{m.creator}</Avatar> <span>{plain(m.body)}</span></div> }
```

- **A screen's settings** come first, a line each: `route "/rooms/:room"` (an address always starts with a slash), `layout L`, `require public` (signed-out visitors may open it; the default is `require signed_in`) and `remember name` (a cookie keeping its last parameters). Its `require … else go <screen> [flash "…"]` (or `else <outcome>`) checks run before it renders. It fills the page's places with `<Fill name=main>`, `<Fill name=nav>`, `<Fill name=footer>` and `<Fill name=sidebar>`, the same `<Fill>` a component's user writes; the layout names them with `<Slot name=…>` inside plain `<nav>`, `<main>`, `<footer>` and `<aside>`.
- **Elements** are `<Name attrs>content</Name>` or `<Name attrs />`. A built-in element or a component takes a fixed set of attributes, and an unknown one is an error. Attributes are:
  - `name="text"` or `name={expression}`;
  - a bare name, for the attributes that name something (`name=body`, `kind=richtext`, `as=m`);
  - a flag on its own (`required`, `desc`).
- **Plain HTML:** headings, sections, rows of things and the like are plain HTML with a class (`<h1>`, `<section>`, `<div class="row">`): the built-ins are only what HTML cannot do (forms and fields that run an action, links to screens, lists of rows, times, images, icons, avatars). A lowercase tag is HTML, as written; `{value}` among its content shows as text, a row as its `show` label, an enum value as its label: `<p class="note">Hello {u.name}!</p>`, `<input type="checkbox" name="pinned">`, `<br>`. A tag with a dash is a web component, passed through the same way (`<my-chart data-points={…}>`; the app's assets define it). Built-in elements and components start with a capital. The elements and attributes HTML has are in `lang/std/html.crud`; a tag or attribute that isn't one is a warning with the one meant (`UI_HTML_UNKNOWN`, `UI_HTML_ATTR_UNKNOWN`), and `data-…` and `aria-…` attributes are always fine. An attribute is `"text"`, `{value}` or bare: a Bool value shows a bare attribute when true, none leaves the attribute out, and an address in `href`, `src` and the like keeps to relative, http(s), mailto and tel (anything else becomes `#`). What could run script is refused: `<script>`, `on…` attributes, `srcdoc`, `javascript:` addresses (`UI_HTML_SCRIPT`, `UI_HTML_HANDLER`, `UI_HTML_URL`); so are `<style>` and a `style` that varies (use the theme's stylesheets and `class`). Inside a `<Form>`, a control's `name` is one of the action's parameters and fills it; a plain `<form>` can't run an action (`UI_HTML_FORM`).
- **Content** is text as it shows, `{expression}` (its value, as text) and elements: `<section>Signed in as {actor.name}</section>`. A run of only spaces and line breaks is nothing, so the layout of the source doesn't show; a space between two elements is written `{" "}`. In other text, line breaks and the spaces around them show as one space, and `//` at the start of a line or after a space starts a comment. Write `{"{"}`, `{"}"}` and `{"<"}` for those characters. Text elements hold only text: `<h1>{room.name}</h1>`, `<span>{left} items left</span>`. Elements whose value isn't text take it in braces: `<Avatar>{m.creator}</Avatar>`, `<Time as={date}>{m.created}</Time>`.
- **Code goes in braces** among the content, and its blocks are content again: `{if c { … } else if d { … } else { … }}`, `{let x = e}` (for the rest of the content), `{for each x in list { … }}`, and `{match e { a { … } b, c { … } none { … } }}`. In a block, text is written as it shows: `{if done { Done } else { <strong>Open</strong> }}`; a quoted string would show its quotes (`UI_TEXT_QUOTED`), and code without its braces shows as text (`UI_TEXT_CODE`). A `match` has an arm for every value of the enum (and `none` when it's optional) and no else, so a value added later is an error until every match handles it (`MATCH_MISSING`). An element's `if={…}` attribute shows or hides that element alone.
- **Links and actions:**
  - `<Link to={screen(args)}>` and `<Link href={url}>`;
  - `<Button action={act(args)} confirm="…">` and `<Form action={act(args)}>` with `<Field>`s and `<Submit>`;
  - `url_of(screen(args))` for an absolute address.

  The arguments a call gives come first. A form's fields fill the action's other parameters by name, and are typed from them: `text`, `email`, `password`, `richtext`, `file`, `textarea`, `number`, `url`, `code`, `hidden`, `checkbox` (a Bool), `choice` (an enum or Bool), `select` (one row, from `from={list}`), `users` (a set), `datetime`, `date` (in the person's time zone) and `time` (a time of day, as text). `select` and `users` offer only rows the person may read.

  **Fields follow HTML's defaults.** A field is a `<label>` holding its label text, then its control: `<label><span>Title</span><input type="text" name="title"></label>` (a checkbox comes before its text). `label_hidden` keeps the label for screen readers only, for a field an icon or a placeholder names. A class or a placeholder is there only when the field or the theme gives one, and a textarea's height is HTML's unless it says `rows={n}`. A `checkbox` sends `false` when it isn't checked. To write a control yourself, put plain HTML in the `<Form>`: `<input type="range" name="volume" min="0" max="10">` fills the `volume` parameter.

  | Kind | HTML | The default screens use it for |
  | --- | --- | --- |
  | `text` | `<input type="text">` | Text, and other text types |
  | `email`, `url`, `password` | `<input type="email">` and so on (a password: `autocomplete="current-password"`) | Email, Url, Password |
  | `number` | `<input type="number" step="1">` | Int |
  | `checkbox` | `<input type="checkbox" value="true">`, after a hidden `false` | Bool |
  | `choice` | `<select>` of the values, by their labels (`—` first when optional) | an enum |
  | `select` | `<select>` of rows | a reference |
  | `users` | a list of checkboxes, or a people picker with `autocomplete={view}` | a set |
  | `datetime`, `date`, `time` | `<input type="datetime-local">`, `date`, `time` (in the person's time zone) | Time |
  | `textarea` | `<textarea>` | RichText |
  | `richtext` | an editor with @mentions and link previews | — |
  | `file` | `<input type="file">` (with its image, with `preview={…}`) | File |
  | `hidden`, `code` | `<input type="hidden">`, `<textarea>` | — |
- **Outcomes after a form or button:**
  - `<On ok go={screen(result)} />`, or `<On ok stay flash="Done." />`;
  - `<On invalid shake />`, `<On not_found go={…} />`, and `sign_in={result}` and `clear_form` on an `<On>`.

  An outcome with no `<On>` returns to the page with the outcome's text. A form's `<On>`s are inside it; a button's come right after it.
- **Components** are used by name, their parameters given as props in order: `<MessageItem m={m} />`. Built-in elements and components start with a capital (`<Link>`, `component MessageItem`); a component can't take a built-in's name. `upgrade-syntax` rewrites the lowercase tags of earlier specs.
- **Widgets:** `<Widget call={copy_button(text)} />` and the runtime's others:
  - `share_button`, `qr_link` (drawn on the server);
  - `lightbox`, `autocomplete`;
  - `push_permission(action)`, which subscribes the browser and calls the action with its endpoint and keys.

  An app adds its own with `widget name(params)`, implemented in Go (`--widgets <file.go>`).
- **Rich text fields:** `mentions={view(…)}` and `autocomplete={view(…)}` name a view of choices, in which `typed` is what has been typed; `unfurl={view}` turns a pasted link into a preview card.
- **A row shown as text** shows its `display`, or else its `name`, `title`, `label` or `subject`.
- **Styling:** `class="…"` on any element (its own classes, instead of the theme's for its kind), and the app's `theme`:
  - `stylesheets [ … ]` (linked in this order: the later win), `custom` CSS and a `logo`;
  - `brand json { href, label, image, alt }`, a link to whoever made the app at the foot of every page;
  - `avatar_colors [ "#…", … ]`, the backgrounds of generated avatars (one picked by the person's id);
  - `tokens json { accent: "#2f6feb" }`, which become CSS variables;
  - `classes { button: "…", … }`, the class names for the runtime's own markup. One nothing reads is a warning (`THEME_CLASS_UNKNOWN`).

  The runtime has no styling of its own.
- **Generated screens:** an action no screen, API route or channel offers gets a form at `/_auto/actions/<name>`; a row view no screen lists gets a list at `/_auto/views/<name>`; `/_auto` indexes them. `node lang/cli.ts scaffold <spec>` prints them as source to copy in.

### Cutting the repetition

Three things keep screens short, and each is written out into ordinary screens before anything else reads them, so a page's reads, who may open it and what it shows are exactly what they look like.

**Access policies.** A requirement that many screens share, with where to send a visitor who fails it, gets a name:

```
policy staff: is_staff(actor) else go sign_in_screen flash "Staff only."
policy members: actor != none else forbidden
screen desk { route "/desk"  layout app  require staff  … }
```

`require staff` is the screen's first `require`, ahead of its own (a screen may add more, as before). `require public` and `require signed_in` are as they were. A policy nobody declared is `POLICY_UNKNOWN`, with the nearest name. Each screen has its own copy of the condition, so a screen reads alone.

**Forms that navigate.** `<Form to={screen}>` is a GET to the screen: its fields are the screen's parameters, sent in the address's query, for a search, a filter or a report:

```
screen households(typed: Text?, status: Status?) {
  route "/households"
  layout app
  <Fill name=main>
    <Form to={households}>
      <Field name=typed kind=text placeholder="Search" />
      <Field name=status kind=choice from={[active, inactive]} />
      <Submit label="Find" />
    </Form>
    <List of={find_households(typed, status)} as=h>…</List>
  </Fill>
}
```

- **Fields and parameters:** each field is a parameter of the screen, and a required one needs a field. An empty field is none, so an optional parameter's filter is off.
- **Address parts can't be fields** (`FORM_TO_ROUTE`): a GET can't change a path, so give the part in the call, `<Form to={bikes(active)}>`, or take it out of the route so it travels in the query. A call may fix only address parts (`FORM_TO_ARGUMENT`), since the form's own query is the rest.
- **Types:** text, numbers, yes/no, choices and references. A parameter of another type (a time) can't come from a field (`FORM_TO_TYPE`).
- **No outcomes:** an `<On>` has no place in it (`FORM_TO_ON`): it goes to the screen. `auto_submit` submits when a field changes, for a filter.
- **Who sees it:** the form shows what the screen shows, so the screen's own access and requirements decide, as for any link.

**Components that take children.** A component with a `<Slot />` in its body is written out where it is used: its parameters become `{let …}`s (named so that a variable of the user's called the same is not captured), and what the user wrote between its tags goes where the `<Slot />` is.

```
component Card(title: Text, note: Text?) {
  <section class="card">
    <h1>{title}</h1>
    <Slot />
    <div class="actions"><Slot name=actions /></div>
  </section>
}
<Card title="Today">
  <span>the body</span>
  <Fill name=actions><Button action={start(shop)} text="Start" /></Fill>
</Card>
```

- **A named place** is a `<Slot name=…>`, filled by a `<Fill name=…>` between the tags; everything else the user wrote goes to the unnamed `<Slot />`. A fill for a place the component hasn't is `UI_FILL`, and a `<Fill>` anywhere else, or a `<Slot>` in a screen, is an error. (A layout's `<Slot name=…>` is the same element: a place something goes.)
- **Components can use components,** and pass their own content along; one that uses itself, directly or through another, is `UI_COMPONENT_RECURSION`, since there's nothing to stop writing it out.
- **What it costs:** the component's markup is repeated at each use, so a page with many uses is larger than one that calls a function; a component without a `<Slot />` is still a function, cached as a fragment, so use that form for something with no content to pass. Arguments are not type-checked against the parameters (they become lets, typed by their values); an error in the body is reported where it is used.

### Real time

- **`updates live`** on a view (above).
- **`signal typing(room: Room) { to set(User where member(it, room)) carries { action: Text } require member(actor, room) }`** broadcasts something ephemeral and never stored, such as typing.
  - A page that shows `<Signal call={typing(room)} />` hears it, if its viewer is in `to` and `require` holds for them. A page sends it (`POST /_signal/typing:<room>`, or `crudspec.signal(key, fields)` in a page's script) if `require` holds for the sender; it reaches the pages of those in `to` at that moment, not the sender's own. Each one heard is a `crudspec:signal` event on the element.
  - `carries` lists what a page sends, by type (Text, Int, Bool), checked when it arrives; anything else is dropped. Who sent it the runtime adds (`from`: their id and display), so a page can't say it's someone else, and `check` warns of a carried `user_id` or the like (`SIGNAL_CARRIES`).
  - **`indicator`** shows who else is typing in the form beside it: the page sends `action: "start"` while someone types (at most once a second) and `"stop"` when they send or empty it, and shows the names of those who started in the last 5 seconds and haven't stopped. Its classes are the theme's `signal`, `signal_author` (the names) and `signal_active` (while anyone is). A signal shown as an indicator must carry `{ action: Text }`.
- **`channel presence(room: Room) { require member(actor, room)  on open present(room)  on close absent(room)  every 50 s refresh(room) }`** keeps a connection open and calls internal actions on its events.

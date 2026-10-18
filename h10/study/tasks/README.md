# Writing change requests for Campfire

You are the product owner of **Campfire**, a team chat app. Write **ten change requests**:
new features or changes to existing ones, the way you'd hand them to a developer. They will be
given, word for word, to developers who will build them, and then checked against what you
wrote.

Work only in this folder. Don't look at any other folder on this machine, and don't look up
how Campfire is built: this is about what users need, not how it's made.

## What Campfire does today

- **Accounts.** One installation is one organisation. The first person to open it sets it up and becomes an administrator. Others join with an invite link (the account page shows it) and sign in with email and password. Administrators can rename the account, set a logo, add custom styles, regenerate the invite link, and see everyone.
- **People.** Each person has a name, an optional bio and an avatar. Administrators can change someone's role, deactivate them, or ban them (which also blocks their IP addresses). People can move a sign-in to another device with a QR code.
- **Rooms.** Open rooms include everyone; closed rooms include chosen people; direct messages are between two or more people. Room creators and administrators can rename rooms, change who's in a closed room, or delete it.
- **Messages.** Rich text with @mentions, attachments (images shown inline), link previews, and "/play" sounds. Authors and administrators can edit or delete a message. Anyone can "boost" a message with a short reaction (an emoji or a few characters).
- **Staying informed.** Per room, each person chooses what to be notified about: everything, mentions only, nothing, or hiding the room. Rooms with new messages are marked unread. Browser push notifications. Who's in a room right now (presence). Search across messages.
- **Bots.** Administrators create bots that post into rooms through a simple HTTP address, and can send each message to a webhook.

## What to write

Ten requests, one per file: `task-01.md` … `task-10.md`. Each has:

1. **A title.**
2. **The request**, a few sentences, as you'd write it to a developer: what people can do, who can do it, what they see.
3. **Acceptance criteria**: a short list a tester can check in a browser, in terms of what's on the screen: the exact text of new buttons, links, field labels and messages; who may and may not do something; what happens to things that already exist. Example, for an imaginary to-do app: *"Each list's page has a 'Due date' field. Only the list's owner can change it. Lists past their due date show 'Overdue' next to their name. Existing lists have no due date."*

Make the set **varied, and realistic for a product like this**:
- some small (a new field, a new button), some larger (a new kind of thing with its own page and rules);
- some that change data that already exists (every existing message, room or person is affected);
- at least three that a chat product commonly needs but that **reach outside the app**: sending email, something that happens on a schedule (every night, after 30 days), exporting data as a file, calling another service, or similar;
- some with permissions that matter (who may see or do it).

Avoid:
- anything about how to build it (no code, databases, frameworks, file names);
- requests that only change colours or wording;
- changes that remove existing features.

Write in plain English. When you're done, write `INDEX.md`: one line per task with its title, and a word on its size (small, medium, large).

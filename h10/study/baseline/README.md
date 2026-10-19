# H10 study baseline

Acceptance checks run on the two unmodified apps, at `7372cd0`, before any agent run:
`node h10/study/run-accept.mjs <arm> <app> <port> base 01 … 10 --out h10/study/baseline`.

Shared setup passes on both arms for every task, and no task passes on either arm. Some
individual checks pass anyway; when the reports count passing checks, these are subtracted:

- 02, 07: negative checks ("others see no …") pass because the feature is absent.
- 04: a plain search, and results linking to the message, already work on both. The Rails
  results show the room name and the spec results don't, so "results show the room name, sender,
  date and a preview" passes on Rails only. The spec arm has that bit of extra work on task 04.
- 06: 4/9 on both arms. With no archiving at all, every room stays active and viewable and nobody sees Archive.
- 09: the spec app has a message-level Reply (quote) button, so "each message has a Reply
  option" passes there and the run continues. A plain message then passes "replies take boosts",
  "an administrator can delete a reply" and "existing messages have no replies". On Rails, Reply
  sits in a menu the check doesn't open, so the run stops at the first check.

---
kind: bug
category: missing-guard
rules: ['G3']
source: invented
touches_invariants: false
---
Missing authorization check in delete_message allows any member to delete any message.

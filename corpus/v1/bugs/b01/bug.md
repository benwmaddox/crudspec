---
kind: bug
category: missing-guard
rules: [G3]
source: invented
touches_invariants: false
---
Missing authorization check in edit_message allows any member to edit any message.
A developer removes the can_administer check thinking the room membership is sufficient,
or copies code without noticing the check is needed. The action by a non-creator is exposed.

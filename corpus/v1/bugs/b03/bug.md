---
kind: bug
category: permission-leak
rules: ['B1']
source: invented
touches_invariants: false
---
Missing room membership check in boost allows non-members to boost messages.

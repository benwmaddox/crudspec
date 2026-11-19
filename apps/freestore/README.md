# Freestore rules

A model of the rules of a church's free store, written in crudspec: households visit a limited number of times a month, take items (some only in their season, at adult or child prices), and people can ask for a bike once a year. It isn't a port of the whole app: it states the calendar and money rules clearly, and proves the ones a mistake would cost.

- **One clock.** `time_zone "America/New_York"` makes every `today()` the store's day. The original app mixed three clocks (UTC's date, the server's, and Cleveland's), so on the evening of a month's last day it could count a second visit as next month's.
- **Rules as stored facts.** Each visit stores its month, so the limit is a fact about the data: `all(visits_in(.household, .month) <= Settings.shops_per_month for Shop where true)`.
- **Proven.** Three invariants (the visit limit, positive quantities, no negative prices) are proven for all 10 actions: 30 proofs in about 3 s. Removing any of the guards makes the build report the run that breaks it, such as `(item: Item#1, price: -0.01)`.
- **Checked at the edges.** `lang/test/freestore.test.ts` runs the compiled app at 8:30 pm on Oct 31 (Nov 1 in UTC) and on a bike's anniversary, and checks the money is exact.

```
node lang/cli.ts check apps/freestore
node lang/test/freestore.test.ts
```

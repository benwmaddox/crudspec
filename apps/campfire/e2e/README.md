# Browser checks for the crudspec runtime

Playwright scripts that drive the runtime in Chromium. Install Playwright somewhere
outside the repository (for example `.scratch/pw`, with `npm i playwright`), run from there,
and pass the runtime's URL and a directory for screenshots.

| Script | Checks |
| --- | --- |
| `smoke.mjs` | first run, landing in All Talk, posting, the account page (needs an empty data directory) |
| `twousers.mjs` | a second person joins with the invite link and posts; the first person's open page shows it without reloading |
| `bot.mjs` | creating a bot through the Chat bots screen and reading its curl commands |
| `sweep.mjs` | every screen route renders, with no server error |

Behaviour equity with Rails is checked separately and over HTTP, by
`tools/src/v2/replay-runtime.ts` against the oracle goldens.

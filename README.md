# Stravaig email-to-task

Forward or send an email to a private address and it becomes a task in Stravaig.

A single-file Cloudflare Email Worker, no dependencies and no build step: you
paste `worker.js` into the dashboard. It appends the task to the same D1
document the app reads, so the task appears on your next 30-second sync.

## How it behaves

- **Subject** becomes the task title.
- **Body** (plain text, or HTML stripped to text) becomes the notes.
- A date in the subject or body sets the due date: `2026-08-20`, `20/08/2026`,
  `20/08`, `today`, or `tomorrow`. No date found = task with no date.
- Subject containing "visit" is typed as a School Visit, otherwise a Meeting.
  Everything else (school, contact, times) is left blank for you to fill in the app.

## Deploy (all in the Cloudflare dashboard, no local tooling)

1. **Create the Worker**
   Workers & Pages -> Create -> Worker -> name it `stravaig-email` -> Deploy
   (the Hello World placeholder is fine for now).

2. **Paste the code**
   Edit code -> replace everything with the contents of `worker.js` -> Deploy.

3. **Bind the database**
   The Worker -> Settings -> Bindings -> Add -> D1 database
   - Variable name: `DB`
   - Database: `stravaig`

4. **Add the sender allowlist**
   Same Settings -> Variables and Secrets -> Add
   - `ALLOWED_SENDERS` = your own addresses, comma-separated, e.g.
     `mmorren@me.com,mark.morren@ea.edin.sch.uk`
   - (optional) `FORWARD_TO` = an address to also receive a copy, e.g. `mmorren@me.com`

   Only mail whose From matches this list creates a task; anything else bounces.
   If the variable is missing or empty, the Worker rejects everything (fails closed).

5. **Route an address to the Worker**
   `morren.uk` already uses Cloudflare Email Routing, so this is just one new rule:
   Email -> Email Routing -> Routing rules -> Create address
   - Custom address: pick something hard to guess, e.g. `task-<random>@morren.uk`
   - Action: Send to a Worker -> `stravaig-email`

That hard-to-guess address is the first gate; the sender allowlist is the second.

## Test

Send a plain email from an allowlisted address to your `task-...@morren.uk`
address, subject e.g. `Visit Gilmerton 2026-08-20`. Within ~30 seconds it should
appear in Stravaig as a School Visit dated 20 Aug. If nothing arrives, check the
Worker's logs (Workers & Pages -> stravaig-email -> Logs) - a rejected sender or
a missing D1 binding will show there.

## Notes

- Nothing secret is in `worker.js` (addresses live in dashboard vars), so it is
  safe to keep in git.
- The body parser is deliberately simple. If an exotic email ever comes through
  with a garbled body, the subject/date still work, and we can switch to a
  git-deployed build with the `postal-mime` library if it becomes a problem.

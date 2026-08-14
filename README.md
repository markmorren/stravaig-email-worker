# Stravaig email-to-task

Forward or send an email to a private address and it becomes a task in Stravaig.

A single-file Cloudflare Email Worker, no dependencies and no build step: you
paste `worker.js` into the dashboard. It appends the task to the same D1
document the app reads, so the task appears on your next 30-second sync.

## How it behaves

**Quick capture (no rules):** the **subject** becomes the task title, the **body**
becomes the notes, and a date in the subject sets the due date. Signatures and
confidentiality footers are trimmed off automatically. That is all you need for a
fast task.

**Structured labels (optional):** to fill specific fields, put `Label: value`
lines anywhere in the body. Recognised labels:

| Label | Fills | Examples |
|-------|-------|----------|
| `Date:` | Due date | `20 Aug`, `2026-08-20`, `20/08`, `Monday`, `today`, `tomorrow` |
| `Time:` | Start/end time | `9:30-10:30`, `9am-10:30am`, `2pm` |
| `Type:` | Task type | `School Visit`, `Meeting`, `CAT` |
| `School:` | School name | `Gilmerton Primary` |
| `Contact:` (or `With:`) | Staff contact | `A. Murray` |
| `LC:` (or `Community:`) | Learning community | `Gilmerton` |
| `Support:` | Support type | `In Person` |
| `Follow-up:` | Follow-up items | `bring plan; email HT` (`;` = separate items) |
| `Notes:` | Notes | free text |

Notes:
- Labels are optional and case-insensitive; use as few or as many as you like.
- An explicit `Date:` beats a date in the subject.
- Any line **without** a recognised label just becomes part of the notes, so you
  can mix labels and prose freely.
- No labels at all = the quick-capture behaviour above.
- Dates are read only from the subject and the `Date:` label - never from loose
  body text - so numbers in a signature can't be mistaken for a due date.

**Example**

```
To:      task@morren.uk        (your real routed address)
Subject: Gilmerton visit

Date: 20 Aug
Time: 9:30-10:30
Contact: A. Murray
Follow-up: bring phonics plan; email HT
Anything here with no label goes into the notes.
```

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

# Validator backend (waitlist + telemetry)

A single Cloudflare Worker with two KV namespaces. Written and unit-tested in G3-2;
**not deployed until G3-3** (Cloudflare account setup is a user-present launch action).
Fits the VR-06 cost ceiling: Workers + KV free tier covers Gate 4 traffic comfortably.

## Endpoints

| Endpoint | Body | Stores |
|---|---|---|
| `POST /waitlist` | `{ email, note?, website? }` | `{ ts, note }` keyed by lowercased email (idempotent). `website` is a honeypot — non-empty gets a fake OK and stores nothing. |
| `POST /event` | `{ format, outcome, fatals, warnings, rules }` | one append-only row per validation, 400-day TTL. Formats/outcomes allowlisted; rule IDs pattern-checked; anything with markup rejected. |
| `POST /lead` | `{ name, contact, comments?, website? }` | **not stored** — emailed to the address in the `LEAD_RECIPIENT_EMAIL` secret via Resend's REST API (plain `fetch()`, no Cloudflare binding), subject `ANTIPHON LEAD - <date>`, body has `name`/`contact`/`comments` plus a full ISO 8601 timestamp. `website` is a honeypot — non-empty gets a fake OK and sends nothing. |
| `GET /export/waitlist` | `Authorization: Bearer <EXPORT_TOKEN>` | → JSON rows (Gate 4: waitlist count) |
| `GET /export/events` | same | → JSON rows (Gate 4: validations by format, pass/fail; rule-ID histogram for explanation curation) |

**Never stored:** IP addresses, user agents, cookies, identifiers of any kind, document content
(free-text fields reject `<`/`>`; rule IDs must match `^[A-Za-z0-9._:-]{2,64}$`).

## Test

Covered by the repo suite: `npm test` in `validator/` runs `tests/worker.test.mjs`
(node:test + in-memory KV mock — no wrangler, no network).

## Deploy (G3-3 checklist)

See the comment block at the top of `wrangler.toml`. After deploy, set the two endpoint URLs in
`site/config.js` — until then the site's waitlist form shows a "preview build" notice and the
telemetry beacon never fires.

### Deployed 2026-09-03 (G3-3)

- Live Worker URL: `https://antiphon-validator-api.clockworkotterfoundry.workers.dev`
  (`/waitlist`, `/event`, `/export/waitlist`, `/export/events`). Plain `workers.dev` route; no
  custom domain. `ALLOWED_ORIGIN` = `https://validator.clockworkotterfoundry.com`.
- KV namespace IDs live in `wrangler.toml`.
- Gotcha (wrangler 4.x): `wrangler kv key list --namespace-id <id>` reads *local* state and shows
  `[]` for production writes — add `--remote` to inspect the deployed namespaces.
- Running `wrangler secret put EXPORT_TOKEN` before the first `wrangler deploy` auto-creates the
  Worker (non-interactive fallback answers "yes"); the subsequent `deploy` uploads the real code.
- Follow-up: if `antiphon.io` is bought and pointed at the validator, update `ALLOWED_ORIGIN` here
  and re-`wrangler deploy`, plus re-run `tools/sync-validator-public.sh`.

### `/lead` — ANT-V5 (Resend REST API, added but not yet deploy-verified)

Cloudflare's own native Email Service (`send_email` binding) was the original design but
turned out to require the paid Workers plan — this route instead POSTs to
[Resend](https://resend.com)'s REST API (`https://api.resend.com/emails`) over a plain
`fetch()`, which Workers can do on any plan. No Cloudflare `send_email` binding is used.

- **Two secrets, never wrangler.toml values, never worker.js literals** — this whole
  `validator/` directory, `wrangler.toml` included, is mirrored verbatim to the **public**
  `antiphon-validator` repo by `tools/sync-validator-public.sh`, so nothing sensitive can
  live in any tracked file here:
  - `RESEND_API_KEY` — from the Resend dashboard.
  - `LEAD_RECIPIENT_EMAIL` — the real recipient address.
  `worker.js` fails closed with a 502 if either secret is unset, or if Resend's API itself
  returns a non-`ok` response — never a silent send to an empty/wrong address or a
  swallowed delivery failure.
- Account-side, user-present setup required before this route can actually deliver:
  1. Sign up for a free Resend account and verify a sending domain there (SPF/DKIM DNS
     records — the usual process for any transactional email provider). The address
     behind `LEAD_FROM_ADDRESS` below must belong to that verified domain.
  2. `wrangler secret put RESEND_API_KEY`
  3. `wrangler secret put LEAD_RECIPIENT_EMAIL`
- `LEAD_FROM_ADDRESS` (a var in `wrangler.toml`) is a placeholder (`leads@clockworkotterfoundry.com`)
  — update it to whatever address on the Resend-verified domain should appear as the sender.

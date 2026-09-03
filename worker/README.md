# Validator backend (waitlist + telemetry)

A single Cloudflare Worker with two KV namespaces. Written and unit-tested in G3-2;
**not deployed until G3-3** (Cloudflare account setup is a user-present launch action).
Fits the VR-06 cost ceiling: Workers + KV free tier covers Gate 4 traffic comfortably.

## Endpoints

| Endpoint | Body | Stores |
|---|---|---|
| `POST /waitlist` | `{ email, note?, website? }` | `{ ts, note }` keyed by lowercased email (idempotent). `website` is a honeypot — non-empty gets a fake OK and stores nothing. |
| `POST /event` | `{ format, outcome, fatals, warnings, rules }` | one append-only row per validation, 400-day TTL. Formats/outcomes allowlisted; rule IDs pattern-checked; anything with markup rejected. |
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

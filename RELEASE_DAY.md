# Validator: release-day steps (Antiphon 1.1.0)

Run after Antiphon 1.1.0 is published on NuGet (planned 2026-12-01). Until then the site ships with
`antiphon11Live: false`, so the evaluation form says keys work with 1.1 and that we reply once 1.1 is
published. Nothing here is done by a dispatched session; steps 5 and 6 are user-present.

1. **Flip the state.** In `site/config.js` set `antiphon11Live: true`. The form copy switches to
   "Send your request and we will reply with your free key, usually the same business day."
2. **Date the changelog header.** The repository `CHANGELOG.md` header `## [1.1.0] - Unreleased` is dated
   by the owner on release day; the pipeline reads it (`X.Y.Z-unreleased` until dated).
3. **Regenerate the footer's bundle release.** From `validator/`: `npm run pipeline`. The footer's
   bundle release should now read 1.1.0.
4. **Restore hand-curated entries.** The regeneration can overwrite hand-curated entries in
   `conformance-results.json`. Compare with `git diff` and restore any the regeneration touched.
   Then `npm test` from `validator/` (all tests must pass).
5. **Worker (user present).** If `worker/worker.js` changed since the last deploy:
   `wrangler deploy` from `validator/worker/`. Secrets are unchanged (`RESEND_API_KEY`,
   `LEAD_RECIPIENT_EMAIL`). The website `/privacy` page must already be live.
6. **Publish the site (user present).** `tools/sync-validator-public.sh`, then deploy the static site.
   Check the live page: the form shows the "free key" wording and a test submission arrives.

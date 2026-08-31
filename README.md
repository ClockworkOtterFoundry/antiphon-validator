# Antiphon Validator

Free, **fully client-side** EN 16931 e-invoice validator. Paste or open invoice XML and the
**pinned official Schematron rule sets** run entirely in your browser via SaxonJS — nothing is ever
uploaded to a server. Covers EN 16931, XRechnung, Peppol BIS Billing 3.0, and Factur-X/ZUGFeRD
(EN 16931 profile) documents in both UBL and CII syntax.

It is the free companion to **Antiphon**, a commercial .NET SDK for EU e-invoicing compliance
(generate / validate / convert EN 16931-family formats). The SDK is distributed separately via
NuGet; this repository is the validator only.

**Live site:** coming soon (not yet deployed).

## Repository history

This repository was extracted from Antiphon's private development monorepo, preserving the
validator's real commit history. That history is a **single feature commit**
(`feat: add validator backend with waitlist and telemetry endpoints`) — in the monorepo the
validator was developed on one branch and squash-merged, so there are no separate per-phase
commits. That one commit bundles both:

- **Validator core** — format auto-detection, in-browser Schematron execution, SVRL rendering,
  the pinned build pipeline, and the fixture corpus.
- **Waitlist, telemetry, and rule explanations** — the `site/explanations.js` plain-language rule
  text and the `worker/` Cloudflare Worker backend.

`git log` shows the LICENSE commit, that feature commit, and the merge that joined them.

## Layout

```
site/       the deployable static site (index.html, app.js, detect.js, explanations.js,
            config.js, styles.css, vendor/ SaxonJS runtime + license,
            rules/ compiled SEFs + versions.json — SEFs are built by the pipeline, not committed)
pipeline/   dev-time Node scripts: pins.json (pinned upstream artifacts + sha256),
            fetch.mjs, compile.mjs, fixtures.mjs
fixtures/   per-format valid fixtures (official examples) + seeded-error mutations
            with known expected rule IDs (expected.json)
tests/      headless smoke tests (shipped SEFs vs. every fixture) + worker unit tests
worker/     Cloudflare Worker source for waitlist + content-free telemetry
            (unit-tested here; deploy steps in worker/README.md and worker/wrangler.toml comments)
```

## Build

```bash
npm install        # dev-time tooling only (xslt3, saxon-js, fflate)
npm run pipeline   # fetch pinned artifacts (sha256-verified) → compile SEFs → build fixtures
npm test           # smoke tests: detection + 0-fatal valid + exact rule IDs on mutations
npm run serve      # http://localhost:8080
```

The pipeline is **deterministic and pinned**: every upstream artifact in `pipeline/pins.json` is a
release tag with a sha256; a hash mismatch or missing zip entry fails the build. When bumping a
pin, re-check the new rule sources for XPath 3.x / engine-compatibility regressions before updating
the tag and hash together.

## What runs where

- **Dev-time (Node):** artifact fetching; Peppol `.sch` → XSLT via SchXslt (pure XSLT — no Java
  anywhere, even at build time); XSLT → SEF via `xslt3`.
- **Browser (runtime):** SaxonJS 2.7 runtime executes the SEFs; `detect.js` auto-detects the
  format (root namespace + CustomizationID/Guideline ID); SVRL is parsed and rendered client-side.
  All SEFs are prefetched at page load so that **validating a document performs zero network
  requests** (verifiable in the browser's network tab).

## Formats and rule sets (v0)

| Detected format | Rule sets executed |
|---|---|
| UBL — EN 16931 | CEN EN 16931 UBL |
| UBL — Peppol BIS Billing 3.0 | CEN UBL + Peppol BIS 3.0 |
| UBL — XRechnung 3.0.2 | CEN UBL + KoSIT XRechnung Schematron 2.5.0 |
| CII — EN 16931 | CEN EN 16931 CII |
| CII — XRechnung 3.0.2 | CEN CII + KoSIT XRechnung Schematron 2.5.0 |
| CII — Factur-X/ZUGFeRD (EN 16931 profile XML) | CEN CII |

Pinned versions live in `pipeline/pins.json` and are surfaced to users via
`site/rules/versions.json` (page footer).

## v0 limitations (stated on-page)

- **No XSD layer** — well-formedness + Schematron only (libxml2-wasm is the v0.x candidate).
- **No PDF input** — Factur-X/ZUGFeRD users paste the embedded XML; PDF extraction is v0.x backlog.

## Waitlist, telemetry, explanations

- **Explanations:** `site/explanations.js` — hand-curated plain-language text for ~45 common rule
  IDs, shown above the official rule message. Tests enforce coverage of every fixture rule ID.
- **Waitlist:** rendered only *after* results (never a wall). Posts `{email, note}` to
  `config.waitlistEndpoint`; with the endpoint empty (this repo's default) the form shows a
  "preview build" notice and nothing is sent.
- **Telemetry:** `navigator.sendBeacon` of `{format, outcome, fatals, warnings, rule-ID histogram}`
  — no content, no cookies, no identifiers. Entirely dormant until `config.telemetryEndpoint` is
  set at deploy time.
- **Backend:** `worker/` (Cloudflare Worker + 2 KV namespaces, token-gated exports). Unit-tested
  via `npm test`; `wrangler.toml` carries placeholder IDs only — real namespace IDs and the export
  token are filled in at deploy time.

## Deploy notes

Any static host works. Asset weight: compiled SEFs total ~18.5 MB raw (largest ~6.8 MB) + ~0.5 MB
runtime; they are highly compressible JSON (a host that serves brotli automatically, e.g.
Cloudflare Pages, handles this well) and are fetched in the background after first paint, so first
contentful paint is instant. If real-world load times disappoint, lazy per-format loading is a
small `site/app.js` change (at the cost of a network request at validate time for uncached
formats).

## Licensing

The **MIT license** in this repository (`LICENSE`) covers **this project's own code** — everything
under `site/` (except `site/vendor/`), `pipeline/`, `fixtures/`, `tests/`, and `worker/`.

It does **not** relicense third-party material:

- **`site/vendor/SaxonJS2.rt.js`** is the SaxonJS runtime, vendored **unmodified** under its own
  separate license — see `site/vendor/SAXONJS-LICENSE.txt` (Saxonica License v1.0, June 2020).
  SaxonJS is **free of charge but not open source**: unmodified binary redistribution as part of an
  application is permitted, but reverse engineering is prohibited and it may not be re-hosted for
  third-party download without Saxonica's permission. It is **not** covered by this repo's MIT
  license.
- **Rule artifacts** fetched at build time by the pipeline are used unmodified under their upstream
  licenses: CEN EN 16931 Schematron (EUPL-1.2), KoSIT XRechnung (Apache-2.0), OpenPeppol BIS
  (Apache-2.0), SchXslt (MIT). None are committed to this repository; the pipeline downloads them
  from their pinned upstream releases.

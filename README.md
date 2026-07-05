# Antiphon Validator

Free, fully client-side EN 16931 e-invoice validator — the Gate 3 lead magnet. Paste or open
invoice XML; the **pinned official Schematron rule sets** run in the browser via SaxonJS; nothing
is ever uploaded. Built per the Gate 2 plan (`../docs/research/gate2-decisions.md` §e); this is
phase G3-1 (validator core). Waitlist, telemetry, and rule explanations arrive in G3-2; deployment
in G3-3.

## Layout

```
site/       the deployable static site (index.html, app.js, detect.js, explanations.js,
            config.js, styles.css, vendor/ SaxonJS runtime + license,
            rules/ compiled SEFs + versions.json)
pipeline/   dev-time Node scripts: pins.json (pinned upstream artifacts + sha256),
            fetch.mjs, compile.mjs, fixtures.mjs
fixtures/   per-format valid fixtures (official examples) + seeded-error mutations
            with known expected rule IDs (expected.json)
tests/      headless smoke tests (shipped SEFs vs. every fixture) + worker unit tests
worker/     Cloudflare Worker source for waitlist + content-free telemetry
            (unit-tested here; DEPLOYED ONLY AT G3-3 — see worker/README.md)
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
pin, first re-run `../docs/research/extract-xpath-inventory.py` against the new rule sources (the
XPath-3.x/engine compatibility gate), then update tag + hash together.

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

## Waitlist, telemetry, explanations (G3-2)

- **Explanations:** `site/explanations.js` — hand-curated plain-language text for ~45 common rule
  IDs, shown above the official rule message. Tests enforce coverage of every fixture rule ID.
  Grow the map using the telemetry rule-ID histogram once live.
- **Waitlist:** rendered only *after* results (never a wall). Posts `{email, note}` to
  `config.waitlistEndpoint`; with the endpoint empty (this repo's default) the form shows a
  "preview build" notice and nothing is sent.
- **Telemetry:** `navigator.sendBeacon` of `{format, outcome, fatals, warnings, rule-ID histogram}`
  — no content, no cookies, no identifiers. Entirely dormant until `config.telemetryEndpoint`
  is set at G3-3. Session counts come from the host's analytics (decided at launch), not from us.
- **Backend:** `worker/` (Cloudflare Worker + 2 KV namespaces, token-gated exports for Gate 4
  evaluation). Unit-tested via `npm test`; deployment steps in `worker/wrangler.toml` comments.

## Licenses

- Rule artifacts: CEN (EUPL-1.2), KoSIT (Apache-2.0), OpenPeppol (Apache-2.0), SchXslt (MIT) —
  all fetched at build time, never modified.
- **SaxonJS** (`site/vendor/`): vendored unmodified with its license file. Free of charge but
  **not open source** — ⚠️ **G3-3 launch checklist: read `site/vendor/SAXONJS-LICENSE.txt`
  end-to-end before the site goes public.**

## Deploy notes (for G3-3)

Any static host works. Asset weight: SEFs total ~18.5 MB raw (largest 6.8 MB) + 0.5 MB runtime;
they are highly compressible JSON (Cloudflare Pages serves brotli automatically) and are fetched
in the background after first paint, so first contentful paint is instant. If real-world load
times disappoint, lazy-per-format loading is a small app.js change (at the cost of a network
request at validate time for uncached formats).

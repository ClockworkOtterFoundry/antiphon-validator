// Site-level checks for the evaluation-key request form (ANT-V6): static markup + config copy.
// No browser: index.html is the form's markup; config.js exports the state-dependent copy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, evaluationCopy } from "../site/config.js";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const read = (f) => readFile(join(site, f), "utf8");

test("site config has a boolean antiphon11Live and the /evaluation endpoint", () => {
  assert.equal(typeof config.antiphon11Live, "boolean"); // flipped on release day; copy is tested for both states below
  assert.match(config.evaluationEndpoint, /^https:\/\/antiphon-validator-api\.clockworkotterfoundry\.workers\.dev\/evaluation$/);
  assert.equal("leadEndpoint" in config, false);
});

test("evaluation copy: pre-1.1 state is honest and never promises a key", () => {
  const c = evaluationCopy(false);
  assert.equal(
    c.intro,
    "Evaluation keys work with Antiphon 1.1, planned for 1 December 2026. Send your request and we will reply once 1.1 is published."
  );
  assert.match(c.thanks, /once 1\.1 is published/);
  assert.doesNotMatch(c.intro, /free key/);
});

test("evaluation copy: live state", () => {
  const c = evaluationCopy(true);
  assert.equal(c.intro, "Send your request and we will reply with your free key, usually the same business day.");
  assert.doesNotMatch(c.intro + c.thanks, /planned for|once 1\.1 is published/);
});

test("form markup: title, subtitle, labelled required fields, fieldset, privacy link, honeypot", async () => {
  const html = await read("index.html");
  assert.match(html, /Get a free Antiphon evaluation key/);
  assert.match(html, /We reply personally, usually the same business day\. We’ll ask what you’re building so we can help, not to sell you anything\./);
  for (const id of ["name", "email", "company", "country", "building"]) {
    assert.match(html, new RegExp(`<label for="eval-${id}">`), "label for " + id);
    assert.match(html, new RegExp(`id="eval-${id}"[^>]*required`), id + " required");
  }
  for (const v of ["xrechnung", "peppol", "facturx", "en16931", "other"]) assert.match(html, new RegExp(`name="formats" value="${v}"`));
  assert.match(html, /<fieldset[^>]*>\s*<legend>Formats you need/);
  assert.match(html, /id="eval-website"[^>]*tabindex="-1"/);
  assert.match(html, /autocomplete="email"/);
  assert.match(html, /id="eval-status"[^>]*aria-live="polite"/);
  assert.match(html, /href="https:\/\/clockworkotterfoundry\.com\/privacy\/"/);
  assert.match(html, /nothing you paste ever leaves the page/);
  assert.match(html, /Run these same rules in your \.NET code: <a href="https:\/\/clockworkotterfoundry\.com\/antiphon\/">Antiphon<\/a>/);
  assert.doesNotMatch(html, /priority pricing/);
});

test("page source: no personal data, secrets, 4.0 mentions, tracking or third-party URLs", async () => {
  const allowedHosts = new Set([
    "clockworkotterfoundry.com",
    "antiphon-validator-api.clockworkotterfoundry.workers.dev",
    "github.com", // pre-existing upstream-issue link in the footer
    "www.w3.org", // XML namespace / SVG favicon declarations
    "purl.oclc.org", // SVRL namespace
    "saxonica.plan.io", // pre-existing bug reference in an app.js comment
  ]);
  for (const f of ["index.html", "app.js", "config.js"]) {
    const src = await read(f);
    for (const m of src.matchAll(/https?:\/\/([^\/"'`\s<>)]+)/g))
      assert.ok(allowedHosts.has(m[1]), `${f}: unexpected host ${m[1]}`);
    for (const m of src.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
      // placeholders like you@company.eu predate this phase; only the public contact may be a real address
      assert.ok(["info@clockworkotterfoundry.com", "you@company.eu"].includes(m[0]), `${f}: unexpected address ${m[0]}`);
    }
    assert.doesNotMatch(src, /\bre_[A-Za-z0-9]{8,}/, f + ": resend-like key");
    assert.doesNotMatch(src, /[?&]utm_/i, f + ": tracking parameter");
  }
  const page = (await read("index.html")) + (await read("app.js"));
  assert.doesNotMatch(page, /XRechnung 4\.0|XRechnung\s*v?4/);
  assert.doesNotMatch(await read("index.html"), /<script[^>]+src="https?:/);
});

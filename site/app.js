// Antiphon validator — client-side application logic.
// Everything runs locally: SEF rule sets are same-origin static assets prefetched at
// page load; validating a document performs no network request at all.
import { detectFormat } from "./detect.js";
import { EXPLANATIONS } from "./explanations.js";
import { config, evaluationCopy } from "./config.js";

const $ = (id) => document.getElementById(id);
const input = $("xml-input");
const fileInput = $("file-input");
const formatSelect = $("format-select");
const btn = $("validate-btn");
const status = $("engine-status");
const responseSection = $("response");
const report = $("report");

const SVRL_NS = "http://purl.oclc.org/dsdl/svrl";
const UBL_CAC_NS = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";
const UBL_CBC_NS = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
const CII_RAM_NS = "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100";

let versions = null;
const sefs = new Map(); // ruleSetId -> parsed SEF object

// ---------- startup: manifest, format options, SEF prefetch ----------
init().catch((e) => {
  status.textContent = "Failed to load rule sets — reload the page to retry. (" + e.message + ")";
});

async function init() {
  versions = await (await fetch("rules/versions.json")).json();

  for (const [id, f] of Object.entries(versions.formats)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = f.label;
    formatSelect.append(opt);
  }

  // ANT-STD-3: render the same metadata shape the SDK's RuleSetProvenance carries — the
  // Antiphon-assigned rules-package version, the upstream tag, the pinned artifact sha256
  // (short), and the licence — so a reader can cross-check SDK and validator on versions.
  const shortSha = (s) => (s ? String(s).slice(0, 12) : "—");
  const versionLines = Object.values(versions.ruleSets)
    .map((rs) => {
      const pkg = rs.rulesPackageVersion ? `Antiphon rules-package ${rs.rulesPackageVersion} · ` : "";
      return `${rs.label} — ${pkg}${rs.upstream} @ ${rs.tag} · sha256 ${shortSha(rs.sha256)}… · ${rs.license}`;
    })
    .filter((v, i, a) => a.indexOf(v) === i);
  const bundle = versions.bundleRelease ? `bundle release ${esc(versions.bundleRelease)} · ` : "";
  $("versions").innerHTML =
    "<strong>Validated against:</strong><br>" +
    versionLines.map(esc).join("<br>") +
    `<br>${bundle}rule sets compiled ${esc(versions.generated.slice(0, 10))} · engine: SaxonJS ${esc(versions.tools["saxon-js"])} (runtime, local)`;

  // Prefetch all SEFs now so that validating later makes zero network requests.
  const ids = Object.keys(versions.ruleSets);
  let done = 0;
  for (const id of ids) {
    status.textContent = `Loading rule sets… ${done} of ${ids.length}`;
    sefs.set(id, await (await fetch(versions.ruleSets[id].sef)).json());
    done++;
  }
  status.textContent = "Rule sets ready. Validation runs entirely in your browser.";
}

// ---------- input handling ----------
fileInput.addEventListener("change", async () => {
  const f = fileInput.files[0];
  if (f) input.value = await readInvoiceFile(f);
});
for (const ev of ["dragover", "dragleave", "drop"]) {
  input.addEventListener(ev, (e) => {
    e.preventDefault();
    input.classList.toggle("dragover", ev === "dragover");
    if (ev === "drop" && e.dataTransfer.files[0]) {
      readInvoiceFile(e.dataTransfer.files[0]).then((t) => (input.value = t));
    }
  });
}

async function readInvoiceFile(f) {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const head = String.fromCharCode(...bytes.slice(0, 5));
  if (head === "%PDF-") {
    showInfo(
      "That’s a PDF — Factur-X/ZUGFeRD PDF extraction is coming soon.",
      "For now, extract the embedded XML (usually <code>factur-x.xml</code> or <code>zugferd-invoice.xml</code>) from the PDF’s attachments and paste it here."
    );
    return "";
  }
  return new TextDecoder().decode(bytes);
}

// ---------- validation flow ----------
btn.addEventListener("click", () => validate().catch((e) => {
  showInfo("Something went wrong during validation.", esc(e.message));
  btn.disabled = false;
}));

async function validate() {
  const xml = input.value.trim();
  if (!xml) {
    showInfo("Nothing to validate yet.", "Paste invoice XML above, or choose a file.");
    return;
  }

  btn.disabled = true;
  try {
    // 1. well-formedness
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      showParseError(parseError.textContent);
      return;
    }

    // 2. format
    const detected = detectFormat(xml);
    let format = formatSelect.value === "auto" ? detected.format : formatSelect.value;
    if (!format) {
      showInfo(
        "This doesn’t look like a supported e-invoice format.",
        `Root element: <code>${esc(detected.root ? detected.root.local : "(none)")}</code>. Supported: ` +
          Object.values(versions.formats).map((f) => esc(f.label)).join(" · ") +
          ". If you know the format, pick it manually and validate again."
      );
      return;
    }

    // 3. run the format's rule sets
    const ruleSetIds = versions.formats[format].ruleSets;
    const svrls = [];
    const violations = [];
    for (let i = 0; i < ruleSetIds.length; i++) {
      const id = ruleSetIds[i];
      status.textContent = `Running rule set ${i + 1} of ${ruleSetIds.length} — ${versions.ruleSets[id].label}…`;
      await new Promise((r) => setTimeout(r)); // let the status paint
      if (!sefs.has(id)) sefs.set(id, await (await fetch(versions.ruleSets[id].sef)).json());
      const result = await SaxonJS.transform(
        { stylesheetInternal: sefs.get(id), sourceText: xml, destination: "serialized" },
        "async"
      );
      svrls.push({ id, svrl: result.principalResult });
      const parsed = parseSvrl(result.principalResult, versions.ruleSets[id].label);
      // Tag each violation with the rule-set id and syntax binding it came from — needed by
      // correctSaxonJsIbanModBug below to know which document elements to check, and cheaper
      // than re-deriving it from `format` or the human-readable label.
      for (const v of parsed) {
        v.ruleSetId = id;
        v.syntaxBinding = versions.ruleSets[id].syntaxBinding;
      }
      violations.push(...parsed);
    }
    status.textContent = "Rule sets ready. Validation runs entirely in your browser.";

    const correctedViolations = correctSaxonJsIbanModBug(doc, violations, versions.tools["saxon-js"]);
    renderReport(format, detected, correctedViolations, svrls);
    sendTelemetry(format, correctedViolations);
  } finally {
    btn.disabled = false;
  }
}

// ---------- telemetry (content-free by design; dormant unless an endpoint is configured) ----------
function sendTelemetry(format, violations) {
  if (!config.telemetryEndpoint || !navigator.sendBeacon) return;
  const rules = {};
  for (const v of violations) rules[v.id] = (rules[v.id] || 0) + 1;
  const top = Object.fromEntries(Object.entries(rules).sort((a, b) => b[1] - a[1]).slice(0, 50));
  const fatals = violations.filter((v) => v.severity === "fatal").length;
  const payload = {
    v: 1,
    format,
    outcome: fatals === 0 ? "pass" : "fail",
    fatals,
    warnings: violations.length - fatals,
    rules: top,
  };
  navigator.sendBeacon(config.telemetryEndpoint, new Blob([JSON.stringify(payload)], { type: "application/json" }));
}

function parseSvrl(svrlText, ruleSetLabel) {
  const doc = new DOMParser().parseFromString(svrlText, "application/xml");
  const out = [];
  for (const tag of ["failed-assert", "successful-report"]) {
    for (const el of doc.getElementsByTagNameNS(SVRL_NS, tag)) {
      const flag = (el.getAttribute("flag") || el.getAttribute("role") || "fatal").toLowerCase();
      out.push({
        id: el.getAttribute("id") || "(no id)",
        severity: flag === "fatal" || flag === "error" ? "fatal" : "warning",
        location: el.getAttribute("location") || "",
        message: (el.getElementsByTagNameNS(SVRL_NS, "text")[0]?.textContent || "").replace(/\s+/g, " ").trim(),
        ruleSet: ruleSetLabel,
      });
    }
  }
  return out;
}

// ---------- SaxonJS large-integer `mod` bug workaround (ANT-V4) ----------
// SaxonJS 2.7.0 (and, per the upstream issue thread, the 3.0.0-beta2 preview) computes the
// XPath `mod` operator on xs:integer operands above JavaScript's 2^53 safe-integer boundary
// using double-precision arithmetic, silently losing precision. Four assertions in the shipped
// rule sets build a 20-60+ digit integer via string-join + `mod 97 = 1` to validate an IBAN's
// checksum: BR-DE-19/BR-DE-20 (xrechnung-ubl, xrechnung-cii — the named xr:checkIBAN function)
// and DE-R-019/DE-R-020 (peppol-ubl, both current v3.0.20 and N-1 v3.0.19 — inline formula).
// SaxonJS gets the wrong answer for real (large) IBANs and reports a false-positive warning on
// ones that are actually valid. Filed upstream, unfixed as of this writing:
// https://saxonica.plan.io/issues/7180
//
// Delete this whole section (and its call site in validate()) once a saxon-js/xslt3 release
// fixes that issue. SAXON_JS_MOD_BUG_VERSIONS gates the correction to the confirmed-buggy
// engine version(s) — bump the pin and drop the old version from this set (or just empty it)
// once a fix is adopted, and the workaround stops applying itself automatically.
const SAXON_JS_MOD_BUG_VERSIONS = new Set(["2.7.0"]);

const IBAN_MOD_BUG_RULES = {
  "BR-DE-19": "payee",
  "BR-DE-20": "payer",
  "DE-R-019": "payee",
  "DE-R-020": "payer",
};

/**
 * Independently recompute an IBAN's MOD-97 checksum with BigInt (exact/arbitrary-precision —
 * unlike Number, string-to-BigInt and `%` never round through a 53-bit mantissa, which is
 * exactly where SaxonJS's own `mod` on xs:integer goes wrong per Saxonica issue #7180).
 * Faithful port of the identical structural-regex + rearrange + codepoint-map + mod-97 formula
 * read from xr:checkIBAN (xrechnung-ubl.xslt / xrechnung-cii.xslt) and the inline DE-R-019/020
 * test= expressions (peppol-ubl.sch). Returns true/false, or null when the text isn't
 * IBAN-shaped — callers must never treat null as "valid".
 */
function ibanMod97IsValid(raw) {
  if (typeof raw !== "string") return null;
  // XSD/XPath regex `\s` (as used by the upstream `replace($iban, '([\s])', '')` step this
  // mirrors) is ASCII-only — space/tab/CR/LF — unlike JS's Unicode-aware `\s`, which also
  // strips U+00A0 and other Unicode spaces. Using JS's wider class here would make a genuinely
  // malformed IBAN (containing e.g. a stray NBSP) look clean and pass structurally when the
  // upstream rule — which does NOT strip that character — still correctly reports it as bad.
  const cleaned = raw.replace(/[ \t\n\r]+/g, "");
  if (!/^[A-Z]{2}[0-9]{2}[a-zA-Z0-9]{0,30}$/.test(cleaned)) return null;
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 2).toUpperCase() + cleaned.slice(2, 4);
  let digits = "";
  for (const ch of rearranged) {
    const cp = ch.codePointAt(0);
    digits += cp > 64 ? String(cp - 55) : String(cp - 48);
  }
  return BigInt(digits) % 97n === 1n;
}

/**
 * Resolve an SVRL `location` value — a "/"-separated path of `Q{namespace}LocalName[position]`
 * steps (Saxon/SchXslt's EQName location format) — to the DOM element it names, walking down
 * from the document root. Returns null (never guesses) if the path doesn't parse or a step has
 * no matching child, e.g. because the document doesn't actually match the shape we expect.
 */
function resolveByLocation(doc, location) {
  if (!location) return null;
  let node = doc;
  for (const step of location.split("/").filter(Boolean)) {
    const m = step.match(/^Q\{([^}]*)\}([^[]+)\[(\d+)\]$/);
    if (!m || !node.childNodes) return null;
    const [, ns, local, posStr] = m;
    const position = Number(posStr);
    const matches = [...node.childNodes].filter((n) => n.nodeType === 1 && n.namespaceURI === ns && n.localName === local);
    node = matches[position - 1];
    if (!node) return null;
  }
  return node;
}

/**
 * The IBAN text within one specific PaymentMeans-like context element — the exact element the
 * SVRL violation's `location` points at (UBL cac:PaymentMeans, CII
 * ram:SpecifiedTradeSettlementPaymentMeans) — never the whole document. Scoping to that single
 * context is what makes this safe when a document has more than one PaymentMeans block (e.g. a
 * valid code-58 credit transfer next to an invalid code-59 direct debit): each violation is
 * checked only against the account inside its own reported context, never a sibling's.
 */
function ibanTextForContext(contextEl, syntaxBinding, role) {
  if (!contextEl) return null;
  if (syntaxBinding === "ubl") {
    const account =
      role === "payee"
        ? contextEl.getElementsByTagNameNS(UBL_CAC_NS, "PayeeFinancialAccount")[0]
        : contextEl.getElementsByTagNameNS(UBL_CAC_NS, "PaymentMandate")[0]?.getElementsByTagNameNS(UBL_CAC_NS, "PayerFinancialAccount")[0];
    const idEl = account ? account.getElementsByTagNameNS(UBL_CBC_NS, "ID")[0] : undefined;
    return idEl ? idEl.textContent : null;
  }
  if (syntaxBinding === "cii") {
    const tag = role === "payee" ? "PayeePartyCreditorFinancialAccount" : "PayerPartyDebtorFinancialAccount";
    const account = contextEl.getElementsByTagNameNS(CII_RAM_NS, tag)[0];
    const idEl = account ? account.getElementsByTagNameNS(CII_RAM_NS, "IBANID")[0] : undefined;
    return idEl ? idEl.textContent : null;
  }
  return null;
}

/**
 * Drop BR-DE-19/20 and DE-R-019/20 warnings that are false positives caused by the SaxonJS
 * `mod` bug above — and only those. For each violation with an affected rule ID, resolves the
 * exact PaymentMeans-like element SVRL says it concerns (from the violation's own `location`,
 * not by pairing/counting elsewhere in the document — a prior version of this function did that
 * and could mis-pair a valid account with a different, genuinely-invalid violation when a
 * document had more than one PaymentMeans block), extracts that context's IBAN text, and drops
 * the violation only when the independent recomputation confirms it's actually MOD-97-valid. If
 * the location can't be resolved, no IBAN-shaped text is found there, or the independent check
 * agrees it's invalid, the violation is left exactly as SaxonJS reported it.
 */
function correctSaxonJsIbanModBug(doc, violations, engineVersion) {
  if (engineVersion && !SAXON_JS_MOD_BUG_VERSIONS.has(engineVersion)) return violations;
  return violations.filter((v) => {
    const role = IBAN_MOD_BUG_RULES[v.id];
    if (!role) return true;
    const contextEl = resolveByLocation(doc, v.location);
    const ibanText = ibanTextForContext(contextEl, v.syntaxBinding, role);
    return ibanMod97IsValid(ibanText) !== true;
  });
}

// ---------- rendering ----------
function renderReport(format, detected, violations, svrls) {
  const fatals = violations.filter((v) => v.severity === "fatal");
  const warnings = violations.filter((v) => v.severity === "warning");

  const parts = [];
  if (fatals.length === 0) {
    parts.push(`<p class="verdict pass">℟&ensp;Passes — 0 violations${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}.</p>`);
  } else {
    parts.push(`<p class="verdict fail">℟&ensp;${fatals.length} violation${fatals.length === 1 ? "" : "s"}${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}.</p>`);
  }

  const ruleSetIds = versions.formats[format].ruleSets;
  const detectNote =
    formatSelect.value !== "auto" ? "chosen manually"
    : detected.confident ? "auto-detected"
    : "auto-detect was unsure — defaulted to this; override above if wrong";
  const shortSha = (s) => (s ? String(s).slice(0, 12) : "—");
  parts.push(
    `<p class="report-meta">Format: ${esc(versions.formats[format].label)} (${detectNote})<br>` +
      `Rules: ${ruleSetIds.map((id) => esc(versions.ruleSets[id].label)).join(" + ")}<br>` +
      // ANT-STD-3: per-rule-set version provenance mirrored from the SDK (rules-package version,
      // upstream tag, pinned-artifact sha256, licence — all already in versions.json, now shown).
      ruleSetIds
        .map((id) => {
          const rs = versions.ruleSets[id];
          const pkg = rs.rulesPackageVersion ? `rules-package ${esc(rs.rulesPackageVersion)}, ` : "";
          return `${esc(rs.label)}: ${pkg}${esc(rs.upstream)} @ ${esc(rs.tag)} · sha256 ${esc(shortSha(rs.sha256))}… · ${esc(rs.license)}`;
        })
        .join("<br>") +
      `<br>` +
      svrls.map((s) => `<a href="${svrlBlobUrl(s.svrl)}" download="${esc(s.id)}.svrl.xml">Download raw SVRL — ${esc(versions.ruleSets[s.id].label)}</a>`).join(" · ") +
      `</p>`
  );

  for (const [title, cls, list] of [["Violations", "fatal", fatals], ["Warnings", "warning", warnings]]) {
    if (list.length === 0) continue;
    parts.push(`<h3 class="viol-group-title ${cls}">${title} · ${list.length}</h3>`);
    for (const v of list) parts.push(renderViolation(v, cls));
  }

  report.innerHTML = parts.join("");
  renderWaitlist();
  reveal();
}

function renderViolation(v, cls) {
  const hint = locationHint(v.location);
  const explain = EXPLANATIONS[v.id];
  return (
    `<div class="viol ${cls}">` +
    `<div class="viol-head"><span class="viol-id">${esc(v.id)}</span>` +
    (hint ? `<span class="viol-where">near &lt;${esc(hint)}&gt;</span>` : "") +
    `<span class="viol-where">${esc(v.ruleSet)}</span></div>` +
    (explain ? `<p class="viol-explain">${esc(explain)}</p>` : "") +
    (v.message ? `<p class="viol-msg${explain ? " viol-msg-official" : ""}">${explain ? "Official rule text: " : ""}${esc(v.message)}</p>` : "") +
    (v.location ? `<p class="viol-loc">${esc(v.location)}</p>` : "") +
    `</div>`
  );
}

// ---------- waitlist (always after results — never a wall in front of them) ----------
let waitlistState = "open"; // open | done
function renderWaitlist() {
  const host = $("waitlist");
  if (waitlistState === "done") {
    host.innerHTML = `<p class="waitlist-thanks">Thanks — you’re on the list. We’ll write once, when it ships.</p>`;
    return;
  }
  host.innerHTML =
    `<div class="waitlist">` +
    `<h3 class="viol-group-title">Need this as a .NET library?</h3>` +
    `<p class="viol-msg">The engine behind this page is becoming <strong>Antiphon</strong> — generate and validate
     XRechnung, Peppol and Factur-X invoices natively in .NET. No Java sidecar, no per-invoice fees,
     nothing leaves your process. Leave an email and we’ll tell you when it ships.</p>` +
    `<form id="waitlist-form">` +
    `<input type="email" id="wl-email" required placeholder="you@company.eu" aria-label="Email address">` +
    `<input type="text" id="wl-note" maxlength="300" placeholder="What would you use it for? (optional)" aria-label="Optional note">` +
    `<input type="text" id="wl-website" tabindex="-1" autocomplete="off" aria-hidden="true">` +
    `<button type="submit">Keep me posted</button>` +
    `</form>` +
    `<p class="quiet" id="wl-status"></p>` +
    `</div>`;
  $("waitlist-form").addEventListener("submit", submitWaitlist);
}

async function submitWaitlist(e) {
  e.preventDefault();
  const statusEl = $("wl-status");
  if (!config.waitlistEndpoint) {
    statusEl.textContent = "This is a preview build — the waitlist opens when the site goes live.";
    return;
  }
  const body = JSON.stringify({
    email: $("wl-email").value.trim(),
    note: $("wl-note").value.trim(),
    website: $("wl-website").value, // honeypot — humans leave it empty
  });
  statusEl.textContent = "Sending…";
  try {
    const res = await fetch(config.waitlistEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    waitlistState = "done";
    renderWaitlist();
  } catch {
    statusEl.textContent = "That didn’t go through — please try again in a moment.";
  }
}

// ---------- evaluation-key request form (visible from page load, not gated on a validation run) ----------
const EVAL_LIMITS = { name: 200, email: 254, company: 200, country: 100, building: 500, source: 200 };
const EVAL_EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/; // same shape as the Worker's EMAIL_RE
const evalCopy = evaluationCopy(config.antiphon11Live === true);
$("eval-intro").textContent = evalCopy.intro;
$("eval-form").addEventListener("submit", submitEvaluation);

function evalValues() {
  const v = (id) => $(id).value.trim();
  return {
    name: v("eval-name"),
    email: v("eval-email"),
    company: v("eval-company"),
    country: v("eval-country"),
    building: v("eval-building"),
    formats: [...document.querySelectorAll('#eval-form input[name="formats"]:checked')].map((c) => c.value),
    timeline: $("eval-timeline").value,
    target: $("eval-target").value,
    source: v("eval-source"),
    website: $("eval-website").value, // honeypot — humans leave it empty
  };
}

/** First problem as { id, message } (focus target + status text), or null. */
function evalProblem(d) {
  const labels = { name: "your name", email: "your work email", company: "your company", country: "your country", building: "what you are building" };
  for (const k of ["name", "email", "company", "country", "building"]) {
    if (!d[k] || d[k].length > EVAL_LIMITS[k] || /[<>]/.test(d[k]))
      return { id: "eval-" + k, message: "Please enter " + labels[k] + " (up to " + EVAL_LIMITS[k] + " characters, no < or >)." };
  }
  if (!EVAL_EMAIL_RE.test(d.email)) return { id: "eval-email", message: "Please enter a valid work email." };
  if (d.formats.length === 0) return { id: "eval-format-first", message: "Please choose at least one format." };
  if (d.source.length > EVAL_LIMITS.source || /[<>]/.test(d.source))
    return { id: "eval-source", message: "Please shorten that answer (no < or >)." };
  return null;
}

async function submitEvaluation(e) {
  e.preventDefault();
  const statusEl = $("eval-status");
  const data = evalValues();
  const problem = evalProblem(data);
  if (problem) {
    statusEl.textContent = problem.message;
    $(problem.id).focus();
    return;
  }
  if (!config.evaluationEndpoint) {
    statusEl.textContent = "This is a preview build — the request form isn’t wired up yet.";
    return;
  }
  const submit = $("eval-submit");
  submit.disabled = true;
  statusEl.textContent = "Sending…";
  try {
    const res = await fetch(config.evaluationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    statusEl.textContent = "";
    $("eval-form").hidden = true;
    $("eval-intro").hidden = true;
    const done = $("eval-done");
    done.textContent = evalCopy.thanks;
    done.hidden = false;
  } catch {
    submit.disabled = false;
    statusEl.textContent = "That didn’t go through. Please try again in a moment, or write to info@clockworkotterfoundry.com.";
  }
}

/** Last element name from an SVRL location XPath — a human landmark, not a precise pointer. */
function locationHint(location) {
  const steps = location.split("/").filter(Boolean);
  for (let i = steps.length - 1; i >= 0; i--) {
    const m = steps[i].match(/^(?:\*:)?([A-Za-z][\w-]*)/);
    if (m && m[1] !== "text" && m[1] !== "node") return m[1];
  }
  return null;
}

function svrlBlobUrl(svrlText) {
  return URL.createObjectURL(new Blob([svrlText], { type: "application/xml" }));
}

function showParseError(text) {
  report.innerHTML =
    `<p class="verdict fail">℟&ensp;Not well-formed XML.</p>` +
    `<div class="parse-error"><p class="viol-msg">The document couldn’t be parsed, so no rules were run. The parser said:</p>` +
    `<pre>${esc(text.trim())}</pre></div>`;
  renderWaitlist();
  if (config.telemetryEndpoint && navigator.sendBeacon) {
    navigator.sendBeacon(
      config.telemetryEndpoint,
      new Blob([JSON.stringify({ v: 1, format: "unknown", outcome: "malformed", fatals: 0, warnings: 0, rules: {} })], { type: "application/json" })
    );
  }
  reveal();
}

function showInfo(headline, detailHtml) {
  report.innerHTML =
    `<p class="verdict info">℟&ensp;${esc(headline)}</p>` +
    (detailHtml ? `<p class="viol-msg">${detailHtml}</p>` : "");
  reveal();
}

function reveal() {
  responseSection.hidden = false;
  responseSection.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

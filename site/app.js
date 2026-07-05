// Antiphon validator — client-side application logic.
// Everything runs locally: SEF rule sets are same-origin static assets prefetched at
// page load; validating a document performs no network request at all.
import { detectFormat } from "./detect.js";
import { EXPLANATIONS } from "./explanations.js";
import { config } from "./config.js";

const $ = (id) => document.getElementById(id);
const input = $("xml-input");
const fileInput = $("file-input");
const formatSelect = $("format-select");
const btn = $("validate-btn");
const status = $("engine-status");
const responseSection = $("response");
const report = $("report");

const SVRL_NS = "http://purl.oclc.org/dsdl/svrl";

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

  const versionLines = Object.values(versions.ruleSets)
    .map((rs) => `${rs.label} — ${rs.upstream} @ ${rs.tag}`)
    .filter((v, i, a) => a.indexOf(v) === i);
  $("versions").innerHTML =
    "<strong>Validated against:</strong><br>" +
    versionLines.map(esc).join("<br>") +
    `<br>rule sets compiled ${esc(versions.generated.slice(0, 10))} · engine: SaxonJS ${esc(versions.tools["saxon-js"])} (runtime, local)`;

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
      violations.push(...parseSvrl(result.principalResult, versions.ruleSets[id].label));
    }
    status.textContent = "Rule sets ready. Validation runs entirely in your browser.";

    renderReport(format, detected, violations, svrls);
    sendTelemetry(format, violations);
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
  parts.push(
    `<p class="report-meta">Format: ${esc(versions.formats[format].label)} (${detectNote})<br>` +
      `Rules: ${ruleSetIds.map((id) => esc(versions.ruleSets[id].label)).join(" + ")}<br>` +
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

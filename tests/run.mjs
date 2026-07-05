// Headless smoke tests: run the exact SEFs the site ships against every fixture.
// Asserts: (1) auto-detect returns the right format for every fixture;
// (2) valid fixtures produce zero fatal/error violations;
// (3) each seeded-error mutation reports exactly its expected rule IDs (among fatals).
// Run: `npm test` from validator/.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import SaxonJS from "saxon-js";
import { detectFormat } from "../site/detect.js";
import { EXPLANATIONS } from "../site/explanations.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const versions = JSON.parse(await readFile(join(root, "site", "rules", "versions.json"), "utf8"));
const expected = JSON.parse(await readFile(join(root, "fixtures", "expected.json"), "utf8"));

// Parse SVRL text into violation objects (regex is fine for test purposes).
function svrlViolations(svrl) {
  const out = [];
  const re = /<svrl:failed-assert\b([^>]*)>([\s\S]*?)<\/svrl:failed-assert>/g;
  for (const m of svrl.matchAll(re)) {
    const attrs = m[1];
    const id = attrs.match(/\bid="([^"]*)"/)?.[1] ?? "(no id)";
    const flag = (attrs.match(/\bflag="([^"]*)"/)?.[1] ?? attrs.match(/\brole="([^"]*)"/)?.[1] ?? "fatal").toLowerCase();
    out.push({ id, flag });
  }
  return out;
}

async function runRuleSet(ruleSetId, xmlText) {
  const sefPath = join(root, "site", versions.ruleSets[ruleSetId].sef);
  const result = await SaxonJS.transform(
    { stylesheetFileName: sefPath, sourceText: xmlText, destination: "serialized", principalResult: "svrl" },
    "async"
  );
  return svrlViolations(result.principalResult);
}

let pass = 0, fail = 0;
const bad = (msg) => { console.error("  FAIL " + msg); fail++; };
const good = (msg) => { console.log("  ok   " + msg); pass++; };

for (const [format, spec] of Object.entries(expected)) {
  console.log(`\n${format}`);
  if (spec.reuses) {
    // detection-only entry (e.g. cii-facturx reuses the CEN CII fixtures)
    good(`reuses ${spec.reuses} fixtures — ${spec.note}`);
    continue;
  }
  const validXml = await readFile(join(root, "fixtures", spec.valid), "utf8");
  const invalidXml = await readFile(join(root, "fixtures", spec.invalid), "utf8");

  // 1. auto-detect
  for (const [name, xml] of [[spec.valid, validXml], [spec.invalid, invalidXml]]) {
    const d = detectFormat(xml);
    if (d.format === format) good(`detect ${name} -> ${format}`);
    else bad(`detect ${name}: expected ${format}, got ${d.format} (customization: ${d.customization})`);
  }

  const ruleSets = versions.formats[format].ruleSets;

  // 2. valid fixture: zero fatal/error violations
  {
    const all = [];
    for (const rs of ruleSets) all.push(...(await runRuleSet(rs, validXml)));
    const fatals = all.filter((v) => v.flag === "fatal" || v.flag === "error");
    const warnings = all.filter((v) => !(v.flag === "fatal" || v.flag === "error"));
    if (fatals.length === 0) good(`${spec.valid}: 0 fatal (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`);
    else bad(`${spec.valid}: expected 0 fatal, got ${fatals.length}: ${[...new Set(fatals.map((v) => v.id))].join(", ")}`);
  }

  // 3. mutation: exactly the expected rule IDs among fatals
  {
    const all = [];
    for (const rs of ruleSets) all.push(...(await runRuleSet(rs, invalidXml)));
    const fatalIds = [...new Set(all.filter((v) => v.flag === "fatal" || v.flag === "error").map((v) => v.id))].sort();
    const want = [...spec.expectedRuleIds].sort();
    if (JSON.stringify(fatalIds) === JSON.stringify(want)) good(`${spec.invalid}: exactly [${want.join(", ")}]`);
    else bad(`${spec.invalid}: expected [${want.join(", ")}], got [${fatalIds.join(", ")}]`);
  }
}

// Every rule ID the fixture corpus can produce must have a plain-language explanation
// (VR-03: report meaningful to non-specialists — at minimum for rules we knowingly ship).
console.log("\nexplanations");
for (const spec of Object.values(expected)) {
  for (const id of spec.expectedRuleIds ?? []) {
    if (typeof EXPLANATIONS[id] === "string" && EXPLANATIONS[id].length > 20) good(`explanation exists: ${id}`);
    else bad(`missing/short explanation for fixture rule ID: ${id}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// Dev-time only. Builds the fixture corpus from the fetched official examples:
// copies each valid fixture and derives a seeded-error mutation with known expected
// rule IDs. Mutations are structural (remove/replace whole elements) so they survive
// upstream example edits; every mutation must match or the pipeline fails loudly.
// All business data in the fixtures is the upstream projects' fabricated sample data.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "work", "fixture-src");
const out = join(here, "..", "fixtures");
await mkdir(out, { recursive: true });

// Expected IDs: derived by executing the pinned official artifacts against each mutation
// (same run path as `npm test`) and sanity-checked against the rules' published texts:
//   BR-03  "An Invoice shall have an Invoice issue date"            (CEN, UBL + CII bindings)
//   BR-CL-04 currency code must be ISO 4217                          (CEN)
//   BR-CO-15/16 total/payable amount arithmetic consistency          (CEN; spike-verified pair)
//   PEPPOL-EN16931-R003 "A buyer reference or purchase order reference MUST be provided"
//   BR-DE-15 XRechnung: BuyerReference (Leitweg-ID) must be present  (KoSIT)
//   BR-TMP-2 XRechnung v2.6.0: external document reference (BT-124) MUST be an absolute URL —
//     raised from "warning" to "fatal" in v2.6.0 (ANT-STD-5; confirmed by direct .sch diff)
//
// `validMutations` (ANT-STD-5): applied to the *valid* fixture before it is copied out and before
// `mutations` derives the invalid one from it — for structural additions the valid fixture itself
// must carry (e.g. an empty BT-13 OrderReference/ID, valid only as of v2.6.0's PEPPOL-EN16931-R008
// fix) so both the valid and invalid fixtures stay generated, not hand-frozen.
const corpus = [
  {
    format: "ubl-en16931",
    valid: "ubl-en16931-valid.xml",
    invalid: "ubl-en16931-invalid.xml",
    expect: ["BR-03", "BR-CL-04", "BR-CO-15", "BR-CO-16"],
    mutations: [
      { re: /\s*<cbc:IssueDate>[^<]*<\/cbc:IssueDate>/, to: "" },
      { re: /<cbc:DocumentCurrencyCode>[^<]*<\/cbc:DocumentCurrencyCode>/, to: "<cbc:DocumentCurrencyCode>EU1</cbc:DocumentCurrencyCode>" },
      {
        re: /<cbc:PayableAmount currencyID="([^"]+)">([0-9.]+)<\/cbc:PayableAmount>/,
        to: (m, cur, amt) => `<cbc:PayableAmount currencyID="${cur}">${(Number(amt) + 100).toFixed(2)}</cbc:PayableAmount>`,
      },
    ],
  },
  {
    format: "ubl-peppol",
    valid: "ubl-peppol-valid.xml",
    invalid: "ubl-peppol-invalid.xml",
    expect: ["PEPPOL-EN16931-R003"],
    mutations: [
      { re: /\s*<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/, to: "", optional: false },
      { re: /\s*<cac:OrderReference>[\s\S]*?<\/cac:OrderReference>/, to: "", optional: true },
    ],
  },
  {
    format: "ubl-xrechnung",
    valid: "ubl-xrechnung-valid.xml",
    invalid: "ubl-xrechnung-invalid.xml",
    expect: ["BR-DE-15", "BR-TMP-2"],
    // ANT-STD-5: the valid fixture gains an empty BT-13 OrderReference/ID (PEPPOL-EN16931-R008 fix
    // proof — fatal pre-v2.6.0, no longer rejected as of v2.6.0) right after BuyerReference.
    validMutations: [
      {
        re: /(<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>)/,
        to: "$1\n    <cac:OrderReference><cbc:ID/></cac:OrderReference>",
      },
    ],
    mutations: [
      { re: /\s*<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/, to: "" },
      // BR-TMP-2 (fatal as of v2.6.0): a non-absolute BT-124 external-document-reference URL.
      {
        re: /(<cac:OrderReference><cbc:ID\/><\/cac:OrderReference>)/,
        to: "$1\n    <cac:AdditionalDocumentReference><cbc:ID>invoice-attachment</cbc:ID>"
          + "<cac:Attachment><cac:ExternalReference><cbc:URI>invoice.pdf</cbc:URI></cac:ExternalReference></cac:Attachment>"
          + "</cac:AdditionalDocumentReference>",
      },
    ],
  },
  {
    format: "cii-en16931",
    valid: "cii-en16931-valid.xml",
    invalid: "cii-en16931-invalid.xml",
    expect: ["BR-03"],
    mutations: [{ re: /\s*<ram:IssueDateTime>[\s\S]*?<\/ram:IssueDateTime>/, to: "" }],
  },
  {
    format: "cii-xrechnung",
    valid: "cii-xrechnung-valid.xml",
    invalid: "cii-xrechnung-invalid.xml",
    expect: ["BR-DE-15", "BR-TMP-2"],
    mutations: [
      // BR-TMP-2 (fatal as of v2.6.0, CII side): a non-absolute URIID on a
      // AdditionalReferencedDocument[TypeCode='916'] (BT-124's CII carrier). Anchored on
      // BuyerReference, so this must run before the BR-DE-15 mutation removes it below.
      {
        re: /(<ram:BuyerReference>[^<]*<\/ram:BuyerReference>)/,
        to: "$1\n            <ram:AdditionalReferencedDocument><ram:IssuerAssignedID>invoice-attachment</ram:IssuerAssignedID>"
          + "<ram:URIID>invoice.pdf</ram:URIID><ram:TypeCode>916</ram:TypeCode></ram:AdditionalReferencedDocument>",
      },
      { re: /\s*<ram:BuyerReference>[^<]*<\/ram:BuyerReference>/, to: "" },
    ],
  },
  {
    // ANT-STD-4a hand-authored this pair directly under validator/fixtures/ (no upstream Peppol
    // CII example is pinned in pins.json the way base-example.xml is for ubl-peppol) — the invalid
    // fixture encodes a Peppol-layer constraint that the generic mutation approach below can't
    // reliably reproduce. `pinned: true` skips copy-from-src and mutation; it only verifies the
    // committed files exist and records the expectation, leaving both files byte-identical.
    format: "cii-peppol",
    valid: "cii-peppol-valid.xml",
    invalid: "cii-peppol-invalid.xml",
    expect: ["PEPPOL-EN16931-R003"],
    pinned: true,
  },
];

let failures = 0;
const expected = {};
for (const c of corpus) {
  if (c.pinned) {
    for (const f of [c.valid, c.invalid]) {
      if (!existsSync(join(out, f))) {
        console.error(`FAIL ${c.format}: pinned fixture missing: ${f}`);
        failures++;
      }
    }
    expected[c.format] = { valid: c.valid, invalid: c.invalid, expectedRuleIds: c.expect };
    console.log(`  ok  ${c.format}: ${c.valid} + ${c.invalid} (pinned, expect: ${c.expect.join(", ")})`);
    continue;
  }
  const srcText = await readFile(join(src, c.valid), "utf8");
  let text = srcText;
  for (const m of c.validMutations ?? []) {
    if (!m.re.test(text)) {
      console.error(`FAIL ${c.format}: validMutation did not match: ${m.re}`);
      failures++;
      continue;
    }
    text = text.replace(m.re, m.to);
  }
  await writeFile(join(out, c.valid), text);
  let mutated = text;
  for (const m of c.mutations) {
    if (!m.re.test(mutated)) {
      if (m.optional) continue;
      console.error(`FAIL ${c.format}: mutation did not match: ${m.re}`);
      failures++;
      continue;
    }
    mutated = mutated.replace(m.re, m.to);
  }
  await writeFile(join(out, c.invalid), mutated);
  expected[c.format] = { valid: c.valid, invalid: c.invalid, expectedRuleIds: c.expect };
  console.log(`  ok  ${c.format}: ${c.valid} + ${c.invalid} (expect: ${c.expect.join(", ")})`);
}

// cii-facturx runs the same CEN CII rules — reuse the CII fixtures for detection coverage
expected["cii-facturx"] = { reuses: "cii-en16931", note: "Factur-X EN 16931-profile XML validates via the CEN CII rule set; PDF extraction is v0.x backlog" };

await writeFile(join(out, "expected.json"), JSON.stringify(expected, null, 2));

// ANT-STD-7A: conformance-matrix expansion. work/fixture-src/conformance/<ruleSet>/*.xml holds the
// additional official example files pins.json now pins/extracts from each publisher's fuller
// example corpus (CEN UBL/CII, Peppol UBL, a bounded KoSIT XRechnung subset — see
// docs/Results/ANTIPHON-STD-7A-Conformance-Matrix-Expansion.md for the survey/selection rationale).
// These are copied byte-for-byte (no mutation — they are already-valid official examples, not
// smoke-test seeds) into validator/fixtures/conformance/<ruleSet>/ so they ship as a committed,
// citable corpus. conformance-results.json records the fatal/warning rule-ID verdict each file
// actually produced when run through Antiphon's own evaluator and, where feasible, the independent
// SaxonHE parity oracle during ANT-STD-7A (both agreed on every file — see the phase's result doc);
// this script only copies files, it does not re-run either engine.
const conformanceResults = {
  note: "ANT-STD-7A conformance-matrix expansion. Verdicts observed by running Antiphon.Validation's " +
    "RuleSetEvaluator (this repo's own IR interpreter) and, where feasible, the independent SaxonHE " +
    "parity oracle (tools/Antiphon.ParityOracle) against each file directly during ANT-STD-7A's " +
    "phase execution — both engines agreed on every file listed here (all clean: zero fatal rule " +
    "violations). See docs/Results/ANTIPHON-STD-7A-Conformance-Matrix-Expansion.md for the full " +
    "conformance matrix, survey findings, and the KoSIT-subset selection rationale. This script only " +
    "copies the pinned files verbatim; it does not itself run either verification engine.",
  ruleSets: {
    "cen-ubl": {
      files: [
        { file: "BIS3_Invoice_negativ.XML", fatalRuleIds: [], warningRuleIds: [], note: "negative-amount corrective invoice, not a schema-error test case" },
        { file: "BIS3_Invoice_positive.XML", fatalRuleIds: [], warningRuleIds: [] },
        { file: "FT-G2G-TD01.xml", fatalRuleIds: [], warningRuleIds: [], note: "renamed from upstream's 'FT G2G_TD01 con Allegato, Bonifico e Split Payment.xml' (spaces/comma) at pin time" },
        { file: "guide-example1.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "guide-example2.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "guide-example3.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "issue116.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "sample-discount-price.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "ubl-tc434-creditnote1.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "ubl-tc434-example2.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "ubl-tc434-example3.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "ubl-tc434-example4.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "ubl-tc434-example5.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "ubl-tc434-example6.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "ubl-tc434-example7.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "ubl-tc434-example8.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "ubl-tc434-example9.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "ubl-tc434-example10.xml", fatalRuleIds: [], warningRuleIds: [] },
      ],
    },
    "cen-cii": {
      files: [
        { file: "CII-BR-CO-10-RoundingIssue.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_business_example_01.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_business_example_02.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_business_example_Z.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_example2.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_example3.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_example4.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_example5.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_example6.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_example7.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_example8.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "CII_example9.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "XRechnung-O.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "huf_example_cii.xml", fatalRuleIds: [], warningRuleIds: [] },
      ],
    },
    "peppol-ubl": {
      files: [
        { file: "Allowance-example.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "Vat-category-S.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "vat-category-E.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "vat-category-O.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "vat-category-Z.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "base-creditnote-correction.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "base-negative-inv-correction.xml", fatalRuleIds: [], warningRuleIds: [], note: "negative-amount corrective invoice, not a schema-error test case" },
        { file: "sales-order-example.xml", fatalRuleIds: [], warningRuleIds: [] },
      ],
    },
    "xrechnung-ubl": {
      note: "warningRuleIds here are the SEF's (SaxonJS's) observed non-fatal verdicts — the actual " +
        "shipped web-validator path — not Antiphon's own RuleSetEvaluator/SaxonHE-oracle verdicts, " +
        "which agree with each other but under-report relative to the SEF for BR-DE-19/BR-DE-20 (see " +
        "the phase result doc's 'known engine discrepancy' note: these fire on IBANs independently " +
        "confirmed MOD-97-valid — a pre-existing SaxonJS/xr:checkIBAN false positive already present " +
        "on the committed ubl-xrechnung-valid.xml smoke fixture before this phase, not a regression " +
        "introduced here). fatalRuleIds agree across all three engines on every file.",
      files: [
        { file: "01.05a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-19", "BR-DE-19"] },
        { file: "01.09a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-TMP-32", "BR-DE-19", "BR-DE-19", "BR-DE-19"] },
        { file: "01.13a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-TMP-32", "BR-DE-19"] },
        { file: "01.17a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-TMP-32", "BR-DE-19"] },
        { file: "01.20a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "02.01a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-19"] },
        { file: "02.03a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-19"] },
        { file: "02.05a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-TMP-32", "BR-DE-19"] },
        { file: "03.01a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-20"] },
        { file: "03.03a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-TMP-32"] },
        { file: "03.05a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-20"] },
        { file: "03.07a-INVOICE_ubl.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-19", "BR-DE-19"] },
      ],
    },
    "xrechnung-cii": {
      note: "see xrechnung-ubl's note above — identical SEF-vs-SDK-evaluator/oracle discrepancy on the CII binding.",
      files: [
        { file: "01.05a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-19", "BR-DE-19"] },
        { file: "01.09a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-TMP-32", "BR-DE-19", "BR-DE-19", "BR-DE-19"] },
        { file: "01.13a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-TMP-32", "BR-DE-19"] },
        { file: "01.17a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-TMP-32", "BR-DE-19"] },
        { file: "01.20a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: [] },
        { file: "02.01a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-19"] },
        { file: "02.03a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-19"] },
        { file: "02.05a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-TMP-32", "BR-DE-19"] },
        { file: "03.01a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-20"] },
        { file: "03.03a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-TMP-32"] },
        { file: "03.05a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-20"] },
        { file: "03.07a-INVOICE_uncefact.xml", fatalRuleIds: [], warningRuleIds: ["BR-DE-19", "BR-DE-19"] },
      ],
    },
  },
};
const conformanceSrcRoot = join(here, "work", "fixture-src", "conformance");
const conformanceOutRoot = join(out, "conformance");
let conformanceCopied = 0;
for (const ruleSetId of Object.keys(conformanceResults.ruleSets)) {
  const srcDir = join(conformanceSrcRoot, ruleSetId);
  if (!existsSync(srcDir)) {
    console.error(`FAIL conformance ${ruleSetId}: expected source dir missing: ${srcDir} — run 'npm run pipeline' fetch step first`);
    failures++;
    continue;
  }
  const destDir = join(conformanceOutRoot, ruleSetId);
  await mkdir(destDir, { recursive: true });
  for (const fileEntry of conformanceResults.ruleSets[ruleSetId].files) {
    const srcFile = join(srcDir, fileEntry.file);
    if (!existsSync(srcFile)) {
      console.error(`FAIL conformance ${ruleSetId}: pinned example not found on disk: ${fileEntry.file}`);
      failures++;
      continue;
    }
    await writeFile(join(destDir, fileEntry.file), await readFile(srcFile));
    conformanceCopied++;
  }
}
await writeFile(join(out, "conformance-results.json"), JSON.stringify(conformanceResults, null, 2));
console.log(`  ok  conformance: ${conformanceCopied} official example file(s) copied to validator/fixtures/conformance/`);
if (failures > 0) {
  console.error(`fixtures FAILED (${failures})`);
  process.exit(1);
}
console.log("fixtures OK — corpus + expected.json written to validator/fixtures/");

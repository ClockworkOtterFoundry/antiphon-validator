// Dev-time only. Builds the fixture corpus from the fetched official examples:
// copies each valid fixture and derives a seeded-error mutation with known expected
// rule IDs. Mutations are structural (remove/replace whole elements) so they survive
// upstream example edits; every mutation must match or the pipeline fails loudly.
// All business data in the fixtures is the upstream projects' fabricated sample data.
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    expect: ["BR-DE-15"],
    mutations: [{ re: /\s*<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/, to: "" }],
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
    expect: ["BR-DE-15"],
    mutations: [{ re: /\s*<ram:BuyerReference>[^<]*<\/ram:BuyerReference>/, to: "" }],
  },
];

let failures = 0;
const expected = {};
for (const c of corpus) {
  const text = await readFile(join(src, c.valid), "utf8");
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
if (failures > 0) {
  console.error(`fixtures FAILED (${failures})`);
  process.exit(1);
}
console.log("fixtures OK — corpus + expected.json written to validator/fixtures/");

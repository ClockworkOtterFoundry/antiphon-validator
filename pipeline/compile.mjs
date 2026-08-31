// Dev-time only. Compiles the fetched rule artifacts to SEF for SaxonJS:
//   1. Peppol .sch -> XSLT via SchXslt (pure XSLT, executed by xslt3 — no Java)
//   2. every rule XSLT -> .sef.json via xslt3 -export
// Emits site/rules/versions.json (pins + tool versions + format->rule-set mapping).
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const work = join(here, "work");
const rulesDir = join(root, "site", "rules");
await mkdir(rulesDir, { recursive: true });

const xslt3 = join(root, "node_modules", ".bin", process.platform === "win32" ? "xslt3.cmd" : "xslt3");
if (!existsSync(xslt3)) {
  console.error("xslt3 not found — run `npm install` in validator/ first");
  process.exit(1);
}
const run = (args, label) => {
  console.log(`${label} ...`);
  execFileSync(xslt3, args, { stdio: ["ignore", "inherit", "inherit"] });
};

// 1. Peppol: .sch -> XSLT via SchXslt pipeline-for-svrl
const peppolXslt = join(work, "peppol-ubl.xslt");
run(
  [`-xsl:${join(work, "schxslt", "2.0", "pipeline-for-svrl.xsl")}`, `-s:${join(work, "peppol-ubl.sch")}`, `-o:${peppolXslt}`],
  "schxslt: peppol-ubl.sch -> peppol-ubl.xslt"
);

// 2. XSLT -> SEF
const ruleXslts = {
  "cen-ubl": join(work, "cen-ubl.xslt"),
  "cen-cii": join(work, "cen-cii.xslt"),
  "peppol-ubl": peppolXslt,
  "xrechnung-ubl": join(work, "xrechnung-ubl.xslt"),
  "xrechnung-cii": join(work, "xrechnung-cii.xslt"),
};
for (const [id, xsltPath] of Object.entries(ruleXslts)) {
  run([`-xsl:${xsltPath}`, `-export:${join(rulesDir, id + ".sef.json")}`, "-nogo", "-relocate:on"], `sef: ${id}`);
}

// 3. versions.json — the single manifest the page displays and the tests read
const pins = JSON.parse(await readFile(join(here, "pins.json"), "utf8"));
const pkgVer = async (name) =>
  JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8")).version;

const pin = (id) => {
  const a = pins.artifacts[id];
  return { upstream: a.upstream, tag: a.tag, license: a.license, sha256: a.sha256 };
};

const versions = {
  generated: new Date().toISOString(),
  tools: {
    "xslt3": await pkgVer("xslt3"),
    "saxon-js": await pkgVer("saxon-js"),
    "schxslt": pins.artifacts["schxslt"].tag + " (XSLT-only distribution; used to compile the Peppol .sch)",
  },
  ruleSets: {
    "cen-ubl": { label: "EN 16931 UBL (CEN/TC 434)", sef: "rules/cen-ubl.sef.json", ...pin("cen-ubl"), source: "official precompiled XSLT" },
    "cen-cii": { label: "EN 16931 CII (CEN/TC 434)", sef: "rules/cen-cii.sef.json", ...pin("cen-cii"), source: "official precompiled XSLT" },
    "peppol-ubl": { label: "Peppol BIS Billing 3.0 (UBL)", sef: "rules/peppol-ubl.sef.json", ...pin("peppol-ubl-sch"), source: "compiled locally from official .sch via SchXslt (no official XSLT is published)" },
    "xrechnung-ubl": { label: "XRechnung 3.0.2 UBL (KoSIT Schematron 2.5.0)", sef: "rules/xrechnung-ubl.sef.json", ...pin("xrechnung-schematron"), source: "official compiled XSL" },
    "xrechnung-cii": { label: "XRechnung 3.0.2 CII (KoSIT Schematron 2.5.0)", sef: "rules/xrechnung-cii.sef.json", ...pin("xrechnung-schematron"), source: "official compiled XSL" },
  },
  formats: {
    "ubl-en16931": { label: "UBL — EN 16931", ruleSets: ["cen-ubl"] },
    "ubl-peppol": { label: "UBL — Peppol BIS Billing 3.0", ruleSets: ["cen-ubl", "peppol-ubl"] },
    "ubl-xrechnung": { label: "UBL — XRechnung 3.0.2", ruleSets: ["cen-ubl", "xrechnung-ubl"] },
    "cii-en16931": { label: "CII — EN 16931", ruleSets: ["cen-cii"] },
    "cii-xrechnung": { label: "CII — XRechnung 3.0.2", ruleSets: ["cen-cii", "xrechnung-cii"] },
    "cii-facturx": { label: "CII — Factur-X/ZUGFeRD (EN 16931 profile XML)", ruleSets: ["cen-cii"], note: "XML input only in v0 — PDF container extraction is on the backlog" },
  },
};
await writeFile(join(rulesDir, "versions.json"), JSON.stringify(versions, null, 2));
console.log("compile OK — SEFs + versions.json written to site/rules/");

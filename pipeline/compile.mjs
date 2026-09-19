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
const peppolCiiXslt = join(work, "peppol-cii.xslt");
run(
  [`-xsl:${join(work, "schxslt", "2.0", "pipeline-for-svrl.xsl")}`, `-s:${join(work, "peppol-cii.sch")}`, `-o:${peppolCiiXslt}`],
  "schxslt: peppol-cii.sch -> peppol-cii.xslt"
);

// 2. XSLT -> SEF
const ruleXslts = {
  "cen-ubl": join(work, "cen-ubl.xslt"),
  "cen-cii": join(work, "cen-cii.xslt"),
  "peppol-ubl": peppolXslt,
  "xrechnung-ubl": join(work, "xrechnung-ubl.xslt"),
  "xrechnung-cii": join(work, "xrechnung-cii.xslt"),
  "peppol-cii": peppolCiiXslt,
};
for (const [id, xsltPath] of Object.entries(ruleXslts)) {
  run([`-xsl:${xsltPath}`, `-export:${join(rulesDir, id + ".sef.json")}`, "-nogo", "-relocate:on"], `sef: ${id}`);
}

// 3. versions.json — the single manifest the page displays and the tests read
const pins = JSON.parse(await readFile(join(here, "pins.json"), "utf8"));
const pkgVer = async (name) =>
  JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8")).version;

// ANT-STD-7A (closes ANT-STD-3 fu-b): sourced from tools/Antiphon.RuleCompiler/out/rule-set-metadata.json
// — the SDK-side rules-package metadata contract that tool's `dotnet run -- compile` emits — instead
// of a hand-duplicated table. That file is gitignored scratch output (tools/Antiphon.RuleCompiler/out/),
// so it only exists in a working tree that has actually run the SDK compiler. Rather than have this
// Node pipeline shell out to `dotnet` itself (a second toolchain dependency this script would then
// need on every machine that runs `npm run pipeline`, including CI), this repo documents and requires
// a fixed run order instead — the same order this phase's own verification steps already use, and the
// same one ANT-STD-5/ANT-STD-5-IBAN followed by convention: run
//   cd tools/Antiphon.RuleCompiler && dotnet run -- fetch && dotnet run -- compile
// once per working tree BEFORE `npm run pipeline`. That keeps this script single-runtime (no `dotnet`
// dependency added to the Node pipeline) and fails loudly with a precise fix-it instruction rather
// than silently falling back to stale or hand-maintained values.
const sdkMetaPath = join(root, "..", "tools", "Antiphon.RuleCompiler", "out", "rule-set-metadata.json");
if (!existsSync(sdkMetaPath)) {
  console.error(
    `compile.mjs: SDK rules-package metadata not found at ${sdkMetaPath}\n` +
    `Run 'dotnet run -- compile' from tools/Antiphon.RuleCompiler (after 'dotnet run -- fetch') ` +
    `before 'npm run pipeline' — see validator/pipeline/compile.mjs's sdkMeta comment.`
  );
  process.exit(1);
}
const sdkMetaEntries = JSON.parse(await readFile(sdkMetaPath, "utf8"));
// Only the current (non-N-1) entry per source: rule-set-metadata.json also carries Legacy N-1
// entries (e.g. "peppol-ubl-v3.0.19") sharing the same sourceId under a different fileId.
const sdkMeta = Object.fromEntries(
  sdkMetaEntries
    .filter((e) => e.lifecycle === "Active" && e.fileId === e.sourceId)
    .map((e) => [e.sourceId, {
      rulesPackageVersion: e.rulesPackageVersion,
      syntaxBinding: e.syntaxBinding,
      publicationDate: e.publicationDate,
      // ANT-STD-8: Official / AntiphonAdvisory — every shipped rule set is "Official" today.
      diagnosticSource: e.diagnosticSource,
    }])
);
for (const id of Object.keys(ruleXslts)) {
  if (!sdkMeta[id]) {
    console.error(`compile.mjs: rule-set-metadata.json has no current/Active entry for '${id}' — regenerate it via 'dotnet run -- compile'`);
    process.exit(1);
  }
}

// ANT-STD-7A (closes ANT-STD-3 fu-c): derived from CHANGELOG.md's topmost version header instead of
// a hardcoded literal. "## [X.Y.Z] - Unreleased" or "## [X.Y.Z] - YYYY-MM-DD" — whichever section is
// topmost is the current one (Keep a Changelog convention this repo already follows). An Unreleased
// topmost section renders as "X.Y.Z-unreleased" rather than inventing a release date.
const changelogText = await readFile(join(root, "..", "CHANGELOG.md"), "utf8");
const changelogHeaderMatch = changelogText.match(/^## \[(\d+\.\d+\.\d+)\] - (.+)$/m);
if (!changelogHeaderMatch) {
  console.error("compile.mjs: could not find a '## [X.Y.Z] - ...' header in CHANGELOG.md to derive bundleRelease from");
  process.exit(1);
}
const [, changelogVersion, changelogStatus] = changelogHeaderMatch;
const bundleRelease = changelogStatus.trim() === "Unreleased" ? `${changelogVersion}-unreleased` : changelogVersion;

const pin = (id, sdkId) => {
  const a = pins.artifacts[id];
  const m = sdkMeta[sdkId] ?? {};
  return {
    upstream: a.upstream, tag: a.tag, license: a.license, sha256: a.sha256,
    rulesPackageVersion: m.rulesPackageVersion ?? null,
    syntaxBinding: m.syntaxBinding ?? null,
    publicationDate: m.publicationDate ?? null,
    diagnosticSource: m.diagnosticSource ?? null,
  };
};

const versions = {
  bundleRelease,
  generated: new Date().toISOString(),
  tools: {
    "xslt3": await pkgVer("xslt3"),
    "saxon-js": await pkgVer("saxon-js"),
    "schxslt": pins.artifacts["schxslt"].tag + " (XSLT-only distribution; used to compile the Peppol .sch)",
  },
  ruleSets: {
    "cen-ubl": { label: "EN 16931 UBL (CEN/TC 434)", sef: "rules/cen-ubl.sef.json", ...pin("cen-ubl", "cen-ubl"), source: "official precompiled XSLT" },
    "cen-cii": { label: "EN 16931 CII (CEN/TC 434)", sef: "rules/cen-cii.sef.json", ...pin("cen-cii", "cen-cii"), source: "official precompiled XSLT" },
    "peppol-ubl": { label: "Peppol BIS Billing 3.0 (UBL)", sef: "rules/peppol-ubl.sef.json", ...pin("peppol-ubl-sch", "peppol-ubl"), source: "compiled locally from official .sch via SchXslt (no official XSLT is published)" },
    "xrechnung-ubl": { label: "XRechnung 3.0.2 UBL (KoSIT Schematron 2.6.0)", sef: "rules/xrechnung-ubl.sef.json", ...pin("xrechnung-schematron", "xrechnung-ubl"), source: "official compiled XSL" },
    "xrechnung-cii": { label: "XRechnung 3.0.2 CII (KoSIT Schematron 2.6.0)", sef: "rules/xrechnung-cii.sef.json", ...pin("xrechnung-schematron", "xrechnung-cii"), source: "official compiled XSL" },
    "peppol-cii": { label: "Peppol BIS Billing 3.0 (CII)", sef: "rules/peppol-cii.sef.json", ...pin("peppol-cii-sch", "peppol-cii"), source: "compiled locally from official .sch via SchXslt (no official XSLT is published)" },
  },
  formats: {
    "ubl-en16931": { label: "UBL — EN 16931", ruleSets: ["cen-ubl"] },
    "ubl-peppol": { label: "UBL — Peppol BIS Billing 3.0", ruleSets: ["cen-ubl", "peppol-ubl"] },
    "ubl-xrechnung": { label: "UBL — XRechnung 3.0.2", ruleSets: ["cen-ubl", "xrechnung-ubl"] },
    "cii-en16931": { label: "CII — EN 16931", ruleSets: ["cen-cii"] },
    "cii-xrechnung": { label: "CII — XRechnung 3.0.2", ruleSets: ["cen-cii", "xrechnung-cii"] },
    "cii-facturx": { label: "CII — Factur-X/ZUGFeRD (EN 16931 profile XML)", ruleSets: ["cen-cii"], note: "XML input only in v0 — PDF container extraction is on the backlog" },
    "cii-peppol": { label: "CII — Peppol BIS Billing 3.0", ruleSets: ["cen-cii", "peppol-cii"] },
  },
};
await writeFile(join(rulesDir, "versions.json"), JSON.stringify(versions, null, 2));
console.log("compile OK — SEFs + versions.json written to site/rules/");

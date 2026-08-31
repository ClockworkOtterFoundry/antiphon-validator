// Format auto-detection. Shared by the browser app and the Node smoke tests, so it
// works on raw XML text (no DOM dependency): root element namespace + the
// CustomizationID (UBL) / Guideline ID (CII) decide the format.

const UBL_INVOICE_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
const UBL_CREDITNOTE_NS = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2";
const CII_NS = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100";

/** Extract the root element's local name and namespace URI from raw XML text. */
function rootInfo(xml) {
  // first element tag that is not a declaration/comment/PI/doctype
  const m = xml.match(/<(?![?!])([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:"[^"]*"|'[^']*'|[^>"'])*)>/);
  if (!m) return null;
  const qname = m[1];
  const attrs = m[2] ?? "";
  const [prefix, local] = qname.includes(":") ? qname.split(":") : ["", qname];
  const nsAttr = prefix === "" ? /\sxmlns\s*=\s*["']([^"']*)["']/ : new RegExp(`\\sxmlns:${prefix}\\s*=\\s*["']([^"']*)["']`);
  const ns = attrs.match(nsAttr)?.[1] ?? "";
  return { local, ns };
}

/** First text content of an element with the given local name (prefix-agnostic). */
function elementText(xml, localName) {
  const m = xml.match(new RegExp(`<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([^<]*)</`));
  return m ? m[1].trim() : null;
}

/** CII: the guideline ID lives inside GuidelineSpecifiedDocumentContextParameter
 *  (the sibling BusinessProcess parameter also has a ram:ID — must not match that). */
function ciiGuidelineId(xml) {
  const block = xml.match(/<(?:[\w.-]+:)?GuidelineSpecifiedDocumentContextParameter\b[\s\S]*?<\/(?:[\w.-]+:)?GuidelineSpecifiedDocumentContextParameter>/);
  return block ? elementText(block[0], "ID") : null;
}

/**
 * Detect the invoice format of raw XML text.
 * Returns { format, confident, root, customization } — format is a key of
 * versions.json "formats" or null when unsupported; confident=false means the
 * syntax was recognized but the customization was not (UI offers manual override).
 */
export function detectFormat(xml) {
  const root = rootInfo(xml);
  if (!root) return { format: null, confident: false, root: null, customization: null };

  let syntax = null;
  if ((root.local === "Invoice" && root.ns === UBL_INVOICE_NS) || (root.local === "CreditNote" && root.ns === UBL_CREDITNOTE_NS)) {
    syntax = "ubl";
  } else if (root.local === "CrossIndustryInvoice" && root.ns === CII_NS) {
    syntax = "cii";
  }
  if (!syntax) return { format: null, confident: false, root, customization: null };

  // UBL: cbc:CustomizationID. CII: the guideline parameter's ram:ID.
  const customization = (syntax === "ubl" ? elementText(xml, "CustomizationID") : ciiGuidelineId(xml)) ?? "";
  const c = customization.toLowerCase();

  if (c.includes("xrechnung")) return { format: `${syntax}-xrechnung`, confident: true, root, customization };
  if (syntax === "ubl" && c.includes("peppol")) return { format: "ubl-peppol", confident: true, root, customization };
  if (syntax === "cii" && (c.includes("factur-x") || c.includes("zugferd"))) return { format: "cii-facturx", confident: true, root, customization };
  if (c.startsWith("urn:cen.eu:en16931:2017")) return { format: `${syntax}-en16931`, confident: true, root, customization };

  // Recognized syntax, unrecognized customization: default to the EN 16931 core
  // rule set for that syntax, flagged for manual override.
  return { format: `${syntax}-en16931`, confident: false, root, customization };
}

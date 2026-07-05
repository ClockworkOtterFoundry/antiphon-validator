// Plain-language explanations for common rule violations, shown beneath the rule's own
// official message. Curated by hand from the published rule texts (CEN EN 16931,
// Peppol BIS Billing 3.0, KoSIT XRechnung); paraphrased for people who don't live in the
// spec. Kept deliberately conservative: where a rule has subtle edge cases, we describe
// the common case and let the official message carry the precision.
// Grows over time — telemetry (rule-ID histogram) tells us which rules people actually hit.

export const EXPLANATIONS = {
  // --- EN 16931: mandatory elements (BR-*) ---
  "BR-01": "The invoice must say which specification it follows (the CustomizationID / specification identifier). Set it to the identifier of the profile you intend — EN 16931, Peppol, or XRechnung.",
  "BR-02": "The invoice must have an invoice number.",
  "BR-03": "The invoice must have an issue date.",
  "BR-04": "The invoice must have an invoice type code (e.g. 380 for a commercial invoice, 381 for a credit note).",
  "BR-05": "The invoice must state its currency (invoice currency code).",
  "BR-06": "The seller's name is missing.",
  "BR-07": "The buyer's name is missing.",
  "BR-08": "The seller's postal address is missing.",
  "BR-09": "The seller's postal address must include a country code.",
  "BR-10": "The buyer's postal address is missing.",
  "BR-11": "The buyer's postal address must include a country code.",
  "BR-12": "The sum of line net amounts is missing from the totals.",
  "BR-13": "The invoice total without VAT is missing.",
  "BR-14": "The invoice total with VAT is missing.",
  "BR-15": "The amount due for payment is missing.",
  "BR-16": "The invoice must have at least one invoice line.",

  // --- EN 16931: calculation consistency (BR-CO-*) ---
  "BR-CO-09": "VAT identifiers must start with the two-letter country prefix (e.g. DE123456789) — Greece uses EL.",
  "BR-CO-10": "The 'sum of line net amounts' in the totals doesn't equal what the lines actually add up to. Recompute the total from the lines.",
  "BR-CO-13": "Total without VAT must equal: sum of line net amounts − document-level allowances + document-level charges.",
  "BR-CO-14": "The invoice VAT total must equal the sum of the VAT amounts of all VAT breakdown categories.",
  "BR-CO-15": "Total with VAT must equal total without VAT plus the VAT total. One of the three amounts is inconsistent — commonly a rounding difference or a stale total after editing lines.",
  "BR-CO-16": "Amount due must equal: total with VAT − amount already paid + rounding amount.",
  "BR-CO-17": "Within each VAT breakdown, the VAT amount must be the taxable amount × the rate (standard rounding applies).",
  "BR-CO-25": "There's a positive amount due, so the invoice must carry either a payment due date or payment terms.",

  // --- EN 16931: code lists (BR-CL-*) ---
  "BR-CL-01": "The invoice type code isn't a valid UNTDID 1001 document type code (380 and 381 are the usual ones).",
  "BR-CL-03": "A currency code in the document isn't a valid ISO 4217 code.",
  "BR-CL-04": "The invoice currency code must be a valid ISO 4217 code (EUR, SEK, PLN … — three letters, uppercase).",
  "BR-CL-10": "An identifier's schemeID isn't on the official ISO 6523 list of identification schemes (e.g. 0088 for GLN, 0204 for Leitweg-ID).",
  "BR-CL-11": "A legal registration identifier's scheme must come from the ISO 6523 list.",
  "BR-CL-14": "A country code isn't a valid ISO 3166-1 alpha-2 code (two letters, e.g. DE, FR, BE).",
  "BR-CL-16": "The payment means code isn't a valid UNTDID 4461 code (e.g. 30 credit transfer, 58 SEPA credit transfer).",
  "BR-CL-17": "The VAT category code isn't on the allowed list (S, Z, E, AE, K, G, O, L, M).",
  "BR-CL-23": "The unit of measure isn't a valid UN/ECE Recommendation 20/21 code (e.g. C62 for 'piece', HUR for hours).",
  "BR-CL-25": "The electronic address (endpoint) scheme isn't on the EAS list (e.g. 0204, 9930, or an email scheme like EM).",

  // --- EN 16931: VAT breakdown examples ---
  "BR-S-08": "For the standard-rate VAT breakdown: its taxable amount must equal the sum of everything invoiced at that category (lines minus allowances plus charges in category S).",
  "BR-S-09": "The standard-rate VAT breakdown's VAT amount must equal its taxable amount × the standard rate.",

  // --- XRechnung (BR-DE-*) ---
  "BR-DE-1": "XRechnung requires payment instructions (a PaymentMeans group) — how the buyer is supposed to pay.",
  "BR-DE-2": "XRechnung requires a seller contact section (contact person or department).",
  "BR-DE-3": "XRechnung requires the seller's city in the postal address.",
  "BR-DE-4": "XRechnung requires the seller's post code.",
  "BR-DE-5": "XRechnung requires a seller contact telephone number.",
  "BR-DE-6": "XRechnung requires a seller contact email address.",
  "BR-DE-15": "XRechnung requires a BuyerReference. For invoices to German public-sector buyers this is the Leitweg-ID the buyer gave you — without it the invoice will be rejected.",
  "BR-DE-16": "XRechnung requires the seller's VAT identifier or tax number (at least one).",

  // --- Peppol BIS Billing 3.0 (PEPPOL-EN16931-R*) ---
  "PEPPOL-EN16931-R001": "Peppol invoices must state the business process (ProfileID), normally urn:fdc:peppol.eu:2017:poacc:billing:01:1.0.",
  "PEPPOL-EN16931-R002": "Peppol allows at most one note on document level.",
  "PEPPOL-EN16931-R003": "Peppol requires a buyer reference or a purchase order reference — at least one of the two.",
  "PEPPOL-EN16931-R004": "The CustomizationID must be exactly the Peppol billing one: urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0.",
  "PEPPOL-EN16931-R008": "The document contains an empty element. Peppol forbids sending elements with no content — remove them instead.",
  "PEPPOL-EN16931-R010": "Peppol requires the buyer's electronic address (EndpointID) — the address the invoice would be delivered to on the network.",
};

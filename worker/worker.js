// Antiphon validator backend — Cloudflare Worker (waitlist + content-free telemetry + lead form).
// Written in G3-2; DEPLOYED ONLY IN G3-3 (account setup is a user-present action).
// /lead added in ANT-V5.
//
// Privacy by design, matching the site's on-page statement:
//   - /waitlist stores exactly { email, note, ts } — no IP, no user agent.
//   - /event stores exactly the content-free fields the beacon sends — format, outcome,
//     counts, rule-ID histogram. Anything that smells like document content is rejected.
//   - /lead sends (never stores) exactly { name, contact, comments, ts } by email — no IP,
//     no user agent, same as the above.
//   - Exports are read-only and token-gated; they exist so Gate 4 evidence
//     (waitlist count, sessions-by-format, pass/fail ratio) can be evaluated.
//
// Bindings (wrangler.toml): KV namespaces WAITLIST and EVENTS; vars ALLOWED_ORIGIN,
// LEAD_FROM_ADDRESS; secrets EXPORT_TOKEN, RESEND_API_KEY, and LEAD_RECIPIENT_EMAIL (set
// via `wrangler secret put <name>` — the latter two specifically must never be
// wrangler.toml values, since this file is mirrored verbatim to the public
// antiphon-validator repo). /lead emails via Resend's REST API over a plain fetch(), not
// a Cloudflare-native binding — Cloudflare's own Email Service requires Workers Paid.

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/;
const RULE_ID_RE = /^[A-Za-z0-9._:-]{2,64}$/;
const FORMATS = new Set([
  "ubl-en16931", "ubl-peppol", "ubl-xrechnung",
  "cii-en16931", "cii-xrechnung", "cii-facturx",
  "unknown",
]);
const OUTCOMES = new Set(["pass", "fail", "malformed", "unsupported"]);

function cors(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
const json = (obj, status, env) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors(env) } });

/** True when a free-text field looks like markup/document content rather than a note. */
const smellsLikeContent = (s) => /[<>]/.test(s);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    if (request.method === "POST" && url.pathname === "/waitlist") return waitlist(request, env);
    if (request.method === "POST" && url.pathname === "/event") return event(request, env);
    if (request.method === "POST" && url.pathname === "/lead") return lead(request, env);
    if (request.method === "GET" && url.pathname === "/export/waitlist") return exportKv(request, env, env.WAITLIST, "email:");
    if (request.method === "GET" && url.pathname === "/export/events") return exportKv(request, env, env.EVENTS, "ev:");

    return json({ error: "not found" }, 404, env);
  },
};

async function waitlist(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400, env); }

  // Honeypot: bots fill every field. Pretend success, store nothing.
  if (typeof body.website === "string" && body.website !== "") return json({ ok: true }, 200, env);

  const email = String(body.email ?? "").trim().toLowerCase();
  const note = String(body.note ?? "").trim().slice(0, 300);
  if (!EMAIL_RE.test(email)) return json({ error: "invalid email" }, 400, env);
  if (smellsLikeContent(note)) return json({ error: "invalid note" }, 400, env);

  // Idempotent by email: repeat signups refresh the timestamp, never duplicate.
  await env.WAITLIST.put("email:" + email, JSON.stringify({ ts: new Date().toISOString(), note }));
  return json({ ok: true }, 200, env);
}

async function event(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400, env); }

  const format = String(body.format ?? "");
  const outcome = String(body.outcome ?? "");
  const fatals = Number(body.fatals);
  const warnings = Number(body.warnings);
  if (!FORMATS.has(format) || !OUTCOMES.has(outcome)) return json({ error: "invalid event" }, 400, env);
  if (!Number.isInteger(fatals) || !Number.isInteger(warnings) || fatals < 0 || warnings < 0 || fatals + warnings > 100000)
    return json({ error: "invalid counts" }, 400, env);

  const rules = {};
  const entries = Object.entries(body.rules ?? {}).slice(0, 50);
  for (const [id, count] of entries) {
    if (!RULE_ID_RE.test(id) || !Number.isInteger(count) || count < 1 || count > 100000)
      return json({ error: "invalid rules" }, 400, env);
    rules[id] = count;
  }

  // Append-only rows (no read-modify-write races); aggregation happens at export time.
  const key = `ev:${new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
  await env.EVENTS.put(key, JSON.stringify({ format, outcome, fatals, warnings, rules }), {
    expirationTtl: 60 * 60 * 24 * 400, // keep ~13 months; Gate 4 reads at 60 days
  });
  return new Response(null, { status: 204, headers: cors(env) });
}

async function lead(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400, env); }
  if (!body || typeof body !== "object") return json({ error: "invalid JSON" }, 400, env);

  // Honeypot: bots fill every field. Pretend success, send nothing. Coerce first — a
  // non-string honeypot value (e.g. an array) is exactly the kind of malformed input a bot
  // (or a hand-crafted request) sends, and must still be caught, not waved through.
  if (body.website != null && String(body.website).trim() !== "") return json({ ok: true }, 200, env);

  if (typeof body.name !== "string" || typeof body.contact !== "string") return json({ error: "invalid input" }, 400, env);
  if (body.comments !== undefined && body.comments !== null && typeof body.comments !== "string")
    return json({ error: "invalid input" }, 400, env);

  const name = body.name.trim().slice(0, 200);
  const contact = body.contact.trim().slice(0, 200);
  const comments = String(body.comments ?? "").trim().slice(0, 1000);
  if (!name) return json({ error: "invalid name" }, 400, env);
  if (!contact) return json({ error: "invalid contact" }, 400, env);
  if (smellsLikeContent(name) || smellsLikeContent(contact) || smellsLikeContent(comments))
    return json({ error: "invalid input" }, 400, env);

  // Body intentionally omits IP address and user agent — explicit product decision.
  const ts = new Date().toISOString();
  const text =
    `Name: ${name}\n` +
    `Contact: ${contact}\n` +
    `Comments: ${comments || "(none)"}\n` +
    `Sent: ${ts}\n`;

  // RESEND_API_KEY and LEAD_RECIPIENT_EMAIL are wrangler secrets, never wrangler.toml
  // values: this whole validator/ directory is mirrored verbatim to the PUBLIC
  // antiphon-validator repo by tools/sync-validator-public.sh, so neither may exist in
  // any tracked file. Set via `wrangler secret put <name>`. Cloudflare's own native
  // Email Service was tried first (ANT-V5) but requires the paid Workers plan — this
  // sends via Resend's REST API instead (resend.com, free tier, no base plan) over a
  // plain fetch(), which Workers can always do regardless of plan. `env.__fetch` is a
  // test-only injection seam (defaults to the real global `fetch`).
  if (!env.RESEND_API_KEY || !env.LEAD_RECIPIENT_EMAIL) return json({ error: "not configured" }, 502, env);

  const doFetch = env.__fetch || fetch;
  try {
    const res = await doFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.LEAD_FROM_ADDRESS || "leads@clockworkotterfoundry.com",
        to: [env.LEAD_RECIPIENT_EMAIL],
        subject: `ANTIPHON LEAD - ${ts.slice(0, 10)}`,
        text,
      }),
    });
    if (!res.ok) return json({ error: "send failed" }, 502, env);
  } catch {
    return json({ error: "send failed" }, 502, env);
  }

  return json({ ok: true }, 200, env);
}

async function exportKv(request, env, kv, prefix) {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.EXPORT_TOKEN || auth !== "Bearer " + env.EXPORT_TOKEN) return json({ error: "unauthorized" }, 401, env);

  const rows = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const value = await kv.get(k.name);
      rows.push({ key: k.name, ...(value ? JSON.parse(value) : {}) });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json({ count: rows.length, rows }, 200, env);
}

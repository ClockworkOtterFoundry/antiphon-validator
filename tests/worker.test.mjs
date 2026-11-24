// Unit tests for worker/worker.js — node:test, in-memory KV mock, no network.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/worker.js";

function kvMock() {
  const store = new Map();
  return {
    store,
    async put(k, v) { store.set(k, v); },
    async get(k) { return store.get(k) ?? null; },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

// /lead sends via a plain fetch() to Resend's REST API (no Cloudflare-native binding) —
// __fetch is worker.js's own test-only injection seam, standing in for the real global
// fetch so no test makes a real network call.
function resendFetchMock({ ok = true } = {}) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      return { ok, status: ok ? 200 : 500, async json() { return ok ? { id: "test-id" } : { message: "boom" }; } };
    },
  };
}

const makeEnv = () => {
  const resend = resendFetchMock();
  return {
    WAITLIST: kvMock(),
    EVENTS: kvMock(),
    EXPORT_TOKEN: "test-token",
    ALLOWED_ORIGIN: "https://example.test",
    RESEND_API_KEY: "test-resend-key",
    __fetch: resend.fetch,
    __resendCalls: resend.calls, // test-only convenience accessor, not read by worker.js
    LEAD_FROM_ADDRESS: "leads@example.test",
    LEAD_RECIPIENT_EMAIL: "recipient@example.test",
  };
};
const post = (path, body) =>
  new Request("https://api.test" + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("waitlist: stores email + note, idempotent, lowercased", async () => {
  const env = makeEnv();
  let res = await worker.fetch(post("/waitlist", { email: "Dev@Company.EU", note: "ERP invoicing" }), env);
  assert.equal(res.status, 200);
  res = await worker.fetch(post("/waitlist", { email: "dev@company.eu" }), env);
  assert.equal(res.status, 200);
  assert.equal(env.WAITLIST.store.size, 1);
  assert.match(env.WAITLIST.store.get("email:dev@company.eu"), /ERP invoicing|"note":""/);
});

test("waitlist: rejects invalid email", async () => {
  const env = makeEnv();
  const res = await worker.fetch(post("/waitlist", { email: "not-an-email" }), env);
  assert.equal(res.status, 400);
  assert.equal(env.WAITLIST.store.size, 0);
});

test("waitlist: honeypot gets fake OK, stores nothing", async () => {
  const env = makeEnv();
  const res = await worker.fetch(post("/waitlist", { email: "bot@spam.com", website: "http://spam" }), env);
  assert.equal(res.status, 200);
  assert.equal(env.WAITLIST.store.size, 0);
});

test("waitlist: rejects markup in note (content guard)", async () => {
  const env = makeEnv();
  const res = await worker.fetch(post("/waitlist", { email: "dev@co.eu", note: "<Invoice>secret</Invoice>" }), env);
  assert.equal(res.status, 400);
  assert.equal(env.WAITLIST.store.size, 0);
});

test("event: stores a valid content-free event", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    post("/event", { format: "ubl-xrechnung", outcome: "fail", fatals: 2, warnings: 1, rules: { "BR-DE-15": 1, "BR-CO-15": 1 } }),
    env
  );
  assert.equal(res.status, 204);
  assert.equal(env.EVENTS.store.size, 1);
  const row = JSON.parse([...env.EVENTS.store.values()][0]);
  assert.deepEqual(row.rules, { "BR-DE-15": 1, "BR-CO-15": 1 });
});

test("event: rejects unknown format and bad rule IDs", async () => {
  const env = makeEnv();
  let res = await worker.fetch(post("/event", { format: "pdf", outcome: "pass", fatals: 0, warnings: 0, rules: {} }), env);
  assert.equal(res.status, 400);
  res = await worker.fetch(
    post("/event", { format: "ubl-en16931", outcome: "pass", fatals: 0, warnings: 0, rules: { "<script>": 1 } }),
    env
  );
  assert.equal(res.status, 400);
  assert.equal(env.EVENTS.store.size, 0);
});

test("export: requires bearer token; returns stored rows", async () => {
  const env = makeEnv();
  await worker.fetch(post("/waitlist", { email: "dev@co.eu" }), env);
  let res = await worker.fetch(new Request("https://api.test/export/waitlist"), env);
  assert.equal(res.status, 401);
  res = await worker.fetch(
    new Request("https://api.test/export/waitlist", { headers: { authorization: "Bearer test-token" } }),
    env
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 1);
  assert.equal(body.rows[0].key, "email:dev@co.eu");
});

test("lead: sends an email with the submitted fields, no IP/user-agent", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    post("/lead", { name: "Dev Person", contact: "dev@company.eu", comments: "Need XRechnung CII generation." }),
    env
  );
  assert.equal(res.status, 200);
  assert.equal(env.__resendCalls.length, 1);
  const call = env.__resendCalls[0];
  assert.equal(call.url, "https://api.resend.com/emails");
  assert.equal(call.init.headers.Authorization, "Bearer test-resend-key");
  const msg = JSON.parse(call.init.body);
  assert.deepEqual(msg.to, ["recipient@example.test"]);
  assert.match(msg.subject, /^ANTIPHON LEAD - \d{4}-\d{2}-\d{2}$/);
  assert.match(msg.text, /Dev Person/);
  assert.match(msg.text, /dev@company\.eu/);
  assert.match(msg.text, /Need XRechnung CII generation\./);
  assert.doesNotMatch(msg.text.toLowerCase(), /user-agent|ip address|x-forwarded-for/);
});

test("lead: rejects missing name/contact", async () => {
  const env = makeEnv();
  let res = await worker.fetch(post("/lead", { name: "", contact: "dev@co.eu" }), env);
  assert.equal(res.status, 400);
  res = await worker.fetch(post("/lead", { name: "Dev", contact: "" }), env);
  assert.equal(res.status, 400);
  assert.equal(env.__resendCalls.length, 0);
});

test("lead: rejects markup in comments (content guard)", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    post("/lead", { name: "Dev", contact: "dev@co.eu", comments: "<Invoice>secret</Invoice>" }),
    env
  );
  assert.equal(res.status, 400);
  assert.equal(env.__resendCalls.length, 0);
});

test("lead: honeypot gets fake OK, sends nothing", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    post("/lead", { name: "Bot", contact: "bot@spam.com", website: "http://spam" }),
    env
  );
  assert.equal(res.status, 200);
  assert.equal(env.__resendCalls.length, 0);
});

test("lead: honeypot still catches a non-string value", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    post("/lead", { name: "Bot", contact: "bot@spam.com", website: ["spam"] }),
    env
  );
  assert.equal(res.status, 200);
  assert.equal(env.__resendCalls.length, 0);
});

test("lead: rejects a JSON null body instead of throwing", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    new Request("https://api.test/lead", { method: "POST", body: "null", headers: { "content-type": "application/json" } }),
    env
  );
  assert.equal(res.status, 400);
  assert.equal(env.__resendCalls.length, 0);
});

test("lead: rejects non-string name/contact instead of stringifying them", async () => {
  const env = makeEnv();
  const res = await worker.fetch(post("/lead", { name: {}, contact: {} }), env);
  assert.equal(res.status, 400);
  assert.equal(env.__resendCalls.length, 0);
});

test("lead: fails closed (502) when LEAD_RECIPIENT_EMAIL secret is unset, never sends", async () => {
  const env = makeEnv();
  delete env.LEAD_RECIPIENT_EMAIL;
  const res = await worker.fetch(post("/lead", { name: "Dev", contact: "dev@co.eu" }), env);
  assert.equal(res.status, 502);
  assert.equal(env.__resendCalls.length, 0);
});

test("lead: fails closed (502) when RESEND_API_KEY secret is unset, never sends", async () => {
  const env = makeEnv();
  delete env.RESEND_API_KEY;
  const res = await worker.fetch(post("/lead", { name: "Dev", contact: "dev@co.eu" }), env);
  assert.equal(res.status, 502);
  assert.equal(env.__resendCalls.length, 0);
});

test("lead: returns 502 when Resend's API responds with a non-ok status", async () => {
  const env = makeEnv();
  env.__fetch = resendFetchMock({ ok: false }).fetch;
  const res = await worker.fetch(post("/lead", { name: "Dev", contact: "dev@co.eu" }), env);
  assert.equal(res.status, 502);
});

test("CORS: preflight allowed, origin from env", async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request("https://api.test/waitlist", { method: "OPTIONS" }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://example.test");
});

// ---- /evaluation (ANT-V6) ----
const validEval = () => ({
  name: "Dev Person",
  email: "dev@company.eu",
  company: "Fabricated GmbH",
  country: "Germany",
  building: "An invoicing module for our ERP",
  formats: ["xrechnung", "peppol"],
  timeline: "exploring",
  target: "erp",
  source: "A search",
  website: "",
});
const evalPost = (body, headers = { "content-type": "application/json" }) =>
  new Request("https://api.test/evaluation", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });
const assertRejected = async (body, label, status = 400) => {
  const env = makeEnv();
  const res = await worker.fetch(evalPost(body), env);
  assert.equal(res.status, status, label);
  assert.equal(env.__resendCalls.length, 0, label + ": nothing sent");
  assert.deepEqual(await res.json(), { error: status === 413 ? "request too large" : "invalid request" }, label + ": generic error");
};

test("evaluation: valid request sends exactly one email with subject, reply-to and fields; stores nothing", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    evalPost(validEval(), { "content-type": "application/json", "user-agent": "SecretAgent/9", "x-forwarded-for": "203.0.113.9" }),
    env
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(env.__resendCalls.length, 1);
  const msg = JSON.parse(env.__resendCalls[0].init.body);
  assert.deepEqual(msg.to, ["recipient@example.test"]);
  assert.equal(msg.reply_to, "dev@company.eu");
  assert.equal(msg.subject, "Antiphon evaluation key request: Fabricated GmbH");
  for (const s of ["Dev Person", "dev@company.eu", "Fabricated GmbH", "Germany", "An invoicing module for our ERP", "xrechnung, peppol", "exploring", "erp", "A search"])
    assert.ok(msg.text.includes(s), "body has " + s);
  assert.match(msg.text, /Sent: \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  assert.doesNotMatch(JSON.stringify(msg) + JSON.stringify(env.__resendCalls[0].init.headers), /SecretAgent|203\.0\.113\.9|user-agent|x-forwarded-for/i);
  assert.equal(env.WAITLIST.store.size, 0);
  assert.equal(env.EVENTS.store.size, 0);
});

test("evaluation: optional fields may be absent", async () => {
  const env = makeEnv();
  const b = validEval();
  delete b.timeline; delete b.target; delete b.source; delete b.website;
  assert.equal((await worker.fetch(evalPost(b), env)).status, 200);
  assert.match(JSON.parse(env.__resendCalls[0].init.body).text, /Timeline: \(not given\)/);
});

test("evaluation: subject company is truncated to 80", async () => {
  const env = makeEnv();
  const b = validEval();
  b.company = "A".repeat(80) + "B".repeat(100);
  assert.equal((await worker.fetch(evalPost(b), env)).status, 200);
  assert.equal(JSON.parse(env.__resendCalls[0].init.body).subject, "Antiphon evaluation key request: " + "A".repeat(80));
});

test("evaluation: control characters (header injection attempts) are rejected in every text field", async () => {
  for (const f of ["name", "email", "company", "country", "building", "source"])
    for (const bad of ["x\r\nBcc: evil@example.test", "x\ny", "x\u0000y", "x y"]) {
      const b = validEval();
      b[f] = f === "email" ? "dev@company.eu" + bad : bad;
      await assertRejected(b, `${f} ${JSON.stringify(bad)}`);
    }
});

test("evaluation: each required field missing, empty or non-string is rejected", async () => {
  for (const f of ["name", "email", "company", "country", "building", "formats"]) {
    let b = validEval(); delete b[f]; await assertRejected(b, "missing " + f);
    b = validEval(); b[f] = f === "formats" ? [] : "   "; await assertRejected(b, "empty " + f);
    b = validEval(); b[f] = {}; await assertRejected(b, "object " + f);
  }
});

test("evaluation: over-length fields are rejected, at-limit accepted", async () => {
  const limits = { name: 200, company: 200, country: 100, building: 500, source: 200 };
  for (const [f, max] of Object.entries(limits)) {
    let b = validEval(); b[f] = "a".repeat(max);
    assert.equal((await worker.fetch(evalPost(b), makeEnv())).status, 200, f + " at limit ok");
    b = validEval(); b[f] = "a".repeat(max + 1); await assertRejected(b, "over " + f);
  }
  const b = validEval(); b.email = "a".repeat(250) + "@b.eu"; await assertRejected(b, "over email");
});

test("evaluation: bad email, markup, unknown enums, malformed JSON are rejected", async () => {
  for (const e of ["nope", "a@b", "a b@c.eu", "<a>@c.eu"]) { const b = validEval(); b.email = e; await assertRejected(b, "email " + e); }
  for (const f of ["name", "company", "country", "building", "source"]) {
    const b = validEval(); b[f] = "<Invoice>secret</Invoice>"; await assertRejected(b, "markup " + f);
  }
  let b = validEval(); b.formats = ["xrechnung", "cobol"]; await assertRejected(b, "unknown format");
  b = validEval(); b.formats = "xrechnung"; await assertRejected(b, "formats not array");
  b = validEval(); b.formats = [1]; await assertRejected(b, "format not string");
  b = validEval(); b.timeline = "yesterday"; await assertRejected(b, "unknown timeline");
  b = validEval(); b.target = "mainframe"; await assertRejected(b, "unknown target");
  await assertRejected("not json", "invalid JSON");
  await assertRejected("null", "null body");
  await assertRejected("[]", "array body");
});

test("evaluation: honeypot returns 200 and sends nothing (including non-string values)", async () => {
  for (const hp of ["http://spam", ["spam"], 1]) {
    const env = makeEnv();
    const res = await worker.fetch(evalPost({ ...validEval(), website: hp }), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(env.__resendCalls.length, 0);
  }
});

test("evaluation: wrong content type and oversized bodies are rejected", async () => {
  const env = makeEnv();
  let res = await worker.fetch(evalPost(validEval(), { "content-type": "text/plain" }), env);
  assert.equal(res.status, 415);
  res = await worker.fetch(evalPost(validEval(), {}), env);
  assert.equal(res.status, 415);
  assert.equal(env.__resendCalls.length, 0);
  await assertRejected({ ...validEval(), padding: "x".repeat(9000) }, "oversized body", 413);
  // multi-byte characters count as bytes, not characters
  await assertRejected({ ...validEval(), padding: "é".repeat(5000) }, "oversized multibyte body", 413);
});

test("evaluation: responses never echo input; CORS and method behave like /lead", async () => {
  const env = makeEnv();
  const b = validEval(); b.name = "<script>"; b.company = "ECHO-ME-NOT";
  const res = await worker.fetch(evalPost(b), env);
  const text = await res.text();
  assert.doesNotMatch(text, /script|ECHO-ME-NOT|dev@company/);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://example.test");
  const pre = await worker.fetch(new Request("https://api.test/evaluation", { method: "OPTIONS" }), env);
  assert.equal(pre.status, 204);
  const get = await worker.fetch(new Request("https://api.test/evaluation"), env);
  assert.equal(get.status, 404);
});

test("evaluation: fails closed (502) when secrets are unset or Resend fails; never stores", async () => {
  let env = makeEnv(); delete env.LEAD_RECIPIENT_EMAIL;
  assert.equal((await worker.fetch(evalPost(validEval()), env)).status, 502);
  assert.equal(env.__resendCalls.length, 0);
  env = makeEnv(); delete env.RESEND_API_KEY;
  assert.equal((await worker.fetch(evalPost(validEval()), env)).status, 502);
  env = makeEnv(); env.__fetch = async () => ({ ok: false, status: 500 });
  const res = await worker.fetch(evalPost(validEval()), env);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "send failed" });
  env.__fetch = async () => { throw new Error("net"); };
  assert.equal((await worker.fetch(evalPost(validEval()), env)).status, 502);
  assert.equal(env.WAITLIST.store.size + env.EVENTS.store.size, 0);
});

test("evaluation: hostile honeypot object does not throw", async () => {
  const env = makeEnv();
  const res = await worker.fetch(evalPost('{"website":{"toString":null}}'), env);
  assert.equal(res.status, 200);
  assert.equal(env.__resendCalls.length, 0);
});

test("evaluation: oversized streamed body without Content-Length stops reading at the cap", async () => {
  const env = makeEnv();
  let pulled = 0;
  const stream = new ReadableStream({
    pull(c) { pulled++; c.enqueue(new Uint8Array(1024).fill(32)); if (pulled > 100) c.close(); },
  });
  const req = new Request("https://api.test/evaluation", { method: "POST", body: stream, duplex: "half", headers: { "content-type": "application/json" } });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 413);
  assert.ok(pulled < 40, "stopped early, pulled " + pulled);
  assert.equal(env.__resendCalls.length, 0);
});

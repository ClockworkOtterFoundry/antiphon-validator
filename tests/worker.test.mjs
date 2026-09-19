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

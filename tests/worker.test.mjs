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

const makeEnv = () => ({ WAITLIST: kvMock(), EVENTS: kvMock(), EXPORT_TOKEN: "test-token", ALLOWED_ORIGIN: "https://example.test" });
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

test("CORS: preflight allowed, origin from env", async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request("https://api.test/waitlist", { method: "OPTIONS" }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://example.test");
});

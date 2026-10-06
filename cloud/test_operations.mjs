import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { buildSlackReport, createOperations, reportWindow, sendSlackReport } from "./operations.mjs";
import { createApplication } from "../service/server.mjs";

const beforeMidnight = Date.parse("2026-10-05T14:59:59.999Z");
const afterMidnight = beforeMidnight + 1;
assert.equal(reportWindow(beforeMidnight).date, "2026-10-04");
assert.deepEqual(reportWindow(afterMidnight), { date: "2026-10-05", start: "2026-10-04T15:00:00.000Z",
  end: "2026-10-05T15:00:00.000Z", previousStart: "2026-10-03T15:00:00.000Z" });
assert.equal(reportWindow(Date.parse("2027-01-01T15:01:00Z")).date, "2027-01-01");

const snapshot = {
  date: "2026-10-05", users: { active: 12, previous: 9, new: 2, total: 45, trackingStarted: "2026-10-01T00:00:00Z", partial: false },
  jobs: { total: 5, previous: 4, done: 3, partial: 1, failed: 1, interrupted: 0, running: 0 },
  periods: { saved: 22, exists: 2, overlap: 1, unknown: 1, not_attempted: 2 },
  database: { bytes: 26 * 1024 * 1024, writable: true },
  recentRuns: Array.from({ length: 4 }, () => ({ kind: "health", status: "success" })),
  latestRuns: [{ kind: "holidays", status: "success", attempts: 2 },
    { kind: "report", status: "success", finished_at: "2026-10-04T15:20:00Z" },
    { kind: "health", status: "success", started_at: "2026-10-05T12:20:00Z" }],
  holidayUpdatedAt: "2026-10-04T18:08:00Z",
};
const options = { now: afterMidnight + 600_000, origin: "https://overnight.example" };
const healthy = { web: true, database: true, responseMs: 180 };
const message = buildSlackReport(snapshot, healthy, options);
assert.equal(message.blocks.filter(block => block.fields?.length === 2).length, 2);
assert.doesNotMatch(JSON.stringify(message), /·|studentId|password|account_key|token/);
assert.match(message.text, /로그인 12명 \(전일 \+3\)/);
assert.match(message.text, /접수 완료 22 \/ 기존 신청 제외 3/);
assert.match(message.text, /확인 필요 1 \/ 미처리 2/);
assert.match(message.text, /재시도 후 성공/);
assert.doesNotMatch(message.blocks[1].text.text, /공휴일/); // Recovered retries are not unresolved incidents.
const unavailable = buildSlackReport(null, { web: false, database: false, responseMs: null }, options);
assert.match(unavailable.text, /사용자\n미집계/);
assert.doesNotMatch(unavailable.text, /로그인 0|DB 정상|0\/0 성공/);
assert.match(buildSlackReport({ ...snapshot, database: { ...snapshot.database, writable: false } }, healthy, options).text, /DB 오류/);
const initial = buildSlackReport({ ...snapshot, users: { ...snapshot.users, active: null, previous: null } }, healthy, options);
assert.match(initial.text, /로그인 미집계/);
assert.doesNotMatch(initial.text, /미집계.*전일/);
const crons = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url))).crons;
assert.equal(crons.filter(cron => cron.path === "/api/cron/report").length, 1);
assert.equal(crons.find(cron => cron.path === "/api/cron/report").schedule, "0 15 * * *");
assert.equal(crons.filter(cron => cron.path === "/api/cron/health").length, 4);
assert.ok(crons.every(cron => /^0 \d{1,2} \* \* \*$/.test(cron.schedule)));

const requests = [];
let reserved = false;
await sendSlackReport(message, { token: "fixture-bot-token", userId: "U123", beforeSend: async () => { reserved = true; },
  fetchImpl: async (url, request) => {
    requests.push({ url, body: JSON.parse(request.body) });
    assert.equal(request.headers.Authorization, "Bearer fixture-bot-token");
    if (url.endsWith("conversations.open")) return Response.json({ ok: true, channel: { id: "D123" } });
    assert.equal(reserved, true);
    return Response.json({ ok: true, ts: "123.456" });
  } });
assert.equal(requests.length, 2);
assert.equal(requests[1].body.channel, "D123");
assert.equal(requests[1].body.unfurl_links, false);
await assert.rejects(sendSlackReport(message, { token: "", userId: "U123" }), error => error.status === 503);
await assert.rejects(sendSlackReport(message, { token: "fixture-bot-token", userId: "U123",
  fetchImpl: async () => Response.json({ ok: false, error: "invalid_auth" }) }), error => !error.uncertain);

function fixtureStore() {
  const runs = new Map();
  return { runs, withBusy: async (_key, task) => task(), cleanupOperations: async () => {}, operationsSnapshot: async () => snapshot,
    startOperation: async (kind, key) => {
      const existing = runs.get(kind + key);
      if (existing && existing.status !== "failed") return null;
      const run = { status: "running", attempts: (existing?.attempts || 0) + 1 };
      runs.set(kind + key, run); return run;
    },
    finishOperation: async (kind, key, status) => { runs.get(kind + key).status = status; },
  };
}
const probeFetch = async url => url.endsWith("/api/health") ? Response.json({ ok: true }) : new Response("fixture", { headers: { "Content-Type": "text/html" } });
let sent = 0;
const store = fixtureStore();
const ops = createOperations({ store, origin: options.origin, now: () => options.now, fetchImpl: probeFetch,
  send: async (_message, { beforeSend }) => { await beforeSend(); sent++; return { ts: "1", channel: "D123" }; },
  holidaySync: async () => ({ count: 46 }), sleep: async () => {},
});
await ops.report();
await ops.report();
assert.equal(sent, 1);
assert.equal(store.runs.get("report2026-10-05").status, "success");
await ops.health();
assert.equal(store.runs.size, 2);
await ops.holidays();
await ops.holidays();
assert.equal(store.runs.get("holidays2026-10-06").attempts, 1);

const uncertainStore = fixtureStore();
let postCalls = 0;
const uncertain = createOperations({ store: uncertainStore, origin: options.origin, now: () => options.now,
  token: "fixture-bot-token", userId: "U123", fetchImpl: async url => {
    if (url.endsWith("conversations.open")) return Response.json({ ok: true, channel: { id: "D123" } });
    if (url.endsWith("chat.postMessage")) { postCalls++; throw new Error("fixture network timeout after delivery"); }
    return probeFetch(url);
  } });
await assert.rejects(uncertain.report(), error => error.status === 503);
assert.equal(uncertainStore.runs.get("report2026-10-05").status, "unknown");
await uncertain.report();
assert.equal(postCalls, 1);

const delayedStore = fixtureStore();
let opens = 0, delayedPosts = 0;
const delayed = createOperations({ store: delayedStore, origin: options.origin, now: () => options.now,
  token: "fixture-bot-token", userId: "U123", sleep: async () => {}, fetchImpl: async url => {
    if (url.endsWith("conversations.open")) {
      if (!opens++) throw new Error("fixture temporary preparation failure");
      return Response.json({ ok: true, channel: { id: "D123" } });
    }
    if (url.endsWith("chat.postMessage")) { delayedPosts++; return Response.json({ ok: true, ts: "1.2" }); }
    return probeFetch(url);
  } });
await delayed.report();
assert.equal(delayedPosts, 1);
assert.equal(delayedStore.runs.get("report2026-10-05").attempts, 2);

const offlineStore = fixtureStore();
offlineStore.withBusy = async () => { throw new Error("fixture DB outage"); };
const offline = createOperations({ store: offlineStore, origin: options.origin, now: () => options.now,
  sleep: async () => {},
  send: async () => { throw new Error("must not send without a durable reservation"); } });
await assert.rejects(offline.report(), error => error.status === 503);

const retryStore = fixtureStore();
let holidayAttempts = 0;
const retry = createOperations({ store: retryStore, origin: options.origin, now: () => options.now,
  holidaySync: async () => { if (!holidayAttempts++) throw new Error("fixture temporary failure"); return { count: 46 }; }, sleep: async () => {} });
await retry.holidays();
assert.equal(retryStore.runs.get("holidays2026-10-06").attempts, 2);
assert.equal(retryStore.runs.get("holidays2026-10-06").status, "success");

// Real loopback routes verify Cron authentication before any operational work.
let called = 0;
const secret = "fixture-cron-secret-".repeat(3);
const app = createApplication({ store: {}, publicOrigin: options.origin, cronSecret: secret, logger: () => {},
  operations: Object.fromEntries(["health", "holidays", "report"].map(kind => [kind, async () => { called++; return { ok: true }; }])) });
const server = createServer(app.handler);
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  for (const path of ["health", "holidays", "report"]) {
    const url = `http://127.0.0.1:${server.address().port}/api/cron/${path}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal((await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${secret}` } })).status, 404);
  }
  assert.equal(called, 3);
} finally { await new Promise(resolve => server.close(resolve)); }
console.log("operations checks passed: KST day boundaries, compact private report, one daily delivery, uncertain-send suppression, retry recovery and Cron authentication");

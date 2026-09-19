import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApplication } from "./server.mjs";
import { CredentialStore } from "./store.mjs";
import { PortalError } from "./portal.mjs";

// Real loopback sockets, disposable credentials, and a stub portal only.
const directory = mkdtempSync(join(tmpdir(), "overnight-http-test-"));
const store = new CredentialStore(directory);
const owner = store.create({ studentId: "httpowner1", password: "fixture-password" });
const other = store.create({ studentId: "httpother2", password: "fixture-password" });
const publicOrigin = "https://overnight.example";
const setupToken = "fixture-http-setup-token-".repeat(3);
const logs = [];
let clock = new Date();
let loginCalls = 0;
let batchCalls = 0;
let releaseBatch;
let optionsForBatch;
const batchGate = new Promise(resolve => { releaseBatch = resolve; });
let singleCalls = 0;
let releaseSingle;
const singleGate = new Promise(resolve => { releaseSingle = resolve; });
const app = createApplication({
  store, publicOrigin, setupToken, now: () => clock, logger: entry => logs.push(entry),
  portalFactory: credentials => ({
    login: async () => {
      loginCalls++;
      if (credentials.password !== "fixture-password") throw new PortalError("fixture authentication refused");
    },
    apply: async (_start, _end, { dryRun = false } = {}) => {
      if (dryRun) return { status: "available", message: "fixture-available" };
      singleCalls++;
      await singleGate;
      return { status: "saved", message: "fixture-single-done" };
    },
    applications: async () => [{ start: "2026-09-18", end: "2026-09-20", active: true }],
    applyMany: async (dates, options) => {
      batchCalls++;
      optionsForBatch = options;
      await options.onProgress({ message: "fixture-processing", results: dates.map(date => ({ date, status: "not_attempted" })) });
      await batchGate;
      return { status: options.shouldStop?.() ? "cancelled" : "batch", message: "fixture-done", results: dates.map(date => ({ date, status: "not_attempted" })) };
    },
  }),
});
const server = createServer(app.handler);

function call(path, { method = "GET", token, body, raw, headers = {} } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port: server.address().port, path, method,
      headers: {
        ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
        ...(token ? { Cookie: `overnight_session=${token}` } : {}), ...headers,
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try {
          resolve({ status: response.statusCode, headers: response.headers, body: response.headers["content-type"]?.includes("application/json") ? JSON.parse(text) : text });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("HTTP test timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const health = await call("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.headers["cache-control"], "no-store");
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  assert.match(health.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.ok(health.headers["x-request-id"]);
  const html = await call("/");
  assert.equal(html.status, 200);
  assert.match(html.body, /id="login-form"/);
  assert.match(html.body, /id="calendar-grid"/);
  assert.match(html.body, /학기 퇴관까지/);
  assert.doesNotMatch(html.body, /저장된 계정 다시 연결|계정 연결/);
  assert.equal((await call("/app.js")).status, 200);
  assert.equal((await call("/api/health", { headers: { Host: "evil.example" } })).status, 403);

  const previewRequest = { method: "POST", token: owner.token, body: { kind: "daily-month" } };
  for (const headers of [
    { Origin: "https://evil.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) assert.equal((await call("/api/batch/preview", { ...previewRequest, headers })).status, 403);
  for (const raw of ["null", "[]", '"text"', "{"]) {
    assert.equal((await call("/api/batch/preview", { ...previewRequest, raw })).status, 400);
  }
  assert.equal((await call("/api/batch/preview", { ...previewRequest, headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await call("/api/batch/preview", { ...previewRequest, raw: "x".repeat(16_385) })).status, 413);
  assert.equal((await call("/api/batch/preview", { ...previewRequest, token: undefined })).status, 401);

  const connected = await call("/api/login", {
    method: "POST", body: { studentId: "httpnew3", password: "fixture-password" },
    headers: { Host: "overnight.example", Origin: publicOrigin, "X-Setup-Token": setupToken },
  });
  assert.equal(connected.status, 201);
  const cookie = connected.headers["set-cookie"]?.[0];
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Secure/);
  const session = await call("/api/session", { headers: { Host: "overnight.example", Origin: publicOrigin, Cookie: cookie.split(";")[0] } });
  assert.equal(session.body.connected, true);
  assert.equal("credentials" in session.body, false);
  assert.equal(session.body.horizons.find(item => item.id === "semester").end, "2026-12-23");
  assert.deepEqual((await call("/api/applications", { token: owner.token })).body.applications, [
    { start: "2026-09-18", end: "2026-09-20", active: true },
  ]);
  assert.equal((await call("/api/applications", { token: other.token })).status, 200);
  assert.equal((await call("/api/applications")).status, 401);

  const preview = await call("/api/batch/preview", previewRequest);
  assert.equal(preview.status, 200);
  assert.ok(preview.body.dates.length >= 29);
  assert.equal(batchCalls, 0);
  assert.equal((await call("/api/batch/apply", { method: "POST", token: other.token, body: { plan: preview.body.plan } })).status, 403);
  const accepted = await call("/api/batch/apply", { method: "POST", token: owner.token, body: { plan: preview.body.plan } });
  assert.equal(accepted.status, 202);
  const jobId = accepted.body.job.id;
  assert.equal((await call(`/api/batch/job?id=${jobId}`, { token: other.token })).body.job, null);
  assert.equal((await call(`/api/batch/job?id=${jobId}`, { token: owner.token })).body.job.status, "running");
  assert.equal((await call("/api/batch/apply", { method: "POST", token: owner.token, body: { plan: preview.body.plan } })).body.job.id, jobId);
  assert.equal(batchCalls, 1);
  assert.equal((await call("/api/account", { method: "DELETE", token: owner.token })).status, 409);
  assert.ok(optionsForBatch);
  assert.equal((await call("/api/batch/cancel", { method: "POST", token: other.token, body: { id: jobId } })).status, 404);
  const cancelled = await call("/api/batch/cancel", { method: "POST", token: owner.token, body: { id: jobId } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.job.cancelRequested, true);
  assert.equal(optionsForBatch.shouldStop(), true);
  releaseBatch();
  await app.drain();
  const stoppedJob = (await call(`/api/batch/job?id=${jobId}`, { token: owner.token })).body.job;
  assert.equal(stoppedJob.status, "done");
  assert.equal(stoppedJob.outcome, "cancelled");

  const singleBody = { id: randomUUID(), start: preview.body.dates[0], end: preview.body.dates[1] };
  assert.equal((await call("/api/check", { method: "POST", token: owner.token, body: singleBody })).body.status, "available");
  assert.equal(singleCalls, 0);
  assert.equal((await call("/api/apply", { method: "POST", token: owner.token, body: { ...singleBody, id: "invalid-id" } })).status, 400);
  const acceptedSingle = await call("/api/apply", { method: "POST", token: owner.token, body: singleBody });
  assert.equal(acceptedSingle.status, 202);
  assert.equal(acceptedSingle.body.job.id, singleBody.id);
  assert.equal((await call("/api/apply", { method: "POST", token: owner.token, body: singleBody })).body.job.id, singleBody.id);
  assert.equal(singleCalls, 1);
  assert.equal((await call(`/api/batch/job?id=${singleBody.id}`, { token: other.token })).body.job, null);
  releaseSingle();
  await app.drain();
  const finishedSingle = (await call(`/api/batch/job?id=${singleBody.id}`, { token: owner.token })).body.job;
  assert.equal(finishedSingle.status, "done");
  assert.equal(finishedSingle.outcome, "saved");
  assert.equal(finishedSingle.results[0].end, singleBody.end.replaceAll("-", ""));
  assert.equal((await call("/api/apply", { method: "POST", token: owner.token, body: singleBody })).body.job.status, "done");
  assert.equal(singleCalls, 1);

  // Multiple users behind one local tunnel must not consume each other's API quota.
  clock = new Date(clock.getTime() + 60_001);
  for (let index = 0; index < 120; index++) assert.equal((await call("/api/session", { token: owner.token })).status, 200);
  const limited = await call("/api/session", { token: owner.token });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal((await call("/api/session", { token: other.token })).status, 200);

  clock = new Date(clock.getTime() + 60_001);
  const profileCount = store.database.prepare("SELECT COUNT(*) AS count FROM profiles").get().count;
  const rejectedReconnect = await call("/api/reconnect", { method: "POST", body: { studentId: "httpowner1", password: "wrong-fixture-password" } });
  assert.equal(rejectedReconnect.status, 502);
  assert.equal(store.find(owner.token, { credentials: false }).id, owner.id);
  const beforeReconnectLogins = loginCalls;
  const reconnected = await call("/api/login", { method: "POST", body: { studentId: "httpowner1", password: "fixture-password" } });
  assert.equal(reconnected.status, 201);
  assert.equal(loginCalls, beforeReconnectLogins + 1);
  const renewedCookie = reconnected.headers["set-cookie"][0];
  const renewedToken = renewedCookie.split(";")[0].slice("overnight_session=".length);
  assert.match(renewedCookie, /; Secure/);
  assert.equal(store.find(renewedToken, { credentials: false }).id, owner.id);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM profiles").get().count, profileCount);
  assert.equal((await call("/api/session", { token: owner.token })).body.connected, false);
  const recoveredHistory = (await call("/api/batch/history", { token: renewedToken })).body.jobs;
  assert.equal(recoveredHistory.length, 2);
  assert.ok(recoveredHistory.some(job => job.id === jobId));
  assert.ok(recoveredHistory.some(job => job.id === singleBody.id));
  const logout = await call("/api/logout", { method: "POST", token: renewedToken, body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers["set-cookie"][0], /Max-Age=0/);
  assert.equal((await call("/api/session", { token: renewedToken })).body.connected, false);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM profiles").get().count, profileCount);
  assert.equal(store.jobs(owner.id).length, 2);
  assert.equal((await call("/api/reconnect", { method: "POST", body: { studentId: "httpowner1", password: "fixture-password" } })).status, 201);
  assert.equal(logs.some(entry => /fixture-password|fixture-http-setup-token|overnight_session/.test(JSON.stringify(entry))), false);
  console.log("real HTTP checks passed: socket responses, request guards, secure cookies, owned/cancelled jobs, durable single requests, replay protection, per-profile rate isolation, reconnect/logout preservation");
} finally {
  releaseBatch();
  releaseSingle();
  await app.drain();
  await new Promise(resolve => server.close(resolve));
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

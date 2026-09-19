import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { createApplication } from "../service/server.mjs";
import { CredentialStore } from "../service/store.mjs";
import { HttpError } from "../service/errors.mjs";
import { PortalError } from "../service/portal.mjs";
import { dispatchJob } from "./dispatch.mjs";

// Real HTTP and deferred async methods, but only a disposable local DB and stub school.
// This checks the shared HTTP contract, not PostgreSQL's SQL or distributed locking.
const directory = mkdtempSync(join(tmpdir(), "overnight-cloud-http-"));
const database = new CredentialStore(directory);
const store = { key: database.key };
const profiles = new Map();
const jobOwners = new Map();
const rates = new Map();
const locks = new Set();
const leases = new Map();
const invoked = new Set();
const logs = [];
const starts = [];
const servers = [];
let clock = new Date();
let failedStart = false;
let unhealthy = false;
let beforeCancel;
let checkGate;
let checkEntered;
const publicOrigin = "https://overnight-cloud.example";
const password = "fixture-only-cloud-password";

for (const name of ["find", "claim", "reconnect", "setupUsed", "job", "jobs", "updateJob"]) {
  store[name] = async (...args) => {
    await turn();
    invoked.add(name);
    return database[name](...args);
  };
}
store.health = async () => {
  await turn();
  invoked.add("health");
  if (unhealthy) throw new Error("fixture-only-secret-database-url");
  return true;
};
store.create = async (...args) => {
  await turn();
  invoked.add("create");
  const profile = database.create(...args);
  profiles.set(profile.id, profile);
  return profile;
};
store.createJob = async (id, profileId, dates) => {
  await turn();
  invoked.add("createJob");
  try { database.createJob(id, profileId, dates.map(value => typeof value === "string" ? value : value.date)); }
  catch { throw new HttpError(409, "이미 처리 중인 신청이 있습니다."); }
  jobOwners.set(id, profileId);
  const job = database.job(profileId, id);
  job.results = dates.map(value => ({ ...(typeof value === "string" ? { date: value } : value), status: "not_attempted" }));
  database.updateJob(id, "running", job);
};
store.delete = async id => {
  await turn();
  invoked.add("delete");
  if (database.jobs(id).some(job => job.status === "running")) throw new HttpError(409, "신청을 처리 중입니다.");
  return database.delete(id);
};
store.withBusy = async (key, task) => {
  await turn();
  invoked.add("withBusy");
  if (locks.has(key)) throw new HttpError(409, "이 계정의 요청을 처리 중입니다.");
  locks.add(key);
  try { return await task(); }
  finally { locks.delete(key); }
};
store.consumeRate = async (key, maximum, window) => {
  await turn();
  invoked.add("consumeRate");
  if (!rates.has(key) || rates.get(key).until <= clock.getTime()) rates.set(key, { count: 0, until: clock.getTime() + window });
  if (++rates.get(key).count > maximum) throw new HttpError(429, "잠시 후 다시 시도해 주세요.");
};
store.cancelJob = async (profileId, id) => {
  await turn();
  invoked.add("cancelJob");
  beforeCancel?.();
  beforeCancel = undefined;
  const job = database.job(profileId, id);
  if (job?.status === "running") database.updateJob(id, "running", { ...job, cancelRequested: true });
};
store.claimDispatch = async id => {
  await turn();
  invoked.add("claimDispatch");
  const job = database.job(jobOwners.get(id), id);
  if (job?.status !== "running" || (leases.get(id) || 0) > clock.getTime()) return false;
  leases.set(id, clock.getTime() + 60_000);
  return true;
};
store.releaseDispatch = async id => {
  await turn();
  invoked.add("releaseDispatch");
  leases.delete(id);
};
const enqueue = id => dispatchJob(store, id, async opaqueId => {
  starts.push(opaqueId);
  if (failedStart) throw new Error("fixture-only-secret-workflow-error");
});

async function serve(options = {}) {
  const app = createApplication({
    store, publicOrigin, publicRegistration: true, now: () => clock, enqueue,
    logger: entry => logs.push(entry),
    // In production only the Vercel adapter supplies the platform-authenticated IP.
    clientAddress: () => "192.0.2.10",
    portalFactory: credentials => ({
      login: async () => {
        await turn();
        if (credentials.password !== password) throw new PortalError("fixture login refused");
      },
      apply: async (_start, _end, { dryRun }) => {
        assert.equal(dryRun, true, "a cloud HTTP request must never save at school");
        checkEntered?.();
        await checkGate;
        return { status: "available", message: "fixture available" };
      },
      applications: async () => [{ start: "2026-09-21", end: "2026-09-21", active: true }],
      applyMany: async () => { throw new Error("HTTP must only enqueue durable work"); },
    }),
    ...options,
  });
  const server = createServer(app.handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return async (path, { method = "GET", token, body, headers = {} } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port: server.address().port, path, method,
        headers: {
          Host: "overnight-cloud.example", Origin: publicOrigin,
          ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
          ...(token ? { Cookie: `overnight_session=${token}` } : {}), ...headers,
        },
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (error) { reject(error); }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error("cloud HTTP test timed out")));
      req.on("error", reject);
      req.end(payload);
    });
  };
}

function tokenOf(response) {
  const cookie = response.headers["set-cookie"][0];
  assert.match(cookie, /; HttpOnly; SameSite=Strict; Path=\//);
  assert.match(cookie, /; Secure/);
  return cookie.split(";")[0].slice("overnight_session=".length);
}

function finish(id) {
  const job = database.job(jobOwners.get(id), id);
  database.updateJob(id, "done", { ...job, outcome: "saved", results: job.results.map(row => ({ ...row, status: "saved" })) });
}

try {
  const call = await serve();
  const otherInstance = await serve();
  const privateRegistration = await serve({ publicRegistration: false });
  const staleSetupToken = "fixture-stale-setup-token-".repeat(3);
  const publicRegistrationWithStaleToken = await serve({ setupToken: staleSetupToken });
  assert.equal((await call("/api/health")).status, 200);
  unhealthy = true;
  const unavailable = await call("/api/health");
  assert.equal(unavailable.status, 500);
  assert.doesNotMatch(JSON.stringify(unavailable.body), /secret-database/);
  unhealthy = false;
  const credentials = { studentId: "cloudowner1", password };
  assert.equal((await privateRegistration("/api/register", { method: "POST", body: credentials })).status, 403);
  assert.equal((await call("/api/register", { method: "POST", body: { ...credentials, password: "wrong" } })).status, 502);
  assert.equal(profiles.size, 0);
  assert.equal((await publicRegistrationWithStaleToken("/api/register", {
    method: "POST", body: { studentId: "cloudpublic3", password },
  })).status, 201, "public registration must ignore a leftover one-time setup token");
  assert.equal(database.setupUsed(staleSetupToken), false);
  const registered = await call("/api/register", { method: "POST", body: credentials });
  assert.equal(registered.status, 201);
  const token = tokenOf(registered);
  const ownerId = database.find(token).id;
  const second = await otherInstance("/api/register", { method: "POST", body: { studentId: "cloudother2", password } });
  assert.equal(second.status, 201, "public registration is not a one-time setup link");
  const otherToken = tokenOf(second);
  const session = await otherInstance("/api/session", { token });
  assert.equal(session.body.connected, true);
  assert.equal((await call("/api/session")).body.connected, false);
  assert.deepEqual((await call("/api/applications", { token })).body.applications, [
    { start: "2026-09-21", end: "2026-09-21", active: true },
  ]);
  assert.equal((await call("/api/applications", { token: otherToken })).status, 200);
  assert.equal((await call("/api/applications")).status, 401);
  const preview = await call("/api/batch/preview", { method: "POST", token, body: { kind: "daily-month" } });
  assert.equal(preview.status, 200);
  const single = { id: randomUUID(), start: preview.body.dates[0], end: preview.body.dates[1] };

  // DB commit survives queue outage; replay or polling can retry dispatch without a new job.
  failedStart = true;
  const failed = await call("/api/apply", { method: "POST", token, body: single });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(failed.body), /secret-workflow/);
  assert.equal(database.job(ownerId, single.id).status, "running");
  assert.equal(database.job(ownerId, single.id).results[0].end, single.end.replaceAll("-", ""));
  assert.equal(leases.has(single.id), false, "failed queue start must release its dispatch lease");
  failedStart = false;
  const polled = await otherInstance(`/api/batch/job?id=${single.id}`, { token });
  assert.equal(polled.status, 200);
  assert.equal(polled.body.job.id, single.id);
  assert.deepEqual(starts, [single.id, single.id], "queue arguments contain only the opaque job id");
  const beforeReplay = starts.length;
  const replays = await Promise.all([
    call("/api/apply", { method: "POST", token, body: single }),
    otherInstance("/api/apply", { method: "POST", token, body: single }),
    call(`/api/batch/job?id=${single.id}`, { token }),
  ]);
  assert.ok(replays.every(response => response.status === 200));
  const differentPeriod = await call("/api/apply", { method: "POST", token, body: { ...single, end: preview.body.dates[2] } });
  assert.equal(differentPeriod.status, 409, "an idempotency key cannot silently refer to a different date range");
  assert.equal(starts.length, beforeReplay, "a live dispatch lease suppresses duplicate starts across HTTP instances");
  assert.equal(database.jobs(ownerId).length, 1);
  assert.equal((await call(`/api/batch/job?id=${single.id}`, { token: otherToken })).body.job, null);
  assert.equal((await call("/api/batch/cancel", { method: "POST", token: otherToken, body: { id: single.id } })).status, 404);
  assert.equal((await call("/api/account", { method: "DELETE", token })).status, 409);

  // A worker finishing after the handler's initial read must not be rewritten as running.
  beforeCancel = () => finish(single.id);
  const cancelRace = await call("/api/batch/cancel", { method: "POST", token, body: { id: single.id } });
  assert.equal(cancelRace.status, 200);
  assert.equal(cancelRace.body.job.status, "done");
  assert.equal(cancelRace.body.job.outcome, "saved");
  assert.equal(cancelRace.body.job.cancelRequested, undefined);
  await otherInstance("/api/apply", { method: "POST", token, body: single });
  assert.equal(starts.length, beforeReplay, "terminal job replay does not dispatch");

  const batch = await call("/api/batch/apply", { method: "POST", token, body: { plan: preview.body.plan } });
  assert.equal(batch.status, 202);
  assert.equal(batch.body.job.results.length, preview.body.dates.length);
  const cancelled = await otherInstance("/api/batch/cancel", { method: "POST", token, body: { id: batch.body.job.id } });
  assert.equal(cancelled.body.job.cancelRequested, true);
  const history = await otherInstance("/api/batch/history", { token });
  assert.equal(history.body.jobs.length, 2);
  assert.ok(history.body.jobs.every(job => !job.credentials && !job.profileId));

  const collisionPlan = await call("/api/batch/preview", { method: "POST", token: otherToken, body: { kind: "daily-month" } });
  const collisionSingle = { id: collisionPlan.body.id, start: collisionPlan.body.dates[0] };
  assert.equal((await call("/api/apply", { method: "POST", token: otherToken, body: collisionSingle })).status, 202);
  const startsBeforeCollision = starts.length;
  const conflictingBatch = await otherInstance("/api/batch/apply", { method: "POST", token: otherToken, body: { plan: collisionPlan.body.plan } });
  assert.equal(conflictingBatch.status, 409, "a preview ID first used for a single request cannot masquerade as a batch");
  assert.equal(starts.length, startsBeforeCollision);
  finish(collisionSingle.id);

  let releaseCheck;
  checkGate = new Promise(resolve => { releaseCheck = resolve; });
  const entered = new Promise(resolve => { checkEntered = resolve; });
  const firstCheck = call("/api/check", { method: "POST", token: otherToken, body: single });
  await entered;
  assert.equal((await otherInstance("/api/check", { method: "POST", token: otherToken, body: single })).status, 409);
  releaseCheck();
  assert.equal((await firstCheck).body.status, "available");
  checkGate = undefined;

  // The original job remains replayable after its dates and preview expire; no new save is requested.
  clock = new Date(clock.getTime() + 2 * 86_400_000);
  const pastSingle = await call("/api/apply", { method: "POST", token, body: single });
  assert.equal(pastSingle.status, 200);
  assert.equal(pastSingle.body.job.id, single.id);
  const expiredPreview = await otherInstance("/api/batch/apply", { method: "POST", token, body: { plan: preview.body.plan } });
  assert.equal(expiredPreview.status, 200);
  assert.equal(expiredPreview.body.job.id, batch.body.job.id);
  assert.equal(database.jobs(ownerId).length, 2);

  // Quotas live in the shared store, not one warm instance, and do not mix users.
  clock = new Date(clock.getTime() + 60_001);
  for (let index = 0; index < 120; index++) {
    assert.equal((await (index % 2 ? call : otherInstance)("/api/session", { token })).status, 200);
  }
  const limited = await otherInstance("/api/session", { token });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal((await call("/api/session", { token: otherToken })).status, 200);
  assert.ok(rates.has("profile:" + ownerId));
  clock = new Date(clock.getTime() + 60_001);
  for (let index = 0; index < 10; index++) {
    assert.equal((await (index % 2 ? call : otherInstance)("/api/register", { method: "POST", body: {} })).status, 400);
  }
  assert.equal((await call("/api/register", { method: "POST", body: {} })).status, 429);
  clock = new Date(clock.getTime() + 60_001);

  const reconnected = await otherInstance("/api/reconnect", { method: "POST", body: credentials });
  assert.equal(reconnected.status, 201);
  const newToken = tokenOf(reconnected);
  assert.equal((await call("/api/session", { token })).body.connected, false);
  assert.equal((await call("/api/batch/history", { token: newToken })).body.jobs.length, 2);
  assert.equal((await call("/api/logout", { method: "POST", token: newToken, body: {} })).status, 200);
  assert.equal((await otherInstance("/api/session", { token: newToken })).body.connected, false);
  assert.equal(database.jobs(ownerId).length, 2);
  const claimed = await otherInstance("/api/claim", { method: "POST", body: {}, headers: { "X-Claim-Token": otherToken } });
  assert.equal(claimed.status, 200);
  const claimedToken = tokenOf(claimed);
  assert.equal((await call("/api/session", { token: otherToken })).body.connected, false);
  assert.equal((await call("/api/account", { method: "DELETE", token: claimedToken })).status, 200);
  assert.equal((await call("/api/session", { token: claimedToken })).body.connected, false);
  for (const method of ["find", "create", "claim", "reconnect", "job", "jobs", "createJob", "delete", "health", "withBusy", "consumeRate", "cancelJob", "claimDispatch", "releaseDispatch"]) {
    assert.ok(invoked.has(method), `deferred async method was not covered: ${method}`);
  }
  assert.doesNotMatch(JSON.stringify(logs), /fixture-only|cloudowner1|cloudother2|overnight_session/);
  console.log("cloud HTTP checks passed: async store, public registration, shared quotas and locks, durable dispatch retries and replay, cancellation race, session lifecycle, secret-safe failures");
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  database.close();
  rmSync(directory, { recursive: true, force: true });
}

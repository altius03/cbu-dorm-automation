import assert from "node:assert/strict";

import { TukoreaPortal } from "../service/portal.mjs";
import { runNext } from "./runner.mjs";

const PRIVATE = "fixture-secret-that-must-not-leave-the-step";
const credentials = { studentId: "fixture-student", password: PRIVATE };

// Atomic in-memory implementation of the runner's store contract; no database or school calls.
function fakeStore(dates = ["20990101"]) {
  const job = { id: "fixture-job", status: "running", cancelRequested: false, results: dates.map(date => ({ date, status: "not_attempted" })) };
  let current = null;
  let clock = 0;
  let serial = 0;
  let crash = false;
  return {
    job,
    expire() { clock += 360_001; },
    crashOnFinish() { crash = true; },
    async claimNext() {
      if (job.status !== "running") return { kind: "done" };
      if (current && current.until > clock) return { kind: "busy" };
      const index = current?.index ?? job.results.findIndex(result => result.status === "not_attempted");
      if (index < 0) { job.status = "done"; return { kind: "done" }; }
      const kind = current ? "reconcile" : "work";
      if (!current && job.cancelRequested) { job.status = "done"; job.outcome = "cancelled"; return { kind: "done" }; }
      current = { index, attempt: String(++serial), until: clock + 360_000 };
      job.results[index].status = "unknown";
      return { kind, index, date: job.results[index].date, end: job.results[index].end, attempt: current.attempt };
    },
    async credentialsForJob() { return { ...credentials }; },
    async getJobById() { return structuredClone(job); },
    async finishDate(_id, { attempt, index, status }) {
      if (crash) { crash = false; throw new Error(PRIVATE); }
      if (attempt !== current?.attempt || index !== current?.index) throw Object.assign(new Error(PRIVATE), { status: 409 });
      job.results[index].status = status;
      current = null;
      if (job.cancelRequested || ["unknown", "not_attempted"].includes(status) || job.results.every(result => result.status !== "not_attempted")) {
        job.status = "done";
        job.outcome = job.cancelRequested ? "cancelled" : ["unknown", "not_attempted"].includes(status) ? "partial" : "batch";
      }
      return structuredClone(job);
    },
  };
}

function fakeSchool(store) {
  const stats = { writes: 0, reads: 0, credentials: 0, rows: [] };
  const portalFactory = value => {
    assert.deepEqual(value, credentials);
    stats.credentials++;
    return {
      async apply(date, end, { shouldStop }) {
        assert.equal(store.job.results.find(row => row.date === date)?.status, "unknown", "unknown must be durable before school work");
        if (await shouldStop()) return { status: "cancelled" };
        stats.writes++;
        stats.rows.push({ outStayFrDt: date, outStayToDt: end, outStayStGbn: "1" });
        return { status: "saved", message: PRIVATE };
      },
      async applicationContext() {
        stats.reads++;
        return { list: async () => stats.rows.map(row => ({ ...row })) };
      },
    };
  };
  return { stats, portalFactory };
}

{
  const store = fakeStore(["20990101", "20990102"]);
  const school = fakeSchool(store);
  assert.equal(await runNext(store.job.id, { store, ...school }), "continue");
  assert.equal(await runNext(store.job.id, { store, ...school }), "done");
  assert.equal(await runNext(store.job.id, { store, ...school }), "done");
  assert.equal(school.stats.writes, 2);
  assert.equal(JSON.stringify(store.job).includes(PRIVATE), false);
}
{
  const store = fakeStore();
  const school = fakeSchool(store);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const portalFactory = credentials => {
    const portal = school.portalFactory(credentials);
    return { ...portal, apply: async (...args) => { entered(); await gate; return portal.apply(...args); } };
  };
  const first = runNext(store.job.id, { store, portalFactory });
  await ready;
  assert.equal(await runNext(store.job.id, { store, portalFactory }), "busy");
  release();
  assert.equal(await first, "done");
  assert.equal(school.stats.writes, 1, "duplicate workflow steps must not submit twice");
}
{
  const store = fakeStore();
  const school = fakeSchool(store);
  store.crashOnFinish();
  await assert.rejects(runNext(store.job.id, { store, ...school }), error => !error.message.includes(PRIVATE) && !error.cause && !error.stack.includes(PRIVATE));
  assert.equal(store.job.results[0].status, "unknown");
  assert.equal(await runNext(store.job.id, { store, ...school }), "busy");
  store.expire();
  assert.equal(await runNext(store.job.id, { store, ...school }), "done");
  assert.equal(store.job.results[0].status, "exists");
  assert.equal(school.stats.reads, 1);
  assert.equal(school.stats.writes, 1, "crash after POST must reconcile without a second POST");
}
{
  const store = fakeStore();
  const school = fakeSchool(store);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const portalFactory = credentials => {
    const portal = school.portalFactory(credentials);
    return { ...portal, apply: async (...args) => { entered(); await gate; return portal.apply(...args); } };
  };
  const stale = runNext(store.job.id, { store, portalFactory });
  await ready;
  store.expire();
  assert.equal(await runNext(store.job.id, { store, ...school }), "done");
  release();
  assert.equal(await stale, "busy", "an old attempt cannot overwrite the reconciliation result");
  assert.equal(store.job.results[0].status, "unknown");
  assert.equal(school.stats.writes, 0, "a stale worker must respect the finished job before saving");
}
{
  const store = fakeStore(["20990101", "20990102"]);
  const school = fakeSchool(store);
  await store.claimNext(); // Simulate a function killed before it could return or save.
  store.expire();
  assert.equal(await runNext(store.job.id, { store, ...school }), "done");
  assert.deepEqual(store.job.results.map(result => result.status), ["unknown", "not_attempted"]);
  assert.equal(school.stats.writes, 0, "absence after a lost attempt is not permission to POST again");
  assert.equal(await runNext(store.job.id, { store, ...school }), "done");
  assert.equal(school.stats.reads, 1);
}
{
  const store = fakeStore();
  const school = fakeSchool(store);
  await store.claimNext();
  store.expire();
  store.job.cancelRequested = true;
  school.stats.rows.push({ outStayFrDt: "20990101", outStayToDt: "20990101", outStayStGbn: "1" });
  assert.equal(await runNext(store.job.id, { store, ...school }), "done");
  assert.equal(store.job.results[0].status, "exists", "cancel cannot erase a possible in-flight save");
  assert.equal(store.job.outcome, "cancelled");
  assert.equal(school.stats.writes, 0);
  assert.equal(school.stats.reads, 1);
}
{
  const store = fakeStore();
  let writes = 0;
  const portalFactory = credentials => {
    const portal = new TukoreaPortal(credentials.studentId, credentials.password);
    portal.applicationContext = async () => {
      store.job.cancelRequested = true;
      return { list: async () => [] };
    };
    portal.saveApplication = async () => { writes++; };
    return portal;
  };
  assert.equal(await runNext(store.job.id, { store, portalFactory }), "done");
  assert.equal(store.job.results[0].status, "not_attempted");
  assert.equal(store.job.outcome, "cancelled");
  assert.equal(writes, 0, "the real portal must await async cancellation after slow login");
}
for (const [failure, expected] of [
  [new Error(PRIVATE), "unknown"],
  [Object.assign(new Error(PRIVATE), { code: "INVALID_PERIOD" }), "not_attempted"],
  [Object.assign(new Error(PRIVATE), { code: "OVERLAP" }), "overlap"],
]) {
  const store = fakeStore();
  let calls = 0;
  assert.equal(await runNext(store.job.id, {
    store,
    portalFactory: () => ({ apply: async () => { calls++; throw failure; } }),
  }), "done");
  assert.equal(store.job.results[0].status, expected);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(store.job).includes(PRIVATE), false);
}
{
  const store = fakeStore();
  store.credentialsForJob = async () => null;
  assert.equal(await runNext(store.job.id, { store, portalFactory: () => { throw new Error("must not construct portal"); } }), "done");
  assert.equal(store.job.results[0].status, "not_attempted");
}
{
  const store = fakeStore();
  const school = fakeSchool(store);
  store.finishDate = async () => { throw Object.assign(new Error(PRIVATE), { status: 409 }); };
  assert.equal(await runNext(store.job.id, { store, ...school }), "busy");
  assert.equal(school.stats.writes, 1);
  assert.equal(store.job.results[0].status, "unknown");
}
{
  const store = { claimNext: async () => { throw new Error(PRIVATE); } };
  await assert.rejects(runNext("fixture-job", { store }), error => !error.message.includes(PRIVATE) && !error.cause);
}

console.log("cloud runner checks passed: one-write claims, concurrent steps, crash/lease reconciliation, async cancellation, timeout/uncertain halt, safe primitive outputs (no network)");

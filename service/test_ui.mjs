import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
assert.doesNotMatch(html.match(/<form id="batch-form">([\s\S]*?)<\/form>/)[1], /<input/);
assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
assert.match(html, /@media \(max-width: 480px\)[\s\S]*\.actions \{ grid-template-columns: 1fr; \}/);
assert.match(html, /input, select, button \{ min-height: 48px; font-size: 16px; \}/);
const pendingKey = "overnight_pending_job";
const http = (status, body) => ({ httpStatus: status, body });
const flush = () => new Promise(resolve => setImmediate(resolve));
const runningJob = (id = "fixture-job") => ({ id, status: "running", message: "processing", results: [{ date: "20260919", status: "unknown" }] });
const finishedJob = (id = "fixture-job") => ({ id, status: "done", outcome: "batch", message: "완료", results: [{ date: "20260919", status: "saved" }] });

// Exercise the actual script with explicit HTTP outcomes and controllable timers.
// This checks browser event/state behavior; rendering is verified separately.
async function page(respond = () => {}, { connected = true, hash = "", storage = new Map(), confirm = () => true } = {}) {
  const elements = new Map();
  const timers = new Map();
  const calls = [];
  const unexpected = [];
  let timerId = 0;
  for (const match of html.matchAll(/<(section|form|input|select|button|div)\b([^>]*)>/g)) {
    const id = match[2].match(/\bid="([^"]+)"/)?.[1];
    const element = {
      id, tag: match[1], name: match[2].match(/\bname="([^"]+)"/)?.[1],
      value: id === "batch-kind" ? "daily-month" : "", disabled: false,
      hidden: /\bhidden\b/.test(match[2]), dataset: {}, events: {}, attributes: {}, children: [], controlIds: [],
      addEventListener(name, callback) { this.events[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ""; },
      add(option) { this.children.push(option); },
      reset() { for (const id of this.controlIds) elements.get(id).value = ""; },
      reportValidity() { return true; },
    };
    elements.set(id || `anonymous-${elements.size}`, element);
  }
  for (const [, id, body] of html.matchAll(/<form id="([^"]+)">([\s\S]*?)<\/form>/g)) {
    elements.get(id).controlIds = [...body.matchAll(/<(?:input|select)\b[^>]*id="([^"]+)"/g)].map(match => match[1]);
  }
  const context = {
    document: {
      querySelector: selector => { const element = elements.get(selector.slice(1)); assert.ok(element, selector); return element; },
      querySelectorAll: () => [...elements.values()].filter(element => ["button", "input", "select"].includes(element.tag)),
    },
    FormData: class {
      constructor(form) { this.values = Object.fromEntries(form.controlIds.map(id => elements.get(id)).filter(element => element.name && !element.disabled).map(element => [element.name, element.value])); }
      get(name) { return this.values[name]; }
    },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    location: { hash, pathname: "/" }, history: { replaceState() { context.location.hash = ""; } },
    window: { confirm }, crypto: { randomUUID }, URLSearchParams, AbortSignal,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: async (path, options) => {
      calls.push({ path, options });
      let result = await respond(path, options, elements);
      if (result === undefined) {
        if (path === "/api/session") result = { connected, today: "2026-09-19" };
        else if (path === "/api/batch/history") result = { jobs: [] };
        else if (path.startsWith("/api/batch/job")) result = { job: null };
        else { unexpected.push(path); throw new Error("Unexpected test request"); }
      }
      const status = result.httpStatus ?? 200;
      return { status, ok: status >= 200 && status < 300, json: async () => result.httpStatus === undefined ? result : result.body };
    },
  };
  await runInNewContext(`(async () => { ${script}\n })()`, context);
  const checkRequests = () => assert.deepEqual(unexpected, []);
  checkRequests();
  return {
    get: id => elements.get(id), calls, storage, timers,
    async fire(id, name) {
      const element = elements.get(id);
      assert.equal(element.disabled, false, `${id} must be enabled before ${name}`);
      await element.events[name]({ preventDefault() {} });
      await flush();
      checkRequests();
    },
    nextDelay() { assert.equal(timers.size, 1, "exactly one job polling timer"); return [...timers.values()][0].delay; },
    async tick() {
      assert.equal(timers.size, 1, "exactly one job polling timer");
      const [id, timer] = [...timers.entries()][0];
      timers.delete(id);
      await timer.callback();
      await flush();
      checkRequests();
    },
  };
}

// FormData must be captured before disabling fields (disabled values are omitted).
let registrationBody;
const registration = await page((path, options) => {
  if (path === "/api/register") { registrationBody = JSON.parse(options.body); return { connected: true }; }
}, { connected: false });
registration.get("student-id").value = "fixturestudent";
registration.get("password").value = "fixture-password";
await registration.fire("connect-form", "submit");
assert.deepEqual(registrationBody, { studentId: "fixturestudent", password: "fixture-password" });
assert.equal(registration.get("apply-section").hidden, false);
assert.equal(registration.get("password").value, "");

const claimed = await page(path => path === "/api/claim" ? http(403, { error: "이미 사용된 링크" }) : undefined, { hash: "#claim=fixture-consumed-claim" });
assert.equal(claimed.get("apply-section").hidden, false);
assert.equal(claimed.get("connect-section").hidden, true);
assert.ok(claimed.calls.some(call => call.path === "/api/session"));

let resumeJob = runningJob("resume-job");
const resumed = await page(path => path.startsWith("/api/batch/job") ? { job: resumeJob } : undefined, { storage: new Map([[pendingKey, "resume-job"]]) });
assert.equal(resumed.get("batch-kind").disabled, true);
assert.equal(resumed.get("start").min, "2026-09-19");
assert.equal(resumed.get("refresh-job").disabled, false);
assert.equal(resumed.get("cancel-job").disabled, false);
assert.equal(resumed.nextDelay(), 3000);
resumeJob = { ...resumeJob, status: "done", outcome: "partial", message: "확인 필요" };
await resumed.tick();
assert.equal(resumed.get("batch-kind").disabled, false);
assert.equal(resumed.storage.has(pendingKey), false);
assert.equal(resumed.get("status").dataset.kind, "error");
assert.match(resumed.get("status").textContent, /2026-09-19: 확인 필요/);

let submitted;
let lostLookups = 0;
const lost = await page((path, options, elements) => {
  if (path === "/api/batch/preview") return { id: "lost-job", dates: ["2026-09-19"], plan: "fixture-signed-plan", message: "1건" };
  if (path === "/api/batch/apply") {
    assert.equal(elements.get("batch-kind").disabled, true);
    submitted = JSON.parse(options.body);
    throw new Error("lost acceptance response");
  }
  if (path === "/api/batch/job?id=lost-job") {
    if (++lostLookups === 1) throw new Error("lost lookup response");
    return { job: lostLookups === 2 ? runningJob("lost-job") : finishedJob("lost-job") };
  }
});
await lost.fire("batch-form", "submit");
assert.deepEqual(submitted, { plan: "fixture-signed-plan" });
assert.equal(lost.storage.get(pendingKey), "lost-job");
assert.equal(lost.get("batch-kind").disabled, true);
assert.equal(lost.get("start").disabled, true);
assert.equal(lost.get("refresh-job").disabled, false);
assert.equal(lost.nextDelay(), 6000);
await lost.tick();
assert.equal(lost.get("batch-kind").disabled, true);
assert.equal(lost.nextDelay(), 3000);
await lost.tick();
assert.equal(lost.get("batch-kind").disabled, false);
assert.equal(lost.storage.has(pendingKey), false);
assert.equal(lost.get("status").dataset.kind, "success");
assert.equal(lost.calls.filter(call => call.path === "/api/batch/apply").length, 1);

let quotaLookups = 0;
const quota = await page(path => {
  if (!path.startsWith("/api/batch/job")) return;
  quotaLookups++;
  return quotaLookups === 2 ? http(429, { error: "잠시 기다려 주세요." }) : { job: quotaLookups === 1 ? runningJob() : finishedJob() };
});
await quota.tick();
assert.equal(quota.nextDelay(), 60_000);
assert.equal(quota.get("batch-kind").disabled, true);
assert.equal(quota.get("refresh-job").disabled, false);
await quota.tick();
assert.equal(quota.get("batch-kind").disabled, false);

let singleBody;
const single = await page((path, options) => {
  if (path !== "/api/apply") return;
  singleBody = JSON.parse(options.body);
  return { job: { ...finishedJob(singleBody.id), outcome: "saved", results: [{ date: "20260920", end: "20260922", status: "saved" }] } };
});
single.get("start").value = "2026-09-20";
single.get("end").value = "2026-09-22";
await single.fire("apply-form", "submit");
assert.match(singleBody.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.equal(singleBody.start, "2026-09-20");
assert.equal(singleBody.end, "2026-09-22");
assert.equal(single.get("status").dataset.kind, "success");
assert.match(single.get("status").textContent, /2026-09-20 ~ 2026-09-22: 신청 완료/);
assert.equal(single.storage.has(pendingKey), false);

let cancelJob = runningJob("cancel-job-fixture");
const cancelled = await page((path, options) => {
  if (path.startsWith("/api/batch/job")) return { job: cancelJob };
  if (path === "/api/batch/cancel") {
    assert.deepEqual(JSON.parse(options.body), { id: cancelJob.id });
    cancelJob = { ...cancelJob, cancelRequested: true };
    return { job: cancelJob };
  }
}, { confirm: () => assert.fail("Stopping remaining requests must not require confirmation") });
await cancelled.fire("cancel-job", "click");
assert.equal(cancelled.get("cancel-job").disabled, true);
assert.equal(cancelled.get("start").disabled, true);
assert.match(cancelled.get("status").textContent, /현재 건 확인 후 중단/);
await cancelled.get("cancel-job").events.click();
assert.equal(cancelled.calls.filter(call => call.path === "/api/batch/cancel").length, 1);
cancelJob = { ...cancelJob, status: "done", outcome: "cancelled", message: "중단했습니다." };
await cancelled.tick();
assert.equal(cancelled.get("cancel-job").hidden, true);
assert.equal(cancelled.get("start").disabled, false);
assert.equal(cancelled.get("status").dataset.kind, "error");
await cancelled.get("cancel-job").events.click();
assert.equal(cancelled.calls.filter(call => call.path === "/api/batch/cancel").length, 1);

const historyJobs = [finishedJob("latest"), { ...finishedJob("older"), message: "이전 신청" }];
const history = await page(path => {
  if (path === "/api/batch/history") return { jobs: historyJobs };
  if (path.startsWith("/api/batch/job")) return { job: path.endsWith("older") ? historyJobs[1] : historyJobs[0] };
});
assert.deepEqual(history.get("job-history").children.map(option => option.value), ["", "latest", "older"]);
history.get("job-history").value = "older";
await history.fire("job-history", "change");
assert.match(history.get("status").textContent, /이전 신청/);

// A history outage must not hide a valid session or forget its pending request.
const historyDown = await page(path => {
  if (path === "/api/batch/history") return http(503, { error: "목록을 불러올 수 없습니다." });
  if (path === "/api/batch/job?id=resume-after-history-failure") return { job: runningJob("resume-after-history-failure") };
}, { storage: new Map([[pendingKey, "resume-after-history-failure"]]) });
assert.equal(historyDown.get("apply-section").hidden, false);
assert.equal(historyDown.storage.get(pendingKey), "resume-after-history-failure");
assert.equal(historyDown.get("batch-kind").disabled, true);
assert.equal(historyDown.nextDelay(), 3000);

console.log("UI flow checks passed: credential capture, claim/session recovery, durable pending state, polling/backoff, single request UUID, cancellation, history recovery");

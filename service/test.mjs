import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { validatePeriod } from "../extension/core.mjs";
import { buildRequest, internals as portalInternals, parseResponse, TukoreaPortal } from "./portal.mjs";
import { CredentialStore } from "./store.mjs";
import { batchDatesFrom, createApplication, koreaNow } from "./server.mjs";
import { sessionProof } from "./crypto.mjs";

// 실제 네트워크 없이 운영 HTTP 핸들러를 격리 DB에 연결한다.
let requestKey;
async function call(app, path, { method = "POST", token, body = {}, headers = {}, raw, socket = { localPort: 8787, remoteAddress: "127.0.0.1" } } = {}) {
  const request = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]);
  request.url = path;
  request.method = method;
  request.headers = { host: "127.0.0.1:8787", "content-type": "application/json", ...(token ? { cookie: `overnight_session=${token}`, "x-session-proof": sessionProof(requestKey, token) } : {}), ...headers };
  request.socket = socket;
  const response = {
    statusCode: 200, headers: {}, headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers) { this.statusCode = status; this.headersSent = true; for (const [name, value] of Object.entries(headers || {})) this.setHeader(name, value); },
    end(body) { this.body = JSON.parse(String(body)); },
  };
  await app.handler(request, response);
  return response;
}

const directory = mkdtempSync(join(tmpdir(), "tuk-overnight-test-"));
try {
  const store = new CredentialStore(directory);
  const created = store.create({ studentId: "2026000000", password: "not-a-real-password" });
  assert.ok(store.find(created.token).accountKey);
  assert.equal("credentials" in store.find(created.token), false);
  const claimed = store.claim(created.token);
  assert.equal(store.find(created.token), null);
  assert.ok(store.find(claimed.token).accountKey);
  assert.equal(store.find("wrong-token"), null);
  assert.equal(store.delete(created.id), true);
  store.close();
  assert.equal(readFileSync(join(directory, "overnight.db")).includes("not-a-real-password"), false);

  const request = buildRequest({ requestTimeStr: "1" }, {
    id: "DS_DORM120",
    columns: [["outStayGbn", "string", "32"], "outStayFrDt"],
    row: { outStayGbn: "07", outStayFrDt: "20260921" },
    type: "insert",
  });
  assert.match(request, /<Row type="insert">/);
  assert.match(request, /<Col id="outStayFrDt">20260921<\/Col>/);

  const parsed = parseResponse(`<?xml version="1.0"?><Root>
    <Parameters><Parameter id="ErrorCode">0</Parameter></Parameters>
    <Dataset id="DS"><Rows><Row><Col id="name">A&amp;B</Col></Row></Rows></Dataset>
  </Root>`);
  assert.deepEqual(parsed.datasets.DS, [{ name: "A&B" }]);
  assert.throws(() => parseResponse("<Root></Root>"), /처리 결과/);
  assert.throws(() => parseResponse('<Root><Parameter id="ErrorCode">0</Parameter>'), /잘못된 응답/);
  assert.throws(() => parseResponse('<Root><Parameter id="ErrorCode">-1</Parameter><Parameter id="ErrorMsg">secret-response</Parameter></Root>'), error => !error.message.includes("secret-response"));
  assert.throws(() => portalInternals.bufferedHttpsRequest("https://example.com", {}), /허용되지/);

  const keyHex = "131848D3308C94638EEF6EC3A89491C9";
  const encryptedLogin = Buffer.from(
    portalInternals.encryptSsoValue("student", "123", keyHex),
    "base64url",
  );
  const decipher = createDecipheriv(
    "aes-128-cbc",
    Buffer.from(keyHex, "hex"),
    encryptedLogin.subarray(0, 16),
  );
  assert.equal(
    Buffer.concat([decipher.update(encryptedLogin.subarray(16)), decipher.final()]).toString(),
    "student|123",
  );

  const cookies = new portalInternals.CookieJar();
  cookies.add("https://ksc.tukorea.ac.kr/sso/login", "SESSION=value; Domain=.tukorea.ac.kr; Path=/; Secure");
  assert.equal(cookies.header("https://dream.tukorea.ac.kr/nx/"), "SESSION=value");
  cookies.add("https://ksc.tukorea.ac.kr/sso/login", "BAD=x; Domain=ac.kr; Path=/");
  cookies.add("https://ksc.tukorea.ac.kr/sso/login", "SCOPED=x; Path=/sso");
  assert.equal(cookies.header("https://ksc.tukorea.ac.kr/sso-other"), "SESSION=value");
  assert.equal(cookies.header("https://unrelated.example/"), "");
  assert.equal(
    validatePeriod("2026-09-20", "2026-09-27", new Date(2026, 8, 19, 12)).end.compact,
    "20260927",
  );

  // 저장 응답만 유실된 경우에는 재전송 없이 조회로 성공을 확인한다.
  const portal = new TukoreaPortal("fake-student", "fake-password");
  let rows = [{ outStayFrDt: "20990101", outStayToDt: "20990101", outStayStGbn: "1" }];
  let saveCalls = 0;
  portal.applicationContext = async () => ({ list: async () => rows.map(row => ({ ...row })) });
  portal.saveApplication = async (_context, start, end) => {
    saveCalls++;
    if (start === "20990102") rows.push({ outStayFrDt: start, outStayToDt: end, outStayStGbn: "1" });
    throw new Error("response-lost");
  };
  const progress = [];
  const partial = await portal.applyMany(["20990101", "20990102", "20990103", "20990104"], {
    onProgress: result => progress.push(structuredClone(result)),
  });
  assert.equal(saveCalls, 2);
  assert.deepEqual(partial.results.map(row => row.status), ["exists", "saved", "unknown", "not_attempted"]);
  assert.equal(progress[1].results[1].status, "unknown");
  assert.equal(partial.status, "partial");
  await assert.rejects(portal.applyMany(["20990101", "20990101"]), /겹치는/);

  const httpStore = new CredentialStore(join(directory, "http"));
  requestKey = httpStore.key;
  httpStore.holidays = () => [{ date: "2026-10-03", name: "개천절", source: "fixture", updatedAt: "2026-09-19T00:00:00.000Z" }];
  const ownerCredentials = { studentId: "owner0001", password: "fake-password" };
  const otherCredentials = { studentId: "other0002", password: "fake-password" };
  const owner = httpStore.create(ownerCredentials);
  const other = httpStore.create(otherCredentials);
  const logs = [];
  let clock = new Date("2026-09-19T03:00:00Z");
  let batchCalls = 0;
  let releaseBatch;
  const batchGate = new Promise(resolve => { releaseBatch = resolve; });
  const appOptions = {
    store: httpStore, now: () => clock, logger: entry => logs.push(entry),
    portalFactory: () => ({
      applyMany: async (periods, { onProgress }) => {
        batchCalls++;
        await onProgress({ message: "processing", results: periods.map(period => ({ ...period, status: "unknown" })) });
        await batchGate;
        return { status: "batch", message: "done", results: periods.map(period => ({ ...period, status: "saved" })) };
      },
      apply: async () => { throw new Error("unexpected single request"); },
    }),
  };
  const app = createApplication(appOptions);
  for (const raw of ["null", "[]", '"text"', "{"]) assert.equal((await call(app, "/api/batch/preview", { token: owner.token, raw })).statusCode, 400);
  assert.equal((await call(app, "/api/batch/preview", { token: owner.token, raw: "x".repeat(16_385) })).statusCode, 413);
  assert.equal((await call(app, "/api/batch/preview", { token: owner.token, headers: { "content-type": "text/plain" } })).statusCode, 415);
  assert.equal((await call(app, "/api/batch/preview", { token: owner.token, headers: { origin: "https://evil.example" } })).statusCode, 403);
  assert.equal((await call(app, "/api/session", { method: "GET", headers: { host: "evil.example" } })).statusCode, 403);
  assert.equal((await call(app, "/api/batch/preview")).statusCode, 401);
  assert.equal((await call(app, "/api/health", { method: "GET" })).body.ok, true);
  const context = await call(app, "/api/session", { method: "GET" });
  assert.deepEqual(context.body.holidays.map(item => item.date), ["2026-10-03"]);
  let holidayRuns = 0;
  const cron = createApplication({
    ...appOptions, cronSecret: "fixture-cron-secret-".repeat(2),
    holidaySync: async () => ({ count: ++holidayRuns, years: [2026, 2027] }),
  });
  assert.equal((await call(cron, "/api/cron/holidays", { method: "GET" })).statusCode, 401);
  const synced = await call(cron, "/api/cron/holidays", {
    method: "GET", socket: {},
    headers: { host: "generated-deployment.vercel.app", authorization: `Bearer ${"fixture-cron-secret-".repeat(2)}` },
  });
  assert.equal(synced.statusCode, 200);
  assert.equal(synced.body.count, 1);
  const proxied = createApplication({ ...appOptions, publicOrigin: "https://overnight.example" });
  assert.equal((await call(proxied, "/api/health", { method: "GET", socket: {}, headers: { host: "overnight.example" } })).statusCode, 200);
  assert.equal((await call(proxied, "/api/health", { method: "GET", socket: {}, headers: { host: "evil.example" } })).statusCode, 403);
  assert.equal((await call(createApplication({ ...appOptions, localPort: 8787 }), "/api/health", { method: "GET", socket: { localPort: 11111 } })).statusCode, 200);
  const monthDates = Array.from({ length: 31 }, (_, index) =>
    new Date(Date.UTC(2026, 8, 19 + index)).toISOString().slice(0, 10));
  const preview = await call(app, "/api/batch/preview", { token: owner.token, body: { dates: monthDates } });
  assert.equal(preview.body.dates.length, 31);
  assert.equal(preview.body.dates.at(-1), "2026-10-19");
  assert.equal(preview.body.periods.length, 4);
  assert.equal(batchCalls, 0);
  assert.equal((await call(app, "/api/batch/preview", { token: owner.token, body: { dates: ["2026-10-20"] } })).statusCode, 400);
  const manual = await call(app, "/api/batch/preview", { token: owner.token, body: { dates: ["2026-09-21", "2026-09-20"] } });
  assert.deepEqual(manual.body.dates, ["2026-09-20", "2026-09-21"]);
  const plan = preview.body.plan;
  assert.equal((await call(app, "/api/batch/apply", { token: other.token, body: { plan, ...ownerCredentials } })).statusCode, 403);
  assert.equal((await call(app, "/api/batch/apply", { token: owner.token, body: { plan: plan + "tampered", ...ownerCredentials } })).statusCode, 400);
  const acceptedRequest = call(app, "/api/batch/apply", { token: owner.token, body: { plan, ...ownerCredentials } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(batchCalls, 1);
  assert.equal((await call(app, "/api/account", { method: "DELETE", token: owner.token })).statusCode, 409);
  releaseBatch();
  const accepted = await acceptedRequest;
  assert.equal(accepted.statusCode, 200);
  assert.equal((await call(app, "/api/batch/apply", { token: owner.token, body: { plan, ...ownerCredentials } })).body.job.id, accepted.body.job.id);
  assert.equal((await call(app, `/api/batch/job?id=${accepted.body.job.id}`, { method: "GET", token: other.token })).body.job, null);
  assert.equal((await call(app, "/api/batch/job", { method: "GET", token: owner.token })).body.job.status, "done");
  clock = new Date("2026-09-20T03:00:00Z");
  assert.equal((await call(app, "/api/batch/apply", { token: owner.token, body: { plan, ...ownerCredentials } })).body.job.status, "done");
  assert.equal(batchCalls, 1);
  const expired = await call(app, "/api/batch/preview", { token: owner.token, body: { dates: ["2026-09-20"] } });
  clock = new Date(clock.getTime() + 600_001);
  assert.equal((await call(app, "/api/batch/apply", { token: owner.token, body: { plan: expired.body.plan, ...ownerCredentials } })).statusCode, 409);

  // 일회성 연결 링크는 동시 요청과 재시작 모두에서 재사용할 수 없다.
  const setupToken = "fixture-setup-token-".repeat(3);
  let releaseLogin;
  let loginCalls = 0;
  const loginGate = new Promise(resolve => { releaseLogin = resolve; });
  const registrationOptions = { store: httpStore, setupToken, logger: entry => logs.push(entry), portalFactory: () => ({ login: async () => { loginCalls++; await loginGate; } }) };
  const registration = createApplication(registrationOptions);
  const registrationRequest = { body: { studentId: "test0003", password: "fixture-secret-password" }, headers: { "x-setup-token": setupToken } };
  const firstRegistration = call(registration, "/api/register", registrationRequest);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await call(registration, "/api/register", registrationRequest)).statusCode, 409);
  releaseLogin();
  assert.equal((await firstRegistration).statusCode, 201);
  assert.equal((await call(createApplication(registrationOptions), "/api/register", registrationRequest)).statusCode, 410);
  assert.equal(loginCalls, 1);
  const limited = createApplication({ store: httpStore, logger: () => {} });
  for (let index = 0; index < 10; index++) assert.equal((await call(limited, "/api/login")).statusCode, 400);
  assert.equal((await call(limited, "/api/login")).statusCode, 429);
  assert.equal((await call(limited, "/api/claim", { token: owner.token, headers: { "x-claim-token": owner.token } })).statusCode, 404);
  assert.equal(logs.some(entry => /fixture-secret-password|fixture-setup-token|fake-password/.test(JSON.stringify(entry))), false);

  httpStore.createJob("interrupted-fixture", owner.id, ["20260921"]);
  httpStore.updateJob("interrupted-fixture", "running", { results: [{ date: "20260921", status: "unknown" }] });
  httpStore.close();
  const reopened = new CredentialStore(join(directory, "http"));
  reopened.recoverJobs();
  assert.equal(reopened.job(owner.id, "interrupted-fixture").status, "interrupted");
  assert.equal(reopened.job(owner.id, "interrupted-fixture").results[0].status, "unknown");
  assert.ok(reopened.find(owner.token).accountKey);
  assert.equal(reopened.setupUsed(setupToken), true);
  assert.equal(reopened.find(owner.token, { now: Date.now() + 31_536_000_001 }), null);
  reopened.delete(owner.id);
  assert.equal(reopened.job(owner.id), null);
  reopened.close();
  assert.equal(batchDatesFrom({ dates: monthDates }, koreaNow(new Date("2026-09-19T14:30:00Z"))).length, 30);
  assert.throws(() => batchDatesFrom({ dates: ["2026-10-20"] }, new Date(2026, 8, 19, 12)), /31일/);
  console.log("service checks passed: credentials, HTTP guards, 31-day preview, batch isolation/replay/recovery, uncertain saves, rate limits, Korea dates");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

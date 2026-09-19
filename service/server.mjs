import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MAX_BATCH_DATES, buildBatchDates, findConflict, groupBatchDates, localIsoDate, parseIsoDate, validatePeriod } from "../extension/core.mjs";
import { PortalError, TukoreaPortal } from "./portal.mjs";
import { HttpError } from "./errors.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sessionCookieName = "overnight_session";
const mascotRoute = "/assets/cbu-sleeping-owl-v2.png";
const knownRoutes = new Set([
  "/", "/app.js", mascotRoute, "/api/health", "/api/session", "/api/login", "/api/register", "/api/reconnect", "/api/claim",
  "/api/logout", "/api/account", "/api/applications", "/api/check", "/api/apply", "/api/batch/job",
  "/api/batch/history", "/api/batch/preview", "/api/batch/apply", "/api/batch/cancel", "/api/batch/reconcile",
  "/api/cron/holidays",
]);

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  response.end(body);
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "JSON 형식으로 요청해 주세요.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, "요청 본문이 너무 큽니다.");
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new HttpError(400, "JSON 요청 형식이 올바르지 않습니다."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "요청 내용을 확인해 주세요.");
  return body;
}

function cookieValue(request) {
  const part = (request.headers.cookie || "").split(";").find(value => value.trim().startsWith(sessionCookieName + "="));
  return part ? part.trim().slice(sessionCookieName.length + 1) : null;
}

export function koreaNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return new Date(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute), Number(value.second));
}

export function periodFrom(body, now = koreaNow()) {
  if (!body || typeof body.start !== "string" || (body.end !== undefined && typeof body.end !== "string")) {
    throw new HttpError(400, "시작일과 종료일을 확인해 주세요.");
  }
  try { return validatePeriod(body.start, body.end || body.start, now); }
  catch (error) { throw new HttpError(400, error.message); }
}

export function batchDatesFrom(body, now = koreaNow()) {
  try {
    const dates = buildBatchDates(body, localIsoDate(now)).filter(value => {
      try { validatePeriod(value, value, now); return true; }
      catch { return false; }
    });
    if (!dates.length || dates.length > MAX_BATCH_DATES) throw new Error("신청 가능한 날짜가 없습니다. 다른 방식을 선택해 주세요.");
    return dates;
  } catch (error) { throw new HttpError(400, error.message); }
}

export function createApplication({
  store, portalFactory = credentials => new TukoreaPortal(credentials.studentId, credentials.password),
  setupToken = "", publicOrigin = "", secureCookie = false, now = () => new Date(),
  logger = entry => console.log(JSON.stringify(entry)),
  publicRegistration = false,
  holidaySync = null, cronSecret = "",
  clientAddress = request => request.socket.remoteAddress,
  localPort,
  page = readFileSync(join(here, "public", "index.html")),
  script = readFileSync(join(here, "public", "app.js")),
}) {
  if (setupToken && setupToken.length < 32) throw new Error("계정 연결 토큰은 32자 이상이어야 합니다.");
  if (cronSecret && cronSecret.length < 32) throw new Error("CRON_SECRET은 32자 이상이어야 합니다.");
  if (localPort !== undefined && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)) throw new Error("개발 서버 포트를 확인해 주세요.");
  if (publicOrigin && (new URL(publicOrigin).protocol !== "https:" || new URL(publicOrigin).origin !== publicOrigin)) {
    throw new Error("OVERNIGHT_PUBLIC_ORIGIN에는 경로 없는 HTTPS 주소를 설정해 주세요.");
  }
  secureCookie ||= Boolean(publicOrigin);
  const busy = new Map();
  const rates = new Map();
  const requestProfiles = new WeakMap();
  let stopping = false;
  const measure = async (phases, name, task) => {
    const started = performance.now();
    try { return await task(); }
    finally { phases[name] = (phases[name] || 0) + Math.round(performance.now() - started); }
  };
  const currentContext = async (today, phases) => {
    const holidays = store.holidays
      ? await measure(phases, "holidayMs", () => store.holidays(today, `${Number(today.slice(0, 4)) + 1}-12-31`))
      : [];
    return { today, maxSelectionDays: MAX_BATCH_DATES, holidays };
  };
  const cookie = (token, maxAge = 31_536_000) => [
    sessionCookieName + "=" + token, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=" + maxAge, secureCookie ? "Secure" : "",
  ].filter(Boolean).join("; ");
  const profileFrom = async request => {
    const cached = requestProfiles.get(request);
    if (cached) return cached;
    const profile = await store.find(cookieValue(request), { now: now().getTime() });
    if (profile) requestProfiles.set(request, profile);
    return profile;
  };
  const requireProfile = async request => {
    const profile = await profileFrom(request);
    if (!profile) throw new HttpError(401, "학교 포탈에 먼저 로그인해 주세요.");
    return profile;
  };
  function credentialsFrom(body) {
    const credentials = { studentId: typeof body?.studentId === "string" ? body.studentId.trim() : "", password: body?.password };
    if (!/^[A-Za-z0-9]{4,32}$/.test(credentials.studentId) || typeof credentials.password !== "string" || credentials.password.length < 1 || credentials.password.length > 256) {
      throw new HttpError(400, "학번과 비밀번호를 확인해 주세요.");
    }
    return credentials;
  }
  function liveCredentials(profile, body) {
    const credentials = credentialsFrom(body);
    const expected = Buffer.from(profile.accountKey || []);
    const supplied = Buffer.from(store.accountKey(credentials));
    if (!expected.length || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new HttpError(403, "이 서비스 계정의 학교 포탈 아이디로 다시 로그인해 주세요.");
    }
    return credentials;
  }
  const accountKey = profile => profile.id;
  function withBusy(key, task) {
    if (store.withBusy) return store.withBusy(key, task);
    // ponytail: 단일 서버의 계정별 잠금. 다중 프로세스 운영 시 DB 임대 잠금으로 교체한다.
    if (busy.has(key)) throw new HttpError(409, "이 계정의 요청을 처리 중입니다. 완료 후 다시 시도해 주세요.");
    const promise = Promise.resolve().then(task).finally(() => busy.delete(key));
    busy.set(key, promise);
    return promise;
  }

  function guard(request) {
    const port = localPort ?? request.socket.localPort;
    const localOrigins = Number.isInteger(port) && port > 0
      ? ["127.0.0.1", "localhost", "[::1]"].map(host => "http://" + host + ":" + port) : [];
    const origins = publicOrigin ? [...localOrigins, publicOrigin] : localOrigins;
    const origin = origins.find(value => new URL(value).host === request.headers.host);
    if (!origin || (request.headers.origin && request.headers.origin !== origin)) {
      throw new HttpError(403, "허용되지 않은 서비스 주소입니다.");
    }
    const site = request.headers["sec-fetch-site"];
    if (site && !["same-origin", "none"].includes(site)) throw new HttpError(403, "다른 사이트에서 보낸 요청은 허용하지 않습니다.");
    return origin;
  }

  async function limit(request, auth = false) {
    const timestamp = now().getTime();
    for (const [key, value] of rates) if (value.until <= timestamp) rates.delete(key);
    // 로그인 시도만 IP로 제한하고, 인증된 조회는 프록시 뒤에서도 계정별로 제한한다.
    const profile = auth ? null : await profileFrom(request);
    const key = auth ? "auth:" + clientAddress(request) : profile ? "profile:" + profile.id : "anonymous:" + clientAddress(request);
    if (store.consumeRate) return store.consumeRate(key, auth ? 10 : 120, 60_000);
    if (!rates.has(key)) {
      if (rates.size >= 1024) throw new HttpError(429, "요청이 많습니다. 잠시 후 다시 시도해 주세요.");
      rates.set(key, { until: timestamp + 60_000, count: 0 });
    }
    if (++rates.get(key).count > (auth ? 10 : 120)) throw new HttpError(429, "요청이 많습니다. 1분 후 다시 시도해 주세요.");
  }

  const sign = payload => createHmac("sha256", store.key).update("batch-plan-v1." + payload).digest("base64url");
  function decodePlan(token, profile) {
    if (typeof token !== "string" || token.length > 8000) throw new HttpError(400, "대상 날짜를 먼저 확인해 주세요.");
    const [payload, signature, extra] = token.split(".");
    const expected = Buffer.from(sign(payload || ""));
    const supplied = Buffer.from(signature || "");
    if (extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(400, "미리보기 정보가 유효하지 않습니다.");
    let plan;
    try { plan = JSON.parse(Buffer.from(payload, "base64url")); }
    catch { throw new HttpError(400, "미리보기 정보가 유효하지 않습니다."); }
    if (plan.profileId !== profile.id) throw new HttpError(403, "다른 계정의 미리보기입니다.");
    return plan;
  }

  async function startJob(profile, id, dates, task, end) {
    const key = accountKey(profile);
    return withBusy(key, async () => {
      await store.createJob(id, profile.id, end ? [{ date: dates[0], end }] : dates);
      const deadline = Date.now() + 240_000;
      const shouldStop = async () => stopping || Date.now() >= deadline || Boolean((await store.job(profile.id, id))?.cancelRequested);
      const progress = async result => store.updateJob(id, "running", {
        ...result, cancelRequested: Boolean((await store.job(profile.id, id))?.cancelRequested),
      });
      try {
        const result = await task({ onProgress: progress, shouldStop });
        await store.updateJob(id, "done", { ...result, outcome: result.status });
      } catch (error) {
        await store.updateJob(id, "failed", {
          ...await store.job(profile.id, id),
          message: error instanceof PortalError ? error.message : "신청 처리가 중단되었습니다. 처리 결과와 학교 신청 내역을 확인해 주세요.",
        });
      }
      return store.job(profile.id, id);
    });
  }

  function matchJob(existing, periods) {
    if (existing.results.length !== periods.length || periods.some((period, index) => {
      const saved = existing.results[index];
      return saved.date !== period.date || (saved.end || saved.date) !== (period.end || period.date);
    })) throw new HttpError(409, "다른 날짜로 사용된 신청 번호입니다. 신청 내용을 다시 확인해 주세요.");
  }

  function reconciliationRows(applications) {
    return applications.filter(item => item?.active).flatMap(item => {
      const start = String(item.start || "").replaceAll("-", "");
      const end = String(item.end || item.start || "").replaceAll("-", "");
      return /^\d{8}$/.test(start) && /^\d{8}$/.test(end)
        ? [{ outStayFrDt: start, outStayToDt: end, outStayStGbn: "1" }] : [];
    });
  }

  async function route(request, response, phases) {
    const url = new URL(request.url, "http://localhost");
    const holidayCron = request.method === "GET" && url.pathname === "/api/cron/holidays";
    const origin = holidayCron ? "" : guard(request);
    if (stopping && request.method !== "GET") throw new HttpError(503, "서버가 재시작 중입니다. 잠시 후 다시 시도해 주세요.");
    if (request.method === "GET" && ["/", "/app.js"].includes(url.pathname)) {
      const body = url.pathname === "/" ? page : script;
      response.writeHead(200, { "Content-Type": url.pathname === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8", "Content-Length": body.length });
      response.end(body);
      return;
    }
    if (request.method === "GET" && url.pathname === mascotRoute) {
      const body = readFileSync(join(here, "public", "assets", "cbu-sleeping-owl-v2.png"));
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": body.length, "Cache-Control": "public, max-age=31536000, immutable" });
      response.end(body);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      await measure(phases, "databaseMs", () => store.health ? store.health() : store.database.prepare("SELECT 1").get());
      return sendJson(response, 200, { ok: true });
    }
    if (holidayCron) {
      const supplied = Buffer.from(String(request.headers.authorization || ""));
      const expected = Buffer.from(`Bearer ${cronSecret}`);
      if (!holidaySync || !cronSecret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new HttpError(401, "공휴일 동기화 요청을 인증할 수 없습니다.");
      }
      return sendJson(response, 200, await withBusy("holiday-sync", holidaySync));
    }
    await limit(request, ["/api/login", "/api/register", "/api/reconnect", "/api/claim"].includes(url.pathname));
    if (request.method === "GET" && url.pathname === "/api/session") {
      const today = localIsoDate(koreaNow(now()));
      return sendJson(response, 200, { connected: false, ...await currentContext(today, phases) });
    }
    if (request.method === "GET" && url.pathname === "/api/batch/job") {
      const profile = await requireProfile(request);
      let job = await store.job(profile.id, url.searchParams.get("id"));
      if (job?.status === "running" && store.recoverJob) job = await store.recoverJob(profile.id, job.id);
      return sendJson(response, 200, { job });
    }
    if (request.method === "GET" && url.pathname === "/api/batch/history") {
      const profile = await requireProfile(request);
      return sendJson(response, 200, { jobs: await measure(phases, "databaseMs", () => store.jobs(profile.id)) });
    }
    if (request.method === "POST" && url.pathname === "/api/applications") {
      const body = await readJson(request);
      const profile = await requireProfile(request);
      const credentials = liveCredentials(profile, body);
      const applications = await measure(phases, "schoolApplicationsMs", () => withBusy(accountKey(profile), () => portalFactory(credentials).applications()));
      return sendJson(response, 200, { applications });
    }
    if (request.method === "POST" && url.pathname === "/api/batch/reconcile") {
      const body = await readJson(request);
      const { id } = body;
      if (typeof id !== "string") throw new HttpError(400, "확인할 신청 결과를 선택해 주세요.");
      const profile = await requireProfile(request);
      const credentials = liveCredentials(profile, body);
      const job = await measure(phases, "databaseMs", () => store.job(profile.id, id));
      if (!job) throw new HttpError(404, "신청 작업을 찾을 수 없습니다.");
      if (job.status === "running") throw new HttpError(409, "처리 중인 신청은 완료 후 다시 확인해 주세요.");
      const unknown = (job.results || []).map((row, index) => ({ row, index })).filter(item => item.row.status === "unknown");
      if (!unknown.length) return sendJson(response, 200, { job });
      const applications = await measure(phases, "schoolApplicationsMs", () => withBusy(accountKey(profile), () => portalFactory(credentials).applications()));
      const rows = reconciliationRows(applications);
      const resolutions = unknown.map(({ row, index }) => {
        const conflict = findConflict(rows, row.date, row.end || row.date);
        return { index, status: conflict?.type === "same" ? "saved" : conflict ? "overlap" : "not_attempted" };
      });
      const reconciled = await measure(phases, "databaseMs", () => store.reconcileJob(profile.id, id, resolutions));
      if (!reconciled) throw new HttpError(404, "신청 작업을 찾을 수 없습니다.");
      return sendJson(response, 200, { job: reconciled, applications });
    }
    if (request.method === "POST" && url.pathname === "/api/logout") {
      await readJson(request);
      await requireProfile(request);
      await store.claim(cookieValue(request), { now: now().getTime() });
      response.setHeader("Set-Cookie", cookie("", 0));
      return sendJson(response, 200, { connected: false });
    }
    if (request.method === "POST" && url.pathname === "/api/claim") {
      await readJson(request);
      const profile = await store.claim(String(request.headers["x-claim-token"] || ""), { now: now().getTime() });
      if (!profile) throw new HttpError(403, "이 계정 연결 링크는 유효하지 않거나 이미 사용되었습니다.");
      response.setHeader("Set-Cookie", cookie(profile.token));
      return sendJson(response, 200, { connected: true });
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = await readJson(request);
      const credentials = credentialsFrom(body);
      if (store.consumeRate) await store.consumeRate("school-login:" + credentials.studentId.toLowerCase(), 5, 60_000);
      const registrationKey = "registration:" + createHmac("sha256", store.key).update(credentials.studentId.toLowerCase()).digest("hex");
      const login = await withBusy(registrationKey, async () => {
        const portal = portalFactory(credentials);
        await measure(phases, "schoolLoginMs", () => portal.login());
        const existing = await measure(phases, "databaseMs", () => store.reconnect(credentials, { now: now().getTime() }));
        let profile = existing;
        if (!profile) {
          const supplied = Buffer.from(String(request.headers["x-setup-token"] || ""));
          const expected = Buffer.from(setupToken);
          const validSetup = setupToken && supplied.length === expected.length && timingSafeEqual(supplied, expected);
          if (!publicRegistration && !validSetup) throw new HttpError(403, "현재는 새 사용자 로그인을 받을 수 없습니다.");
          if (validSetup && await store.setupUsed(setupToken)) throw new HttpError(410, "이 로그인 링크는 이미 사용되었습니다.");
          profile = await measure(phases, "databaseMs", () => store.create(credentials, validSetup ? setupToken : ""));
        }
        try { return { profile, applications: await measure(phases, "schoolApplicationsMs", () => portal.applications()) }; }
        catch (error) {
          return {
            profile, applications: [],
            applicationsError: error instanceof PortalError ? error.message : "학교 신청내역을 불러오지 못했습니다.",
          };
        }
      });
      response.setHeader("Set-Cookie", cookie(login.profile.token));
      const today = localIsoDate(koreaNow(now()));
      return sendJson(response, 201, {
        connected: true, ...await currentContext(today, phases), createdAt: login.profile.createdAt,
        applications: login.applications, applicationsError: login.applicationsError,
        jobs: await measure(phases, "databaseMs", () => store.jobs(login.profile.id)),
      });
    }
    if (request.method === "POST" && ["/api/register", "/api/reconnect"].includes(url.pathname)) {
      const body = await readJson(request);
      if (await profileFrom(request)) throw new HttpError(409, "이미 계정이 연결되어 있습니다.");
      const reconnect = url.pathname === "/api/reconnect";
      if (!reconnect && !publicRegistration && !setupToken && origin === publicOrigin) throw new HttpError(403, "계정 연결 링크가 필요합니다.");
      const registrationToken = !reconnect && !publicRegistration ? setupToken : "";
      const supplied = Buffer.from(String(request.headers["x-setup-token"] || ""));
      const expected = Buffer.from(registrationToken);
      if (registrationToken && (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))) throw new HttpError(403, "유효한 계정 연결 링크가 필요합니다.");
      const credentials = credentialsFrom(body);
      if (store.consumeRate) await store.consumeRate("school-login:" + credentials.studentId.toLowerCase(), 5, 60_000);
      const registrationKey = publicRegistration ? "registration:" + createHmac("sha256", store.key).update(credentials.studentId.toLowerCase()).digest("hex") : "registration";
      const profile = await withBusy(registrationKey, async () => {
        if (registrationToken && await store.setupUsed(registrationToken)) throw new HttpError(410, "이 계정 연결 링크는 이미 사용되었습니다. 저장된 계정 다시 연결을 이용해 주세요.");
        await measure(phases, "schoolLoginMs", () => portalFactory(credentials).login());
        if (!reconnect) return store.create(credentials, registrationToken);
        const existing = await store.reconnect(credentials, { now: now().getTime() });
        if (!existing) throw new HttpError(403, "다시 연결할 계정이 없습니다. 최초 계정 연결 링크를 이용해 주세요.");
        return existing;
      });
      response.setHeader("Set-Cookie", cookie(profile.token));
      return sendJson(response, 201, { connected: true });
    }
    if (request.method === "POST" && url.pathname === "/api/batch/preview") {
      const profile = await requireProfile(request);
      const dates = batchDatesFrom(await readJson(request), koreaNow(now()));
      const periods = groupBatchDates(dates);
      const id = randomUUID();
      const payload = Buffer.from(JSON.stringify({ id, profileId: profile.id, dates, expires: now().getTime() + 600_000 })).toString("base64url");
      return sendJson(response, 200, {
        id, dates, periods, plan: payload + "." + sign(payload),
        message: `총 ${dates.length}일을 ${periods.length}개 기간으로 신청합니다.`,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/batch/apply") {
      const body = await readJson(request);
      const profile = await requireProfile(request);
      const credentials = liveCredentials(profile, body);
      const plan = decodePlan(body.plan, profile);
      const periods = groupBatchDates(plan.dates).map(({ start, end }) => ({ date: start.replaceAll("-", ""), end: end.replaceAll("-", "") }));
      const existing = await store.job(profile.id, plan.id);
      if (existing) {
        matchJob(existing, periods);
        return sendJson(response, 200, { job: existing });
      }
      if (plan.expires <= now().getTime()) throw new HttpError(409, "미리보기가 만료되었습니다. 대상 날짜를 다시 확인해 주세요.");
      for (const date of plan.dates) periodFrom({ start: date }, koreaNow(now()));
      const job = await measure(phases, "schoolApplyMs", () => startJob(profile, plan.id, periods, options => portalFactory(credentials).applyMany(periods, options)));
      return sendJson(response, 200, { job });
    }
    if (request.method === "POST" && url.pathname === "/api/batch/cancel") {
      const { id } = await readJson(request);
      if (typeof id !== "string") throw new HttpError(400, "처리 중인 신청을 선택해 주세요.");
      const profile = await requireProfile(request);
      const job = await store.job(profile.id, id);
      if (!job) throw new HttpError(404, "신청 작업을 찾을 수 없습니다.");
      if (store.cancelJob) await store.cancelJob(profile.id, id);
      else if (job.status === "running") await store.updateJob(id, "running", { ...job, cancelRequested: true });
      return sendJson(response, 200, { job: await store.job(profile.id, id) });
    }
    if (request.method === "POST" && ["/api/check", "/api/apply"].includes(url.pathname)) {
      const body = await readJson(request);
      const profile = await requireProfile(request);
      const credentials = liveCredentials(profile, body);
      if (url.pathname === "/api/apply") {
        if (typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id)) {
          throw new HttpError(400, "신청 정보를 다시 확인해 주세요.");
        }
        const existing = await store.job(profile.id, body.id);
        if (existing) {
          let period;
          try { period = { date: parseIsoDate(body.start).compact, end: parseIsoDate(body.end || body.start).compact }; }
          catch { throw new HttpError(400, "시작일과 종료일을 확인해 주세요."); }
          matchJob(existing, [period]);
          return sendJson(response, 200, { job: existing });
        }
        const { start, end } = periodFrom(body, koreaNow(now()));
        const job = await measure(phases, "dispatchMs", () => startJob(profile, body.id, [start.compact], async ({ onProgress, shouldStop }) => {
          if (await shouldStop()) return { status: "cancelled", results: [{ date: start.compact, end: end.compact, status: "not_attempted" }], message: "신청을 중단했습니다." };
          await onProgress({ results: [{ date: start.compact, end: end.compact, status: "unknown" }], message: "신청 결과를 확인하고 있습니다." });
          const result = await portalFactory(credentials).apply(start.compact, end.compact, { shouldStop });
          return { ...result, results: [{ date: start.compact, end: end.compact, status: result.status === "cancelled" ? "not_attempted" : result.status }] };
        }, end.compact));
        return sendJson(response, 200, { job });
      }
      const period = periodFrom(body, koreaNow(now()));
      const result = await measure(phases, "schoolCheckMs", () => withBusy(accountKey(profile), () => portalFactory(credentials).apply(period.start.compact, period.end.compact, { dryRun: true })));
      return sendJson(response, 200, result);
    }
    if (request.method === "DELETE" && url.pathname === "/api/account") {
      const profile = await requireProfile(request);
      await withBusy(accountKey(profile), () => store.delete(profile.id));
      response.setHeader("Set-Cookie", cookie("", 0));
      return sendJson(response, 200, { deleted: true });
    }
    throw new HttpError(404, "페이지를 찾을 수 없습니다.");
  }

  async function handler(request, response) {
    const started = Date.now();
    const requestId = randomUUID();
    const phases = {};
    let pathname = "";
    try { pathname = new URL(request.url, "http://localhost").pathname; } catch {}
    const routeName = knownRoutes.has(pathname) ? pathname : "other";
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; style-src 'self' 'unsafe-inline'");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    try { await route(request, response, phases); }
    catch (error) {
      if (response.headersSent) response.destroy();
      else {
        const status = error instanceof HttpError ? error.status : error instanceof PortalError ? 502 : 500;
        if (status === 429) response.setHeader("Retry-After", "60");
        sendJson(response, status, { error: status === 500 ? "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." : error.message, requestId });
      }
    } finally {
      // URL, 본문, 쿠키, 학교 응답 및 예외 원문은 비밀값을 포함할 수 있어 기록하지 않는다.
      logger({ requestId, route: routeName, method: request.method, status: response.statusCode, durationMs: Date.now() - started, phases });
    }
  }
  return { handler, drain: () => Promise.allSettled([...busy.values()]), stop: () => { stopping = true; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { CredentialStore } = await import("./store.mjs");
  process.umask(0o077);
  const store = new CredentialStore(process.env.OVERNIGHT_DATA_DIR || join(here, "data"));
  const app = createApplication({
    store, setupToken: process.env.OVERNIGHT_SETUP_TOKEN || "", publicOrigin: process.env.OVERNIGHT_PUBLIC_ORIGIN || "",
    secureCookie: process.env.NODE_ENV === "production" || process.env.OVERNIGHT_SECURE_COOKIE === "1",
  });
  let ready = false;
  const server = createServer((request, response) => ready ? app.handler(request, response) : sendJson(response, 503, { error: "서버를 준비하고 있습니다." }));
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8787);
  server.on("error", error => {
    console.error("서버를 시작하지 못했습니다:", error.code || "STARTUP_ERROR");
    store.close();
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    try {
      store.acquireRuntime();
      store.recoverJobs();
      ready = true;
      console.log("TUK 외박신청 서비스: http://" + host + ":" + port);
    } catch {
      console.error("서버를 시작하지 못했습니다. 다른 실행 프로세스와 계정 DB 상태를 확인해 주세요.");
      server.close(() => store.close());
      process.exitCode = 1;
    }
  });
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    app.stop();
    const timer = setTimeout(() => process.exit(1), 90_000);
    timer.unref();
    server.close(async () => {
      await app.drain();
      store.close();
      clearTimeout(timer);
    });
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

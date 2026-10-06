import { randomUUID } from "node:crypto";
import { HttpError } from "../service/errors.mjs";

const DAY = 86_400_000;
const KST = 9 * 3_600_000;
const koreaDate = now => new Date(now + KST).toISOString().slice(0, 10);
const koreaTime = value => new Date(new Date(value).getTime() + KST).toISOString().slice(5, 16).replace("T", " ");

export function reportWindow(now = Date.now()) {
  const end = Date.parse(koreaDate(now) + "T00:00:00+09:00");
  return { date: koreaDate(end - DAY), start: new Date(end - DAY).toISOString(),
    end: new Date(end).toISOString(), previousStart: new Date(end - 2 * DAY).toISOString() };
}

const delta = (current, previous) => current === null || previous === null ? "" : ` (전일 ${current - previous >= 0 ? "+" : ""}${current - previous})`;
const mrkdwn = text => ({ type: "mrkdwn", text });
const escape = text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const statusLabel = status => ({ success: "성공", failed: "실패", running: "처리 중", unknown: "전송 확인 필요" }[status] || "기록 없음");

export function buildSlackReport(snapshot, health, { now = Date.now(), origin, date = reportWindow(now).date } = {}) {
  health = { ...health, database: health.database && snapshot?.database.writable !== false };
  const issues = [];
  if (!health.web) issues.push("웹 연결 오류");
  if (!health.database) issues.push("DB 연결 또는 쓰기 오류");
  const p = snapshot?.periods;
  const j = snapshot?.jobs;
  const u = snapshot?.users;
  if (j?.failed) issues.push(`신청 실패 ${j.failed}회`);
  if (j?.interrupted) issues.push(`신청 중단 ${j.interrupted}회`);
  if (p?.unknown) issues.push(`신청 결과 확인 ${p.unknown}건`);
  const dbPercent = snapshot ? Math.ceil(snapshot.database.bytes / (500 * 1024 * 1024) * 100) : null;
  if (dbPercent >= 80) issues.push(`DB 용량 ${dbPercent}%`);
  const recent = kind => snapshot?.recentRuns.filter(row => row.kind === kind) || [];
  const latest = kind => snapshot?.latestRuns.find(row => row.kind === kind);
  const checks = recent("health");
  const holiday = latest("holidays");
  const previousReport = latest("report");
  const trackingAge = u?.trackingStarted ? now - Date.parse(u.trackingStarted) : 0;
  const lastCheck = latest("health");
  if (trackingAge > 8 * 3_600_000 && (!lastCheck || now - Date.parse(lastCheck.started_at) > 8 * 3_600_000)) issues.push("상태 검사 실행 누락");
  if (holiday && holiday.status !== "success") issues.push("공휴일 동기화 확인");
  if (snapshot && (!snapshot.holidayUpdatedAt || now - Date.parse(snapshot.holidayUpdatedAt) > 36 * 3_600_000)) issues.push("공휴일 데이터 갱신 지연");
  if (previousReport && (previousReport.status !== "success" || now - Date.parse(previousReport.finished_at) > 36 * 3_600_000)) issues.push("직전 리포트 전송 확인");
  if (!snapshot) issues.push("사용량 집계 불가");
  const summary = issues.length ? `*확인 필요: ${issues.join(" / ")}*` : "*확인 필요 없음*";
  const users = u ? `*사용자*\n로그인 *${u.active === null ? "미집계" : u.active + "명"}*${delta(u.active, u.previous)}\n신규 ${u.new}명 / 누적 ${u.total}명`
    : "*사용자*\n미집계";
  const jobs = j ? `*신청 결과*\n실행 *${j.total}회*${delta(j.total, j.previous)}\n작업: 완료 ${j.done} / 부분 처리 ${j.partial} / 실패 ${j.failed}`
    + (j.interrupted || j.running ? `\n중단 ${j.interrupted} / 처리 중 ${j.running}` : "")
    + `\n기간별: 접수 완료 ${p.saved || 0} / 기존 신청 제외 ${(p.exists || 0) + (p.overlap || 0)}\n확인 필요 ${p.unknown || 0} / 미처리 ${p.not_attempted || 0}`
    : "*신청 결과*\n미집계";
  const service = `*서비스 상태*\n웹 *${health.web ? "정상" : "오류"}* / DB *${health.database ? "정상" : "오류"}*`
    + `\n응답 ${health.responseMs === null ? "미확인" : health.responseMs + "ms"}`
    + (snapshot ? `\nDB ${Math.ceil(snapshot.database.bytes / 1024 / 1024)}MB / 500MB *(${dbPercent}%)*` : "\nDB 용량 미확인");
  const holidays = holiday ? holiday.status === "success" && holiday.attempts > 1 ? "재시도 후 성공" : statusLabel(holiday.status)
    : snapshot?.holidayUpdatedAt ? "새 작업 기록 없음" : "미확인";
  const regular = "*정기 작업*\n상태 검사 " + (checks.length ? `*${checks.filter(row => row.status === "success").length}/${checks.length} 성공*` : "기록 없음")
    + `\n공휴일 동기화 *${holidays}*`
    + (snapshot?.holidayUpdatedAt ? `\n마지막 성공 ${koreaTime(snapshot.holidayUpdatedAt)}` : "")
    + `\n직전 리포트 *${statusLabel(previousReport?.status)}*`;
  const context = `집계: ${date} 00:00~24:00 KST / 상태: 발송 시점 / 정기 작업: 최근 24시간`;
  const blocks = [
    { type: "header", text: { type: "plain_text", text: `생활관 운영 리포트 | ${date}` } },
    { type: "section", text: mrkdwn(summary) },
    { type: "section", fields: [mrkdwn(users), mrkdwn(jobs)] },
    { type: "section", fields: [mrkdwn(service), mrkdwn(regular)] },
  ];
  if (u && (u.active === null || u.partial || u.previous === null)) blocks.push({ type: "context", elements: [mrkdwn(
    `로그인 집계 시작: ${u.trackingStarted ? koreaTime(u.trackingStarted) + " KST" : "미확인"}. 수집 전 사용자 수와 전일 비교는 미집계입니다.`)] });
  if (issues.length) {
    const actions = [];
    if (j?.failed || j?.interrupted || p?.unknown) actions.push("학교 신청내역과 결과 대조");
    if (!health.web || !health.database || issues.some(value => /누락|동기화|갱신|전송/.test(value))) actions.push("정기 작업 로그와 서비스 콘솔 확인");
    if (dbPercent >= 80) actions.push("DB 보관 기록과 용량 점검");
    if (actions.length) blocks.push({ type: "section", text: mrkdwn(`조치: ${actions.join(" / ")}`) });
  }
  blocks.push({ type: "context", elements: [mrkdwn(`${context}\n<${escape(origin)}|서비스 열기>`)] });
  return { text: [`생활관 운영 리포트 | ${date}`, summary.replaceAll("*", ""), users, jobs, service, regular, context, origin].join("\n").replaceAll("*", ""), blocks };
}

class SlackError extends Error {
  constructor(uncertain = false) { super("슬랙 리포트 전송을 확인해 주세요."); this.uncertain = uncertain; }
}

export async function sendSlackReport(message, { token, userId, fetchImpl = fetch, beforeSend = async () => {} }) {
  if (!token || !/^U[A-Z0-9]+$/.test(userId || "")) throw new HttpError(503, "슬랙 리포트 설정을 확인해 주세요.");
  const api = async (method, body) => {
    let response;
    try {
      response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      if (!response.ok) throw new SlackError(response.status !== 429);
      const result = await response.json();
      if (!result.ok) throw new SlackError();
      return result;
    } catch (error) { throw error instanceof SlackError ? error : new SlackError(true); }
  };
  const conversation = await api("conversations.open", { users: userId });
  if (!/^D[A-Z0-9]+$/.test(conversation.channel?.id || "")) throw new SlackError();
  await beforeSend();
  const result = await api("chat.postMessage", { channel: conversation.channel.id, ...message, unfurl_links: false, unfurl_media: false });
  if (!result.ts) throw new SlackError(true);
  return { channel: conversation.channel.id, ts: result.ts };
}

export function createOperations({ store, origin, holidaySync, token, userId, fetchImpl = fetch, now = Date.now,
  send = (message, options) => sendSlackReport(message, { token, userId, fetchImpl, ...options }),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const probe = async () => {
    const started = performance.now();
    const results = await Promise.allSettled(["/", "/api/health"].map(async path => {
      const response = await fetchImpl(origin + path, { signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store" });
      if (!response.ok) return false;
      if (path === "/") return response.headers.get("content-type")?.includes("text/html") || false;
      return (await response.json()).ok === true;
    }));
    const ok = index => results[index].status === "fulfilled" && results[index].value === true;
    return { web: ok(0), database: ok(1), responseMs: ok(1) ? Math.round(performance.now() - started) : null };
  };
  const health = () => store.withBusy("operations-health", async () => {
    const runKey = randomUUID();
    await store.startOperation("health", runKey, now());
    const result = await probe();
    await store.finishOperation("health", runKey, result.web && result.database ? "success" : "failed", result, now());
    await store.cleanupOperations(now());
    if (!result.web || !result.database) throw new HttpError(503, "서비스 상태 검사가 실패했습니다.");
    return { ok: true };
  });
  const holidays = () => store.withBusy("holiday-sync", async () => {
    const runKey = koreaDate(now());
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!await store.startOperation("holidays", runKey, now())) return { ok: true, skipped: true };
      try {
        result = await holidaySync();
        await store.finishOperation("holidays", runKey, "success", { count: result.count }, now());
        return result;
      } catch {
        await store.finishOperation("holidays", runKey, "failed", { code: "sync_failed" }, now());
        if (!attempt) await sleep(1000);
      }
    }
    throw new HttpError(503, "공휴일 동기화가 실패했습니다. 기존 데이터는 유지됩니다.");
  });
  const report = async () => {
    const window = reportWindow(now());
    for (let attempt = 0; attempt < 3; attempt++) {
      let claimed = false;
      let sending = false;
      try {
        return await store.withBusy("operations-report:" + window.date, async () => {
          const run = await store.startOperation("report", window.date, now());
          if (!run) return { ok: true, skipped: true };
          claimed = true;
          const [data, health] = await Promise.allSettled([store.operationsSnapshot(window, now()), probe()]);
          const snapshot = data.status === "fulfilled" ? data.value : null;
          const state = health.status === "fulfilled" ? health.value : { web: false, database: false, responseMs: null };
          const message = buildSlackReport(snapshot, state, { now: now(), origin, date: window.date });
          const delivered = await send(message, { beforeSend: async () => {
            // Reserve before the network write: a timeout or a crash must never blindly send twice.
            await store.finishOperation("report", window.date, "unknown", { code: "delivery_pending" }, now());
            sending = true;
          } });
          await store.finishOperation("report", window.date, "success", delivered, now());
          return { ok: true, date: window.date };
        });
      } catch (error) {
        if (error.status === 409) return { ok: true, skipped: true };
        const uncertain = sending && !(error instanceof SlackError && !error.uncertain);
        if (claimed) {
          try { await store.finishOperation("report", window.date, uncertain ? "unknown" : "failed", { code: "delivery_failed" }, now()); }
          catch { /* The pre-send reservation remains unknown if the DB cannot record delivery. */ }
        }
        if (!uncertain && attempt < 2 && !(error instanceof HttpError)) {
          await sleep(3000 * (attempt + 1));
          continue;
        }
        throw new HttpError(503, "일일 리포트 전송 상태를 확인해 주세요.");
      }
    }
  };
  return { health, holidays, report };
}

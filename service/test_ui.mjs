import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { historyDate, summarizeJob } from "./public/history.mjs";

const htmlUrl = new URL("./public/index.html", import.meta.url);
const scriptUrl = new URL("./public/app.js", import.meta.url);
const html = readFileSync(htmlUrl, "utf8");
const script = readFileSync(scriptUrl, "utf8");

assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
assert.match(html, /<form id="login-form">[\s\S]*autocomplete="username"[\s\S]*autocomplete="current-password"/);
assert.match(html, /id="calendar-grid" role="grid"/);
assert.match(html, /오늘 포함 7일[\s\S]*오늘 포함 14일[\s\S]*한 달 단위 최대 기간/);
assert.match(html, /매일[\s\S]*평일 전체[\s\S]*주말 전체[\s\S]*지정 요일/);
assert.match(html, /@media \(max-width: 760px\)[\s\S]*\.submit-bar \{ position: fixed/);
assert.match(html, /학교 신청내역[\s\S]*확인 필요[\s\S]*제외·미처리/);
assert.match(html, /달력 직접 선택[\s\S]*자동 선택[\s\S]*id="reconcile-job"/);
assert.match(html, /id="holiday-meta"[\s\S]*공휴일을 제외한/);
assert.doesNotMatch(html, /저장된 계정 다시 연결|계정 연결|학기 퇴관|6개월 퇴관|12개월 퇴관|schedule-meta/);

for (const endpoint of ["/api/login", "/api/applications", "/api/batch/history", "/api/batch/preview", "/api/batch/apply", "/api/batch/reconcile"]) {
  assert.ok(script.includes(endpoint), `${endpoint} UI flow missing`);
}
assert.match(script, /state\.activeJob = job;[\s\S]*renderCalendar/);
assert.match(script, /historyDate\(summary\.first, summary\.last\)[\s\S]*달력에서 보기/);
assert.match(script, /scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
assert.match(script, /status-saved|`status-\$\{mark\}`/);
assert.match(script, /const body = \{ dates \}/);
assert.match(script, /pattern === "weekends"[\s\S]*day === 5/);
assert.match(script, /pattern === "weekdays"[\s\S]*!holidayFor\(value\)/);
assert.match(script, /addDays\(state\.today, state\.maxSelectionDays - 1\)/);
assert.match(script, /preview\.periods\.length/);
assert.doesNotMatch(script, /innerHTML|eval\(/);

const counts = { saved: 1, exists: 0, overlap: 1, unknown: 0, not_attempted: 0 };
assert.deepEqual(summarizeJob({
  status: "done", outcome: "batch",
  results: [{ date: "20260920", end: "20260927" }, { date: "20260929", end: "20260929" }],
}, counts), {
  first: "2026-09-20", last: "2026-09-29", days: 9, label: "신청 완료", tone: "success",
});
assert.equal(summarizeJob({ status: "interrupted", results: [] }, { ...counts, saved: 0, unknown: 1 }).label, "확인 필요");
assert.equal(historyDate("2026-12-31", "2027-01-02"), "2026년 12월 31일 ~ 2027년 1월 2일");

const syntax = spawnSync(process.execPath, ["--check", fileURLToPath(scriptUrl)], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr);

console.log("UI checks passed: single login, 31-day calendar limit, selection patterns, mobile focus, safe DOM rendering");

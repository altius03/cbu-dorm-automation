import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const htmlUrl = new URL("./public/index.html", import.meta.url);
const scriptUrl = new URL("./public/app.js", import.meta.url);
const html = readFileSync(htmlUrl, "utf8");
const script = readFileSync(scriptUrl, "utf8");

assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
assert.match(html, /<form id="login-form">[\s\S]*autocomplete="username"[\s\S]*autocomplete="current-password"/);
assert.match(html, /id="calendar-grid" role="grid"/);
assert.match(html, /31일 이내 선택 가능/);
assert.doesNotMatch(html, /오늘부터 31일 안의 날짜를 선택하세요/);
assert.match(html, /오늘 포함 7일[\s\S]*오늘 포함 14일[\s\S]*한 달 단위 최대 기간/);
assert.match(html, /<strong>매일<\/strong>[\s\S]*<strong>평일<\/strong>[\s\S]*<strong>주말<\/strong>[\s\S]*<strong>요일 지정<\/strong>/);
assert.match(html, /<legend>어떤 날을<\/legend>[\s\S]*<legend>기간<\/legend>/);
assert.match(html, /\.pattern-options \{ grid-template-columns: repeat\(2,[\s\S]*\.range-options \{ grid-template-columns: repeat\(3,/);
assert.match(html, /id="pattern-help"[\s\S]*금요일부터 일요일까지 선택합니다/);
assert.match(html, /id="mode-auto"[^>]*checked/);
assert.doesNotMatch(html, /id="mode-manual"[^>]*checked/);
assert.match(html, /@media \(max-width: 760px\)[\s\S]*\.submit-bar \{ position: fixed/);
assert.match(html, /\.control-panel \{ order: 1; \}[\s\S]*\.calendar-panel \{ order: 2; \}/);
assert.match(html, /학교 신청내역[\s\S]*data-result="saved" hidden[\s\S]*data-result="unknown" hidden[\s\S]*data-result="exists overlap not_attempted" hidden/);
assert.match(html, /#login-status\[data-kind="error"\]/);
assert.match(html, /id="reconcile-job"[\s\S]*자동 선택[\s\S]*달력 직접 선택/);
assert.match(html, /id="holiday-meta"[\s\S]*공휴일을 제외한/);
assert.doesNotMatch(html, /최근 신청 결과|history-list|history-item/);
assert.doesNotMatch(html, /저장된 계정 다시 연결|계정 연결|학기 퇴관|6개월 퇴관|12개월 퇴관|schedule-meta/);

for (const endpoint of ["/api/login", "/api/applications", "/api/batch/history", "/api/batch/preview", "/api/batch/apply", "/api/batch/reconcile"]) {
  assert.ok(script.includes(endpoint), `${endpoint} UI flow missing`);
}
assert.match(script, /state\.activeJob = job;[\s\S]*renderCalendar/);
assert.doesNotMatch(script, /renderHistory|historyDate|historyTime|summarizeJob/);
assert.match(script, /status-saved|`status-\$\{mark\}`/);
assert.match(script, /const body = \{ dates \}/);
assert.match(script, /pattern === "weekends"[\s\S]*day === 5/);
assert.match(script, /pattern === "weekdays"[\s\S]*!holidayFor\(value\)/);
assert.match(script, /addDays\(state\.today, state\.maxSelectionDays - 1\)/);
assert.match(script, /preview\.periods\.length/);
assert.match(script, /function moveMonth\(offset\)[\s\S]*if \(month < state\.today\.slice\(0, 7\)\) return/);
assert.doesNotMatch(script, /month > maxSelectableDate\(\)\.slice\(0, 7\)/);
assert.match(script, /prevMonthButton\.disabled = viewMonth === state\.today\.slice\(0, 7\)/);
assert.match(script, /nextMonthButton\.disabled = false/);
assert.match(script, /if \(!loadError\) show\(""\)/);
assert.doesNotMatch(script, /학교 신청내역을 새로 불러왔습니다/);
assert.match(script, /showLogin\(error\.message, "error"\)/);
assert.match(script, /patternHelp\.textContent = document\.querySelector\('input\[name="pattern"\]:checked'\)\?\.dataset\.help/);
assert.doesNotMatch(script, /innerHTML|eval\(/);

const syntax = spawnSync(process.execPath, ["--check", fileURLToPath(scriptUrl)], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr);

console.log("UI checks passed: single login, 31-day calendar limit, selection patterns, mobile focus, safe DOM rendering");

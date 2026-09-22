import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const htmlUrl = new URL("./public/index.html", import.meta.url);
const scriptUrl = new URL("./public/app.js", import.meta.url);
const mascotUrl = new URL("./public/assets/cbu-sleeping-owl-v2.png", import.meta.url);
const html = readFileSync(htmlUrl, "utf8");
const script = readFileSync(scriptUrl, "utf8");
const mascot = readFileSync(mascotUrl);

assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
assert.match(html, /<meta name="theme-color" content="#ffffff"/);
assert.equal(html.match(/data-theme-toggle/g)?.length, 2);
assert.match(html, /:root\[data-theme="dark"\][\s\S]*--page: #08090b[\s\S]*--surface: #141518[\s\S]*--field: #0e0f12/);
assert.match(html, /@media \(prefers-color-scheme: dark\)/);
assert.match(script, /localStorage\.getItem\("overnight_theme"\)/);
assert.match(script, /matchMedia\("\(prefers-color-scheme: dark\)"\)/);
assert.match(script, /themeColor\.content = theme === "dark" \? "#08090b" : "#ffffff"/);
assert.match(html, /<form id="login-form">[\s\S]*autocomplete="username"[\s\S]*autocomplete="current-password"/);
assert.match(html, /id="password-toggle"[\s\S]*aria-label="비밀번호 보기"[\s\S]*class="password-slash"/);
assert.match(html, /class="club-mark"[\s\S]*외박신청을 더 간편하게[\s\S]*로그인하고 시작하기/);
assert.equal(html.match(/src="\/assets\/cbu-sleeping-owl-v2\.png"/g)?.length, 2);
assert.match(html, /<header class="app-header">[\s\S]*class="club-mark"[\s\S]*외박신청<small>by CBU<\/small>/);
assert.doesNotMatch(html, /brand-mark|<span class="brand-mark">T<\/span>/);
assert.equal(mascot.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.match(html, /<strong>외박신청<\/strong><small>by CBU<\/small>/);
assert.match(html, /.login-brand strong \{ font-size: 32px; font-weight: 600; letter-spacing: -\.04em; \}/);
assert.match(html, /<label for="student-id">포탈 아이디<\/label>/);
assert.match(html, /class="club-link" href="https:\/\/www\.instagram\.com\/tukorea_cbu\/"[\s\S]*한국공학대 개발동아리 CBU[\s\S]*class="external-arrow"[\s\S]*↗/);
assert.equal(html.match(/href="https:\/\/www\.instagram\.com\/tukorea_cbu\/"/g)?.length, 2);
assert.doesNotMatch(html, /\.club-link \{[^}]*background:/);
assert.doesNotMatch(html, /날짜만 고르면 신청은 자동으로|비밀번호는 저장하지 않아요|학교 로그인에만 사용해요|씨부엉이 만들었어요|한국공학대학교 개발동아리/);
assert.doesNotMatch(html, /TUK DORM|외박신청 로그인/);
assert.match(html, /id="calendar-grid" role="grid"/);
assert.doesNotMatch(html, /31일 이내 선택 가능/);
assert.match(html, /\.day\.is-selected:disabled \{ opacity: 1; \}/);
assert.match(html, /\.day:disabled \{ opacity: 1; \}/);
assert.match(script, /iso > maxSelectableDate\(\)[\s\S]*is-unavailable/);
assert.doesNotMatch(html, /오늘부터 31일 안의 날짜를 선택하세요/);
assert.match(html, /<p class="control-copy">외박할 날짜를 선택하세요\.<\/p>/);
assert.match(html, /오늘 포함 7일[\s\S]*오늘 포함 14일[\s\S]*한 달 단위 최대 기간/);
assert.match(html, /<strong>매일<\/strong>[\s\S]*<strong>평일<\/strong>[\s\S]*<strong>요일 지정<\/strong>[\s\S]*<strong>공휴일<\/strong>[\s\S]*<strong>주말<\/strong>/);
assert.match(html, /<h2 id="request-heading">외박 날짜 선택<\/h2>/);
assert.match(html, /<legend>신청할 날<\/legend>[\s\S]*<legend>반복 기간<\/legend>/);
assert.match(html, /\.pattern-options \{ grid-template-columns: repeat\(2,[\s\S]*\.range-options \{ grid-template-columns: repeat\(3,/);
assert.match(html, /\.pattern-options \.featured-pattern \{ grid-column: 1 \/ -1/);
assert.match(html, /id="range-section"/);
assert.match(html, /\.day \.today-label/);
assert.equal(html.match(/type="checkbox" name="pattern"/g)?.length, 5);
assert.doesNotMatch(html, /여러 항목을 함께 선택할 수 있습니다/);
assert.doesNotMatch(html, /기간은 공휴일 외 항목에 적용됩니다/);
assert.match(html, /id="mode-auto"[^>]*checked/);
assert.doesNotMatch(html, /id="mode-manual"[^>]*checked/);
assert.doesNotMatch(html, /name="pattern"[^>]*\bchecked/);
assert.doesNotMatch(html, /name="range"[^>]*\bchecked/);
assert.match(html, /@media \(max-width: 760px\)[\s\S]*\.submit-bar \{ position: fixed/);
assert.match(html, /\.control-panel \{ order: 1; \}[\s\S]*\.calendar-panel \{ order: 2; \}/);
assert.match(html, /\.calendar-column \{ display: contents; \}[\s\S]*\.club-panel \{ order: 3; padding: 0 14px; \}/);
assert.match(html, /class="calendar-column"[\s\S]*class="panel calendar-panel"[\s\S]*class="club-panel"[\s\S]*class="panel control-panel"/);
assert.match(html, /선택한 날[\s\S]*이미 신청한 날[\s\S]*공휴일[\s\S]*data-result="saved" hidden[\s\S]*data-result="unknown" hidden[\s\S]*data-result="exists overlap not_attempted" hidden/);
assert.match(html, /#login-status\[data-kind="error"\]/);
assert.match(html, /<dialog id="service-dialog"[\s\S]*id="dialog-title"[\s\S]*id="dialog-message"[\s\S]*id="dialog-confirm"/);
assert.match(html, /id="dialog-support"[\s\S]*문의 코드[\s\S]*id="dialog-copy"/);
assert.match(html, /\.dialog-actions:has\(#dialog-confirm\[hidden\]\) \{ display: none; \}/);
assert.match(html, /id="reconcile-job"[\s\S]*자동 선택[\s\S]*달력 직접 선택/);
assert.match(html, /id="holiday-meta"/);
assert.match(html, /공휴일 제외 월~금/);
assert.doesNotMatch(html, /최근 신청 결과|history-list|history-item/);
assert.doesNotMatch(html, /저장된 계정 다시 연결|계정 연결|학기 퇴관|6개월 퇴관|12개월 퇴관|schedule-meta/);

for (const endpoint of ["/api/login", "/api/applications", "/api/batch/history", "/api/batch/preview", "/api/batch/apply", "/api/batch/reconcile"]) {
  assert.ok(script.includes(endpoint), `${endpoint} UI flow missing`);
}
assert.match(script, /state\.activeJob = job;[\s\S]*renderCalendar/);
assert.doesNotMatch(script, /renderHistory|historyDate|historyTime|summarizeJob/);
assert.match(script, /status-saved|`status-\$\{mark\}`/);
assert.match(script, /const body = \{ dates \}/);
assert.match(script, /patterns\.has\("weekends"\)[^\n]*day === 5/);
assert.match(script, /patterns\.has\("weekdays"\)[^\n]*holidayFor/);
assert.match(script, /todayLabel\.textContent = "오늘"/);
assert.match(script, /rangeSection\.hidden = patterns\.size === 1 && patterns\.has\("holidays"\)/);
assert.match(script, /addDays\(state\.today, state\.maxSelectionDays - 1\)/);
assert.match(script, /dates\.length === 1 \? `\$\{formatDate\(dates\[0\]\)\} 1일 선택`/);
assert.match(script, /\$\{formatDate\(dates\[0\]\)\}~\$\{formatDate\(dates\.at\(-1\)\)\} 중 \$\{dates\.length\}일 선택/);
assert.match(script, /preview\.periods\.map\([\s\S]*dateSummary/);
assert.match(script, /title: "이 날짜로 신청할까요\?"[\s\S]*총 \$\{preview\.dates\.length\}일/);
assert.doesNotMatch(script, /한 기간은 최대 7박 8일이며 기존 신청일은 제외됩니다/);
assert.match(script, /function moveMonth\(offset\)[\s\S]*if \(month < state\.today\.slice\(0, 7\)\) return/);
assert.doesNotMatch(script, /month > maxSelectableDate\(\)\.slice\(0, 7\)/);
assert.match(script, /prevMonthButton\.disabled = viewMonth === state\.today\.slice\(0, 7\)/);
assert.match(script, /nextMonthButton\.disabled = false/);
assert.match(script, /if \(!loadError\) show\(""\)/);
assert.doesNotMatch(script, /학교 신청내역을 새로 불러왔습니다/);
assert.doesNotMatch(html + script, /학교 신청내역/);
assert.doesNotMatch(html + script, /·/);
assert.doesNotMatch(script, /window\.confirm/);
assert.match(script, /function openDialog\([\s\S]*serviceDialog\.showModal\(\)/);
assert.match(script, /navigator\.clipboard\.writeText\(dialogRequestId\)/);
assert.match(script, /error\.requestId = body\.requestId \|\| requestId/);
assert.match(script, /function showErrorDialog\([\s\S]*confirmLabel: retry \? "다시 시도" : "확인"/);
assert.match(script, /function setPasswordVisible\([\s\S]*비밀번호 숨기기[\s\S]*비밀번호 보기/);
assert.match(script, /applicationSubmitting \? "신청 중…"/);
assert.match(script, /setTimeout\(showProgressDialog, 2000\)/);
assert.match(script, /외박신청을 처리하고 있어요[\s\S]*이 화면을 닫지 마세요\./);
assert.match(script, /closeProgressDialog\(\)[\s\S]*serviceDialog\.dataset\.kind === "progress"/);
assert.match(script, /외박 신청이 완료됐어요/);
assert.match(script, /function resultDateSummary\([\s\S]*item\.status === "saved"[\s\S]*신청 완료[\s\S]*이미 신청한 날[\s\S]*신청하지 못한 날[\s\S]*확인이 필요한 날/);
assert.match(script, /shouldReconcile \? "결과 다시 확인"/);
assert.doesNotMatch(script, /개 기간 신청 완료/);
assert.doesNotMatch(script, /개 기간 기존 신청으로 제외|개 기간 미처리|개 기간 확인 필요/);
assert.match(script, /showLogin\(error\.message, "error"\)/);
assert.doesNotMatch(script, /pageColor/);
assert.doesNotMatch(script, /학교 포탈 계정으로 로그인해 주세요/);
assert.match(script, /로그인 중…" : "로그인하고 시작하기/);
assert.doesNotMatch(script, /innerHTML|eval\(/);

const selectionSource = script.slice(script.indexOf("function dateAt("), script.indexOf("function jobMarks("));
function selectedFor(patterns, { today = "2026-09-22", holidays = [], applications = [], weekdays = [], range = "7" } = {}) {
  const state = { today, holidays: holidays.map(date => ({ date })), applications, maxSelectionDays: 31 };
  const document = {
    querySelector: () => ({ value: range }),
    querySelectorAll: selector => selector.includes('name="pattern"')
      ? patterns.map(value => ({ value }))
      : weekdays.map(value => ({ value: String(value) })),
  };
  return [...runInNewContext(`${selectionSource}\nactiveDates()`, { state, document, manualMode: { checked: false } })];
}
const holidays = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-30", "2026-10-01"];
const applications = [{ active: true, start: "2026-09-25", end: "2026-09-25" }];
assert.deepEqual(selectedFor(["holidays"], { holidays, applications }), [
  "2026-09-23", "2026-09-24", "2026-09-26", "2026-09-29", "2026-09-30",
]);
assert.deepEqual(selectedFor(["holidays"], { today: "2026-09-24", holidays, applications }), [
  "2026-09-24", "2026-09-26", "2026-09-29", "2026-09-30",
]);
assert.deepEqual(selectedFor(["holidays"]), []);
assert.deepEqual(selectedFor([], { range: "" }), []);
assert.deepEqual(selectedFor(["weekends"], { range: "" }), []);
assert.deepEqual(selectedFor(["holidays"], { holidays, applications, range: "" }), [
  "2026-09-23", "2026-09-24", "2026-09-26", "2026-09-29", "2026-09-30",
]);
assert.deepEqual(selectedFor(["holidays", "weekends"], { holidays, applications, range: "" }), []);
assert.deepEqual(selectedFor(["weekdays"], { holidays, applications }), ["2026-09-22", "2026-09-23", "2026-09-28"]);
assert.deepEqual(selectedFor(["holidays", "weekends"], { holidays, applications }), [
  "2026-09-23", "2026-09-24", "2026-09-26", "2026-09-27", "2026-09-29", "2026-09-30",
]);
assert.deepEqual(selectedFor(["custom", "weekends"], { weekdays: [1] }), [
  "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28",
]);
assert.deepEqual(selectedFor(["custom", "weekends"]), []);

const syntax = spawnSync(process.execPath, ["--check", fileURLToPath(scriptUrl)], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr);

console.log("UI checks passed: single login, 31-day calendar limit, selection patterns, mobile focus, safe DOM rendering");

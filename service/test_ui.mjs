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
assert.match(html, /학기 퇴관까지[\s\S]*6개월 퇴관까지[\s\S]*12개월 퇴관까지/);
assert.match(html, /매일[\s\S]*평일 전체[\s\S]*주말 전체[\s\S]*지정 요일/);
assert.match(html, /@media \(max-width: 760px\)[\s\S]*\.submit-bar \{ position: fixed/);
assert.match(html, /학교 신청내역[\s\S]*확인 필요[\s\S]*제외·미처리/);
assert.match(html, /id="schedule-meta"[\s\S]*id="reconcile-job"/);
assert.match(html, /id="holiday-meta"[\s\S]*공휴일을 제외한/);
assert.doesNotMatch(html, /저장된 계정 다시 연결|계정 연결|퇴관일.*(?:input|저장)/);

for (const endpoint of ["/api/login", "/api/applications", "/api/batch/history", "/api/batch/preview", "/api/batch/apply", "/api/batch/reconcile"]) {
  assert.ok(script.includes(endpoint), `${endpoint} UI flow missing`);
}
assert.match(script, /state\.activeJob = job;[\s\S]*renderCalendar/);
assert.match(script, /status-saved|`status-\$\{mark\}`/);
assert.match(script, /const body = \{ dates \}/);
assert.match(script, /pattern === "weekends"[\s\S]*day === 5/);
assert.match(script, /pattern === "weekdays"[\s\S]*!holidayFor\(value\)/);
assert.match(script, /preview\.periods\.length/);
assert.doesNotMatch(script, /innerHTML|eval\(/);

const syntax = spawnSync(process.execPath, ["--check", fileURLToPath(scriptUrl)], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr);

console.log("UI checks passed: single login, calendar results, residence horizons, selection patterns, mobile focus, safe DOM rendering");

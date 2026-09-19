import { historyDate, historyTime, summarizeJob } from "/history.mjs";

const loginSection = document.querySelector("#login-section");
const appSection = document.querySelector("#app-section");
const loginForm = document.querySelector("#login-form");
const requestForm = document.querySelector("#request-form");
const loginStatus = document.querySelector("#login-status");
const status = document.querySelector("#status");
const calendarPanel = document.querySelector(".calendar-panel");
const calendarGrid = document.querySelector("#calendar-grid");
const monthTitle = document.querySelector("#month-title");
const prevMonthButton = document.querySelector("#prev-month");
const nextMonthButton = document.querySelector("#next-month");
const todayMonthButton = document.querySelector("#today-month");
const manualMode = document.querySelector("#mode-manual");
const autoMode = document.querySelector("#mode-auto");
const manualControls = document.querySelector("#manual-controls");
const autoControls = document.querySelector("#auto-controls");
const customWeekdays = document.querySelector("#custom-weekdays");
const selectionSummary = document.querySelector("#selection-summary");
const submitButton = document.querySelector("#submit-selection");
const cancelButton = document.querySelector("#cancel-job");
const refreshButton = document.querySelector("#refresh-data");
const reconcileButton = document.querySelector("#reconcile-job");
const holidayMeta = document.querySelector("#holiday-meta");
const historyList = document.querySelector("#history-list");
const historyEmpty = document.querySelector("#history-empty");
const logoutButton = document.querySelector("#logout");
const deleteButton = document.querySelector("#delete-account");

const state = {
  today: "",
  maxSelectionDays: 31,
  holidays: [],
  viewYear: 0,
  viewMonth: 0,
  manualDates: new Set(),
  applications: [],
  jobs: [],
  activeJob: null,
};
let jobTimer;
let batchRunning = false;
let actionBusy = false;
let checkingJob = false;
let unresolvedJob = false;
let cancelRequested = false;
let requestedJobId;
let activeCredentials;
let pollDelay = 3000;
const pendingKey = "overnight_pending_job";
try { requestedJobId = sessionStorage.getItem(pendingKey) || undefined; } catch {}
const linkParameters = new URLSearchParams(location.hash.slice(1));
const setupToken = linkParameters.get("setup") || "";
const claimToken = linkParameters.get("claim") || "";
if (location.hash) history.replaceState(null, "", location.pathname);

function show(message, kind = "") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function showLogin(message = "") {
  loginStatus.textContent = message;
}

function compactToIso(value) {
  return /^\d{8}$/.test(value || "") ? value.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") : value;
}

function dateAt(iso) {
  return new Date(`${iso}T00:00:00Z`);
}

function isoAt(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(iso, count) {
  const date = dateAt(iso);
  date.setUTCDate(date.getUTCDate() + count);
  return isoAt(date);
}

function datesBetween(start, end) {
  const result = [];
  for (let value = start; value <= end && result.length < 370; value = addDays(value, 1)) result.push(value);
  return result;
}

function formatDate(iso) {
  const [, month, day] = iso.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

function checkedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || "";
}

function selectedWeekdays() {
  return [...document.querySelectorAll('input[name="weekday"]:checked')].map(input => Number(input.value));
}

function rememberJob(id) {
  requestedJobId = id;
  try { if (id) sessionStorage.setItem(pendingKey, id); else sessionStorage.removeItem(pendingKey); } catch {}
}

function hasApplication(iso) {
  return state.applications.some(item => item.active && item.start <= iso && iso <= item.end);
}

function holidayFor(iso) {
  return state.holidays.find(item => item.date === iso);
}

function setConnected(connected) {
  loginSection.hidden = connected;
  appSection.hidden = !connected;
  if (!connected) {
    activeCredentials = undefined;
    clearTimeout(jobTimer);
    batchRunning = false;
    unresolvedJob = false;
    cancelRequested = false;
    rememberJob(undefined);
  }
  updateControls();
}

function credentialBody(value = {}) {
  if (!activeCredentials) throw new Error("학교 포털에 다시 로그인해 주세요.");
  return { ...value, ...activeCredentials };
}

function setBusy(busy) {
  actionBusy = busy;
  updateControls();
}

function activeDates() {
  if (!state.today) return [];
  if (manualMode.checked) return [...state.manualDates]
    .filter(date => state.today <= date && date <= maxSelectableDate() && !hasApplication(date))
    .sort();
  const days = Number(checkedValue("range"));
  if (![7, 14, state.maxSelectionDays].includes(days)) return [];
  const pattern = checkedValue("pattern");
  const weekdays = new Set(selectedWeekdays());
  return datesBetween(state.today, addDays(state.today, days - 1)).filter(value => {
    const day = dateAt(value).getUTCDay();
    if (pattern === "daily") return true;
    if (pattern === "weekdays") return day >= 1 && day <= 5 && !holidayFor(value);
    if (pattern === "weekends") return day === 0 || day === 5 || day === 6;
    return pattern === "custom" && weekdays.has(day);
  }).filter(date => !hasApplication(date));
}

function maxSelectableDate() {
  return addDays(state.today, state.maxSelectionDays - 1);
}

function jobMarks() {
  const marks = new Map();
  for (const item of state.activeJob?.results || []) {
    const start = compactToIso(item.date);
    const end = compactToIso(item.end || item.date);
    for (const date of datesBetween(start, end)) marks.set(date, item.status);
  }
  return marks;
}

const statusNames = {
  saved: "신청 완료", exists: "이미 신청됨", overlap: "기존 신청과 겹침",
  unknown: "확인 필요", not_attempted: "미처리",
};

function renderCalendar() {
  if (!state.today) return;
  const selected = new Set(activeDates());
  const marks = jobMarks();
  const first = new Date(Date.UTC(state.viewYear, state.viewMonth, 1));
  const startOffset = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(state.viewYear, state.viewMonth + 1, 0)).getUTCDate();
  monthTitle.textContent = `${state.viewYear}년 ${state.viewMonth + 1}월`;
  const prefix = `${state.viewYear}-${String(state.viewMonth + 1).padStart(2, "0")}-`;
  const monthHolidays = state.holidays.filter(item => item.date.startsWith(prefix));
  holidayMeta.textContent = monthHolidays.length
    ? `공휴일 · ${monthHolidays.map(item => `${Number(item.date.slice(8))}일 ${item.name}`).join(" · ")}`
    : "";
  holidayMeta.hidden = monthHolidays.length === 0;
  calendarGrid.replaceChildren();

  for (let index = 0; index < 42; index++) {
    const day = index - startOffset + 1;
    if (day < 1 || day > daysInMonth) {
      const blank = document.createElement("span");
      blank.setAttribute("aria-hidden", "true");
      calendarGrid.append(blank);
      continue;
    }
    const iso = `${state.viewYear}-${String(state.viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const button = document.createElement("button");
    const application = hasApplication(iso);
    const holiday = holidayFor(iso);
    const mark = marks.get(iso);
    button.type = "button";
    button.className = "day";
    button.textContent = String(day);
    button.dataset.date = iso;
    if (iso === state.today) button.classList.add("is-today");
    if (iso < state.today) button.classList.add("is-past");
    if (selected.has(iso)) button.classList.add("is-selected");
    if (application) button.classList.add("has-application");
    if (holiday) button.classList.add("is-holiday");
    if (mark) button.classList.add(`status-${mark}`);
    button.dataset.mark = mark === "saved" ? "✓" : mark === "unknown" ? "!" : mark ? "–" : application ? "●" : "";
    const labels = [`${state.viewMonth + 1}월 ${day}일`];
    if (selected.has(iso)) labels.push("선택됨");
    if (application) labels.push("학교 신청내역 있음");
    if (holiday) labels.push(holiday.name);
    if (mark) labels.push(statusNames[mark] || "결과 확인 필요");
    button.setAttribute("aria-label", labels.join(", "));
    if (holiday) button.title = holiday.name;
    button.setAttribute("aria-pressed", String(selected.has(iso)));
    button.disabled = iso < state.today || iso > maxSelectableDate() || application || autoMode.checked || actionBusy || batchRunning || unresolvedJob;
    button.addEventListener("click", () => {
      if (state.manualDates.has(iso)) state.manualDates.delete(iso);
      else state.manualDates.add(iso);
      updateSelection();
    });
    calendarGrid.append(button);
  }
}

function updateSelection() {
  manualControls.hidden = !manualMode.checked;
  autoControls.hidden = manualMode.checked;
  customWeekdays.hidden = checkedValue("pattern") !== "custom";
  const dates = activeDates();
  selectionSummary.textContent = dates.length
    ? `${formatDate(dates[0])}부터 ${formatDate(dates.at(-1))}까지 · ${dates.length}일 선택`
    : manualMode.checked ? "달력에서 날짜를 선택해 주세요." : "신청할 날짜가 없습니다.";
  submitButton.textContent = dates.length ? `선택한 ${dates.length}일 신청하기` : "날짜를 선택해 주세요";
  submitButton.disabled = !dates.length || actionBusy || batchRunning || unresolvedJob;
  renderCalendar();
}

function updateControls() {
  const blocked = actionBusy || batchRunning || unresolvedJob;
  for (const control of requestForm.querySelectorAll("input, button")) control.disabled = blocked;
  for (const control of loginForm.querySelectorAll("input, button")) control.disabled = actionBusy;
  refreshButton.disabled = actionBusy || checkingJob;
  const canReconcile = state.activeJob?.status !== "running" && countStatuses(state.activeJob).unknown > 0;
  reconcileButton.hidden = !canReconcile;
  reconcileButton.disabled = !canReconcile || actionBusy || checkingJob || batchRunning || unresolvedJob;
  logoutButton.disabled = blocked;
  deleteButton.disabled = blocked;
  cancelButton.hidden = !batchRunning;
  cancelButton.disabled = actionBusy || cancelRequested || !batchRunning;
  appSection.setAttribute("aria-busy", String(blocked));
  updateSelection();
}

async function api(path, options = {}) {
  let response;
  try {
    const { timeout = 45_000, ...requestOptions } = options;
    response = await fetch(path, {
      ...requestOptions,
      signal: AbortSignal.timeout(timeout),
      headers: { "Content-Type": "application/json", ...(requestOptions.headers || {}) },
    });
  } catch {
    throw new Error("서버 연결이 끊겼습니다. 처리 결과를 다시 확인해 주세요.");
  }
  let body;
  try { body = await response.json(); }
  catch { throw new Error("서버 응답을 확인할 수 없습니다."); }
  if (!response.ok) {
    const error = new Error(body.error || `요청 실패 (${response.status})`);
    error.status = response.status;
    if (response.status === 401) setConnected(false);
    throw error;
  }
  return body;
}

function configureSession(session) {
  state.today = session.today;
  state.maxSelectionDays = Number.isInteger(session.maxSelectionDays) ? session.maxSelectionDays : 31;
  state.holidays = session.holidays || [];
  state.manualDates.clear();
  const today = dateAt(state.today);
  state.viewYear = today.getUTCFullYear();
  state.viewMonth = today.getUTCMonth();
  updateSelection();
}

function countStatuses(job) {
  const counts = { saved: 0, exists: 0, overlap: 0, unknown: 0, not_attempted: 0 };
  for (const item of job?.results || []) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

function renderHistory() {
  historyList.replaceChildren();
  historyEmpty.hidden = state.jobs.length > 0;
  for (const job of state.jobs) {
    const counts = countStatuses(job);
    const summary = summarizeJob(job, counts);
    const button = document.createElement("button");
    const top = document.createElement("span");
    const title = document.createElement("strong");
    const badge = document.createElement("span");
    const meta = document.createElement("small");
    const countsLine = document.createElement("span");
    const action = document.createElement("span");
    button.type = "button";
    button.className = `history-item history-${summary.tone}`;
    button.dataset.id = job.id;
    button.setAttribute("aria-pressed", String(state.activeJob?.id === job.id));
    title.textContent = historyDate(summary.first, summary.last);
    badge.className = "history-badge";
    badge.textContent = summary.label;
    top.className = "history-top";
    top.append(title, badge);
    const time = historyTime(job.updatedAt);
    meta.className = "history-meta";
    meta.textContent = `${summary.days}일 · ${job.results?.length || 0}개 묶음${time ? ` · ${time}` : ""}`;
    const parts = [];
    if (counts.saved) parts.push(`신청 완료 ${counts.saved}`);
    if (counts.exists + counts.overlap) parts.push(`기존 신청 제외 ${counts.exists + counts.overlap}`);
    if (counts.unknown) parts.push(`확인 필요 ${counts.unknown}`);
    if (counts.not_attempted) parts.push(`미처리 ${counts.not_attempted}`);
    countsLine.className = "history-counts";
    countsLine.textContent = parts.join(" · ") || summary.label;
    action.className = "history-action";
    action.textContent = state.activeJob?.id === job.id ? "달력에 표시 중" : "달력 보기";
    button.setAttribute("aria-label", `${title.textContent}, ${summary.label}, ${meta.textContent}, ${action.textContent}`);
    button.append(top, meta, countsLine, action);
    button.addEventListener("click", () => {
      state.activeJob = job;
      const date = summary.first;
      if (date) {
        const value = dateAt(date);
        state.viewYear = value.getUTCFullYear();
        state.viewMonth = value.getUTCMonth();
      }
      showJob(job, false);
      calendarPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    historyList.append(button);
  }
}

function showJob(job, remember = true) {
  const jobRunning = job.status === "running";
  if (remember) {
    batchRunning = jobRunning;
    unresolvedJob = false;
    cancelRequested = Boolean(job.cancelRequested);
    rememberJob(batchRunning ? job.id : undefined);
    requestedJobId = batchRunning ? job.id : undefined;
  }
  state.activeJob = job;
  const counts = countStatuses(job);
  const completed = counts.saved + counts.exists + counts.overlap;
  const total = job.results?.length || 0;
  const needsCheck = job.status !== "done" || job.outcome === "partial" || job.outcome === "cancelled";
  const message = jobRunning
    ? `${cancelRequested ? "중단 요청됨" : "신청 처리 중"} · ${completed}/${total}개 기간 확인`
    : `${job.message || "처리가 끝났습니다."} · ${counts.saved}개 기간 완료, ${counts.exists + counts.overlap}개 제외${counts.unknown ? `, ${counts.unknown}개 확인 필요` : ""}`;
  show(message, jobRunning ? "" : needsCheck ? "error" : "success");
  renderHistory();
  updateControls();
}

async function loadHistory() {
  const { jobs } = await api("/api/batch/history");
  state.jobs = jobs || [];
  if (state.activeJob) state.activeJob = state.jobs.find(job => job.id === state.activeJob.id) || state.activeJob;
  renderHistory();
}

async function loadApplications() {
  const { applications } = await api("/api/applications", { method: "POST", body: JSON.stringify(credentialBody()) });
  state.applications = applications || [];
  updateSelection();
}

function scheduleJob(id, delay = pollDelay) {
  clearTimeout(jobTimer);
  jobTimer = setTimeout(() => refreshJob(id), delay);
}

async function refreshJob(id = requestedJobId) {
  if (checkingJob) return;
  clearTimeout(jobTimer);
  checkingJob = true;
  updateControls();
  try {
    const { job } = await api("/api/batch/job" + (id ? `?id=${encodeURIComponent(id)}` : ""));
    pollDelay = 3000;
    if (!job) {
      batchRunning = false;
      unresolvedJob = false;
      rememberJob(undefined);
      if (id) show("접수된 작업을 찾지 못했습니다. 최근 결과를 확인해 주세요.", "error");
      return;
    }
    showJob(job);
    if (batchRunning) scheduleJob(job.id);
    else {
      await loadHistory();
      await loadApplications();
    }
  } catch (error) {
    if (error.status === 401) return;
    show(`${error.message} 잠시 후 자동으로 다시 확인합니다.`, "error");
    pollDelay = error.status === 429 ? 60_000 : Math.min(pollDelay * 2, 30_000);
    scheduleJob(id);
  } finally {
    checkingJob = false;
    updateControls();
  }
}

async function submitJob(plan, id) {
  rememberJob(id);
  batchRunning = true;
  unresolvedJob = true;
  updateControls();
  try {
    const { job } = await api("/api/batch/apply", { method: "POST", body: JSON.stringify(credentialBody({ plan })), timeout: 270_000 });
    showJob(job);
    if (batchRunning) scheduleJob(job.id);
    else await loadHistory();
  } catch (error) {
    show(error.message, "error");
    if (error.status && error.status < 500) {
      unresolvedJob = false;
      rememberJob(undefined);
      if (error.status === 409) await refreshJob();
    } else await refreshJob(id);
  }
}

async function loadDashboard(initial = {}) {
  updateSelection();
  const tasks = [];
  if (Array.isArray(initial.jobs)) {
    state.jobs = initial.jobs;
    renderHistory();
  } else tasks.push(loadHistory());
  if (Array.isArray(initial.applications)) {
    state.applications = initial.applications;
    updateSelection();
  } else tasks.push(loadApplications());
  const results = await Promise.allSettled(tasks);
  const failed = results.find(result => result.status === "rejected");
  const loadError = initial.applicationsError || failed?.reason.message;
  if (loadError) show(loadError, "error");
  const running = state.jobs.find(job => job.status === "running");
  if (requestedJobId || running) {
    unresolvedJob = true;
    await refreshJob(requestedJobId || running.id);
  } else {
    updateControls();
    if (!loadError) show("달력에서 날짜를 선택하거나 자동 선택을 이용하세요.");
  }
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!loginForm.reportValidity()) return;
  const form = new FormData(loginForm);
  const credentials = { studentId: form.get("studentId"), password: form.get("password") };
  setBusy(true);
  showLogin("학교 포털 로그인을 확인하고 있습니다…");
  try {
    const session = await api("/api/login", {
      method: "POST",
      headers: setupToken ? { "X-Setup-Token": setupToken } : {},
      body: JSON.stringify(credentials),
    });
    activeCredentials = credentials;
    loginForm.reset();
    showLogin();
    configureSession(session);
    setConnected(true);
    await loadDashboard(session);
  } catch (error) {
    showLogin(error.message);
  } finally { setBusy(false); }
});

requestForm.addEventListener("change", updateSelection);
requestForm.addEventListener("submit", async event => {
  event.preventDefault();
  const dates = activeDates();
  if (!dates.length) return;
  const body = { dates };
  setBusy(true);
  try {
    const preview = await api("/api/batch/preview", { method: "POST", body: JSON.stringify(body) });
    const first = preview.dates[0], last = preview.dates.at(-1);
    if (!window.confirm(`${first} ~ ${last}\n총 ${preview.dates.length}일을 ${preview.periods.length}개 기간으로 묶어 신청할까요?\n한 기간은 최대 7박 8일이며 기존 신청일은 제외됩니다.`)) return;
    setBusy(false);
    await submitJob(preview.plan, preview.id);
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});

prevMonthButton.addEventListener("click", () => {
  if (--state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
  renderCalendar();
});
nextMonthButton.addEventListener("click", () => {
  if (++state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
  renderCalendar();
});
todayMonthButton.addEventListener("click", () => {
  const today = dateAt(state.today);
  state.viewYear = today.getUTCFullYear();
  state.viewMonth = today.getUTCMonth();
  renderCalendar();
});

refreshButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    await Promise.all([loadHistory(), loadApplications()]);
    if (requestedJobId) await refreshJob(requestedJobId);
    else show("학교 신청내역과 최근 결과를 새로 불러왔습니다.", "success");
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});

reconcileButton.addEventListener("click", async () => {
  const id = state.activeJob?.id;
  if (!id || countStatuses(state.activeJob).unknown === 0) return;
  setBusy(true);
  show("학교 신청내역을 읽어 확인 필요 결과를 대조하고 있습니다…");
  try {
    const { job, applications } = await api("/api/batch/reconcile", { method: "POST", body: JSON.stringify(credentialBody({ id })) });
    state.applications = applications || state.applications;
    state.jobs = state.jobs.map(item => item.id === job.id ? job : item);
    showJob(job);
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});

cancelButton.addEventListener("click", async () => {
  if (!requestedJobId || cancelRequested || !batchRunning) return;
  setBusy(true);
  try {
    const { job } = await api("/api/batch/cancel", { method: "POST", body: JSON.stringify({ id: requestedJobId }) });
    showJob(job);
    if (batchRunning) scheduleJob(job.id);
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});

logoutButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    setConnected(false);
    showLogin("로그아웃했습니다.");
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});

deleteButton.addEventListener("click", async () => {
  if (!window.confirm("이 서비스의 계정과 작업 기록을 삭제할까요? 학교에 제출된 신청은 유지됩니다.")) return;
  setBusy(true);
  try {
    await api("/api/account", { method: "DELETE", body: "{}" });
    setConnected(false);
    showLogin("저장정보를 삭제했습니다.");
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});

let claimError;
try {
  if (claimToken) await api("/api/claim", { method: "POST", headers: { "X-Claim-Token": claimToken }, body: "{}" });
} catch (error) { claimError = error; }
try {
  const session = await api("/api/session");
  configureSession(session);
  setConnected(session.connected);
  if (session.connected) await loadDashboard();
  else showLogin(claimError?.message || "학교 포털 계정으로 로그인해 주세요.");
} catch (error) {
  setConnected(false);
  showLogin(error.message);
}

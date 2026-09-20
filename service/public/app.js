const loginSection = document.querySelector("#login-section");
const appSection = document.querySelector("#app-section");
const loginForm = document.querySelector("#login-form");
const requestForm = document.querySelector("#request-form");
const loginButton = loginForm.querySelector('button[type="submit"]');
const passwordInput = document.querySelector("#password");
const passwordToggle = document.querySelector("#password-toggle");
const loginStatus = document.querySelector("#login-status");
const status = document.querySelector("#status");
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
const patternHelp = document.querySelector("#pattern-help");
const selectionSummary = document.querySelector("#selection-summary");
const submitButton = document.querySelector("#submit-selection");
const cancelButton = document.querySelector("#cancel-job");
const refreshButton = document.querySelector("#refresh-data");
const reconcileButton = document.querySelector("#reconcile-job");
const holidayMeta = document.querySelector("#holiday-meta");
const logoutButton = document.querySelector("#logout");
const deleteButton = document.querySelector("#delete-account");
const resultLegends = document.querySelectorAll("[data-result]");
const serviceDialog = document.querySelector("#service-dialog");
const dialogMark = document.querySelector("#dialog-mark");
const dialogTitle = document.querySelector("#dialog-title");
const dialogMessage = document.querySelector("#dialog-message");
const dialogSupport = document.querySelector("#dialog-support");
const dialogCode = document.querySelector("#dialog-code");
const dialogCopy = document.querySelector("#dialog-copy");
const dialogCancel = document.querySelector("#dialog-cancel");
const dialogConfirm = document.querySelector("#dialog-confirm");
const themeColor = document.querySelector('meta[name="theme-color"]');
const themeButtons = document.querySelectorAll("[data-theme-toggle]");
const systemTheme = matchMedia("(prefers-color-scheme: dark)");

function savedTheme() {
  try {
    const value = localStorage.getItem("overnight_theme");
    return value === "light" || value === "dark" ? value : "";
  } catch { return ""; }
}

function applyTheme(theme = savedTheme() || (systemTheme.matches ? "dark" : "light")) {
  document.documentElement.dataset.theme = theme;
  themeColor.content = theme === "dark" ? "#0a0d13" : "#ffffff";
  for (const button of themeButtons) {
    const label = theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환";
    button.textContent = theme === "dark" ? "☀︎" : "☾";
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(theme === "dark"));
    button.title = label;
  }
}

for (const button of themeButtons) button.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("overnight_theme", theme); } catch {}
  applyTheme(theme);
});
systemTheme.addEventListener?.("change", () => { if (!savedTheme()) applyTheme(); });
applyTheme();

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
let applicationSubmitting = false;
let checkingJob = false;
let unresolvedJob = false;
let cancelRequested = false;
let requestedJobId;
let activeCredentials;
let pollDelay = 3000;
const notifiedJobs = new Set();
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

function showLogin(message = "", kind = "") {
  loginStatus.textContent = message;
  loginStatus.dataset.kind = kind;
}

let dialogRequestId = "";

function openDialog({ title, message, confirmLabel = "확인", cancelLabel = "", kind = "confirm", requestId = "" }) {
  const mark = kind === "success" ? "✓" : ["warning", "danger"].includes(kind) ? "!" : "";
  dialogTitle.textContent = title;
  dialogMessage.textContent = message;
  dialogMark.textContent = mark;
  dialogMark.hidden = !mark;
  dialogCancel.textContent = cancelLabel;
  dialogCancel.hidden = !cancelLabel;
  dialogConfirm.textContent = confirmLabel;
  dialogConfirm.hidden = false;
  dialogRequestId = requestId;
  dialogCode.textContent = requestId.slice(0, 8).toUpperCase();
  dialogCopy.textContent = "복사";
  dialogSupport.hidden = !requestId;
  serviceDialog.dataset.kind = kind;
  serviceDialog.returnValue = "";
  serviceDialog.showModal();
  return new Promise(resolve => serviceDialog.addEventListener("close", () => resolve(serviceDialog.returnValue === "confirm"), { once: true }));
}

function showProgressDialog() {
  if (serviceDialog.open) return;
  dialogTitle.textContent = "외박신청을 처리하고 있어요";
  dialogMessage.textContent = "이 화면을 닫지 마세요.";
  dialogMark.hidden = true;
  dialogSupport.hidden = true;
  dialogCancel.hidden = true;
  dialogConfirm.hidden = true;
  serviceDialog.dataset.kind = "progress";
  serviceDialog.showModal();
}

function closeProgressDialog() {
  if (serviceDialog.open && serviceDialog.dataset.kind === "progress") serviceDialog.close();
}

serviceDialog.addEventListener("cancel", event => {
  if (serviceDialog.dataset.kind === "progress") event.preventDefault();
});

dialogCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(dialogRequestId);
    dialogCopy.textContent = "복사됨";
  } catch { dialogCopy.textContent = "복사 실패"; }
});

function showErrorDialog(error, { title = "문제가 발생했어요", retry = false } = {}) {
  return openDialog({
    title,
    message: error.message,
    confirmLabel: retry ? "다시 시도" : "확인",
    cancelLabel: retry ? "닫기" : "",
    kind: "warning",
    requestId: error.requestId || "",
  });
}

function setPasswordVisible(visible) {
  passwordInput.type = visible ? "text" : "password";
  passwordToggle.setAttribute("aria-pressed", String(visible));
  passwordToggle.setAttribute("aria-label", visible ? "비밀번호 숨기기" : "비밀번호 보기");
}

passwordToggle.addEventListener("click", () => setPasswordVisible(passwordInput.type === "password"));

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
    setPasswordVisible(false);
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
  if (!activeCredentials) throw new Error("학교 포탈에 다시 로그인해 주세요.");
  return { ...value, ...activeCredentials };
}

function setBusy(busy) {
  actionBusy = busy;
  loginButton.textContent = busy && !loginSection.hidden ? "로그인 중…" : "로그인하고 시작하기";
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
    if (pattern === "weekdays") return day >= 1 && day <= 5;
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
  const markStatuses = new Set(marks.values());
  const first = new Date(Date.UTC(state.viewYear, state.viewMonth, 1));
  const startOffset = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(state.viewYear, state.viewMonth + 1, 0)).getUTCDate();
  monthTitle.textContent = `${state.viewYear}년 ${state.viewMonth + 1}월`;
  const prefix = `${state.viewYear}-${String(state.viewMonth + 1).padStart(2, "0")}-`;
  const monthHolidays = state.holidays.filter(item => item.date.startsWith(prefix));
  holidayMeta.textContent = monthHolidays.length
    ? `공휴일: ${monthHolidays.map(item => `${Number(item.date.slice(8))}일 ${item.name}`).join(", ")}`
    : "";
  holidayMeta.hidden = monthHolidays.length === 0;
  for (const legend of resultLegends) {
    legend.hidden = !legend.dataset.result.split(" ").some(result => markStatuses.has(result));
  }
  const viewMonth = `${state.viewYear}-${String(state.viewMonth + 1).padStart(2, "0")}`;
  prevMonthButton.disabled = viewMonth === state.today.slice(0, 7);
  nextMonthButton.disabled = false;
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
    if (iso > maxSelectableDate()) button.classList.add("is-unavailable");
    if (selected.has(iso)) button.classList.add("is-selected");
    if (application) button.classList.add("has-application");
    if (holiday) button.classList.add("is-holiday");
    if (mark) button.classList.add(`status-${mark}`);
    button.dataset.mark = mark === "saved" ? "✓" : mark === "unknown" ? "!" : mark ? "–" : application ? "●" : "";
    const labels = [`${state.viewMonth + 1}월 ${day}일`];
    if (selected.has(iso)) labels.push("선택됨");
    if (application) labels.push("이미 신청한 날");
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
  patternHelp.textContent = document.querySelector('input[name="pattern"]:checked')?.dataset.help || "";
  const dates = activeDates();
  selectionSummary.textContent = dates.length
    ? dates.length === 1 ? `${formatDate(dates[0])} 1일 선택` : `${formatDate(dates[0])}~${formatDate(dates.at(-1))} 중 ${dates.length}일 선택`
    : manualMode.checked ? "달력에서 날짜를 선택해 주세요." : "신청할 날짜가 없습니다.";
  submitButton.textContent = applicationSubmitting ? "신청 중…" : dates.length ? `선택한 ${dates.length}일 신청하기` : "날짜를 선택해 주세요";
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
  const requestId = response.headers.get("x-request-id") || "";
  try { body = await response.json(); }
  catch {
    const error = new Error("서버 응답을 확인할 수 없습니다.");
    error.requestId = requestId;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body.error || `요청 실패 (${response.status})`);
    error.status = response.status;
    error.requestId = body.requestId || requestId;
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

function resultDateSummary(items) {
  return items.map(item => {
    const start = compactToIso(item.date), end = compactToIso(item.end || item.date);
    return start === end ? formatDate(start) : `${formatDate(start)}~${formatDate(end)}`;
  }).join(", ");
}

async function showJobResult(job, needsCheck) {
  const results = job.results || [];
  const lines = [];
  const saved = results.filter(item => item.status === "saved");
  const existing = results.filter(item => item.status === "exists" || item.status === "overlap");
  const notAttempted = results.filter(item => item.status === "not_attempted");
  const unknown = results.filter(item => item.status === "unknown");
  const hasOtherResults = existing.length || notAttempted.length || unknown.length;
  if (saved.length) {
    const savedDays = saved.reduce((total, item) => total + datesBetween(compactToIso(item.date), compactToIso(item.end || item.date)).length, 0);
    if (hasOtherResults) lines.push(`신청 완료\n${resultDateSummary(saved)}`);
    else lines.push(resultDateSummary(saved), `총 ${savedDays}일`);
  }
  if (existing.length) lines.push(`이미 신청한 날\n${resultDateSummary(existing)}`);
  if (notAttempted.length) lines.push(`신청하지 못한 날\n${resultDateSummary(notAttempted)}`);
  if (unknown.length) lines.push(`확인이 필요한 날\n${resultDateSummary(unknown)}`);
  const shouldReconcile = unknown.length > 0;
  const confirmed = await openDialog({
    title: needsCheck ? "신청 결과를 확인해 주세요" : "외박 신청이 완료됐어요",
    message: lines.join(hasOtherResults ? "\n\n" : "\n") || job.message || "신청 처리가 끝났습니다.",
    confirmLabel: shouldReconcile ? "결과 다시 확인" : "확인",
    cancelLabel: shouldReconcile ? "닫기" : "",
    kind: needsCheck ? "warning" : "success",
  });
  if (shouldReconcile && confirmed) await reconcileActiveJob();
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
  if (jobRunning) show(`${cancelRequested ? "중단 요청됨" : "신청 처리 중"} ${completed}/${total}개 기간 확인`);
  else {
    show("");
    if (job.id && !notifiedJobs.has(job.id)) {
      notifiedJobs.add(job.id);
      void showJobResult(job, needsCheck);
    }
  }
  updateControls();
}

async function loadHistory() {
  const { jobs } = await api("/api/batch/history");
  state.jobs = jobs || [];
  if (state.activeJob) state.activeJob = state.jobs.find(job => job.id === state.activeJob.id) || state.activeJob;
  else state.activeJob = state.jobs.find(job => countStatuses(job).unknown > 0) || null;
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
      if (id) show("접수된 작업을 찾지 못했습니다. 새로고침 후 다시 확인해 주세요.", "error");
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
  applicationSubmitting = true;
  updateControls();
  const progressTimer = setTimeout(showProgressDialog, 2000);
  const finishProgress = () => {
    clearTimeout(progressTimer);
    closeProgressDialog();
    applicationSubmitting = false;
  };
  try {
    const { job } = await api("/api/batch/apply", { method: "POST", body: JSON.stringify(credentialBody({ plan })), timeout: 270_000 });
    finishProgress();
    showJob(job);
    if (batchRunning) scheduleJob(job.id);
    else await loadHistory();
  } catch (error) {
    finishProgress();
    show("");
    await showErrorDialog(error, { title: error.status && error.status < 500 ? "신청을 시작하지 못했어요" : "신청 결과를 바로 확인하지 못했어요" });
    if (error.status && error.status < 500) {
      batchRunning = false;
      unresolvedJob = false;
      rememberJob(undefined);
      if (error.status === 409) await refreshJob();
    } else await refreshJob(id);
  } finally {
    finishProgress();
    updateControls();
  }
}

async function loadDashboard(initial = {}) {
  updateSelection();
  const tasks = [];
  if (Array.isArray(initial.jobs)) {
    state.jobs = initial.jobs;
    state.activeJob = state.jobs.find(job => countStatuses(job).unknown > 0) || null;
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
    if (!loadError) show("");
  }
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!loginForm.reportValidity()) return;
  const form = new FormData(loginForm);
  const credentials = { studentId: form.get("studentId"), password: form.get("password") };
  setBusy(true);
  showLogin("학교 포탈 로그인을 확인하고 있습니다…");
  try {
    const session = await api("/api/login", {
      method: "POST",
      headers: setupToken ? { "X-Setup-Token": setupToken } : {},
      body: JSON.stringify(credentials),
    });
    activeCredentials = credentials;
    loginForm.reset();
    setPasswordVisible(false);
    showLogin();
    configureSession(session);
    setConnected(true);
    await loadDashboard(session);
  } catch (error) {
    showLogin();
    await showErrorDialog(error, { title: "로그인하지 못했어요" });
  } finally { setBusy(false); }
});

requestForm.addEventListener("change", updateSelection);
requestForm.addEventListener("submit", async event => {
  event.preventDefault();
  const dates = activeDates();
  if (!dates.length) return;
  const body = { dates };
  let retry = false;
  setBusy(true);
  try {
    const preview = await api("/api/batch/preview", { method: "POST", body: JSON.stringify(body) });
    const dateSummary = preview.periods.map(({ start, end }) => start === end ? formatDate(start) : `${formatDate(start)}~${formatDate(end)}`).join(", ");
    const confirmed = await openDialog({
      title: "이 날짜로 신청할까요?",
      message: `${dateSummary}\n총 ${preview.dates.length}일`,
      confirmLabel: "신청하기",
      cancelLabel: "취소",
    });
    if (!confirmed) return;
    setBusy(false);
    await submitJob(preview.plan, preview.id);
  } catch (error) {
    retry = await showErrorDialog(error, { title: "신청을 시작하지 못했어요", retry: error.status !== 401 });
  }
  finally { setBusy(false); }
  if (retry) requestForm.requestSubmit();
});

function moveMonth(offset) {
  const candidate = new Date(Date.UTC(state.viewYear, state.viewMonth + offset, 1));
  const month = isoAt(candidate).slice(0, 7);
  if (month < state.today.slice(0, 7)) return;
  state.viewYear = candidate.getUTCFullYear();
  state.viewMonth = candidate.getUTCMonth();
  renderCalendar();
}

prevMonthButton.addEventListener("click", () => moveMonth(-1));
nextMonthButton.addEventListener("click", () => moveMonth(1));
todayMonthButton.addEventListener("click", () => {
  const today = dateAt(state.today);
  state.viewYear = today.getUTCFullYear();
  state.viewMonth = today.getUTCMonth();
  renderCalendar();
});

refreshButton.addEventListener("click", async () => {
  let retry = false;
  setBusy(true);
  try {
    await Promise.all([loadHistory(), loadApplications()]);
    if (requestedJobId) await refreshJob(requestedJobId);
    else show("");
  } catch (error) {
    show("");
    retry = await showErrorDialog(error, { title: "새로고침하지 못했어요", retry: error.status !== 401 });
  }
  finally { setBusy(false); }
  if (retry) refreshButton.click();
});

async function reconcileActiveJob() {
  const id = state.activeJob?.id;
  if (!id || countStatuses(state.activeJob).unknown === 0) return;
  setBusy(true);
  show("이미 신청한 날짜를 불러와 결과를 다시 확인하고 있어요…");
  let retry = false;
  try {
    const { job, applications } = await api("/api/batch/reconcile", { method: "POST", body: JSON.stringify(credentialBody({ id })) });
    state.applications = applications || state.applications;
    state.jobs = state.jobs.map(item => item.id === job.id ? job : item);
    notifiedJobs.delete(job.id);
    showJob(job);
  } catch (error) {
    show("");
    retry = await showErrorDialog(error, { title: "결과를 다시 확인하지 못했어요", retry: error.status !== 401 });
  }
  finally { setBusy(false); }
  if (retry) await reconcileActiveJob();
}

reconcileButton.addEventListener("click", reconcileActiveJob);

cancelButton.addEventListener("click", async () => {
  if (!requestedJobId || cancelRequested || !batchRunning) return;
  let retry = false;
  setBusy(true);
  try {
    const { job } = await api("/api/batch/cancel", { method: "POST", body: JSON.stringify({ id: requestedJobId }) });
    showJob(job);
    if (batchRunning) scheduleJob(job.id);
  } catch (error) {
    retry = await showErrorDialog(error, { title: "중단을 요청하지 못했어요", retry: error.status !== 401 });
  }
  finally { setBusy(false); }
  if (retry) cancelButton.click();
});

logoutButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    setConnected(false);
    showLogin("로그아웃했습니다.");
  } catch (error) { await showErrorDialog(error, { title: "로그아웃하지 못했어요" }); }
  finally { setBusy(false); }
});

deleteButton.addEventListener("click", async () => {
  const confirmed = await openDialog({
    title: "서비스 기록을 삭제할까요?",
    message: "이 서비스에 저장된 계정과 작업 기록만 삭제합니다. 학교에 제출된 신청은 유지됩니다.",
    confirmLabel: "삭제",
    cancelLabel: "취소",
    kind: "danger",
  });
  if (!confirmed) return;
  setBusy(true);
  try {
    await api("/api/account", { method: "DELETE", body: "{}" });
    setConnected(false);
    showLogin("저장정보를 삭제했습니다.");
  } catch (error) { await showErrorDialog(error, { title: "기록을 삭제하지 못했어요" }); }
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
  else if (claimError) showLogin(claimError.message, "error");
  else showLogin();
} catch (error) {
  setConnected(false);
  showLogin(error.message, "error");
}

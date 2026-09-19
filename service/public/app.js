const connectSection = document.querySelector("#connect-section");
const applySection = document.querySelector("#apply-section");
const connectForm = document.querySelector("#connect-form");
const applyForm = document.querySelector("#apply-form");
const batchForm = document.querySelector("#batch-form");
const checkButton = document.querySelector("#check");
const batchPreviewButton = document.querySelector("#batch-preview");
const deleteButton = document.querySelector("#delete-account");
const startInput = document.querySelector("#start");
const endInput = document.querySelector("#end");
const batchKind = document.querySelector("#batch-kind");
const refreshJobButton = document.querySelector("#refresh-job");
const cancelButton = document.querySelector("#cancel-job");
const historySelect = document.querySelector("#job-history");
const reconnectButton = document.querySelector("#reconnect");
const logoutButton = document.querySelector("#logout");
const status = document.querySelector("#status");
let jobTimer;
let batchRunning = false;
let actionBusy = false;
let checkingJob = false;
let unresolvedJob = false;
let cancelRequested = false;
let requestedJobId;
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

function rememberJob(id) {
  requestedJobId = id;
  try { if (id) sessionStorage.setItem(pendingKey, id); else sessionStorage.removeItem(pendingKey); } catch {}
}

function setConnected(connected) {
  connectSection.hidden = connected;
  applySection.hidden = !connected;
  if (!connected) {
    clearTimeout(jobTimer);
    batchRunning = false;
    unresolvedJob = false;
    cancelRequested = false;
    rememberJob(undefined);
    setBusy(false);
  }
}

function setBusy(busy) {
  actionBusy = busy;
  updateControls();
}

function updateControls() {
  const blocked = actionBusy || batchRunning || unresolvedJob;
  for (const control of document.querySelectorAll("button, input, select")) control.disabled = blocked;
  refreshJobButton.disabled = actionBusy || checkingJob;
  cancelButton.hidden = !batchRunning;
  cancelButton.disabled = actionBusy || cancelRequested || !batchRunning;
  applySection.setAttribute("aria-busy", String(blocked));
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      signal: AbortSignal.timeout(45_000),
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } catch {
    throw new Error("서버 연결이 끊겼습니다. 처리 결과를 다시 확인하고 있습니다.");
  }
  let body;
  try { body = await response.json(); }
  catch { throw new Error("서버 응답을 확인할 수 없습니다. 처리 결과를 다시 확인해 주세요."); }
  if (!response.ok) {
    const error = new Error(body.error || "요청 실패 (" + response.status + ")");
    error.status = response.status;
    if (response.status === 401) setConnected(false);
    throw error;
  }
  return body;
}

function dates() {
  return { start: startInput.value, end: endInput.value || startInput.value };
}

const batchPreview = () => api("/api/batch/preview", {
  method: "POST", body: JSON.stringify({ kind: batchKind.value }),
});

function iso(value) { return value.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"); }

function showJob(job) {
  batchRunning = job.status === "running";
  unresolvedJob = false;
  cancelRequested = Boolean(job.cancelRequested);
  rememberJob(batchRunning ? job.id : undefined);
  requestedJobId = job.id;
  const names = { saved: "신청 완료", exists: "이미 신청됨", overlap: "겹쳐서 제외", unknown: "확인 필요", not_attempted: "신청하지 않음" };
  const details = (job.results || []).map(item => {
    const period = iso(item.date) + (item.end && item.end !== item.date ? " ~ " + iso(item.end) : "");
    return period + ": " + (names[item.status] || "확인 필요");
  }).join("\n");
  const needsCheck = job.status !== "done" || job.outcome === "partial" || job.outcome === "cancelled";
  const prefix = batchRunning ? cancelRequested ? "현재 건 확인 후 중단합니다.\n" : "처리 중 · " : "";
  show(prefix + job.message + "\n" + details, batchRunning ? "" : needsCheck ? "error" : "success");
  updateControls();
}

async function loadHistory() {
  try {
    const { jobs } = await api("/api/batch/history");
    historySelect.replaceChildren(new Option(jobs.length ? "이전 결과 선택" : "기록 없음", ""));
    for (const job of jobs) {
      const first = job.results?.[0]?.date;
      const label = (first ? iso(first) + " · " : "") + job.message;
      historySelect.add(new Option(label, job.id));
    }
  } catch {
    historySelect.replaceChildren(new Option("기록을 불러오지 못했습니다. 결과 확인을 눌러 다시 시도해 주세요.", ""));
  }
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
    const { job } = await api("/api/batch/job" + (id ? "?id=" + encodeURIComponent(id) : ""));
    pollDelay = 3000;
    if (!job) {
      batchRunning = false;
      unresolvedJob = false;
      rememberJob(undefined);
      show(id ? "접수된 작업이 없습니다. 신청 내용을 확인한 뒤 다시 진행해 주세요." : "저장된 신청 결과가 없습니다.");
      return;
    }
    showJob(job);
    if (batchRunning) scheduleJob(job.id);
    else await loadHistory();
  } catch (error) {
    if (error.status === 401) return;
    show(error.message + "\n잠시 후 자동으로 다시 조회합니다. ‘처리 결과 다시 확인’도 이용할 수 있습니다.", "error");
    pollDelay = error.status === 429 ? 60_000 : Math.min(pollDelay * 2, 30_000);
    scheduleJob(id);
  } finally {
    checkingJob = false;
    updateControls();
  }
}

refreshJobButton.addEventListener("click", () => refreshJob());
historySelect.addEventListener("change", () => {
  if (historySelect.value) refreshJob(historySelect.value);
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

async function submitJob(path, body, id) {
  rememberJob(id);
  unresolvedJob = true;
  updateControls();
  try {
    const { job } = await api(path, { method: "POST", body: JSON.stringify(body) });
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

async function connect(path) {
  if (!connectForm.reportValidity()) return;
  const form = new FormData(connectForm);
  setBusy(true);
  show("학교 계정을 확인하고 있습니다…");
  try {
    await api(path, {
      method: "POST",
      headers: setupToken ? { "X-Setup-Token": setupToken } : {},
      body: JSON.stringify({ studentId: form.get("studentId"), password: form.get("password") }),
    });
    connectForm.reset();
    setConnected(true);
    show("계정이 연결되었습니다. 날짜 또는 일괄신청 방식을 선택해 주세요.", "success");
    await refreshJob();
  } catch (error) {
    // 로그인 응답만 유실됐어도 이미 쿠키가 설정됐을 수 있다.
    try {
      const session = await api("/api/session");
      if (session.connected) { setConnected(true); connectForm.reset(); await refreshJob(); return; }
    } catch {}
    show(error.message + "\n기존에 연결한 계정이라면 ‘저장된 계정 다시 연결’을 이용해 주세요.", "error");
  } finally { setBusy(false); }
}
connectForm.addEventListener("submit", event => { event.preventDefault(); return connect("/api/register"); });
reconnectButton.addEventListener("click", () => connect("/api/reconnect"));

checkButton.addEventListener("click", async () => {
  if (!applyForm.reportValidity()) return;
  setBusy(true);
  show("신청 가능 여부를 확인하고 있습니다…");
  try {
    const result = await api("/api/check", { method: "POST", body: JSON.stringify(dates()) });
    show(result.message, "success");
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});
applyForm.addEventListener("submit", async event => {
  event.preventDefault();
  const period = dates();
  if (!window.confirm(period.start + " ~ " + period.end + " 외박을 실제로 신청할까요?")) return;
  setBusy(true);
  try {
    const id = crypto.randomUUID();
    await submitJob("/api/apply", { ...period, id }, id);
  } finally { setBusy(false); }
});

batchPreviewButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    const result = await batchPreview();
    show(result.message + "\n" + result.dates.join(", "), "success");
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});
batchForm.addEventListener("submit", async event => {
  event.preventDefault();
  setBusy(true);
  try {
    const preview = await batchPreview();
    show(preview.message + "\n" + preview.dates.join(", "), "success");
    if (!window.confirm(preview.dates[0] + " ~ " + preview.dates.at(-1) + "\n" + preview.message + "\n기존 신청과 겹치는 날짜는 제외됩니다. 실제로 진행할까요?")) return;
    await submitJob("/api/batch/apply", { plan: preview.plan }, preview.id);
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});

logoutButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    await api("/api/logout", { method: "POST" });
    setConnected(false);
    show("로그아웃했습니다. 학교 계정으로 다시 연결할 수 있습니다.");
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});
deleteButton.addEventListener("click", async () => {
  if (!window.confirm("저장된 학교 계정과 이 서비스의 작업 기록을 삭제할까요? 학교에 이미 제출한 신청은 유지됩니다.")) return;
  setBusy(true);
  try {
    await api("/api/account", { method: "DELETE" });
    setConnected(false);
    show("저장된 계정과 작업 기록을 삭제했습니다.", "success");
  } catch (error) { show(error.message, "error"); }
  finally { setBusy(false); }
});
startInput.addEventListener("change", () => {
  endInput.min = startInput.value || startInput.min;
  if (endInput.value && endInput.value < startInput.value) endInput.value = startInput.value;
});

let claimError;
try {
  if (claimToken) await api("/api/claim", { method: "POST", headers: { "X-Claim-Token": claimToken } });
} catch (error) { claimError = error; }
try {
  const session = await api("/api/session");
  startInput.min = session.today;
  endInput.min = session.today;
  setConnected(session.connected);
  if (session.connected) {
    unresolvedJob = Boolean(requestedJobId);
    updateControls();
    await loadHistory();
    await refreshJob();
  } else show(claimError?.message || "학교 계정을 연결해 주세요. 이전에 연결했다면 ‘저장된 계정 다시 연결’을 이용할 수 있습니다.");
} catch (error) {
  setConnected(false);
  show(error.message, "error");
}

import { validatePeriod } from "./core.mjs";

const DREAM_PREFIX = "https://dream.tukorea.ac.kr/nx/";
const form = document.querySelector("#form");
const startInput = document.querySelector("#start");
const endInput = document.querySelector("#end");
const checkButton = document.querySelector("#check");
const submitButton = document.querySelector("#submit");
const status = document.querySelector("#status");

function show(message, kind = "") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setBusy(busy) {
  checkButton.disabled = busy;
  submitButton.disabled = busy;
}

async function run(mode) {
  let period;
  try {
    period = validatePeriod(startInput.value, endInput.value);
  } catch (error) {
    show(error.message, "error");
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith(DREAM_PREFIX)) {
    show("통합정보시스템 외박신청 탭을 연 뒤 다시 실행하세요.", "error");
    return;
  }

  setBusy(true);
  show(mode === "save" ? "신청 중입니다…" : "신청 가능 여부를 확인 중입니다…");
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: portalTask,
      args: [{
        mode,
        start: period.start.compact,
        end: period.end.compact,
      }],
    });
    if (!result?.ok) throw new Error(result?.message || "포탈 요청에 실패했습니다.");
    show(result.message, "success");
  } catch (error) {
    show(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

checkButton.addEventListener("click", () => run("check"));
form.addEventListener("submit", event => {
  event.preventDefault();
  run("save");
});

async function portalTask(request) {
  const NS = "http://www.nexacroplatform.com/platform/dataset";
  const MENU = "menuId=MPB0022&pgmId=PPB0021";

  const localName = node => node.localName || node.nodeName.split(":").pop();
  const encode = value => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

  function requestParameters(extra = {}) {
    const wanted = new Set(["hakbun", "USER_HAKBUN", "userid", "USER_NAME", "USER_ID"]);
    const params = {};
    for (const pair of document.cookie.split(";")) {
      const index = pair.indexOf("=");
      if (index < 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1);
      if (wanted.has(name)) params[name] = value;
    }
    params.requestTimeStr = String(Date.now());
    return { ...params, ...extra };
  }

  function buildRequest(parameters, dataset) {
    const parameterXml = Object.entries(parameters)
      .map(([key, value]) => `<Parameter id="${encode(key)}">${encode(value)}</Parameter>`)
      .join("");
    let datasetXml = "";
    if (dataset) {
      const columnId = column => Array.isArray(column) ? column[0] : column;
      const columns = dataset.columns
        .map(column => {
          const [id, type = "STRING", size = "256"] = Array.isArray(column)
            ? column
            : [column];
          return `<Column id="${encode(id)}" type="${encode(type)}" size="${encode(size)}"/>`;
        })
        .join("");
      const values = dataset.columns
        .map(columnId)
        .filter(column => dataset.row[column] !== undefined && dataset.row[column] !== null)
        .map(column => `<Col id="${encode(column)}">${encode(dataset.row[column])}</Col>`)
        .join("");
      const type = dataset.type ? ` type="${encode(dataset.type)}"` : "";
      const original = dataset.original === undefined
        ? ""
        : `<OrgRow>${dataset.columns
            .map(columnId)
            .filter(column => dataset.original[column] !== undefined && dataset.original[column] !== null)
            .map(column => `<Col id="${encode(column)}">${encode(dataset.original[column])}</Col>`)
            .join("")}</OrgRow>`;
      datasetXml = `<Dataset id="${encode(dataset.id)}"><ColumnInfo>${columns}</ColumnInfo><Rows><Row${type}>${values}${original}</Row></Rows></Dataset>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?><Root xmlns="${NS}"><Parameters>${parameterXml}</Parameters>${datasetXml}</Root>`;
  }

  function parseResponse(text) {
    const documentXml = new DOMParser().parseFromString(text, "application/xml");
    if (documentXml.querySelector("parsererror")) {
      throw new Error("학교 서버가 로그인 페이지 또는 잘못된 응답을 반환했습니다.");
    }
    const parameters = {};
    const datasets = {};
    for (const node of documentXml.getElementsByTagName("*")) {
      if (localName(node) === "Parameter") parameters[node.getAttribute("id")] = node.textContent || "";
      if (localName(node) !== "Dataset") continue;
      const rows = [];
      for (const rowNode of node.getElementsByTagName("*")) {
        if (localName(rowNode) !== "Row") continue;
        const row = {};
        for (const column of rowNode.children) {
          if (localName(column) === "Col") row[column.getAttribute("id")] = column.textContent || "";
        }
        rows.push(row);
      }
      datasets[node.getAttribute("id")] = rows;
    }
    if (Number(parameters.ErrorCode || 0) !== 0) {
      throw new Error(parameters.ErrorMsg || "학교 서버가 요청을 거절했습니다.");
    }
    return { parameters, datasets };
  }

  async function transaction(path, dataset, parameters = {}) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        Reqfoundataion: "nexacro",
      },
      body: buildRequest(requestParameters(parameters), dataset),
    });
    if (!response.ok) throw new Error(`학교 서버 HTTP 오류: ${response.status}`);
    return parseResponse(await response.text());
  }

  const conditionColumns = ["yy", "tmGbn", "schregNo", "stdKorNm", "outStayStGbn"];
  const condition = (term, id, name) => ({
    id: "DS_COND",
    columns: conditionColumns,
    row: { yy: term.yy, tmGbn: term.tmGbn, schregNo: id, stdKorNm: name },
  });

  try {
    if (location.origin !== "https://dream.tukorea.ac.kr") {
      throw new Error("한국공학대학교 통합정보시스템 탭에서만 실행할 수 있습니다.");
    }

    const identity = requestParameters();
    const userId = identity.hakbun || identity.USER_HAKBUN || identity.USER_ID;
    let userName = identity.USER_NAME || "";
    try { userName = decodeURIComponent(userName); } catch {}
    if (!userId || !userName) {
      throw new Error("통합정보시스템 로그인 정보가 없습니다. 다시 로그인해 주세요.");
    }

    const termResult = await transaction(
      `/aff/dorm/DormCtr/findYyTmGbnList.do?${MENU}`,
      { id: "DS_COND", columns: ["mvinTermYn"], row: { mvinTermYn: "1" } },
    );
    const term = termResult.datasets.DS_DORM010?.[0];
    if (!term?.yy || !term?.tmGbn) throw new Error("현재 생활관 신청 학기를 확인할 수 없습니다.");

    const residentResult = await transaction(
      `/aff/dorm/DormCtr/findMdstrmLeaveAplyList.do?${MENU}`,
      condition(term, userId, userName),
    );
    const resident = residentResult.datasets.DS_DORM100?.[0];
    if (!resident || resident.livstuStGbn !== "2") {
      throw new Error("현재 생활관 입주 중인 학생만 외박신청할 수 있습니다.");
    }

    const list = async () => {
      const result = await transaction(
        `/aff/dorm/DormCtr/findStayAplyList.do?${MENU}`,
        condition(term, userId, userName),
      );
      return result.datasets.DS_DORM120 || [];
    };

    const conflict = rows => rows.find(row => {
      if (row.outStayStGbn === "3") return false;
      const from = row.outStayFrDt || "";
      const to = row.outStayToDt || "";
      return /^\d{8}$/.test(from) && /^\d{8}$/.test(to) && from <= request.end && request.start <= to;
    });

    const before = await list();
    const existing = conflict(before);
    const label = `${request.start.slice(0, 4)}-${request.start.slice(4, 6)}-${request.start.slice(6)} ~ ${request.end.slice(0, 4)}-${request.end.slice(4, 6)}-${request.end.slice(6)}`;
    if (existing) {
      const exact = existing.outStayFrDt === request.start && existing.outStayToDt === request.end;
      return {
        ok: exact,
        message: exact
          ? `이미 신청된 기간입니다: ${label}`
          : `기존 신청 기간(${existing.outStayFrDt} ~ ${existing.outStayToDt})과 겹칩니다.`,
      };
    }
    if (request.mode === "check") {
      return { ok: true, message: `신청 가능합니다: ${label}` };
    }

    const saveColumns = [
      ["outStayGbn", "string", "32"],
      ["outStayReplyCtnt", "undefined", "0"],
      ["outStayToDt", "string", "32"],
      ["outStayFrDt", "string", "32"],
      ["chk", "string", "32"],
      ["outStaySeq", "bigdecimal", "16"],
      ["outStayStGbn", "string", "32"],
      ["schregNo", "string", "32"],
      ["outStayStNm", "string", "32"],
      ["livstuNo", "string", "32"],
      ["outStayAplyDt", "string", "32"],
      ["yy", "string", "32"],
      ["noneLtOutStayYn", "string", "32"],
      ["tmGbn", "string", "32"],
    ];
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("");
    await transaction(
      `/aff/dorm/DormCtr/saveOutAplyList.do?${MENU}`,
      {
        id: "DS_DORM120",
        columns: saveColumns,
        row: {
          yy: term.yy,
          tmGbn: term.tmGbn,
          livstuNo: resident.livstuNo,
          outStayGbn: "07",
          outStayFrDt: request.start,
          outStayToDt: request.end,
          outStayStGbn: "1",
          outStayStNm: "미승인",
          outStayAplyDt: today,
        },
        type: "insert",
      },
    );

    const saved = (await list()).some(row =>
      row.outStayStGbn !== "3" &&
      row.outStayFrDt === request.start &&
      row.outStayToDt === request.end,
    );
    if (!saved) throw new Error("저장 응답 뒤 재조회에서 신청 내역을 확인하지 못했습니다.");
    return { ok: true, message: `외박신청이 완료되었습니다: ${label}` };
  } catch (error) {
    return { ok: false, message: error.message || String(error) };
  }
}

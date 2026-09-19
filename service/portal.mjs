import { createCipheriv, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";

import { MAX_BATCH_DATES, findConflict, parseIsoDate, validatePeriod } from "../extension/core.mjs";

const DREAM = "https://dream.tukorea.ac.kr";
const SSO = "https://ksc.tukorea.ac.kr";
const MENU = "menuId=MPB0022&pgmId=PPB0021";
const XML_NS = "http://www.nexacroplatform.com/platform/dataset";
const SAVE_COLUMNS = [
  ["outStayGbn", "string", "32"], ["outStayReplyCtnt", "undefined", "0"],
  ["outStayToDt", "string", "32"], ["outStayFrDt", "string", "32"],
  ["chk", "string", "32"], ["outStaySeq", "bigdecimal", "16"],
  ["outStayStGbn", "string", "32"], ["schregNo", "string", "32"],
  ["outStayStNm", "string", "32"], ["livstuNo", "string", "32"],
  ["outStayAplyDt", "string", "32"], ["yy", "string", "32"],
  ["noneLtOutStayYn", "string", "32"], ["tmGbn", "string", "32"],
];

export class PortalError extends Error {}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlDecode(value) {
  return value.replace(/&([^;]*);|&/g, (_, entity) => {
    const named = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const code = /^#x[0-9a-f]+$/i.test(entity) ? Number.parseInt(entity.slice(2), 16)
      : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (![9, 10, 13].includes(code) && !(code >= 32 && code <= 0xd7ff) && !(code >= 0xe000 && code <= 0xfffd) && !(code >= 0x10000 && code <= 0x10ffff)) {
      throw new PortalError("학교 서버의 XML 문자 형식이 올바르지 않습니다.");
    }
    return String.fromCodePoint(code);
  });
}

// Nexacro의 작은 XML 응답만 읽는다. 알 수 없는 구조를 빈 신청 내역으로 해석하지 않는다.
function parseXml(text) {
  const invalid = () => { throw new PortalError("학교 서버가 로그인 페이지 또는 잘못된 응답을 반환했습니다."); };
  if (typeof text !== "string" || text.length > 2 * 1024 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) invalid();
  const document = { children: [], text: "" };
  const stack = [document];
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?xml\s[^?]*\?>|<[^>]*>|[^<]+/gy;
  let offset = 0;
  let elements = 0;
  while (offset < text.length) {
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match) invalid();
    const value = match[0];
    offset = token.lastIndex;
    const parent = stack.at(-1);
    if (value.startsWith("<!--")) {
      if (value.slice(4, -3).includes("--")) invalid();
    } else if (value.startsWith("<?xml")) {
      if (stack.length !== 1 || document.children.length) invalid();
    } else if (value.startsWith("<![CDATA[")) {
      if (stack.length === 1) invalid();
      parent.text += value.slice(9, -3);
    } else if (value.startsWith("</")) {
      const closing = /^<\/([\w:.-]+)\s*>$/.exec(value);
      if (!closing || stack.length === 1 || parent.name !== closing[1]) invalid();
      stack.pop();
    } else if (value.startsWith("<")) {
      const opening = /^<([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(value);
      if (!opening || ++elements > 50_000 || stack.length > 32) invalid();
      const attributes = {};
      let remaining = opening[2];
      while (remaining.trim()) {
        const attribute = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(remaining);
        if (!attribute || Object.hasOwn(attributes, attribute[1])) invalid();
        Object.defineProperty(attributes, attribute[1], { value: xmlDecode(attribute[2] ?? attribute[3]), enumerable: true });
        remaining = remaining.slice(attribute[0].length);
      }
      const element = { name: opening[1], attributes, children: [], text: "" };
      parent.children.push(element);
      if (!opening[3]) stack.push(element);
    } else {
      parent.text += xmlDecode(value);
    }
  }
  if (stack.length !== 1 || document.text.trim() || document.children.length !== 1 || document.children[0].name !== "Root") invalid();
  return document.children[0];
}

export function buildRequest(parameters = {}, dataset = null) {
  const parameterXml = Object.entries(parameters)
    .map(([key, value]) => `<Parameter id="${xmlEscape(key)}">${xmlEscape(value)}</Parameter>`)
    .join("");
  if (!dataset) {
    return `<?xml version="1.0" encoding="UTF-8"?><Root xmlns="${XML_NS}"><Parameters>${parameterXml}</Parameters></Root>`;
  }

  const columnId = column => Array.isArray(column) ? column[0] : column;
  const columns = dataset.columns.map(column => {
    const [id, type = "STRING", size = "256"] = Array.isArray(column) ? column : [column];
    return `<Column id="${xmlEscape(id)}" type="${xmlEscape(type)}" size="${xmlEscape(size)}"/>`;
  }).join("");
  const values = dataset.columns
    .map(columnId)
    .filter(column => dataset.row[column] !== undefined && dataset.row[column] !== null)
    .map(column => `<Col id="${xmlEscape(column)}">${xmlEscape(dataset.row[column])}</Col>`)
    .join("");
  const type = dataset.type ? ` type="${xmlEscape(dataset.type)}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Root xmlns="${XML_NS}"><Parameters>${parameterXml}</Parameters><Dataset id="${xmlEscape(dataset.id)}"><ColumnInfo>${columns}</ColumnInfo><Rows><Row${type}>${values}</Row></Rows></Dataset></Root>`;
}

export function parseResponse(text) {
  const root = parseXml(text);
  const parameters = {};
  const datasets = {};
  const invalid = () => { throw new PortalError("학교 서버의 데이터 구조를 확인할 수 없습니다."); };
  const put = (target, node, value) => {
    const id = node.attributes.id;
    if (!id || Object.hasOwn(target, id)) invalid();
    Object.defineProperty(target, id, { value, enumerable: true });
  };
  const scalar = node => { if (node.children.length) invalid(); return node.text; };
  if (root.text.trim()) invalid();
  for (const node of root.children) {
    if (node.text.trim()) invalid();
    if (node.name === "Parameters") {
      for (const item of node.children) {
        if (item.name !== "Parameter") invalid();
        put(parameters, item, scalar(item));
      }
    } else if (node.name === "Dataset") {
      if (node.children.some(child => !["ColumnInfo", "Rows"].includes(child.name))) invalid();
      const containers = node.children.filter(child => child.name === "Rows");
      if (containers.length > 1 || containers.some(child => child.text.trim())) invalid();
      const rows = (containers[0]?.children || []).map(item => {
        if (item.name !== "Row" || item.text.trim()) invalid();
        const row = {};
        for (const column of item.children) {
          if (column.name !== "Col") invalid();
          put(row, column, scalar(column));
        }
        return row;
      });
      put(datasets, node, rows);
    } else invalid();
  }
  if (!/^-?\d+$/.test(parameters.ErrorCode?.trim() || "")) throw new PortalError("학교 서버의 처리 결과를 확인할 수 없습니다.");
  if (Number(parameters.ErrorCode) !== 0) throw new PortalError("학교 서버가 요청을 거절했습니다. 포털에서 신청 조건을 확인해 주세요.");
  return { parameters, datasets };
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  add(url, rawCookie) {
    const source = new URL(url);
    if (typeof rawCookie !== "string" || rawCookie.length > 8192 || /[\r\n\u0000]/.test(rawCookie)) return;
    const parts = rawCookie.split(";");
    const separator = parts[0].indexOf("=");
    if (separator < 1) return;
    const name = parts[0].slice(0, separator).trim();
    const value = parts[0].slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\u0000-\u0020\u007f]/.test(value)) return;
    let domain = source.hostname.toLowerCase();
    let hostOnly = true;
    let path = source.pathname.includes("/")
      ? source.pathname.slice(0, source.pathname.lastIndexOf("/")) || "/"
      : "/";
    let expires = null;
    let secure = false;

    for (const rawAttribute of parts.slice(1)) {
      const [rawName, ...rawValue] = rawAttribute.trim().split("=");
      const attribute = rawName.toLowerCase();
      const attributeValue = rawValue.join("=");
      if (attribute === "domain" && attributeValue) {
        domain = attributeValue.replace(/^\./, "").toLowerCase();
        if (!(domain === "tukorea.ac.kr" || domain.endsWith(".tukorea.ac.kr")) ||
            !(source.hostname === domain || source.hostname.endsWith(`.${domain}`))) return;
        hostOnly = false;
      } else if (attribute === "path" && attributeValue.startsWith("/")) {
        path = attributeValue;
      } else if (attribute === "max-age" && /^-?\d+$/.test(attributeValue)) {
        expires = Date.now() + Number(attributeValue) * 1000;
      } else if (attribute === "expires" && expires === null) {
        const parsed = Date.parse(attributeValue);
        if (!Number.isNaN(parsed)) expires = parsed;
      } else if (attribute === "secure") {
        secure = true;
      }
    }

    const key = `${domain}\t${path}\t${name}`;
    if ((name.startsWith("__Secure-") && !secure) || (name.startsWith("__Host-") && (!secure || !hostOnly || path !== "/"))) return;
    if (expires !== null && expires <= Date.now()) {
      this.cookies.delete(key);
      return;
    }
    if (!this.cookies.has(key) && this.cookies.size >= 256) throw new PortalError("학교 로그인 쿠키 수가 제한을 초과했습니다.");
    this.cookies.set(key, { name, value, domain, hostOnly, path, expires, secure });
  }

  matching(url) {
    const target = new URL(url);
    const host = target.hostname.toLowerCase();
    const now = Date.now();
    const matches = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expires !== null && cookie.expires <= now) {
        this.cookies.delete(key);
        continue;
      }
      const domainMatches = cookie.hostOnly
        ? host === cookie.domain
        : host === cookie.domain || host.endsWith(`.${cookie.domain}`);
      const pathMatches = target.pathname === cookie.path ||
        (target.pathname.startsWith(cookie.path) && (cookie.path.endsWith("/") || target.pathname[cookie.path.length] === "/"));
      if (!domainMatches || !pathMatches) continue;
      if (cookie.secure && target.protocol !== "https:") continue;
      matches.push(cookie);
    }
    return matches.sort((left, right) => right.path.length - left.path.length);
  }

  header(url) {
    return this.matching(url).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  }

  value(name, url) {
    return this.matching(url).find(cookie => cookie.name === name)?.value;
  }
}

function schoolUrl(url) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443") ||
      !["dream.tukorea.ac.kr", "ksc.tukorea.ac.kr", "portal.tukorea.ac.kr"].includes(target.hostname)) {
    throw new PortalError("허용되지 않은 학교 로그인 주소입니다.");
  }
  return target;
}

function bufferedHttpsRequest(url, { method, body, headers, timeoutMs }, requestImpl = httpsRequest) {
  const target = schoolUrl(url);
  const payload = body instanceof URLSearchParams ? body.toString() : body;
  if (payload !== undefined && typeof payload !== "string" && !Buffer.isBuffer(payload)) {
    throw new PortalError("학교 서버 요청 본문 형식이 올바르지 않습니다.");
  }
  const requestHeaders = Object.fromEntries(headers.entries());
  if (payload !== undefined && !headers.has("content-length")) {
    requestHeaders["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const fail = error => { settled = true; clearTimeout(timer); reject(error); };
    const request = requestImpl(target, {
      method,
      headers: requestHeaders,
      // 학교 포털이 일부 응답 헤더 끝에 비표준 공백을 붙여 Node fetch가 거부한다.
      insecureHTTPParser: true,
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("error", fail);
      response.on("aborted", () => fail(new PortalError("학교 서버 응답이 중단되었습니다.")));
      response.on("close", () => { if (!settled) fail(new PortalError("학교 서버 응답이 중단되었습니다.")); });
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          const error = new PortalError("학교 서버 응답 크기가 제한을 초과했습니다.");
          fail(error);
          request.destroy(error);
        }
        else chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        if (settled) return;
        try {
          const responseBody = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (name === "set-cookie" || value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
          }
          settled = true;
          resolve({
            status: response.statusCode || 0,
            ok: response.statusCode >= 200 && response.statusCode < 300,
            headers: responseHeaders,
            setCookies: response.headers["set-cookie"] || [],
            text: async () => responseBody.toString("utf8"),
          });
        } catch {
          fail(new PortalError("학교 서버 응답 헤더를 읽을 수 없습니다."));
        }
      });
    });
    timer = setTimeout(() => {
      const error = new PortalError("학교 서버 응답 시간이 초과되었습니다.");
      fail(error);
      request.destroy(error);
    }, timeoutMs);
    timer.unref();
    request.on("error", fail);
    try {
      if (payload !== undefined) request.write(payload);
      request.end();
    } catch (error) { fail(error); request.destroy(); }
  });
}

class SessionFetch {
  constructor(timeoutMs = 25_000, transport = bufferedHttpsRequest) {
    this.jar = new CookieJar();
    this.timeoutMs = timeoutMs;
    this.transport = transport;
  }

  async request(url, options = {}) {
    let currentUrl = schoolUrl(url);
    let method = (options.method || "GET").toUpperCase();
    let body = options.body;
    let headers = new Headers(options.headers || {});
    const deadline = Date.now() + this.timeoutMs;

    for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
      if (Date.now() >= deadline) throw new PortalError("학교 서버 응답 시간이 초과되었습니다.");
      if (!headers.has("User-Agent")) {
        headers.set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36");
      }
      if (!headers.has("Accept")) headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
      if (!headers.has("Accept-Language")) headers.set("Accept-Language", "ko-KR,ko;q=0.9,en;q=0.8");
      const cookie = this.jar.header(currentUrl);
      if (cookie) headers.set("Cookie", cookie);
      else headers.delete("Cookie");
      const response = await this.transport(currentUrl, {
        method,
        body,
        headers,
        timeoutMs: deadline - Date.now(),
      });
      for (const item of response.setCookies) this.jar.add(currentUrl, item);

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        response.url = currentUrl.href;
        return response;
      }
      if (options.redirect === "error") throw new PortalError("학교 서버가 로그인 이동을 요청했습니다. 다시 연결해 주세요.");
      const redirectLocation = response.headers.get("location");
      if (!redirectLocation) throw new PortalError("학교 로그인 이동 주소를 확인할 수 없습니다.");
      const previousUrl = currentUrl;
      currentUrl = schoolUrl(new URL(redirectLocation, currentUrl));
      if (response.status === 303 || ([301, 302].includes(response.status) && method === "POST")) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = undefined;
        headers = new Headers();
        headers.set("Referer", previousUrl.origin === currentUrl.origin ? previousUrl.href : `${previousUrl.origin}/`);
      } else if (!["GET", "HEAD"].includes(method)) {
        throw new PortalError("학교 서버가 요청 재전송을 요구하여 처리를 중단했습니다.");
      } else if (previousUrl.origin !== currentUrl.origin) {
        headers.delete("Authorization");
        headers.delete("Origin");
        headers.set("Referer", `${previousUrl.origin}/`);
      }
    }
    throw new PortalError("학교 로그인 리디렉션이 너무 많이 발생했습니다.");
  }
}

function encryptSsoValue(value, timestamp, keyHex) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(keyHex, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(`${value}|${timestamp}`, "utf8"), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64url");
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function koreaTodayCompact(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function compactDate(value) {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) throw new Error("신청 날짜가 올바르지 않습니다.");
  return parseIsoDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`);
}

function validateApplicationPeriod(start, end, now) {
  try {
    // validatePeriod는 현지 벽시계 시간을 받으므로 서버의 TZ와 무관하게 한국 시간으로 넘긴다.
    const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const clock = new Date(korea.getUTCFullYear(), korea.getUTCMonth(), korea.getUTCDate(), korea.getUTCHours(), korea.getUTCMinutes());
    return validatePeriod(compactDate(start).iso, compactDate(end).iso, clock);
  } catch (error) {
    const failure = new PortalError(error.message);
    failure.code = "INVALID_PERIOD";
    throw failure;
  }
}

export class TukoreaPortal {
  constructor(studentId, password, { now = () => new Date() } = {}) {
    this.studentId = studentId;
    this.password = password;
    this.http = new SessionFetch();
    this.session = {};
    this.authenticated = false;
    this.now = now;
  }

  async login() {
    if (this.authenticated) return this.session;
    try {
      const returnUrl = `${DREAM}/nx/`;
      const loginUrl = `${SSO}/sso/login_stand.jsp?returnurl=${returnUrl}`;
      const loginPage = await this.http.request(loginUrl);
      if (!loginPage.ok) throw new PortalError("학교 로그인 페이지를 불러올 수 없습니다.");
      const html = await loginPage.text();
      const keyHex = html.match(/keyHex\s*=\s*"([0-9a-f]{32})"/i)?.[1];
      if (!keyHex) throw new PortalError("학교 로그인 암호화 키를 확인할 수 없습니다.");

      const timestamp = String(Date.now());
      const fields = new URLSearchParams({
        internalId: encryptSsoValue(this.studentId, timestamp, keyHex),
        internalPw: encryptSsoValue(this.password, timestamp, keyHex),
        externalId: "",
        externalPw: "",
        gubun: "inter",
      });
      const loginResponse = await this.http.request(`${SSO}/sso/login_proc.jsp?returnurl=${returnUrl}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: SSO,
          Referer: loginUrl,
        },
        body: fields,
      });
      const loginResult = await loginResponse.text();
      if (!loginResponse.ok) throw new PortalError("학교 로그인 서버가 요청을 처리하지 못했습니다.");
      if (/인증에 실패했습니다/.test(loginResult)) {
        throw new PortalError("학교 SSO가 전송된 로그인 정보를 거절했습니다. 포털 로그인 화면에서 사용하는 아이디인지 확인해 주세요.");
      }
      await this.http.request(`${DREAM}/com/SsoCtr/initPageWork.do?loginGbn=sso`, {
        headers: { Referer: "https://portal.tukorea.ac.kr/" },
      });
      const login = await this.transaction("/com/SsoCtr/isLogin.do");
      if (login.datasets.DS_LOGINCONFIRM?.[0]?.isLogin !== "1") {
        throw new PortalError("학교 포털 로그인에 실패했습니다. 학번과 비밀번호를 확인해 주세요.");
      }
      this.session = login.datasets.DS_SESSIONINFO?.[0] || {};
      this.authenticated = true;
      return this.session;
    } catch (error) {
      if (error instanceof PortalError) throw error;
      throw new PortalError("학교 로그인 서버에 연결할 수 없습니다.", { cause: error });
    }
  }

  requestParameters(extra = {}) {
    const params = {};
    const url = `${DREAM}/nx/`;
    for (const name of ["hakbun", "USER_HAKBUN", "userid", "USER_NAME", "USER_ID"]) {
      const value = this.http.jar.value(name, url);
      if (value) params[name] = value;
    }
    const actualId = this.session.persNo || this.studentId;
    for (const name of ["hakbun", "USER_HAKBUN", "userid", "USER_ID"]) {
      if (!(name in params)) params[name] = actualId;
    }
    if (!("USER_NAME" in params) && this.session.userNm) {
      params.USER_NAME = encodeURIComponent(this.session.userNm);
    }
    params.requestTimeStr = String(Date.now());
    return { ...params, ...extra };
  }

  async transaction(path, dataset = null, parameters = {}) {
    let response;
    try {
      response = await this.http.request(new URL(path, DREAM), {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          Reqfoundataion: "nexacro",
          Origin: DREAM,
          Referer: `${DREAM}/nx/`,
        },
        body: buildRequest(this.requestParameters(parameters), dataset),
      });
    } catch (error) {
      if (error instanceof PortalError) throw error;
      throw new PortalError("학교 서버에 연결할 수 없습니다.", { cause: error });
    }
    if (!response.ok) throw new PortalError(`학교 서버 HTTP 오류: ${response.status}`);
    return parseResponse(await response.text());
  }

  async profile() {
    let userName = safeDecode(
      this.http.jar.value("USER_NAME", `${DREAM}/nx/`) || this.session.userNm || "",
    );
    let userId = this.session.persNo || this.studentId;
    if (!userName) {
      const result = await this.transaction(
        `/com/SsoCtr/findMyGLIOList.do?${MENU}`,
        null,
        { columnList: "persNo|userNm" },
      );
      const profile = result.datasets.DS_GLIO?.[0];
      userId = profile?.persNo || userId;
      userName = profile?.userNm || "";
    }
    if (!userId || !userName) throw new PortalError("로그인한 학생 정보를 확인할 수 없습니다.");
    return { userId, userName };
  }

  async applicationContext({ requireResident = true } = {}) {
    await this.login();
    const { userId, userName } = await this.profile();
    const termResult = await this.transaction(
      `/aff/dorm/DormCtr/findYyTmGbnList.do?${MENU}`,
      { id: "DS_COND", columns: ["mvinTermYn"], row: { mvinTermYn: "1" } },
    );
    const term = termResult.datasets.DS_DORM010?.[0];
    if (!term?.yy || !term?.tmGbn) throw new PortalError("현재 생활관 신청 학기를 확인할 수 없습니다.");

    const condition = {
      id: "DS_COND",
      columns: ["yy", "tmGbn", "schregNo", "stdKorNm", "outStayStGbn"],
      row: { yy: term.yy, tmGbn: term.tmGbn, schregNo: userId, stdKorNm: userName },
    };
    let resident;
    if (requireResident) {
      const residentResult = await this.transaction(
        `/aff/dorm/DormCtr/findMdstrmLeaveAplyList.do?${MENU}`,
        condition,
      );
      resident = residentResult.datasets.DS_DORM100?.[0];
      if (!resident?.livstuNo || resident.livstuStGbn !== "2" || (resident.schregNo && resident.schregNo !== userId)) {
        throw new PortalError("현재 생활관 입주 중인 학생만 외박신청할 수 있습니다.");
      }
    }

    const list = async () => {
      const result = await this.transaction(`/aff/dorm/DormCtr/findStayAplyList.do?${MENU}`, condition);
      const rows = result.datasets.DS_DORM120;
      try {
        if (!Array.isArray(rows) || rows.some(row =>
          compactDate(row.outStayFrDt).epochDay > compactDate(row.outStayToDt).epochDay ||
          !/^\d+$/.test(row.outStayStGbn || "") || (row.schregNo && row.schregNo !== userId) ||
          (resident && row.livstuNo && row.livstuNo !== resident.livstuNo),
        )) throw new Error();
      } catch { throw new PortalError("기존 신청 내역을 확인할 수 없습니다. 신청을 중단합니다."); }
      return rows;
    };
    return { term, resident, list };
  }

  async applications() {
    const { list } = await this.applicationContext({ requireResident: false });
    return (await list()).map(row => ({
      start: compactDate(row.outStayFrDt).iso,
      end: compactDate(row.outStayToDt).iso,
      active: row.outStayStGbn !== "3",
    })).sort((left, right) => left.start.localeCompare(right.start) || left.end.localeCompare(right.end));
  }

  async saveApplication({ term, resident }, start, end) {
    validateApplicationPeriod(start, end, this.now());
    const result = await this.transaction(`/aff/dorm/DormCtr/saveOutAplyList.do?${MENU}`, {
      id: "DS_DORM120",
      columns: SAVE_COLUMNS,
      type: "insert",
      row: {
        outStayGbn: "07",
        outStayToDt: end,
        outStayFrDt: start,
        outStayStGbn: "1",
        outStayStNm: "미승인",
        livstuNo: resident.livstuNo,
        outStayAplyDt: koreaTodayCompact(this.now()),
        yy: term.yy,
        tmGbn: term.tmGbn,
      },
    });
    return result.datasets.DS_SAVE_RESULT?.[0]?.outStayCnt;
  }

  async apply(start, end, { dryRun = false, shouldStop = () => false } = {}) {
    validateApplicationPeriod(start, end, this.now());
    if (await shouldStop()) return { status: "cancelled", message: "신청을 중단했습니다." };
    const context = await this.applicationContext();
    const conflict = findConflict(await context.list(), start, end);
    const label = `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6)} ~ ${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6)}`;
    if (conflict?.type === "same") return { status: "exists", message: `이미 신청된 기간입니다: ${label}` };
    if (conflict?.type === "overlap") {
      const error = new PortalError(`기존 신청 기간(${conflict.row.outStayFrDt} ~ ${conflict.row.outStayToDt})과 겹칩니다.`);
      error.code = "OVERLAP";
      throw error;
    }
    if (dryRun) {
      validateApplicationPeriod(start, end, this.now());
      return { status: "available", message: `신청 가능합니다: ${label}` };
    }

    if (await shouldStop()) return { status: "cancelled", message: "신청을 중단했습니다." };
    const saved = await this.saveAndVerify(context, start, end, shouldStop);
    if (saved.cancelled) return { status: "cancelled", message: "신청을 중단했습니다." };
    const { count } = saved;
    return {
      status: "saved",
      message: `외박신청이 완료되었습니다: ${label}${count ? ` (현재 자유외박 ${count}회)` : ""}`,
    };
  }

  async saveAndVerify(context, start, end, shouldStop = () => false) {
    validateApplicationPeriod(start, end, this.now());
    if (await shouldStop()) return { cancelled: true };
    let count;
    try { count = await this.saveApplication(context, start, end); }
    catch (error) {
      if (error.code === "INVALID_PERIOD") throw error;
      // 저장 요청은 재전송하지 않고 조회만으로 결과를 확인한다.
    }
    let rows;
    try { rows = await context.list(); }
    catch { throw new PortalError("신청 결과를 확인할 수 없습니다. 학교 포털의 신청 내역을 확인해 주세요."); }
    if (!rows.some(row => row.outStayStGbn !== "3" && row.outStayFrDt === start && row.outStayToDt === end)) {
      throw new PortalError("재조회에서 신청을 확인하지 못했습니다. 학교 포털의 신청 내역을 확인해 주세요.");
    }
    return { count, rows };
  }

  async applyMany(periods, { onProgress = () => {}, shouldStop = () => false } = {}) {
    if (!Array.isArray(periods) || !periods.length || periods.length > MAX_BATCH_DATES) {
      throw new PortalError("일괄신청 날짜가 올바르지 않습니다.");
    }
    const results = periods.map(period => {
      const date = typeof period === "string" ? period : period?.date;
      const end = typeof period === "string" ? period : period?.end || date;
      if (typeof date !== "string" || typeof end !== "string" || !/^\d{8}$/.test(date) || !/^\d{8}$/.test(end)) {
        throw new PortalError("일괄신청 날짜가 올바르지 않습니다.");
      }
      validateApplicationPeriod(date, end, this.now());
      return { date, end, status: "not_attempted" };
    }).sort((left, right) => left.date.localeCompare(right.date));
    if (results.some((period, index) => index && period.date <= results[index - 1].end)) {
      throw new PortalError("겹치는 일괄신청 기간이 있습니다.");
    }
    let cancelled = false;
    let stoppedReason = "";
    const report = () => {
      const summary = Object.fromEntries(["saved", "exists", "overlap", "unknown", "not_attempted"].map(status => [status, results.filter(result => result.status === status).length]));
      const partial = summary.unknown > 0 || summary.not_attempted > 0;
      return {
        status: cancelled ? "cancelled" : partial ? "partial" : "batch", summary, results: results.map(item => ({ ...item })),
        message: `${cancelled ? "일괄신청을 중단했습니다. " : stoppedReason ? `${stoppedReason} ` : ""}${summary.saved}개 기간 신청 완료, ${summary.exists + summary.overlap}개 기존 신청으로 제외, ${summary.unknown}개 확인 필요, ${summary.not_attempted}개 미처리`,
      };
    };
    if (await shouldStop()) { cancelled = true; return report(); }
    const context = await this.applicationContext();
    let rows = await context.list();

    for (const item of results) {
      if (await shouldStop()) { cancelled = true; break; }
      const { date, end } = item;
      const conflict = findConflict(rows, date, end);
      if (conflict) {
        item.status = conflict.type === "same" ? "exists" : "overlap";
        await onProgress(report());
        continue;
      }
      // 저장 직전에 '확인 필요'를 남겨 프로세스 종료 시에도 성공으로 오인하지 않는다.
      item.status = "unknown";
      await onProgress(report());
      if (await shouldStop()) { item.status = "not_attempted"; cancelled = true; break; }
      try {
        const saved = await this.saveAndVerify(context, date, end, shouldStop);
        if (saved.cancelled) { item.status = "not_attempted"; cancelled = true; break; }
        ({ rows } = saved);
        item.status = "saved";
      } catch (error) {
        if (error.code === "INVALID_PERIOD") { item.status = "not_attempted"; stoppedReason = error.message; }
        await onProgress(report());
        break;
      }
      await onProgress(report());
    }
    return report();
  }
}

export const internals = { CookieJar, SessionFetch, bufferedHttpsRequest, encryptSsoValue, koreaTodayCompact };

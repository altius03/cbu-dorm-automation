#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";

import { TukoreaPortal } from "../service/portal.mjs";

const ORIGIN = "https://tuk-overnight.vercel.app";
const KEYCHAIN_SERVICE = "tuk-overnight/OVERNIGHT_SETUP_TOKEN";
const KEYCHAIN_ACCOUNT = "tuk-overnight";

function sessionToken(headers) {
  const cookies = headers.getSetCookie?.().join(",") || headers.get("set-cookie") || "";
  return /(?:^|[,;]\s*)overnight_session=([A-Za-z0-9_-]{40,100})(?:;|,|$)/.exec(cookies)?.[1] || "";
}

async function responseBody(response) {
  try { return await response.json(); }
  catch { return {}; }
}

async function register(credentials, setupToken) {
  const call = async (path, token = "") => {
    const response = await fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        ...(token ? { "X-Setup-Token": token } : {}),
      },
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(60_000),
    });
    return { response, body: await responseBody(response) };
  };

  let result = await call("/api/register", setupToken);
  if ([409, 410].includes(result.response.status) && /연결된 계정|이미 사용/.test(result.body.error || "")) {
    result = await call("/api/reconnect");
  }
  if (!result.response.ok) {
    const requestId = typeof result.body.requestId === "string" ? ` (요청 ID: ${result.body.requestId})` : "";
    throw new Error(`${result.body.error || `서비스 연결 오류 HTTP ${result.response.status}`}${requestId}`);
  }
  const token = sessionToken(result.response.headers);
  if (!token) throw new Error("서비스 세션을 받지 못했습니다.");
  return token;
}

function tomorrowInKorea(now = new Date()) {
  const date = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

async function preflight(token) {
  const date = tomorrowInKorea();
  const response = await fetch(`${ORIGIN}/api/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `overnight_session=${token}`,
      Origin: ORIGIN,
    },
    body: JSON.stringify({ start: date, end: date }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await responseBody(response);
  if (!response.ok) {
    if (/^기존 신청 기간\(\d{8} ~ \d{8}\)과 겹칩니다\.$/.test(body.error || "")) {
      return `기존 신청 내역 조회 성공: ${body.error}`;
    }
    const requestId = typeof body.requestId === "string" ? ` (요청 ID: ${body.requestId})` : "";
    throw new Error(`${body.error || `읽기 전용 확인 오류 HTTP ${response.status}`}${requestId}`);
  }
  return body.message || "기숙사 신청 정보를 확인했습니다.";
}

function keychainSetupToken() {
  try {
    return execFileSync("/usr/bin/security", [
      "find-generic-password", "-w", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error("macOS 키체인에서 일회용 연결 토큰을 찾지 못했습니다.");
  }
}

function terminalPrompt(input, output, label) {
  output.write(label);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003" || character === "\u0004") return done(new Error("입력을 취소했습니다."));
        if (character === "\r" || character === "\n") return done();
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    input.on("data", onData);
  });
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const cookie = `overnight_session=${"a".repeat(43)}; HttpOnly; Path=/`;
    assert.equal(sessionToken(new Headers({ "set-cookie": cookie })), "a".repeat(43));
    assert.equal(tomorrowInKorea(new Date("2026-09-19T14:59:00Z")), "2026-09-20");
    console.log("connect-account self-test: ok");
    return;
  }
  if (process.platform !== "darwin") throw new Error("이 연결 도구는 macOS 키체인을 사용합니다.");

  const descriptor = openSync("/dev/tty", "r+");
  const input = new ReadStream(descriptor);
  const output = new WriteStream(descriptor);
  const studentId = await terminalPrompt(input, output, "학번/포털 아이디 (화면에 표시되지 않음): ");
  const password = await terminalPrompt(input, output, "포털 비밀번호 (화면에 표시되지 않음): ");
  if (!/^[A-Za-z0-9]{4,32}$/.test(studentId) || password.length < 1 || password.length > 256) {
    throw new Error("학번/포털 아이디와 비밀번호 형식을 확인해 주세요.");
  }

  process.stdout.write("1/3 로컬에서 학교 로그인 확인 중…\n");
  await new TukoreaPortal(studentId, password).login();
  process.stdout.write("로컬 학교 로그인 성공\n2/3 Vercel 계정 연결 중…\n");
  const token = await register({ studentId, password }, keychainSetupToken());
  process.stdout.write("계정 연결 성공\n3/3 실제 기숙사 정보를 읽기 전용으로 확인 중…\n");
  let result;
  try {
    result = await preflight(token);
  } finally {
    const child = spawn("/usr/bin/open", ["-a", "Safari", `${ORIGIN}/#claim=${encodeURIComponent(token)}`], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
  process.stdout.write(`${result}\n전체 확인 성공. Safari에서 서비스를 열었습니다.\n`);
}

main().catch(error => {
  process.stderr.write(`연결 실패: ${error?.message || "알 수 없는 오류"}\n`);
  process.exitCode = 1;
});

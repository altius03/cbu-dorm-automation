import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { internals, parseResponse, PortalError, TukoreaPortal } from "./portal.mjs";

const envelope = content => `<?xml version="1.0" encoding="UTF-8"?><Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters><Parameter id="ErrorCode" type="int">0</Parameter><Parameter id="ErrorMsg"/></Parameters>${content}</Root>`;
const fixture = envelope(`<Dataset id="DS_DORM120"><ColumnInfo><Column id="outStayFrDt" type="STRING" size="32"/></ColumnInfo><Rows><Row><Col id="outStayFrDt">20990101</Col><Col id="outStayToDt">20990101</Col><Col id="outStayStGbn">1</Col><Col id="note"><![CDATA[A<B &amp; literal]]></Col><Col id="empty"/></Row></Rows></Dataset><!-- harmless comment --><Dataset id='EMPTY'><Rows/></Dataset>`);
assert.deepEqual(parseResponse(fixture).datasets.DS_DORM120[0], {
  outStayFrDt: "20990101", outStayToDt: "20990101", outStayStGbn: "1", note: "A<B &amp; literal", empty: "",
});
assert.deepEqual(parseResponse(fixture).datasets.EMPTY, []);
assert.deepEqual(parseResponse(envelope('<Dataset id="EMPTY"/>')).datasets.EMPTY, []);
assert.equal(parseResponse(envelope('<Dataset id="DS"><Rows><Row><Col id="value">&#x1f600; &amp;lt;</Col></Row></Rows></Dataset>')).datasets.DS[0].value, "😀 &lt;");
for (const malformed of [
  fixture.replace("</Rows>", "</Missing>"),
  fixture.replace("<Rows><Row>", "<Rows><Row"),
  envelope('<Dataset id="DS"><Rows/></Dataset><Dataset id="DS"/>'),
  envelope('<Dataset id="DS"><Rows/><Rows/></Dataset>'),
  envelope('<Dataset id="DS"><Rows><Row><Col id="x">a</Col><Col id="x">b</Col></Row></Rows></Dataset>'),
  envelope('<Dataset id="DS"><Unexpected><Row/></Unexpected></Dataset>'),
  envelope('<Dataset id="DS"><Rows><Row><Col id="x">&#x110000;</Col></Row></Rows></Dataset>'),
  envelope('<Dataset id="DS"><Rows><Row><Col id="x">&undefined;</Col></Row></Rows></Dataset>'),
  envelope('<Dataset id="DS"><Rows><Row><Col id="x">&#xd800;</Col></Row></Rows></Dataset>'),
  envelope('<Dataset id="DS"><Rows><Row><Col id="x">&#xffff;</Col></Row></Rows></Dataset>'),
  '<!DOCTYPE Root [<!ENTITY name "value">]>' + envelope(""),
  '<Root><!--<Parameter id="ErrorCode">0</Parameter>--></Root>',
  envelope("") + "<Root/>",
  envelope("").replace('</Parameters>', '<Parameter id="ErrorCode">0</Parameter></Parameters>'),
]) assert.throws(() => parseResponse(malformed), PortalError);
const prototype = parseResponse(envelope('<Dataset id="__proto__"><Rows><Row><Col id="__proto__">safe</Col></Row></Rows></Dataset>'));
assert.equal(Object.getPrototypeOf(prototype.datasets), Object.prototype);
assert.equal(prototype.datasets.__proto__[0].__proto__, "safe");
assert.equal({}.safe, undefined);

const school = "https://dream.tukorea.ac.kr/";
const cookieJar = new internals.CookieJar();
cookieJar.add(school, "empty=; Path=/; Secure");
assert.equal(cookieJar.header(school), "empty=");
cookieJar.add(school, "empty=gone; Max-Age=0; Path=/");
assert.equal(cookieJar.header(school), "");
cookieJar.add(school, "expired=x; Max-Age=bad; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/");
cookieJar.add(school, "__Host-invalid=x; Path=/; Domain=tukorea.ac.kr; Secure");
cookieJar.add(school, "inject=x\r\nSecret: value; Path=/");
assert.equal(cookieJar.header(school), "");
cookieJar.add(`${school}sso/login`, "scoped=x; Path=invalid");
assert.equal(cookieJar.header(`${school}sso/login`), "scoped=x");
assert.equal(cookieJar.header(`${school}sso-other`), "");

// Fake node:https transport: no sockets, school requests, or stored profiles.
function fakeHttps(emitResponse) {
  return (_url, _options, callback) => {
    const request = new EventEmitter();
    request.write = () => {};
    request.destroy = error => { if (error) queueMicrotask(() => request.emit("error", error)); };
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.headers = {};
        response.statusCode = 200;
        callback(response);
        emitResponse(response);
      });
    };
    return request;
  };
}
const requestOptions = { method: "GET", headers: new Headers(), timeoutMs: 40 };
const buffered = emit => internals.bufferedHttpsRequest(school, requestOptions, fakeHttps(emit));
assert.equal(await (await buffered(response => { response.emit("data", Buffer.from("ok")); response.emit("end"); response.emit("close"); })).text(), "ok");
await assert.rejects(buffered(response => { response.headers.bad = "bad\nprivate-value"; response.emit("end"); }), error => error instanceof PortalError && !error.message.includes("private-value"));
await assert.rejects(buffered(response => { response.emit("aborted"); response.emit("end"); }), /중단/);
await assert.rejects(buffered(response => response.emit("close")), /중단/);
await assert.rejects(buffered(response => { response.emit("data", Buffer.alloc(2 * 1024 * 1024 + 1)); response.emit("end"); }), /크기/);
// The real request's socket keeps Node alive; this fake transport needs one referenced timer.
const keepAlive = setTimeout(() => {}, 200);
try { await assert.rejects(buffered(() => {}), /시간/); } finally { clearTimeout(keepAlive); }

function response(status = 200, location = null, setCookies = []) {
  return { status, ok: status === 200, headers: new Headers(location ? { location } : {}), setCookies, text: async () => "ok" };
}
const redirects = [];
const session = new internals.SessionFetch(25_000, async (url, options) => {
  redirects.push({ url: url.href, ...options, headers: new Headers(options.headers) });
  return redirects.length === 1 ? response(302, school, ["sso=fixture; Domain=tukorea.ac.kr; Path=/; Secure"]) : response();
});
await session.request("https://ksc.tukorea.ac.kr/sso/login", {
  method: "post", body: "fake-secret", headers: { Authorization: "fake-auth", "Content-Type": "text/plain" },
});
assert.equal(redirects.length, 2);
assert.equal(redirects[1].method, "GET");
assert.equal(redirects[1].body, undefined);
assert.equal(redirects[1].headers.has("Authorization"), false);
assert.equal(redirects[1].headers.get("Cookie"), "sso=fixture");
for (const [status, location, options] of [
  [307, school, { method: "POST", body: "fake-secret" }],
  [302, school, { method: "POST", body: "fake-secret", redirect: "error" }],
  [302, "https://example.com/", {}],
  [302, "http://dream.tukorea.ac.kr/", {}],
  [302, null, {}],
]) {
  let requests = 0;
  const isolated = new internals.SessionFetch(25_000, async () => { requests++; return response(status, location); });
  await assert.rejects(isolated.request(school, options), PortalError);
  assert.equal(requests, 1, "unsafe redirects must not repeat a POST or reach another host");
}
{
  const calls = [];
  const session = new internals.SessionFetch(25_000, async (url, options) => {
    calls.push(new Headers(options.headers));
    return calls.length === 1 ? response(302, school) : response();
  });
  await session.request("https://ksc.tukorea.ac.kr/sso/login", { headers: { Authorization: "fixture", Origin: "https://ksc.tukorea.ac.kr", Referer: "https://ksc.tukorea.ac.kr/sso/?sensitive=fixture" } });
  assert.equal(calls[1].has("Authorization"), false);
  assert.equal(calls[1].has("Origin"), false);
  assert.equal(calls[1].get("Referer"), "https://ksc.tukorea.ac.kr/");
}

// Even well-formed XML must not turn an invalid/foreign application row into "no conflict".
{
  const portal = new TukoreaPortal("fixture-student", "fixture-password");
  let rows = [];
  portal.login = async () => {};
  portal.profile = async () => ({ userId: "fixture-student", userName: "Fixture" });
  portal.transaction = async path => path.includes("findYyTmGbnList")
    ? { datasets: { DS_DORM010: [{ yy: "2026", tmGbn: "20" }] } }
    : path.includes("findMdstrmLeaveAplyList")
      ? { datasets: { DS_DORM100: [{ livstuNo: "fixture-resident", livstuStGbn: "2", schregNo: "fixture-student" }] } }
      : { datasets: { DS_DORM120: rows } };
  const context = await portal.applicationContext();
  assert.deepEqual(await context.list(), []);
  for (const row of [
    { outStayFrDt: "20260230", outStayToDt: "20260301", outStayStGbn: "1" },
    { outStayFrDt: "20260921", outStayToDt: "20260920", outStayStGbn: "1" },
    { outStayFrDt: "20260920", outStayToDt: "20260920", outStayStGbn: "1", schregNo: "another-student" },
    { outStayFrDt: "20260920", outStayToDt: "20260920", outStayStGbn: "1", livstuNo: "another-resident" },
    {},
  ]) { rows = [row]; await assert.rejects(context.list(), /기존 신청 내역/); }
}

// Read-only history skips the resident-detail request; applying still requires it.
{
  const portal = new TukoreaPortal("fixture-student", "fixture-password");
  const paths = [];
  portal.login = async () => {};
  portal.profile = async () => ({ userId: "fixture-student", userName: "Fixture" });
  portal.transaction = async path => {
    paths.push(path);
    if (path.includes("findYyTmGbnList")) return { datasets: { DS_DORM010: [{ yy: "2026", tmGbn: "20" }] } };
    if (path.includes("findStayAplyList")) return { datasets: { DS_DORM120: [] } };
    throw new Error("resident lookup must not run for read-only history");
  };
  assert.deepEqual(await portal.applications(), []);
  assert.equal(paths.some(path => path.includes("findMdstrmLeaveAplyList")), false);
}

function fakePortal(now = () => new Date("2026-09-19T03:00:00Z")) {
  const portal = new TukoreaPortal("fixture-student", "fixture-password", { now });
  const stats = { contexts: 0, saves: 0, rows: [] };
  portal.applicationContext = async () => {
    stats.contexts++;
    return { list: async () => stats.rows.map(row => ({ ...row })) };
  };
  portal.saveApplication = async (_context, start, end) => {
    stats.saves++;
    stats.rows.push({ outStayFrDt: start, outStayToDt: end, outStayStGbn: "1" });
  };
  return { portal, stats };
}
{
  const { portal, stats } = fakePortal();
  stats.rows.push(
    { outStayFrDt: "20260921", outStayToDt: "20260921", outStayStGbn: "1" },
    { outStayFrDt: "20260918", outStayToDt: "20260920", outStayStGbn: "3" },
  );
  assert.deepEqual(await portal.applications(), [
    { start: "2026-09-18", end: "2026-09-20", active: false },
    { start: "2026-09-21", end: "2026-09-21", active: true },
  ]);
}
for (const [start, end] of [["20260230", "20260230"], ["20260918", "20260918"], ["20260920", "20260919"], ["20260920", "20260928"], [null, null]]) {
  const { portal, stats } = fakePortal();
  await assert.rejects(portal.apply(start, end), PortalError);
  assert.equal(stats.contexts, 0);
}
{
  const { portal, stats } = fakePortal();
  stats.rows.push({ outStayFrDt: "20260920", outStayToDt: "20260922", outStayStGbn: "1" });
  await assert.rejects(portal.apply("20260921", "20260921"), error => error instanceof PortalError && error.code === "OVERLAP");
  assert.equal(stats.saves, 0);
}
{
  const { portal, stats } = fakePortal();
  await assert.rejects(portal.applyMany(["20260230"]), PortalError);
  assert.equal(stats.contexts, 0);
  assert.equal((await portal.applyMany(["20260920"], { shouldStop: () => true })).status, "cancelled");
  assert.equal((await portal.apply("20260920", "20260920", { shouldStop: () => true })).status, "cancelled");
  assert.equal(stats.contexts, 0);
}
{
  const { portal, stats } = fakePortal();
  let stop = false;
  const original = portal.applicationContext;
  portal.applicationContext = async () => { stop = true; return original(); };
  assert.equal((await portal.apply("20260920", "20260920", { shouldStop: () => stop })).status, "cancelled");
  assert.equal(stats.saves, 0);
}
{
  let now = new Date("2026-09-19T14:29:59Z");
  const { portal, stats } = fakePortal(() => now);
  const original = portal.applicationContext;
  portal.applicationContext = async () => { now = new Date("2026-09-19T14:30:00Z"); return original(); };
  await assert.rejects(portal.apply("20260919", "20260919"), /23:30/);
  assert.equal(stats.saves, 0);
}
{
  const { portal, stats } = fakePortal();
  let stop = false;
  const result = await portal.applyMany(["20260920", "20260921"], {
    shouldStop: () => stop,
    onProgress: () => { stop = true; },
  });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.results.map(item => item.status), ["not_attempted", "not_attempted"]);
  assert.equal(stats.saves, 0);
}
{
  const { portal, stats } = fakePortal();
  let stop = false;
  const save = portal.saveApplication;
  portal.saveApplication = async (...args) => { await save(...args); stop = true; throw new Error("response lost after save"); };
  const result = await portal.applyMany(["20260920", "20260921"], { shouldStop: () => stop });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.results.map(item => item.status), ["saved", "not_attempted"]);
  assert.equal(stats.saves, 1);
}
{
  let now = new Date("2026-09-19T14:29:59Z");
  const { portal, stats } = fakePortal(() => now);
  const result = await portal.applyMany(["20260919", "20260920"], {
    onProgress: () => { now = new Date("2026-09-19T14:30:00Z"); },
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.results.map(item => item.status), ["not_attempted", "not_attempted"]);
  assert.equal(stats.saves, 0);
  assert.match(result.message, /23:30/);
}
{
  const { portal, stats } = fakePortal();
  portal.saveApplication = async () => { stats.saves++; throw new Error("uncertain network response"); };
  const result = await portal.applyMany(["20260920", "20260921"]);
  assert.deepEqual(result.results.map(item => item.status), ["unknown", "not_attempted"]);
  assert.equal(stats.saves, 1, "uncertain saves must not be retried");
}

console.log("portal checks passed: strict Nexacro XML, bounded transport, redirect/cookie isolation, last-moment Korea deadlines, cancellation and uncertain saves (no network)");

import assert from "node:assert/strict";

import { parseHolidayResponse, syncPublicHolidays } from "./holidays.mjs";

const response = items => `<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items>${items}</items></body></response>`;
const item = ({ date, name, holiday = "Y" }) => `<item><dateKind>01</dateKind><dateName>${name}</dateName><isHoliday>${holiday}</isHoliday><locdate>${date}</locdate><seq>1</seq></item>`;

assert.deepEqual(parseHolidayResponse(response(
  item({ date: "20261003", name: "개천절 &amp; 기념일" }) + item({ date: "20261004", name: "일요일", holiday: "N" }),
)), [{ date: "2026-10-03", name: "개천절 & 기념일" }]);
assert.throws(() => parseHolidayResponse(response(item({ date: "20260230", name: "잘못된 날짜" }))), /응답 형식/);
assert.throws(() => parseHolidayResponse("<OpenAPI_ServiceResponse><errMsg>SERVICE_KEY_IS_NULL</errMsg></OpenAPI_ServiceResponse>"), /응답 형식/);

const calls = [];
let saved;
const store = {
  async replaceHolidays(fromYear, throughYear, holidays) {
    saved = { fromYear, throughYear, holidays };
    return holidays.length;
  },
};
const fetchImpl = async value => {
  const url = new URL(value);
  calls.push(url);
  const year = url.searchParams.get("solYear");
  const month = url.searchParams.get("solMonth");
  assert.equal(url.searchParams.get("serviceKey"), "abc+def/ghi=");
  return { ok: true, text: async () => response(month === "01" ? item({ date: `${year}0101`, name: "신정" }) : "") };
};
const result = await syncPublicHolidays(store, {
  serviceKey: "abc%2Bdef%2Fghi%3D", now: new Date("2026-09-19T03:00:00Z"), fetchImpl,
});
assert.equal(calls.length, 24);
assert.deepEqual(result.years, [2026, 2027]);
assert.equal(result.count, 2);
assert.deepEqual(saved.holidays.map(value => value.date), ["2026-01-01", "2027-01-01"]);

let replaced = false;
await assert.rejects(syncPublicHolidays({ replaceHolidays: async () => { replaced = true; } }, {
  serviceKey: "do-not-leak-this-key", now: new Date("2026-09-19T03:00:00Z"),
  fetchImpl: async () => { throw new Error("do-not-leak-this-key"); },
}), error => !error.message.includes("do-not-leak-this-key"));
assert.equal(replaced, false);

console.log("holiday checks passed: strict XML parsing, 24 monthly reads, atomic replacement, secret-safe failures");

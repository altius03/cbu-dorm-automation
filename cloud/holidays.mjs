import { parseIsoDate } from "../extension/core.mjs";

export const HOLIDAY_SOURCE = "한국천문연구원 특일 정보";
const endpoint = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity.toLowerCase())) return named[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) throw new Error("공휴일 응답 형식이 올바르지 않습니다.");
    return String.fromCodePoint(code);
  });
}

function field(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")) : "";
}

export function parseHolidayResponse(xml) {
  if (typeof xml !== "string" || xml.length > 1024 * 1024 || !/^\s*(?:<\?xml[\s\S]*?\?>)?\s*<response[>\s]/.test(xml) || field(xml, "resultCode") !== "00") {
    throw new Error("공휴일 응답 형식이 올바르지 않습니다.");
  }
  const holidays = new Map();
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (field(match[1], "isHoliday") !== "Y") continue;
    const compact = field(match[1], "locdate");
    const name = field(match[1], "dateName");
    if (!/^\d{8}$/.test(compact) || !name || name.length > 100) throw new Error("공휴일 응답 형식이 올바르지 않습니다.");
    const date = compact.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
    try { parseIsoDate(date); } catch { throw new Error("공휴일 응답 형식이 올바르지 않습니다."); }
    const names = holidays.get(date) || new Set();
    names.add(name);
    holidays.set(date, names);
  }
  return [...holidays].map(([date, names]) => ({ date, name: [...names].join(" / ") }));
}

async function fetchMonth(fetchImpl, serviceKey, year, month) {
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries({
    serviceKey, solYear: String(year), solMonth: String(month).padStart(2, "0"), numOfRows: "100", pageNo: "1",
  })) url.searchParams.set(name, value);
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/xml" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error();
    return parseHolidayResponse(await response.text());
  } catch {
    throw new Error("공휴일 정보를 불러오지 못했습니다.");
  }
}

export async function syncPublicHolidays(store, { serviceKey, now = new Date(), fetchImpl = fetch } = {}) {
  let key = typeof serviceKey === "string" ? serviceKey.trim() : "";
  try { key = decodeURIComponent(key); } catch {}
  if (key.length < 10 || key.length > 500 || typeof store?.replaceHolidays !== "function") throw new Error("공휴일 동기화 설정을 확인해 주세요.");
  const year = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(now));
  const years = [year, year + 1];
  const batches = await Promise.all(years.flatMap(value => Array.from({ length: 12 }, (_, month) => fetchMonth(fetchImpl, key, value, month + 1))));
  const byDate = new Map();
  for (const holiday of batches.flat()) byDate.set(holiday.date, { ...holiday, source: HOLIDAY_SOURCE });
  const holidays = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const count = await store.replaceHolidays(years[0], years[1], holidays);
  return { years, count, updatedAt: new Date().toISOString(), source: HOLIDAY_SOURCE };
}

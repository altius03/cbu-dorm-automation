const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MAX_BATCH_DATES = 370;

// DB가 아직 준비되지 않은 로컬 실행과 장애 시 사용하는 마지막 확인 일정이다.
export const DEFAULT_RESIDENCY_SCHEDULES = [
  {
    from: "2026-02-27", through: "2026-08-28", term: "2026-1",
    ends: { semester: "2026-06-23", sixMonths: "2026-08-15", twelveMonths: "2027-02-13" },
    source: "2026학년도 생활관 모집 공지", updatedAt: "2026-09-19T00:00:00.000Z",
  },
  {
    from: "2026-08-29", through: "2027-02-13", term: "2026-2",
    ends: { semester: "2026-12-23", sixMonths: "2027-02-13", twelveMonths: "2027-02-13" },
    source: "2026학년도 생활관 모집 공지", updatedAt: "2026-09-19T00:00:00.000Z",
  },
];

export function parseIsoDate(value) {
  const match = typeof value === "string" && ISO_DATE.exec(value);
  if (!match) throw new Error("날짜를 선택하세요.");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const parsed = new Date(utc);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("존재하지 않는 날짜입니다.");
  }

  return {
    iso: value,
    compact: `${match[1]}${match[2]}${match[3]}`,
    epochDay: Math.floor(utc / 86400000),
  };
}

export function localIsoDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function validatePeriod(startValue, endValue, now = new Date()) {
  const start = parseIsoDate(startValue);
  const end = parseIsoDate(endValue || startValue);
  const today = parseIsoDate(localIsoDate(now));
  const dayCount = end.epochDay - start.epochDay + 1;

  if (start.epochDay < today.epochDay) {
    throw new Error("지난 날짜는 신청할 수 없습니다.");
  }
  if (dayCount < 1) {
    throw new Error("종료일은 시작일보다 빠를 수 없습니다.");
  }
  if (dayCount > 8) {
    throw new Error("한 번에 최대 7박 8일까지만 신청할 수 있습니다.");
  }
  if (
    start.epochDay === today.epochDay &&
    (now.getHours() > 23 || (now.getHours() === 23 && now.getMinutes() >= 30))
  ) {
    throw new Error("당일 외박신청 마감 시각인 23:30이 지났습니다.");
  }

  return { start, end };
}

export function findConflict(rows, start, end) {
  for (const row of rows) {
    if (row.outStayStGbn === "3") continue;
    const from = row.outStayFrDt || "";
    const to = row.outStayToDt || "";
    if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) continue;
    if (from === start && to === end) return { type: "same", row };
    if (from <= end && start <= to) return { type: "overlap", row };
  }
  return null;
}

function isoFromEpochDay(epochDay) {
  return new Date(epochDay * 86400000).toISOString().slice(0, 10);
}

function datesFrom(epochDay, count) {
  return Array.from({ length: count }, (_, index) => isoFromEpochDay(epochDay + index));
}

function weekends(dates) {
  return dates.filter(value => [0, 5, 6].includes(new Date(`${value}T00:00:00Z`).getUTCDay()));
}

export function groupBatchDates(dates) {
  if (!Array.isArray(dates) || !dates.length || dates.length > MAX_BATCH_DATES) {
    throw new Error("선택한 날짜를 확인해 주세요.");
  }
  const parsed = dates.map(parseIsoDate).sort((left, right) => left.epochDay - right.epochDay);
  if (new Set(parsed.map(date => date.iso)).size !== parsed.length) throw new Error("중복된 날짜를 선택할 수 없습니다.");

  const periods = [];
  let start = parsed[0], end = parsed[0];
  for (const date of parsed.slice(1)) {
    if (date.epochDay === end.epochDay + 1 && date.epochDay - start.epochDay < 8) {
      end = date;
    } else {
      periods.push({ start: start.iso, end: end.iso });
      start = end = date;
    }
  }
  periods.push({ start: start.iso, end: end.iso });
  return periods;
}

export function validateResidencySchedule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !/^\d{4}-[12]$/.test(value.term || "")) {
    throw new Error("생활관 일정 형식을 확인해 주세요.");
  }
  const source = typeof value.source === "string" ? value.source.trim() : "";
  if (!source || source.length > 200) throw new Error("생활관 일정 출처를 확인해 주세요.");
  const from = parseIsoDate(value.from).iso;
  const through = parseIsoDate(value.through).iso;
  const semester = parseIsoDate(value.ends?.semester).iso;
  const sixMonths = parseIsoDate(value.ends?.sixMonths).iso;
  const twelveMonths = parseIsoDate(value.ends?.twelveMonths).iso;
  if (from > through || semester < from || sixMonths < semester || twelveMonths < sixMonths) {
    throw new Error("생활관 일정 날짜 순서를 확인해 주세요.");
  }
  const updatedAt = value.updatedAt === undefined ? undefined : new Date(value.updatedAt).toISOString();
  return { from, through, term: value.term, ends: { semester, sixMonths, twelveMonths }, source, ...(updatedAt ? { updatedAt } : {}) };
}

export function residencyHorizons(todayValue = localIsoDate(), schedules = DEFAULT_RESIDENCY_SCHEDULES) {
  parseIsoDate(todayValue);
  if (!Array.isArray(schedules)) throw new Error("생활관 일정 형식을 확인해 주세요.");
  const schedule = schedules.map(validateResidencySchedule).find(item => item.from <= todayValue && todayValue <= item.through);
  if (!schedule) return [];
  return [
    { id: "semester", label: "학기 퇴관", end: schedule.ends.semester },
    { id: "sixMonths", label: "6개월 퇴관", end: schedule.ends.sixMonths },
    { id: "twelveMonths", label: "12개월 퇴관", end: schedule.ends.twelveMonths },
  ].map(item => ({ ...item, term: schedule.term, source: schedule.source, updatedAt: schedule.updatedAt, available: item.end >= todayValue }));
}

export function buildBatchDates(body, todayValue = localIsoDate(), schedules = DEFAULT_RESIDENCY_SCHEDULES) {
  const today = parseIsoDate(todayValue);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("신청 방식을 선택하세요.");

  if (body.dates !== undefined) {
    if (!Array.isArray(body.dates) || !body.dates.length || body.dates.length > MAX_BATCH_DATES) {
      throw new Error("선택한 날짜를 확인해 주세요.");
    }
    const dates = body.dates.map(value => parseIsoDate(value).iso).sort();
    if (new Set(dates).size !== dates.length) throw new Error("중복된 날짜를 선택할 수 없습니다.");
    return dates;
  }

  const { kind } = body;
  let count;

  if (kind === "daily-month") count = 30;
  else if (kind === "weekends-week") count = 7;
  else if (kind === "weekends-month") count = 30;
  else if (kind === "weekends-term") {
    // ponytail: 학교의 실제 종강일이 아닌 반기 말 기준. 학사 일정 연동 시 이 계산을 교체한다.
    const date = new Date(today.epochDay * 86400000);
    const endMonth = date.getUTCMonth() < 6 ? 6 : 12;
    const end = Date.UTC(date.getUTCFullYear(), endMonth, 0) / 86400000;
    count = end - today.epochDay + 1;
  }
  if (count) {
    const dates = datesFrom(today.epochDay, count);
    return kind === "daily-month" ? dates : weekends(dates);
  }

  const horizon = residencyHorizons(todayValue, schedules).find(item => item.id === body.range && item.available);
  if (!horizon) throw new Error("선택한 입주기간의 퇴관일이 아직 공지되지 않았습니다.");
  const end = parseIsoDate(horizon.end);
  const dates = datesFrom(today.epochDay, end.epochDay - today.epochDay + 1);
  if (body.pattern === "daily") return dates;
  if (body.pattern === "weekdays") return dates.filter(value => {
    const day = new Date(`${value}T00:00:00Z`).getUTCDay();
    return day >= 1 && day <= 5;
  });
  if (body.pattern === "weekends") return weekends(dates);
  if (body.pattern === "custom") {
    if (!Array.isArray(body.weekdays) || !body.weekdays.length || body.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error("신청할 요일을 선택하세요.");
    }
    const weekdays = new Set(body.weekdays);
    return dates.filter(value => weekdays.has(new Date(`${value}T00:00:00Z`).getUTCDay()));
  }
  throw new Error("신청 패턴을 선택하세요.");
}

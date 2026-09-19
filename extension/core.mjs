const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

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
  return dates.filter(value => [0, 6].includes(new Date(`${value}T00:00:00Z`).getUTCDay()));
}

export function buildBatchDates({ kind }, todayValue = localIsoDate()) {
  const today = parseIsoDate(todayValue);
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
  if (!count) throw new Error("일괄신청 방식을 선택하세요.");

  const dates = datesFrom(today.epochDay, count);
  return kind === "daily-month" ? dates : weekends(dates);
}

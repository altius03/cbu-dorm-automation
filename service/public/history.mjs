const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value) {
  const iso = /^\d{8}$/.test(value || "")
    ? value.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")
    : value || "";
  return ISO_DATE.test(iso) ? iso : "";
}

function periodDays(start, end) {
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
  return Number.isInteger(days) && days > 0 ? days : 0;
}

export function summarizeJob(job, counts) {
  const periods = (job.results || []).map(item => ({
    start: isoDate(item.date),
    end: isoDate(item.end || item.date),
  })).filter(item => item.start && item.end && item.start <= item.end);
  const first = periods.map(item => item.start).sort()[0] || "";
  const last = periods.map(item => item.end).sort().at(-1) || first;
  const days = periods.reduce((total, item) => total + periodDays(item.start, item.end), 0);
  if (job.status === "running") return { first, last, days, label: "처리 중", tone: "running" };
  if (job.outcome === "cancelled") return { first, last, days, label: "중단됨", tone: "warning" };
  if (job.status !== "done" || counts.unknown || counts.not_attempted) {
    return { first, last, days, label: "확인 필요", tone: "warning" };
  }
  if (counts.saved) return { first, last, days, label: "신청 완료", tone: "success" };
  if (counts.exists + counts.overlap) return { first, last, days, label: "이미 처리됨", tone: "neutral" };
  return { first, last, days, label: "처리 완료", tone: "neutral" };
}

function shortDate(iso) {
  const [, month, day] = iso.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

export function historyDate(first, last) {
  if (!first) return "날짜 정보 없음";
  const start = `${first.slice(0, 4)}년 ${shortDate(first)}`;
  const end = first.slice(0, 4) === last.slice(0, 4) ? shortDate(last) : `${last.slice(0, 4)}년 ${shortDate(last)}`;
  return first === last ? start : `${start} ~ ${end}`;
}

export function historyTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

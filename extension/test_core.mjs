import assert from "node:assert/strict";
import { MAX_BATCH_DATES, buildBatchDates, findConflict, groupBatchDates, parseIsoDate, residencyHorizons, validatePeriod, validateResidencySchedule } from "./core.mjs";

const now = new Date(2026, 8, 19, 12, 0);
assert.equal(parseIsoDate("2026-09-20").compact, "20260920");
assert.deepEqual(
  validatePeriod("2026-09-20", "2026-09-27", now).end.compact,
  "20260927",
);
assert.throws(() => validatePeriod("2026-09-20", "2026-09-28", now), /7박 8일/);
assert.equal(
  findConflict(
    [{ outStayFrDt: "20260920", outStayToDt: "20260922", outStayStGbn: "1" }],
    "20260922",
    "20260923",
  ).type,
  "overlap",
);
const monthDates = Array.from({ length: MAX_BATCH_DATES }, (_, index) =>
  new Date(Date.UTC(2026, 8, 19 + index)).toISOString().slice(0, 10));
assert.deepEqual(
  [buildBatchDates({ dates: monthDates }, "2026-09-19").length, monthDates.at(-1)],
  [31, "2026-10-19"],
);
assert.deepEqual(
  residencyHorizons("2026-09-19").map(({ id, end }) => [id, end]),
  [["semester", "2026-12-23"], ["sixMonths", "2027-02-13"], ["twelveMonths", "2027-02-13"]],
);
assert.deepEqual(groupBatchDates([
  "2026-09-19", "2026-09-20", "2026-09-25", "2026-09-26", "2026-09-27",
]), [
  { start: "2026-09-19", end: "2026-09-20" },
  { start: "2026-09-25", end: "2026-09-27" },
]);
assert.deepEqual(groupBatchDates(Array.from({ length: 10 }, (_, index) => `2026-09-${String(index + 19).padStart(2, "0")}`)), [
  { start: "2026-09-19", end: "2026-09-26" },
  { start: "2026-09-27", end: "2026-09-28" },
]);
assert.deepEqual(
  buildBatchDates({ dates: ["2026-09-21", "2026-09-20"] }, "2026-09-19"),
  ["2026-09-20", "2026-09-21"],
);
assert.throws(() => buildBatchDates({ dates: Array(MAX_BATCH_DATES + 1).fill("2026-09-20") }, "2026-09-19"), /날짜/);
assert.throws(() => buildBatchDates({ dates: ["2026-10-20"] }, "2026-09-19"), /31일/);
assert.throws(() => buildBatchDates({ dates: ["2026-09-18"] }, "2026-09-19"), /31일/);
assert.deepEqual(residencyHorizons("2027-02-14"), []);
const configured = [{
  from: "2027-02-14", through: "2027-08-28", term: "2027-1",
  ends: { semester: "2027-06-23", sixMonths: "2027-08-15", twelveMonths: "2028-02-13" },
  source: "fixture official notice", updatedAt: "2027-01-01T00:00:00Z",
}];
assert.equal(residencyHorizons("2027-02-14", configured)[0].source, "fixture official notice");
assert.equal(validateResidencySchedule({
  ...configured[0], from: new Date("2027-02-14T00:00:00Z"),
  ends: { ...configured[0].ends, semester: new Date("2027-06-23T00:00:00Z") },
}).ends.semester, "2027-06-23");
assert.throws(() => validateResidencySchedule({ ...configured[0], ends: { ...configured[0].ends, semester: "2026-01-01" } }), /날짜 순서/);

console.log("extension core checks passed");

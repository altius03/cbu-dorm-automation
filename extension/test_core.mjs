import assert from "node:assert/strict";
import { MAX_BATCH_DATES, buildBatchDates, findConflict, parseIsoDate, residencyHorizons, validatePeriod } from "./core.mjs";

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
assert.deepEqual(
  [
    buildBatchDates({ kind: "daily-month" }, "2026-09-19").length,
    buildBatchDates({ kind: "daily-month" }, "2026-09-19").at(-1),
  ],
  [30, "2026-10-18"],
);
assert.deepEqual(
  buildBatchDates({ kind: "weekends-week" }, "2026-09-19"),
  ["2026-09-19", "2026-09-20"],
);
assert.deepEqual(
  buildBatchDates({ kind: "weekends-month" }, "2026-09-19"),
  ["2026-09-19", "2026-09-20", "2026-09-26", "2026-09-27", "2026-10-03", "2026-10-04", "2026-10-10", "2026-10-11", "2026-10-17", "2026-10-18"],
);
assert.deepEqual(
  [
    buildBatchDates({ kind: "weekends-term" }, "2026-09-19")[0],
    buildBatchDates({ kind: "weekends-term" }, "2026-09-19").at(-1),
  ],
  ["2026-09-19", "2026-12-27"],
);
assert.deepEqual(
  residencyHorizons("2026-09-19").map(({ id, end }) => [id, end]),
  [["semester", "2026-12-23"], ["sixMonths", "2027-02-13"], ["twelveMonths", "2027-02-13"]],
);
assert.deepEqual(
  [
    buildBatchDates({ range: "semester", pattern: "daily" }, "2026-09-19").length,
    buildBatchDates({ range: "semester", pattern: "weekdays" }, "2026-09-19").length,
    buildBatchDates({ range: "semester", pattern: "weekends" }, "2026-09-19").length,
  ],
  [96, 68, 28],
);
assert.deepEqual(
  buildBatchDates({ range: "sixMonths", pattern: "custom", weekdays: [1] }, "2026-09-19").slice(0, 2),
  ["2026-09-21", "2026-09-28"],
);
assert.deepEqual(
  buildBatchDates({ dates: ["2026-09-21", "2026-09-20"] }, "2026-09-19"),
  ["2026-09-20", "2026-09-21"],
);
assert.throws(() => buildBatchDates({ dates: Array(MAX_BATCH_DATES + 1).fill("2026-09-20") }, "2026-09-19"), /날짜/);
assert.throws(() => buildBatchDates({ range: "semester", pattern: "custom", weekdays: [] }, "2026-09-19"), /요일/);
assert.deepEqual(residencyHorizons("2027-02-14"), []);

console.log("extension core checks passed");

import { parseArgs } from "node:util";
import { getStore } from "./runtime.mjs";

const required = ["term", "from", "through", "semester", "six-months", "twelve-months", "source"];
const { values } = parseArgs({ options: Object.fromEntries(required.map(name => [name, { type: "string" }])) });
const missing = required.filter(name => !values[name]).map(name => "--" + name);
if (missing.length) throw new Error("필수 옵션이 없습니다: " + missing.join(", "));

const store = getStore();
try {
  const schedule = await store.upsertSchedule({
    term: values.term, from: values.from, through: values.through, source: values.source,
    ends: { semester: values.semester, sixMonths: values["six-months"], twelveMonths: values["twelve-months"] },
  });
  console.log(JSON.stringify(schedule, null, 2));
} finally {
  await store.close();
}

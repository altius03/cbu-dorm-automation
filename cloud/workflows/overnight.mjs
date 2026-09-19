import { sleep } from "workflow";
import { getStore } from "../runtime.mjs";
import { runChunk } from "../runner.mjs";

export async function applyOvernight(jobId) {
  "use workflow";
  let failures = 0;
  for (;;) {
    let result;
    try {
      result = await nextChunk(jobId);
      failures = 0;
    } catch {
      // ponytail: recover transient outages for about an hour; a longer outage
      // resumes from persisted state when the owner next opens the job page.
      if (++failures > 12) throw new Error("작업 상태를 다시 확인해 주세요.");
      await sleep("5m");
      continue;
    }
    if (result === "done") return;
    if (result === "busy") await sleep("30s");
  }
}

async function nextChunk(jobId) {
  "use step";
  // Only this opaque ID and the control string enter Workflow's persisted history.
  try { return await runChunk(jobId, { store: getStore() }); }
  catch { throw new Error("신청 작업을 재확인하고 있습니다."); }
}

import { findConflict } from "../extension/core.mjs";
import { TukoreaPortal } from "../service/portal.mjs";

// Run inside one workflow step. Claims remain durable per period while the school
// session is reused for as many periods as the function time budget safely allows.
export async function runChunk(jobId, {
  store,
  portalFactory = credentials => new TukoreaPortal(credentials.studentId, credentials.password),
  maxItems = 16,
  timeBudgetMs = 180_000,
} = {}) {
  const started = Date.now();
  let school;
  try {
    for (let handled = 0; handled < maxItems; handled++) {
      const claim = await store.claimNext(jobId);
      if (claim.kind === "done" || claim.kind === "busy") return claim.kind;
      if (!["work", "reconcile"].includes(claim.kind)) throw new Error();
      const { attempt, index, date } = claim;
      const end = claim.end ?? date;
      const shouldStop = async () => {
        const job = await store.getJobById(jobId);
        return !job || job.status !== "running" || Boolean(job.cancelRequested);
      };
      let status = "unknown";

      if (claim.kind === "work" && await shouldStop()) {
        status = "not_attempted";
      } else {
        const credentials = school ? true : await store.credentialsForJob(jobId);
        if (!credentials) {
          status = claim.kind === "work" ? "not_attempted" : "unknown";
        } else {
          if (!school) {
            const portal = await portalFactory(credentials);
            const context = await portal.applicationContext();
            school = { portal, context, rows: await context.list() };
          }
          try {
            const conflict = findConflict(school.rows, date, end);
            if (claim.kind === "reconcile") {
              // An expired lease could have saved at school before the function stopped. Never POST again.
              status = conflict?.type === "same" ? "exists" : conflict?.type === "overlap" ? "overlap" : "unknown";
            } else if (conflict) {
              status = conflict.type === "same" ? "exists" : "overlap";
            } else if (await shouldStop()) {
              status = "not_attempted";
            } else {
              const saved = await school.portal.saveAndVerify(school.context, date, end, shouldStop);
              if (saved.cancelled) status = "not_attempted";
              else { school.rows = saved.rows; status = "saved"; }
            }
          } catch (error) {
            if (claim.kind === "work" && error?.code === "INVALID_PERIOD") status = "not_attempted";
            else if (claim.kind === "work" && error?.code === "OVERLAP") status = "overlap";
          }
        }
      }

      let job;
      try { job = await store.finishDate(jobId, { attempt, index, status }); }
      catch (error) {
        // Another worker owns the new lease. The next step may only claim/reconcile its current state.
        if (error?.status === 409) return "busy";
        throw error;
      }
      if (job?.status !== "running") return "done";
      // ponytail: stop before the 300-second function ceiling; the next workflow step resumes the next period.
      if (Date.now() - started >= timeBudgetMs) return "continue";
    }
    return "continue";
  } catch {
    // Workflow engines persist thrown errors, including causes; do not forward database or school errors.
    throw new Error("외박신청 처리 상태를 확인할 수 없습니다. 잠시 후 작업 상태를 확인해 주세요.");
  }
}

export function runNext(jobId, options = {}) {
  return runChunk(jobId, { ...options, maxItems: 1, timeBudgetMs: Number.POSITIVE_INFINITY });
}

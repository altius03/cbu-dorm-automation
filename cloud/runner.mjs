import { findConflict } from "../extension/core.mjs";
import { TukoreaPortal } from "../service/portal.mjs";

// Run inside a workflow step. Only the job ID enters the step and a control word leaves it.
export async function runNext(jobId, {
  store,
  portalFactory = credentials => new TukoreaPortal(credentials.studentId, credentials.password),
} = {}) {
  try {
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
      // Secrets stay in this process; never return them, an upstream exception, or a portal object.
      const credentials = await store.credentialsForJob(jobId);
      if (!credentials) {
        status = claim.kind === "work" ? "not_attempted" : "unknown";
      } else {
        const portal = await portalFactory(credentials);
        try {
          if (claim.kind === "reconcile") {
            // An expired lease could have saved at school before the function stopped. Never POST again.
            const context = await portal.applicationContext();
            const conflict = findConflict(await context.list(), date, end);
            status = conflict?.type === "same" ? "exists" : conflict?.type === "overlap" ? "overlap" : "unknown";
          } else {
            const result = await portal.apply(date, end, { shouldStop });
            if (["saved", "exists", "overlap"].includes(result?.status)) status = result.status;
            else if (result?.status === "cancelled") status = "not_attempted";
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
    return job?.status === "running" ? "continue" : "done";
  } catch {
    // Workflow engines persist thrown errors, including causes; do not forward database or school errors.
    throw new Error("외박신청 처리 상태를 확인할 수 없습니다. 잠시 후 작업 상태를 확인해 주세요.");
  }
}

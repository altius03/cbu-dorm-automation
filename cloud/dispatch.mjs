import { HttpError } from "../service/errors.mjs";

// A durable dispatch lease closes the DB-commit/enqueue gap. Polling retries only
// expired dispatches; the worker's independent attempt fence prevents duplicate saves.
export async function dispatchJob(store, id, start) {
  if (!await store.claimDispatch(id)) return;
  try { await start(id); }
  catch {
    await store.releaseDispatch(id);
    throw new HttpError(503, "신청은 보관되어 있습니다. 잠시 후 처리 상태를 다시 확인해 주세요.");
  }
}

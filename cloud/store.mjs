import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { decodeKey, seal, tokenHash, unseal } from "../service/crypto.mjs";
import { HttpError } from "../service/errors.mjs";
import { MAX_BATCH_DATES, parseIsoDate } from "../extension/core.mjs";

export { HttpError as StoreError } from "../service/errors.mjs";
const leaseMs = 360_000; // Must exceed the 300-second worker limit; an expired attempt is read-only reconciliation.
const iso = value => new Date(value).toISOString();
const validToken = token => typeof token === "string" && token.length >= 32 && token.length <= 128;
const validId = id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const jobView = row => row ? { ...row.result, id: row.id, status: row.status, cancelRequested: row.cancel_requested, updatedAt: iso(row.updated_at) } : null;
const terminalDate = new Set(["saved", "exists", "overlap", "unknown", "not_attempted"]);

function datesForJob(dates) {
  if (!Array.isArray(dates) || !dates.length || dates.length > MAX_BATCH_DATES) throw new HttpError(400, "신청 날짜를 확인해 주세요.");
  const result = dates.map(item => {
    const date = typeof item === "string" ? item : item?.date;
    const end = typeof item === "string" ? item : item?.end || date;
    const parsed = [];
    for (const value of [date, end]) {
      if (typeof value !== "string" || !/^\d{8}$/.test(value)) throw new HttpError(400, "신청 날짜를 확인해 주세요.");
      try { parsed.push(parseIsoDate(value.slice(0, 4) + "-" + value.slice(4, 6) + "-" + value.slice(6))); }
      catch { throw new HttpError(400, "신청 날짜를 확인해 주세요."); }
    }
    if (end < date || parsed[1].epochDay - parsed[0].epochDay >= 8) throw new HttpError(400, "신청 기간을 확인해 주세요.");
    return { date, end, status: "not_attempted" };
  });
  if (new Set(result.map(row => row.date)).size !== result.length) throw new HttpError(400, "중복된 신청 날짜입니다.");
  return result;
}

function completeResult(result, cancelled = false) {
  const summary = Object.fromEntries([...terminalDate].map(status => [status, result.results.filter(row => row.status === status).length]));
  const outcome = cancelled ? "cancelled" : summary.unknown || summary.not_attempted ? "partial" : "batch";
  return { ...result, summary, outcome, message: outcome === "cancelled" ? "남은 신청을 중단했습니다. 이미 접수된 날짜는 유지됩니다." : outcome === "partial" ? "확인이 필요한 결과가 있습니다. 학교 신청 내역을 확인해 주세요." : "모든 신청 결과를 확인했습니다." };
}

export class PostgresStore {
  constructor({ sql, key = process.env.OVERNIGHT_MASTER_KEY, schema = "overnight_private" }) {
    if (!sql || !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Postgres 저장소 설정을 확인해 주세요.");
    this.sql = sql;
    this.key = Buffer.isBuffer(key) ? decodeKey(key.toString("base64")) : decodeKey(key);
    this.schema = schema;
    this.t = Object.fromEntries(["key_guard", "profiles", "used_setup_tokens", "batch_jobs", "rate_limits", "busy_locks"].map(name => [name, `"${schema}"."${name}"`]));
  }

  hash(namespace, value) { return createHmac("sha256", this.key).update(namespace + "\0" + value).digest(); }
  accountKey(credentials) { return this.hash("overnight-account-v1", credentials.studentId.trim().toLowerCase()); }

  ready() {
    this.verified ||= this.sql.begin(async tx => {
      const fingerprint = this.hash("overnight-key-guard-v1", "");
      const [existing] = await tx.unsafe(`SELECT fingerprint FROM ${this.t.key_guard} WHERE id = 1`);
      if (!existing) {
        for (const row of await tx.unsafe(`SELECT id, credential_ciphertext FROM ${this.t.profiles}`)) {
          try { unseal(row.credential_ciphertext, row.id, this.key); }
          catch { throw new Error("저장된 계정의 원래 암호화 키가 필요합니다."); }
        }
        await tx.unsafe(`INSERT INTO ${this.t.key_guard} VALUES (1, $1) ON CONFLICT DO NOTHING`, [fingerprint]);
      }
      const [guard] = await tx.unsafe(`SELECT fingerprint FROM ${this.t.key_guard} WHERE id = 1`);
      if (!guard || guard.fingerprint.length !== fingerprint.length || !timingSafeEqual(guard.fingerprint, fingerprint)) throw new Error("저장된 계정의 원래 암호화 키가 필요합니다.");
    }).catch(error => { this.verified = null; throw error; });
    return this.verified;
  }

  async q(statement, values = [], tx = this.sql) { await this.ready(); return tx.unsafe(statement, values); }
  async transaction(task) { await this.ready(); return this.sql.begin(task); }
  async health() { await this.q("SELECT 1"); return true; }
  async setupUsed(token) { return (await this.q(`SELECT 1 FROM ${this.t.used_setup_tokens} WHERE token_hash = $1`, [tokenHash(token)])).length > 0; }

  async create(credentials, setupToken = "") {
    const id = randomUUID(), token = randomBytes(32).toString("base64url");
    try {
      return await this.transaction(async tx => {
        if (setupToken) await this.q(`INSERT INTO ${this.t.used_setup_tokens}(token_hash) VALUES ($1)`, [tokenHash(setupToken)], tx);
        const [row] = await this.q(`INSERT INTO ${this.t.profiles}(id, account_key, token_hash, credential_ciphertext) VALUES ($1, $2, $3, $4) RETURNING created_at`, [id, this.accountKey(credentials), tokenHash(token), seal(credentials, id, this.key)], tx);
        return { id, token, createdAt: iso(row.created_at) };
      });
    } catch (error) {
      if (error.code === "23505") throw new HttpError(409, "이미 연결된 계정이거나 사용한 연결 링크입니다. 저장된 계정 다시 연결을 이용해 주세요.");
      throw error;
    }
  }

  async find(token, { credentials = true, now = Date.now() } = {}) {
    if (!validToken(token) || !Number.isFinite(now)) return null;
    const [row] = await this.q(`SELECT id, credential_ciphertext, created_at FROM ${this.t.profiles} WHERE token_hash = $1 AND updated_at > $2::timestamptz - interval '365 days'`, [tokenHash(token), iso(now)]);
    return row ? { id: row.id, createdAt: iso(row.created_at), ...(credentials ? { credentials: unseal(row.credential_ciphertext, row.id, this.key) } : {}) } : null;
  }

  async claim(token, { now = Date.now() } = {}) {
    if (!validToken(token) || !Number.isFinite(now)) return null;
    const replacement = randomBytes(32).toString("base64url");
    const [row] = await this.q(`UPDATE ${this.t.profiles} SET token_hash = $1, updated_at = $2 WHERE token_hash = $3 AND updated_at > $2::timestamptz - interval '365 days' RETURNING id, created_at`, [tokenHash(replacement), iso(now), tokenHash(token)]);
    return row ? { id: row.id, token: replacement, createdAt: iso(row.created_at) } : null;
  }

  // Caller must successfully verify these credentials at the school before reconnecting.
  async reconnect(credentials, { now = Date.now() } = {}) {
    return this.transaction(async tx => {
      const [row] = await this.q(`SELECT id, created_at FROM ${this.t.profiles} WHERE account_key = $1 FOR UPDATE`, [this.accountKey(credentials)], tx);
      if (!row) return null;
      const token = randomBytes(32).toString("base64url");
      await this.q(`UPDATE ${this.t.profiles} SET token_hash = $1, credential_ciphertext = $2, updated_at = $3 WHERE id = $4`, [tokenHash(token), seal(credentials, row.id, this.key), iso(now), row.id], tx);
      return { id: row.id, token, createdAt: iso(row.created_at) };
    });
  }

  async delete(id) {
    if (!validId(id)) return false;
    return this.transaction(async tx => {
      const [profile] = await this.q(`SELECT id FROM ${this.t.profiles} WHERE id = $1 FOR UPDATE`, [id], tx);
      if (!profile) return false;
      if ((await this.q(`SELECT 1 FROM ${this.t.batch_jobs} WHERE profile_id = $1 AND status = 'running'`, [id], tx)).length) throw new HttpError(409, "신청 처리 중에는 계정을 삭제할 수 없습니다.");
      await this.q(`DELETE FROM ${this.t.profiles} WHERE id = $1`, [id], tx);
      return true;
    });
  }

  async createJob(id, profileId, dates) {
    if (!validId(id) || !validId(profileId)) throw new HttpError(400, "신청 번호를 확인해 주세요.");
    const results = datesForJob(dates);
    try {
      return await this.transaction(async tx => {
        if (!(await this.q(`SELECT id FROM ${this.t.profiles} WHERE id = $1 FOR UPDATE`, [profileId], tx)).length) throw new HttpError(409, "계정 연결 상태를 다시 확인해 주세요.");
        const [existing] = await this.q(`SELECT * FROM ${this.t.batch_jobs} WHERE id = $1`, [id], tx);
        if (existing) {
          const periods = rows => rows.map(({ date, end }) => [date, end || date]);
          if (existing.profile_id !== profileId || JSON.stringify(periods(existing.result.results)) !== JSON.stringify(periods(results))) throw new HttpError(409, "다른 내용으로 사용된 신청 번호입니다.");
          return jobView(existing);
        }
        const [row] = await this.q(`INSERT INTO ${this.t.batch_jobs}(id, profile_id, status, result) VALUES ($1, $2, 'running', $3::jsonb) RETURNING *`, [id, profileId, { results, message: "신청 처리를 기다리고 있습니다." }], tx);
        return jobView(row);
      });
    } catch (error) {
      if (error.code === "23505") throw new HttpError(409, "이 계정의 신청을 처리 중입니다. 완료 후 다시 시도해 주세요.");
      throw error;
    }
  }

  async updateJob(id, status, result) {
    if (!["running", "done", "failed", "interrupted"].includes(status) || !result || !Array.isArray(result.results)) throw new HttpError(400, "신청 결과 형식을 확인해 주세요.");
    const [row] = await this.q(`UPDATE ${this.t.batch_jobs} SET status = $2, result = $3::jsonb, updated_at = clock_timestamp() WHERE id = $1 AND status = 'running' AND attempt IS NULL RETURNING *`, [id, status, result]);
    if (!row) throw new HttpError(409, "처리 중이거나 종료된 작업 결과는 덮어쓸 수 없습니다.");
    return jobView(row);
  }

  async job(profileId, id = null) {
    if (!validId(profileId) || (id !== null && !validId(id))) return null;
    const rows = id ? await this.q(`SELECT * FROM ${this.t.batch_jobs} WHERE profile_id = $1 AND id = $2`, [profileId, id]) : await this.q(`SELECT * FROM ${this.t.batch_jobs} WHERE profile_id = $1 ORDER BY updated_at DESC, created_at DESC LIMIT 1`, [profileId]);
    return jobView(rows[0]);
  }
  async jobs(profileId, limit = 10) {
    if (!validId(profileId)) return [];
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, "조회할 작업 개수가 올바르지 않습니다.");
    return (await this.q(`SELECT * FROM ${this.t.batch_jobs} WHERE profile_id = $1 ORDER BY updated_at DESC, created_at DESC LIMIT $2`, [profileId, limit])).map(jobView);
  }
  async getJobById(id) {
    if (!validId(id)) return null;
    const [row] = await this.q(`SELECT * FROM ${this.t.batch_jobs} WHERE id = $1`, [id]);
    return row ? { ...jobView(row), profileId: row.profile_id } : null;
  }
  async credentialsForJob(id) {
    if (!validId(id)) return null;
    const [row] = await this.q(`SELECT p.id, p.credential_ciphertext FROM ${this.t.profiles} p JOIN ${this.t.batch_jobs} j ON j.profile_id = p.id WHERE j.id = $1 AND j.status = 'running'`, [id]);
    return row ? unseal(row.credential_ciphertext, row.id, this.key) : null;
  }

  async claimDispatch(id) {
    return (await this.q(`UPDATE ${this.t.batch_jobs} SET dispatch_until = clock_timestamp() + interval '6 minutes' WHERE id = $1 AND status = 'running' AND (dispatch_until IS NULL OR dispatch_until <= clock_timestamp()) RETURNING id`, [id])).length > 0;
  }
  async releaseDispatch(id) { await this.q(`UPDATE ${this.t.batch_jobs} SET dispatch_until = NULL WHERE id = $1 AND status = 'running'`, [id]); }

  async claimNext(id) {
    return this.transaction(async tx => {
      const [row] = await this.q(`SELECT *, lease_until > clock_timestamp() AS live_lease FROM ${this.t.batch_jobs} WHERE id = $1 FOR UPDATE`, [id], tx);
      if (!row || row.status !== "running") return { kind: "done" };
      if (row.attempt && row.live_lease) return { kind: "busy" };
      const result = row.result;
      let index = row.attempt ? row.claim_index : result.results.findIndex(item => item.status === "unknown");
      let kind = index >= 0 ? "reconcile" : "work";
      if (index < 0 && !row.cancel_requested) index = result.results.findIndex(item => item.status === "not_attempted");
      if (index < 0) {
        await this.q(`UPDATE ${this.t.batch_jobs} SET status = 'done', result = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1`, [id, completeResult(result, row.cancel_requested)], tx);
        return { kind: "done" };
      }
      result.results[index].status = "unknown";
      const attempt = randomUUID();
      await this.q(`UPDATE ${this.t.batch_jobs} SET result = $2::jsonb, claim_index = $3, attempt = $4, lease_until = clock_timestamp() + interval '6 minutes', dispatch_until = clock_timestamp() + interval '6 minutes', updated_at = clock_timestamp() WHERE id = $1`, [id, result, index, attempt], tx);
      return { kind, index, date: result.results[index].date, end: result.results[index].end || result.results[index].date, attempt };
    });
  }

  async finishDate(id, { attempt, index, status, message }) {
    if (!terminalDate.has(status) || !Number.isInteger(index)) throw new HttpError(400, "신청 결과 형식을 확인해 주세요.");
    return this.transaction(async tx => {
      const [row] = await this.q(`SELECT * FROM ${this.t.batch_jobs} WHERE id = $1 FOR UPDATE`, [id], tx);
      if (!row || row.status !== "running" || row.attempt !== attempt || row.claim_index !== index) throw new HttpError(409, "신청 처리 소유권이 만료되었습니다.");
      const result = row.result;
      result.results[index] = { ...result.results[index], status, ...(typeof message === "string" ? { message: message.slice(0, 500) } : {}) };
      const done = row.cancel_requested || ["unknown", "not_attempted"].includes(status) || result.results.every(item => ["saved", "exists", "overlap"].includes(item.status));
      const finalResult = done ? completeResult(result, row.cancel_requested) : result;
      const [updated] = await this.q(`UPDATE ${this.t.batch_jobs} SET status = $2, result = $3::jsonb, attempt = NULL, claim_index = NULL, lease_until = NULL, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`, [id, done ? "done" : "running", finalResult], tx);
      return jobView(updated);
    });
  }

  async cancelJob(profileId, id) {
    if (!validId(profileId) || !validId(id)) return null;
    const [row] = await this.q(`UPDATE ${this.t.batch_jobs} SET cancel_requested = CASE WHEN status = 'running' THEN true ELSE cancel_requested END, updated_at = CASE WHEN status = 'running' THEN clock_timestamp() ELSE updated_at END WHERE profile_id = $1 AND id = $2 RETURNING *`, [profileId, id]);
    return jobView(row);
  }

  async consumeRate(key, limit, windowMs) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) throw new Error("요청 제한 설정을 확인해 주세요.");
    const [row] = await this.q(`INSERT INTO ${this.t.rate_limits} AS current(key_hash, count, expires_at) VALUES ($1, 1, clock_timestamp() + $2 * interval '1 millisecond') ON CONFLICT (key_hash) DO UPDATE SET count = CASE WHEN current.expires_at <= clock_timestamp() THEN 1 ELSE least(current.count + 1, $3 + 1) END, expires_at = CASE WHEN current.expires_at <= clock_timestamp() THEN EXCLUDED.expires_at ELSE current.expires_at END RETURNING count`, [this.hash("overnight-rate-v1", key), windowMs, limit]);
    if (!this.lastCleanup || Date.now() - this.lastCleanup >= 60_000) {
      this.lastCleanup = Date.now();
      for (const table of [this.t.rate_limits, this.t.busy_locks]) {
        await this.q(`DELETE FROM ${table} WHERE key_hash IN (SELECT key_hash FROM ${table} WHERE expires_at < clock_timestamp() - interval '1 day' ORDER BY expires_at LIMIT 1000)`);
      }
    }
    if (row.count > limit) throw new HttpError(429, "요청이 많습니다. 잠시 후 다시 시도해 주세요.");
    return true;
  }

  async withBusy(key, task) {
    const owner = randomUUID(), hash = this.hash("overnight-lock-v1", key);
    const rows = await this.q(`INSERT INTO ${this.t.busy_locks} AS current(key_hash, owner, expires_at) VALUES ($1, $2, clock_timestamp() + interval '6 minutes') ON CONFLICT (key_hash) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at WHERE current.expires_at <= clock_timestamp() RETURNING owner`, [hash, owner]);
    if (!rows.length) throw new HttpError(409, "이 계정의 요청을 처리 중입니다. 완료 후 다시 시도해 주세요.");
    try { return await task(); }
    finally { await this.q(`DELETE FROM ${this.t.busy_locks} WHERE key_hash = $1 AND owner = $2`, [hash, owner]); }
  }

  async close() { await this.sql.end({ timeout: 5 }); }
}

export const internals = { datesForJob, completeResult, leaseMs };

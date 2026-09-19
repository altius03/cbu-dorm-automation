import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_RESIDENCY_SCHEDULES, validateResidencySchedule } from "../extension/core.mjs";
import { decodeKey, seal, tokenHash, unseal } from "./crypto.mjs";
import { HttpError } from "./errors.mjs";

function loadMasterKey(dataDirectory) {
  if (process.env.OVERNIGHT_MASTER_KEY) return decodeKey(process.env.OVERNIGHT_MASTER_KEY);
  if (process.env.NODE_ENV === "production") {
    throw new Error("운영 환경에서는 OVERNIGHT_MASTER_KEY가 필요합니다.");
  }
  const keyPath = join(dataDirectory, "master.key");
  if (!existsSync(keyPath)) {
    if (existsSync(join(dataDirectory, "overnight.db"))) throw new Error("기존 계정 DB의 암호화 키가 없습니다. 원래 키를 복구해 주세요.");
    writeFileSync(keyPath, randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 });
  }
  chmodSync(keyPath, 0o600);
  return decodeKey(readFileSync(keyPath, "utf8"));
}

function jobResult(value) {
  try {
    const result = JSON.parse(value);
    if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.results)
      || result.results.some(row => !row || typeof row !== "object" || Array.isArray(row) || typeof row.status !== "string")) throw new Error();
    return result;
  } catch {
    throw new Error("저장된 일괄신청 결과가 손상되었습니다. DB 백업과 학교 신청 내역을 확인해 주세요.");
  }
}

function storedJob(row) {
  return row ? { ...jobResult(row.result), id: row.id, status: row.status, updatedAt: row.updated_at } : null;
}

function completed(result) {
  const statuses = ["saved", "exists", "overlap", "unknown", "not_attempted"];
  const summary = Object.fromEntries(statuses.map(status => [status, result.results.filter(row => row.status === status).length]));
  const outcome = result.cancelRequested ? "cancelled" : summary.unknown || summary.not_attempted ? "partial" : "batch";
  const message = outcome === "cancelled"
    ? "남은 신청을 중단했습니다. 이미 접수된 날짜는 유지됩니다."
    : summary.unknown ? "확인이 필요한 결과가 있습니다. 학교 신청 내역을 확인해 주세요."
      : summary.not_attempted ? "학교 신청내역에서 확인되지 않은 기간이 있습니다. 필요한 날짜만 다시 신청해 주세요."
        : "모든 신청 결과를 확인했습니다.";
  return { ...result, summary, outcome, message };
}

export class CredentialStore {
  constructor(dataDirectory) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
    this.key = loadMasterKey(dataDirectory);
    const databasePath = join(dataDirectory, "overnight.db");
    this.database = new DatabaseSync(databasePath);
    try {
      chmodSync(databasePath, 0o600);
      this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      BEGIN IMMEDIATE;
    `);
      try {
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        token_hash BLOB NOT NULL UNIQUE,
        credential_ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS used_setup_tokens (
        token_hash BLOB PRIMARY KEY,
        used_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS batch_jobs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        result TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_batch
        ON batch_jobs(profile_id) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS runtime_owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        token TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS residency_schedules (
        term TEXT PRIMARY KEY,
        starts_on TEXT NOT NULL,
        through_on TEXT NOT NULL,
        semester_end TEXT NOT NULL,
        six_month_end TEXT NOT NULL,
        twelve_month_end TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
        `);
        const seedSchedule = this.database.prepare("INSERT OR IGNORE INTO residency_schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        for (const schedule of DEFAULT_RESIDENCY_SCHEDULES) seedSchedule.run(
          schedule.term, schedule.from, schedule.through, schedule.ends.semester, schedule.ends.sixMonths,
          schedule.ends.twelveMonths, schedule.source, schedule.updatedAt,
        );
        // 잘못 교체한 키로 새 계정을 저장하기 전에 기존 암호문의 인증을 확인한다.
        for (const row of this.database.prepare("SELECT id, credential_ciphertext FROM profiles").iterate()) {
          try { unseal(row.credential_ciphertext, row.id, this.key); }
          catch { throw new Error("저장된 계정을 복호화할 수 없습니다. 기존 암호화 키와 DB를 복구해 주세요."); }
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
    this.findStatement = this.database.prepare(
      "SELECT id, credential_ciphertext, created_at, updated_at FROM profiles WHERE token_hash = ?",
    );
    this.insertStatement = this.database.prepare(
      "INSERT INTO profiles (id, token_hash, credential_ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.claimStatement = this.database.prepare(
      "UPDATE profiles SET token_hash = ?, updated_at = ? WHERE id = ? AND token_hash = ?",
    );
    this.deleteStatement = this.database.prepare("DELETE FROM profiles WHERE id = ?");
  }

  setupUsed(token) {
    return Boolean(this.database.prepare("SELECT 1 FROM used_setup_tokens WHERE token_hash = ?").get(tokenHash(token)));
  }

  create(credentials, setupToken = "") {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (setupToken) this.database.prepare("INSERT INTO used_setup_tokens VALUES (?, ?)").run(tokenHash(setupToken), now);
      this.insertStatement.run(id, tokenHash(token), seal(credentials, id, this.key), now, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { id, token, createdAt: now };
  }

  find(token, { credentials = true, now = Date.now() } = {}) {
    if (typeof token !== "string" || token.length < 32 || token.length > 128) return null;
    const row = this.findStatement.get(tokenHash(token));
    const updatedAt = row ? Date.parse(row.updated_at) : NaN;
    if (!Number.isFinite(now) || !Number.isFinite(updatedAt) || now - updatedAt >= 31_536_000_000) return null;
    return {
      id: row.id,
      createdAt: row.created_at,
      ...(credentials ? { credentials: unseal(row.credential_ciphertext, row.id, this.key) } : {}),
    };
  }

  claim(token, { now = Date.now() } = {}) {
    const profile = this.find(token, { credentials: false, now });
    if (!profile) return null;
    const replacement = randomBytes(32).toString("base64url");
    const updated = this.claimStatement.run(
      tokenHash(replacement), new Date(now).toISOString(), profile.id, tokenHash(token),
    );
    return updated.changes === 1 ? { id: profile.id, token: replacement, createdAt: profile.createdAt } : null;
  }

  // 호출자는 반드시 이 자격 증명으로 학교 로그인을 성공한 뒤 복구를 요청해야 한다.
  reconnect(credentials, { now = Date.now() } = {}) {
    const studentId = credentials.studentId.trim();
    const timestamp = new Date(now).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let profile;
      for (const row of this.database.prepare("SELECT id, credential_ciphertext, created_at FROM profiles ORDER BY updated_at DESC, rowid DESC").iterate()) {
        const saved = unseal(row.credential_ciphertext, row.id, this.key);
        if (saved.studentId.trim().toLowerCase() === studentId.toLowerCase()) { profile = row; break; }
      }
      let result = null;
      if (profile) {
        const token = randomBytes(32).toString("base64url");
        this.database.prepare("UPDATE profiles SET token_hash = ?, credential_ciphertext = ?, updated_at = ? WHERE id = ?")
          .run(tokenHash(token), seal({ studentId, password: credentials.password }, profile.id, this.key), timestamp, profile.id);
        result = { id: profile.id, token, createdAt: profile.created_at };
      }
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  delete(id) {
    return this.deleteStatement.run(id).changes === 1;
  }

  createJob(id, profileId, dates) {
    this.database.prepare("INSERT INTO batch_jobs VALUES (?, ?, 'running', ?, ?)").run(
      id, profileId, JSON.stringify({ results: dates.map(item => typeof item === "string" ? { date: item, status: "not_attempted" } : { date: item.date, end: item.end || item.date, status: "not_attempted" }), message: "일괄신청을 처리하고 있습니다." }), new Date().toISOString(),
    );
  }

  updateJob(id, status, result) {
    if (!["running", "done", "failed", "interrupted"].includes(status)) throw new Error("잘못된 일괄신청 상태입니다.");
    const serialized = JSON.stringify(result);
    jobResult(serialized);
    const updated = this.database.prepare("UPDATE batch_jobs SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(status, serialized, new Date().toISOString(), id);
    if (updated.changes !== 1) throw new Error("종료되었거나 존재하지 않는 일괄신청 작업입니다.");
  }

  job(profileId, id = null) {
    const row = id
      ? this.database.prepare("SELECT * FROM batch_jobs WHERE profile_id = ? AND id = ?").get(profileId, id)
      : this.database.prepare("SELECT * FROM batch_jobs WHERE profile_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(profileId);
    return storedJob(row);
  }

  jobs(profileId, limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("조회할 작업 개수가 올바르지 않습니다.");
    return this.database.prepare("SELECT * FROM batch_jobs WHERE profile_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?")
      .all(profileId, limit).map(storedJob);
  }

  schedules() {
    return this.database.prepare("SELECT * FROM residency_schedules ORDER BY starts_on").all().map(row => validateResidencySchedule({
      from: row.starts_on, through: row.through_on, term: row.term,
      ends: { semester: row.semester_end, sixMonths: row.six_month_end, twelveMonths: row.twelve_month_end },
      source: row.source, updatedAt: row.updated_at,
    }));
  }

  upsertSchedule(value) {
    const schedule = validateResidencySchedule(value);
    const updatedAt = new Date().toISOString();
    this.database.prepare(`INSERT INTO residency_schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(term) DO UPDATE SET starts_on = excluded.starts_on, through_on = excluded.through_on,
      semester_end = excluded.semester_end, six_month_end = excluded.six_month_end,
      twelve_month_end = excluded.twelve_month_end, source = excluded.source, updated_at = excluded.updated_at`).run(
      schedule.term, schedule.from, schedule.through, schedule.ends.semester, schedule.ends.sixMonths,
      schedule.ends.twelveMonths, schedule.source, updatedAt,
    );
    return this.schedules().find(item => item.term === schedule.term);
  }

  reconcileJob(profileId, id, resolutions) {
    if (!Array.isArray(resolutions) || resolutions.some(item => !Number.isInteger(item?.index) || !["saved", "overlap", "not_attempted"].includes(item.status))) {
      throw new HttpError(400, "확인 결과 형식을 확인해 주세요.");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM batch_jobs WHERE profile_id = ? AND id = ?").get(profileId, id);
      if (!row) { this.database.exec("COMMIT"); return null; }
      if (row.status === "running") throw new HttpError(409, "처리 중인 신청은 완료 후 다시 확인해 주세요.");
      const result = jobResult(row.result);
      for (const { index, status } of resolutions) {
        if (result.results[index]?.status === "unknown") result.results[index] = { ...result.results[index], status };
      }
      const final = completed(result);
      this.database.prepare("UPDATE batch_jobs SET status = 'done', result = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(final), new Date().toISOString(), id);
      this.database.exec("COMMIT");
      return this.job(profileId, id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recoverJobs() {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.database.prepare("SELECT id, result FROM batch_jobs WHERE status = 'running'").all()) {
        this.updateJob(row.id, "interrupted", {
          ...jobResult(row.result),
          message: "서버가 재시작되어 처리가 중단되었습니다. 확인되지 않은 날짜는 학교 신청 내역에서 확인한 뒤 다시 신청해 주세요.",
        });
      }
      // 확인 필요 결과는 날짜가 지나도 남긴다. 완전히 확인된 결과만 30일 뒤 정리한다.
      const expired = this.database.prepare("SELECT id, result FROM batch_jobs WHERE updated_at < ? AND status = 'done'")
        .all(new Date(Date.now() - 30 * 86_400_000).toISOString());
      const remove = this.database.prepare("DELETE FROM batch_jobs WHERE id = ?");
      for (const row of expired) {
        const { results } = jobResult(row.result);
        if (Array.isArray(results) && results.length && results.every(result => ["saved", "exists", "overlap"].includes(result.status))) remove.run(row.id);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  acquireRuntime() {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const owner = this.database.prepare("SELECT pid, token FROM runtime_owner WHERE id = 1").get();
      if (owner && owner.token !== this.runtimeToken) {
        let alive = true;
        try { process.kill(owner.pid, 0); }
        catch (error) { if (error.code === "ESRCH") alive = false; }
        if (alive) throw new Error("이 DB를 사용하는 서버가 이미 실행 중입니다. 기존 서버를 정상 종료해 주세요.");
      }
      const token = this.runtimeToken || randomUUID();
      // ponytail: 같은 호스트의 로컬 SQLite에 한정한다. 공유 디스크 운영은 DB 임대 잠금으로 교체한다.
      this.database.prepare("INSERT INTO runtime_owner VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, token = excluded.token")
        .run(process.pid, token);
      this.database.exec("COMMIT");
      this.runtimeToken = token;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseRuntime() {
    if (!this.runtimeToken) return;
    this.database.prepare("DELETE FROM runtime_owner WHERE id = 1 AND token = ?").run(this.runtimeToken);
    this.runtimeToken = null;
  }

  close() {
    this.releaseRuntime();
    this.database.close();
  }
}

export const internals = { decodeKey, seal, tokenHash, unseal };

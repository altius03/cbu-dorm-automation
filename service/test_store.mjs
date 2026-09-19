import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { CredentialStore, internals } from "./store.mjs";

const directory = mkdtempSync(join(tmpdir(), "tuk-store-test-"));
const previousKey = process.env.OVERNIGHT_MASTER_KEY;
const previousMode = process.env.NODE_ENV;
delete process.env.OVERNIGHT_MASTER_KEY;
delete process.env.NODE_ENV;
const credentials = { studentId: "fixture123", password: "fixture-only-password" };
const opened = new Set();
const open = path => { const store = new CredentialStore(path); opened.add(store); return store; };
const close = store => { store.close(); opened.delete(store); };
try {
  const key = randomBytes(32);
  assert.deepEqual(internals.decodeKey(key.toString("base64")), key);
  assert.deepEqual(internals.decodeKey(key.toString("base64").replace(/=$/, "")), key);
  for (const invalid of ["", "!" + key.toString("base64"), key.toString("base64") + "=", undefined]) {
    assert.throws(() => internals.decodeKey(invalid), /32바이트/);
  }

  // 기존 스키마를 직접 만든다. 잘못된 키로 시작하면 마이그레이션도 커밋하지 않는다.
  const legacyPath = join(directory, "overnight.db");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("CREATE TABLE profiles (id TEXT PRIMARY KEY, token_hash BLOB NOT NULL UNIQUE, credential_ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT");
  const token = randomBytes(32).toString("base64url");
  const timestamp = new Date().toISOString();
  legacy.prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?)").run("legacy-profile", internals.tokenHash(token), internals.seal(credentials, "legacy-profile", key), timestamp, timestamp);
  const original = legacy.prepare("SELECT * FROM profiles").get();
  legacy.close();
  writeFileSync(join(directory, "master.key"), key.toString("base64"), { mode: 0o600 });
  process.env.OVERNIGHT_MASTER_KEY = randomBytes(32).toString("base64");
  assert.throws(() => new CredentialStore(directory), /복호화할 수 없습니다/);
  const afterFailure = new DatabaseSync(legacyPath);
  assert.deepEqual(afterFailure.prepare("SELECT * FROM profiles").get(), original);
  assert.equal(afterFailure.prepare("SELECT 1 FROM sqlite_master WHERE name = 'batch_jobs'").get(), undefined);
  afterFailure.close();
  delete process.env.OVERNIGHT_MASTER_KEY;
  let store = open(directory);
  assert.equal(store.schedules().find(item => item.term === "2026-2").ends.semester, "2026-12-23");
  assert.equal(store.upsertSchedule({
    term: "2027-1", from: "2027-02-14", through: "2027-08-28", source: "fixture notice",
    ends: { semester: "2027-06-23", sixMonths: "2027-08-15", twelveMonths: "2028-02-13" },
  }).source, "fixture notice");
  assert.deepEqual(store.find(token).credentials, credentials);
  assert.deepEqual(store.database.prepare("SELECT * FROM profiles").get(), original);
  assert.equal(store.find(token, { now: NaN }), null);
  store.database.prepare("UPDATE profiles SET updated_at = 'invalid' WHERE id = ?").run("legacy-profile");
  assert.equal(store.find(token), null);
  assert.equal(store.claim(token), null);
  store.database.prepare("UPDATE profiles SET updated_at = ? WHERE id = ?").run(timestamp, "legacy-profile");
  const expiry = Date.parse(timestamp) + 31_536_000_000;
  assert.equal(store.claim(token, { now: expiry }), null);
  const claimed = store.claim(token, { now: expiry - 1 });
  assert.ok(claimed);
  assert.equal(store.find(token), null);
  assert.equal(store.database.prepare("SELECT updated_at FROM profiles WHERE id = ?").get(claimed.id).updated_at, new Date(expiry - 1).toISOString());
  assert.deepEqual(store.find(claimed.token).credentials, credentials);

  // 종료 결과를 늦은 진행 콜백이 덮어쓰지 못하며 불명확한 결과는 만료 삭제하지 않는다.
  const stale = new Date(Date.now() - 40 * 86_400_000).toISOString();
  for (const [id, resultStatus] of [["resolved", "saved"], ["uncertain", "unknown"], ["unattempted", "not_attempted"]]) {
    store.createJob(id, claimed.id, ["20990101"]);
    store.updateJob(id, "done", { results: [{ date: "20990101", status: resultStatus }] });
    store.database.prepare("UPDATE batch_jobs SET updated_at = ? WHERE id = ?").run(stale, id);
  }
  assert.throws(() => store.updateJob("uncertain", "running", { results: [] }), /종료/);
  store.createJob("recover", claimed.id, ["20990102"]);
  assert.throws(() => store.updateJob("recover", "invalid", { results: [] }), /잘못된/);
  assert.throws(() => store.updateJob("recover", "done", null), /손상/);
  store.updateJob("recover", "running", { cancelRequested: true, results: [{ date: "20990102", status: "unknown" }] });
  store.recoverJobs();
  assert.equal(store.job(claimed.id, "resolved"), null);
  assert.equal(store.job(claimed.id, "uncertain").results[0].status, "unknown");
  assert.equal(store.job(claimed.id, "unattempted").results[0].status, "not_attempted");
  assert.equal(store.job(claimed.id, "recover").status, "interrupted");
  assert.equal(store.job(claimed.id, "recover").cancelRequested, true);
  assert.equal(store.jobs(claimed.id, 1)[0].id, "recover");
  assert.equal(store.jobs("unrelated-profile").length, 0);
  assert.throws(() => store.jobs(claimed.id, 51), /개수/);
  assert.equal(store.reconcileJob(claimed.id, "uncertain", [{ index: 0, status: "not_attempted" }]).results[0].status, "not_attempted");
  assert.equal(store.reconcileJob("unrelated-profile", "uncertain", []), null);

  // 학교에서 새 비밀번호 검증을 마친 복구 요청은 같은 프로필과 신청 기록을 유지한다.
  const recoveryClock = expiry + 1000;
  const recovered = store.reconnect({ studentId: "  FIXTURE123  ", password: "fixture-replacement-password" }, { now: recoveryClock });
  assert.equal(recovered.id, claimed.id);
  assert.equal(recovered.createdAt, claimed.createdAt);
  assert.equal(store.find(claimed.token), null);
  assert.deepEqual(store.find(recovered.token, { now: recoveryClock }).credentials, { studentId: "FIXTURE123", password: "fixture-replacement-password" });
  assert.equal(store.job(recovered.id, "recover").status, "interrupted");
  assert.equal(store.reconnect({ studentId: "missing123", password: "fake" }), null);
  assert.equal(store.database.prepare("SELECT count(*) AS count FROM profiles").get().count, 1);

  // 결과가 손상된 경우 오류에 원문을 노출하지 않고 복구 트랜잭션 전체를 되돌린다.
  const another = store.create(credentials);
  // 중복 프로필이 있으면 갱신 시각이 가장 최근인 기존 계정만 복구한다.
  store.database.prepare("UPDATE profiles SET updated_at = ? WHERE id = ?").run(new Date(recoveryClock + 1000).toISOString(), another.id);
  const recoveredLatest = store.reconnect(credentials, { now: recoveryClock + 2000 });
  assert.equal(recoveredLatest.id, another.id);
  assert.ok(store.find(recovered.token, { now: recoveryClock + 2000 }));
  assert.equal(store.find(another.token), null);
  store.createJob("recovery-before-corrupt", claimed.id, ["20990103"]);
  store.createJob("corrupt", another.id, ["20990104"]);
  store.database.prepare("UPDATE batch_jobs SET result = ? WHERE id = 'corrupt'").run("fixture-secret-result");
  assert.throws(() => store.recoverJobs(), error => /손상/.test(error.message) && !error.message.includes("fixture-secret-result"));
  assert.equal(store.job(claimed.id, "recovery-before-corrupt").status, "running");
  store.delete(another.id);
  assert.equal(store.job(another.id), null);
  store.recoverJobs();

  // 같은 DB의 두 번째 서버는 살아 있는 소유자를 대체할 수 없다.
  store.acquireRuntime();
  store.acquireRuntime();
  const second = open(directory);
  assert.throws(() => second.acquireRuntime(), /이미 실행 중/);
  const helper = open(directory);
  close(helper);
  assert.throws(() => second.acquireRuntime(), /이미 실행 중/);
  store.releaseRuntime();
  second.acquireRuntime();
  close(store);
  const third = open(directory);
  assert.throws(() => third.acquireRuntime(), /이미 실행 중/);
  close(second);
  third.acquireRuntime();
  third.releaseRuntime();
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(child.status, 0);
  const stalePid = Number(child.stdout);
  assert.ok(Number.isInteger(stalePid) && stalePid > 0);
  third.database.prepare("INSERT INTO runtime_owner VALUES (1, ?, ?)").run(stalePid, "stale-fixture");
  third.acquireRuntime();
  assert.equal(third.database.prepare("SELECT pid FROM runtime_owner").get().pid, process.pid);
  close(third);

  const keyPath = join(directory, "master.key");
  const keyContents = readFileSync(keyPath, "utf8");
  unlinkSync(keyPath);
  assert.throws(() => new CredentialStore(directory), /암호화 키가 없습니다/);
  writeFileSync(keyPath, keyContents, { mode: 0o600 });
  store = open(directory);
  assert.deepEqual(store.find(recovered.token).credentials, { studentId: "FIXTURE123", password: "fixture-replacement-password" });
  close(store);
  console.log("store checks passed: legacy preservation, key integrity, expiry/reconnect, owned history, job transitions/recovery/retention, runtime ownership");
} finally {
  for (const store of opened) store.close();
  if (previousKey === undefined) delete process.env.OVERNIGHT_MASTER_KEY;
  else process.env.OVERNIGHT_MASTER_KEY = previousKey;
  if (previousMode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousMode;
  rmSync(directory, { recursive: true, force: true });
}

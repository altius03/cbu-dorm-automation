import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupData } from "./backup.mjs";
import { CredentialStore } from "./store.mjs";

const directory = mkdtempSync(join(tmpdir(), "tuk-backup-test-"));
const originalKey = process.env.OVERNIGHT_MASTER_KEY;
const originalMode = process.env.NODE_ENV;
delete process.env.OVERNIGHT_MASTER_KEY;
delete process.env.NODE_ENV;
let store;
let restored;
try {
  const source = join(directory, "source");
  store = new CredentialStore(source);
  store.database.exec("PRAGMA wal_autocheckpoint = 0");
  const owner = store.create({ studentId: "fixture123", password: "fixture-backup-password" });
  store.createJob("fixture-job", owner.id, ["20990101"]);
  store.updateJob("fixture-job", "done", { results: [{ date: "20990101", status: "saved" }] });
  assert.ok(statSync(join(source, "overnight.db-wal")).size > 0);
  const originalProfile = store.database.prepare("SELECT * FROM profiles WHERE id = ?").get(owner.id);
  const key = readFileSync(join(source, "master.key"), "utf8");

  // 원본 DB를 열어 둔 채 WAL의 최신 내용을 온라인 백업한다.
  const localBackup = join(directory, "local-backup");
  assert.equal((await backupData(source, localBackup)).keyIncluded, true);
  assert.equal(statSync(localBackup).mode & 0o777, 0o700);
  for (const file of ["overnight.db", "master.key", "manifest.json"]) assert.equal(statSync(join(localBackup, file)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(localBackup, "master.key"), "utf8"), key);
  assert.equal(JSON.parse(readFileSync(join(localBackup, "manifest.json"), "utf8")).requiresExternalKey, false);
  restored = new CredentialStore(localBackup);
  assert.deepEqual(restored.database.prepare("SELECT * FROM profiles WHERE id = ?").get(owner.id), originalProfile);
  assert.equal(restored.find(owner.token).credentials.password, "fixture-backup-password");
  assert.equal(restored.job(owner.id, "fixture-job").results[0].status, "saved");
  restored.close();
  restored = null;
  const backupBefore = readFileSync(join(localBackup, "overnight.db"));
  await assert.rejects(backupData(source, localBackup), /새 폴더/);
  assert.deepEqual(readFileSync(join(localBackup, "overnight.db")), backupBefore);
  await assert.rejects(backupData(source, join(source, "nested")), /밖에/);

  // 키가 바뀌었거나 없으면 성공 표시를 남기지 않는다.
  process.env.OVERNIGHT_MASTER_KEY = randomBytes(32).toString("base64");
  const invalidBackup = join(directory, "wrong-key");
  await assert.rejects(backupData(source, invalidBackup), /검증에 실패/);
  assert.equal(existsSync(join(invalidBackup, "manifest.json")), false);
  assert.equal(existsSync(join(invalidBackup, "master.key")), false);
  delete process.env.OVERNIGHT_MASTER_KEY;
  unlinkSync(join(source, "master.key"));
  const missingBackup = join(directory, "missing-key");
  await assert.rejects(backupData(source, missingBackup), /암호화 키/);
  assert.equal(existsSync(missingBackup), false);

  // 운영 환경변수 키는 백업 파일이나 manifest에 기록하지 않는다.
  process.env.OVERNIGHT_MASTER_KEY = key;
  const externalBackup = join(directory, "external-key");
  assert.equal((await backupData(source, externalBackup)).keyIncluded, false);
  assert.equal(existsSync(join(externalBackup, "master.key")), false);
  assert.equal(JSON.parse(readFileSync(join(externalBackup, "manifest.json"), "utf8")).requiresExternalKey, true);
  for (const file of readdirSync(externalBackup)) assert.equal(readFileSync(join(externalBackup, file)).includes(key), false);
  restored = new CredentialStore(externalBackup);
  assert.equal(restored.find(owner.token).credentials.password, "fixture-backup-password");
  restored.close();
  restored = null;
  assert.deepEqual(store.database.prepare("SELECT * FROM profiles WHERE id = ?").get(owner.id), originalProfile);
  console.log("backup checks passed: live WAL snapshot, restore, permissions, no overwrite, key verification, external key isolation");
} finally {
  restored?.close();
  store?.close();
  if (originalKey === undefined) delete process.env.OVERNIGHT_MASTER_KEY;
  else process.env.OVERNIGHT_MASTER_KEY = originalKey;
  if (originalMode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalMode;
  rmSync(directory, { recursive: true, force: true });
}

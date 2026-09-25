import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SESSION_TTL_MS } from "./crypto.mjs";
import { CredentialStore, internals } from "./store.mjs";

const directory = mkdtempSync(join(tmpdir(), "tuk-store-test-"));
const previousKey = process.env.OVERNIGHT_MASTER_KEY;
const previousMode = process.env.NODE_ENV;
delete process.env.OVERNIGHT_MASTER_KEY;
delete process.env.NODE_ENV;
const credentials = { studentId: "fixture123", password: "fixture-only-password" };
let store;

try {
  const key = randomBytes(32);
  const databasePath = join(directory, "overnight.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec("CREATE TABLE profiles (id TEXT PRIMARY KEY, token_hash BLOB NOT NULL UNIQUE, credential_ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT");
  const token = randomBytes(32).toString("base64url");
  const timestamp = new Date().toISOString();
  legacy.prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?)").run(
    "legacy-profile", internals.tokenHash(token), internals.seal(credentials, "legacy-profile", key), timestamp, timestamp,
  );
  legacy.close();
  writeFileSync(join(directory, "master.key"), key.toString("base64"), { mode: 0o600 });

  process.env.OVERNIGHT_MASTER_KEY = randomBytes(32).toString("base64");
  assert.throws(() => new CredentialStore(directory), /복호화할 수 없습니다/);
  const unchanged = new DatabaseSync(databasePath);
  assert.ok(unchanged.prepare("PRAGMA table_info(profiles)").all().some(column => column.name === "credential_ciphertext"));
  unchanged.close();

  delete process.env.OVERNIGHT_MASTER_KEY;
  store = new CredentialStore(directory);
  const columns = store.database.prepare("PRAGMA table_info(profiles)").all().map(column => column.name);
  assert.equal(columns.includes("credential_ciphertext"), false);
  assert.equal(columns.includes("account_key"), true);
  assert.equal("credentials" in store.find(token), false);
  assert.deepEqual(Buffer.from(store.find(token).accountKey), store.accountKey(credentials));
  assert.equal(readFileSync(databasePath).includes(credentials.password), false);

  const expiresAt = Date.parse(timestamp) + SESSION_TTL_MS;
  const claimed = store.claim(token, { now: expiresAt - 1000 });
  assert.equal(store.find(token), null);
  assert.ok(store.find(claimed.token));
  assert.ok(store.find(claimed.token, { now: expiresAt - 1 }));
  assert.equal(store.find(claimed.token, { now: expiresAt }), null);
  const reconnected = store.reconnect({ studentId: " FIXTURE123 ", password: "replacement" });
  assert.equal(reconnected.id, claimed.id);
  assert.equal(store.find(claimed.token), null);
  assert.equal("credentials" in store.find(reconnected.token), false);
  assert.equal(store.reconnect({ studentId: "missing123", password: "unused" }), null);

  store.createJob("stale-job", claimed.id, ["20990101"]);
  store.updateJob("stale-job", "running", { results: [{ date: "20990101", status: "unknown" }] });
  store.database.prepare("UPDATE batch_jobs SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 361_000).toISOString(), "stale-job");
  const recovered = store.recoverJob(claimed.id, "stale-job");
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.results[0].status, "unknown");

  store.createJob("restart-job", claimed.id, ["20990102"]);
  store.recoverJobs();
  assert.equal(store.job(claimed.id, "restart-job").status, "interrupted");
  assert.equal(store.schedules().find(item => item.term === "2026-2").ends.semester, "2026-12-23");

  store.close();
  store = undefined;
  process.env.OVERNIGHT_MASTER_KEY = randomBytes(32).toString("base64");
  assert.throws(() => new CredentialStore(directory), /원래 서버 키/);
  process.env.OVERNIGHT_MASTER_KEY = key.toString("base64");
  store = new CredentialStore(directory);
  assert.ok(store.find(reconnected.token));
  console.log("store checks passed: legacy password purge, account HMAC, token rotation, stale-job recovery, key integrity");
} finally {
  store?.close();
  if (previousKey === undefined) delete process.env.OVERNIGHT_MASTER_KEY;
  else process.env.OVERNIGHT_MASTER_KEY = previousKey;
  if (previousMode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousMode;
  rmSync(directory, { recursive: true, force: true });
}

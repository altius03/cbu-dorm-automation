import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import { SESSION_TTL_MS } from "../service/crypto.mjs";
import { PostgresStore, internals } from "./store.mjs";
import { createOperations, reportWindow } from "./operations.mjs";

const migrations = [
  "./supabase/migrations/20260919095949_init_cloud_schema.sql",
  "./supabase/migrations/20260919135500_residency_schedules.sql",
  "./supabase/migrations/20260919142047_allow_passwordless_profiles.sql",
  "./supabase/migrations/20260919142049_drop_stored_credentials.sql",
  "./supabase/migrations/20260919144058_add_public_holidays.sql",
  "./supabase/migrations/20261006105453_add_operations_reporting.sql",
];
const migrationSource = () => migrations.map(path => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n").replace(/^(?:BEGIN|COMMIT);$/gm, "");

assert.deepEqual(internals.datesForJob([{ date: "20990101", end: "20990108" }])[0], {
  date: "20990101", end: "20990108", status: "not_attempted",
});
assert.throws(() => internals.datesForJob([{ date: "20990101", end: "20990109" }]), /기간/);

async function restrictedMigration(root, connectionUrl) {
  const suffix = randomUUID().replaceAll("-", "");
  const adminRole = "overnight_migration_" + suffix;
  const appRole = "overnight_bootstrap_" + suffix;
  const database = "overnight_bootstrap_" + suffix;
  const password = randomBytes(24).toString("hex");
  let client;
  try {
    await root.unsafe(`CREATE ROLE "${adminRole}" LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOBYPASSRLS PASSWORD '${password}'`);
    await root.unsafe(`CREATE DATABASE "${database}" OWNER "${adminRole}"`);
    const target = new URL(connectionUrl);
    target.username = adminRole;
    target.password = password;
    target.pathname = "/" + database;
    client = postgres(target.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const migration = migrationSource().replaceAll("overnight_app", appRole);
    await client.unsafe(migration);
    await client.unsafe(migration);
    const [backend] = await client`SELECT rolsuper, rolreplication, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = ${appRole}`;
    assert.ok(Object.values(backend).every(value => value === false));
  } finally {
    if (client) await client.end({ timeout: 5 });
    await root.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
    await root.unsafe(`DROP ROLE IF EXISTS "${appRole}"`);
    await root.unsafe(`DROP ROLE IF EXISTS "${adminRole}"`);
  }
}

const url = process.env.CLOUD_TEST_DATABASE_URL;
if (!url) {
  console.log("cloud store tests skipped: set CLOUD_TEST_DATABASE_URL to a disposable PostgreSQL database");
} else {
  const suffix = randomUUID().replaceAll("-", "");
  const schema = "overnight_test_" + suffix;
  const appRole = "overnight_backend_" + suffix;
  const deniedRole = "overnight_denied_" + suffix;
  const sql = postgres(url, { max: 5, prepare: false, onnotice: () => {} });
  const appSql = postgres(url, { max: 5, prepare: false, onnotice: () => {}, connection: { role: appRole } });
  const key = randomBytes(32);
  const store = new PostgresStore({ sql: appSql, key, schema });
  const second = new PostgresStore({ sql: appSql, key, schema });
  let madeAppRole = false;
  let madeDeniedRole = false;
  try {
    const migration = migrationSource().replaceAll("overnight_private", schema).replaceAll("overnight_app", appRole);
    await sql.begin(tx => tx.unsafe(migration));
    madeAppRole = true;
    await sql.unsafe(`CREATE ROLE "${deniedRole}" NOLOGIN`);
    madeDeniedRole = true;
    assert.equal(await store.health(), true);
    await assert.rejects(new PostgresStore({ sql: appSql, key: randomBytes(32), schema }).health(), /원래 서버 키/);

    const credentials = { studentId: "fixture123", password: "fake-cloud-password" };
    const owner = await store.create(credentials, "fixture-setup-token");
    const other = await store.create({ studentId: "fixture456", password: "fake-cloud-password" });
    assert.equal(await store.setupUsed("fixture-setup-token"), true);
    await assert.rejects(store.create({ ...credentials, studentId: " FIXTURE123 " }), error => error.status === 409);
    const profile = await store.find(owner.token);
    assert.equal("credentials" in profile, false);
    assert.deepEqual(Buffer.from(profile.accountKey), store.accountKey(credentials));
    const columns = await sql.unsafe(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'profiles'`);
    assert.equal(columns.some(row => row.column_name === "credential_ciphertext"), false);

    const [beforeClaim] = await sql.unsafe(`SELECT updated_at FROM "${schema}".profiles WHERE id = $1`, [owner.id]);
    const claims = await Promise.all([store.claim(owner.token), second.claim(owner.token)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claimed = claims.find(Boolean);
    assert.equal(await store.find(owner.token), null);
    const [afterClaim] = await sql.unsafe(`SELECT updated_at FROM "${schema}".profiles WHERE id = $1`, [owner.id]);
    assert.equal(new Date(afterClaim.updated_at).getTime(), new Date(beforeClaim.updated_at).getTime());
    assert.equal(await store.find(claimed.token, { now: new Date(beforeClaim.updated_at).getTime() + SESSION_TTL_MS + 1 }), null);
    const reconnected = await store.reconnect({ ...credentials, password: "replacement" });
    assert.equal(reconnected.id, owner.id);
    assert.equal(await store.find(claimed.token), null);

    const jobId = randomUUID();
    await store.createJob(jobId, owner.id, [{ date: "20990101", end: "20990102" }]);
    await store.updateJob(jobId, "running", { results: [{ date: "20990101", end: "20990102", status: "unknown" }] });
    await sql.unsafe(`UPDATE "${schema}".batch_jobs SET updated_at = clock_timestamp() - interval '7 minutes' WHERE id = $1`, [jobId]);
    const recovered = await store.recoverJob(owner.id, jobId);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.results[0].status, "unknown");
    assert.equal((await store.reconcileJob(owner.id, jobId, [{ index: 0, status: "not_attempted" }])).status, "done");
    assert.equal(await store.job(other.id, jobId), null);

    assert.equal((await store.schedules()).find(item => item.term === "2026-2").ends.semester, "2026-12-23");
    assert.equal(await store.replaceHolidays(2026, 2027, [
      { date: "2026-10-03", name: "개천절", source: "fixture" },
      { date: "2027-01-01", name: "신정", source: "fixture" },
    ]), 2);
    assert.deepEqual((await store.holidays("2026-09-19", "2026-12-31")).map(item => [item.date, item.name]), [["2026-10-03", "개천절"]]);
    await assert.rejects(store.replaceHolidays(2026, 2027, [
      { date: "2026-10-03", name: "중복", source: "fixture" },
      { date: "2026-10-03", name: "중복", source: "fixture" },
    ]), /형식/);
    const policies = await sql.unsafe(`SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${schema}' AND c.relkind = 'r'`);
    assert.equal(policies.length, 10);
    assert.ok(policies.every(row => row.relrowsecurity && row.relforcerowsecurity));
    await assert.rejects(sql.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE "${deniedRole}"`);
      await tx.unsafe(`SELECT * FROM "${schema}".profiles`);
    }), error => error.code === "42501");

    const rates = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => (index % 2 ? store : second).consumeRate("fixture", 2, 60_000)));
    assert.equal(rates.filter(row => row.status === "fulfilled").length, 2);
    let release;
    let acquired;
    const acquiredPromise = new Promise(resolve => { acquired = resolve; });
    const held = store.withBusy("fixture-lock", async () => { acquired(); await new Promise(resolve => { release = resolve; }); });
    await acquiredPromise;
    await assert.rejects(second.withBusy("fixture-lock", async () => {}), error => error.status === 409);
    release();
    await held;

    await sql.unsafe(`UPDATE "${schema}".operations_runs SET started_at = '2026-10-01T00:00:00Z' WHERE kind = 'setup'`);
    const activityCredentials = { studentId: "metrics123", password: "fixture-only" };
    const activeUser = await store.create(activityCredentials, "", { now: Date.parse("2026-10-04T14:00:00Z") });
    await Promise.all([store, second].map(client => client.reconnect(activityCredentials, { now: Date.parse("2026-10-05T14:59:59Z") })));
    await store.reconnect(activityCredentials, { now: Date.parse("2026-10-05T15:00:00Z") });
    await store.create({ studentId: "metrics456", password: "fixture-only" }, "", { now: Date.parse("2026-10-05T14:00:00Z") });
    const activityRows = await sql.unsafe(`SELECT activity_date::text FROM "${schema}".daily_logins WHERE account_key = $1 ORDER BY activity_date`, [store.accountKey(activityCredentials)]);
    assert.deepEqual(activityRows.map(row => row.activity_date), ["2026-10-04", "2026-10-05", "2026-10-06"]);
    const metricJob = randomUUID();
    await store.createJob(metricJob, activeUser.id, ["20990101", "20990103"]);
    await store.updateJob(metricJob, "done", { outcome: "partial", results: [{ date: "20990101", status: "saved" }, { date: "20990103", status: "unknown" }] });
    await sql.unsafe(`UPDATE "${schema}".batch_jobs SET created_at = '2026-10-05T14:00:00Z' WHERE id = $1`, [metricJob]);
    const reportNow = Date.parse("2026-10-05T15:10:00Z");
    for (const date of ["2026-10-04T18:00:00Z", "2026-10-05T00:00:00Z", "2026-10-05T06:00:00Z", "2026-10-05T12:00:00Z"]) {
      await store.startOperation("health", date, Date.parse(date));
      await store.finishOperation("health", date, "success", {}, Date.parse(date) + 100);
    }
    const stats = await store.operationsSnapshot(reportWindow(reportNow), reportNow);
    assert.deepEqual([stats.users.active, stats.users.previous, stats.users.new, stats.users.total], [2, 1, 1, 2]);
    assert.deepEqual([stats.jobs.total, stats.jobs.partial, stats.jobs.failed], [1, 1, 0]);
    assert.deepEqual(stats.periods, { saved: 1, unknown: 1 });
    assert.equal(stats.recentRuns.length, 4);
    assert.equal(stats.database.writable, true);
    let dmCount = 0;
    const reportOptions = { store, origin: "https://fixture.example", now: () => reportNow,
      fetchImpl: async url => url.endsWith("/api/health") ? Response.json({ ok: true }) : new Response("fixture", { headers: { "Content-Type": "text/html" } }),
      send: async (_message, { beforeSend }) => { await beforeSend(); dmCount++; return { ts: "fixture.1", channel: "D123" }; },
    };
    await Promise.all([createOperations(reportOptions).report(), createOperations({ ...reportOptions, store: second }).report()]);
    await createOperations(reportOptions).report();
    assert.equal(dmCount, 1);
    const readOnlySql = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connection: { role: appRole, default_transaction_read_only: "on" } });
    try { await assert.rejects(new PostgresStore({ sql: readOnlySql, key, schema }).health(), error => error.status === 503); }
    finally { await readOnlySql.end({ timeout: 5 }); }
    await store.delete(activeUser.id);
    assert.equal((await sql.unsafe(`SELECT 1 FROM "${schema}".daily_logins WHERE account_key = $1`, [store.accountKey(activityCredentials)])).length, 0);

    assert.equal(await store.delete(owner.id), true);
    assert.deepEqual(await store.jobs(owner.id), []);
    await restrictedMigration(sql, url);
    console.log("cloud store checks passed: private RLS, KST unique logins, read-only health, result counts, atomic single report, cleanup, migration permissions and existing session/job behavior");
  } finally {
    await appSql.end({ timeout: 5 });
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (madeDeniedRole) await sql.unsafe(`DROP ROLE "${deniedRole}"`);
    if (madeAppRole) await sql.unsafe(`DROP ROLE "${appRole}"`);
    await sql.end({ timeout: 5 });
  }
}

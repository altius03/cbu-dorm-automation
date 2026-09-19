import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { PostgresStore, internals } from "./store.mjs";

const migrationSource = () => [
  "./supabase/migrations/20260919095949_init_cloud_schema.sql",
  "./supabase/migrations/20260919135500_residency_schedules.sql",
].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n").replace(/^(?:BEGIN|COMMIT);$/gm, "");

const longBatch = Array.from({ length: 96 }, (_, index) => {
  const date = new Date(Date.UTC(2099, 0, index + 1)).toISOString().slice(0, 10).replaceAll("-", "");
  return date;
});
assert.equal(internals.datesForJob(longBatch).length, 96);
assert.deepEqual(internals.datesForJob([{ date: "20990101", end: "20990108" }])[0], { date: "20990101", end: "20990108", status: "not_attempted" });
assert.throws(() => internals.datesForJob([{ date: "20990101", end: "20990109" }]), /기간/);
assert.throws(() => internals.datesForJob(Array.from({ length: 371 }, (_, index) => ({ date: longBatch[index % longBatch.length], end: longBatch[index % longBatch.length] }))), /날짜/);

async function restrictedMigration(root, connectionUrl) {
  const suffix = randomUUID().replaceAll("-", "");
  const adminRole = "overnight_migration_" + suffix;
  const appRole = "overnight_bootstrap_" + suffix;
  const database = "overnight_bootstrap_" + suffix;
  const password = randomBytes(24).toString("hex");
  let client;
  let createdRole = false;
  let createdDatabase = false;
  try {
    await root.unsafe(`CREATE ROLE "${adminRole}" LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOBYPASSRLS PASSWORD '${password}'`);
    createdRole = true;
    await root.unsafe(`CREATE DATABASE "${database}" OWNER "${adminRole}"`);
    createdDatabase = true;
    const target = new URL(connectionUrl);
    target.username = adminRole;
    target.password = password;
    target.pathname = "/" + database;
    client = postgres(target.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const [permissions] = await client`SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`;
    assert.deepEqual(permissions, { rolsuper: false, rolcreaterole: true, rolcreatedb: false });
    const migration = migrationSource().replaceAll("overnight_app", appRole);
    await client.unsafe(migration);
    await client.unsafe(migration);
    const [backend] = await client`SELECT rolsuper, rolreplication, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = ${appRole}`;
    assert.ok(Object.values(backend).every(value => value === false));
    // A pre-existing privileged role must be rejected, not silently weakened or used.
    await root.unsafe(`ALTER ROLE "${appRole}" BYPASSRLS`);
    await assert.rejects(client.unsafe(migration), error => /elevated privileges/.test(error.message));
    await client.unsafe("ROLLBACK");
    assert.equal((await root`SELECT rolbypassrls FROM pg_roles WHERE rolname = ${appRole}`)[0].rolbypassrls, true);
  } finally {
    if (client) await client.end({ timeout: 5 });
    if (createdDatabase) await root.unsafe(`DROP DATABASE "${database}"`);
    await root.unsafe(`DROP ROLE IF EXISTS "${appRole}"`);
    if (createdRole) await root.unsafe(`DROP ROLE "${adminRole}"`);
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
    let firstConnection = true;
    const transientSql = { unsafe: appSql.unsafe, begin: task => {
      if (firstConnection) { firstConnection = false; return Promise.reject(new Error("fixture transient connection failure")); }
      return appSql.begin(task);
    } };
    const recovering = new PostgresStore({ sql: transientSql, key, schema });
    await assert.rejects(recovering.health(), /transient/);
    assert.equal(await recovering.health(), true);
    await assert.rejects(new PostgresStore({ sql: appSql, key: randomBytes(32), schema }).health(), /원래 암호화 키/);
    const credentials = { studentId: "fixture123", password: "fake-cloud-password" };
    const owner = await store.create(credentials, "fixture-setup-token");
    const other = await store.create({ studentId: "fixture456", password: "fake-cloud-password" });
    assert.equal(await store.setupUsed("fixture-setup-token"), true);
    await assert.rejects(store.create({ ...credentials, studentId: " FIXTURE123 " }, "unused-token"), error => error.status === 409);
    assert.equal(await store.setupUsed("unused-token"), false);
    assert.deepEqual((await store.find(owner.token)).credentials, credentials);
    assert.equal(await store.find(owner.token, { now: Date.now() + 366 * 86_400_000 }), null);
    const claims = await Promise.all([store.claim(owner.token), second.claim(owner.token)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claimed = claims.find(Boolean);
    assert.equal(await store.find(owner.token), null);

    // Privileges and RLS: backend role can access this schema; an ungranted role cannot.
    const policies = await sql.unsafe(`SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${schema}' AND c.relkind = 'r'`);
    assert.equal(policies.length, 7);
    assert.ok(policies.every(row => row.relrowsecurity && row.relforcerowsecurity));
    await sql.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE "${appRole}"`);
      assert.equal((await tx.unsafe(`SELECT count(*)::int AS count FROM "${schema}".profiles`))[0].count, 2);
    });
    await assert.rejects(sql.begin(async tx => {
      await tx.unsafe(`SET LOCAL ROLE "${deniedRole}"`);
      await tx.unsafe(`SELECT * FROM "${schema}".profiles`);
    }), error => error.code === "42501");
    for (const role of ["anon", "authenticated"]) {
      if ((await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`).length) {
        assert.equal((await sql`SELECT has_schema_privilege(${role}, ${schema}, 'USAGE') AS allowed`)[0].allowed, false);
      }
    }
    const raw = (await sql.unsafe(`SELECT * FROM "${schema}".profiles WHERE id = $1`, [owner.id]))[0];
    assert.equal(raw.credential_ciphertext.includes(credentials.password), false);
    assert.equal(raw.account_key.length, 32);
    assert.equal((await store.schedules()).find(item => item.term === "2026-2").ends.semester, "2026-12-23");
    assert.equal((await store.upsertSchedule({
      term: "2027-1", from: "2027-02-14", through: "2027-08-28", source: "fixture notice",
      ends: { semester: "2027-06-23", sixMonths: "2027-08-15", twelveMonths: "2028-02-13" },
    })).source, "fixture notice");

    const firstId = randomUUID();
    await store.createJob(firstId, owner.id, [{ date: "20990101", end: "20990102" }, "20990103"]);
    assert.equal((await store.createJob(firstId, owner.id, [{ date: "20990101", end: "20990102" }, "20990103"])).id, firstId);
    await assert.rejects(store.createJob(firstId, owner.id, ["20990104"]), error => error.status === 409);
    await assert.rejects(store.createJob(randomUUID(), owner.id, ["20990104"]), error => error.status === 409);
    await assert.rejects(store.delete(owner.id), error => error.status === 409);
    assert.equal(await store.job(other.id, firstId), null);
    assert.equal(await store.job(other.id, "not-a-uuid"), null);
    assert.equal(await store.cancelJob(other.id, "not-a-uuid"), null);
    assert.deepEqual(await store.jobs(other.id), []);

    const dispatches = await Promise.all(Array.from({ length: 8 }, () => store.claimDispatch(firstId)));
    assert.equal(dispatches.filter(Boolean).length, 1);
    await store.releaseDispatch(firstId);
    assert.equal(await store.claimDispatch(firstId), true);
    const contenders = await Promise.all([store.claimNext(firstId), second.claimNext(firstId)]);
    assert.deepEqual(contenders.map(row => row.kind).sort(), ["busy", "work"]);
    const firstClaim = contenders.find(row => row.kind === "work");
    assert.equal(firstClaim.end, "20990102");
    assert.equal((await store.job(owner.id, firstId)).results[0].status, "unknown");
    assert.deepEqual(await store.credentialsForJob(firstId), credentials);
    await store.cancelJob(owner.id, firstId);
    const cancelled = await store.finishDate(firstId, { ...firstClaim, status: "saved" });
    assert.equal(cancelled.status, "done");
    assert.equal(cancelled.outcome, "cancelled");
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.results[1].status, "not_attempted");
    assert.equal((await store.claimNext(firstId)).kind, "done");
    assert.equal(await store.claimDispatch(firstId), false);
    assert.equal(await store.credentialsForJob(firstId), null);
    await assert.rejects(store.updateJob(firstId, "running", { results: [] }), error => error.status === 409);

    // A dead worker's unknown claim is never offered as fresh work again.
    const crashId = randomUUID();
    await store.createJob(crashId, owner.id, ["20990104", "20990105"]);
    const lost = await store.claimNext(crashId);
    await sql.unsafe(`UPDATE "${schema}".batch_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`, [crashId]);
    const recovery = await second.claimNext(crashId);
    assert.equal(recovery.kind, "reconcile");
    assert.notEqual(recovery.attempt, lost.attempt);
    await assert.rejects(store.finishDate(crashId, { ...lost, status: "saved" }), error => error.status === 409);
    assert.equal((await store.finishDate(crashId, { ...recovery, status: "exists" })).status, "running");
    const next = await store.claimNext(crashId);
    assert.equal(next.kind, "work");
    assert.equal(next.date, "20990105");
    const partial = await store.finishDate(crashId, { ...next, status: "unknown" });
    assert.equal(partial.outcome, "partial");
    assert.equal((await store.claimNext(crashId)).kind, "done");
    assert.equal((await store.reconcileJob(owner.id, crashId, [{ index: 1, status: "not_attempted" }])).results[1].status, "not_attempted");
    assert.equal(await store.reconcileJob(other.id, crashId, []), null);

    const cancelledUnknownId = randomUUID();
    await store.createJob(cancelledUnknownId, owner.id, ["20990106", "20990107"]);
    await store.claimNext(cancelledUnknownId);
    await store.cancelJob(owner.id, cancelledUnknownId);
    await sql.unsafe(`UPDATE "${schema}".batch_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`, [cancelledUnknownId]);
    const cancelledReconcile = await store.claimNext(cancelledUnknownId);
    assert.equal(cancelledReconcile.kind, "reconcile");
    assert.equal((await store.finishDate(cancelledUnknownId, { ...cancelledReconcile, status: "exists" })).outcome, "cancelled");

    const stopId = randomUUID();
    await store.createJob(stopId, owner.id, ["20990108"]);
    const stop = await store.claimNext(stopId);
    assert.equal((await store.finishDate(stopId, { ...stop, status: "not_attempted" })).outcome, "partial");
    assert.equal((await store.claimNext(stopId)).kind, "done");
    const newCredentials = { ...credentials, password: "fake-new-cloud-password" };
    const reconnected = await store.reconnect(newCredentials);
    assert.equal(reconnected.id, owner.id);
    assert.equal(await store.find(claimed.token), null);
    assert.deepEqual((await store.find(reconnected.token)).credentials, newCredentials);
    assert.equal((await store.jobs(owner.id)).length, 4);
    assert.equal(await store.reconnect({ studentId: "missing123", password: "fake" }), null);

    // Global rate increments and busy leases remain atomic across store instances.
    const rates = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => (index % 2 ? store : second).consumeRate("fixture-ip-and-user", 3, 60_000)));
    assert.equal(rates.filter(row => row.status === "fulfilled").length, 3);
    assert.ok(rates.filter(row => row.status === "rejected").every(row => row.reason.status === 429));
    const rateRow = (await sql.unsafe(`SELECT key_hash FROM "${schema}".rate_limits`))[0];
    assert.equal(rateRow.key_hash.length, 32);
    assert.equal(rateRow.key_hash.includes("fixture-ip-and-user"), false);
    await sql.unsafe(`UPDATE "${schema}".rate_limits SET expires_at = clock_timestamp() - interval '1 second'`);
    assert.equal(await store.consumeRate("fixture-ip-and-user", 3, 60_000), true);
    await sql.unsafe(`INSERT INTO "${schema}".rate_limits VALUES ($1, 1, clock_timestamp() - interval '2 days')`, [store.hash("fixture-stale", "rate")]);
    await sql.unsafe(`INSERT INTO "${schema}".busy_locks VALUES ($1, $2, clock_timestamp() - interval '2 days')`, [store.hash("fixture-stale", "lock"), randomUUID()]);
    store.lastCleanup = 0;
    await store.consumeRate("fixture-cleanup", 3, 60_000);
    assert.equal((await sql.unsafe(`SELECT count(*)::int AS count FROM "${schema}".rate_limits WHERE expires_at < clock_timestamp() - interval '1 day'`))[0].count, 0);
    assert.equal((await sql.unsafe(`SELECT count(*)::int AS count FROM "${schema}".busy_locks WHERE expires_at < clock_timestamp() - interval '1 day'`))[0].count, 0);
    let releaseBusy;
    let acquired;
    const acquiredPromise = new Promise(resolve => { acquired = resolve; });
    const firstBusy = store.withBusy("fixture-auth-lock", async () => { acquired(); await new Promise(resolve => { releaseBusy = resolve; }); return "ok"; });
    await acquiredPromise;
    await assert.rejects(second.withBusy("fixture-auth-lock", async () => "unexpected"), error => error.status === 409);
    releaseBusy();
    assert.equal(await firstBusy, "ok");
    assert.equal(await second.withBusy("fixture-auth-lock", async () => "released"), "released");

    const racing = await store.create({ studentId: "race123", password: "fake" });
    const racedId = randomUUID();
    const race = await Promise.allSettled([store.createJob(racedId, racing.id, ["20990101"]), second.delete(racing.id)]);
    assert.equal(race.filter(row => row.status === "fulfilled").length, 1);
    assert.ok(race.filter(row => row.status === "rejected").every(row => row.reason.status === 409));
    if (await store.getJobById(racedId)) {
      await store.cancelJob(racing.id, racedId);
      assert.equal((await store.claimNext(racedId)).kind, "done");
      assert.equal(await store.delete(racing.id), true);
    }
    assert.equal(await store.delete(owner.id), true);
    assert.deepEqual(await store.jobs(owner.id), []);
    await restrictedMigration(sql, url);
    console.log("cloud store checks passed: non-superuser migration, encrypted auth, private schema/RLS, atomic rate/locks, durable claims/reconciliation/cancellation, owned history, delete races");
  } finally {
    await appSql.end({ timeout: 5 });
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (madeDeniedRole) await sql.unsafe(`DROP ROLE "${deniedRole}"`);
    if (madeAppRole) await sql.unsafe(`DROP ROLE "${appRole}"`);
    await sql.end({ timeout: 5 });
  }
}

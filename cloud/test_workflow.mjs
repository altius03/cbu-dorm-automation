import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { PostgresStore } from "./store.mjs";

const supplied = process.env.CLOUD_TEST_DATABASE_URL;
if (!supplied) {
  console.log("workflow smoke skipped: set CLOUD_TEST_DATABASE_URL to a disposable local PostgreSQL administrator URL");
} else {
  const base = new URL(supplied);
  assert.ok(["127.0.0.1", "[::1]", "localhost"].includes(base.hostname), "workflow smoke requires a local disposable PostgreSQL server");
  const suffix = randomBytes(8).toString("hex");
  const database = `overnight_workflow_${suffix}`;
  const role = `overnight_workflow_role_${suffix}`;
  const temporary = await mkdtemp(join(tmpdir(), "overnight-workflow-smoke-"));
  const url = new URL(base);
  url.pathname = `/${database}`;
  const admin = postgres(base.href, { max: 1, connect_timeout: 3, onnotice: () => {} });
  let sql;
  let child;
  let created = false;
  let logs = "";
  let lastStatus = 0;
  let stage = "database setup";
  let token = "";
  const key = randomBytes(32);
  const fixturePassword = randomBytes(24).toString("base64url");
  const kill = signal => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    }
  };
  const watchdog = setTimeout(() => kill("SIGKILL"), 55_000);
  const deadline = Date.now() + 50_000;
  try {
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    created = true;
    sql = postgres(url.href, { max: 2, prepare: false, connect_timeout: 3, onnotice: () => {} });
    const migration = (await readFile(new URL("./supabase/migrations/20260919095949_init_cloud_schema.sql", import.meta.url), "utf8"))
      .replaceAll("overnight_app", role).replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
    await sql.begin(tx => tx.unsafe(migration));
    const store = new PostgresStore({ sql, key });
    const owner = await store.create({ studentId: "workflowfixture", password: fixturePassword });
    token = owner.token;
    const id = randomUUID();
    await store.createJob(id, owner.id, ["20990101"]);
    await store.cancelJob(owner.id, id);
    assert.equal((await store.getJobById(id)).status, "running");

    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    // The guard is test-process-only and inherited by Nitro workers. It cannot be enabled in production code.
    const preload = `
      import http from 'node:http'; import https from 'node:https';
      import { syncBuiltinESMExports } from 'node:module';
      function check(input) {
        let host = '';
        try { host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input?.hostname || input?.host || new URL(input?.url).hostname; } catch {}
        host = String(host).toLowerCase().split(':')[0];
        if (host === 'tukorea.ac.kr' || host.endsWith('.tukorea.ac.kr')) {
          process.stderr.write('SCHOOL_NETWORK_BLOCKED\\n'); throw new Error('School network forbidden in workflow smoke');
        }
      }
      for (const transport of [http, https]) for (const name of ['request', 'get']) {
        const original = transport[name]; transport[name] = function(...args) { check(args[0]); return original.apply(this, args); };
      }
      const fetch = globalThis.fetch;
      globalThis.fetch = (...args) => { check(args[0]); return fetch(...args); };
      syncBuiltinESMExports(); process.stderr.write('SMOKE_NETWORK_GUARD_READY\\n');
    `;
    stage = "Nitro startup";
    child = spawn(process.execPath, [fileURLToPath(new URL("./node_modules/.bin/nitro", import.meta.url)), "dev", "--port", String(port), "--host", "127.0.0.1"], {
      cwd: fileURLToPath(new URL(".", import.meta.url)), detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, TMPDIR: tmpdir(), NODE_ENV: "development", PORT: String(port), NO_COLOR: "1", CI: "1",
        NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
        OVERNIGHT_DATABASE_URL: url.href, OVERNIGHT_MASTER_KEY: key.toString("base64"),
        OVERNIGHT_PUBLIC_ORIGIN: "", OVERNIGHT_SETUP_TOKEN: "", OVERNIGHT_PUBLIC_REGISTRATION: "0",
        WORKFLOW_LOCAL_BASE_URL: origin,
        WORKFLOW_LOCAL_DATA_DIR: join(temporary, "workflow"), WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
      },
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-200_000); });
    const exited = once(child, "exit");
    let completed = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Nitro exited before completion");
      if (logs.includes("Dev worker failed after")) throw new Error("Nitro worker startup failed");
      assert.ok(!logs.includes("SCHOOL_NETWORK_BLOCKED"), "school network was attempted");
      try {
        const response = await fetch(`${origin}/api/batch/job?id=${id}`, {
          headers: { cookie: `overnight_session=${token}` }, signal: AbortSignal.timeout(1500),
        });
        lastStatus = response.status;
        const body = await response.json();
        if ([401, 403].includes(response.status)) assert.fail(`local fixture request rejected: ${String(body.error || "access denied").slice(0, 200)}`);
        if (response.ok && body.job?.status === "done") {
          assert.equal(body.job.outcome, "cancelled");
          assert.equal(body.job.results[0].status, "not_attempted");
          completed = true;
          break;
        }
        if (response.ok) stage = "Workflow dispatch and step completion";
      } catch (error) {
        if (error?.name === "AssertionError") throw error;
      }
      await delay(250);
    }
    assert.ok(completed, "workflow did not finish within the bounded smoke window");
    assert.ok(logs.includes("SMOKE_NETWORK_GUARD_READY"));
    assert.ok(!logs.includes("SCHOOL_NETWORK_BLOCKED"));
    assert.equal((await store.getJobById(id)).outcome, "cancelled");
    kill("SIGTERM");
    await Promise.race([exited, delay(2000).then(() => kill("SIGKILL"))]);
    const inspectHistory = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await inspectHistory(path);
        else if (entry.isFile()) {
          const content = await readFile(path);
          for (const value of [key.toString("base64"), token, fixturePassword, "workflowfixture"]) {
            assert.equal(content.includes(value), false, "private account data must not enter Workflow history");
          }
        }
      }
    };
    await inspectHistory(temporary);
    console.log("workflow smoke passed: actual Nitro HTTP → Workflow SDK queue → Postgres cancelled job; school network blocked and unused");
  } catch (error) {
    let diagnostic = logs.split("\n").filter(line => /error|cannot|failed|ERR_|typeerror|syntaxerror/i.test(line)).slice(-12).join("\n").slice(-2500);
    for (const value of [key.toString("base64"), token, fixturePassword, url.href, base.href]) if (value) diagnostic = diagnostic.replaceAll(value, "[redacted]");
    throw new Error(`Workflow smoke failed during ${stage}; last HTTP status ${lastStatus}. ${error?.name === "AssertionError" ? error.message : "Fixture execution failed."}\n${diagnostic}`);
  } finally {
    kill("SIGTERM");
    if (child?.exitCode === null && child?.signalCode === null) {
      await Promise.race([once(child, "exit"), delay(1500).then(() => kill("SIGKILL"))]);
    }
    clearTimeout(watchdog);
    if (sql) await sql.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end({ timeout: 1 });
    await rm(temporary, { recursive: true, force: true });
  }
}

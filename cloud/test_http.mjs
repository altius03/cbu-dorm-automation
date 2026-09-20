import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cloud = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const server = readFileSync(new URL("../service/server.mjs", import.meta.url), "utf8");
const client = readFileSync(new URL("../service/public/app.js", import.meta.url), "utf8");

assert.doesNotMatch(cloud, /workflow|dispatchJob|enqueue/);
assert.doesNotMatch(server, /profile\.credentials|credential_ciphertext/);
assert.match(server, /liveCredentials/);
assert.match(server, /connected: false/);
assert.match(client, /activeCredentials/);
assert.match(cloud, /DATA_GO_KR_SERVICE_KEY/);
assert.match(cloud, /CRON_SECRET/);
assert.match(server, /\/api\/cron\/holidays/);
assert.deepEqual([...client.matchAll(/localStorage\.(?:getItem|setItem)\("([^"]+)"/g)].map(match => match[1]), ["overnight_theme", "overnight_theme"]);
assert.doesNotMatch(client, /(?:localStorage|sessionStorage)\.setItem\([^)]*(?:password|studentId)/);

console.log("cloud HTTP checks passed: no workflow credential dependency, fresh-login session, memory-only client credentials");

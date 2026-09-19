import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("./.vercel/output/functions/__server.func/.vc-config.json", import.meta.url);
const config = JSON.parse(readFileSync(file, "utf8"));
assert.equal(config.runtime, "nodejs24.x");
config.maxDuration = 300;
writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
assert.equal(JSON.parse(readFileSync(file, "utf8")).maxDuration, 300);
assert.ok(readFileSync(new URL("./.vercel/output/static/assets/cbu-sleeping-owl-v2.png", import.meta.url)).length > 1_000);
console.log("Build checks passed: Node24, one 300s function");

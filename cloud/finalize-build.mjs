import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { internals } from "./store.mjs";

// Workflow 4.x emits maxDuration:'max', independently of Nitro's API setting.
// Keep every function shorter than the database attempt lease, even on paid plans.
for (const name of ["__server", ".well-known/workflow/v1/step", ".well-known/workflow/v1/flow"]) {
  const file = new URL(`./.vercel/output/functions/${name}.func/.vc-config.json`, import.meta.url);
  const config = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(config.runtime, "nodejs24.x");
  if (name !== "__server") assert.ok(config.experimentalTriggers?.some(trigger => trigger.type === "queue/v2beta"));
  config.maxDuration = 300;
  assert.ok(internals.leaseMs > config.maxDuration * 1000);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).maxDuration, 300);
}
console.log("Build checks passed: Node24, queue-only workers, 300s functions < 360s attempt lease");

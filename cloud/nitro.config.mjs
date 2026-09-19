import { defineConfig } from "nitro";

export default defineConfig({
  builder: "rollup",
  modules: ["workflow/nitro"],
  workflow: { runtime: "nodejs24.x" },
  routes: { "/**": { handler: "./index.mjs", format: "node" } },
  vercel: { entryFormat: "node", functions: { maxDuration: 300 } },
});

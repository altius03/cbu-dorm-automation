import { defineConfig } from "nitro";

export default defineConfig({
  builder: "rollup",
  routes: { "/**": { handler: "./index.mjs", format: "node" } },
  vercel: { entryFormat: "node", functions: { maxDuration: 300 } },
});

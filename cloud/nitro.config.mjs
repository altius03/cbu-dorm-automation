import { defineConfig } from "nitro";

export default defineConfig({
  builder: "rollup",
  publicAssets: [{ dir: "../service/public/assets", baseURL: "/assets", fallthrough: false, maxAge: 31_536_000 }],
  routes: { "/**": { handler: "./index.mjs", format: "node" } },
  vercel: { entryFormat: "node", functions: { maxDuration: 300 } },
});

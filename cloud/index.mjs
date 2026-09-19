import { isIP } from "node:net";
import html from "../service/public/index.html" with { type: "text" };
import script from "../service/public/app.js" with { type: "text" };
import { createApplication } from "../service/server.mjs";
import { syncPublicHolidays } from "./holidays.mjs";
import { getStore } from "./runtime.mjs";

let app;
export default async function handler(request, response) {
  try {
    if (!app) {
      const store = getStore();
      const publicOrigin = process.env.OVERNIGHT_PUBLIC_ORIGIN || "";
      if (process.env.VERCEL && !publicOrigin) throw new Error("Missing origin");
      app = createApplication({
        store, publicOrigin, secureCookie: true,
        // Nitro dev proxies through another socket; trust the configured port, never incoming Host.
        localPort: !process.env.VERCEL && process.env.NODE_ENV === "development" ? Number(process.env.PORT || 8789) : undefined,
        publicRegistration: process.env.OVERNIGHT_PUBLIC_REGISTRATION === "1",
        setupToken: process.env.OVERNIGHT_SETUP_TOKEN || "",
        cronSecret: process.env.CRON_SECRET || "",
        holidaySync: () => syncPublicHolidays(store, { serviceKey: process.env.DATA_GO_KR_SERVICE_KEY || "" }),
        page: Buffer.from(html),
        script: Buffer.from(script),
        clientAddress: req => {
          const value = process.env.VERCEL ? req.headers["x-vercel-forwarded-for"] : req.socket.remoteAddress;
          return typeof value === "string" && isIP(value) ? value : "unknown";
        },
      });
    }
    await app.handler(request, response);
  } catch {
    // Never emit a DB URL, credential, raw SQL error, or environment value.
    if (response.headersSent) return response.destroy();
    response.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "서비스를 준비하고 있습니다. 잠시 후 다시 시도해 주세요." }));
  }
}

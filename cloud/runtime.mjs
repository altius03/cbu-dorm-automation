import postgres from "postgres";
import { decodeKey } from "../service/crypto.mjs";
import { PostgresStore } from "./store.mjs";

let store;
export function getStore() {
  if (store) return store;
  const url = new URL(process.env.OVERNIGHT_DATABASE_URL || "");
  const local = !process.env.VERCEL && process.env.NODE_ENV !== "production"
    && ["127.0.0.1", "[::1]"].includes(url.hostname);
  // Cloud runtime uses only the restricted role through Supabase's transaction pooler.
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || (!local && (!url.hostname.endsWith(".pooler.supabase.com") || url.port !== "6543"
    || !decodeURIComponent(url.username).startsWith("overnight_app.")))) {
    throw new Error("클라우드 DB 연결 설정을 확인해 주세요.");
  }
  const key = decodeKey(process.env.OVERNIGHT_MASTER_KEY);
  const sql = postgres(url.href, {
    prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10,
    ssl: local ? false : { rejectUnauthorized: true, ...(process.env.OVERNIGHT_DB_CA ? { ca: process.env.OVERNIGHT_DB_CA } : {}) },
    onnotice: () => {},
  });
  store = new PostgresStore({ sql, key });
  return store;
}

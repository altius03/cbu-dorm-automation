import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { internals } from "./store.mjs";

export async function backupData(source, destination) {
  if (typeof source !== "string" || !source.trim() || typeof destination !== "string" || !destination.trim()) {
    throw new Error("원본 데이터 폴더와 새로운 백업 폴더를 지정해 주세요.");
  }
  source = resolve(source);
  destination = resolve(destination);
  if (destination === source || destination.startsWith(source + sep)) throw new Error("백업 폴더는 원본 데이터 폴더 밖에 만들어 주세요.");
  if (existsSync(destination)) throw new Error("백업 대상은 아직 존재하지 않는 새 폴더여야 합니다.");
  const keyPath = join(source, "master.key");
  const localKey = existsSync(keyPath) ? readFileSync(keyPath, "utf8") : null;
  const encodedKey = process.env.OVERNIGHT_MASTER_KEY || localKey;
  if (!encodedKey) throw new Error("원래 암호화 키가 필요합니다. master.key 또는 OVERNIGHT_MASTER_KEY를 복구해 주세요.");
  const key = internals.decodeKey(encodedKey);
  const keyIncluded = localKey !== null && localKey.trim().replace(/=$/, "") === key.toString("base64").slice(0, -1);
  const database = new DatabaseSync(join(source, "overnight.db"), { readOnly: true });
  try {
    // mkdir는 기존 경로를 원자적으로 거부하므로 기존 백업을 덮어쓰지 않는다.
    mkdirSync(destination, { mode: 0o700 });
    const databasePath = join(destination, "overnight.db");
    await backup(database, databasePath);
    chmodSync(databasePath, 0o600);
    const snapshot = new DatabaseSync(databasePath, { readOnly: true });
    try {
      if (snapshot.prepare("PRAGMA quick_check").all().some(row => row.quick_check !== "ok")) throw new Error();
      for (const row of snapshot.prepare("SELECT id, credential_ciphertext FROM profiles").iterate()) {
        internals.unseal(row.credential_ciphertext, row.id, key);
      }
    } catch {
      throw new Error("백업 DB 또는 암호화 키 검증에 실패했습니다. 이 폴더를 복구용 백업으로 사용하지 마세요.");
    } finally {
      snapshot.close();
    }
    if (keyIncluded) writeFileSync(join(destination, "master.key"), localKey, { flag: "wx", mode: 0o600, flush: true });
    // 마지막에 기록되는 manifest가 있어야 검증까지 끝난 백업이다. 환경변수 키는 파일로 내보내지 않는다.
    writeFileSync(join(destination, "manifest.json"), JSON.stringify({
      version: 1, createdAt: new Date().toISOString(), database: "overnight.db", masterKey: keyIncluded ? "master.key" : null,
      requiresExternalKey: !keyIncluded,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    return { directory: destination, keyIncluded };
  } finally {
    database.close();
    key.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const [destination, source = join(dirname(fileURLToPath(import.meta.url)), "data"), ...extra] = process.argv.slice(2);
  try {
    if (!destination || extra.length) throw new Error("사용법: node service/backup.mjs <새 백업 폴더> [원본 데이터 폴더]");
    const result = await backupData(source, destination);
    console.log(result.keyIncluded ? "DB와 암호화 키 백업 및 복구 검증을 완료했습니다." : "DB 백업 및 검증을 완료했습니다. 복구에는 별도 보관한 기존 환경변수 암호화 키가 필요합니다.");
  } catch {
    console.error(!destination || extra.length ? "사용법: node service/backup.mjs <새 백업 폴더> [원본 데이터 폴더]" : "백업하지 못했습니다. 원본 DB·키와 새 대상 경로를 확인하세요. manifest.json 없는 백업은 사용하지 마세요.");
    process.exitCode = 1;
  }
}

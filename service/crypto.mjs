import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function decodeKey(value) {
  const encoded = typeof value === "string" ? value.trim() : "";
  const key = Buffer.from(encoded, "base64");
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(encoded) || key.length !== 32 || key.toString("base64").slice(0, 43) !== encoded.slice(0, 43)) {
    throw new Error("OVERNIGHT_MASTER_KEY는 Base64로 인코딩한 32바이트 키여야 합니다.");
  }
  return key;
}

export function tokenHash(token) {
  return createHash("sha256").update(token).digest();
}

export function seal(credentials, profileId, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(profileId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function unseal(payload, profileId, key) {
  const [version, ivValue, tagValue, ciphertextValue, extra] = payload.split(".");
  if (version !== "v1" || !ciphertextValue || extra !== undefined) throw new Error("저장된 계정 형식이 올바르지 않습니다.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAAD(Buffer.from(profileId));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

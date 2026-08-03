import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM secret sealing. Packed format: "v1:{ivB64}:{tagB64}:{dataB64}".
// Key = MASTER_ENCRYPTION_KEY, 32 bytes hex-encoded. The versioned prefix lets a
// future key rotation re-seal rows lazily without a migration.

function masterKey(): Buffer {
  const hex = process.env.MASTER_ENCRYPTION_KEY;
  if (!hex) throw new Error("MASTER_ENCRYPTION_KEY is not set");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("MASTER_ENCRYPTION_KEY must be 32 bytes of hex (64 hex chars)");
  }
  return key;
}

export function sealSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

export function openSecret(packed: string): string {
  const [version, ivB64, tagB64, dataB64] = packed.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Unrecognized sealed secret format");
  }
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

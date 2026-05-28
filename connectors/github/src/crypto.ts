/**
 * Symmetric token encryption helpers.
 *
 * Format: `v1:<base64>` where the base64 blob is:
 *   [16 bytes salt] [12 bytes IV] [16 bytes GCM auth tag] [N bytes ciphertext]
 *
 * Key derivation: scrypt(passphrase, salt, N=2^15, r=8, p=1) → 32-byte key.
 * Cipher: AES-256-GCM.
 *
 * The "v1:" prefix exists so the format can evolve without ambiguity.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const VERSION = "v1";
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_OPTS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function encryptToken(plaintext: string, passphrase: string): string {
  if (!plaintext) throw new Error("encryptToken: plaintext is empty");
  if (!passphrase) throw new Error("encryptToken: passphrase is empty");

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(passphrase, salt, KEY_LEN, SCRYPT_OPTS);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const blob = Buffer.concat([salt, iv, tag, ciphertext]).toString("base64");
  return `${VERSION}:${blob}`;
}

export function decryptToken(encrypted: string, passphrase: string): string {
  if (!encrypted) throw new Error("decryptToken: encrypted value is empty");
  if (!passphrase) throw new Error("decryptToken: passphrase is empty");

  const [version, b64] = encrypted.split(":", 2);
  if (version !== VERSION || !b64) {
    throw new Error(
      `decryptToken: unsupported encrypted token format (expected '${VERSION}:...')`,
    );
  }

  const blob = Buffer.from(b64, "base64");
  if (blob.length < SALT_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error("decryptToken: encrypted blob is truncated");
  }

  const salt = blob.subarray(0, SALT_LEN);
  const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = blob.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key = scryptSync(passphrase, salt, KEY_LEN, SCRYPT_OPTS);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf-8",
    );
  } catch {
    throw new Error(
      "decryptToken: decryption failed — wrong passphrase or corrupted blob",
    );
  }
}

/**
 * Resolve the token to use, checking encrypted-mode first.
 * Returns the plaintext token, plus a tag describing where it came from.
 */
export function resolveToken(env: NodeJS.ProcessEnv): {
  token: string;
  source: "GITHUB_TOKEN" | "GITHUB_TOKEN_ENCRYPTED";
} {
  const encrypted = env.GITHUB_TOKEN_ENCRYPTED;
  if (encrypted) {
    const pass = env.OPENCODE_PASSPHRASE;
    if (!pass) {
      throw new Error(
        "GITHUB_TOKEN_ENCRYPTED is set but OPENCODE_PASSPHRASE is missing. " +
          "Set it in your shell before launching OpenCode.",
      );
    }
    return { token: decryptToken(encrypted, pass), source: "GITHUB_TOKEN_ENCRYPTED" };
  }
  const plain = env.GITHUB_TOKEN;
  if (plain) return { token: plain, source: "GITHUB_TOKEN" };
  throw new Error(
    "No GitHub token configured. Set either GITHUB_TOKEN (plain) or " +
      "GITHUB_TOKEN_ENCRYPTED + OPENCODE_PASSPHRASE in the environment.",
  );
}

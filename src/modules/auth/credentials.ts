import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * scrypt parameters per OWASP Password Storage Cheat Sheet (N=2^17, r=8, p=1:
 * ~128 MiB, memory-hard). Parameters are encoded into each stored hash so they
 * can be raised later without invalidating existing passwords.
 */
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must exceed 128 * N * r bytes, or Node rejects the parameters.
    scrypt(password, salt, keylen, { ...opts, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Returns `scrypt$N$r$p$<salt b64>$<hash b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const { N, r, p } = SCRYPT_PARAMS;
  const key = await scryptAsync(password, salt, KEY_LENGTH, { N, r, p });
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Constant-time verification. Malformed stored hashes verify as false, never throw. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64");
  if (expected.length === 0) return false;

  const key = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn the same CPU/memory as a real verification when the email is unknown,
 * so response timing does not reveal which emails are registered.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  await verifyPassword(password, await dummyHash);
  return false;
}

/** 256-bit random bearer token, base64url (43 chars, no padding). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Tokens are high-entropy, so a fast unsalted hash is sufficient (unlike passwords). */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

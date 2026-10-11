/**
 * Workers 版密码学工具。
 *
 * 与 Node 版 server/auth.ts 的差异：
 * - `node:crypto` 的 `scrypt` 在 Workers 中不存在 → 改用 PBKDF2-SHA256
 * - `createHmac` / `createHash` → WebCrypto 的 `subtle`
 * - WebCrypto 不提供 SHA-1（七牛上传凭证必须用 HMAC-SHA1）→ 内置纯 JS 实现
 */
import { bytesToBase64Url, bytesToHex, utf8Bytes, type Bytes } from "./bytes.js";

/** 免费的 Workers 计划单请求 CPU 预算有限，PBKDF2 迭代次数需要克制。 */
export const DEFAULT_PBKDF2_ITERATIONS = 10_000;
const DERIVED_KEY_BYTES = 32;

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function getSubtle(): SubtleCrypto {
  return crypto.subtle;
}

export async function sha256Bytes(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await getSubtle().digest("SHA-256", data));
}

export async function sha256Hex(data: Bytes): Promise<string> {
  return bytesToHex(await sha256Bytes(data));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const cached = hmacKeyCache.get(secret);

  if (cached) {
    return cached;
  }

  const pending = getSubtle().importKey(
    "raw",
    utf8Bytes(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  hmacKeyCache.set(secret, pending);

  return pending;
}

export async function hmacSha256Bytes(
  secret: string,
  message: string,
): Promise<Bytes> {
  const key = await importHmacKey(secret);
  const signature = await getSubtle().sign("HMAC", key, utf8Bytes(message));

  return new Uint8Array(signature);
}

export async function hmacSha256Base64Url(
  secret: string,
  message: string,
): Promise<string> {
  return bytesToBase64Url(await hmacSha256Bytes(secret, message));
}

/* -------------------------------------------------------------------------- */
/* PBKDF2（替代 Node 的 scrypt）                                                */
/* -------------------------------------------------------------------------- */

export async function derivePasswordHash(
  password: string,
  salt: string,
  iterations: number,
): Promise<Bytes> {
  const keyMaterial = await getSubtle().importKey(
    "raw",
    utf8Bytes(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await getSubtle().deriveBits(
    {
      hash: "SHA-256",
      iterations,
      name: "PBKDF2",
      salt: utf8Bytes(salt),
    },
    keyMaterial,
    DERIVED_KEY_BYTES * 8,
  );

  return new Uint8Array(bits);
}

export function randomBytes(length: number): Bytes {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomBase64Url(byteLength: number): string {
  return bytesToBase64Url(randomBytes(byteLength));
}

export function randomHex(byteLength: number): string {
  return bytesToHex(randomBytes(byteLength));
}

export function randomUuid(): string {
  return crypto.randomUUID();
}

/* -------------------------------------------------------------------------- */
/* SHA-1 / HMAC-SHA1（纯 JS）                                                   */
/*                                                                              */
/* 七牛上传凭证的签名算法固定为 HMAC-SHA1，而 WebCrypto 出于安全考虑不提供      */
/* SHA-1。这里按 FIPS 180-1 实现，仅用于七牛签名与内容哈希，不用于口令派生。    */
/* -------------------------------------------------------------------------- */

const SHA1_BLOCK_SIZE = 64;

export function sha1Bytes(input: Bytes): Bytes {
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const words = new Int32Array(80);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getInt32(offset + index * 4);
    }

    for (let index = 16; index < 80; index += 1) {
      const value =
        words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16];
      words[index] = (value << 1) | (value >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let index = 0; index < 80; index += 1) {
      let f: number;
      let k: number;

      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (((a << 5) | (a >>> 27)) + f + e + k + words[index]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const digest = new Uint8Array(20);
  const digestView = new DataView(digest.buffer);
  digestView.setInt32(0, h0);
  digestView.setInt32(4, h1);
  digestView.setInt32(8, h2);
  digestView.setInt32(12, h3);
  digestView.setInt32(16, h4);

  return digest;
}

export function hmacSha1Bytes(key: Bytes, message: Bytes): Bytes {
  let normalizedKey = key;

  if (normalizedKey.length > SHA1_BLOCK_SIZE) {
    normalizedKey = sha1Bytes(normalizedKey);
  }

  const keyBlock = new Uint8Array(SHA1_BLOCK_SIZE);
  keyBlock.set(normalizedKey);

  const inner = new Uint8Array(SHA1_BLOCK_SIZE + message.length);
  const outer = new Uint8Array(SHA1_BLOCK_SIZE + 20);

  for (let index = 0; index < SHA1_BLOCK_SIZE; index += 1) {
    inner[index] = keyBlock[index] ^ 0x36;
    outer[index] = keyBlock[index] ^ 0x5c;
  }

  inner.set(message, SHA1_BLOCK_SIZE);
  outer.set(sha1Bytes(inner), SHA1_BLOCK_SIZE);

  return sha1Bytes(outer);
}

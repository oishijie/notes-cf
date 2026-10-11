/**
 * base64 / base64url / hex 编解码工具。
 *
 * Workers 没有 Node 的 `Buffer`，全部用 `btoa` / `atob` 与 `Uint8Array` 实现。
 * 分段拼接是为了避免超长字符串触发 `String.fromCharCode` 的参数上限。
 */

import type { Bytes } from "../../src/lib/bytes.js";

export type { Bytes };

const CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Bytes): string {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...Array.from(bytes.subarray(offset, offset + CHUNK_SIZE)),
    );
  }

  return btoa(binary);
}

export function bytesToBase64Url(bytes: Bytes): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 解码 base64url；输入非法时返回 null 而不是抛错。 */
export function base64UrlToBytes(value: string): Bytes | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return null;
  }

  const padded =
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}

export function stringToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

/** 解码 base64url 为 UTF-8 字符串；输入非法时返回 null。 */
export function base64UrlToString(value: string): string | null {
  const bytes = base64UrlToBytes(value);

  if (!bytes) {
    return null;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function bytesToHex(bytes: Bytes): string {
  let hex = "";

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

export function utf8Bytes(value: string): Bytes {
  return new TextEncoder().encode(value);
}

/** 常量时间比较，避免通过响应耗时泄露签名差异位置。 */
export function timingSafeEqual(
  left: Bytes,
  right: Bytes,
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;

  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }

  return diff === 0;
}

/** 比较两个字符串的摘要，避免长度差异泄露信息。 */
export function safeStringEqual(left: string, right: string): boolean {
  const leftBytes = utf8Bytes(left);
  const rightBytes = utf8Bytes(right);
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |=
      (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

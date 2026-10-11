/**
 * 图片存储层：用 R2 替代原 Node 版的 storage/images 目录。
 *
 * 行为与原版保持一致：
 * - 以内容 SHA-256 作为对象名，天然去重
 * - 通过 `/images/<hash>.<ext>` 暴露给前端
 */
import { sha256Hex } from "./lib/crypto.js";
import { utf8Bytes, type Bytes } from "./lib/bytes.js";
import type { R2Bucket } from "@cloudflare/workers-types";

export interface ImageSource {
  buffer: Bytes;
  filename?: string | null;
  mimeType?: string | null;
}

export interface StoredImage {
  extension: string;
  hash: string;
  path: string;
  url: string;
}

export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

/** R2 对象前缀，与公开路径 `/images/` 对应。 */
export const IMAGE_PREFIX = "images/";

function asciiAt(buffer: Bytes, offset: number, length: number): string {
  let value = "";

  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(buffer[offset + index] ?? 0);
  }

  return value;
}

/**
 * 通过文件头（magic bytes）判断真实图片格式，MIME 与扩展名仅作兜底。
 * 与 Node 版 detectImageFormat 的判断顺序一致。
 */
export function detectImageFormat(
  buffer: Bytes,
  mimeType?: string | null,
  filename?: string | null,
): string | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "jpg";
  }

  if (buffer.length >= 6) {
    const gifHeader = asciiAt(buffer, 0, 6);

    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
      return "gif";
    }
  }

  if (
    buffer.length >= 12 &&
    asciiAt(buffer, 0, 4) === "RIFF" &&
    asciiAt(buffer, 8, 4) === "WEBP"
  ) {
    return "webp";
  }

  if (buffer.length >= 2 && asciiAt(buffer, 0, 2) === "BM") {
    return "bmp";
  }

  const sample = new TextDecoder("utf-8", { fatal: false })
    .decode(buffer.subarray(0, 512))
    .trimStart();

  if (
    (sample.startsWith("<?xml") || sample.startsWith("<svg")) &&
    /<svg[\s>]/i.test(sample)
  ) {
    return "svg";
  }

  const normalizedMime = mimeType?.split(";")[0].trim().toLowerCase();

  switch (normalizedMime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/svg+xml":
      return "svg";
    default:
      break;
  }

  const extension = filename
    ?.slice(filename.lastIndexOf(".") + 1)
    .toLowerCase()
    .trim();

  switch (extension) {
    case "png":
    case "gif":
    case "webp":
    case "bmp":
    case "svg":
      return extension;
    case "jpg":
    case "jpeg":
      return "jpg";
    default:
      return null;
  }
}

export function getImageMimeType(extension: string): string {
  switch (extension.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    default:
      return "image/png";
  }
}

export function resolveSourceUrl(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) {
    return null;
  }

  try {
    const url = new URL(input.trim());

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

export async function downloadImageFromUrl(sourceUrl: string): Promise<ImageSource> {
  const response = await fetch(sourceUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `图片下载失败（${response.status} ${response.statusText || ""}）`.trim(),
    );
  }

  const contentLength = Number(response.headers.get("content-length") || "0");

  if (contentLength > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(
      `图片过大，单张图片不能超过 ${Math.floor(MAX_IMAGE_SIZE_BYTES / 1024 / 1024)}MB。`,
    );
  }

  const buffer = new Uint8Array(await response.arrayBuffer());

  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(
      `图片过大，单张图片不能超过 ${Math.floor(MAX_IMAGE_SIZE_BYTES / 1024 / 1024)}MB。`,
    );
  }

  let filename = "remote-image";

  try {
    filename = new URL(response.url).pathname.split("/").pop() || filename;
  } catch {
    // 保留默认文件名
  }

  return {
    buffer,
    filename,
    mimeType: response.headers.get("content-type"),
  };
}

/** 把图片写入 R2 并返回公开访问信息。相同内容的图片只存一份。 */
export async function persistImage(
  bucket: R2Bucket,
  baseUrl: string,
  source: ImageSource,
): Promise<StoredImage> {
  if (!source.buffer.length) {
    throw new Error("图片内容为空。");
  }

  const extension = detectImageFormat(
    source.buffer,
    source.mimeType,
    source.filename,
  );

  if (!extension) {
    throw new Error("暂不支持该图片格式。");
  }

  const hash = await sha256Hex(source.buffer);
  const filename = `${hash}.${extension}`;
  const key = `${IMAGE_PREFIX}${filename}`;
  const existing = await bucket.head(key);

  if (!existing) {
    await bucket.put(key, source.buffer, {
      httpMetadata: {
        cacheControl: "public, max-age=31536000, immutable",
        contentType: getImageMimeType(extension),
      },
    });
  }

  const publicPath = `/${IMAGE_PREFIX}${filename}`.replace("//", "/");

  return {
    extension,
    hash,
    path: publicPath,
    url: `${baseUrl}${publicPath}`,
  };
}

/** 读取已存储的图片（供公众号图片回环访问使用）。 */
export async function readStoredImage(
  bucket: R2Bucket,
  filename: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  // 只接受 `<64 位十六进制>.<扩展名>`，避免路径穿越
  if (!/^[a-f0-9]{64}\.[a-z0-9]{2,5}$/.test(filename)) {
    return null;
  }

  const object = await bucket.get(`${IMAGE_PREFIX}${filename}`);

  if (!object) {
    return null;
  }

  return {
    // R2 的 `body` 是 workerd 的 ReadableStream，而 DOM lib 的 `ReadableStream`
    // 是另一套独立的类声明（两者在类型上无法互相赋值），但运行时是同一个对象。
    // 这里做一次类型桥接，调用方（`/images/:filename`）直接交给 `Response`。
    body: object.body as unknown as ReadableStream,
    contentType:
      object.httpMetadata?.contentType ?? getImageMimeType(filename.split(".").pop() ?? ""),
  };
}

/** 判断字符串是否指向本站的 `/images/*` 资源。 */
export function isLocalImageUrl(source: string): string | null {
  const match = /^\/images\/([^/?#]+)$/.exec(source.trim());

  return match ? match[1] : null;
}

export { utf8Bytes };

/**
 * 七牛云图床（Workers 版）。
 *
 * 与原 Node 版 server/qiniu.ts 的差异：
 * - 不再依赖官方 Node SDK（它依赖 Node 的 http 栈）
 * - 改为直接构造表单上传请求：POST multipart/form-data，字段 token / key / file
 * - 签名用 HMAC-SHA1（WebCrypto 不提供 SHA-1，见 lib/crypto.ts 的纯 JS 实现）
 *
 * 对象名规则保持一致：`<内容 SHA-256>.<真实扩展名>`，天然去重。
 */
import { hmacSha1Bytes, sha256Hex } from "./lib/crypto.js";
import type { Bytes } from "./lib/bytes.js";
import { getImageMimeType } from "./images.js";

export interface QiniuConfig {
  accessKey: string;
  bucket: string;
  domain: string;
  prefix: string;
  secretKey: string;
  uploadTimeoutMs: number;
  uploadUrls: string[];
}

export interface QiniuUploadResult {
  key: string;
  uploaded: boolean;
  url: string;
}

export interface QiniuUploadOptions {
  deleteAfterDays?: number;
  prefix?: string;
}

export class QiniuConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QiniuConfigurationError";
  }
}

export class QiniuUploadError extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(
    message: string,
    options: { code?: string; status?: number } = {},
  ) {
    super(message);
    this.name = "QiniuUploadError";
    this.status = options.status;
    this.code = options.code;
  }
}

const DEFAULT_QINIU_UPLOAD_TIMEOUT_MS = 30_000;
const MIN_QINIU_UPLOAD_TIMEOUT_MS = 10_000;
const MAX_QINIU_UPLOAD_TIMEOUT_MS = 300_000;
/** 七牛的通用上传入口，会自动路由到 Bucket 所在区域。 */
const DEFAULT_QINIU_UPLOAD_ORIGIN = "https://upload.qiniup.com";

export interface QiniuEnvSource {
  QINIU_ACCESS_KEY?: string;
  QINIU_BUCKET?: string;
  QINIU_DOMAIN?: string;
  QINIU_PREFIX?: string;
  QINIU_SECRET_KEY?: string;
  QINIU_UPLOAD_TIMEOUT_MS?: string;
  QINIU_UPLOAD_URL?: string;
}

export function parseQiniuUploadTimeoutMs(value?: string): number {
  const normalized = value?.trim();

  if (!normalized) {
    return DEFAULT_QINIU_UPLOAD_TIMEOUT_MS;
  }

  const parsed = Number(normalized);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_QINIU_UPLOAD_TIMEOUT_MS ||
    parsed > MAX_QINIU_UPLOAD_TIMEOUT_MS
  ) {
    throw new QiniuConfigurationError(
      `QINIU_UPLOAD_TIMEOUT_MS 必须是 ${MIN_QINIU_UPLOAD_TIMEOUT_MS} 到 ${MAX_QINIU_UPLOAD_TIMEOUT_MS} 之间的整数毫秒值。`,
    );
  }

  return parsed;
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

function parseUploadOrigin(value?: string): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!entries?.length) {
    return [];
  }

  return entries.map((entry) => {
    let parsed: URL;

    try {
      parsed = new URL(entry);
    } catch {
      throw new QiniuConfigurationError(`七牛上传地址格式不正确：${entry}`);
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new QiniuConfigurationError(
        `七牛上传地址必须是 HTTP(S) 地址：${entry}`,
      );
    }

    return parsed.origin;
  });
}

/** 从环境变量读取七牛配置；未配置任何一项时返回 null。 */
export function loadQiniuConfig(env: QiniuEnvSource): QiniuConfig | null {
  const accessKey = env.QINIU_ACCESS_KEY?.trim();
  const secretKey = env.QINIU_SECRET_KEY?.trim();
  const bucket = env.QINIU_BUCKET?.trim();
  const domain = env.QINIU_DOMAIN?.trim();
  const configured = [accessKey, secretKey, bucket, domain].filter(Boolean);

  if (configured.length === 0) {
    return null;
  }

  if (!accessKey || !secretKey || !bucket || !domain) {
    throw new QiniuConfigurationError(
      "七牛环境变量配置不完整，需要 QINIU_ACCESS_KEY、QINIU_SECRET_KEY、QINIU_BUCKET 和 QINIU_DOMAIN。",
    );
  }

  return {
    accessKey,
    bucket,
    domain: normalizeDomain(domain),
    prefix: env.QINIU_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "",
    secretKey,
    uploadTimeoutMs: parseQiniuUploadTimeoutMs(env.QINIU_UPLOAD_TIMEOUT_MS),
    uploadUrls: parseUploadOrigin(env.QINIU_UPLOAD_URL),
  };
}

/** 七牛要求 urlsafe base64（`+/` 换成 `-_`），此处保留 padding 与原版一致。 */
function urlSafeBase64(input: Uint8Array): string {
  let binary = "";

  for (const byte of input) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

function urlSafeBase64FromString(input: string): string {
  return urlSafeBase64(new TextEncoder().encode(input));
}

export function createQiniuUploadToken(
  config: QiniuConfig,
  key: string,
  now = Date.now(),
  deleteAfterDays?: number,
): string {
  const policy: Record<string, number | string> = {
    scope: `${config.bucket}:${key}`,
    deadline: Math.floor(now / 1000) + 3600,
  };

  if (
    typeof deleteAfterDays === "number" &&
    Number.isInteger(deleteAfterDays) &&
    deleteAfterDays > 0
  ) {
    policy.deleteAfterDays = deleteAfterDays;
  }

  const encodedPolicy = urlSafeBase64FromString(JSON.stringify(policy));
  const encodedSignature = urlSafeBase64(
    hmacSha1Bytes(new TextEncoder().encode(config.secretKey), new TextEncoder().encode(encodedPolicy)),
  );

  return `${config.accessKey}:${encodedSignature}:${encodedPolicy}`;
}

function normalizeImageExtension(extension: string): string {
  const normalized = extension.toLowerCase().replace(/[^a-z0-9]/g, "") || "png";

  return normalized === "jpeg" ? "jpg" : normalized;
}

function encodeObjectKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/** 判断地址是否已经指向七牛空间；未配置七牛时恒为 false。 */
export function isQiniuUrl(
  sourceUrl: string,
  config: QiniuConfig | null,
): boolean {
  if (!config) {
    return false;
  }

  return sourceUrl === config.domain || sourceUrl.startsWith(`${config.domain}/`);
}

export async function createContentAddressedQiniuKey(
  buffer: Bytes,
  extension: string,
  prefix = "",
): Promise<string> {
  const normalizedExtension = normalizeImageExtension(extension);
  const hash = await sha256Hex(buffer);
  const filename = `${hash}.${normalizedExtension}`;
  const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");

  return normalizedPrefix ? `${normalizedPrefix}/${filename}` : filename;
}

interface QiniuUploadResponsePayload {
  error?: unknown;
  error_code?: unknown;
}

export async function uploadImageBufferToQiniu(
  buffer: Bytes,
  extension: string,
  config: QiniuConfig,
  options: QiniuUploadOptions = {},
): Promise<QiniuUploadResult> {
  const normalizedExtension = normalizeImageExtension(extension);
  const key = await createContentAddressedQiniuKey(
    buffer,
    normalizedExtension,
    options.prefix ?? config.prefix,
  );
  const publicUrl = `${config.domain}/${encodeObjectKey(key)}`;
  const uploadToken = createQiniuUploadToken(
    config,
    key,
    Date.now(),
    options.deleteAfterDays,
  );
  const filename = key.slice(key.lastIndexOf("/") + 1);
  const mimeType = getImageMimeType(normalizedExtension);
  const origins =
    config.uploadUrls.length > 0
      ? config.uploadUrls
      : [DEFAULT_QINIU_UPLOAD_ORIGIN];
  let lastError: unknown = null;

  for (const origin of origins) {
    const form = new FormData();
    form.append("token", uploadToken);
    form.append("key", key);
    // 文件的 Content-Type 即七牛保存对象时使用的 MIME 类型
    form.append("file", new Blob([buffer], { type: mimeType }), filename);

    try {
      const response = await fetch(`${origin}/`, {
        body: form,
        method: "POST",
        signal: AbortSignal.timeout(config.uploadTimeoutMs),
      });

      // 七牛在对象已存在时返回 614：内容寻址下直接复用公开地址
      if (response.status === 614) {
        return { key, uploaded: false, url: publicUrl };
      }

      if (response.ok) {
        return { key, uploaded: true, url: publicUrl };
      }

      const payload = (await response
        .json()
        .catch(() => null)) as QiniuUploadResponsePayload | null;
      const detail =
        (typeof payload?.error === "string" && payload.error) ||
        (typeof payload?.error_code === "string" && payload.error_code) ||
        response.statusText ||
        "未知错误";

      throw new QiniuUploadError(
        `七牛图片上传失败（${response.status}）：${detail}`,
        { status: response.status },
      );
    } catch (error) {
      if (error instanceof QiniuUploadError) {
        lastError = error;
        continue;
      }

      lastError = error;
    }
  }

  if (lastError instanceof QiniuUploadError) {
    throw lastError;
  }

  throw new QiniuUploadError(
    `七牛上传失败：已尝试 ${origins.length} 个上传节点。`,
    {
      code:
        lastError instanceof Error && "code" in lastError
          ? String((lastError as { code?: unknown }).code)
          : undefined,
    },
  );
}

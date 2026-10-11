/**
 * 微信公众号官方接口封装（Workers 版）。
 *
 * 与原 Node 版 server/wechat-official.ts 几乎一致：原实现只依赖 fetch / FormData /
 * Blob，这些在 Workers 中都是原生能力。唯一改动是把 `createHash` 换成 WebCrypto。
 */
import { sha256Hex } from "./lib/crypto.js";
import { utf8Bytes, type Bytes } from "./lib/bytes.js";

export interface WechatOfficialConfiguration {
  appId: string;
  appSecret: string;
}

export interface WechatImageUpload {
  buffer: Bytes;
  filename: string;
  mimeType: string;
}

export interface WechatPermanentImage {
  mediaId: string;
  url: string | null;
}

export interface WechatDraftArticle {
  content: string;
  thumbMediaId: string;
  title: string;
}

export interface WechatEnvSource {
  WECHAT_API_BASE_URL?: string;
}

interface WechatAccessTokenResponse {
  access_token?: unknown;
  errcode?: unknown;
  errmsg?: unknown;
  expires_in?: unknown;
}

interface WechatContentImageResponse {
  errcode?: unknown;
  errmsg?: unknown;
  url?: unknown;
}

interface WechatPermanentImageResponse {
  errcode?: unknown;
  errmsg?: unknown;
  media_id?: unknown;
  url?: unknown;
}

interface WechatDraftResponse {
  errcode?: unknown;
  errmsg?: unknown;
  media_id?: unknown;
}

interface CachedAccessToken {
  expiresAt: number;
  token: string;
}

/** isolate 级缓存：同一份凭据在有效期内不会重复换取。 */
const accessTokenCache = new Map<string, CachedAccessToken>();
const requestTimeoutMs = 20_000;

function getWechatApiBaseUrl(env: WechatEnvSource): string {
  return env.WECHAT_API_BASE_URL?.trim() || "https://api.weixin.qq.com";
}

function createWechatApiUrl(env: WechatEnvSource, pathname: string): URL {
  return new URL(
    pathname,
    `${getWechatApiBaseUrl(env).replace(/\/$/, "")}/`,
  );
}

async function getConfigurationKey(
  configuration: WechatOfficialConfiguration,
): Promise<string> {
  return sha256Hex(
    utf8Bytes(`${configuration.appId}\u0000${configuration.appSecret}`),
  );
}

function getWechatErrorMessage(code: number | null, message: string): string {
  switch (code) {
    case 40013:
      return "微信公众号 AppID 无效。";
    case 40125:
      return "微信公众号 AppSecret 无效。";
    case 40164:
      return "当前服务器出口 IP 不在微信公众号白名单中。";
    case 40007:
      return "微信公众号拒绝了图片素材。";
    case 45009:
      return "微信公众号接口调用额度已用完。";
    default:
      return message
        ? `微信公众号接口返回错误：${message}${code == null ? "" : `（${code}）`}`
        : `微信公众号接口调用失败${code == null ? "" : `（${code}）`}。`;
  }
}

export class WechatOfficialApiError extends Error {
  readonly code: number | null;

  constructor(code: number | null, message: string) {
    super(getWechatErrorMessage(code, message));
    this.name = "WechatOfficialApiError";
    this.code = code;
  }
}

async function readWechatJson<T>(response: Response, operation: string): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | (T & { errcode?: unknown; errmsg?: unknown })
    | null;

  if (!response.ok || !payload) {
    throw new WechatOfficialApiError(
      null,
      `${operation}失败（HTTP ${response.status}）`,
    );
  }

  const code = typeof payload.errcode === "number" ? payload.errcode : null;

  if (code !== null && code !== 0) {
    throw new WechatOfficialApiError(
      code,
      typeof payload.errmsg === "string" ? payload.errmsg : operation,
    );
  }

  return payload;
}

async function requestWechatJson<T>(
  url: URL,
  init: RequestInit,
  operation: string,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new WechatOfficialApiError(
      null,
      error instanceof Error ? `${operation}失败：${error.message}` : operation,
    );
  }

  return readWechatJson<T>(response, operation);
}

export async function clearWechatAccessToken(
  configuration: WechatOfficialConfiguration,
): Promise<void> {
  accessTokenCache.delete(await getConfigurationKey(configuration));
}

export async function getWechatAccessToken(
  env: WechatEnvSource,
  configuration: WechatOfficialConfiguration,
  forceRefresh = false,
): Promise<string> {
  const cacheKey = await getConfigurationKey(configuration);
  const cached = accessTokenCache.get(cacheKey);

  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const url = createWechatApiUrl(env, "/cgi-bin/token");
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", configuration.appId);
  url.searchParams.set("secret", configuration.appSecret);

  const payload = await requestWechatJson<WechatAccessTokenResponse>(
    url,
    { method: "GET" },
    "验证公众号配置",
  );

  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new WechatOfficialApiError(null, "微信没有返回接口调用凭据");
  }

  const expiresIn =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : 7_200;
  accessTokenCache.set(cacheKey, {
    expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1_000,
    token: payload.access_token,
  });

  return payload.access_token;
}

function createImageFormData(image: WechatImageUpload): FormData {
  const form = new FormData();
  form.append(
    "media",
    new Blob([image.buffer], { type: image.mimeType }),
    image.filename,
  );

  return form;
}

export async function uploadWechatContentImage(
  env: WechatEnvSource,
  accessToken: string,
  image: WechatImageUpload,
): Promise<string> {
  const url = createWechatApiUrl(env, "/cgi-bin/media/uploadimg");
  url.searchParams.set("access_token", accessToken);
  const payload = await requestWechatJson<WechatContentImageResponse>(
    url,
    { body: createImageFormData(image), method: "POST" },
    "上传公众号正文图片",
  );

  if (typeof payload.url !== "string" || !payload.url) {
    throw new WechatOfficialApiError(null, "微信没有返回正文图片地址");
  }

  return payload.url;
}

export async function uploadWechatPermanentImage(
  env: WechatEnvSource,
  accessToken: string,
  image: WechatImageUpload,
): Promise<WechatPermanentImage> {
  const url = createWechatApiUrl(env, "/cgi-bin/material/add_material");
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("type", "image");
  const payload = await requestWechatJson<WechatPermanentImageResponse>(
    url,
    { body: createImageFormData(image), method: "POST" },
    "上传公众号永久图片素材",
  );

  if (typeof payload.media_id !== "string" || !payload.media_id) {
    throw new WechatOfficialApiError(null, "微信没有返回永久图片素材 ID");
  }

  return {
    mediaId: payload.media_id,
    url: typeof payload.url === "string" && payload.url ? payload.url : null,
  };
}

export async function addWechatDraft(
  env: WechatEnvSource,
  accessToken: string,
  article: WechatDraftArticle,
): Promise<string> {
  const url = createWechatApiUrl(env, "/cgi-bin/draft/add");
  url.searchParams.set("access_token", accessToken);
  const payload = await requestWechatJson<WechatDraftResponse>(
    url,
    {
      body: JSON.stringify({
        articles: [
          {
            article_type: "news",
            content: article.content,
            need_open_comment: 0,
            only_fans_can_comment: 0,
            thumb_media_id: article.thumbMediaId,
            title: article.title,
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    "保存公众号草稿",
  );

  if (typeof payload.media_id !== "string" || !payload.media_id) {
    throw new WechatOfficialApiError(null, "微信没有返回草稿素材 ID");
  }

  return payload.media_id;
}

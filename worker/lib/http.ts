/**
 * 请求级工具：同源校验与对外公开地址推导。
 */
import type { Env } from "../env.js";

const FORWARDED_PROTO_HEADER = "x-forwarded-proto";
const FORWARDED_HOST_HEADER = "x-forwarded-host";
const HOST_HEADER = "host";

export function isSecureRequest(request: Request): boolean {
  const url = new URL(request.url);

  if (url.protocol === "https:") {
    return true;
  }

  const forwardedProto =
    request.headers.get(FORWARDED_PROTO_HEADER)?.split(",")[0]?.trim() ??
    "";

  return forwardedProto === "https";
}

function getForwardedHost(request: Request): string | null {
  const forwarded =
    request.headers.get(FORWARDED_HOST_HEADER)?.split(",")[0]?.trim() ??
    request.headers.get(HOST_HEADER)?.trim() ??
    "";

  return forwarded || null;
}

/**
 * 推导站点的对外公开地址（不带尾部斜杠）。
 *
 * 优先使用显式配置的 NOTES_PUBLIC_BASE_URL，其次使用反向代理转发的
 * Host / Proto 头，最后回退到请求自身的 URL。
 */
export function getPublicBaseUrl(request: Request, env: Env): string {
  const configured = env.NOTES_PUBLIC_BASE_URL?.trim();

  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const requestUrl = new URL(request.url);
  const host = getForwardedHost(request);

  if (!host) {
    return requestUrl.origin;
  }

  const protocol = isSecureRequest(request)
    ? "https"
    : requestUrl.protocol.replace(":", "") || "http";

  return `${protocol}://${host}`;
}

/**
 * 同源校验：用于保护会签发凭据的接口（skill-token、公众号配置、草稿发布）。
 *
 * 只信任浏览器无法伪造的 `Origin`（其次 `Referer`），并与请求自身 Host 比对，
 * 不信任任何可被中间人改写的转发头。
 */
export function isSameOriginRequest(request: Request): boolean {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");

  if (origin) {
    if (origin === "null") {
      return false;
    }

    try {
      return new URL(origin).host === requestUrl.host;
    } catch {
      return false;
    }
  }

  const referer = request.headers.get("referer");

  if (referer) {
    try {
      return new URL(referer).host === requestUrl.host;
    } catch {
      return false;
    }
  }

  // 命令行客户端通常不带 Origin / Referer，此时放行，
  // 真正需要凭据的路径仍会单独要求 Token 或会话。
  return true;
}

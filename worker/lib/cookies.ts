/**
 * 会话 Cookie 的读写。与原 Node 版保持完全相同的名称与属性，
 * 以保证既有浏览器会话在迁移后仍然有效。
 */

export const SESSION_COOKIE_NAME = "notes_session";
export const SESSION_DURATION_SECONDS = 12 * 60 * 60;
export const REMEMBERED_SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;

export function readSessionToken(
  cookieHeader: string | undefined,
): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const cookie of cookieHeader.split(";")) {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex < 0) {
      continue;
    }

    const name = cookie.slice(0, separatorIndex).trim();

    if (name === SESSION_COOKIE_NAME) {
      try {
        return decodeURIComponent(cookie.slice(separatorIndex + 1).trim());
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

export function createSessionCookie(
  token: string,
  options: { remember: boolean; secure: boolean },
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (options.remember) {
    parts.push(`Max-Age=${REMEMBERED_SESSION_DURATION_SECONDS}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export function createExpiredSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

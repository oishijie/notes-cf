/**
 * 开源版锤子便签 —— Cloudflare Workers 后端入口。
 *
 * 单 Worker 同时承担三件事：
 *   1. `/api/*`  业务接口（账号、同步、图片、AI、公众号、Skill 包）
 *   2. `/images/*` 图片读取（R2）
 *   3. 其余路径交给静态资源绑定（Vite 构建产物）
 *
 * 与原 Node/Express 版的差异（详见 README 的「与旧 Docker 方案的差异」一节与
 * DOCS/architecture.md）：
 *   - 存储：storage/data/*.json → D1；storage/images/* → R2
 *   - 密码：scrypt → PBKDF2-SHA256
 *   - PNG 长图导出、离线归档、工作区 ZIP 导出改为纯浏览器端实现，
 *     因此不再提供 /api/export、/api/archive、/api/workspace/archive
 */
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import {
  DEFAULT_FOOTER_LOGO_URL,
} from "../src/lib/footer.js";
import { NOTE_CARD_THEME_STYLES } from "../src/lib/note-card-theme-styles.js";
import type { NoteCardThemeId } from "../src/types/app.js";
import {
  AccountNotFoundError,
  AnonymousQuotaExceededError,
  DuplicateUsernameError,
  InvalidCurrentPasswordError,
  InvalidNewPasswordError,
  InvalidUsernameError,
  InvalidWechatConfigurationError,
  NotesStore,
  WorkspaceConflictError,
  createSessionToken,
  createSkillToken,
  normalizeUsername,
  resolvePbkdf2Iterations,
  resolveSessionSecret,
  safeStringEqual,
  verifySessionToken,
  verifySkillToken,
  type AuthRole,
  type AuthSession,
  type AuthUser,
} from "./auth.js";
import {
  createAiSuggestions,
  isAiAvailable,
} from "./ai.js";
import type { Env } from "./env.js";
import { buildHermesSkillPackage, HERMES_DOWNLOAD_FILENAME } from "./hermes.js";
import {
  isLocalImageUrl,
  persistImage,
  readStoredImage,
  resolveSourceUrl,
  downloadImageFromUrl,
  detectImageFormat,
  MAX_IMAGE_SIZE_BYTES,
} from "./images.js";
import { inferImageExtension, isImageBedUrl } from "../src/lib/image-bed.js";
import { utf8Bytes, type Bytes } from "./lib/bytes.js";
import { sha256Hex } from "./lib/crypto.js";
import {
  SESSION_COOKIE_NAME,
  REMEMBERED_SESSION_DURATION_SECONDS,
  readSessionToken,
} from "./lib/cookies.js";
import { getPublicBaseUrl, isSameOriginRequest, isSecureRequest } from "./lib/http.js";
import { createSolidColorPng, type RgbColor } from "./lib/png.js";
import {
  addWechatDraft,
  clearWechatAccessToken,
  getWechatAccessToken,
  uploadWechatContentImage,
  uploadWechatPermanentImage,
  WechatOfficialApiError,
  type WechatPermanentImage,
} from "./wechat-official.js";
import {
  assertWechatDraftContentLimits,
  collectHtmlImageSources,
  collectMarkdownImageSources,
  decodeHtmlImageSource,
  getWechatDraftTitle,
  prepareWechatArticle,
  prepareWechatDraftArticle,
  renderWechatArticle,
  replaceAll,
  resolveFooterConfig,
  resolveImageSource,
  type FooterConfig,
  type WechatConnectionStatus,
} from "./wechat-article.js";

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

const SUPPORTED_THEMES = new Set<string>(Object.keys(NOTE_CARD_THEME_STYLES));
const DEFAULT_ANONYMOUS_DAILY_UPLOAD_LIMIT = 500;
const MAX_AI_MARKDOWN_LENGTH = 100_000;
const MAX_AI_INSTRUCTION_LENGTH = 2_000;
const AI_REQUEST_WINDOW_MS = 10 * 60 * 1_000;
const MAX_AI_REQUESTS_PER_WINDOW = 10;
const WECHAT_COVER_WIDTH = 900;
const WECHAT_COVER_HEIGHT = 383;

/** 草稿封面兜底色（Workers 无字体光栅化能力，退化为纯色封面）。 */
const WECHAT_COVER_COLORS: Record<string, RgbColor> = {
  "apple-notes": { b: 0x1c, g: 0x1c, r: 0x1c },
  "apple-notes-light": { b: 0xff, g: 0xff, r: 0xff },
  bazhahei: { b: 0xf5, g: 0xf9, r: 0xfa },
  bear: { b: 0xff, g: 0xff, r: 0xff },
  default: { b: 0xf7, g: 0xfc, r: 0xff },
  "smartisan-dark": { b: 0x26, g: 0x24, r: 0x22 },
  telegraph: { b: 0xff, g: 0xff, r: 0xff },
};

class UnsupportedExportThemeError extends Error {
  constructor(theme: unknown) {
    super(`不支持的导出主题：${String(theme)}`);
    this.name = "UnsupportedExportThemeError";
  }
}

/** isolate 级 AI 限流（跨 isolate 不共享，属可接受的降级）。 */
const activeAiUsers = new Set<string>();
const aiRequestHistory = new Map<string, number[]>();

/* -------------------------------------------------------------------------- */
/* 请求上下文                                                                  */
/* -------------------------------------------------------------------------- */

interface AppEnv {
  Bindings: Env;
  Variables: {
    sessionSecret: string;
    store: NotesStore;
  };
}

const app = new Hono<AppEnv>();

function getStore(c: { env: Env }): NotesStore {
  return new NotesStore(c.env.DB, {
    iterations: resolvePbkdf2Iterations(c.env.PBKDF2_ITERATIONS),
  });
}

function getAnonymousUploadLimit(env: Env): number {
  return Math.max(
    1,
    Number.parseInt(
      env.ANONYMOUS_DAILY_UPLOAD_LIMIT || String(DEFAULT_ANONYMOUS_DAILY_UPLOAD_LIMIT),
      10,
    ) || DEFAULT_ANONYMOUS_DAILY_UPLOAD_LIMIT,
  );
}

function getSuperAdminCredentials(env: Env): {
  password: string;
  username: string;
} | null {
  const username = env.SUPERADMIN?.trim();
  const password = env.SUPERADMINPASSWORD?.trim();

  return username && password ? { password, username } : null;
}

function getPublicAuthUser(user: AuthUser): AuthUser {
  return { id: user.id, role: user.role, username: user.username };
}

async function readJsonBody<T>(request: Request): Promise<Partial<T>> {
  try {
    const value = (await request.json()) as unknown;

    return value && typeof value === "object" ? (value as Partial<T>) : {};
  } catch {
    return {};
  }
}

/**
 * 供 `requireSuperAdmin` 这类「非路由处理器」返回 JSON 响应。
 *
 * 这些辅助函数只持有 `{ req, env }` 结构片段，拿不到 Hono 的 `c.json()`；
 * 直接构造 `Response` 可以避开 Hono 的泛型约束。
 */
function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });
}

function resolveTheme(body: { theme?: unknown }): NoteCardThemeId {
  if (body.theme == null || body.theme === "") {
    return "default";
  }

  if (typeof body.theme === "string" && SUPPORTED_THEMES.has(body.theme)) {
    return body.theme as NoteCardThemeId;
  }

  throw new UnsupportedExportThemeError(body.theme);
}

function resolveMarkdown(body: { markdown?: unknown }): string {
  if (typeof body.markdown === "string") {
    return body.markdown;
  }

  throw new Error("Missing markdown");
}

/* -------------------------------------------------------------------------- */
/* 会话                                                                        */
/* -------------------------------------------------------------------------- */

function setAuthenticatedSession(
  c: { req: { raw: Request }; env: Env },
  user: AuthUser,
  remember: boolean,
  passwordVersion: number | undefined,
  token: string,
): void {
  const context = c as unknown as Parameters<typeof setCookie>[0];

  setCookie(context, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    maxAge: remember ? REMEMBERED_SESSION_DURATION_SECONDS : undefined,
    path: "/",
    sameSite: "Lax",
    secure: isSecureRequest(c.req.raw),
  });
}

function clearAuthenticatedSession(c: {
  req: { raw: Request };
  env: Env;
}): void {
  deleteCookie(c as unknown as Parameters<typeof deleteCookie>[0], SESSION_COOKIE_NAME, {
    path: "/",
  });
}

async function getAuthenticatedUser(
  c: { req: { raw: Request }; env: Env },
): Promise<AuthSession | null> {
  const secret = await resolveSessionSecret(c.env);
  const token = readSessionToken(c.req.raw.headers.get("cookie") ?? undefined);
  const session = await verifySessionToken(secret, token);

  if (!session) {
    return null;
  }

  if (session.role === "superadmin") {
    const credentials = getSuperAdminCredentials(c.env);

    return credentials &&
      session.id === "superadmin" &&
      safeStringEqual(
        normalizeUsername(session.username),
        normalizeUsername(credentials.username),
      )
      ? session
      : null;
  }

  const account = await getStore(c).getUserById(session.id);

  return account &&
    account.passwordVersion === (session.passwordVersion ?? 1) &&
    safeStringEqual(
      normalizeUsername(account.username),
      normalizeUsername(session.username),
    )
    ? session
    : null;
}

function readBearerToken(request: Request): string | undefined {
  const match = request.headers
    .get("authorization")
    ?.trim()
    .match(/^Bearer\s+([^\s]+)$/i);

  return match?.[1];
}

async function getAuthenticatedSkillUser(
  c: { req: { raw: Request }; env: Env },
): Promise<AuthSession | null> {
  const secret = await resolveSessionSecret(c.env);
  const session = await verifySkillToken(
    secret,
    c.env,
    readBearerToken(c.req.raw),
  );

  if (!session) {
    return null;
  }

  if (session.role === "superadmin") {
    return session;
  }

  const account = await getStore(c).getUserById(session.id);

  return account &&
    account.passwordVersion === session.passwordVersion &&
    account.skillTokenVersion === session.skillTokenVersion &&
    safeStringEqual(
      normalizeUsername(account.username),
      normalizeUsername(session.username),
    )
    ? session
    : null;
}

async function getWorkspaceUser(c: {
  req: { raw: Request };
  env: Env;
}): Promise<AuthSession | null> {
  return (
    (await getAuthenticatedUser(c)) ?? (await getAuthenticatedSkillUser(c))
  );
}

async function createSkillTokenForUser(
  c: { env: Env },
  user: AuthUser,
): Promise<string | null> {
  const secret = await resolveSessionSecret(c.env);

  if (user.role === "superadmin") {
    return createSkillToken(secret, c.env, user);
  }

  const account = await getStore(c).getUserById(user.id);

  return account
    ? createSkillToken(secret, c.env, user, account.passwordVersion, account.skillTokenVersion)
    : null;
}

/* -------------------------------------------------------------------------- */
/* 中间件                                                                      */
/* -------------------------------------------------------------------------- */

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const requestHeaders = c.req.header("access-control-request-headers");

  c.header("Access-Control-Allow-Origin", origin || "*");
  c.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  c.header(
    "Access-Control-Allow-Headers",
    requestHeaders || "Content-Type, Authorization",
  );
  c.header(
    "Access-Control-Expose-Headers",
    "Content-Disposition, X-Export-Path, X-Export-Url, X-Export-Theme",
  );

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
});

/* -------------------------------------------------------------------------- */
/* 健康检查                                                                    */
/* -------------------------------------------------------------------------- */

app.get("/api/health", (c) => c.json({ ok: true }));

/* -------------------------------------------------------------------------- */
/* 认证                                                                        */
/* -------------------------------------------------------------------------- */

app.get("/api/auth/session", async (c) => {
  const user = await getAuthenticatedUser(c);

  return c.json({ user: user ? getPublicAuthUser(user) : null });
});

interface LoginBody {
  password?: string;
  remember?: boolean;
  username?: string;
}

function resolveLoginCredentials(body: Partial<LoginBody>): {
  password: string;
  remember: boolean;
  username: string;
} | null {
  const username = body.username?.trim();
  const password = body.password;

  if (!username || !password) {
    return null;
  }

  return { password, remember: body.remember === true, username };
}

function authenticateSuperAdmin(
  env: Env,
  credentials: ReturnType<typeof resolveLoginCredentials>,
): AuthUser | null {
  const configured = getSuperAdminCredentials(env);

  if (
    !credentials ||
    !configured ||
    !safeStringEqual(
      normalizeUsername(credentials.username),
      normalizeUsername(configured.username),
    ) ||
    !safeStringEqual(credentials.password, configured.password)
  ) {
    return null;
  }

  return { id: "superadmin", role: "superadmin", username: configured.username };
}

/** 统一处理「普通用户或管理员」的登录，供 /api/auth/login 与 skill-token 复用。 */
async function resolveLoginUser(
  c: { env: Env },
  body: Partial<LoginBody>,
): Promise<
  | { account: Awaited<ReturnType<NotesStore["authenticateUser"]>>; user: AuthUser }
  | null
> {
  const credentials = resolveLoginCredentials(body);

  if (!credentials) {
    return null;
  }

  const superAdmin = authenticateSuperAdmin(c.env, credentials);
  const account = superAdmin
    ? null
    : await getStore(c).authenticateUser(credentials.username, credentials.password);

  if (!superAdmin && !account) {
    return null;
  }

  return {
    account,
    user:
      superAdmin ??
      ({ id: account!.id, role: "user", username: account!.username } satisfies AuthUser),
  };
}

app.post("/api/auth/login", async (c) => {
  const body = await readJsonBody<LoginBody>(c.req.raw);
  const resolved = await resolveLoginUser(c, body);

  if (!resolved) {
    // 区分「参数缺失」与「凭据错误」，与原版行为一致
    const hasCredentials = Boolean(body.username?.trim() && body.password);

    return c.json(
      { error: hasCredentials ? "用户名、邮箱或密码错误。" : "请输入用户名或邮箱及密码。" },
      hasCredentials ? 401 : 400,
    );
  }

  const secret = await resolveSessionSecret(c.env);
  const token = await createSessionToken(
    secret,
    resolved.user,
    body.remember === true,
    Date.now(),
    resolved.account?.passwordVersion,
  );

  setAuthenticatedSession(c, resolved.user, body.remember === true, resolved.account?.passwordVersion, token);

  return c.json({ user: resolved.user });
});

app.post("/api/auth/skill-token", async (c) => {
  c.header("Cache-Control", "no-store");

  if (!isSameOriginRequest(c.req.raw)) {
    return c.json({ error: "请从当前便签页面或可信客户端申请 Skill Token。" }, 403);
  }

  let user: AuthUser | null = await getAuthenticatedUser(c);

  if (!user) {
    const body = await readJsonBody<LoginBody>(c.req.raw);
    const resolved = await resolveLoginUser(c, body);

    if (!resolved) {
      const hasCredentials = Boolean(body.username?.trim() && body.password);

      return c.json(
        { error: hasCredentials ? "用户名、邮箱或密码错误。" : "请提供用户名或邮箱及密码。" },
        hasCredentials ? 401 : 400,
      );
    }

    user = resolved.user;
  }

  const token = await createSkillTokenForUser(c, user);

  if (!token) {
    return c.json({ error: "当前账号已不存在，请重新登录。" }, 401);
  }

  return c.json({ token });
});

app.post("/api/auth/password", async (c) => {
  const session = await getAuthenticatedUser(c);

  if (!session) {
    return c.json({ error: "请先登录账号。" }, 401);
  }

  if (session.role !== "user") {
    return c.json(
      { error: "管理员密码由服务端环境变量维护，不能在便签页面修改。" },
      403,
    );
  }

  const body = await readJsonBody<{ currentPassword?: string; newPassword?: string }>(
    c.req.raw,
  );
  const { currentPassword, newPassword } = body;

  if (
    typeof currentPassword !== "string" ||
    !currentPassword ||
    typeof newPassword !== "string"
  ) {
    return c.json({ error: "请输入当前密码和新密码。" }, 400);
  }

  try {
    const store = getStore(c);
    const passwordVersion = await store.changePassword(
      session.id,
      currentPassword,
      newPassword,
    );
    const user = getPublicAuthUser(session);
    const secret = await resolveSessionSecret(c.env);
    const token = await createSessionToken(
      secret,
      user,
      session.remember,
      Date.now(),
      passwordVersion,
    );

    setAuthenticatedSession(c, user, session.remember, passwordVersion, token);
    await store.revokeHermesInstallLink(session.id);

    return c.json({ ok: true });
  } catch (error) {
    const status =
      error instanceof InvalidCurrentPasswordError ||
      error instanceof InvalidNewPasswordError
        ? 400
        : error instanceof AccountNotFoundError
          ? 404
          : 500;

    return c.json(
      { error: error instanceof Error ? error.message : "修改密码失败。" },
      status,
    );
  }
});

app.post("/api/auth/logout", (c) => {
  clearAuthenticatedSession(c);

  return c.json({ ok: true });
});

app.post("/api/superadmin/login", async (c) => {
  const configured = getSuperAdminCredentials(c.env);

  if (!configured) {
    return c.json(
      {
        error:
          "管理员账号尚未配置，请在服务端设置 SUPERADMIN 和 SUPERADMINPASSWORD。",
      },
      503,
    );
  }

  const body = await readJsonBody<LoginBody>(c.req.raw);
  const credentials = resolveLoginCredentials(body);
  const user = authenticateSuperAdmin(c.env, credentials);

  if (!user) {
    return c.json(
      {
        error: credentials ? "管理员用户名或密码错误。" : "请输入用户名和密码。",
      },
      credentials ? 401 : 400,
    );
  }

  const remember = credentials?.remember === true;
  const secret = await resolveSessionSecret(c.env);
  const token = await createSessionToken(secret, user, remember);

  setAuthenticatedSession(c, user, remember, undefined, token);

  return c.json({ user });
});

/* -------------------------------------------------------------------------- */
/* 管理员：普通用户管理                                                        */
/* -------------------------------------------------------------------------- */

async function requireSuperAdmin(c: {
  req: { raw: Request };
  env: Env;
}): Promise<{ error: Response } | { session: AuthSession }> {
  const session = await getAuthenticatedUser(c);

  if (!session) {
    return { error: jsonResponse({ error: "请先登录管理员后台。" }, 401) };
  }

  if (session.role !== "superadmin") {
    return { error: jsonResponse({ error: "当前账号没有管理员权限。" }, 403) };
  }

  return { session };
}

app.get("/api/superadmin/users", async (c) => {
  const result = await requireSuperAdmin(c);

  if ("error" in result) {
    return result.error;
  }

  return c.json({ users: await getStore(c).listUsers() });
});

app.post("/api/superadmin/users", async (c) => {
  const result = await requireSuperAdmin(c);

  if ("error" in result) {
    return result.error;
  }

  const body = await readJsonBody<{ username?: string }>(c.req.raw);

  if (typeof body.username !== "string") {
    return c.json({ error: "请输入普通用户名或邮箱。" }, 400);
  }

  const configured = getSuperAdminCredentials(c.env);

  if (
    configured &&
    normalizeUsername(body.username) === normalizeUsername(configured.username)
  ) {
    return c.json({ error: "普通账号不能与管理员账号相同。" }, 409);
  }

  try {
    return c.json({ user: await getStore(c).createUser(body.username) }, 201);
  } catch (error) {
    const status =
      error instanceof DuplicateUsernameError
        ? 409
        : error instanceof InvalidUsernameError
          ? 400
          : 500;

    return c.json(
      { error: error instanceof Error ? error.message : "创建用户失败。" },
      status,
    );
  }
});

app.post("/api/superadmin/users/:userId/reset-password", async (c) => {
  const result = await requireSuperAdmin(c);

  if ("error" in result) {
    return result.error;
  }

  try {
    const store = getStore(c);
    const user = await store.resetUserPassword(c.req.param("userId"));

    await store.revokeHermesInstallLink(c.req.param("userId"));

    return c.json({ user });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "重置密码失败。" },
      error instanceof AccountNotFoundError ? 404 : 500,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 工作区                                                                      */
/* -------------------------------------------------------------------------- */

app.get("/api/workspace", async (c) => {
  const user = await getWorkspaceUser(c);

  if (!user) {
    return c.json({ error: "请先登录账号或提供有效的 Skill Token。" }, 401);
  }

  const stored = await getStore(c).getWorkspace(user.id);

  return c.json(stored ?? { updatedAt: null, workspace: null });
});

app.put("/api/workspace", async (c) => {
  const user = await getWorkspaceUser(c);

  if (!user) {
    return c.json({ error: "请先登录账号或提供有效的 Skill Token。" }, 401);
  }

  const body = await readJsonBody<{
    expectedUpdatedAt?: number | null;
    workspace?: unknown;
  }>(c.req.raw);
  const expectedUpdatedAt = body.expectedUpdatedAt;

  if (
    expectedUpdatedAt !== undefined &&
    expectedUpdatedAt !== null &&
    (typeof expectedUpdatedAt !== "number" || !Number.isFinite(expectedUpdatedAt))
  ) {
    return c.json(
      { error: "expectedUpdatedAt 必须是服务端返回的时间戳或 null。" },
      400,
    );
  }

  try {
    return c.json(
      await getStore(c).saveWorkspace(
        user.id,
        body.workspace,
        Date.now(),
        expectedUpdatedAt,
      ),
    );
  } catch (error) {
    return c.json(
      {
        ...(error instanceof WorkspaceConflictError
          ? { updatedAt: error.updatedAt }
          : {}),
        error: error instanceof Error ? error.message : "云端工作区保存失败。",
      },
      error instanceof WorkspaceConflictError ? 409 : 400,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* AI 辅助审阅                                                                 */
/* -------------------------------------------------------------------------- */

app.get("/api/ai/status", async (c) => {
  c.header("Cache-Control", "no-store");

  return c.json({ available: await isAiAvailable(c.env) });
});

function consumeAiRateLimit(userId: string): number | null {
  const now = Date.now();
  const earliestAllowed = now - AI_REQUEST_WINDOW_MS;
  const history = (aiRequestHistory.get(userId) || []).filter(
    (timestamp) => timestamp > earliestAllowed,
  );

  if (history.length >= MAX_AI_REQUESTS_PER_WINDOW) {
    aiRequestHistory.set(userId, history);

    return Math.max(1, Math.ceil((history[0] + AI_REQUEST_WINDOW_MS - now) / 1_000));
  }

  history.push(now);
  aiRequestHistory.set(userId, history);

  return null;
}

app.post("/api/ai/suggestions", async (c) => {
  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: "请先登录账号。" }, 401);
  }

  if (!isSameOriginRequest(c.req.raw)) {
    return c.json({ error: "请从当前便签页面发起 AI 审阅。" }, 403);
  }

  if (!(await isAiAvailable(c.env))) {
    return c.json({ error: "AI 服务当前不可用，请稍后重试。" }, 503);
  }

  const body = await readJsonBody<{ instruction?: unknown; markdown?: unknown }>(
    c.req.raw,
  );
  const markdown = body.markdown;
  const instruction =
    typeof body.instruction === "string" ? body.instruction.trim() : "";

  if (
    typeof markdown !== "string" ||
    !markdown ||
    markdown.length > MAX_AI_MARKDOWN_LENGTH
  ) {
    return c.json({ error: `便签正文须为 1-${MAX_AI_MARKDOWN_LENGTH} 个字符。` }, 400);
  }

  if (!instruction || instruction.length > MAX_AI_INSTRUCTION_LENGTH) {
    return c.json({ error: `审阅要求须为 1-${MAX_AI_INSTRUCTION_LENGTH} 个字符。` }, 400);
  }

  if (activeAiUsers.has(user.id)) {
    return c.json({ error: "已有 AI 审阅正在进行，请稍候。" }, 429);
  }

  const retryAfter = consumeAiRateLimit(user.id);

  if (retryAfter !== null) {
    c.header("Retry-After", retryAfter.toString());

    return c.json({ error: "AI 审阅请求过于频繁，请稍后再试。" }, 429);
  }

  activeAiUsers.add(user.id);

  try {
    c.header("Cache-Control", "no-store");

    return c.json(await createAiSuggestions(c.env, markdown, instruction));
  } catch (error) {
    const code = error instanceof Error ? error.message : "AI_UPSTREAM_ERROR";
    const status =
      code === "AI_TIMEOUT" ? 504 : code === "AI_UNAVAILABLE" ? 503 : 502;

    return c.json(
      {
        error:
          status === 504
            ? "AI 审阅超时，请稍后重试。"
            : status === 503
              ? "AI 服务当前不可用，请稍后重试。"
              : "AI 暂时无法生成有效建议，请稍后重试。",
      },
      status,
    );
  } finally {
    activeAiUsers.delete(user.id);
  }
});

/* -------------------------------------------------------------------------- */
/* 图片                                                                        */
/* -------------------------------------------------------------------------- */

app.get("/images/:filename", async (c) => {
  const image = await readStoredImage(c.env.IMAGES, c.req.param("filename"));

  if (!image) {
    return c.body("Not Found", 404);
  }

  return new Response(image.body, {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": image.contentType,
    },
  });
});

app.post("/api/images/import", async (c) => {
  const baseUrl = getPublicBaseUrl(c.req.raw, c.env);

  try {
    const contentType = c.req.header("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.raw.formData();
      const file = form.get("image");

      if (file instanceof File) {
        if (file.size > MAX_IMAGE_SIZE_BYTES) {
          return c.json(
            {
              error: `图片过大，单张图片不能超过 ${Math.floor(MAX_IMAGE_SIZE_BYTES / 1024 / 1024)}MB。`,
            },
            413,
          );
        }

        return c.json(
          await persistImage(c.env.IMAGES, baseUrl, {
            buffer: new Uint8Array(await file.arrayBuffer()),
            filename: file.name,
            mimeType: file.type,
          }),
        );
      }
    }

    const body = await readJsonBody<{ sourceUrl?: unknown }>(c.req.raw);
    const sourceUrl = resolveSourceUrl(body.sourceUrl);

    if (!sourceUrl) {
      return c.json(
        { error: "请拖入图片文件，或粘贴一个可访问的图片 URL。" },
        400,
      );
    }

    // 命中外部图床白名单：图片本身已公网可达，保留外链原样，不下载也不转存 R2
    if (isImageBedUrl(sourceUrl, c.env.IMAGE_BED_HOSTS)) {
      return c.json({
        extension: inferImageExtension(sourceUrl),
        hash: "",
        path: sourceUrl,
        url: sourceUrl,
      });
    }

    return c.json(
      await persistImage(
        c.env.IMAGES,
        baseUrl,
        await downloadImageFromUrl(sourceUrl),
      ),
    );
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "图片导入失败" },
      400,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 微信公众号配置                                                              */
/* -------------------------------------------------------------------------- */

app.get("/api/wechat/config", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  if (!isSameOriginRequest(c.req.raw)) {
    return c.json({ error: "请从当前便签页面读取公众号配置。" }, 403);
  }

  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: "请先登录账号。" }, 401);
  }

  const configuration = await getStore(c).getWechatConfiguration(user.id);

  return c.json(
    configuration ?? { appId: "", appSecret: "", updatedAt: null },
  );
});

app.put("/api/wechat/config", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  if (!isSameOriginRequest(c.req.raw)) {
    return c.json({ error: "请从当前便签页面保存公众号配置。" }, 403);
  }

  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: "请先登录账号。" }, 401);
  }

  const body = await readJsonBody<{ appId?: unknown; appSecret?: unknown }>(c.req.raw);
  const { appId, appSecret } = body;

  if (typeof appId !== "string" || typeof appSecret !== "string") {
    return c.json({ error: "请输入公众号 AppID 和 AppSecret。" }, 400);
  }

  try {
    const configuration = await getStore(c).saveWechatConfiguration(
      user.id,
      appId,
      appSecret,
    );

    await clearWechatAccessToken(configuration);

    return c.json({
      ...configuration,
      ...(await checkWechatConnection(c.env, configuration, true)),
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "保存公众号配置失败。",
      },
      error instanceof InvalidWechatConfigurationError ? 400 : 500,
    );
  }
});

app.get("/api/wechat/status", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  if (!isSameOriginRequest(c.req.raw)) {
    return c.json({ error: "请从当前便签页面检查公众号连接。" }, 403);
  }

  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: "请先登录账号。" }, 401);
  }

  const configuration = await getStore(c).getWechatConfiguration(user.id);

  return c.json(await checkWechatConnection(c.env, configuration));
});

async function checkWechatConnection(
  env: Env,
  configuration: { appId: string; appSecret: string } | null,
  forceRefresh = false,
): Promise<WechatConnectionStatus> {
  if (!configuration) {
    return {
      checkedAt: null,
      configured: false,
      connected: false,
      connectionError: null,
    };
  }

  try {
    await getWechatAccessToken(env, configuration, forceRefresh);

    return {
      checkedAt: Date.now(),
      configured: true,
      connected: true,
      connectionError: null,
    };
  } catch (error) {
    return {
      checkedAt: Date.now(),
      configured: true,
      connected: false,
      connectionError:
        error instanceof Error ? error.message : "微信公众号连接失败。",
    };
  }
}

/* -------------------------------------------------------------------------- */
/* 复制到公众号                                                                */
/* -------------------------------------------------------------------------- */

app.post("/api/wechat", async (c) => {
  try {
    const body = await readJsonBody<{
      footerBrand?: string;
      footerLogoUrl?: string;
      footerVia?: string;
      markdown?: unknown;
      theme?: unknown;
    }>(c.req.raw);
    const theme = resolveTheme(body);
    const markdown = resolveMarkdown(body);
    const authenticatedUser = await getWorkspaceUser(c);

    return c.json(
      await prepareWechatArticle(c.env, getStore(c), markdown, {
        anonymousDailyUploadLimit: getAnonymousUploadLimit(c.env),
        footer: resolveFooterConfig(body),
        publicBaseUrl: getPublicBaseUrl(c.req.raw, c.env),
        temporaryUploads: !authenticatedUser,
        theme,
      }),
    );
  } catch (error) {
    const { AnonymousQuotaExceededError: QuotaError, QiniuConfigurationError } =
      await import("./auth.js").then(async (auth) => ({
        AnonymousQuotaExceededError: auth.AnonymousQuotaExceededError,
        QiniuConfigurationError: (await import("./qiniu.js")).QiniuConfigurationError,
      }));
    const { QiniuUploadError } = await import("./qiniu.js");
    const status =
      error instanceof UnsupportedExportThemeError
        ? 400
        : error instanceof AnonymousQuotaExceededError || error instanceof QuotaError
          ? 429
          : error instanceof QiniuConfigurationError
            ? 503
            : error instanceof QiniuUploadError
              ? 502
              : 500;

    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to prepare WeChat article",
        hint:
          error instanceof AnonymousQuotaExceededError
            ? `今日额度已使用 ${error.quota.used}/${error.quota.limit} 张，下一次重置时间：${error.quota.resetsAt}`
            : undefined,
      },
      status,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 发布公众号草稿                                                              */
/* -------------------------------------------------------------------------- */

interface DraftImageResolution {
  coverImage: { buffer: Bytes; filename: string; mimeType: string | null } | null;
  html: string;
  imageCount: number;
}

/**
 * 把草稿正文里的占位图片地址替换为微信图片地址。
 *
 * 与原版差异：Workers 无图片编解码能力，不做旋转/缩放/转码，
 * 而是原样上传（GIF 走永久素材，其余走正文图片接口）。
 * 微信对正文图片有 1MB 限制，超限时由微信侧返回明确错误。
 */
async function replaceDraftContentImages(
  c: { env: Env },
  html: string,
  accessToken: string,
  sourceByPlaceholder: Map<string, string>,
  publicBaseUrl: string,
): Promise<DraftImageResolution> {
  const placeholders = collectHtmlImageSources(html);
  let nextHtml = html;
  let imageCount = 0;
  let coverImage: DraftImageResolution["coverImage"] = null;
  const urlByPlaceholder = new Map<string, string>();

  for (const placeholder of placeholders) {
    const source = sourceByPlaceholder.get(placeholder) ?? placeholder;
    const image = await resolveImageSource(c.env, source, publicBaseUrl);

    if (!image?.buffer.length) {
      throw new Error(`无法读取公众号草稿图片：${source}`);
    }

    if (!coverImage) {
      coverImage = {
        buffer: image.buffer,
        filename: image.filename || "cover",
        mimeType: image.mimeType ?? null,
      };
    }

    const extension = detectImageFormat(
      image.buffer,
      image.mimeType,
      image.filename || source,
    );
    const upload = {
      buffer: image.buffer,
      filename: `image.${extension ?? "png"}`,
      mimeType: image.mimeType || "image/png",
    };

    // GIF 动图必须走永久素材，否则会丢失动画
    if (extension === "gif") {
      const permanent = await uploadWechatPermanentImage(c.env, accessToken, {
        ...upload,
        mimeType: "image/gif",
      });

      if (permanent.url) {
        urlByPlaceholder.set(placeholder, permanent.url);
      }
    } else {
      urlByPlaceholder.set(
        placeholder,
        await uploadWechatContentImage(c.env, accessToken, upload),
      );
    }

    imageCount += 1;
  }

  for (const [placeholder, url] of urlByPlaceholder) {
    nextHtml = replaceAll(nextHtml, placeholder, url);
  }

  return { coverImage, html: nextHtml, imageCount };
}

/** 上传草稿封面：优先使用文章首图，否则生成主题色纯色封面。 */
async function uploadDraftCover(
  c: { env: Env },
  accessToken: string,
  theme: NoteCardThemeId,
  coverImage: DraftImageResolution["coverImage"],
): Promise<string> {
  if (coverImage) {
    const extension = detectImageFormat(
      coverImage.buffer,
      coverImage.mimeType,
      coverImage.filename,
    );

    if (extension === "gif") {
      const permanent = await uploadWechatPermanentImage(c.env, accessToken, {
        buffer: coverImage.buffer,
        filename: "cover.gif",
        mimeType: "image/gif",
      });

      return permanent.mediaId;
    }

    const permanent = await uploadWechatPermanentImage(c.env, accessToken, {
      buffer: coverImage.buffer,
      filename: `cover.${extension ?? "png"}`,
      mimeType: coverImage.mimeType || "image/png",
    });

    return permanent.mediaId;
  }

  const color = WECHAT_COVER_COLORS[theme] ?? WECHAT_COVER_COLORS.default;
  const png = await createSolidColorPng(
    WECHAT_COVER_WIDTH,
    WECHAT_COVER_HEIGHT,
    color,
  );
  const permanent = await uploadWechatPermanentImage(c.env, accessToken, {
    buffer: png,
    filename: "cover.png",
    mimeType: "image/png",
  });

  return permanent.mediaId;
}

app.post("/api/wechat/draft", async (c) => {
  if (!isSameOriginRequest(c.req.raw)) {
    return c.json({ error: "请从当前便签页面发布公众号草稿。" }, 403);
  }

  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: "请先登录账号。" }, 401);
  }

  const startedAt = Date.now();
  let stageStartedAt = startedAt;
  const timings: Record<string, number> = {};
  const recordStage = (name: string) => {
    const now = Date.now();
    timings[name] = now - stageStartedAt;
    stageStartedAt = now;
  };

  try {
    const configuration = await getStore(c).getWechatConfiguration(user.id);

    if (!configuration) {
      return c.json(
        { error: "请先在设置中配置并连通当前账号的公众号 AppID 和 AppSecret。" },
        409,
      );
    }

    const body = await readJsonBody<{
      footerBrand?: string;
      footerLogoUrl?: string;
      footerVia?: string;
      markdown?: unknown;
      theme?: unknown;
    }>(c.req.raw);
    const theme = resolveTheme(body);
    const markdown = resolveMarkdown(body);
    const publicBaseUrl = getPublicBaseUrl(c.req.raw, c.env);
    const prepared = prepareWechatDraftArticle(
      c.env,
      markdown,
      resolveFooterConfig(body),
      theme,
    );

    assertWechatDraftContentLimits(prepared.html);
    recordStage("prepare");

    const accessToken = await getWechatAccessToken(c.env, configuration);
    recordStage("token");

    const content = await replaceDraftContentImages(
      c,
      prepared.html,
      accessToken,
      prepared.sourceByPlaceholder,
      publicBaseUrl,
    );

    assertWechatDraftContentLimits(content.html);
    recordStage("images");

    const thumbMediaId = await uploadDraftCover(
      c,
      accessToken,
      theme,
      content.coverImage,
    );
    recordStage("cover");

    const title = getWechatDraftTitle(markdown);
    const mediaId = await addWechatDraft(c.env, accessToken, {
      content: content.html,
      thumbMediaId,
      title,
    });
    recordStage("save");

    c.header(
      "Server-Timing",
      Object.entries({ ...timings, total: Date.now() - startedAt })
        .map(([name, duration]) => `${name};dur=${duration}`)
        .join(", "),
    );

    return c.json({ imageCount: content.imageCount, mediaId, theme, title });
  } catch (error) {
    const status =
      error instanceof UnsupportedExportThemeError
        ? 400
        : error instanceof WechatOfficialApiError
          ? 502
          : 500;

    return c.json(
      { error: error instanceof Error ? error.message : "发布公众号草稿失败。" },
      status,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Hermes / OpenClaw Skill 安装包                                              */
/* -------------------------------------------------------------------------- */

async function getNotesPublicBaseUrl(
  request: Request,
  env: Env,
): Promise<string> {
  const configured = env.NOTES_PUBLIC_BASE_URL?.trim();
  const url = new URL(configured || getPublicBaseUrl(request, env));

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NOTES_PUBLIC_BASE_URL 只支持 HTTP 或 HTTPS 地址。");
  }

  url.hash = "";
  url.pathname = "";
  url.search = "";

  return url.toString().replace(/\/$/, "");
}

function applyHermesHeaders(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Content-Type", "application/zip");
  response.headers.set(
    "Content-Disposition",
    `attachment; filename="${HERMES_DOWNLOAD_FILENAME}"`,
  );

  return response;
}

app.post("/api/hermes-skill/download", async (c) => {
  if (!isSameOriginRequest(c.req.raw)) {
    return c.json({ error: "请从当前便签页面下载 Hermes Skill。" }, 403);
  }

  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: "请先登录账号。" }, 401);
  }

  const token = await createSkillTokenForUser(c, user);

  if (!token) {
    return c.json({ error: "当前账号已不存在，请重新登录。" }, 401);
  }

  try {
    const zip = await buildHermesSkillPackage(
      c.env,
      await getNotesPublicBaseUrl(c.req.raw, c.env),
      token,
    );

    return applyHermesHeaders(
      new Response(zip.buffer as ArrayBuffer, { status: 200 }),
    );
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Hermes Skill 生成失败，请稍后重试。" },
      500,
    );
  }
});

async function respondWithHermesInstallLink(
  c: { req: { raw: Request }; env: Env; json: (body: unknown, status?: number) => Response },
  reset: boolean,
): Promise<Response> {
  if (!isSameOriginRequest(c.req.raw)) {
    return c.json({ error: "请从当前便签页面管理安装链接。" }, 403);
  }

  const user = await getAuthenticatedUser(c);

  if (!user) {
    return c.json({ error: "请先登录账号。" }, 401);
  }

  let publicBaseUrl: string;

  try {
    publicBaseUrl = await getNotesPublicBaseUrl(c.req.raw, c.env);
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Hermes 安装链接生成失败，请检查公开服务地址。",
      },
      500,
    );
  }

  const store = getStore(c);
  const ticket = reset
    ? await store.resetHermesInstallLink(user.id)
    : await store.getOrCreateHermesInstallLink(user.id);

  return c.json({
    installUrl: new URL(
      `/api/hermes-skill/install/${ticket}/${HERMES_DOWNLOAD_FILENAME}`,
      `${publicBaseUrl}/`,
    ).toString(),
  });
}

app.post("/api/hermes-skill/install-link", (c) =>
  respondWithHermesInstallLink(c, false),
);

app.post("/api/hermes-skill/install-link/reset", (c) =>
  respondWithHermesInstallLink(c, true),
);

async function resolveInstallTicketToken(
  c: { env: Env },
  ticket: string,
): Promise<string | null> {
  const ownerId = await getStore(c).getHermesInstallLinkOwner(ticket);

  if (!ownerId) {
    return null;
  }

  const secret = await resolveSessionSecret(c.env);

  if (ownerId === "superadmin") {
    const credentials = getSuperAdminCredentials(c.env);

    return credentials
      ? createSkillToken(secret, c.env, {
          id: "superadmin",
          role: "superadmin",
          username: credentials.username,
        })
      : null;
  }

  const account = await getStore(c).getUserById(ownerId);

  return account
    ? createSkillToken(
        secret,
        c.env,
        { id: account.id, role: "user", username: account.username },
        account.passwordVersion,
        account.skillTokenVersion,
      )
    : null;
}

app.on(["HEAD", "GET"], "/api/hermes-skill/install/:ticket/:filename", async (c) => {
  const token = await resolveInstallTicketToken(c, c.req.param("ticket"));

  if (!token) {
    if (c.req.method === "HEAD") {
      return c.body(null, 410);
    }

    return c.json(
      { error: "安装链接无效或已被重置，请在设置中复制当前链接。" },
      410,
    );
  }

  if (c.req.method === "HEAD") {
    return applyHermesHeaders(new Response(null, { status: 200 }));
  }

  try {
    const zip = await buildHermesSkillPackage(
      c.env,
      await getNotesPublicBaseUrl(c.req.raw, c.env),
      token,
    );

    return applyHermesHeaders(
      new Response(zip.buffer as ArrayBuffer, { status: 200 }),
    );
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Hermes Skill 生成失败，请稍后重试。" },
      500,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 兜底：未匹配的 /api 与 /images 返回 JSON 404                                */
/* -------------------------------------------------------------------------- */

app.all("/api/*", (c) => c.json({ error: "接口不存在。" }, 404));
app.all("/images/*", (c) => c.body("Not Found", 404));

export default app;

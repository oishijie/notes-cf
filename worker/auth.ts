/**
 * 认证、会话签名与 D1 数据访问。
 *
 * 与 Node 版 server/auth.ts 的对应关系：
 * - `NotesDataStore`（JSON 文件 + 单进程写队列）→ `NotesStore`（D1 + 条件写入）
 * - `scrypt` → PBKDF2-SHA256（Workers 不支持 scrypt）
 * - `node:crypto` 的 HMAC / hash → WebCrypto
 *
 * Cookie 名称、令牌格式、错误语义均保持与 Node 版一致，前端无需改动。
 */
import type { NoteWorkspace } from "../src/types/app.js";
import type { D1Database } from "@cloudflare/workers-types";
import { parseNoteWorkspace } from "../src/lib/notes.js";
import {
  base64UrlToBytes,
  base64UrlToString,
  bytesToBase64Url,
  safeStringEqual,
  stringToBase64Url,
  timingSafeEqual,
  utf8Bytes,
} from "./lib/bytes.js";
import {
  DEFAULT_PBKDF2_ITERATIONS,
  derivePasswordHash,
  hmacSha256Base64Url,
  randomBase64Url,
  randomUuid,
} from "./lib/crypto.js";
import { SESSION_DURATION_SECONDS, REMEMBERED_SESSION_DURATION_SECONDS } from "./lib/cookies.js";

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

export type AuthRole = "user" | "superadmin";

export interface AuthUser {
  id: string;
  role: AuthRole;
  username: string;
}

export interface AccountSummary {
  createdAt: number;
  id: string;
  username: string;
}

export interface CreatedAccount extends AccountSummary {
  initialPassword: string;
}

export interface AuthenticatedAccount extends AccountSummary {
  passwordVersion: number;
  skillTokenVersion: number;
}

export interface ResetAccountPassword extends AccountSummary {
  temporaryPassword: string;
}

export interface StoredWorkspace {
  updatedAt: number;
  workspace: NoteWorkspace;
}

export interface WechatConfiguration {
  appId: string;
  appSecret: string;
  updatedAt: number;
}

export interface AnonymousQuotaStatus {
  dateKey: string;
  limit: number;
  remaining: number;
  resetsAt: string;
  used: number;
}

export interface AuthSession extends AuthUser {
  passwordVersion?: number;
  remember: boolean;
}

export interface SkillTokenSession extends AuthSession {
  skillTokenVersion: number;
}

interface SessionPayload extends AuthUser {
  exp: number;
  passwordVersion?: number;
  remember?: boolean;
}

interface SkillTokenPayload extends AuthUser {
  credentialVersion?: string;
  passwordVersion?: number;
  skillTokenVersion: number;
}

interface StoredAccountRow {
  created_at: number;
  id: string;
  normalized_username: string;
  password_hash: string;
  password_salt: string;
  password_version: number;
  skill_token_version: number;
  username: string;
}

/* -------------------------------------------------------------------------- */
/* 错误                                                                        */
/* -------------------------------------------------------------------------- */

function defineError(name: string) {
  return class extends Error {
    constructor(message: string) {
      super(message);
      this.name = name;
    }
  };
}

export class InvalidUsernameError extends defineError("InvalidUsernameError") {}
export class DuplicateUsernameError extends defineError("DuplicateUsernameError") {
  constructor() {
    super("该用户名或邮箱已经存在。");
  }
}
export class InvalidCurrentPasswordError extends defineError(
  "InvalidCurrentPasswordError",
) {
  constructor() {
    super("当前密码错误。");
  }
}
export class InvalidNewPasswordError extends defineError("InvalidNewPasswordError") {}
export class AccountNotFoundError extends defineError("AccountNotFoundError") {
  constructor() {
    super("普通用户不存在。");
  }
}

export class WorkspaceConflictError extends Error {
  readonly updatedAt: number | null;

  constructor(updatedAt: number | null) {
    super("云端工作区已被其他客户端更新，请读取最新版本后重试。");
    this.name = "WorkspaceConflictError";
    this.updatedAt = updatedAt;
  }
}

export class AnonymousQuotaExceededError extends Error {
  readonly quota: AnonymousQuotaStatus;

  constructor(quota: AnonymousQuotaStatus) {
    super(
      `今日匿名图片额度（${quota.limit} 张）已用完，将于北京时间 0 点重置。请联系管理员 zhaoolee@gmail.com 注册账号。`,
    );
    this.name = "AnonymousQuotaExceededError";
    this.quota = quota;
  }
}

export class InvalidWechatConfigurationError extends defineError(
  "InvalidWechatConfigurationError",
) {}

/* -------------------------------------------------------------------------- */
/* 校验                                                                        */
/* -------------------------------------------------------------------------- */

export function validateWechatAppId(appId: string): string {
  const normalized = appId.trim();

  if (!/^wx[0-9a-f]{16}$/i.test(normalized)) {
    throw new InvalidWechatConfigurationError(
      "AppID 应为 wx 开头的 18 位公众号 AppID。",
    );
  }

  return normalized;
}

export function validateWechatAppSecret(appSecret: string): string {
  const normalized = appSecret.trim();

  if (!/^[0-9a-z]{32}$/i.test(normalized)) {
    throw new InvalidWechatConfigurationError(
      "AppSecret 应为 32 位字母或数字。",
    );
  }

  return normalized;
}

export function normalizeUsername(username: string): string {
  return username.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function validateUsername(username: string): string {
  const normalizedDisplayName = username.trim().normalize("NFKC");
  const isUsername = /^[\p{L}\p{N}._-]{3,32}$/u.test(normalizedDisplayName);
  const [emailLocalPart = "", emailDomain = "", ...extraEmailParts] =
    normalizedDisplayName.split("@");
  const isEmail =
    normalizedDisplayName.length <= 254 &&
    emailLocalPart.length > 0 &&
    emailLocalPart.length <= 64 &&
    extraEmailParts.length === 0 &&
    /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(emailLocalPart) &&
    /^(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i.test(
      emailDomain,
    );

  if (!isUsername && !isEmail) {
    throw new InvalidUsernameError(
      "请输入有效邮箱，或 3–32 个字符的用户名（中英文、数字、点、下划线或连字符）。",
    );
  }

  return normalizedDisplayName;
}

export function validateNewPassword(password: string): string {
  if (password.length < 8 || password.length > 128) {
    throw new InvalidNewPasswordError("新密码长度应为 8–128 个字符。");
  }

  return password;
}

export { safeStringEqual };

/* -------------------------------------------------------------------------- */
/* 北京时间日期                                                                */
/* -------------------------------------------------------------------------- */

function getShanghaiDateParts(now: Date): {
  day: number;
  month: number;
  year: number;
} {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  return {
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
  };
}

export function getShanghaiDateKey(now = new Date()): string {
  const { day, month, year } = getShanghaiDateParts(now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getNextShanghaiMidnight(now = new Date()): string {
  const { day, month, year } = getShanghaiDateParts(now);
  return new Date(
    Date.UTC(year, month - 1, day + 1) - 8 * 60 * 60 * 1000,
  ).toISOString();
}

/* -------------------------------------------------------------------------- */
/* 密码哈希                                                                    */
/*                                                                              */
/* 存储格式：pbkdf2-sha256$<迭代次数>$<base64url 派生密钥>                       */
/* 迭代次数随哈希一起保存，因此调整 PBKDF2_ITERATIONS 不会让已有密码失效。      */
/* -------------------------------------------------------------------------- */

const PASSWORD_HASH_PREFIX = "pbkdf2-sha256";

async function hashPassword(
  password: string,
  iterations: number,
): Promise<{ hash: string; salt: string }> {
  const salt = randomBase64Url(16);
  const derived = await derivePasswordHash(password, salt, iterations);

  return {
    hash: `${PASSWORD_HASH_PREFIX}$${iterations}$${bytesToBase64Url(derived)}`,
    salt,
  };
}

async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
): Promise<boolean> {
  const [prefix, rawIterations, encoded] = expectedHash.split("$");

  if (prefix !== PASSWORD_HASH_PREFIX || !encoded) {
    // 旧 Node 版的 scrypt 哈希无法在 Workers 中校验，必须由管理员重置密码。
    return false;
  }

  const iterations = Number.parseInt(rawIterations ?? "", 10);

  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    return false;
  }

  const expected = base64UrlToBytes(encoded);

  if (!expected) {
    return false;
  }

  try {
    const derived = await derivePasswordHash(password, salt, iterations);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

const GENERATED_PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function generateInitialPassword(length = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));

  return Array.from(
    bytes,
    (value) => GENERATED_PASSWORD_ALPHABET[value % GENERATED_PASSWORD_ALPHABET.length],
  ).join("");
}

/* -------------------------------------------------------------------------- */
/* Hermes 安装链接                                                             */
/* -------------------------------------------------------------------------- */

const HERMES_TICKET_PREFIX = "notes_hi_v1";

function createHermesInstallTicket(ownerId: string): string {
  return `${HERMES_TICKET_PREFIX}.${stringToBase64Url(ownerId)}.${randomBase64Url(32)}`;
}

function readHermesInstallTicketOwner(ticket: string): string | null {
  const [prefix, encodedOwnerId, secret, extra] = ticket.split(".");

  if (
    prefix !== HERMES_TICKET_PREFIX ||
    !encodedOwnerId ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret || "") ||
    extra
  ) {
    return null;
  }

  const ownerId = base64UrlToString(encodedOwnerId);

  return ownerId && stringToBase64Url(ownerId) === encodedOwnerId ? ownerId : null;
}

/* -------------------------------------------------------------------------- */
/* D1 数据访问                                                                 */
/* -------------------------------------------------------------------------- */

export interface NotesStoreOptions {
  iterations: number;
}

export class NotesStore {
  constructor(
    private readonly database: D1Database,
    private readonly options: NotesStoreOptions,
  ) {}

  private get iterations(): number {
    return this.options.iterations;
  }

  async listUsers(): Promise<AccountSummary[]> {
    const result = await this.database
      .prepare(
        "SELECT id, username, created_at FROM users ORDER BY created_at DESC",
      )
      .all<{ created_at: number; id: string; username: string }>();

    return (result.results ?? []).map((row) => ({
      createdAt: row.created_at,
      id: row.id,
      username: row.username,
    }));
  }

  async createUser(username: string): Promise<CreatedAccount> {
    const displayUsername = validateUsername(username);
    const normalizedUsername = normalizeUsername(displayUsername);
    const initialPassword = generateInitialPassword();
    const password = await hashPassword(initialPassword, this.iterations);
    const account = {
      createdAt: Date.now(),
      id: randomUuid(),
      normalizedUsername,
      passwordHash: password.hash,
      passwordSalt: password.salt,
      passwordVersion: 1,
      skillTokenVersion: 1,
      username: displayUsername,
    };

    try {
      await this.database
        .prepare(
          `INSERT INTO users (
             id, username, normalized_username, password_hash, password_salt,
             password_version, skill_token_version, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          account.id,
          account.username,
          account.normalizedUsername,
          account.passwordHash,
          account.passwordSalt,
          account.passwordVersion,
          account.skillTokenVersion,
          account.createdAt,
        )
        .run();
    } catch (error) {
      // UNIQUE 约束冲突即用户名重复；D1 把原因写在错误信息里
      if (String(error).includes("UNIQUE")) {
        throw new DuplicateUsernameError();
      }

      throw error;
    }

    return {
      createdAt: account.createdAt,
      id: account.id,
      initialPassword,
      username: account.username,
    };
  }

  private async findAccountByNormalizedUsername(
    normalizedUsername: string,
  ): Promise<StoredAccountRow | null> {
    return this.database
      .prepare("SELECT * FROM users WHERE normalized_username = ?")
      .bind(normalizedUsername)
      .first<StoredAccountRow>();
  }

  private async findAccountById(userId: string): Promise<StoredAccountRow | null> {
    return this.database
      .prepare("SELECT * FROM users WHERE id = ?")
      .bind(userId)
      .first<StoredAccountRow>();
  }

  private toAuthenticatedAccount(row: StoredAccountRow): AuthenticatedAccount {
    return {
      createdAt: row.created_at,
      id: row.id,
      passwordVersion: row.password_version,
      skillTokenVersion: row.skill_token_version,
      username: row.username,
    };
  }

  async authenticateUser(
    username: string,
    password: string,
  ): Promise<AuthenticatedAccount | null> {
    const row = await this.findAccountByNormalizedUsername(
      normalizeUsername(username),
    );

    if (
      !row ||
      !(await verifyPassword(password, row.password_salt, row.password_hash))
    ) {
      return null;
    }

    return this.toAuthenticatedAccount(row);
  }

  async getUserById(userId: string): Promise<AuthenticatedAccount | null> {
    const row = await this.findAccountById(userId);

    return row ? this.toAuthenticatedAccount(row) : null;
  }

  async getOrCreateHermesInstallLink(ownerId: string): Promise<string> {
    const existing = await this.database
      .prepare("SELECT ticket FROM hermes_install_links WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ ticket: string }>();

    if (existing?.ticket) {
      return existing.ticket;
    }

    return this.writeHermesInstallLink(ownerId);
  }

  async resetHermesInstallLink(ownerId: string): Promise<string> {
    return this.writeHermesInstallLink(ownerId);
  }

  private async writeHermesInstallLink(ownerId: string): Promise<string> {
    const ticket = createHermesInstallTicket(ownerId);

    await this.database
      .prepare(
        `INSERT INTO hermes_install_links (owner_id, ticket) VALUES (?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET ticket = excluded.ticket`,
      )
      .bind(ownerId, ticket)
      .run();

    return ticket;
  }

  async revokeHermesInstallLink(ownerId: string): Promise<void> {
    await this.database
      .prepare("DELETE FROM hermes_install_links WHERE owner_id = ?")
      .bind(ownerId)
      .run();
  }

  async getHermesInstallLinkOwner(ticket: string): Promise<string | null> {
    const ownerId = readHermesInstallTicketOwner(ticket);

    if (!ownerId) {
      return null;
    }

    const row = await this.database
      .prepare("SELECT ticket FROM hermes_install_links WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ ticket: string }>();

    return row?.ticket && safeStringEqual(row.ticket, ticket) ? ownerId : null;
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<number> {
    const validatedPassword = validateNewPassword(newPassword);
    const row = await this.findAccountById(userId);

    if (!row) {
      throw new AccountNotFoundError();
    }

    if (
      !(await verifyPassword(currentPassword, row.password_salt, row.password_hash))
    ) {
      throw new InvalidCurrentPasswordError();
    }

    if (
      await verifyPassword(validatedPassword, row.password_salt, row.password_hash)
    ) {
      throw new InvalidNewPasswordError("新密码不能与当前密码相同。");
    }

    const password = await hashPassword(validatedPassword, this.iterations);
    const nextVersion = row.password_version + 1;

    await this.database
      .prepare(
        `UPDATE users
            SET password_hash = ?, password_salt = ?,
                password_version = ?, skill_token_version = skill_token_version + 1
          WHERE id = ?`,
      )
      .bind(password.hash, password.salt, nextVersion, userId)
      .run();

    return nextVersion;
  }

  async resetUserPassword(userId: string): Promise<ResetAccountPassword> {
    const row = await this.findAccountById(userId);

    if (!row) {
      throw new AccountNotFoundError();
    }

    const temporaryPassword = generateInitialPassword();
    const password = await hashPassword(temporaryPassword, this.iterations);

    await this.database
      .prepare(
        `UPDATE users
            SET password_hash = ?, password_salt = ?,
                password_version = password_version + 1,
                skill_token_version = skill_token_version + 1
          WHERE id = ?`,
      )
      .bind(password.hash, password.salt, userId)
      .run();

    return {
      createdAt: row.created_at,
      id: row.id,
      temporaryPassword,
      username: row.username,
    };
  }

  async getWorkspace(userId: string): Promise<StoredWorkspace | null> {
    const row = await this.database
      .prepare("SELECT updated_at, workspace FROM workspaces WHERE user_id = ?")
      .bind(userId)
      .first<{ updated_at: number; workspace: string }>();

    if (!row) {
      return null;
    }

    const workspace = parseNoteWorkspace(row.workspace);

    return workspace ? { updatedAt: row.updated_at, workspace } : null;
  }

  /**
   * 保存云端工作区并执行乐观并发控制。
   *
   * 原版依赖单进程写队列；这里改成「条件写入」：只有当前 updated_at 仍等于
   * 调用方读到的版本时才允许覆盖。D1 的写入本身是串行的，因此该条件判断
   * 不会出现丢更新。
   */
  async saveWorkspace(
    userId: string,
    value: unknown,
    now = Date.now(),
    expectedUpdatedAt?: number | null,
  ): Promise<StoredWorkspace> {
    const serialized = JSON.stringify(value);
    const workspace = parseNoteWorkspace(serialized);

    if (!workspace) {
      throw new Error("云端工作区数据格式无效。");
    }

    const row = await this.database
      .prepare("SELECT updated_at FROM workspaces WHERE user_id = ?")
      .bind(userId)
      .first<{ updated_at: number }>();
    const currentUpdatedAt = row?.updated_at ?? null;

    if (
      expectedUpdatedAt !== undefined &&
      currentUpdatedAt !== expectedUpdatedAt
    ) {
      throw new WorkspaceConflictError(currentUpdatedAt);
    }

    const stored: StoredWorkspace = {
      updatedAt: Math.max(now, (currentUpdatedAt ?? 0) + 1),
      workspace,
    };

    const result = await this.database
      .prepare(
        `INSERT INTO workspaces (user_id, updated_at, workspace) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE
           SET updated_at = excluded.updated_at,
               workspace  = excluded.workspace
         WHERE workspaces.updated_at = ?`,
      )
      .bind(userId, stored.updatedAt, serialized, currentUpdatedAt ?? -1)
      .run();

    if ((result.meta?.changes ?? 0) === 0) {
      // 读到版本与写入之间被其他请求改过
      const latest = await this.database
        .prepare("SELECT updated_at FROM workspaces WHERE user_id = ?")
        .bind(userId)
        .first<{ updated_at: number }>();

      throw new WorkspaceConflictError(latest?.updated_at ?? null);
    }

    return stored;
  }

  async getWechatConfiguration(
    ownerId: string,
  ): Promise<WechatConfiguration | null> {
    const row = await this.database
      .prepare(
        `SELECT app_id, app_secret, updated_at
           FROM wechat_configurations WHERE owner_id = ?`,
      )
      .bind(ownerId)
      .first<{ app_id: string; app_secret: string; updated_at: number }>();

    if (!row) {
      return null;
    }

    try {
      return {
        appId: validateWechatAppId(row.app_id),
        appSecret: validateWechatAppSecret(row.app_secret),
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  async saveWechatConfiguration(
    ownerId: string,
    appId: string,
    appSecret: string,
    now = Date.now(),
  ): Promise<WechatConfiguration> {
    const existing = await this.database
      .prepare(
        "SELECT updated_at FROM wechat_configurations WHERE owner_id = ?",
      )
      .bind(ownerId)
      .first<{ updated_at: number }>();
    const configuration: WechatConfiguration = {
      appId: validateWechatAppId(appId),
      appSecret: validateWechatAppSecret(appSecret),
      updatedAt: Math.max(now, (existing?.updated_at ?? 0) + 1),
    };

    await this.database
      .prepare(
        `INSERT INTO wechat_configurations (owner_id, app_id, app_secret, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE
           SET app_id = excluded.app_id,
               app_secret = excluded.app_secret,
               updated_at = excluded.updated_at`,
      )
      .bind(
        ownerId,
        configuration.appId,
        configuration.appSecret,
        configuration.updatedAt,
      )
      .run();

    return configuration;
  }

  async reserveAnonymousUploads(
    amount: number,
    limit: number,
    now = new Date(),
  ): Promise<AnonymousQuotaStatus> {
    const dateKey = getShanghaiDateKey(now);
    const row = await this.database
      .prepare("SELECT count, date_key FROM anonymous_upload_quota WHERE id = 1")
      .first<{ count: number; date_key: string }>();
    const currentCount = row?.date_key === dateKey ? row.count : 0;
    const nextCount = currentCount + amount;
    const status: AnonymousQuotaStatus = {
      dateKey,
      limit,
      remaining: Math.max(0, limit - currentCount),
      resetsAt: getNextShanghaiMidnight(now),
      used: currentCount,
    };

    if (nextCount > limit) {
      throw new AnonymousQuotaExceededError(status);
    }

    await this.database
      .prepare(
        `INSERT INTO anonymous_upload_quota (id, count, date_key) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET count = ?, date_key = ?`,
      )
      .bind(nextCount, dateKey, nextCount, dateKey)
      .run();

    return { ...status, remaining: Math.max(0, limit - nextCount), used: nextCount };
  }
}

/* -------------------------------------------------------------------------- */
/* 会话签名                                                                    */
/* -------------------------------------------------------------------------- */

const SKILL_TOKEN_PREFIX = "notes_sk_v1";

/**
 * 由 isolate 内缓存的随机密钥兜底。
 *
 * 只有在既没有 SESSION_SECRET、也没有配置 SUPERADMIN 时才会用到；此时
 * isolate 回收后旧会话会失效。生产环境必须配置 SESSION_SECRET。
 *
 * 注意：不能在模块顶层直接生成 —— Cloudflare Workers 禁止在 global scope
 * 调用 crypto.getRandomValues()，否则部署阶段会报错 10021
 * （Disallowed operation called within global scope）。因此改为首次使用时
 * 惰性生成，并在 isolate 生命周期内缓存。
 */
let cachedRuntimeSessionSecret: string | null = null;

function getRuntimeSessionSecret(): string {
  if (cachedRuntimeSessionSecret === null) {
    cachedRuntimeSessionSecret = randomBase64Url(32);
  }

  return cachedRuntimeSessionSecret;
}

export interface SessionSecretSource {
  SESSION_SECRET?: string;
  SUPERADMIN?: string;
  SUPERADMINPASSWORD?: string;
}

export async function resolveSessionSecret(
  env: SessionSecretSource,
): Promise<string> {
  const configuredSecret = env.SESSION_SECRET?.trim();

  if (configuredSecret) {
    return configuredSecret;
  }

  const adminUsername = env.SUPERADMIN?.trim() || "";
  const adminPassword = env.SUPERADMINPASSWORD?.trim() || "";

  if (adminUsername && adminPassword) {
    const fallback = [adminUsername, adminPassword, "smartisan-notes-session-v1"].join(":");
    const { sha256Bytes } = await import("./lib/crypto.js");
    return bytesToBase64Url(await sha256Bytes(utf8Bytes(fallback)));
  }

  return getRuntimeSessionSecret();
}

export async function createSessionToken(
  secret: string,
  user: AuthUser,
  remember: boolean,
  now = Date.now(),
  passwordVersion?: number,
): Promise<string> {
  const duration = remember
    ? REMEMBERED_SESSION_DURATION_SECONDS
    : SESSION_DURATION_SECONDS;
  const payload: SessionPayload = {
    ...user,
    exp: Math.floor(now / 1000) + duration,
    passwordVersion,
    remember,
  };
  const encodedPayload = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256Base64Url(secret, encodedPayload);

  return `${encodedPayload}.${signature}`;
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): Promise<AuthSession | null> {
  if (!token) {
    return null;
  }

  const [encodedPayload, providedSignature, extra] = token.split(".");

  if (!encodedPayload || !providedSignature || extra) {
    return null;
  }

  const expectedSignature = await hmacSha256Base64Url(secret, encodedPayload);

  if (!safeStringEqual(providedSignature, expectedSignature)) {
    return null;
  }

  const decoded = base64UrlToString(encodedPayload);

  if (!decoded) {
    return null;
  }

  try {
    const payload = JSON.parse(decoded) as Partial<SessionPayload>;

    if (
      typeof payload.id !== "string" ||
      !payload.id ||
      typeof payload.username !== "string" ||
      !payload.username ||
      (payload.role !== "user" && payload.role !== "superadmin") ||
      typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(now / 1000)
    ) {
      return null;
    }

    return {
      id: payload.id,
      passwordVersion:
        typeof payload.passwordVersion === "number" &&
        Number.isInteger(payload.passwordVersion) &&
        payload.passwordVersion >= 1
          ? payload.passwordVersion
          : undefined,
      remember: payload.remember === true,
      role: payload.role,
      username: payload.username,
    };
  } catch {
    return null;
  }
}

async function getSuperAdminSkillCredentialVersion(
  secret: string,
  env: SessionSecretSource,
  username: string,
): Promise<string | null> {
  const adminUsername = env.SUPERADMIN?.trim();
  const adminPassword = env.SUPERADMINPASSWORD?.trim();

  if (
    !adminUsername ||
    !adminPassword ||
    normalizeUsername(username) !== normalizeUsername(adminUsername)
  ) {
    return null;
  }

  return hmacSha256Base64Url(
    secret,
    [
      "smartisan-notes-skill-superadmin-v1",
      normalizeUsername(adminUsername),
      adminPassword,
    ].join(":"),
  );
}

export async function createSkillToken(
  secret: string,
  env: SessionSecretSource,
  user: AuthUser,
  passwordVersion?: number,
  skillTokenVersion = 1,
): Promise<string> {
  const payload: SkillTokenPayload = {
    id: user.id,
    role: user.role,
    skillTokenVersion,
    username: user.username,
    ...(user.role === "user"
      ? { passwordVersion }
      : {
          credentialVersion:
            (await getSuperAdminSkillCredentialVersion(secret, env, user.username)) ??
            undefined,
        }),
  };
  const encodedPayload = stringToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256Base64Url(
    secret,
    `${SKILL_TOKEN_PREFIX}.${encodedPayload}`,
  );

  return `${SKILL_TOKEN_PREFIX}.${encodedPayload}.${signature}`;
}

export async function verifySkillToken(
  secret: string,
  env: SessionSecretSource,
  token: string | undefined,
): Promise<SkillTokenSession | null> {
  if (!token) {
    return null;
  }

  const [prefix, encodedPayload, providedSignature, extra] = token.split(".");

  if (
    prefix !== SKILL_TOKEN_PREFIX ||
    !encodedPayload ||
    !providedSignature ||
    extra
  ) {
    return null;
  }

  const expectedSignature = await hmacSha256Base64Url(
    secret,
    `${prefix}.${encodedPayload}`,
  );

  if (!safeStringEqual(providedSignature, expectedSignature)) {
    return null;
  }

  const decoded = base64UrlToString(encodedPayload);

  if (!decoded) {
    return null;
  }

  try {
    const payload = JSON.parse(decoded) as Partial<SkillTokenPayload>;
    const validTokenVersion =
      typeof payload.skillTokenVersion === "number" &&
      Number.isInteger(payload.skillTokenVersion) &&
      payload.skillTokenVersion >= 1;

    if (
      typeof payload.id !== "string" ||
      !payload.id ||
      typeof payload.username !== "string" ||
      !payload.username ||
      (payload.role !== "user" && payload.role !== "superadmin") ||
      !validTokenVersion
    ) {
      return null;
    }

    if (payload.role === "superadmin") {
      const currentCredentialVersion = await getSuperAdminSkillCredentialVersion(
        secret,
        env,
        payload.username,
      );

      if (
        !currentCredentialVersion ||
        typeof payload.credentialVersion !== "string" ||
        !safeStringEqual(payload.credentialVersion, currentCredentialVersion)
      ) {
        return null;
      }
    } else if (
      typeof payload.passwordVersion !== "number" ||
      !Number.isInteger(payload.passwordVersion) ||
      payload.passwordVersion < 1
    ) {
      return null;
    }

    return {
      id: payload.id,
      passwordVersion: payload.passwordVersion,
      remember: false,
      role: payload.role,
      skillTokenVersion: payload.skillTokenVersion!,
      username: payload.username,
    };
  } catch {
    return null;
  }
}

export function resolvePbkdf2Iterations(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);

  if (!Number.isSafeInteger(parsed) || parsed < 1000) {
    return DEFAULT_PBKDF2_ITERATIONS;
  }

  return parsed;
}

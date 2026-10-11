/**
 * Cloudflare Workers 运行时绑定与环境变量。
 *
 * 机密（SESSION_SECRET / SUPERADMIN / SUPERADMINPASSWORD / QINIU_* / OPENAI_*）
 * 一律通过 `wrangler secret put` 注入，不写入 wrangler.toml。
 */

/**
 * 这里刻意使用「命名导入」而不是 tsconfig 的 `types` 数组：
 * `@cloudflare/workers-types` 的全局声明与 DOM lib 存在同名接口合并
 * （最典型的是 HTMLRewriter 的 `Element.append` 覆盖了 DOM 的
 * `Element.append`），会让前端组件的 `.append(element)` 调用报类型错误。
 * Worker 与前端共用一套 tsconfig 时，命名导入是唯一干净的共存方式。
 */
import type { D1Database, Fetcher, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  /** 静态资源绑定，指向 Vite 构建产物 dist/ */
  ASSETS: Fetcher;
  /** D1 数据库：账号、工作区、公众号配置、匿名额度 */
  DB: D1Database;
  /** R2 存储桶：图片与导出结果 */
  IMAGES: R2Bucket;

  // ---- 会话与管理员 ----
  SUPERADMIN?: string;
  SUPERADMINPASSWORD?: string;
  SESSION_SECRET?: string;

  // ---- 匿名额度 ----
  ANONYMOUS_DAILY_UPLOAD_LIMIT?: string;

  // ---- 外部图床白名单 ----
  /**
   * 逗号分隔的主机名列表。命中该白名单的图片地址会被「原样保留为外链」，
   * 不再下载转存到 R2（例如自建图床 `imgbed.example.com`）。
   * 留空时所有远程图片仍按原行为转存 R2。
   */
  IMAGE_BED_HOSTS?: string;

  // ---- 七牛图床（公众号正文图片） ----
  QINIU_ACCESS_KEY?: string;
  QINIU_SECRET_KEY?: string;
  QINIU_BUCKET?: string;
  QINIU_DOMAIN?: string;
  QINIU_PREFIX?: string;
  QINIU_UPLOAD_URL?: string;
  QINIU_UPLOAD_TIMEOUT_MS?: string;

  // ---- AI 辅助审阅 ----
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;

  // ---- 微信公众号 ----
  WECHAT_API_BASE_URL?: string;
  WECHAT_FOOTER_HAMMER_URL?: string;

  // ---- 站点地址 ----
  NOTES_PUBLIC_BASE_URL?: string;

  // ---- 密码哈希 ----
  /**
   * PBKDF2-SHA256 迭代次数。Workers 免费版单请求 CPU 预算只有 10ms，
   * 而 Node 版原本使用的 scrypt 在 Workers 中不可用，故改用 PBKDF2。
   * 10000 次约 5–12ms，是免费额度下能承受的上限附近。
   */
  PBKDF2_ITERATIONS?: string;
}

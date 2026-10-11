# 部署到生产

生产环境运行在 Cloudflare Workers（单 Worker + D1 + R2），不需要服务器、容器或
反向代理。前端导出（PNG 长图、离线归档、工作区 ZIP）全部在浏览器端完成，服务端
只负责 `/api/*` 与 `/images/*`。

> 本项目不使用 GitHub Actions 做部署或 CI。全部步骤在本地或可信环境手工执行。

## 更新日志规范

任何用户可感知的功能、行为、兼容性或安全性变化，都必须同步维护项目根目录的
`CHANGELOG.md`。纯内部重构、测试和构建调整无需单独记录。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本；
用户可通过 `/changelog` 查看该文件渲染后的独立页面。

固定使用以下 Markdown 层级；方括号属于格式的一部分：

```md
# 更新日志

## [未发布]

### 新增

- 用户可感知的结果。

## [1.2.3] - 2026-08-02

### 修复

- 用户可感知的结果。

[未发布]: https://github.com/<owner>/<repo>/compare/1.2.3...HEAD
[1.2.3]: https://github.com/<owner>/<repo>/compare/1.2.2...1.2.3
```

1. 开发期间把值得用户关注的变更写入置顶的 `[未发布]` 区域，不要直接粘贴 Git commit 列表。
2. 仅使用实际需要的三级分类：`新增`、`变更`、`弃用`、`移除`、`修复`、`安全`；不要保留空分类。
3. 同一分类内每项变更使用一条 Markdown 列表，描述用户可感知的结果，而不是实现细节。
4. 正式发布时，把 `[未发布]` 内容移动到 `[版本号] - YYYY-MM-DD` 标题下；日期必须使用 ISO 8601 格式，版本号必须与 `package.json` 根节点以及本次 Git tag 一致。
5. 版本按时间倒序排列；仓库具备浏览器可访问的 tag 比较地址时，在文件底部维护 `[未发布]` 和各版本的比较链接。
6. `[未发布]` 只允许存在于开发中的源码。发布提交必须将其内容归档到本次版本并删除该标题；线上 `/changelog` 的第一个二级标题必须是本次发布版本和日期，不能显示空的或包含已发布内容的 `[未发布]` 区域。
7. 发布前必须检查：没有空分类，版本文件与 tag 一致，`/changelog` 返回 HTTP 200，且页面第一个二级标题与本次发布版本及日期一致。


## 1. 发布前检查

阅读 `DOCS`，确认本次变更与架构、账号、D1 表结构和匿名额度兼容。选择并记录精确的
版本标签或 commit SHA，不要只记录 `main`、`dev` 等可移动引用。

在可信构建环境运行：

```bash
npm install
npm test
npm run typecheck
npm run build
git status --short
git rev-parse HEAD
```

`npm run build` 已包含 typecheck。任一步失败，或工作区存在不属于本次发布的修改，
都应停止部署。

确认变更范围后，将本次发布提交并推送；使用版本标签时也要推送标签。确认远端已包含
准备部署的 commit SHA。

## 2. 准备 Cloudflare 资源

首次部署才需要执行（之后跳过）：

```bash
# 1) 建 D1 数据库：把输出的 database_id 填进 wrangler.toml 的 [[d1_databases]]
npx wrangler d1 create notes-db

# 2) 建 R2 存储桶（名字要与 wrangler.toml 的 [[r2_buckets]] 一致）
npx wrangler r2 bucket create notes-images

# 3) 在远端 D1 建表
npm run db:remote
```

检查密钥是否齐全（`npx wrangler secret list` 只列出名字，不显示值）：

- `SESSION_SECRET`：独立、高熵、非空
- `SUPERADMIN`、`SUPERADMINPASSWORD`
- 使用公众号图片功能时所需的 `QINIU_*`
- 使用 AI 审阅时所需的 `OPENAI_*`

写入方式：

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put SUPERADMIN
npx wrangler secret put SUPERADMINPASSWORD
```

非机密变量（`ANONYMOUS_DAILY_UPLOAD_LIMIT`、`NOTES_PUBLIC_BASE_URL`、
`WECHAT_FOOTER_HAMMER_URL` 等）写在 `wrangler.toml` 的 `[vars]`。变量不能使用
`VITE_` 前缀。Secret 不得写入仓库、日志、报告或 `MEMORY`。

准备阶段的 R2 备份策略见 `DOCS/backup-and-disaster-recovery.md`。

## 3. 部署

```bash
npm run deploy  # typecheck + vite build + wrangler deploy
curl -fsS https://<你的域名>/api/health
```

`wrangler deploy` 是原子切换，失败不会影响正在服务的版本；不需要「先下线」。

> Cloudflare 免费版单次请求 CPU 预算只有 10ms。`PBKDF2_ITERATIONS` 默认 10000，
> 已接近上限；不要为了「更安全」盲目调高，否则登录会因超时被 Workers 中断。

## 4. 上线验证

依次确认：

1. `curl -fsS https://<域名>/api/health` 返回 `{"ok":true}`。
2. 配置 AI 时，`/api/ai/status` 返回 `{"available":true}`，且日志不泄露密钥。
3. 桌面和手机页面能加载，匿名编辑与刷新正常。
4. 导入图片后可在 `/images/<hash>.<ext>` 访问（内容存 R2）。
5. 导出功能全部可用（这三条链路已改为纯浏览器端，不经过服务端）：
   PNG 长图、单便签离线归档、整体工作区 ZIP。
6. `/superadmin`、专用测试用户登录和云工作区同步正常。
7. 写入一张便签后重新加载，内容仍在（D1 持久化）。
8. 配置七牛时，“复制到公众号”的匿名额度、登录用户长期对象和公网图片均正常。
9. HTTPS 下登录 Cookie 包含 `Secure`。

任一关键检查失败都应停止发布或执行回滚。验证时不要破坏真实用户数据。

## 5. 回滚

```bash
npx wrangler rollback            # 回退到上一个 Worker 版本
```

D1 与 R2 的数据不随 Worker 版本回滚而回滚——若本次发布包含表结构变更，需按
`DOCS/backup-and-disaster-recovery.md` 单独处理。

只有应用回滚无效且确认必须恢复数据时，才可使用准备阶段的备份。恢复前再次备份当前
线上数据，并取得明确授权。

## 6. 发布报告

汇报：

- Git commit、版本标签
- Worker 版本 / 部署 ID（`npx wrangler deployments list`）
- `.dev.vars` 或 Secret 是否配置完整，但不报告任何值
- 涉及的 D1 数据库与 R2 存储桶名称及其备份位置
- 测试、类型检查、构建、健康检查和上线验证结果
- 未执行的检查、遗留问题和可用回滚版本

只把经验证且长期有效的信息更新到 `MEMORY`。

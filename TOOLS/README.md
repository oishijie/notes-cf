# 可用工具

本目录记录智能体和开发者在仓库内可直接使用的工具与命令。执行前先阅读 `DOCS`，执行后运行 feedback 测试。

> **包管理器说明**：本机（Windows）全局 npm 安装已损坏，执行 `npm install` 会报
> `Cannot find module './cache/policy.js'`。此时把下文所有 `npm run <script>`
> 换成 `pnpm run <script>`、`npm install` 换成 `pnpm install` 即可。
> ⚠️ pnpm 下**必须**写 `pnpm run deploy`，直接敲 `pnpm deploy` 会被解析成 pnpm
> 内置的同名命令而不是本项目的 script。

## Node.js

```bash
npm install
npm run dev
npm run dev:frontend
npm run dev:worker
npm run typecheck
npm run build
```

`npm run dev` 会同时启动 `wrangler dev`（`127.0.0.1:8787`）与 Vite
（`127.0.0.1:15173`）；Vite 会把 `/api` 与 `/images` 代理到 8787。
只有在需要分别调试时，才单独运行 `npm run dev:frontend` 或 `npm run dev:worker`。

## Feedback 测试

```bash
npm test
```

测试位于 `frontend/tests`。

## 正文输入延迟 Benchmark

运行真实 Chromium，在便签正文编辑器中逐字符输入，统计每次 `keydown` 到浏览器
下一次绘制机会的 p50、p95、p99、最大值和平均值：

```bash
npm run benchmark:input
```

默认会在 `127.0.0.1:15173` 不可用时临时启动前端，使用 2000 字符的初始正文、
20 次预热和 200 次正式输入。指定已运行页面、移动端视口或性能回归阈值：

```bash
npm run benchmark:input -- --url http://127.0.0.1:15173 --mobile
npm run benchmark:input -- --characters 500 --interval 8 --max-p95 50
npm run benchmark:input -- --json
```

`--max-p95` 失败时命令以状态码 `2` 退出；完整选项使用
`npm run benchmark:input -- --help` 查看（该帮助不依赖 playwright）。
benchmark 使用隔离的浏览器上下文与测试工作区，不会读写日常浏览器中的便签。

> playwright 已不再是项目依赖（服务端的 PNG 渲染已下沉到浏览器端）。
> 需要跑 benchmark 时先安装：
> `npm install -D playwright && npx playwright install chromium`。

## 本地环境准备

```bash
npm install       # 首次：安装依赖
npm run db:local  # 首次：初始化本地 D1，缺表会让接口返回 500
npm run dev       # wrangler dev(8787) + Vite(15173)
```

本地机密写在 `.dev.vars`（`wrangler dev` 会自动加载，格式参考 `.env.example`），
该文件已被 `.gitignore` 忽略，不会提交。

## 部署到 Cloudflare Workers

首次部署前先创建资源，并把 D1 的 `database_id` 填进 `wrangler.toml`：

```bash
npx wrangler d1 create notes-db
npx wrangler r2 bucket create notes-images
```

然后写入机密并发布：

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put SUPERADMIN
npx wrangler secret put SUPERADMINPASSWORD
npm run db:remote   # 在远端 D1 建表
npm run deploy      # 类型检查 + 构建 + wrangler deploy
```

线上机密一律用 `npx wrangler secret put <NAME>` 注入，不要写进 `wrangler.toml`。

## 健康检查

```bash
curl -fsS http://127.0.0.1:8787/api/health
```

## 微信公众号富文本与七牛图床

七牛配置通过 Worker 的环境绑定提供：本地写在 `.dev.vars`（`wrangler dev` 会自动
加载，格式参考 `.env.example`），线上用 `wrangler secret put` 注入。Workers 没有
文件系统，因此不再读取本机的 `qiniu.json`。

生产环境需要以下变量，不要将真实密钥写入仓库：

```bash
npx wrangler secret put QINIU_ACCESS_KEY
npx wrangler secret put QINIU_SECRET_KEY
# QINIU_BUCKET / QINIU_DOMAIN / QINIU_PREFIX / QINIU_UPLOAD_TIMEOUT_MS
# 属非机密配置，可写在 wrangler.toml 的 [vars] 中
```

上传链路不再使用七牛官方 Node SDK（它依赖 Node 的 http 栈），改为直接构造表单
上传请求（`POST multipart/form-data`，字段 token / key / file），签名用 HMAC-SHA1。
默认上传域名为 `https://upload.qiniup.com`；私有网关可用 `QINIU_UPLOAD_URL` 指定，
`QINIU_UPLOAD_URLS` 可传入逗号分隔的多个同协议节点。单节点超时允许配置为 10000 到
300000 毫秒。

开发环境可以直接检查富文本生成接口：

```bash
curl -fsS http://127.0.0.1:8787/api/wechat \
  -H 'Content-Type: application/json' \
  --data '{"markdown":"[公众号标题]\n\n正文包含 **粗体**。","theme":"bear"}'
```

`theme` 可为 `default`、`smartisan-dark`、`apple-notes`、`apple-notes-light` 或
`bear`；省略时兼容性回退为 `default`。接口返回实际采用的 `theme`、`html`、替换
图片后的 `markdown`、图片总数和上传/复用计数。真实使用
时从桌面分享预览或手机分享面板点击“复制到公众号”，再粘贴进公众号编辑器。

## 便签导出 Skill

```bash
skills/notes-export-api/scripts/export_note.sh \
  --base-url http://127.0.0.1:8787 \
  --markdown-file /absolute/path/to/note.md \
  --output /absolute/path/to/note.png
```

> ⚠️ 该 Skill 依赖的 `POST /api/export` 已在 Cloudflare Workers 版本中**移除**
> （Workers 无法运行 Playwright 做服务端截图），指向本部署会返回 404。
> 同目录下的 `notes-workspace-api`（由 `/api/hermes-skill/download` 生成的 Skill 包）
> 不受影响。

详细参数见 `skills/notes-export-api/SKILL.md`。

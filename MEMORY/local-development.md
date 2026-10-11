# 本地开发运维事实

## 2026-10-11：切换到 Cloudflare Workers 本地运行时

- 项目已从 Docker / Express 迁移到 Cloudflare Workers，旧的 `Dockerfile.*`、
  `docker-compose*.yml`、`server/`、`backend/tests/` 已**全部删除**（先移入临时备份
  目录 `.cf-migration-backup/`，随后连同该目录一并清理），仓库内已无旧架构残留。
- `npm run dev` 现在由 `scripts/dev.mjs` 同时管理 `wrangler dev`（默认 8787）与
  Vite（默认 15173）。Vite 的 `/api` 与 `/images` 代理目标已改为 8787。
- 首次本地开发前必须先执行 `npm run db:local` 初始化本地 D1，否则接口会因缺表失败。
- 本地机密写在 `.dev.vars`（已被忽略），格式参考 `.env.example`。**线上机密一律用
  `wrangler secret put` 写入，不要用 `.env`。**

## 2026-10-11：本机包管理器注意事项

- 本机全局 npm 安装已损坏：执行 `npm install` 会报
  `Cannot find module './cache/policy.js'`（`make-fetch-happen` 缺文件）。
  装依赖请用 **pnpm**（本机位于 `D:\Development\Node.js\pnpm`，版本 11.x）。
- pnpm 10+ 默认拦截依赖的构建脚本。本项目已在 `pnpm-workspace.yaml` 的
  `allowBuilds` 中放行 `esbuild` 与 `workerd`（注意：pnpm 11 起不再读取
  `package.json` 里的 `pnpm.onlyBuiltDependencies`，写了也会被忽略并自动生成
  占位文件）；
  缺少这一步会导致 `wrangler dev` 无法启动（workerd 二进制未下载）。
- `@cloudflare/workerd-windows-64` 约 40–60MB，走 npmmirror 容易超时。
  安装超时请加大超时并重试：
  `pnpm install --fetch-timeout 900000 --fetch-retries 5`。

- 部署与线上资源（2026-10-11 已上线）：Worker `notes` →
  `https://notes.cro.cc.cd`（自定义域名）；D1 `notes-db`
  （`deee573b-294c-49d6-9470-d41466de4d91`）；R2 `notes-images`。
  部署命令 `node node_modules/wrangler/bin/wrangler.js deploy`。
  注意：`wrangler.toml` 一旦写了 `routes`，wrangler 会自动关闭 `*.workers.dev`
  入口，需 `workers_dev = true` 才能同时保留。
- ⚠️ Workers 禁止在**模块顶层**执行随机数 / I-O / 定时器。`worker/auth.ts` 曾因
  顶层 `randomBase64Url(32)` 导致部署报 `10021 Disallowed operation called within
  global scope`，现改为函数内惰性求值。新增模块级常量时务必注意。

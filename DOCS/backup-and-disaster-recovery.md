# 备份与灾难恢复方案（Cloudflare Workers 版）

## 1. 目标与结论

本方案面向以下故障：D1 数据被误删或误改、R2 图片丢失、Worker 代码错误发布、
管理员账号被盗、第三方服务配置（七牛 / 微信 / OpenAI）丢失。

推荐三条链路：

1. **D1 Time Travel**：Cloudflare 内置的时间点恢复，应对误删与误改。这是第一道
   防线，不需要额外建设。
2. **手工导出到仓库之外**：`wrangler d1 export` 产出 SQL 快照；用任意 S3 兼容
   客户端同步 R2 图片桶，用于跨账号/跨服务商留档。
3. **发布前快照**：每次正式发布前导出一份 D1 + R2 快照，与精确的 Git commit SHA
   绑定。

建议的首期恢复指标：

- RPO（最多丢失的数据）：自动链路 24 小时；发布前手工快照接近 0。
- RTO（恢复服务时间）：Time Travel 回滚 30 分钟内；从 SQL 快照重建 2 小时内。
- 保留：Time Travel 依赖平台自身的保留窗口；手工快照按「最近 10 次正式发布」保留。

> 各能力的具体保留天数与计费归属以 Cloudflare 控制台与官方文档为准，本文件不
> 做承诺。首次完整恢复演练后应按实测结果修订上述指标。

## 2. 当前系统的数据边界

### 2.1 必须备份的核心数据

| 内容 | 当前位置 | 恢复价值 |
| --- | --- | --- |
| 账号（含密码哈希与版本号） | D1 `users` | 高：丢失后所有用户无法登录 |
| 云工作区 | D1 `workspaces` | 最高：用户内容本体 |
| 公众号配置 | D1 `wechat_configurations` | 中：可重新填写 |
| Hermes 安装链接 | D1 `hermes_install_links` | 低 |
| 匿名上传额度 | D1 `anonymous_upload_quota` | 低：丢失只影响当天限流 |
| 图片对象 | R2 `IMAGES` 桶 | 高：用户上传的图片 |
| 表结构 | `schema.sql`（仓库内） | 必须：重建 D1 的前提 |

密码哈希为 PBKDF2-SHA256（Workers 不提供 Node 的 `scrypt`），格式为
`pbkdf2-sha256$<iterations>$<base64url>`，随 `users` 表一并备份即可。

### 2.2 不需要备份的内容

- 前端构建产物（`dist/`）：由 `npm run build` 从源码重建。
- Worker 代码：就是 Git 仓库内容。
- PNG 长图、离线归档 ZIP、工作区导出包：**已改为浏览器端生成，服务端不再留存
  任何副本**，因此没有可备份的文件，也没有需要清理生命周期的导出目录。
- 会话 Cookie：由 `SESSION_SECRET` 派生，重新登录即可。

### 2.3 服务端无法覆盖的数据

- 用户浏览器里的本地草稿（尚未同步到云工作区的部分）。
- 微信公众号后台已发布的文章。
- 七牛图床中已上传的对象（需在七牛侧单独备份）。

## 3. 备份方式

### 3.1 D1：Time Travel（首选，用于误删误改）

```bash
npx wrangler d1 time-travel info notes-db
npx wrangler d1 time-travel restore notes-db --timestamp=<ISO8601>
```

### 3.2 D1：导出 SQL 快照（用于跨账号留档）

```bash
npx wrangler d1 export notes-db --remote --output=backup-$(date +%Y%m%d).sql
```

### 3.3 R2：S3 兼容同步

R2 兼容 S3 API，可用任意 S3 客户端同步图片桶。需要先在 Cloudflare 控制台创建
R2 API Token 取得 S3 凭据：

```bash
rclone sync r2:notes-images /path/to/offline/notes-images

# 或直接用 aws cli
aws s3 sync s3://notes-images /path/to/offline/notes-images \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com
```

### 3.4 发布前快照清单

每次正式发布前，把以下内容放进同一个目录（目录名含 tag 与 commit SHA）：

```
release-<tag>-<sha>/
  schema.sql             # 从仓库复制
  d1-backup.sql          # wrangler d1 export 产物
  r2-manifest.txt        # rclone ls 输出，用于校验完整性
  wrangler.toml          # 记录 binding 与 vars（不含 secret 值）
  secrets-list.txt       # npx wrangler secret list 的名字清单
  CHANGELOG-section.md   # 本次版本的变更说明
```

Secret 的**值**永远不进入快照。

## 4. 恢复流程

### 4.1 D1 误删 / 误改 → Time Travel

优先使用。选一个早于故障发生的时间点：

```bash
npx wrangler d1 time-travel info notes-db
npx wrangler d1 time-travel restore notes-db --timestamp=2026-10-11T03:00:00Z
```

### 4.2 D1 完全重建（库被删除）

```bash
npx wrangler d1 create notes-db            # 把新 database_id 填进 wrangler.toml
npx wrangler d1 execute notes-db --remote --file=./schema.sql
npx wrangler d1 execute notes-db --remote --file=./backup-YYYYMMDD.sql
```

### 4.3 R2 恢复

```bash
rclone sync /path/to/offline/notes-images r2:notes-images
```

恢复后抽查 `/images/<hash>.<ext>` 是否可访问。

### 4.4 Worker 代码回退

```bash
npx wrangler rollback                      # 回退到上一个 Worker 版本

# 或从 Git 检出目标 commit 后重新部署
git checkout --detach <tag-or-sha>
npm run deploy
```

注意：Worker 版本回滚**不会**回滚 D1 与 R2 的数据。

## 5. 校验与恢复演练

1. 在独立的 Development 环境（另建一套 D1 + R2）执行一次完整恢复。
2. 恢复后跑一遍上线验证清单（见 `PROMPTS/deploy-to-production.md` 第 4 节）。
3. 记录实测 RPO / RTO，并按结果修订本文件第 1 节的指标。

## 6. 分阶段实施建议

### 阶段一：可验证的手工备份（现在即可做）

- 每次发布前手工执行「3.4 发布前快照清单」。
- 熟记 `wrangler d1 time-travel` 的用法，出问题第一时间用它而不是重建。

### 阶段二：脚本化与异地

- 把导出与同步写成脚本，加时间戳与校验和。
- 把快照存到第二个 Cloudflare 账号或另一个对象存储，实现异地冗余。

### 阶段三：防篡改与规模化

- 评估 R2 的对象锁 / 保留策略，避免备份被同一把凭据误删。
- 建立定期恢复演练表，把演练纳入发布流程。

## 7. 验收标准

- 能从 Time Travel 恢复 24 小时内的任意时间点。
- 能用 SQL 快照在空 D1 上重建出可登录、可同步工作区的环境。
- 能重建 R2 图片桶，且既有图片的 `/images/<hash>.<ext>` 全部可访问。
- 恢复演练记录中，实测 RPO / RTO 不超过第 1 节的指标。

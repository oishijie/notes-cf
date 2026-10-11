-- 开源版锤子便签 —— D1 数据库结构
--
-- 应用方式：
--   本地：npx wrangler d1 execute notes-db --local  --file=./schema.sql
--   线上：npx wrangler d1 execute notes-db --remote --file=./schema.sql
--
-- 对应原 Node 版 storage/data/notes-data.json 中的各个顶层字段。

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT    PRIMARY KEY,
  username             TEXT    NOT NULL,
  normalized_username  TEXT    NOT NULL UNIQUE,
  password_hash        TEXT    NOT NULL,
  password_salt        TEXT    NOT NULL,
  password_version     INTEGER NOT NULL DEFAULT 1,
  skill_token_version  INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);

-- 每个账号一份云端工作区；updated_at 同时充当乐观并发控制的版本号
CREATE TABLE IF NOT EXISTS workspaces (
  user_id    TEXT    PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  workspace  TEXT    NOT NULL
);

-- 微信公众号 AppID / AppSecret，按账号隔离
CREATE TABLE IF NOT EXISTS wechat_configurations (
  owner_id   TEXT    PRIMARY KEY,
  app_id     TEXT    NOT NULL,
  app_secret TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Hermes Skill 安装链接（ticket → owner）
CREATE TABLE IF NOT EXISTS hermes_install_links (
  owner_id TEXT PRIMARY KEY,
  ticket   TEXT NOT NULL
);

-- 匿名用户每日图片上传额度，全表只保留一行（id 恒为 1）
CREATE TABLE IF NOT EXISTS anonymous_upload_quota (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  count    INTEGER NOT NULL DEFAULT 0,
  date_key TEXT    NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO anonymous_upload_quota (id, count, date_key)
VALUES (1, 0, '');

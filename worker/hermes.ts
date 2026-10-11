/**
 * Hermes / OpenClaw Skill 安装包生成。
 *
 * 原版从 skills/notes-workspace-api 目录读三个模板文件；这里改为从
 * Workers 静态资源绑定读取同一批文件（构建前已复制到 public/hermes-skill-template）。
 */
import type { Env } from "./env.js";
import { createZip, type ZipEntry } from "../src/lib/zip.js";

const PACKAGE_ROOT = "notes-workspace-api";
const TEMPLATE_PREFIX = "/hermes-skill-template";

const TEMPLATE_FILES: Array<{ mode: number; relativePath: string }> = [
  { mode: 0o100644, relativePath: "SKILL.md" },
  { mode: 0o100755, relativePath: "scripts/notes_api.mjs" },
  { mode: 0o100644, relativePath: "references/workspace-api.md" },
];

export async function buildHermesSkillPackage(
  env: Env,
  baseUrl: string,
  token: string,
): Promise<Uint8Array> {
  const entries: ZipEntry[] = [];

  for (const { mode, relativePath } of TEMPLATE_FILES) {
    // 这里传 URL 字符串而不是 `new Request(...)`：全局 `Request` 来自 DOM lib，
    // 缺少 Workers 专有的 `fetcher` 字段，无法赋给 `Fetcher.fetch` 的入参类型。
    const response = await env.ASSETS.fetch(
      `https://notes.local${TEMPLATE_PREFIX}/${relativePath}`,
    );

    if (!response.ok) {
      throw new Error(`缺少 Hermes 模板文件：${relativePath}`);
    }

    entries.push({
      data: new Uint8Array(await response.arrayBuffer()),
      mode,
      path: `${PACKAGE_ROOT}/${relativePath}`,
    });
  }

  const envFile = [
    `NOTES_API_BASE_URL=${baseUrl}`,
    `NOTES_API_TOKEN=${token}`,
    "",
  ].join("\n");

  entries.push({
    data: new TextEncoder().encode(envFile),
    mode: 0o100600,
    path: `${PACKAGE_ROOT}/.env`,
  });

  return createZip(entries);
}

export const HERMES_DOWNLOAD_FILENAME = "notes-workspace-api.zip";

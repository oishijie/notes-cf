/**
 * 浏览器端离线归档。
 *
 * 替代原 Node 版的 /api/archive 与 /api/workspace/archive：
 * - 单个便签归档：生成内联 CSS 与图片的 index.html
 * - 整体工作区导出：按文件夹组织 Markdown，图片落到同级 `.assets/` 目录
 *
 * 原版服务端用 Python fonttools 裁剪 OPPOSans 字体后再内嵌；浏览器端无法做字体
 * 子集化，因此归档内联完整 CSS 并依赖系统字体栈回退，字号与排版规则保持一致。
 */
import type { NoteWorkspace } from "../types/app.js";
import {
  collectMarkdownImageSources,
  replaceImageSources,
} from "./markdown-images.js";
import { getNoteTitle, orderNoteDocuments } from "./notes.js";
import { createZip, type ZipEntry } from "./zip.js";
import type { Bytes } from "./bytes.js";

const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_IMAGES = 2_000;

export interface ArchiveBuildResult {
  blob: Blob;
  filename: string;
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function buildTimestamp(now = new Date()): string {
  return [
    now.getFullYear(),
    padDatePart(now.getMonth() + 1),
    padDatePart(now.getDate()),
    padDatePart(now.getHours()),
    padDatePart(now.getMinutes()),
    padDatePart(now.getSeconds()),
  ].join("-");
}

/** 目录 / 文件名的安全化：保留中文，剔除文件系统非法字符。 */
function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return cleaned || fallback;
}

function ensureUniqueName(
  used: Set<string>,
  candidate: string,
): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }

  const lastDot = candidate.lastIndexOf(".");
  const base = lastDot > 0 ? candidate.slice(0, lastDot) : candidate;
  const extension = lastDot > 0 ? candidate.slice(lastDot) : "";

  for (let index = 2; index < 1000; index += 1) {
    const next = `${base}-${index}${extension}`;

    if (!used.has(next)) {
      used.add(next);
      return next;
    }
  }

  const fallbackName = `${base}-${Date.now()}${extension}`;
  used.add(fallbackName);

  return fallbackName;
}

function getExtensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();

  switch (normalized) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
}

interface ArchivedImage {
  bytes: Bytes;
  filename: string;
}

async function fetchImageForArchive(
  source: string,
  usedNames: Set<string>,
): Promise<ArchivedImage | null> {
  try {
    const response = await fetch(source, {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") || "image/png";

    let rawName = "image";

    try {
      rawName = decodeURIComponent(
        new URL(response.url, location.href).pathname.split("/").pop() || "image",
      );
    } catch {
      // 保留默认名
    }

    const lastDot = rawName.lastIndexOf(".");
    const hasExtension = lastDot > 0;
    const baseName = hasExtension ? rawName.slice(0, lastDot) : rawName;
    const extension = hasExtension
      ? rawName.slice(lastDot + 1).replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "png"
      : getExtensionFromMimeType(mimeType);
    const filename = ensureUniqueName(
      usedNames,
      `${baseName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 48) || "image"}.${extension}`,
    );

    return { bytes, filename };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 单个便签归档                                                                */
/* -------------------------------------------------------------------------- */

/** 收集页面全部 CSS 规则，用于离线 HTML 的内联样式。 */
function collectDocumentCss(): string {
  const parts: string[] = [];

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;

    try {
      rules = sheet.cssRules;
    } catch {
      // 跨域样式表无法读取，跳过
      continue;
    }

    if (!rules) {
      continue;
    }

    for (const rule of Array.from(rules)) {
      parts.push(rule.cssText);
    }
  }

  return parts.join("\n");
}

async function toDataUrl(source: string): Promise<string | null> {
  try {
    const response = await fetch(source, {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const blob = await response.blob();

    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** 把 CSS 与 HTML 中引用的站内图片替换为 data URL，使归档完全离线可用。 */
async function inlineLocalImages(
  content: string,
  cache: Map<string, string | null>,
): Promise<string> {
  const urlPattern = /url\((['"]?)(\/[^'")]+)\1\)/g;
  const imgSrcPattern = /(<img\b[^>]*\bsrc=)(["'])(\/[^"']*)\2/gi;
  const candidates = new Set<string>();

  for (const match of content.matchAll(urlPattern)) {
    candidates.add(match[2]);
  }

  for (const match of content.matchAll(imgSrcPattern)) {
    candidates.add(match[3]);
  }

  for (const candidate of candidates) {
    if (!cache.has(candidate)) {
      cache.set(candidate, await toDataUrl(candidate));
    }
  }

  let result = content.replace(urlPattern, (whole, _quote: string, url: string) => {
    const dataUrl = cache.get(url);
    return dataUrl ? `url("${dataUrl}")` : whole;
  });

  result = result.replace(
    imgSrcPattern,
    (whole, prefix: string, quote: string, url: string) => {
      const dataUrl = cache.get(url);
      return dataUrl ? `${prefix}${quote}${dataUrl}${quote}` : whole;
    },
  );

  return result;
}

function buildArchiveHtmlDocument(sheetHtml: string, css: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>便签归档</title>
<style>
${css}
html, body {
  margin: 0;
  padding: 0;
  background: #f3efe8;
  min-height: 100%;
}
body {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 32px 16px;
  box-sizing: border-box;
}
.preview-stage {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  width: 100%;
}
</style>
</head>
<body>
<div class="preview-stage" style="--note-scale: 2">
${sheetHtml}
</div>
</body>
</html>
`;
}

/**
 * 生成单个便签的离线归档 ZIP。
 * `sheetHtml` 由 `renderMarkdownToHtml` 产出，与网页预览使用同一套 DOM。
 */
export async function buildNoteArchiveZip(
  sheetHtml: string,
): Promise<ArchiveBuildResult> {
  const imageCache = new Map<string, string | null>();
  const inlinedSheet = await inlineLocalImages(sheetHtml, imageCache);
  const inlinedCss = await inlineLocalImages(collectDocumentCss(), imageCache);
  const html = buildArchiveHtmlDocument(inlinedSheet, inlinedCss);
  const timestamp = buildTimestamp();
  const zip = await createZip([
    {
      data: new TextEncoder().encode(html),
      mode: 0o100644,
      path: "index.html",
    },
  ]);

  return {
    blob: new Blob([zip], { type: "application/zip" }),
    filename: `便签归档-${timestamp}.zip`,
  };
}

/* -------------------------------------------------------------------------- */
/* 整体工作区导出                                                              */
/* -------------------------------------------------------------------------- */

function buildWorkspaceReadme(
  workspace: NoteWorkspace,
  rootFolder: string,
  exportedNotes: number,
  archivedImageCount: number,
): string {
  const lines = [
    `# ${rootFolder}`,
    "",
    `导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `便签数量：${exportedNotes}`,
    `图片数量：${archivedImageCount}`,
    `文件夹数量：${workspace.folders?.length ?? 0}`,    "",
    "## 目录说明",
    "",
    "- 每个便签导出为同名 Markdown 文件，图片存放在同名的 `.assets` 目录中。",
    "- `_未分类` 存放没有归属文件夹的便签。",
    "- `_回收站` 存放仍在回收站中、尚可恢复的便签。",
    "- Markdown 中的图片地址已改写为 `.assets` 目录内的相对路径。",
    "- 无法下载的远程图片会保留原始地址。",
    "",
  ];

  return lines.join("\n");
}

/**
 * 生成整个工作区的 ZIP。
 * 匿名用户也能导出仅存在于 localStorage 的工作区。
 */
export async function buildWorkspaceArchiveZip(
  workspace: NoteWorkspace,
): Promise<ArchiveBuildResult> {
  const notes = orderNoteDocuments(workspace.notes);
  const rootFolder = `锤子便签-${buildTimestamp()}`;
  const folderNameById = new Map<string, string>();
  const usedFolderNames = new Set<string>();

  for (const folder of workspace.folders ?? []) {
    folderNameById.set(
      folder.id,
      ensureUniqueName(
        usedFolderNames,
        sanitizeSegment(folder.name, "未命名文件夹"),
      ),
    );
  }

  const entries: ZipEntry[] = [];
  const usedFileNamesByFolder = new Map<string, Set<string>>();
  const imageNameCache = new Map<string, string>();
  const usedImageNames = new Set<string>();
  const encoder = new TextEncoder();
  let exportedNotes = 0;
  let archivedImageCount = 0;

  const getFileNamesFor = (folder: string): Set<string> => {
    const existing = usedFileNamesByFolder.get(folder);

    if (existing) {
      return existing;
    }

    const created = new Set<string>();
    usedFileNamesByFolder.set(folder, created);

    return created;
  };

  for (const note of notes) {
    const folderSegment = note.deletedAt !== null
      ? "_回收站"
      : note.folderId && folderNameById.has(note.folderId)
        ? folderNameById.get(note.folderId)!
        : "_未分类";
    const title = sanitizeSegment(
      getNoteTitle(note.markdown) || `便签-${exportedNotes + 1}`,
      `便签-${exportedNotes + 1}`,
    );
    const fileName = ensureUniqueName(
      getFileNamesFor(folderSegment),
      `${title}.md`,
    );
    const baseName = fileName.replace(/\.md$/, "");
    const assetDirectory = `${baseName}.assets`;
    const sources = collectMarkdownImageSources(note.markdown);
    const replacements = new Map<string, string>();

    for (const source of sources.slice(0, MAX_ARCHIVE_IMAGES)) {
      let archivedName = imageNameCache.get(source);

      if (!archivedName) {
        const archived = await fetchImageForArchive(source, usedImageNames);

        if (!archived) {
          continue;
        }

        imageNameCache.set(source, archived.filename);
        entries.push({
          data: archived.bytes,
          mode: 0o100644,
          path: `${folderSegment}/${assetDirectory}/${archived.filename}`,
        });
        archivedName = archived.filename;
        archivedImageCount += 1;
      }

      replacements.set(source, `${assetDirectory}/${archivedName}`);
    }

    // 图片下载失败时保留原始地址，而不是静默生成缺图归档
    const markdown = replaceImageSources(note.markdown, replacements);

    entries.push({
      data: encoder.encode(markdown),
      mode: 0o100644,
      path: `${folderSegment}/${fileName}`,
    });
    exportedNotes += 1;
  }

  const rootEntries: ZipEntry[] = [
    {
      data: encoder.encode(
        buildWorkspaceReadme(workspace, rootFolder, exportedNotes, archivedImageCount),
      ),
      mode: 0o100644,
      path: "导出说明.md",
    },
    ...entries,
  ];
  const zip = await createZip(
    rootEntries.map((entry) => ({
      ...entry,
      path: `${rootFolder}/${entry.path}`,
    })),
  );

  return {
    blob: new Blob([zip], { type: "application/zip" }),
    filename: `${rootFolder}.zip`,
  };
}

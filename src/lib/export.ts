/**
 * 导出入口（浏览器端实现）。
 *
 * 原实现把 PNG、离线归档、整体工作区导出都交给 Node 后端（Playwright + sharp +
 * 手写 ZIP）。迁移到 Cloudflare Workers 后，后端不再具备这些能力，因此全部下沉到
 * 浏览器：
 *
 *   /api/export            → renderMarkdownToPngBlob（同款组件 → Canvas）
 *   /api/archive           → renderMarkdownToHtml + buildNoteArchiveZip
 *   /api/workspace/archive → buildWorkspaceArchiveZip
 *
 * 对外函数签名与旧版完全一致，App.tsx 等调用方无需改动。
 */
import type { NoteCardThemeId, NoteWorkspace } from "../types/app.js";
import { ExportError } from "../types/app.js";
import { buildNoteArchiveZip, buildWorkspaceArchiveZip } from "./archive.js";
import { renderMarkdownToHtml, renderMarkdownToPngBlob } from "./export-png.js";

interface ExportFooterOptions {
  footerBrand: string;
  footerLogoUrl: string;
  footerVia: string;
}

export interface WorkspaceArchiveProgress {
  percent: number;
  message: string;
  completedNotes: number;
  totalNotes: number;
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function buildExportFilename(): string {
  const now = new Date();
  const formatted = [
    now.getFullYear(),
    padDatePart(now.getMonth() + 1),
    padDatePart(now.getDate()),
    padDatePart(now.getHours()),
    padDatePart(now.getMinutes()),
    padDatePart(now.getSeconds()),
  ].join("-");

  return `${formatted}-${Date.now()}.png`;
}

/** 移动端优先走系统分享面板，桌面端回退到普通下载。 */
async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const isCoarsePointer =
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches;
  const objectUrl = URL.createObjectURL(blob);

  try {
    const file = new File([blob], filename, {
      type: blob.type || "application/octet-stream",
    });

    if (
      isCoarsePointer &&
      typeof navigator !== "undefined" &&
      navigator.share &&
      navigator.canShare?.({ files: [file] })
    ) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        console.warn("Share failed, falling back to download.", error);
      }
    }

    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.rel = "noopener";

    if (isCoarsePointer) {
      link.target = "_blank";
      link.download = "";
    }

    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    globalThis.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 60_000);
  }
}

function toExportError(error: unknown): ExportError {
  if (error instanceof ExportError) {
    return error;
  }

  if (error instanceof Error) {
    return new ExportError(error.message);
  }

  return new ExportError("导出失败，原因未知");
}

/** 把 Markdown 渲染为 PNG 长图并触发保存。 */
export async function exportMarkdownAsPng(
  markdown: string,
  theme: NoteCardThemeId,
  footer: ExportFooterOptions,
): Promise<void> {
  const filename = buildExportFilename();

  try {
    const blob = await renderMarkdownToPngBlob(markdown, {
      footerBrand: footer.footerBrand,
      footerLogoUrl: footer.footerLogoUrl,
      footerVia: footer.footerVia,
      theme,
    });

    await saveBlob(blob, filename);
  } catch (error) {
    throw toExportError(error);
  }
}

/** 下载当前便签的离线归档（内联 CSS 与图片，可脱离站点打开）。 */
export async function exportMarkdownArchive(
  markdown: string,
  theme: NoteCardThemeId,
  footer: ExportFooterOptions,
): Promise<void> {
  try {
    const sheetHtml = await renderMarkdownToHtml(markdown, {
      footerBrand: footer.footerBrand,
      footerLogoUrl: footer.footerLogoUrl,
      footerVia: footer.footerVia,
      theme,
    });
    const archive = await buildNoteArchiveZip(sheetHtml);

    await saveBlob(archive.blob, archive.filename);
  } catch (error) {
    throw toExportError(error);
  }
}

/**
 * 导出整个工作区为 ZIP。
 *
 * 保持与原版一致的进度回调语义：图片较多的作品集在浏览器抓图阶段耗时较久，
 * 因此按便签数量推进进度。
 */
export async function exportNoteWorkspaceArchive(
  workspace: NoteWorkspace,
  onProgress: (progress: WorkspaceArchiveProgress) => void,
): Promise<void> {
  const totalNotes = workspace.notes.length;

  try {
    onProgress({
      completedNotes: 0,
      message: "正在准备整体导出",
      percent: 1,
      totalNotes,
    });

    const archive = await buildWorkspaceArchiveZip(workspace);

    onProgress({
      completedNotes: totalNotes,
      message: "全部便签已导出",
      percent: 100,
      totalNotes,
    });

    await saveBlob(archive.blob, archive.filename);
  } catch (error) {
    throw toExportError(error);
  }
}

export function getExportErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "导出失败，原因未知。";
  }

  return error.message;
}

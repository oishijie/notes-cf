/**
 * 浏览器端便签渲染：把 NoteSheet 组件离屏渲染成 Canvas / PNG。
 *
 * 替代原 Node 版的 Playwright 截图链路（server/index.ts 的 renderNotePng）。
 * 因为渲染用的就是页面上的同一套 React 组件与 CSS，导出结果与预览天然一致。
 *
 * 实现要点：
 * - 在 `left:-20000px` 的离屏容器中挂载与预览完全相同的 DOM 结构
 *   （`.preview-stage` → `.preview-card-theme` → `.note-sheet`），
 *   保证 CSS 变量与卡片主题作用域都能正确生效
 * - 使用 html2canvas-pro：它支持 `color-mix()` 等现代颜色函数，
 *   原生 html2canvas 会把计算后的 `color(srgb …)` 解析为黑色
 * - 项目 CSS 大量依赖 `@font-face` 的 OPPOSans，canvas 绘制直接使用
 *   已加载字体，因此无需像 SVG foreignObject 方案那样内联字体
 */
import { createRoot } from "react-dom/client";
import html2canvas from "html2canvas-pro";
import { NoteSheet } from "../components/NoteSheet.js";
import type { NoteCardThemeId } from "../types/app.js";
import { splitSections } from "./markdown.js";

/** 与原 Playwright 导出保持一致的 3 倍图。 */
export const EXPORT_DEVICE_SCALE_FACTOR = 3;
/** 与预览一致的逻辑便签宽度比例。 */
const EXPORT_NOTE_SCALE = 2;
/** 浏览器 Canvas 单边上限（Chromium 约为 32767），留出安全余量。 */
const MAX_CANVAS_DIMENSION = 30_000;
const IMAGE_WAIT_TIMEOUT_MS = 15_000;

export interface NoteRenderOptions {
  footerBrand: string;
  footerLogoUrl: string;
  footerVia: string;
  theme: NoteCardThemeId;
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function waitForImages(element: HTMLElement): Promise<void> {
  const images = Array.from(element.querySelectorAll("img"));

  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete && image.naturalWidth > 0) {
            resolve();
            return;
          }

          const timeout = globalThis.setTimeout(resolve, IMAGE_WAIT_TIMEOUT_MS);
          const finish = () => {
            globalThis.clearTimeout(timeout);
            resolve();
          };

          image.addEventListener("load", finish, { once: true });
          image.addEventListener("error", finish, { once: true });
        }),
    ),
  );
}

/**
 * 构建离屏容器并渲染 NoteSheet，返回便签根元素与清理函数。
 */
async function mountNoteSheet(
  markdown: string,
  options: NoteRenderOptions,
): Promise<{ sheet: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  host.setAttribute("data-notes-export-host", "");
  // 必须真实渲染（不能 display:none），否则拿不到布局尺寸与 CSS 变量
  host.style.cssText = [
    "position:fixed",
    "left:-20000px",
    "top:0",
    "z-index:-1",
    "pointer-events:none",
    "contain:layout style",
  ].join(";");

  const stage = document.createElement("div");
  stage.className = "preview-stage";
  stage.style.setProperty("--note-scale", String(EXPORT_NOTE_SCALE));

  const themeWrapper = document.createElement("div");
  themeWrapper.className = "preview-card-theme";
  themeWrapper.setAttribute("data-preview-theme", options.theme);

  stage.append(themeWrapper);
  host.append(stage);
  document.body.append(host);

  const root = createRoot(themeWrapper);

  const cleanup = () => {
    root.unmount();
    host.remove();
  };

  root.render(
    <NoteSheet
      notes={splitSections(markdown)}
      footerLogoUrl={options.footerLogoUrl}
      footerBrand={
        <span className="sheet-footer-brand">{options.footerBrand}</span>
      }
      footerVia={<span className="sheet-footer-via">{options.footerVia}</span>}
    />,
  );

  // 等待 React 提交、样式计算与字体就绪
  await waitForAnimationFrame();

  if (document.fonts?.ready) {
    await document.fonts.ready.catch(() => undefined);
  }

  const sheet = themeWrapper.querySelector<HTMLElement>(".note-sheet");

  if (!sheet) {
    cleanup();
    throw new Error("便签渲染失败，请刷新页面后重试。");
  }

  await waitForImages(sheet);
  await waitForAnimationFrame();

  return { cleanup, sheet };
}

/** 把 Markdown 渲染为 PNG Blob（与网页预览同一套组件与样式）。 */
export async function renderMarkdownToPngBlob(
  markdown: string,
  options: NoteRenderOptions,
): Promise<Blob> {
  const { sheet, cleanup } = await mountNoteSheet(markdown, options);

  try {
    // 便签为横向固定宽度（330px × scale），只有纵向会无限增长
    const logicalHeight = Math.max(sheet.offsetHeight, 1);
    const scale = Math.max(
      1,
      Math.min(EXPORT_DEVICE_SCALE_FACTOR, MAX_CANVAS_DIMENSION / logicalHeight),
    );

    const canvas = await html2canvas(sheet, {
      backgroundColor: null,
      height: logicalHeight,
      logging: false,
      scale,
      useCORS: true,
      width: sheet.offsetWidth,
      windowHeight: Math.min(window.innerHeight, logicalHeight + 200),
      windowWidth: window.innerWidth,
    });

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("导出图片编码失败，请重试。"));
      }, "image/png");
    });
  } finally {
    cleanup();
  }
}

/** 渲染便签并返回其 outerHTML，供离线归档使用。 */
export async function renderMarkdownToHtml(
  markdown: string,
  options: NoteRenderOptions,
): Promise<string> {
  const { sheet, cleanup } = await mountNoteSheet(markdown, options);

  try {
    return sheet.outerHTML;
  } finally {
    cleanup();
  }
}

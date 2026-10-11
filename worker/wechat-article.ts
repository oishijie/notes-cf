/**
 * 公众号富文本渲染与图片解析（Workers 版）。
 *
 * 复用与前端完全相同的 React 组件（`src/components/WechatArticle.tsx`），
 * 保证「网页预览 = 复制到公众号」的排版一致。
 *
 * 与原 Node 版的差异：图片来源解析从「本地文件系统」改为
 * 「R2（本站图片）+ 静态资源（public/）+ 远程下载」三路。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WechatArticle } from "../src/components/WechatArticle.js";
import {
  DEFAULT_FOOTER_BRAND,
  DEFAULT_FOOTER_LOGO_URL,
  DEFAULT_FOOTER_VIA,
} from "../src/lib/footer.js";
import {
  collectHtmlImageSources as collectHtmlImageSourcesShared,
  collectMarkdownImageSources as collectMarkdownImageSourcesShared,
  decodeHtmlImageSource as decodeHtmlImageSourceShared,
  replaceAll as replaceAllShared,
} from "../src/lib/markdown-images.js";
import type { NoteCardThemeId } from "../src/types/app.js";
import type { AnonymousQuotaStatus, NotesStore } from "./auth.js";
import { getShanghaiDateKey } from "./auth.js";
import type { Env } from "./env.js";
import { sha256Hex } from "./lib/crypto.js";
import type { Bytes } from "./lib/bytes.js";
import {
  detectImageFormat,
  downloadImageFromUrl,
  IMAGE_PREFIX,
  type ImageSource,
} from "./images.js";
import {
  isQiniuUrl,
  loadQiniuConfig,
  uploadImageBufferToQiniu,
} from "./qiniu.js";

export interface FooterConfig {
  brand?: string;
  logoUrl?: string;
  via?: string;
}

export const DEFAULT_WECHAT_FOOTER_HAMMER_URL =
  "https://notes.fangyuanxiaozhan.com/images/b5d3bd9587fa9a1226b25a0709ff61a450df29d96ca2f127c6afc0b8e193a60e.png";

export interface WechatConnectionStatus {
  checkedAt: number | null;
  configured: boolean;
  connected: boolean;
  connectionError: string | null;
}

export function resolveFooterConfig(body: {
  footerBrand?: string;
  footerLogoUrl?: string;
  footerVia?: string;
}): FooterConfig {
  return {
    brand: normalizeFooterText(body.footerBrand),
    logoUrl: normalizeFooterLogoUrl(body.footerLogoUrl),
    via: normalizeFooterText(body.footerVia),
  };
}

export function normalizeFooterText(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  return input.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 80);
}

export function normalizeFooterLogoUrl(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const value = input
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 2048);

  if (
    (value.startsWith("/") && !value.startsWith("//")) ||
    /^https?:\/\//i.test(value) ||
    /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)
  ) {
    return value;
  }

  return undefined;
}

export function replaceAll(
  value: string,
  search: string,
  replacement: string,
): string {
  return replaceAllShared(value, search, replacement);
}

/** 从 Markdown 与内嵌 HTML 中收集图片地址（与前端共用同一套规则）。 */
export function collectMarkdownImageSources(markdown: string): string[] {
  return collectMarkdownImageSourcesShared(markdown);
}

export function collectHtmlImageSources(html: string): string[] {
  return collectHtmlImageSourcesShared(html);
}

export function decodeHtmlImageSource(source: string): string {
  return decodeHtmlImageSourceShared(source);
}

function getDataUrlImage(source: string): ImageSource | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(source);

  if (!match) {
    return null;
  }

  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return { buffer: bytes, filename: "embedded-image", mimeType: match[1] };
}

/** 读取站内图片：`/images/*` 走 R2，其余（如 public/ 下的内置 Logo）走静态资源。 */
async function readRootRelativeImage(
  env: Env,
  source: string,
): Promise<ImageSource | null> {
  let pathname = "";

  try {
    pathname = decodeURIComponent(new URL(source, "http://notes.local").pathname);
  } catch {
    return null;
  }

  if (pathname.startsWith("/images/")) {
    const filename = pathname.slice("/images/".length);

    if (!/^[a-f0-9]{64}\.[a-z0-9]{2,5}$/.test(filename)) {
      return null;
    }

    const object = await env.IMAGES.get(`${IMAGE_PREFIX}${filename}`);

    if (!object) {
      return null;
    }

    return {
      buffer: new Uint8Array(await object.arrayBuffer()),
      filename,
      mimeType: object.httpMetadata?.contentType ?? null,
    };
  }

  // public/ 下的静态资源由 Workers 静态资源绑定提供
  // 同样传 URL 字符串以避开 DOM `Request` 与 Workers `RequestInfo` 的类型差异。
  const assetResponse = await env.ASSETS.fetch(
    `https://notes.local${pathname}`,
  ).catch(() => null);

  if (!assetResponse?.ok) {
    return null;
  }

  return {
    buffer: new Uint8Array(await assetResponse.arrayBuffer()),
    filename: pathname.split("/").pop() || "asset",
    mimeType: assetResponse.headers.get("content-type"),
  };
}

/** 解析任意图片来源为二进制内容。 */
export async function resolveImageSource(
  env: Env,
  source: string,
  publicBaseUrl?: string,
): Promise<ImageSource | null> {
  const dataImage = getDataUrlImage(source);

  if (dataImage) {
    return dataImage;
  }

  if (/^https?:\/\//i.test(source)) {
    if (publicBaseUrl) {
      try {
        const sourceUrl = new URL(source);
        const publicUrl = new URL(publicBaseUrl);

        if (
          sourceUrl.host.toLowerCase() === publicUrl.host.toLowerCase() &&
          sourceUrl.pathname.startsWith("/images/")
        ) {
          // 同源图片直接读存储，避免回环访问自身
          return readRootRelativeImage(
            env,
            `${sourceUrl.pathname}${sourceUrl.search}`,
          );
        }
      } catch {
        // 解析失败时按远程图片处理
      }
    }

    return downloadImageFromUrl(source);
  }

  if (source.startsWith("/")) {
    return readRootRelativeImage(env, source);
  }

  return null;
}

export function renderWechatArticle(
  env: Env,
  markdown: string,
  footer: FooterConfig,
  theme: NoteCardThemeId,
): string {
  const footerHammerUrl =
    footer.logoUrl && footer.logoUrl !== DEFAULT_FOOTER_LOGO_URL
      ? footer.logoUrl
      : env.WECHAT_FOOTER_HAMMER_URL?.trim() || DEFAULT_WECHAT_FOOTER_HAMMER_URL;

  return renderToStaticMarkup(
    createElement(WechatArticle, {
      footerBrand: footer.brand ?? DEFAULT_FOOTER_BRAND,
      footerHammerUrl,
      footerVia: footer.via ?? DEFAULT_FOOTER_VIA,
      markdown,
      theme,
    }),
  ).replace(
    /<link\b[^>]*\brel="preload"[^>]*\bas="image"[^>]*\/?>/gi,
    "",
  );
}

/** 为草稿预览准备 HTML：把图片替换为占位地址，避免 Data URL 进入正文。 */
export function prepareWechatDraftArticle(
  env: Env,
  markdown: string,
  footer: FooterConfig,
  theme: NoteCardThemeId,
): { html: string; sourceByPlaceholder: Map<string, string> } {
  const articleSources = collectMarkdownImageSources(markdown);
  const sources = Array.from(
    new Set([
      ...articleSources,
      ...(footer.logoUrl && footer.logoUrl !== DEFAULT_FOOTER_LOGO_URL
        ? [footer.logoUrl]
        : []),
    ]),
  );
  const sourceByPlaceholder = new Map<string, string>();
  const placeholderBySource = new Map<string, string>();

  for (const [index, source] of sources.entries()) {
    const placeholder = `https://wechat-draft.invalid/image/${index}/`;
    sourceByPlaceholder.set(placeholder, source);
    placeholderBySource.set(source, placeholder);
  }

  let draftMarkdown = markdown;

  for (const [source, placeholder] of Array.from(placeholderBySource).sort(
    ([left], [right]) => right.length - left.length,
  )) {
    draftMarkdown = replaceAll(draftMarkdown, source, placeholder);
  }

  return {
    html: renderWechatArticle(
      env,
      draftMarkdown,
      {
        ...footer,
        logoUrl: placeholderBySource.get(footer.logoUrl || "") || footer.logoUrl,
      },
      theme,
    ),
    sourceByPlaceholder,
  };
}

/**
 * 「复制到公众号」：把正文图片上传到七牛，返回带内联样式的 HTML。
 * 匿名用户共用每日额度，登录用户不受限。
 */
export async function prepareWechatArticle(
  env: Env,
  store: NotesStore,
  markdown: string,
  options: {
    footer: FooterConfig;
    publicBaseUrl: string;
    temporaryUploads: boolean;
    theme: NoteCardThemeId;
    anonymousDailyUploadLimit: number;
  },
): Promise<{
  anonymousQuota: AnonymousQuotaStatus | null;
  html: string;
  imageCount: number;
  markdown: string;
  reusedImageCount: number;
  theme: NoteCardThemeId;
  uploadedImageCount: number;
}> {
  const markdownImageSources = collectMarkdownImageSources(markdown);
  const customFooterLogoSource =
    options.footer.logoUrl && options.footer.logoUrl !== DEFAULT_FOOTER_LOGO_URL
      ? options.footer.logoUrl
      : null;
  const imageSources = Array.from(
    new Set([
      ...markdownImageSources,
      ...(customFooterLogoSource ? [customFooterLogoSource] : []),
    ]),
  );
  const replacements = new Map<string, string>();
  let uploadedImageCount = 0;
  let reusedImageCount = 0;
  let wechatMarkdown = markdown;
  let anonymousQuota: AnonymousQuotaStatus | null = null;

  if (imageSources.length > 0) {
    const qiniuConfig = loadQiniuConfig(env);

    if (!qiniuConfig) {
      const { QiniuConfigurationError } = await import("./qiniu.js");

      throw new QiniuConfigurationError(
        "未配置七牛图床。请设置 QINIU_ACCESS_KEY、QINIU_SECRET_KEY、QINIU_BUCKET 和 QINIU_DOMAIN。",
      );
    }

    const imagesByContentHash = new Map<
      string,
      { buffer: Bytes; extension: string; sources: string[] }
    >();

    for (const source of imageSources) {
      if (isQiniuUrl(source, qiniuConfig)) {
        reusedImageCount += 1;
        continue;
      }

      const image = await resolveImageSource(env, source, options.publicBaseUrl);

      if (!image?.buffer.length) {
        throw new Error(`无法读取公众号图片：${source}`);
      }

      const extension = detectImageFormat(
        image.buffer,
        image.mimeType,
        image.filename || source,
      );

      if (!extension) {
        throw new Error(`公众号暂不支持该图片格式：${source}`);
      }

      const contentHash = await sha256Hex(image.buffer);
      const existingImage = imagesByContentHash.get(contentHash);

      if (existingImage) {
        existingImage.sources.push(source);
      } else {
        imagesByContentHash.set(contentHash, {
          buffer: image.buffer,
          extension,
          sources: [source],
        });
      }
    }

    const uniqueImages = Array.from(imagesByContentHash.values());
    const temporaryPrefix = [
      qiniuConfig.prefix,
      "temporary",
      getShanghaiDateKey(),
    ]
      .filter(Boolean)
      .join("/");

    if (options.temporaryUploads && uniqueImages.length > 0) {
      anonymousQuota = await store.reserveAnonymousUploads(
        uniqueImages.length,
        options.anonymousDailyUploadLimit,
      );
    }

    for (const image of uniqueImages) {
      const uploaded = await uploadImageBufferToQiniu(
        image.buffer,
        image.extension,
        qiniuConfig,
        options.temporaryUploads
          ? { deleteAfterDays: 1, prefix: temporaryPrefix }
          : undefined,
      );

      for (const source of image.sources) {
        replacements.set(source, uploaded.url);
      }

      if (uploaded.uploaded) {
        uploadedImageCount += 1;
      } else {
        reusedImageCount += 1;
      }

      reusedImageCount += Math.max(0, image.sources.length - 1);
    }

    for (const [source, replacement] of Array.from(replacements).sort(
      ([left], [right]) => right.length - left.length,
    )) {
      wechatMarkdown = replaceAll(wechatMarkdown, source, replacement);
    }
  }

  const footerHammerUrl = customFooterLogoSource
    ? replacements.get(customFooterLogoSource) || customFooterLogoSource
    : env.WECHAT_FOOTER_HAMMER_URL?.trim() || DEFAULT_WECHAT_FOOTER_HAMMER_URL;
  const html = renderWechatArticle(
    env,
    wechatMarkdown,
    { ...options.footer, logoUrl: footerHammerUrl },
    options.theme,
  );

  return {
    anonymousQuota,
    html,
    imageCount: markdownImageSources.length,
    markdown: wechatMarkdown,
    reusedImageCount,
    theme: options.theme,
    uploadedImageCount,
  };
}

export function getWechatDraftTitle(markdown: string): string {
  const firstHeading = /^\s*#{1,6}\s+(.+?)\s*$/m.exec(markdown)?.[1];
  const firstLine = markdown
    .split("\n")
    .map((line) => line.replace(/^\s*[#>*-]+\s*/, "").trim())
    .find(Boolean);
  const title = (firstHeading || firstLine || "锤子便签")
    .replace(/[*_`[\]]/g, "")
    .trim();

  return Array.from(title).slice(0, 32).join("") || "锤子便签";
}

/** 微信官方限制：正文少于 2 万字符且小于 1MB。 */
export function assertWechatDraftContentLimits(html: string): void {
  const byteLength = new TextEncoder().encode(html).length;
  const characterCount = Array.from(html).length;

  if (characterCount > 20_000) {
    throw new Error("公众号正文超过 2 万字符限制，请拆分便签后重试。");
  }

  if (byteLength > 1024 * 1024) {
    throw new Error("公众号正文超过 1MB 限制，请减少图片或文字后重试。");
  }
}

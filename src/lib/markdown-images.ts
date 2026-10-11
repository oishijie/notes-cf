/**
 * Markdown 图片地址收集（前后端共享）。
 *
 * 网页端「复制到公众号」、离线归档与 Worker 端的富文本渲染都依赖同一套
 * 提取规则，因此集中在这里维护，避免两边规则漂移。
 */

/**
 * 从 Markdown 与内嵌 HTML 中收集图片地址。
 * 保留首次出现顺序并去重，与原实现一致。
 */
export function collectMarkdownImageSources(markdown: string): string[] {
  const sources: string[] = [];
  const markdownImagePattern =
    /!\[[^\]]*]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g;
  const htmlImagePattern = /<img\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi;

  for (const match of markdown.matchAll(markdownImagePattern)) {
    sources.push(match[1]);
  }

  for (const match of markdown.matchAll(htmlImagePattern)) {
    sources.push(match[2]);
  }

  return Array.from(new Set(sources));
}

/** 收集渲染后 HTML 中的 `<img src>`。 */
export function collectHtmlImageSources(html: string): string[] {
  const sources: string[] = [];
  const pattern = /<img\b[^>]*\bsrc=(['"])(.*?)\1[^>]*>/gi;

  for (const match of html.matchAll(pattern)) {
    sources.push(match[2]);
  }

  return Array.from(new Set(sources));
}

export function decodeHtmlImageSource(source: string): string {
  return source
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"');
}

/** 逐字面量替换，避免把地址里的正则元字符当成模式。 */
export function replaceAll(
  value: string,
  search: string,
  replacement: string,
): string {
  return value.split(search).join(replacement);
}

/**
 * 按源地址长度降序替换。
 * 必须先替换较长的地址，否则带查询参数的地址会被较短的基础地址提前部分替换。
 */
export function replaceImageSources(
  value: string,
  replacements: Map<string, string>,
): string {
  let result = value;

  for (const [source, replacement] of Array.from(replacements).sort(
    ([left], [right]) => right.length - left.length,
  )) {
    result = replaceAll(result, source, replacement);
  }

  return result;
}

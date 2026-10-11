/**
 * 外部图床白名单（前后端共享的纯函数）。
 *
 * 命中白名单的图片地址会被「原样保留为外链」，不再下载转存到 R2：
 * - 图片导入：`POST /api/images/import` 直接把该外链回给前端
 * - 公众号链路：直接复用地址，跳过七牛上传
 *
 * 白名单由 `IMAGE_BED_HOSTS` 配置，逗号分隔。只比对主机名（不含端口），
 * 避免把 `example.com:8443` 之类的写法误判为另一个站点。
 */

/** 把 `IMAGE_BED_HOSTS` 拆成规范化的小写主机名列表。 */
export function parseImageBedHosts(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/** 判断地址是否命中外部图床白名单；白名单为空时恒为 false（保持原行为）。 */
export function isImageBedUrl(
  source: string,
  hosts: string | null | undefined,
): boolean {
  const allowed = parseImageBedHosts(hosts);

  if (allowed.length === 0) {
    return false;
  }

  try {
    const url = new URL(source.trim());

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    return allowed.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 从图片地址推断扩展名。
 * 仅用于补齐导入结果结构，前端并不消费该字段，失败时回退 `png`。
 */
export function inferImageExtension(source: string): string {
  try {
    const pathname = new URL(source.trim()).pathname;
    const extension = pathname.split(".").pop()?.toLowerCase() ?? "";

    return /^[a-z0-9]{2,5}$/.test(extension) ? extension : "png";
  } catch {
    return "png";
  }
}

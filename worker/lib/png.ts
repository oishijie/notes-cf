/**
 * 纯色 PNG 生成。
 *
 * 原 Node 版在「文章没有首图」时用 sharp 把一段 SVG 光栅化成 900×383 的公众号封面，
 * 并带有「光栅化失败则用主题色纯色图兜底」的逻辑。Workers 没有 sharp，也没有
 * 图片编码库，因此这里直接把兜底分支提为主路径：按主题色生成纯色封面。
 *
 * PNG 的 IDAT 需要 zlib 包装（含 2 字节头与 Adler-32 校验），正好对应
 * `CompressionStream("deflate")` 的输出格式（`deflate-raw` 则是裸 deflate）。
 */
import { crc32 } from "../../src/lib/zip.js";
import type { Bytes } from "../../src/lib/bytes.js";

function buildChunk(type: string, data: Bytes): Bytes {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);

  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));

  return chunk;
}

export interface RgbColor {
  b: number;
  g: number;
  r: number;
}

/** 生成一张纯色 PNG。颜色分量取值 0–255。 */
export async function createSolidColorPng(
  width: number,
  height: number,
  color: RgbColor,
): Promise<Bytes> {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // 位深
  header[9] = 2; // 颜色类型：真彩色 RGB
  header[10] = 0; // 压缩方法
  header[11] = 0; // 过滤方法
  header[12] = 0; // 隔行扫描：无

  // 每行 = 1 字节过滤类型(0) + width × 3 字节 RGB
  const rowLength = 1 + width * 3;
  const raw = new Uint8Array(rowLength * height);

  for (let row = 0; row < height; row += 1) {
    const offset = row * rowLength;
    raw[offset] = 0;

    for (let column = 0; column < width; column += 1) {
      const pixel = offset + 1 + column * 3;
      raw[pixel] = color.r;
      raw[pixel + 1] = color.g;
      raw[pixel + 2] = color.b;
    }
  }

  const compressed = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );

  const ihdr = buildChunk("IHDR", header);
  const idat = buildChunk("IDAT", compressed);
  const iend = buildChunk("IEND", new Uint8Array(0));
  const png = new Uint8Array(
    signature.length + ihdr.length + idat.length + iend.length,
  );

  png.set(signature, 0);
  png.set(ihdr, signature.length);
  png.set(idat, signature.length + ihdr.length);
  png.set(iend, signature.length + ihdr.length + idat.length);

  return png;
}

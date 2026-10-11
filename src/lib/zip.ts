/**
 * 极简 ZIP 写入器。
 *
 * 原 Node 版手写了一套 ZIP（crc32 + deflate + 拼接）；这里改用 Workers 原生的
 * `CompressionStream("deflate-raw")`，代码量和出错面都小得多。
 * 仅支持写入，不支持读取，足够生成 Hermes Skill 安装包。
 */

import type { Bytes } from "./bytes.js";

export interface ZipEntry {
  data: Bytes;
  /** Unix 权限位，例如 0o100644 / 0o100755 */
  mode?: number;
  path: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;

  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function getDosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { date: dosDate, time: dosTime };
}

async function deflateRaw(bytes: Bytes): Promise<Bytes> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class ByteWriter {
  private chunks: Bytes[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  push(bytes: Bytes): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.push(
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]),
    );
  }

  text(value: string): void {
    this.push(new TextEncoder().encode(value));
  }

  toUint8Array(): Bytes {
    const output = new Uint8Array(this.length);
    let offset = 0;

    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }

    return output;
  }
}

const UTF8_FLAG = 0x0800;
const METHOD_DEFLATE = 8;

export async function createZip(
  entries: ZipEntry[],
  now = new Date(),
): Promise<Bytes> {
  const { date, time } = getDosDateTime(now);
  const writer = new ByteWriter();
  const directory: Array<{
    compressedSize: number;
    crc: number;
    fileNameBytes: Bytes;
    localHeaderOffset: number;
    mode: number;
    uncompressedSize: number;
  }> = [];

  for (const entry of entries) {
    const fileNameBytes = new TextEncoder().encode(entry.path);
    const compressed = await deflateRaw(entry.data);
    const useDeflate = compressed.length < entry.data.length;
    const payload = useDeflate ? compressed : entry.data;
    const localHeaderOffset = writer.offset;
    const entryCrc = crc32(entry.data);

    writer.u32(0x04_03_4b_50);
    writer.u16(20);
    writer.u16(UTF8_FLAG);
    writer.u16(useDeflate ? METHOD_DEFLATE : 0);
    writer.u16(time);
    writer.u16(date);
    writer.u32(entryCrc);
    writer.u32(payload.length);
    writer.u32(entry.data.length);
    writer.u16(fileNameBytes.length);
    writer.u16(0);
    writer.push(fileNameBytes);
    writer.push(payload);

    directory.push({
      compressedSize: payload.length,
      crc: entryCrc,
      fileNameBytes,
      localHeaderOffset,
      mode: entry.mode ?? 0o100644,
      uncompressedSize: entry.data.length,
    });
  }

  const directoryOffset = writer.offset;

  for (const item of directory) {
    writer.u32(0x02_01_4b_50);
    writer.u16(20);
    writer.u16(20);
    writer.u16(UTF8_FLAG);
    writer.u16(METHOD_DEFLATE);
    writer.u16(time);
    writer.u16(date);
    writer.u32(item.crc);
    writer.u32(item.compressedSize);
    writer.u32(item.uncompressedSize);
    writer.u16(item.fileNameBytes.length);
    writer.u16(0);
    writer.u16(0);
    writer.u16(0);
    writer.u16(0);
    // Unix 权限写入 external attributes 的高 16 位
    writer.u32((item.mode << 16) >>> 0);
    writer.u32(item.localHeaderOffset);
    writer.push(item.fileNameBytes);
  }

  const directorySize = writer.offset - directoryOffset;

  writer.u32(0x06_05_4b_50);
  writer.u16(0);
  writer.u16(0);
  writer.u16(directory.length);
  writer.u16(directory.length);
  writer.u32(directorySize);
  writer.u32(directoryOffset);
  writer.u16(0);

  return writer.toUint8Array();
}

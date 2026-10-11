/**
 * 二进制数据的统一类型别名。
 *
 * TypeScript 5.7 起 `Uint8Array` 变为泛型 `Uint8Array<TArrayBuffer>`，默认参数是
 * `ArrayBufferLike`（含 `SharedArrayBuffer`），因此 `Uint8Array` 不能再被赋给
 * `BlobPart` 或 `BufferSource`——它们都要求 `ArrayBufferView<ArrayBuffer>`。
 *
 * 本项目所有由 `new Uint8Array(...)` / WebCrypto / CompressionStream 产出的二进制
 * 数据底层都是独立的 `ArrayBuffer`，统一用这个别名标注，避免在每处调用点写断言。
 *
 * 该文件同时被浏览器端（src/lib/zip.ts、src/lib/archive.ts）与 Worker 端
 * （worker/lib/bytes.ts re-export）引用，因此不能依赖任何运行时环境。
 */
export type Bytes = Uint8Array<ArrayBuffer>;

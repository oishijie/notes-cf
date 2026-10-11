import assert from "node:assert/strict";
import test from "node:test";
import {
  inferImageExtension,
  isImageBedUrl,
  parseImageBedHosts,
} from "../../src/lib/image-bed.js";

const ALLOWED = "imgbed.058823.xyz";

test("图床白名单按主机名精确匹配，空格与大小写归一", () => {
  assert.deepEqual(
    parseImageBedHosts(" ImgBed.058823.xyz , ,cdn.example.com "),
    ["imgbed.058823.xyz", "cdn.example.com"],
  );

  assert.equal(
    isImageBedUrl(
      "https://imgbed.058823.xyz/file/1791695838581_2026-10-11_12_06_13-Greenshot.png",
      ALLOWED,
    ),
    true,
  );
  assert.equal(
    isImageBedUrl("https://IMGBED.058823.xyz/file/a.png?width=1200#preview", ALLOWED),
    true,
  );
  // 端口不影响主机名比对
  assert.equal(
    isImageBedUrl("https://imgbed.058823.xyz:8443/file/a.png", ALLOWED),
    true,
  );
});

test("未命中或非法地址不保留外链，保持转存 R2 的原有行为", () => {
  assert.equal(isImageBedUrl("https://notes.cro.cc.cd/images/a.png", ALLOWED), false);
  // 前缀/后缀伪装成白名单域名的地址必须被拒绝
  assert.equal(
    isImageBedUrl("https://imgbed.058823.xyz.evil.test/a.png", ALLOWED),
    false,
  );
  assert.equal(
    isImageBedUrl("https://evil.test/imgbed.058823.xyz/a.png", ALLOWED),
    false,
  );
  assert.equal(isImageBedUrl("ftp://imgbed.058823.xyz/a.png", ALLOWED), false);
  assert.equal(isImageBedUrl("not-a-url", ALLOWED), false);
  // 白名单未配置时恒为 false
  assert.equal(isImageBedUrl("https://imgbed.058823.xyz/a.png", ""), false);
  assert.equal(isImageBedUrl("https://imgbed.058823.xyz/a.png", undefined), false);
});

test("命中白名单时补齐导入结果需要的扩展名，取不到则回退 png", () => {
  assert.equal(
    inferImageExtension(
      "https://imgbed.058823.xyz/file/1791695838581_2026-10-11_12_06_13-Greenshot.png",
    ),
    "png",
  );
  assert.equal(
    inferImageExtension("https://imgbed.058823.xyz/file/photo.JPEG"),
    "jpeg",
  );
  assert.equal(
    inferImageExtension("https://imgbed.058823.xyz/file/no-extension"),
    "png",
  );
  assert.equal(inferImageExtension("https://imgbed.058823.xyz/browse/2026/10"), "png");
  assert.equal(inferImageExtension("not-a-url"), "png");
});

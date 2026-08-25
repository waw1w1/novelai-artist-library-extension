import assert from "node:assert/strict";
import test from "node:test";

import {
  blobToDataUrl,
  dataUrlToFile,
  extractImageMetadata,
  parsePngTextChunks,
  sha256Blob,
} from "../extension/src/metadata.js";
import {
  buildPromptSnapshot,
  classifyPromptContext,
  formatPromptSnapshot,
  prependPromptText,
  selectSnapshotActionPrompt,
} from "../extension/src/novelai.js";

const encoder = new TextEncoder();
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function concatBytes(...parts) {
  const normalized = parts.map((part) =>
    part instanceof Uint8Array ? part : new Uint8Array(part),
  );
  const output = new Uint8Array(
    normalized.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of normalized) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function uint32(value, littleEndian = false) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, littleEndian);
  return bytes;
}

function uint16(value, littleEndian = false) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, littleEndian);
  return bytes;
}

function pngChunk(type, data = new Uint8Array()) {
  return concatBytes(
    uint32(data.byteLength),
    encoder.encode(type),
    data,
    // 解析器不依赖 CRC；测试的重点是 metadata 字节边界与文本编码。
    new Uint8Array(4),
  );
}

function textChunk(keyword, text) {
  return pngChunk(
    "tEXt",
    concatBytes(encoder.encode(keyword), Uint8Array.of(0), encoder.encode(text)),
  );
}

function internationalTextChunk(keyword, text) {
  return pngChunk(
    "iTXt",
    concatBytes(
      encoder.encode(keyword),
      Uint8Array.of(0, 0, 0),
      // languageTag 结束符、translatedKeyword 结束符
      Uint8Array.of(0, 0),
      encoder.encode(text),
    ),
  );
}

function sampleNovelAiPng() {
  const comment = JSON.stringify({
    prompt: "artist:test, 1girl, 星空",
    uc: "lowres",
    seed: 123456,
    steps: 28,
    width: 832,
    height: 1216,
    sampler: "k_euler",
  });
  return concatBytes(
    PNG_SIGNATURE,
    pngChunk("IHDR", new Uint8Array(13)),
    textChunk("Software", "NovelAI"),
    textChunk("Description", "fallback description"),
    internationalTextChunk("Comment", comment),
    pngChunk("IEND"),
  );
}

function tiffWithImageDescription(description) {
  const text = concatBytes(encoder.encode(description), Uint8Array.of(0));
  const valueOffset = 8 + 2 + 12 + 4;
  return concatBytes(
    encoder.encode("II"),
    uint16(42, true),
    uint32(8, true),
    uint16(1, true),
    uint16(0x010e, true),
    uint16(2, true),
    uint32(text.byteLength, true),
    uint32(valueOffset, true),
    uint32(0, true),
    text,
  );
}

function webpChunk(type, data) {
  return concatBytes(
    encoder.encode(type),
    uint32(data.byteLength, true),
    data,
    data.byteLength % 2 ? Uint8Array.of(0) : new Uint8Array(),
  );
}

function sampleNovelAiWebp() {
  const exif = tiffWithImageDescription("artist:webp, 1boy");
  const chunk = webpChunk("EXIF", exif);
  return concatBytes(
    encoder.encode("RIFF"),
    uint32(4 + chunk.byteLength, true),
    encoder.encode("WEBP"),
    chunk,
  );
}

test("sha256Blob 对原始字节计算标准 SHA-256", async () => {
  const hash = await sha256Blob(new Blob([encoder.encode("abc")]));
  assert.equal(
    hash,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("Blob -> data URL -> File 往返保持每一个字节", async () => {
  const originalBytes = sampleNovelAiPng();
  const original = new File([originalBytes], "source.png", {
    type: "image/png",
    lastModified: 1234,
  });
  const dataUrl = await blobToDataUrl(original);
  const restored = dataUrlToFile(dataUrl, "restored.png", 5678);

  assert.equal(restored.name, "restored.png");
  assert.equal(restored.type, "image/png");
  assert.equal(restored.lastModified, 5678);
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), originalBytes);
  assert.equal(await sha256Blob(restored), await sha256Blob(original));

  const reusedBufferUrl = await blobToDataUrl(originalBytes.buffer, "image/png");
  const reusedBufferFile = dataUrlToFile(reusedBufferUrl, "buffer.png", 42);
  assert.deepEqual(new Uint8Array(await reusedBufferFile.arrayBuffer()), originalBytes);
});

test("解析 PNG tEXt/iTXt 并提取 NovelAI 正向提示词和摘要", () => {
  const bytes = sampleNovelAiPng();
  const entries = parsePngTextChunks(bytes);

  assert.deepEqual(entries.map((entry) => entry.type), ["tEXt", "tEXt", "iTXt"]);
  assert.equal(entries[2].keyword, "Comment");
  assert.match(entries[2].text, /星空/u);

  const metadata = extractImageMetadata(bytes.buffer, "image/png");
  assert.equal(metadata.hasMetadata, true);
  assert.equal(metadata.prompt, "artist:test, 1girl, 星空");
  assert.match(metadata.summary, /NovelAI/u);
  assert.match(metadata.summary, /Seed 123456/u);
  assert.match(metadata.summary, /832×1216/u);
  assert.equal(metadata.rawEntries.length, 3);
});

test("解析 WebP EXIF ImageDescription 提示词", () => {
  const bytes = sampleNovelAiWebp();
  const metadata = extractImageMetadata(bytes, "image/webp");

  assert.equal(metadata.hasMetadata, true);
  assert.equal(metadata.prompt, "artist:webp, 1boy");
  assert.equal(metadata.rawEntries[0].type, "EXIF");
  assert.equal(metadata.rawEntries[0].keyword, "ImageDescription");
  assert.match(metadata.summary, /WebP 元数据/u);

  const wrongMime = extractImageMetadata(bytes, "image/png");
  assert.equal(wrongMime.prompt, "artist:webp, 1boy");
});

test("无 metadata 与截断 PNG 均安全返回", () => {
  const noMetadata = extractImageMetadata(
    concatBytes(PNG_SIGNATURE, pngChunk("IEND")),
    "image/png",
  );
  assert.deepEqual(noMetadata, {
    hasMetadata: false,
    prompt: "",
    summary: "未检测到图片元数据",
    rawEntries: [],
  });

  const truncated = concatBytes(PNG_SIGNATURE, uint32(999), encoder.encode("tEXt"));
  assert.doesNotThrow(() => extractImageMetadata(truncated, "image/png"));
  assert.equal(extractImageMetadata(truncated, "image/png").hasMetadata, false);
});

test("提示词快照包含主提示词和全部角色，格式便于复制", () => {
  const snapshot = buildPromptSnapshot("artist:a, scenery", [
    { label: "角色 1", prompt: "1girl, red hair" },
    "1boy, black hair",
  ]);

  assert.equal(snapshot.mainPrompt, "artist:a, scenery");
  assert.deepEqual(snapshot.characterPrompts, ["1girl, red hair", "1boy, black hair"]);
  assert.equal(
    formatPromptSnapshot(snapshot),
    "【主提示词】\nartist:a, scenery\n\n【角色 1】\n1girl, red hair\n\n【角色 2】\n1boy, black hair",
  );
  assert.equal(prependPromptText("artist:new", "1girl"), "artist:new, 1girl");
  assert.equal(classifyPromptContext("Character 2 Prompt"), "character");
  assert.equal(classifyPromptContext("prompt-input-box-character-prompts-1"), "character");
  assert.equal(classifyPromptContext("Add Character"), "unknown");
  assert.equal(classifyPromptContext("prompt-input-box-base-prompt"), "main");
  assert.equal(classifyPromptContext("Undesired Content Prompt"), "negative");
});

test("可执行提示词选择不会混入快照标题，多个角色时保守拒绝", () => {
  const snapshot = buildPromptSnapshot("artist:a, scenery", [
    { label: "角色 1", prompt: "1girl, red hair" },
  ]);
  assert.deepEqual(selectSnapshotActionPrompt(snapshot, "artist"), {
    ok: true,
    prompt: "artist:a, scenery",
  });
  assert.deepEqual(selectSnapshotActionPrompt(snapshot, "character"), {
    ok: true,
    prompt: "1girl, red hair",
  });
  const multiple = buildPromptSnapshot("main", ["character one", "character two"]);
  const rejected = selectSnapshotActionPrompt(multiple, "character");
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /多个角色/u);
  assert.doesNotMatch(snapshot.mainPrompt, /【主提示词】/u);
});

test("超大 PNG 文本块只标记存在但不解码内容", () => {
  const oversizedText = new Uint8Array(1024 * 1024 + 1);
  oversizedText.fill(65);
  const bytes = concatBytes(
    PNG_SIGNATURE,
    pngChunk("tEXt", concatBytes(encoder.encode("Comment"), Uint8Array.of(0), oversizedText)),
    pngChunk("IEND"),
  );
  const metadata = extractImageMetadata(bytes, "image/png");
  assert.equal(metadata.hasMetadata, true);
  assert.equal(metadata.prompt, "");
  assert.equal(metadata.rawEntries[0].oversized, true);
  assert.match(metadata.summary, /过大未解析/u);
});

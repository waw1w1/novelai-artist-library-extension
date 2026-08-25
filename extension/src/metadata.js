const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const UTF8_DECODER = new TextDecoder("utf-8");
const MAX_TEXT_BLOCK_BYTES = 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_JSON_NODES = 10_000;
const MAX_PROMPT_CHARACTERS = 256 * 1024;
let UTF8_FATAL_DECODER;

try {
  UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });
} catch {
  UTF8_FATAL_DECODER = null;
}

const EXIF_TAG_NAMES = new Map([
  [0x010e, "ImageDescription"],
  [0x0131, "Software"],
  [0x8298, "Copyright"],
  [0x9286, "UserComment"],
  [0x9c9b, "XPTitle"],
  [0x9c9c, "XPComment"],
  [0x9c9d, "XPAuthor"],
  [0x9c9e, "XPKeywords"],
  [0x9c9f, "XPSubject"],
]);

const TIFF_TYPE_SIZES = new Map([
  [1, 1],
  [2, 1],
  [3, 2],
  [4, 4],
  [5, 8],
  [7, 1],
  [9, 4],
  [10, 8],
]);

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("需要 Blob、ArrayBuffer 或 TypedArray");
}

async function readBinary(value) {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  return toUint8Array(value);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  if (typeof btoa === "function") {
    return btoa(binary);
  }

  if (globalThis.Buffer) {
    return globalThis.Buffer.from(bytes).toString("base64");
  }

  throw new Error("当前环境不支持 Base64 编码");
}

function base64ToBytes(value) {
  const normalized = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");

  if (typeof atob === "function") {
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  if (globalThis.Buffer) {
    return new Uint8Array(globalThis.Buffer.from(normalized, "base64"));
  }

  throw new Error("当前环境不支持 Base64 解码");
}

function percentEncodedToBytes(value) {
  const output = [];
  const encoder = new TextEncoder();

  for (let index = 0; index < value.length; index += 1) {
    if (
      value[index] === "%" &&
      index + 2 < value.length &&
      /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))
    ) {
      output.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    const codePoint = value.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    output.push(...encoder.encode(character));
    if (codePoint > 0xffff) {
      index += 1;
    }
  }

  return new Uint8Array(output);
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    throw new TypeError("不是有效的 data URL");
  }

  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new TypeError("data URL 缺少数据部分");
  }

  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const segments = header.split(";");
  const isBase64 = segments.some((segment) => segment.toLowerCase() === "base64");
  const mediaType = segments[0] || "text/plain;charset=us-ascii";

  return {
    mediaType,
    bytes: isBase64 ? base64ToBytes(payload) : percentEncodedToBytes(payload),
  };
}

/**
 * 计算原始 Blob/File 或二进制数据的 SHA-256，不进行图片解码或重编码。
 */
export async function sha256Blob(blob) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("当前环境不支持 Web Crypto SHA-256");
  }

  const bytes = await readBinary(blob);
  const digest = await subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return bytesToHex(new Uint8Array(digest));
}

/**
 * 将 Blob/File 或已读取的二进制原样转为 data URL。Base64 只改变表示方式，
 * 不改变图片字节。传入 ArrayBuffer 可避免再次读取大文件。
 */
export async function blobToDataUrl(blob, mimeType = "") {
  if (typeof Blob !== "undefined" && blob instanceof Blob && typeof FileReader === "function") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)));
      reader.addEventListener("error", () => reject(reader.error || new Error("读取图片失败")));
      reader.addEventListener("abort", () => reject(new DOMException("读取已取消", "AbortError")));
      reader.readAsDataURL(blob);
    });
  }

  const bytes = await readBinary(blob);
  const detectedType = (typeof Blob !== "undefined" && blob instanceof Blob ? blob.type : mimeType) || "application/octet-stream";
  return `data:${detectedType};base64,${bytesToBase64(bytes)}`;
}

/**
 * 从 data URL 恢复 File。文件内容由 data URL 字节直接构造，不经过 Canvas。
 */
export function dataUrlToFile(dataUrl, name = "image", lastModified = Date.now()) {
  const { mediaType, bytes } = parseDataUrl(dataUrl);
  return new File([bytes], String(name || "image"), {
    type: mediaType,
    lastModified: Number.isFinite(Number(lastModified)) ? Number(lastModified) : Date.now(),
  });
}

function matchesPrefix(bytes, prefix, offset = 0) {
  if (offset < 0 || offset + prefix.length > bytes.length) {
    return false;
  }
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function decodeAscii(bytes) {
  return String.fromCharCode(...bytes);
}

function decodeLatin1(bytes) {
  let value = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return value;
}

function decodeUtf8(bytes, fatal = false) {
  try {
    if (fatal && UTF8_FATAL_DECODER) {
      return UTF8_FATAL_DECODER.decode(bytes);
    }
    return UTF8_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function decodePngText(bytes) {
  const latin1 = decodeLatin1(bytes);
  if (!bytes.some((byte) => byte >= 0x80)) {
    return { text: latin1, encoding: "latin1" };
  }

  const utf8 = decodeUtf8(bytes, true);
  if (utf8 !== null && /[^\u0000-\u007f]/u.test(utf8)) {
    return { text: utf8, encoding: "utf8-compatible" };
  }

  return { text: latin1, encoding: "latin1" };
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/^\ufeff/u, "")
    .replace(/\u0000+$/gu, "")
    .trim();
}

function readNullTerminated(bytes, start) {
  const end = bytes.indexOf(0, start);
  if (end < 0) {
    return null;
  }
  return { bytes: bytes.subarray(start, end), next: end + 1 };
}

function parseTextChunk(data, offset, length) {
  const keywordPart = readNullTerminated(data, 0);
  if (!keywordPart || keywordPart.bytes.length === 0 || keywordPart.bytes.length > 79) {
    return null;
  }

  const decoded = decodePngText(data.subarray(keywordPart.next));
  return {
    container: "png",
    type: "tEXt",
    keyword: decodeLatin1(keywordPart.bytes),
    text: cleanText(decoded.text),
    encoding: decoded.encoding,
    compressed: false,
    offset,
    length,
  };
}

function parseInternationalTextChunk(data, offset, length) {
  const keywordPart = readNullTerminated(data, 0);
  if (!keywordPart || keywordPart.bytes.length === 0 || keywordPart.bytes.length > 79 || keywordPart.next + 2 > data.length) {
    return null;
  }

  const compressionFlag = data[keywordPart.next];
  const compressionMethod = data[keywordPart.next + 1];
  const languagePart = readNullTerminated(data, keywordPart.next + 2);
  if (!languagePart) {
    return null;
  }

  const translatedPart = readNullTerminated(data, languagePart.next);
  if (!translatedPart) {
    return null;
  }

  const textBytes = data.subarray(translatedPart.next);
  const compressed = compressionFlag === 1;

  return {
    container: "png",
    type: "iTXt",
    keyword: decodeLatin1(keywordPart.bytes),
    text: compressed ? null : cleanText(decodeUtf8(textBytes) || ""),
    encoding: "utf8",
    compressed,
    compressionMethod,
    languageTag: decodeAscii(languagePart.bytes),
    translatedKeyword: cleanText(decodeUtf8(translatedPart.bytes) || ""),
    compressedByteLength: compressed ? textBytes.length : 0,
    offset,
    length,
  };
}

/**
 * 同步解析 PNG 的 tEXt/iTXt。压缩 iTXt 会被识别并保留摘要信息，但不会在此处重写图片。
 */
export function parsePngTextChunks(input) {
  const bytes = toUint8Array(input);
  if (!matchesPrefix(bytes, PNG_SIGNATURE)) {
    return [];
  }

  const entries = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = PNG_SIGNATURE.length;
  let parsedTextBytes = 0;

  while (cursor + 12 <= bytes.length) {
    const length = view.getUint32(cursor, false);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) {
      break;
    }

    const type = decodeAscii(bytes.subarray(cursor + 4, cursor + 8));
    const data = bytes.subarray(dataStart, dataEnd);
    let entry = null;

    if (type === "tEXt" || type === "iTXt") {
      if (length > MAX_TEXT_BLOCK_BYTES || parsedTextBytes + length > MAX_TOTAL_TEXT_BYTES) {
        entry = { container: "png", type, keyword: null, text: null, oversized: true, offset: cursor, length };
      } else {
        parsedTextBytes += length;
        entry = type === "tEXt"
          ? parseTextChunk(data, cursor, length)
          : parseInternationalTextChunk(data, cursor, length);
      }
    }

    if (entry) {
      entries.push(entry);
    }

    cursor = chunkEnd;
    if (type === "IEND") {
      break;
    }
  }

  return entries;
}

function decodeUtf16(bytes, littleEndian) {
  if (bytes.length < 2) {
    return "";
  }

  const evenBytes = bytes.subarray(0, bytes.length - (bytes.length % 2));
  const view = new DataView(evenBytes.buffer, evenBytes.byteOffset, evenBytes.byteLength);
  let value = "";
  for (let offset = 0; offset < evenBytes.length; offset += 2) {
    const codeUnit = view.getUint16(offset, littleEndian);
    if (codeUnit !== 0) {
      value += String.fromCharCode(codeUnit);
    }
  }
  return value;
}

function decodeExifUserComment(bytes, littleEndian) {
  if (bytes.length >= 8) {
    const prefix = decodeAscii(bytes.subarray(0, 8));
    const payload = bytes.subarray(8);
    if (prefix.startsWith("ASCII")) {
      return cleanText(decodeLatin1(payload));
    }
    if (prefix.startsWith("UNICODE")) {
      const hasLittleEndianBom = payload[0] === 0xff && payload[1] === 0xfe;
      const hasBigEndianBom = payload[0] === 0xfe && payload[1] === 0xff;
      return cleanText(
        decodeUtf16(
          hasLittleEndianBom || hasBigEndianBom ? payload.subarray(2) : payload,
          hasLittleEndianBom || (!hasBigEndianBom && littleEndian),
        ),
      );
    }
  }

  const utf8 = decodeUtf8(bytes, true);
  return cleanText(utf8 ?? decodeLatin1(bytes));
}

function extractJsonSubstring(value) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }

  const candidate = value.slice(start, end + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function parseExifTextEntries(input, container, chunkOffset = 0) {
  const source = toUint8Array(input);
  if (source.byteLength > MAX_TEXT_BLOCK_BYTES) {
    return [{ container, type: "EXIF", keyword: null, text: null, oversized: true, offset: chunkOffset, length: source.byteLength }];
  }
  let tiffStart = 0;
  if (source.length >= 6 && decodeAscii(source.subarray(0, 6)) === "Exif\u0000\u0000") {
    tiffStart = 6;
  }

  if (tiffStart + 8 > source.length) {
    return [];
  }

  const byteOrder = decodeAscii(source.subarray(tiffStart, tiffStart + 2));
  if (byteOrder !== "II" && byteOrder !== "MM") {
    const decoded = cleanText(decodeUtf8(source) || "");
    const json = extractJsonSubstring(decoded);
    return json
      ? [{ container, type: "EXIF", keyword: "UserComment", text: json, offset: chunkOffset }]
      : [];
  }

  const littleEndian = byteOrder === "II";
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const readU16 = (offset) => view.getUint16(offset, littleEndian);
  const readU32 = (offset) => view.getUint32(offset, littleEndian);
  if (readU16(tiffStart + 2) !== 42) {
    return [];
  }

  const entries = [];
  const visited = new Set();

  const parseIfd = (relativeOffset, depth = 0) => {
    if (depth > 4 || visited.has(relativeOffset)) {
      return;
    }
    visited.add(relativeOffset);

    const ifdOffset = tiffStart + relativeOffset;
    if (ifdOffset < tiffStart || ifdOffset + 2 > source.length) {
      return;
    }

    const count = readU16(ifdOffset);
    if (count > 4096 || ifdOffset + 2 + count * 12 > source.length) {
      return;
    }

    for (let index = 0; index < count; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      const tag = readU16(entryOffset);
      const type = readU16(entryOffset + 2);
      const itemCount = readU32(entryOffset + 4);
      const typeSize = TIFF_TYPE_SIZES.get(type);
      if (!typeSize || itemCount > 0x1000000) {
        continue;
      }

      const byteLength = typeSize * itemCount;
      const valueOffset =
        byteLength <= 4 ? entryOffset + 8 : tiffStart + readU32(entryOffset + 8);
      if (valueOffset < tiffStart || valueOffset + byteLength > source.length) {
        continue;
      }

      if (tag === 0x8769 && type === 4 && itemCount >= 1) {
        parseIfd(readU32(valueOffset), depth + 1);
        continue;
      }

      const keyword = EXIF_TAG_NAMES.get(tag);
      if (!keyword) {
        continue;
      }

      const valueBytes = source.subarray(valueOffset, valueOffset + byteLength);
      let text;
      if (tag >= 0x9c9b && tag <= 0x9c9f) {
        text = cleanText(decodeUtf16(valueBytes, true));
      } else if (tag === 0x9286) {
        text = decodeExifUserComment(valueBytes, littleEndian);
      } else if (type === 2) {
        text = cleanText(decodeLatin1(valueBytes));
      } else {
        text = cleanText(decodeUtf8(valueBytes) || decodeLatin1(valueBytes));
      }

      if (text) {
        entries.push({
          container,
          type: "EXIF",
          keyword,
          text,
          offset: chunkOffset + valueOffset,
          length: byteLength,
        });
      }
    }

    const nextOffsetLocation = ifdOffset + 2 + count * 12;
    if (nextOffsetLocation + 4 <= source.length) {
      const nextOffset = readU32(nextOffsetLocation);
      if (nextOffset) {
        parseIfd(nextOffset, depth + 1);
      }
    }
  };

  parseIfd(readU32(tiffStart + 4));
  return entries;
}

function parsePngEntries(bytes) {
  const entries = [...parsePngTextChunks(bytes)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = PNG_SIGNATURE.length;

  while (cursor + 12 <= bytes.length) {
    const length = view.getUint32(cursor, false);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) {
      break;
    }

    const type = decodeAscii(bytes.subarray(cursor + 4, cursor + 8));
    if (type === "eXIf") {
      const exifEntries = parseExifTextEntries(bytes.subarray(dataStart, dataEnd), "png", dataStart);
      entries.push(
        ...(exifEntries.length
          ? exifEntries
          : [{
              container: "png",
              type: "eXIf",
              keyword: null,
              text: null,
              offset: cursor,
              length,
            }]),
      );
    } else if (type === "zTXt") {
      const keywordPart = readNullTerminated(bytes.subarray(dataStart, dataEnd), 0);
      entries.push({
        container: "png",
        type: "zTXt",
        keyword: keywordPart ? decodeLatin1(keywordPart.bytes) : null,
        text: null,
        compressed: true,
        offset: cursor,
        length,
      });
    }

    cursor = chunkEnd;
    if (type === "IEND") {
      break;
    }
  }

  return entries;
}

function isWebp(bytes) {
  return (
    bytes.length >= 12 &&
    decodeAscii(bytes.subarray(0, 4)) === "RIFF" &&
    decodeAscii(bytes.subarray(8, 12)) === "WEBP"
  );
}

function parseWebpEntries(bytes) {
  if (!isWebp(bytes)) {
    return [];
  }

  const entries = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 12;

  while (cursor + 8 <= bytes.length) {
    const type = decodeAscii(bytes.subarray(cursor, cursor + 4));
    const length = view.getUint32(cursor + 4, true);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    if (dataEnd < dataStart || dataEnd > bytes.length) {
      break;
    }

    if (type === "EXIF") {
      const exifEntries = parseExifTextEntries(bytes.subarray(dataStart, dataEnd), "webp", dataStart);
      entries.push(
        ...(exifEntries.length
          ? exifEntries
          : [{
              container: "webp",
              type: "EXIF",
              keyword: null,
              text: null,
              offset: cursor,
              length,
            }]),
      );
    } else if (type === "XMP ") {
      entries.push({
        container: "webp",
        type: "XMP",
        keyword: "XML:com.adobe.xmp",
        text: length <= MAX_TEXT_BLOCK_BYTES ? cleanText(decodeUtf8(bytes.subarray(dataStart, dataEnd)) || "") : null,
        oversized: length > MAX_TEXT_BLOCK_BYTES,
        offset: cursor,
        length,
      });
    } else if (type === "ICCP") {
      entries.push({
        container: "webp",
        type: "ICCP",
        keyword: null,
        text: null,
        offset: cursor,
        length,
      });
    }

    cursor = dataEnd + (length % 2);
  }

  return entries;
}

function tryParseJson(value) {
  const text = cleanText(value);
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const json = extractJsonSubstring(text);
    if (!json) {
      return null;
    }
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
}

function normalizedKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function inspectJsonMetadata(root) {
  const promptCandidates = [];
  const settings = {};
  const visited = new Set();
  let visitedNodes = 0;

  const visit = (value, path = [], depth = 0) => {
    if (!value || typeof value !== "object" || depth > 8 || visited.has(value) || visitedNodes >= MAX_JSON_NODES) {
      return;
    }
    visited.add(value);
    visitedNodes += 1;

    for (const [key, child] of Object.entries(value)) {
      const keyName = normalizedKey(key);
      const nextPath = [...path, keyName];
      const pathText = nextPath.join(".");
      const isNegative = /negative|undesired|(^|\.)uc($|\.)/.test(pathText);

      if (typeof child === "string" && !isNegative) {
        let score = 0;
        if (keyName === "prompt" || keyName === "positiveprompt") {
          score = 120;
        } else if (keyName === "basecaption") {
          score = 115;
        } else if (keyName === "description") {
          score = 90;
        }

        const text = cleanText(child);
        if (score && text) {
          promptCandidates.push({ text: Array.from(text).slice(0, MAX_PROMPT_CHARACTERS).join(""), score: score - depth, source: pathText });
        }
      }

      const settingAliases = {
        seed: "seed",
        steps: "steps",
        sampler: "sampler",
        scale: "scale",
        cfgscale: "scale",
        width: "width",
        height: "height",
        model: "model",
        software: "software",
        source: "source",
      };
      const settingName = settingAliases[keyName];
      if (
        settingName &&
        settings[settingName] === undefined &&
        (typeof child === "string" || typeof child === "number")
      ) {
        settings[settingName] = child;
      }

      if (child && typeof child === "object") {
        visit(child, nextPath, depth + 1);
      }
    }
  };

  visit(root);
  promptCandidates.sort((left, right) => right.score - left.score);
  return { prompt: promptCandidates[0]?.text || "", settings };
}

function promptFromParameters(value) {
  const text = cleanText(value);
  if (!text) {
    return "";
  }
  const negativeIndex = text.search(/\n\s*negative prompt\s*:/i);
  const settingsIndex = text.search(/\n\s*steps\s*:/i);
  const end = [negativeIndex, settingsIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  return cleanText(end === undefined ? text : text.slice(0, end));
}

function extractPromptAndSettings(entries) {
  const candidates = [];
  const settings = {};

  for (const entry of entries) {
    if (!entry.text) {
      continue;
    }

    const keyword = normalizedKey(entry.keyword || "");
    const parsed = tryParseJson(entry.text);
    if (parsed) {
      const inspected = inspectJsonMetadata(parsed);
      if (inspected.prompt) {
        candidates.push({ text: inspected.prompt, score: 130 });
      }
      Object.assign(settings, { ...inspected.settings, ...settings });
    }

    if (keyword === "prompt" || keyword === "positiveprompt") {
      candidates.push({ text: cleanText(entry.text), score: 125 });
    } else if (keyword === "description" || keyword === "imagedescription") {
      candidates.push({ text: cleanText(entry.text), score: 110 });
    } else if (keyword === "parameters") {
      const prompt = promptFromParameters(entry.text);
      if (prompt) {
        candidates.push({ text: prompt, score: 100 });
      }
    }

    if ((keyword === "software" || keyword === "source") && !settings[keyword]) {
      settings[keyword] = cleanText(entry.text);
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return { prompt: candidates[0]?.text || "", settings };
}

function buildSummary(format, entries, prompt, settings) {
  if (!entries.length) {
    return "未检测到图片元数据";
  }

  const parts = [];
  const producer = settings.software || settings.source;
  if (producer) {
    parts.push(String(producer));
  } else {
    parts.push(format === "png" ? "PNG 元数据" : format === "webp" ? "WebP 元数据" : "图片元数据");
  }

  if (prompt) {
    parts.push(`提示词 ${Array.from(prompt).length} 字`);
  }
  if (settings.seed !== undefined) {
    parts.push(`Seed ${settings.seed}`);
  }
  if (settings.width !== undefined && settings.height !== undefined) {
    parts.push(`${settings.width}×${settings.height}`);
  }
  if (settings.steps !== undefined) {
    parts.push(`${settings.steps} Steps`);
  }
  if (settings.sampler !== undefined) {
    parts.push(String(settings.sampler));
  }
  parts.push(`${entries.length} 项`);
  if (entries.some((entry) => entry.oversized)) parts.push("部分 metadata 过大未解析");
  return parts.join(" · ");
}

/**
 * 从 PNG/WebP 原始字节中提取可显示的 NovelAI 提示词与元数据摘要。
 * 此函数只读取字节，绝不修改或重编码传入图片。
 */
export function extractImageMetadata(arrayBuffer, mimeType = "") {
  const bytes = toUint8Array(arrayBuffer);
  const normalizedMime = String(mimeType).toLowerCase();
  let format = "unknown";
  let rawEntries = [];

  if (matchesPrefix(bytes, PNG_SIGNATURE)) {
    format = "png";
    rawEntries = parsePngEntries(bytes);
  } else if (isWebp(bytes)) {
    format = "webp";
    rawEntries = parseWebpEntries(bytes);
  } else if (normalizedMime.includes("png")) {
    format = "png";
  } else if (normalizedMime.includes("webp")) {
    format = "webp";
  }

  let textBytes = 0;
  rawEntries = rawEntries.map((entry) => {
    const length = Number(entry.length) || 0;
    if (!entry.text) return entry;
    if (textBytes + length > MAX_TOTAL_TEXT_BYTES) return { ...entry, text: null, oversized: true };
    textBytes += length;
    return entry;
  });
  const extracted = extractPromptAndSettings(rawEntries);
  const prompt = Array.from(extracted.prompt).slice(0, MAX_PROMPT_CHARACTERS).join("");
  const { settings } = extracted;
  return {
    hasMetadata: rawEntries.length > 0,
    prompt,
    summary: buildSummary(format, rawEntries, prompt, settings),
    rawEntries,
  };
}

export const blobToDataURL = blobToDataUrl;
export const dataURLToFile = dataUrlToFile;
export const sha256Hex = sha256Blob;

import {
  IMAGES_DIRECTORY_NAME,
  LIBRARY_FILE_NAME,
  LibraryStorageError,
  getDirectoryRecord,
  queryDirectoryPermission,
  readImageFile,
  readLibrary,
  removeImageFile,
  sha256Hex,
  writeImageVerified,
  writeLibrary,
  withLibraryReadLock,
  withLibraryWriteLock,
} from "./src/directory-db.js";
import { removeItemFromManifest } from "./src/core.js";

class RequestError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "RequestError";
    this.code = code;
  }
}

const TYPE_ALIASES = new Map([
  ["GET-STATUS", "GET_STATUS"],
  ["GET-LIBRARY", "GET_LIBRARY"],
  ["GET-FILE", "GET_FILE"],
  ["IMPORT-ITEM", "IMPORT_ITEM"],
  ["UPDATE-ITEM", "UPDATE_ITEM"],
  ["DELETE-ITEM", "DELETE_ITEM"],
  ["TOGGLE-FAVORITE", "TOGGLE_FAVORITE"],
  ["REORDER", "REORDER_ITEMS"],
  ["REORDER-ITEMS", "REORDER_ITEMS"],
  ["SET-UI", "SET_UI_STATE"],
  ["SET-UI-STATE", "SET_UI_STATE"],
  ["OPEN-SETTINGS", "OPEN_SETTINGS"],
]);

const MUTATING_TYPES = new Set([
  "IMPORT_ITEM",
  "UPDATE_ITEM",
  "DELETE_ITEM",
  "TOGGLE_FAVORITE",
  "REORDER_ITEMS",
  "SET_UI_STATE",
]);

const READING_TYPES = new Set(["GET_STATUS", "GET_LIBRARY", "GET_FILE"]);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TITLE_LENGTH = 100;
const MAX_PROMPT_LENGTH = 256 * 1024;
const MAX_METADATA_SUMMARY_LENGTH = 4 * 1024;

let mutationQueue = Promise.resolve();

function enqueueMutation(operation) {
  const guardedOperation = () => withLibraryWriteLock(operation);
  const result = mutationQueue.then(guardedOperation, guardedOperation);
  mutationQueue = result.catch(() => undefined);
  return result;
}

function normalizeRequestType(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toUpperCase().replaceAll(" ", "_");
  return TYPE_ALIASES.get(normalized) || normalized.replaceAll("-", "_");
}

function asPayload(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new RequestError("REQUEST_INVALID", "请求必须是对象");
  }
  if (request.payload === undefined) {
    return {};
  }
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) {
    throw new RequestError("PAYLOAD_INVALID", "payload 必须是对象");
  }
  return request.payload;
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new RequestError("PAYLOAD_INVALID", `${field} 必须是字符串`);
  }
  return value;
}

export function requireBoundedString(value, field, maxLength, options) {
  const text = requireString(value, field, options);
  if (Array.from(text).length > maxLength) {
    throw new RequestError("PAYLOAD_TOO_LARGE", `${field} 不能超过 ${maxLength} 个字符`);
  }
  return text;
}

function requireKind(value) {
  if (value !== "artist" && value !== "character") {
    throw new RequestError("KIND_INVALID", "kind 只能是 artist 或 character");
  }
  return value;
}

function generateId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function normalizeSha256(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized = String(value).trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new RequestError("HASH_INVALID", "sha256 必须是 64 位十六进制字符串");
  }
  return normalized;
}

function decodeBase64(base64) {
  const cleaned = base64.replace(/[\r\n\t ]/g, "");
  if (!cleaned || cleaned.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(cleaned)) {
    throw new RequestError("DATA_URL_INVALID", "图片的 Base64 数据无效");
  }

  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  const outputLength = Math.floor((cleaned.length * 3) / 4) - padding;
  if (outputLength > MAX_IMAGE_BYTES) {
    throw new RequestError("IMAGE_TOO_LARGE", "图片不能超过 32 MiB");
  }
  const output = new Uint8Array(outputLength);
  const base64ChunkSize = 4 * 16_384;
  let writeOffset = 0;

  try {
    for (let offset = 0; offset < cleaned.length; offset += base64ChunkSize) {
      const binary = atob(cleaned.slice(offset, offset + base64ChunkSize));
      for (let index = 0; index < binary.length; index += 1) {
        output[writeOffset] = binary.charCodeAt(index);
        writeOffset += 1;
      }
    }
  } catch (error) {
    throw new RequestError("DATA_URL_INVALID", "图片的 Base64 数据无法解码", error);
  }

  if (writeOffset !== output.length) {
    throw new RequestError("DATA_URL_INVALID", "图片的 Base64 长度不正确");
  }
  return output;
}

function parseDataUrl(dataUrl, fallbackMimeType) {
  requireString(dataUrl, "dataUrl");
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    throw new RequestError("DATA_URL_INVALID", "dataUrl 缺少数据分隔符");
  }

  const header = dataUrl.slice(0, commaIndex);
  if (!header.startsWith("data:") || !/;base64(?:;|$)/i.test(header)) {
    throw new RequestError("DATA_URL_INVALID", "dataUrl 必须使用 Base64 编码");
  }

  const declaredMime = header.slice(5).split(";")[0].trim();
  const mimeType = declaredMime || fallbackMimeType || "application/octet-stream";
  return { bytes: decodeBase64(dataUrl.slice(commaIndex + 1)), mimeType };
}

function bytesToBase64(bytes) {
  const byteChunkSize = 3 * 16_384;
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += byteChunkSize) {
    const chunk = bytes.subarray(offset, offset + byteChunkSize);
    let binary = "";
    for (let index = 0; index < chunk.length; index += 1) {
      binary += String.fromCharCode(chunk[index]);
    }
    parts.push(btoa(binary));
  }
  return parts.join("");
}

function safeMimeType(value) {
  if (typeof value === "string" && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)) {
    return value.toLowerCase();
  }
  return "application/octet-stream";
}

function safeOriginalName(value, mimeType) {
  let name = typeof value === "string" ? value.trim() : "";
  name = name.replaceAll("\\", "/").split("/").at(-1) || "";
  name = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 180);
  if (name && name !== "." && name !== "..") {
    return name;
  }
  const extension = extensionForMimeType(mimeType);
  return `image.${extension}`;
}

function extensionForMimeType(mimeType) {
  const mapping = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  };
  return mapping[mimeType] || "bin";
}

function detectedImageMimeType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === "avif" || brand === "avis") {
      return "image/avif";
    }
  }
  return null;
}

function storageFileName(id, originalName, mimeType) {
  const knownExtension = extensionForMimeType(mimeType);
  const extensionMatch = originalName.match(/\.([a-z0-9]{1,10})$/i);
  const extension = (knownExtension !== "bin" ? knownExtension : extensionMatch?.[1] || "bin").toLowerCase();
  return `${id}.${extension}`;
}

export function itemForId(library, id) {
  if (!Object.prototype.hasOwnProperty.call(library.items, id)) {
    throw new RequestError("ITEM_NOT_FOUND", `未找到条目 ${id}`);
  }
  return library.items[id];
}

export function normalizeMetadata(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("METADATA_INVALID", "metadata 必须是对象");
  }
  return {
    hasMetadata: value.hasMetadata === true,
    hasNovelAiMetadata: value.hasNovelAiMetadata === true,
    prompt: requireBoundedString(value.prompt ?? "", "metadata.prompt", MAX_PROMPT_LENGTH, { allowEmpty: true }),
    summary: requireBoundedString(value.summary ?? "", "metadata.summary", MAX_METADATA_SUMMARY_LENGTH, { allowEmpty: true }),
  };
}

async function requireLibraryDirectory() {
  const record = await getDirectoryRecord();
  if (!record) {
    throw new RequestError("DIRECTORY_NOT_CONFIGURED", "请先在扩展设置中选择数据目录");
  }

  const permission = await queryDirectoryPermission(record.handle, "readwrite");
  if (permission !== "granted") {
    throw new RequestError(
      "DIRECTORY_PERMISSION_REQUIRED",
      permission === "prompt" ? "数据目录需要重新授权" : "数据目录访问已被拒绝，请重新授权或更换目录",
    );
  }
  return { record, directoryHandle: record.handle };
}

async function requireLibrary() {
  const context = await requireLibraryDirectory();
  const library = await readLibrary(context.directoryHandle);
  if (!library) {
    throw new RequestError("LIBRARY_MISSING", "数据目录中缺少 library.json，请在设置页点击“检查目录”进行修复");
  }
  return { ...context, library };
}

async function getStatus() {
  let record;
  try {
    record = await getDirectoryRecord();
  } catch (error) {
    return {
      configured: false,
      ready: false,
      permission: "denied",
      code: error.code || "HANDLE_INVALID",
      error: error.message,
    };
  }

  if (!record) {
    return {
      configured: false,
      ready: false,
      permission: "prompt",
      directoryName: null,
      libraryFileName: LIBRARY_FILE_NAME,
      imagesDirectoryName: IMAGES_DIRECTORY_NAME,
    };
  }

  const permission = await queryDirectoryPermission(record.handle, "readwrite");
  const status = {
    configured: true,
    ready: false,
    permission,
    needsAuthorization: permission !== "granted",
    directoryName: record.name || record.handle.name,
    selectedAt: record.selectedAt || null,
    verifiedAt: record.verifiedAt || null,
    libraryFileName: LIBRARY_FILE_NAME,
    imagesDirectoryName: IMAGES_DIRECTORY_NAME,
  };

  if (permission !== "granted") {
    return status;
  }

  try {
    const library = await readLibrary(record.handle);
    if (!library) {
      status.code = "LIBRARY_MISSING";
      status.error = "所选目录中缺少 library.json，请在设置页重新验证";
      return status;
    }
    status.ready = true;
    status.itemCount = Object.keys(library.items).length;
    status.artistCount = Object.values(library.items).filter((item) => item.kind === "artist").length;
    status.characterCount = status.itemCount - status.artistCount;
    status.manifest = library;
    return status;
  } catch (error) {
    status.code = error.code || "LIBRARY_READ_FAILED";
    status.error = error.message;
    return status;
  }
}

async function getLibrary() {
  const { library } = await requireLibrary();
  return library;
}

async function getFile(payload) {
  const id = requireString(payload.id || payload.itemId, "id");
  const { directoryHandle, library } = await requireLibrary();
  const item = itemForId(library, id);
  const fileName = item.imageFile || String(item.imagePath || "").replace(/^images\//, "");
  if (!fileName) {
    throw new RequestError("FILE_NOT_FOUND", `条目 ${id} 没有图片路径`);
  }

  const file = await readImageFile(directoryHandle, fileName);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  if (item.sha256 && sha256 !== String(item.sha256).toLowerCase()) {
    throw new RequestError("FILE_INTEGRITY_ERROR", `图片 ${fileName} 的 SHA-256 与清单不一致`);
  }

  const mimeType = safeMimeType(item.mimeType || file.type);
  return {
    dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
    name: item.originalName || file.name,
    mimeType,
    lastModified: Number.isFinite(item.lastModified) ? item.lastModified : file.lastModified,
    sha256,
  };
}

function normalizedImportPayload(payload) {
  const nestedItem = payload.item && typeof payload.item === "object" ? payload.item : {};
  const nestedFile = payload.file && typeof payload.file === "object" ? payload.file : {};
  const combined = { ...nestedItem, ...payload };
  const mimeType = combined.mimeType || nestedFile.type || null;
  let dataUrl = combined.dataUrl || nestedFile.dataUrl;
  if (!dataUrl && typeof nestedFile.dataBase64 === "string") {
    dataUrl = `data:${safeMimeType(mimeType)};base64,${nestedFile.dataBase64}`;
  }
  return {
    kind: combined.kind,
    title: combined.title,
    actionPrompt: combined.actionPrompt ?? combined.prompt ?? combined.tags,
    originalName: combined.originalName || nestedFile.name,
    mimeType,
    lastModified: combined.lastModified ?? nestedFile.lastModified,
    dataUrl,
    sha256: combined.sha256 ?? nestedFile.sha256,
    metadata: combined.metadata ?? null,
  };
}

async function importItem(payload) {
  const input = normalizedImportPayload(payload);
  const kind = requireKind(input.kind);
  const actionPrompt = requireBoundedString(input.actionPrompt, "actionPrompt", MAX_PROMPT_LENGTH, { allowEmpty: true });
  const parsed = parseDataUrl(input.dataUrl, input.mimeType);
  const detectedMimeType = detectedImageMimeType(parsed.bytes);
  if (!detectedMimeType) {
    throw new RequestError("IMAGE_FORMAT_UNSUPPORTED", "只支持 PNG、JPEG、WebP、GIF 或 AVIF 图片");
  }
  const mimeType = detectedMimeType;
  const originalName = safeOriginalName(input.originalName, mimeType);
  const suppliedHash = normalizeSha256(input.sha256);
  const computedHash = await sha256Hex(parsed.bytes);
  if (suppliedHash && suppliedHash !== computedHash) {
    throw new RequestError("HASH_MISMATCH", "导入图片的 SHA-256 与传入值不一致");
  }

  const { directoryHandle, library } = await requireLibrary();
  const id = generateId();
  const imageFile = storageFileName(id, originalName, mimeType);
  const now = new Date().toISOString();
  const fallbackTitle = originalName.replace(/\.[^.]+$/, "") || (kind === "artist" ? "未命名画师串" : "未命名角色");
  const title = requireBoundedString(
    typeof input.title === "string" && input.title.trim() ? input.title.trim() : fallbackTitle,
    "title",
    MAX_TITLE_LENGTH,
  );
  const item = {
    id,
    kind,
    title,
    actionPrompt,
    originalName,
    mimeType,
    lastModified: Number.isFinite(Number(input.lastModified)) ? Number(input.lastModified) : Date.now(),
    imagePath: `${IMAGES_DIRECTORY_NAME}/${imageFile}`,
    imageFile,
    sha256: computedHash,
    metadata: normalizeMetadata(input.metadata),
    favorite: false,
    favoriteAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await writeImageVerified(directoryHandle, imageFile, parsed.bytes, computedHash);
  try {
    library.items[id] = item;
    library.orders[kind].normalMaster.push(id);
    const manifest = await writeLibrary(directoryHandle, library);
    return { item: manifest.items[id], manifest };
  } catch (error) {
    try {
      await removeImageFile(directoryHandle, imageFile);
    } catch {
      // Preserve the original manifest error; orphan cleanup can be retried manually.
    }
    throw error;
  }
}

async function updateItem(payload) {
  const id = requireString(payload.id || payload.itemId, "id");
  const changes = payload.changes && typeof payload.changes === "object"
    ? payload.changes
    : payload;
  const { directoryHandle, library } = await requireLibrary();
  const item = itemForId(library, id);

  if (changes.kind !== undefined) {
    const nextKind = requireKind(changes.kind);
    if (nextKind !== item.kind) {
      const previousKind = item.kind;
      library.orders[previousKind].normalMaster = library.orders[previousKind].normalMaster.filter(
        (itemId) => itemId !== id,
      );
      library.orders[previousKind].favorites = library.orders[previousKind].favorites.filter(
        (itemId) => itemId !== id,
      );
      library.orders[nextKind].normalMaster.push(id);
      if (item.favorite) {
        library.orders[nextKind].favorites.push(id);
      }
      item.kind = nextKind;
    }
  }

  if (changes.title !== undefined) {
    item.title = requireBoundedString(changes.title, "title", MAX_TITLE_LENGTH).trim();
  }
  const nextPrompt = changes.actionPrompt ?? changes.prompt ?? changes.tags;
  if (nextPrompt !== undefined) {
    item.actionPrompt = requireBoundedString(nextPrompt, "actionPrompt", MAX_PROMPT_LENGTH, { allowEmpty: true });
  }
  if (changes.metadata !== undefined) {
    item.metadata = normalizeMetadata(changes.metadata);
  }
  item.updatedAt = new Date().toISOString();

  const manifest = await writeLibrary(directoryHandle, library);
  return { item: manifest.items[id], manifest };
}

async function deleteItem(payload) {
  const id = requireString(payload.id || payload.itemId, "id");
  const { directoryHandle, library } = await requireLibrary();
  const item = itemForId(library, id);
  const imageFile = item.imageFile || String(item.imagePath || "").replace(/^images\//u, "");
  const nextLibrary = removeItemFromManifest(library, id);
  const manifest = await writeLibrary(directoryHandle, nextLibrary);
  let imageRemoved = !imageFile;
  let warning = null;
  if (imageFile) {
    try {
      await removeImageFile(directoryHandle, imageFile);
      imageRemoved = true;
    } catch (error) {
      warning = `条目已删除，但原图文件清理失败：${error?.message || "未知错误"}`;
    }
  }
  return { removedId: id, imageRemoved, warning, manifest };
}

async function toggleFavorite(payload) {
  const id = requireString(payload.id || payload.itemId, "id");
  const { directoryHandle, library } = await requireLibrary();
  const item = itemForId(library, id);
  const favorites = library.orders[item.kind].favorites;
  const nextFavorite = typeof payload.favorite === "boolean" ? payload.favorite : !item.favorite;

  library.orders[item.kind].favorites = favorites.filter((favoriteId) => favoriteId !== id);
  if (nextFavorite) {
    library.orders[item.kind].favorites.push(id);
    item.favoriteAt = new Date().toISOString();
  } else {
    item.favoriteAt = null;
  }
  item.favorite = nextFavorite;
  item.updatedAt = new Date().toISOString();

  const manifest = await writeLibrary(directoryHandle, library);
  return { item: manifest.items[id], manifest };
}

function ensureExactIds(candidate, expected, fieldName) {
  const ids = Array.isArray(candidate) ? candidate : [];
  if (ids.length !== expected.length || new Set(ids).size !== ids.length) {
    throw new RequestError("ORDER_INVALID", `${fieldName} 必须且只能包含该分组的全部条目`);
  }
  const expectedSet = new Set(expected);
  if (ids.some((id) => typeof id !== "string" || !expectedSet.has(id))) {
    throw new RequestError("ORDER_INVALID", `${fieldName} 含未知条目`);
  }
  return ids;
}

function replaceNormalItems(normalMaster, favoriteSet, orderedNormalIds) {
  let nextIndex = 0;
  return normalMaster.map((id) => {
    if (favoriteSet.has(id)) {
      return id;
    }
    const replacement = orderedNormalIds[nextIndex];
    nextIndex += 1;
    return replacement;
  });
}

function moveWithin(values, id, toIndex) {
  const fromIndex = values.indexOf(id);
  if (fromIndex < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= values.length) {
    throw new RequestError("ORDER_INVALID", "拖动目标位置无效");
  }
  const output = [...values];
  output.splice(fromIndex, 1);
  output.splice(toIndex, 0, id);
  return output;
}

function moveRelative(values, dragId, targetId, position) {
  if (dragId === targetId) {
    return [...values];
  }
  const withoutDragged = values.filter((id) => id !== dragId);
  const targetIndex = withoutDragged.indexOf(targetId);
  if (targetIndex < 0) {
    throw new RequestError("ORDER_INVALID", "拖动目标条目已不存在");
  }
  const insertionIndex = position === "after" ? targetIndex + 1 : targetIndex;
  withoutDragged.splice(insertionIndex, 0, dragId);
  return withoutDragged;
}

async function reorderItems(payload) {
  const { directoryHandle, library } = await requireLibrary();
  const inferredId = payload.itemId || payload.id || payload.dragId;
  const inferredItem = inferredId ? itemForId(library, inferredId) : null;
  const kind = requireKind(payload.kind || inferredItem?.kind);
  const order = library.orders[kind];
  const favorites = [...order.favorites];
  const favoriteSet = new Set(favorites);
  const normalIds = order.normalMaster.filter((id) => !favoriteSet.has(id));
  const allVisible = [...favorites, ...normalIds];

  const targetId = payload.targetId;
  const position = payload.position;
  const fullOrder = payload.orderedIds || (Array.isArray(payload.order) ? payload.order : null);
  if (inferredItem && targetId && ["before", "after", "start", "end"].includes(position)) {
    const targetItem = position === "start" || position === "end"
      ? inferredItem
      : itemForId(library, targetId);
    if (targetItem.kind !== kind || targetItem.favorite !== inferredItem.favorite) {
      throw new RequestError("FAVORITE_BOUNDARY", "只能在同一收藏分区内调整顺序");
    }
    const partition = inferredItem.favorite ? favorites : normalIds;
    let reordered;
    if (position === "start") {
      reordered = [inferredItem.id, ...partition.filter((id) => id !== inferredItem.id)];
    } else if (position === "end") {
      reordered = [...partition.filter((id) => id !== inferredItem.id), inferredItem.id];
    } else {
      reordered = moveRelative(partition, inferredItem.id, targetId, position);
    }
    if (inferredItem.favorite) {
      order.favorites = reordered;
    } else {
      order.normalMaster = replaceNormalItems(order.normalMaster, favoriteSet, reordered);
    }
  } else if (Array.isArray(fullOrder)) {
    const ordered = ensureExactIds(fullOrder, allVisible, "orderedIds");
    const favoriteCount = favorites.length;
    if (
      ordered.slice(0, favoriteCount).some((id) => !favoriteSet.has(id)) ||
      ordered.slice(favoriteCount).some((id) => favoriteSet.has(id))
    ) {
      throw new RequestError("FAVORITE_BOUNDARY", "收藏条目必须保持在普通条目前面");
    }
    order.favorites = ordered.slice(0, favoriteCount);
    order.normalMaster = replaceNormalItems(order.normalMaster, favoriteSet, ordered.slice(favoriteCount));
  } else if (Array.isArray(payload.favorites) || Array.isArray(payload.normalMaster)) {
    if (Array.isArray(payload.favorites)) {
      order.favorites = ensureExactIds(payload.favorites, favorites, "favorites");
    }
    if (Array.isArray(payload.normalMaster)) {
      const incoming = payload.normalMaster;
      if (incoming.length === order.normalMaster.length) {
        const ordered = ensureExactIds(incoming, order.normalMaster, "normalMaster");
        const visible = [...order.favorites, ...ordered.filter((id) => !favoriteSet.has(id))];
        if (visible.slice(0, favorites.length).some((id) => !favoriteSet.has(id))) {
          throw new RequestError("FAVORITE_BOUNDARY", "普通条目不能插到收藏条目前面");
        }
        order.normalMaster = ordered;
      } else {
        const orderedNormals = ensureExactIds(incoming, normalIds, "normalMaster");
        order.normalMaster = replaceNormalItems(order.normalMaster, favoriteSet, orderedNormals);
      }
    }
  } else if (inferredItem) {
    const rawTarget = Number(payload.toIndex);
    if (!Number.isInteger(rawTarget)) {
      throw new RequestError("ORDER_INVALID", "toIndex 必须是整数");
    }
    const group = payload.group;
    if (inferredItem.favorite) {
      const target = group === "favorites" ? rawTarget : rawTarget;
      if (group !== "favorites" && (target < 0 || target >= favorites.length)) {
        throw new RequestError("FAVORITE_BOUNDARY", "收藏条目不能拖到普通条目后面");
      }
      order.favorites = moveWithin(favorites, inferredItem.id, target);
    } else {
      const target = group === "normal" || group === "regular" ? rawTarget : rawTarget - favorites.length;
      if (group !== "normal" && group !== "regular" && rawTarget < favorites.length) {
        throw new RequestError("FAVORITE_BOUNDARY", "普通条目不能拖到收藏条目前面");
      }
      const reorderedNormals = moveWithin(normalIds, inferredItem.id, target);
      order.normalMaster = replaceNormalItems(order.normalMaster, favoriteSet, reorderedNormals);
    }
  } else {
    throw new RequestError("ORDER_INVALID", "缺少排序数据");
  }

  const manifest = await writeLibrary(directoryHandle, library);
  return { orders: manifest.orders, manifest };
}

function validatePosition(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("UI_STATE_INVALID", `${field} 必须是位置对象`);
  }
  const unknownKeys = Object.keys(value).filter((key) => key !== "x" && key !== "y");
  const x = Number(value.x);
  const y = Number(value.y);
  if (unknownKeys.length || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100_000 || y > 100_000) {
    throw new RequestError("UI_STATE_INVALID", `${field} 必须包含合理的 x 和 y 坐标`);
  }
  return { x, y };
}

export function validateUiPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new RequestError("UI_STATE_INVALID", "UI 状态必须是对象");
  }
  const unknownKeys = Object.keys(patch).filter((key) => !["activeKind", "expanded", "minimized", "positions", "scroll"].includes(key));
  if (unknownKeys.length) {
    throw new RequestError("UI_STATE_INVALID", `不支持的 UI 状态字段：${unknownKeys.join(", ")}`);
  }
  const output = {};
  if (patch.activeKind !== undefined) output.activeKind = requireKind(patch.activeKind);
  if (patch.expanded !== undefined) {
    if (typeof patch.expanded !== "boolean") throw new RequestError("UI_STATE_INVALID", "expanded 必须是布尔值");
    output.expanded = patch.expanded;
  }
  if (patch.minimized !== undefined) {
    if (typeof patch.minimized !== "boolean") throw new RequestError("UI_STATE_INVALID", "minimized 必须是布尔值");
    output.minimized = patch.minimized;
  }
  if (patch.positions !== undefined) {
    if (!patch.positions || typeof patch.positions !== "object" || Array.isArray(patch.positions)) {
      throw new RequestError("UI_STATE_INVALID", "positions 必须是对象");
    }
    const allowedPositions = ["compact", "minimized"];
    const unknownPositionKeys = Object.keys(patch.positions).filter((key) => !allowedPositions.includes(key));
    if (unknownPositionKeys.length) throw new RequestError("UI_STATE_INVALID", "positions 只允许 compact 和 minimized");
    output.positions = {};
    for (const key of allowedPositions) {
      if (patch.positions[key] !== undefined) output.positions[key] = validatePosition(patch.positions[key], `positions.${key}`);
    }
  }
  if (patch.scroll !== undefined) {
    if (!patch.scroll || typeof patch.scroll !== "object" || Array.isArray(patch.scroll)) {
      throw new RequestError("UI_STATE_INVALID", "scroll 必须是对象");
    }
    const unknownScrollKeys = Object.keys(patch.scroll).filter((key) => key !== "artist" && key !== "character");
    if (unknownScrollKeys.length) throw new RequestError("UI_STATE_INVALID", "scroll 只允许 artist 和 character");
    output.scroll = {};
    for (const kind of ["artist", "character"]) {
      if (patch.scroll[kind] === undefined) continue;
      const value = Number(patch.scroll[kind]);
      if (!Number.isFinite(value) || value < 0 || value > 10_000_000) {
        throw new RequestError("UI_STATE_INVALID", `scroll.${kind} 必须是合理的非负数`);
      }
      output.scroll[kind] = value;
    }
  }
  return output;
}

async function setUiState(payload) {
  const patch = payload.patch || payload.ui || payload.changes || payload;
  const { directoryHandle, library } = await requireLibrary();
  const safePatch = validateUiPatch(patch);
  library.ui = {
    ...(library.ui || {}),
    ...safePatch,
    ...(safePatch.scroll ? { scroll: { ...(library.ui?.scroll || {}), ...safePatch.scroll } } : {}),
    ...(safePatch.positions ? { positions: { ...(library.ui?.positions || {}), ...safePatch.positions } } : {}),
  };
  const manifest = await writeLibrary(directoryHandle, library);
  return { ui: manifest.ui };
}

async function openSettings() {
  await chrome.runtime.openOptionsPage();
  return { opened: true };
}

async function broadcastDirectoryChanged() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://novelai.net/*" });
  } catch {
    return { notified: 0 };
  }
  let notified = 0;
  await Promise.all(
    tabs.map(async (tab) => {
      if (!Number.isInteger(tab.id)) {
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "DIRECTORY_CHANGED" });
        notified += 1;
      } catch {
        // A matching tab may not yet have a content script.
      }
    }),
  );
  return { notified };
}

async function dispatchRequest(request) {
  const type = normalizeRequestType(request?.type);
  const payload = asPayload(request);

  switch (type) {
    case "GET_STATUS":
      return getStatus();
    case "GET_LIBRARY":
      return getLibrary();
    case "GET_FILE":
      return getFile(payload);
    case "IMPORT_ITEM":
      return importItem(payload);
    case "UPDATE_ITEM":
      return updateItem(payload);
    case "DELETE_ITEM":
      return deleteItem(payload);
    case "TOGGLE_FAVORITE":
      return toggleFavorite(payload);
    case "REORDER_ITEMS":
      return reorderItems(payload);
    case "SET_UI_STATE":
      return setUiState(payload);
    case "OPEN_SETTINGS":
      return openSettings();
    case "DIRECTORY_CHANGED":
      return broadcastDirectoryChanged();
    default:
      throw new RequestError("REQUEST_UNKNOWN", `不支持的请求类型：${type || "(空)"}`);
  }
}

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

function errorResponse(error) {
  let code = error?.code || "UNEXPECTED_ERROR";
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    code = "DIRECTORY_PERMISSION_REQUIRED";
  } else if (error?.name === "NotFoundError") {
    code = "FILE_NOT_FOUND";
  } else if (error?.name === "AbortError") {
    code = "OPERATION_ABORTED";
  } else if (error instanceof LibraryStorageError) {
    code = error.code;
  }
  return {
    ok: false,
    error: error?.message || "发生未知错误",
    code,
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id && sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "拒绝来自其他扩展的请求", code: "SENDER_REJECTED" });
    return false;
  }

  const type = normalizeRequestType(request?.type);
  const operation = () => dispatchRequest(request);
  const promise = MUTATING_TYPES.has(type)
    ? enqueueMutation(operation)
    : READING_TYPES.has(type)
      ? withLibraryReadLock(operation)
      : operation();
  promise
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse(errorResponse(error)));
  return true;
});

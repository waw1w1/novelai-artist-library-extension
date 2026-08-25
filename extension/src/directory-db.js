const DATABASE_NAME = "novelai-quick-library";
const DATABASE_VERSION = 1;
const HANDLE_STORE = "directory-handles";
const ACTIVE_HANDLE_KEY = "active-library-directory";

export const LIBRARY_FILE_NAME = "library.json";
export const IMAGES_DIRECTORY_NAME = "images";
export const LIBRARY_SCHEMA_VERSION = 1;
const LIBRARY_WRITE_LOCK = "novelai-quick-library-write";

let databasePromise;

export async function withLibraryWriteLock(operation) {
  if (typeof operation !== "function") throw new TypeError("operation 必须是函数");
  if (globalThis.navigator?.locks?.request) {
    return globalThis.navigator.locks.request(
      LIBRARY_WRITE_LOCK,
      { mode: "exclusive" },
      operation,
    );
  }
  return operation();
}

export async function withLibraryReadLock(operation) {
  if (typeof operation !== "function") throw new TypeError("operation 必须是函数");
  if (globalThis.navigator?.locks?.request) {
    return globalThis.navigator.locks.request(
      LIBRARY_WRITE_LOCK,
      { mode: "shared" },
      operation,
    );
  }
  return operation();
}

export class LibraryStorageError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "LibraryStorageError";
    this.code = code;
  }
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error || new Error("IndexedDB 请求失败")),
      { once: true },
    );
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error || new Error("IndexedDB 事务已中止")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error || new Error("IndexedDB 事务失败")),
      { once: true },
    );
  });
}

export function openDirectoryDatabase() {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(HANDLE_STORE)) {
        database.createObjectStore(HANDLE_STORE);
      }
    });

    request.addEventListener("success", () => {
      const database = request.result;
      database.addEventListener("versionchange", () => {
        database.close();
        databasePromise = undefined;
      });
      resolve(database);
    });

    request.addEventListener("error", () => {
      databasePromise = undefined;
      reject(request.error || new Error("无法打开目录句柄数据库"));
    });

    request.addEventListener("blocked", () => {
      databasePromise = undefined;
      reject(new Error("目录句柄数据库升级被其他页面阻止"));
    });
  });

  return databasePromise;
}

export async function getDirectoryRecord() {
  const database = await openDirectoryDatabase();
  const transaction = database.transaction(HANDLE_STORE, "readonly");
  const record = await idbRequest(transaction.objectStore(HANDLE_STORE).get(ACTIVE_HANDLE_KEY));
  await transactionDone(transaction);

  if (!record) {
    return null;
  }
  if (!record.handle || record.handle.kind !== "directory") {
    throw new LibraryStorageError("HANDLE_INVALID", "保存的目录授权已损坏，请重新选择目录");
  }
  return record;
}

export async function saveDirectoryRecord(handle, details = {}) {
  if (!handle || handle.kind !== "directory") {
    throw new LibraryStorageError("HANDLE_INVALID", "只能保存文件夹句柄");
  }

  const now = new Date().toISOString();
  const record = {
    handle,
    name: handle.name,
    selectedAt: details.selectedAt || now,
    verifiedAt: details.verifiedAt || now,
    libraryCreated: Boolean(details.libraryCreated),
  };

  const database = await openDirectoryDatabase();
  const transaction = database.transaction(HANDLE_STORE, "readwrite");
  transaction.objectStore(HANDLE_STORE).put(record, ACTIVE_HANDLE_KEY);
  await transactionDone(transaction);
  return record;
}

export async function clearDirectoryRecord() {
  const database = await openDirectoryDatabase();
  const transaction = database.transaction(HANDLE_STORE, "readwrite");
  transaction.objectStore(HANDLE_STORE).delete(ACTIVE_HANDLE_KEY);
  await transactionDone(transaction);
}

export async function queryDirectoryPermission(handle, mode = "readwrite") {
  if (!handle || typeof handle.queryPermission !== "function") {
    return "denied";
  }
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return "denied";
  }
}

export function createEmptyLibrary() {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    items: {},
    orders: {
      artist: { normalMaster: [], favorites: [] },
      character: { normalMaster: [], favorites: [] },
    },
    ui: {
      activeKind: "artist",
      expanded: false,
      scroll: {
        artist: 0,
        character: 0,
        compact: { artist: 0, character: 0 },
        expanded: { artist: 0, character: 0 },
      },
    },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === "string" && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function normalizeKindOrder(rawOrder, itemIds, items) {
  const allowed = new Set(itemIds);
  const orderObject = isPlainObject(rawOrder) ? rawOrder : {};
  let normalMaster = uniqueStrings(orderObject.normalMaster).filter((id) => allowed.has(id));

  for (const id of itemIds) {
    if (!normalMaster.includes(id)) {
      normalMaster.push(id);
    }
  }

  const favorites = uniqueStrings(orderObject.favorites).filter((id) => allowed.has(id));
  const favoriteSet = new Set(favorites);
  const missingFavorites = normalMaster
    .filter((id) => items[id].favorite && !favoriteSet.has(id))
    .sort((left, right) => {
      const leftAt = items[left].favoriteAt || items[left].createdAt || "";
      const rightAt = items[right].favoriteAt || items[right].createdAt || "";
      return leftAt.localeCompare(rightAt);
    });

  favorites.push(...missingFavorites);
  for (const id of itemIds) {
    items[id].favorite = favorites.includes(id);
  }

  return { normalMaster, favorites };
}

function mergeUiState(defaultValue, candidate) {
  if (!isPlainObject(candidate)) {
    return structuredClone(defaultValue);
  }
  const output = { ...defaultValue };
  for (const [key, value] of Object.entries(candidate)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    if (isPlainObject(value) && isPlainObject(defaultValue[key])) {
      output[key] = mergeUiState(defaultValue[key], value);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

export function normalizeLibrary(candidate) {
  if (!isPlainObject(candidate)) {
    throw new LibraryStorageError("LIBRARY_INVALID", "library.json 的根内容必须是对象");
  }
  if (candidate.items !== undefined && !isPlainObject(candidate.items)) {
    throw new LibraryStorageError("LIBRARY_INVALID", "library.json 的 items 字段格式不正确");
  }

  const defaults = createEmptyLibrary();
  const items = {};
  for (const [key, rawItem] of Object.entries(candidate.items || {})) {
    if (!isPlainObject(rawItem)) {
      throw new LibraryStorageError("LIBRARY_INVALID", `条目 ${key} 的格式不正确`);
    }
    const idSource = typeof rawItem.id === "string" && rawItem.id ? rawItem.id : key;
    const id = String(idSource).trim();
    const kind = rawItem.kind;
    if (id === "__proto__" || id === "constructor" || id === "prototype") {
      throw new LibraryStorageError("LIBRARY_INVALID", `条目 ${key} 使用了不安全的 id`);
    }
    if (!id || (kind !== "artist" && kind !== "character")) {
      throw new LibraryStorageError("LIBRARY_INVALID", `条目 ${key} 缺少有效的 id 或 kind`);
    }
    if (items[id]) {
      throw new LibraryStorageError("LIBRARY_INVALID", `library.json 中存在重复条目 ${id}`);
    }
    items[id] = { ...rawItem, id, kind, favorite: Boolean(rawItem.favorite) };
  }

  const artistIds = Object.keys(items).filter((id) => items[id].kind === "artist");
  const characterIds = Object.keys(items).filter((id) => items[id].kind === "character");
  const rawOrders = isPlainObject(candidate.orders) ? candidate.orders : {};

  return {
    ...candidate,
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    items,
    orders: {
      artist: normalizeKindOrder(rawOrders.artist, artistIds, items),
      character: normalizeKindOrder(rawOrders.character, characterIds, items),
    },
    ui: mergeUiState(defaults.ui, candidate.ui),
  };
}

function isNotFoundError(error) {
  return error && (error.name === "NotFoundError" || error.code === "ENOENT");
}

async function writeBytes(fileHandle, contents) {
  const writable = await fileHandle.createWritable({ keepExistingData: false });
  try {
    await writable.write(contents);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // The stream may already be closed or aborted.
    }
    throw error;
  }
}

export async function sha256Hex(contents) {
  const digest = await crypto.subtle.digest("SHA-256", contents);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function writeLibrary(directoryHandle, library) {
  const normalized = normalizeLibrary(library);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  const encoded = new TextEncoder().encode(serialized);
  const expectedHash = await sha256Hex(encoded);
  const fileHandle = await directoryHandle.getFileHandle(LIBRARY_FILE_NAME, { create: true });

  await writeBytes(fileHandle, encoded);

  const writtenFile = await fileHandle.getFile();
  const actualHash = await sha256Hex(await writtenFile.arrayBuffer());
  if (actualHash !== expectedHash) {
    throw new LibraryStorageError("WRITE_VERIFY_FAILED", "library.json 写入后的 SHA-256 校验失败");
  }
  return normalized;
}

export async function readLibrary(directoryHandle) {
  let fileHandle;
  try {
    fileHandle = await directoryHandle.getFileHandle(LIBRARY_FILE_NAME);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  const file = await fileHandle.getFile();
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    throw new LibraryStorageError("LIBRARY_INVALID", "现有 library.json 不是有效的 JSON", error);
  }
  return normalizeLibrary(parsed);
}

export async function openOrCreateLibrary(directoryHandle) {
  const existing = await readLibrary(directoryHandle);
  if (existing) {
    await directoryHandle.getDirectoryHandle(IMAGES_DIRECTORY_NAME, { create: true });
    return { manifest: existing, created: false };
  }

  await directoryHandle.getDirectoryHandle(IMAGES_DIRECTORY_NAME, { create: true });
  const manifest = await writeLibrary(directoryHandle, createEmptyLibrary());
  return { manifest, created: true };
}

export async function testWritableDirectory(directoryHandle) {
  const suffix = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probeName = `.novelai-quick-library-write-test-${suffix}.tmp`;
  const probeBytes = crypto.getRandomValues(new Uint8Array(64));
  const expectedHash = await sha256Hex(probeBytes);
  let probeCreated = false;

  try {
    const probeHandle = await directoryHandle.getFileHandle(probeName, { create: true });
    probeCreated = true;
    await writeBytes(probeHandle, probeBytes);
    const probeFile = await probeHandle.getFile();
    const actualHash = await sha256Hex(await probeFile.arrayBuffer());
    if (actualHash !== expectedHash) {
      throw new LibraryStorageError("WRITE_VERIFY_FAILED", "目录试写后的 SHA-256 校验失败");
    }
  } finally {
    if (probeCreated) {
      try {
        await directoryHandle.removeEntry(probeName);
      } catch {
        // A failed cleanup must not hide the more important write result.
      }
    }
  }
}

function validateImageFileName(fileName) {
  if (
    typeof fileName !== "string" ||
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new LibraryStorageError("FILE_NAME_INVALID", "图片文件名不安全");
  }
}

export async function writeImageVerified(directoryHandle, fileName, bytes, expectedHash) {
  validateImageFileName(fileName);
  const imagesDirectory = await directoryHandle.getDirectoryHandle(IMAGES_DIRECTORY_NAME, { create: true });
  const fileHandle = await imagesDirectory.getFileHandle(fileName, { create: true });
  await writeBytes(fileHandle, bytes);

  const writtenFile = await fileHandle.getFile();
  const actualHash = await sha256Hex(await writtenFile.arrayBuffer());
  if (expectedHash && actualHash !== expectedHash.toLowerCase()) {
    try {
      await imagesDirectory.removeEntry(fileName);
    } catch {
      // The caller still receives the verification failure.
    }
    throw new LibraryStorageError("WRITE_VERIFY_FAILED", "图片写入后的 SHA-256 校验失败");
  }

  return { fileHandle, file: writtenFile, sha256: actualHash };
}

export async function readImageFile(directoryHandle, fileName) {
  validateImageFileName(fileName);
  const imagesDirectory = await directoryHandle.getDirectoryHandle(IMAGES_DIRECTORY_NAME);
  const fileHandle = await imagesDirectory.getFileHandle(fileName);
  return fileHandle.getFile();
}

export async function removeImageFile(directoryHandle, fileName) {
  validateImageFileName(fileName);
  try {
    const imagesDirectory = await directoryHandle.getDirectoryHandle(IMAGES_DIRECTORY_NAME);
    await imagesDirectory.removeEntry(fileName);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

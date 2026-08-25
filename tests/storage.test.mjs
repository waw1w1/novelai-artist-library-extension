import assert from "node:assert/strict";
import test from "node:test";

import {
  IMAGES_DIRECTORY_NAME,
  LIBRARY_FILE_NAME,
  LibraryStorageError,
  createEmptyLibrary,
  openOrCreateLibrary,
  readImageFile,
  readLibrary,
  removeImageFile,
  sha256Hex,
  testWritableDirectory,
  withLibraryReadLock,
  withLibraryWriteLock,
  writeImageVerified,
  writeLibrary,
} from "../extension/src/directory-db.js";

const encoder = new TextEncoder();

function notFound(message = "不存在") {
  return new DOMException(message, "NotFoundError");
}

function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (typeof value === "string") return encoder.encode(value);
  throw new TypeError(`测试 Writable 不支持 ${Object.prototype.toString.call(value)}`);
}

class MemoryFileHandle {
  kind = "file";

  constructor(name, initialBytes = new Uint8Array()) {
    this.name = name;
    this.bytes = toBytes(initialBytes);
    this.lastModified = Date.now();
    this.writeCount = 0;
    this.corruptNextCommit = false;
    this.failNextWrite = false;
    this.failNextClose = false;
  }

  async createWritable({ keepExistingData = false } = {}) {
    let staged = keepExistingData ? new Uint8Array(this.bytes) : new Uint8Array();
    let finished = false;

    return {
      write: async (value) => {
        if (finished) throw new DOMException("流已关闭", "InvalidStateError");
        if (this.failNextWrite) {
          this.failNextWrite = false;
          throw new Error("模拟写入失败");
        }
        staged = toBytes(value);
      },
      close: async () => {
        if (finished) throw new DOMException("流已关闭", "InvalidStateError");
        if (this.failNextClose) {
          this.failNextClose = false;
          throw new Error("模拟关闭失败");
        }
        finished = true;
        if (this.corruptNextCommit) {
          this.corruptNextCommit = false;
          staged = new Uint8Array(staged);
          if (staged.length) staged[staged.length - 1] ^= 0xff;
        }
        this.bytes = staged;
        this.writeCount += 1;
        this.lastModified = Date.now();
      },
      abort: async () => {
        finished = true;
      },
    };
  }

  async getFile() {
    const snapshot = new Uint8Array(this.bytes);
    return {
      name: this.name,
      type: "",
      size: snapshot.byteLength,
      lastModified: this.lastModified,
      arrayBuffer: async () => snapshot.buffer.slice(
        snapshot.byteOffset,
        snapshot.byteOffset + snapshot.byteLength,
      ),
      text: async () => new TextDecoder().decode(snapshot),
    };
  }
}

class MemoryDirectoryHandle {
  kind = "directory";

  constructor(name = "data") {
    this.name = name;
    this.files = new Map();
    this.directories = new Map();
    this.permission = "granted";
  }

  async queryPermission() {
    return this.permission;
  }

  async requestPermission() {
    return this.permission;
  }

  seedFile(name, contents) {
    const handle = new MemoryFileHandle(name, contents);
    this.files.set(name, handle);
    return handle;
  }

  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name)) {
      if (!create) throw notFound(`文件 ${name} 不存在`);
      this.files.set(name, new MemoryFileHandle(name));
    }
    return this.files.get(name);
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.directories.has(name)) {
      if (!create) throw notFound(`目录 ${name} 不存在`);
      this.directories.set(name, new MemoryDirectoryHandle(name));
    }
    return this.directories.get(name);
  }

  async removeEntry(name) {
    if (this.files.delete(name) || this.directories.delete(name)) return;
    throw notFound(`${name} 不存在`);
  }
}

class MemoryLockManager {
  constructor() {
    this.states = new Map();
  }

  request(name, options, callback) {
    const mode = options?.mode || "exclusive";
    return new Promise((resolve, reject) => {
      const state = this.states.get(name) || {
        readers: 0,
        writer: false,
        queue: [],
      };
      this.states.set(name, state);
      state.queue.push({ mode, callback, resolve, reject });
      this.#drain(name, state);
    });
  }

  #drain(name, state) {
    if (state.writer || !state.queue.length) return;

    const first = state.queue[0];
    if (first.mode === "exclusive") {
      if (state.readers) return;
      state.queue.shift();
      state.writer = true;
      this.#run(name, state, first, () => {
        state.writer = false;
      });
      return;
    }

    while (state.queue[0]?.mode === "shared" && !state.writer) {
      const entry = state.queue.shift();
      state.readers += 1;
      this.#run(name, state, entry, () => {
        state.readers -= 1;
      });
    }
  }

  #run(name, state, entry, release) {
    Promise.resolve()
      .then(() => entry.callback({ name, mode: entry.mode }))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        release();
        if (!state.writer && state.readers === 0 && state.queue.length === 0) {
          this.states.delete(name);
        }
        this.#drain(name, state);
      });
  }
}

async function withMockLocks(callback) {
  const navigatorObject = globalThis.navigator || {};
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalLocksDescriptor = Object.getOwnPropertyDescriptor(navigatorObject, "locks");

  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, "navigator", {
      value: navigatorObject,
      configurable: true,
    });
  }
  Object.defineProperty(navigatorObject, "locks", {
    value: new MemoryLockManager(),
    configurable: true,
  });

  try {
    return await callback();
  } finally {
    if (originalLocksDescriptor) {
      Object.defineProperty(navigatorObject, "locks", originalLocksDescriptor);
    } else {
      delete navigatorObject.locks;
    }
    if (!originalNavigatorDescriptor) {
      delete globalThis.navigator;
    }
  }
}

test("新目录会建立 images/ 与完整清单，并可写回后读取", async () => {
  const root = new MemoryDirectoryHandle();
  const opened = await openOrCreateLibrary(root);

  assert.equal(opened.created, true);
  assert.equal(root.directories.has(IMAGES_DIRECTORY_NAME), true);
  assert.equal(root.files.has(LIBRARY_FILE_NAME), true);
  assert.deepEqual(opened.manifest, createEmptyLibrary());
  assert.equal(opened.manifest.ui.minimized, false);
  assert.deepEqual(opened.manifest.ui.positions, {});

  opened.manifest.items.artistA = {
    id: "artistA",
    kind: "artist",
    title: "Artist A",
    actionPrompt: "artist:a",
    favorite: true,
  };
  opened.manifest.orders.artist.normalMaster.push("artistA");
  opened.manifest.orders.artist.favorites.push("artistA");
  opened.manifest.ui.activeKind = "character";
  opened.manifest.ui.scroll.artist = 321;

  const written = await writeLibrary(root, opened.manifest);
  const restored = await readLibrary(root);
  assert.deepEqual(restored, written);
  assert.equal(restored.items.artistA.actionPrompt, "artist:a");
  assert.deepEqual(restored.orders.artist.favorites, ["artistA"]);
  assert.equal(restored.ui.scroll.artist, 321);

  await testWritableDirectory(root);
  assert.equal(
    [...root.files.keys()].some((name) => name.includes("write-test")),
    false,
    "目录试写文件应被清理",
  );
});

test("图片按原始字节写入并以 SHA-256 复验；不匹配时删除坏文件", async () => {
  const root = new MemoryDirectoryHandle();
  const original = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  const expectedHash = await sha256Hex(original);

  const result = await writeImageVerified(root, "original.png", original, expectedHash);
  assert.equal(result.sha256, expectedHash);
  const restored = new Uint8Array(
    await (await readImageFile(root, "original.png")).arrayBuffer(),
  );
  assert.deepEqual(restored, original);
  assert.equal(await sha256Hex(restored), expectedHash);

  const images = await root.getDirectoryHandle(IMAGES_DIRECTORY_NAME);
  await assert.rejects(
    writeImageVerified(root, "wrong.png", original, "0".repeat(64)),
    (error) => error instanceof LibraryStorageError && error.code === "WRITE_VERIFY_FAILED",
  );
  assert.equal(images.files.has("wrong.png"), false);

  const corruptHandle = await images.getFileHandle("corrupt.png", { create: true });
  corruptHandle.corruptNextCommit = true;
  await assert.rejects(
    writeImageVerified(root, "corrupt.png", original, expectedHash),
    (error) => error instanceof LibraryStorageError && error.code === "WRITE_VERIFY_FAILED",
  );
  assert.equal(images.files.has("corrupt.png"), false);
});

test("图片流写入或关闭失败也会删除已创建的孤立文件", async () => {
  const root = new MemoryDirectoryHandle();
  const images = await root.getDirectoryHandle(IMAGES_DIRECTORY_NAME, { create: true });
  for (const [name, failure] of [["write-fail.png", "failNextWrite"], ["close-fail.png", "failNextClose"]]) {
    const handle = await images.getFileHandle(name, { create: true });
    handle[failure] = true;
    await assert.rejects(writeImageVerified(root, name, Uint8Array.of(1, 2, 3), null));
    assert.equal(images.files.has(name), false, `${name} 应被清理`);
  }
});

test("删除图片文件成功，并允许重复删除不存在的文件", async () => {
  const root = new MemoryDirectoryHandle();
  const images = await root.getDirectoryHandle(IMAGES_DIRECTORY_NAME, { create: true });
  images.seedFile("delete-me.png", Uint8Array.of(1, 2, 3));
  await removeImageFile(root, "delete-me.png");
  assert.equal(images.files.has("delete-me.png"), false);
  await assert.doesNotReject(removeImageFile(root, "delete-me.png"));
});

test("打开已有库只读取和规范化，不重写用户的 library.json", async () => {
  const root = new MemoryDirectoryHandle();
  const exactText = JSON.stringify({
    schemaVersion: 1,
    customTopLevel: { mustStay: true },
    items: {},
    orders: {
      artist: { normalMaster: [], favorites: [] },
      character: { normalMaster: [], favorites: [] },
    },
  });
  const libraryHandle = root.seedFile(LIBRARY_FILE_NAME, encoder.encode(exactText));
  const beforeBytes = new Uint8Array(libraryHandle.bytes);
  const beforeWrites = libraryHandle.writeCount;

  const opened = await openOrCreateLibrary(root);

  assert.equal(opened.created, false);
  assert.equal(opened.manifest.customTopLevel.mustStay, true);
  assert.equal(opened.manifest.ui.activeKind, "artist", "内存结果可补齐默认 UI");
  assert.equal(root.directories.has(IMAGES_DIRECTORY_NAME), true);
  assert.equal(libraryHandle.writeCount, beforeWrites, "已有清单不得被设置页式打开重写");
  assert.deepEqual(libraryHandle.bytes, beforeBytes);
  assert.equal(await (await libraryHandle.getFile()).text(), exactText);
});

test("缺失清单返回 null；显式 openOrCreate 才建立新库", async () => {
  const root = new MemoryDirectoryHandle();
  assert.equal(await readLibrary(root), null);
  assert.equal(root.files.has(LIBRARY_FILE_NAME), false);
  assert.equal(root.directories.has(IMAGES_DIRECTORY_NAME), false);

  const opened = await openOrCreateLibrary(root);
  assert.equal(opened.created, true);
  assert.equal(root.files.has(LIBRARY_FILE_NAME), true);
  assert.equal(root.directories.has(IMAGES_DIRECTORY_NAME), true);
});

test("损坏清单会明确报错，且 openOrCreate 不覆盖原字节", async () => {
  for (const [label, brokenText] of [
    ["非法 JSON", "{ definitely-not-json"],
    ["错误 items 类型", JSON.stringify({ items: [] })],
  ]) {
    const root = new MemoryDirectoryHandle(label);
    const handle = root.seedFile(LIBRARY_FILE_NAME, encoder.encode(brokenText));
    const before = new Uint8Array(handle.bytes);

    await assert.rejects(
      readLibrary(root),
      (error) => error instanceof LibraryStorageError && error.code === "LIBRARY_INVALID",
      label,
    );
    await assert.rejects(
      openOrCreateLibrary(root),
      (error) => error instanceof LibraryStorageError && error.code === "LIBRARY_INVALID",
      `${label} 不应被自动覆盖`,
    );

    assert.deepEqual(handle.bytes, before);
    assert.equal(handle.writeCount, 0);
    assert.equal(root.directories.has(IMAGES_DIRECTORY_NAME), false);
  }
});

test("Web Locks mock 允许并行读，但写锁等待且写操作彼此串行", async () => {
  await withMockLocks(async () => {
    const events = [];
    let releaseReadOne;
    let releaseReadTwo;
    const readOneGate = new Promise((resolve) => { releaseReadOne = resolve; });
    const readTwoGate = new Promise((resolve) => { releaseReadTwo = resolve; });

    const readOne = withLibraryReadLock(async () => {
      events.push("read-1:start");
      await readOneGate;
      events.push("read-1:end");
    });
    const readTwo = withLibraryReadLock(async () => {
      events.push("read-2:start");
      await readTwoGate;
      events.push("read-2:end");
    });
    const writeOne = withLibraryWriteLock(async () => {
      events.push("write-1:start");
      await Promise.resolve();
      events.push("write-1:end");
    });
    const writeTwo = withLibraryWriteLock(async () => {
      events.push("write-2:start");
      events.push("write-2:end");
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["read-1:start", "read-2:start"]);

    releaseReadOne();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.includes("write-1:start"), false, "还有读锁时写锁不能开始");

    releaseReadTwo();
    await Promise.all([readOne, readTwo, writeOne, writeTwo]);
    assert.deepEqual(events, [
      "read-1:start",
      "read-2:start",
      "read-1:end",
      "read-2:end",
      "write-1:start",
      "write-1:end",
      "write-2:start",
      "write-2:end",
    ]);
  });
});

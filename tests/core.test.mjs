import test from "node:test";
import assert from "node:assert/strict";

import {
  addItemToManifest,
  canReorderWithinPartition,
  captureScrollAnchor,
  createDefaultManifest,
  getDisplayIds,
  getDisplayItems,
  normalizeManifest,
  reorderWithinPartition,
  removeItemFromManifest,
  resetFloatingUiState,
  restoreScrollAnchor,
  toggleFavorite,
  updateItemInManifest,
} from "../extension/src/core.js";

function addItems(items) {
  return items.reduce(
    (manifest, item) => addItemToManifest(manifest, item),
    createDefaultManifest(),
  );
}

test("createDefaultManifest 返回互不共享的完整默认结构", () => {
  const first = createDefaultManifest();
  const second = createDefaultManifest();

  assert.deepEqual(first, {
    schemaVersion: 1,
    items: {},
    orders: {
      artist: { normalMaster: [], favorites: [] },
      character: { normalMaster: [], favorites: [] },
    },
  });

  first.orders.artist.normalMaster.push("changed");
  assert.deepEqual(second.orders.artist.normalMaster, []);
});

test("normalizeManifest 清除坏引用、去重、补齐顺序并兼容旧清单", () => {
  const dirty = {
    schemaVersion: 0,
    customSetting: "kept",
    items: {
      a: { id: "a", kind: "artist", favorite: true, actionPrompt: "A" },
      b: { id: "b", kind: "artist", favorite: false, actionPrompt: "B" },
      c: { id: "c", kind: "unknown", actionPrompt: "C" },
      d: { id: "d", kind: "character", favorite: true, actionPrompt: "D" },
    },
    orders: {
      artist: {
        normalMaster: ["b", "ghost", "a", "b"],
        favorites: ["ghost", "a", "b", "a"],
      },
      character: {
        normalMaster: ["c"],
        favorites: ["c", "d", "c"],
      },
    },
  };
  const untouched = structuredClone(dirty);

  const normalized = normalizeManifest(dirty);

  assert.deepEqual(dirty, untouched, "不得修改传入清单");
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.customSetting, "kept");
  assert.equal(normalized.items.c.kind, "character", "可从旧顺序推断丢失的类型");
  assert.equal(normalized.items.c.favorite, true, "缺少 favorite 时从旧收藏顺序推断");
  assert.deepEqual(normalized.orders.artist, {
    normalMaster: ["b", "a"],
    favorites: ["a"],
  });
  assert.deepEqual(normalized.orders.character, {
    normalMaster: ["c", "d"],
    favorites: ["c", "d"],
  });
  assert.deepEqual(getDisplayIds(normalized, "artist"), ["a", "b"]);
  assert.deepEqual(getDisplayIds(normalized, "character"), ["c", "d"]);
});

test("收藏按点击顺序追加，取消收藏后恢复普通区原位置", () => {
  let manifest = addItems([
    { id: "a", kind: "artist", actionPrompt: "A" },
    { id: "b", kind: "artist", actionPrompt: "B" },
    { id: "c", kind: "artist", actionPrompt: "C" },
  ]);

  manifest = toggleFavorite(manifest, "b");
  manifest = toggleFavorite(manifest, "a");
  assert.deepEqual(manifest.orders.artist.favorites, ["b", "a"]);
  assert.deepEqual(manifest.orders.artist.normalMaster, ["a", "b", "c"]);
  assert.deepEqual(getDisplayIds(manifest, "artist"), ["b", "a", "c"]);

  manifest = toggleFavorite(manifest, "b");
  assert.deepEqual(manifest.orders.artist.favorites, ["a"]);
  assert.deepEqual(getDisplayIds(manifest, "artist"), ["a", "b", "c"]);

  manifest = toggleFavorite(manifest, "b");
  assert.deepEqual(manifest.orders.artist.favorites, ["a", "b"]);
  assert.deepEqual(getDisplayIds(manifest, "artist"), ["a", "b", "c"]);
});

test("收藏区与普通区各自排序，跨分区拖放是安全的无操作", () => {
  let manifest = addItems([
    { id: "a", kind: "artist" },
    { id: "b", kind: "artist" },
    { id: "c", kind: "artist" },
    { id: "d", kind: "artist" },
  ]);
  manifest = toggleFavorite(manifest, "b");
  manifest = toggleFavorite(manifest, "d");

  assert.equal(canReorderWithinPartition(manifest, "artist", "d", "b"), true);
  assert.equal(canReorderWithinPartition(manifest, "artist", "a", "b"), false);

  manifest = reorderWithinPartition(manifest, "artist", "d", "b", "before");
  assert.deepEqual(manifest.orders.artist.favorites, ["d", "b"]);
  assert.deepEqual(getDisplayIds(manifest, "artist"), ["d", "b", "a", "c"]);

  const beforeRejectedDrop = structuredClone(manifest);
  manifest = reorderWithinPartition(manifest, "artist", "a", "d", "before");
  assert.deepEqual(manifest, beforeRejectedDrop, "普通图片不能插进收藏区");

  manifest = reorderWithinPartition(manifest, "artist", "d", "a", "after");
  assert.deepEqual(manifest, beforeRejectedDrop, "收藏图片不能插进普通区");

  manifest = reorderWithinPartition(manifest, "artist", "c", "a", "before");
  assert.deepEqual(manifest.orders.artist.normalMaster, ["c", "b", "a", "d"]);
  assert.deepEqual(getDisplayIds(manifest, "artist"), ["d", "b", "c", "a"]);

  manifest = toggleFavorite(manifest, "b");
  assert.deepEqual(
    getDisplayIds(manifest, "artist"),
    ["d", "c", "b", "a"],
    "取消收藏后回到 normalMaster 中保留的位置",
  );
});

test("reorderWithinPartition 支持同分区移到开头和末尾", () => {
  let manifest = addItems([
    { id: "a", kind: "character" },
    { id: "b", kind: "character" },
    { id: "c", kind: "character" },
  ]);

  manifest = reorderWithinPartition(manifest, "character", "c", null, "start");
  assert.deepEqual(getDisplayIds(manifest, "character"), ["c", "a", "b"]);
  manifest = reorderWithinPartition(manifest, "character", "c", null, "end");
  assert.deepEqual(getDisplayIds(manifest, "character"), ["a", "b", "c"]);
});

test("新增和编辑类型、收藏状态时同步维护两个图库的 orders", () => {
  let manifest = addItemToManifest(createDefaultManifest(), {
    id: "x",
    kind: "artist",
    favorite: true,
    actionPrompt: "old",
  });

  assert.deepEqual(manifest.orders.artist.normalMaster, ["x"]);
  assert.deepEqual(manifest.orders.artist.favorites, ["x"]);

  manifest = updateItemInManifest(manifest, "x", {
    kind: "character",
    actionPrompt: "new",
  });
  assert.deepEqual(manifest.orders.artist, { normalMaster: [], favorites: [] });
  assert.deepEqual(manifest.orders.character, {
    normalMaster: ["x"],
    favorites: ["x"],
  });
  assert.equal(getDisplayItems(manifest, "character")[0].actionPrompt, "new");

  manifest = updateItemInManifest(manifest, "x", { favorite: false });
  assert.deepEqual(manifest.orders.character.favorites, []);
  assert.deepEqual(manifest.orders.character.normalMaster, ["x"]);
  assert.equal(manifest.items.x.favorite, false);

  assert.throws(
    () => addItemToManifest(manifest, { id: "x", kind: "character" }),
    /already exists/,
  );
  assert.throws(
    () => updateItemInManifest(manifest, "x", { id: "renamed" }),
    /cannot be changed/,
  );
});

test("删除条目会同步清理 items、普通顺序和收藏顺序", () => {
  let manifest = addItems([
    { id: "keep", kind: "artist" },
    { id: "remove", kind: "artist", favorite: true },
  ]);
  manifest = removeItemFromManifest(manifest, "remove");
  assert.equal(Object.hasOwn(manifest.items, "remove"), false);
  assert.deepEqual(manifest.orders.artist.normalMaster, ["keep"]);
  assert.deepEqual(manifest.orders.artist.favorites, []);
  assert.deepEqual(getDisplayIds(manifest, "artist"), ["keep"]);
});

test("重置悬浮布局保留其他 UI 数据并恢复默认显示状态", () => {
  assert.deepEqual(resetFloatingUiState({
    activeKind: "character",
    expanded: true,
    minimized: true,
    positions: { compact: { x: 20, y: 30 }, minimized: { x: 40, y: 50 } },
    scroll: { artist: 12, character: 34 },
  }), {
    activeKind: "character",
    expanded: false,
    minimized: false,
    positions: {},
    scroll: { artist: 12, character: 34 },
  });
});

function fakeElement(id, rect) {
  return {
    dataset: { libraryItemId: id },
    getBoundingClientRect: () => ({ ...rect }),
  };
}

test("captureScrollAnchor 捕获首个可见项目及其像素偏移", () => {
  const elements = [
    fakeElement("hidden", { top: 20, bottom: 90 }),
    fakeElement("partial", { top: 80, bottom: 140 }),
    fakeElement("next", { top: 150, bottom: 210 }),
  ];
  const container = {
    scrollTop: 250,
    getBoundingClientRect: () => ({ top: 100, bottom: 300 }),
    querySelectorAll: () => elements,
  };

  assert.deepEqual(captureScrollAnchor(container), {
    anchorId: "partial",
    offsetPx: -20,
    rawScrollTop: 250,
  });
});

test("restoreScrollAnchor 按锚点恢复；锚点丢失时退回原 scrollTop 并限制边界", () => {
  const moved = fakeElement("partial", { top: 170, bottom: 230 });
  const container = {
    scrollTop: 400,
    scrollHeight: 1000,
    clientHeight: 200,
    getBoundingClientRect: () => ({ top: 100, bottom: 300 }),
    querySelectorAll: () => [moved],
  };
  const anchor = { anchorId: "partial", offsetPx: -20, rawScrollTop: 250 };

  assert.equal(restoreScrollAnchor(container, anchor), 490);
  assert.equal(container.scrollTop, 490);

  container.querySelectorAll = () => [];
  assert.equal(
    restoreScrollAnchor(container, { ...anchor, rawScrollTop: 900 }),
    800,
    "回退值不得超过最大可滚动距离",
  );
  assert.equal(container.scrollTop, 800);
});

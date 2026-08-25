import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = {
  action: { onClicked: { addListener() {} } },
  runtime: {
    id: "test-extension",
    onMessage: { addListener() {} },
    async openOptionsPage() {},
  },
  tabs: { async query() { return []; }, async sendMessage() {} },
};

const {
  itemForId,
  normalizeMetadata,
  requireBoundedString,
  validateUiPatch,
} = await import("../extension/background.js");

test("后台只接受自有条目属性，拒绝 Object.prototype 名称", () => {
  assert.equal(itemForId({ items: { own: { id: "own" } } }, "own").id, "own");
  assert.throws(() => itemForId({ items: {} }, "toString"), (error) => error.code === "ITEM_NOT_FOUND");
});

test("后台限制标题、提示词与 metadata 长度和结构", () => {
  assert.equal(requireBoundedString("标题", "title", 100), "标题");
  assert.throws(() => requireBoundedString("x".repeat(101), "title", 100), (error) => error.code === "PAYLOAD_TOO_LARGE");
  assert.deepEqual(normalizeMetadata({ hasMetadata: true, hasNovelAiMetadata: true, prompt: "p", summary: "s", ignored: "x" }), {
    hasMetadata: true,
    hasNovelAiMetadata: true,
    prompt: "p",
    summary: "s",
  });
  assert.throws(
    () => normalizeMetadata({ prompt: "x".repeat(256 * 1024 + 1), summary: "" }),
    (error) => error.code === "PAYLOAD_TOO_LARGE",
  );
});

test("UI 状态使用严格白名单并限制滚动值和悬浮位置", () => {
  assert.deepEqual(validateUiPatch({ activeKind: "character", expanded: true, minimized: true, positions: { compact: { x: 320, y: 240 } }, scroll: { artist: 123 } }), {
    activeKind: "character",
    expanded: true,
    minimized: true,
    positions: { compact: { x: 320, y: 240 } },
    scroll: { artist: 123 },
  });
  assert.throws(() => validateUiPatch({ arbitrary: { nested: true } }), (error) => error.code === "UI_STATE_INVALID");
  assert.throws(() => validateUiPatch({ scroll: { artist: -1 } }), (error) => error.code === "UI_STATE_INVALID");
  assert.throws(() => validateUiPatch({ positions: { expanded: { x: 1, y: 1 } } }), (error) => error.code === "UI_STATE_INVALID");
  assert.throws(() => validateUiPatch({ positions: { minimized: { x: -1, y: 1 } } }), (error) => error.code === "UI_STATE_INVALID");
});

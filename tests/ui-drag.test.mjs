import assert from "node:assert/strict";
import test from "node:test";

import {
  clampFloatingPosition,
  draggedImageFileName,
  extractElementImageSource,
  extractDraggedImageUrls,
  isPointInsideRect,
  resolveImportPromptSource,
} from "../extension/src/ui.js";
import { buildPromptSnapshot } from "../extension/src/novelai.js";

test("网页图片拖放可从已记录源与 URI 列表提取安全 URL", () => {
  const transfer = {
    getData(type) {
      if (type === "text/uri-list") {
        return "# generated image\nhttps://images.novelai.net/history/output.webp\n";
      }
      return "";
    },
  };
  assert.deepEqual(extractDraggedImageUrls(transfer, {
    url: "blob:https://novelai.net/1234",
  }), [
    "blob:https://novelai.net/1234",
    "https://images.novelai.net/history/output.webp",
  ]);
});

test("历史卡片可从懒加载子图片、背景图和 NovelAI 自定义拖放数据识别原图", () => {
  const lazyImage = {
    currentSrc: "",
    src: "",
    alt: "History output",
    getAttribute(name) { return name === "data-src" ? "https://novelai.net/history/full.png" : null; },
  };
  const historyCard = {
    tagName: "DIV",
    querySelector() { return lazyImage; },
    getAttribute() { return null; },
    ownerDocument: { defaultView: { getComputedStyle() { return { backgroundImage: "none" }; } } },
  };
  assert.deepEqual(extractElementImageSource(historyCard), {
    url: "https://novelai.net/history/full.png",
    name: "History output",
  });

  const backgroundCard = {
    tagName: "DIV",
    querySelector() { return null; },
    getAttribute(name) { return name === "aria-label" ? "Generated history image" : null; },
    ownerDocument: { defaultView: { getComputedStyle() { return { backgroundImage: 'url("https://novelai.net/history/background.webp")' }; } } },
  };
  assert.equal(extractElementImageSource(backgroundCard).url, "https://novelai.net/history/background.webp");

  const customTransfer = {
    types: ["application/x-novelai-image"],
    getData() { return '{"imageUrl":"https:\\/\\/novelai.net\\/history\\/custom.png"}'; },
  };
  assert.deepEqual(extractDraggedImageUrls(customTransfer), ["https://novelai.net/history/custom.png"]);
});

test("网页图片拖放拒绝危险协议并生成安全文件名", () => {
  const transfer = {
    getData(type) {
      return type === "text/uri-list" ? "javascript:alert(1)\nfile:///secret.png" : "";
    },
  };
  assert.deepEqual(extractDraggedImageUrls(transfer), []);
  assert.equal(
    draggedImageFileName({ url: "https://novelai.net/output/generated-image.png" }, "image/png"),
    "generated-image.png",
  );
  assert.equal(
    draggedImageFileName({ url: "blob:https://novelai.net/1234", name: "history:image" }, "image/webp"),
    "history_image.webp",
  );
});

test("只有落点位于面板内部时才进入插件拖放处理范围", () => {
  const panelRect = { left: 900, right: 1260, top: 300, bottom: 700 };
  assert.equal(isPointInsideRect(1000, 500, panelRect), true);
  assert.equal(isPointInsideRect(899, 500, panelRect), false, "NovelAI 左侧区域不得被插件接管");
  assert.equal(isPointInsideRect(1000, 250, panelRect), false, "NovelAI 上方区域不得被插件接管");
  assert.equal(isPointInsideRect(500, 500, panelRect), false, "NovelAI 主画布不得被插件接管");
});

test("悬浮面板和小图标位置始终限制在浏览器可视区域", () => {
  assert.deepEqual(clampFloatingPosition(5000, -20, 320, 400, 1280, 720), { x: 952, y: 8 });
  assert.deepEqual(clampFloatingPosition(1200, 680, 46, 46, 1280, 720), { x: 1200, y: 666 });
  assert.deepEqual(clampFloatingPosition(50, 50, 1400, 800, 1280, 720), { x: 0, y: 0 });
});

test("NovelAI metadata 始终优先于网页实时提示词", () => {
  const pageSnapshot = buildPromptSnapshot("live page prompt", ["live character"]);
  const resolved = resolveImportPromptSource({
    hasNovelAiMetadata: true,
    prompt: "embedded metadata prompt",
  }, pageSnapshot, "artist");
  assert.equal(resolved.source, "metadata");
  assert.equal(resolved.prompt, "embedded metadata prompt");
  assert.doesNotMatch(resolved.prompt, /live page/u);

  const missingPrompt = resolveImportPromptSource({ hasNovelAiMetadata: true, prompt: "" }, pageSnapshot, "artist");
  assert.equal(missingPrompt.prompt, "", "metadata 存在但无提示词时也不得静默回退网页");
  assert.match(missingPrompt.message, /不会自动改用网页提示词/u);
});

test("没有 NovelAI metadata 时才回退当前页面提示词并明确说明来源", () => {
  const pageSnapshot = buildPromptSnapshot("live page prompt", ["only character"]);
  const artist = resolveImportPromptSource({ hasNovelAiMetadata: false }, pageSnapshot, "artist");
  assert.equal(artist.source, "page");
  assert.equal(artist.prompt, "live page prompt");
  assert.match(artist.message, /当前 NovelAI 页面提示词作为回退来源/u);

  const character = resolveImportPromptSource(null, pageSnapshot, "character");
  assert.equal(character.prompt, "only character");
});

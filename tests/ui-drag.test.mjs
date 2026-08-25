import assert from "node:assert/strict";
import test from "node:test";

import {
  draggedImageFileName,
  extractDraggedImageUrls,
  isPointInsideRect,
} from "../extension/src/ui.js";

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

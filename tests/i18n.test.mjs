import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LANGUAGE,
  getStoredLanguage,
  normalizeLanguage,
  setStoredLanguage,
  translateMessage,
} from "../extension/src/i18n.js";

test("界面默认使用英文，且只接受受支持的语言", () => {
  assert.equal(DEFAULT_LANGUAGE, "en");
  assert.equal(normalizeLanguage(undefined), "en");
  assert.equal(normalizeLanguage("fr"), "en");
  assert.equal(normalizeLanguage("zh-CN"), "zh-CN");
});

test("面板和设置页关键文案可双向切换", () => {
  assert.equal(translateMessage("提示词图库", "en"), "Prompt Gallery");
  assert.equal(translateMessage("Prompt Gallery", "zh-CN"), "提示词图库");
  assert.equal(translateMessage("重置面板位置", "en"), "Reset panel position");
  assert.equal(translateMessage("画师串 · 24 张", "en"), "Artist Prompts · 24 images");
  assert.equal(translateMessage("数据目录：MyLibrary", "en"), "Data directory: MyLibrary");
});

test("用户内容不会被当成系统文案翻译", () => {
  assert.equal(translateMessage("artist:foo, 1girl, red hair", "en"), "artist:foo, 1girl, red hair");
  assert.equal(translateMessage("我的角色图库", "en"), "我的角色图库");
});

test("语言选择持久化到 chrome.storage.local", async () => {
  const values = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) { return { ...defaults, ...values }; },
        async set(patch) { Object.assign(values, patch); },
      },
    },
  };
  assert.equal(await getStoredLanguage(), "en");
  assert.equal(await setStoredLanguage("zh-CN"), "zh-CN");
  assert.equal(await getStoredLanguage(), "zh-CN");
});

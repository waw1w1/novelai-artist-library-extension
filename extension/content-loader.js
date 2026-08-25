(() => {
  if (window.top !== window || globalThis.__naiPromptGalleryLoading) return;
  globalThis.__naiPromptGalleryLoading = true;

  import(chrome.runtime.getURL("src/main.js"))
    .then(({ mountNovelAiGallery }) => mountNovelAiGallery())
    .catch((error) => {
      globalThis.__naiPromptGalleryLoading = false;
      console.error("[NovelAI 提示词图库] 加载失败", error);
    });
})();

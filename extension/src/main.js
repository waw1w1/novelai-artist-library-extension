import { createGalleryPanel } from "./ui.js";

const HOST_ID = "nai-prompt-gallery-host";

export async function mountNovelAiGallery() {
  const existing = document.getElementById(HOST_ID);
  if (existing) return existing.__naiGalleryApi;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
  document.documentElement.append(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  try {
    style.textContent = await fetch(chrome.runtime.getURL("panel.css")).then((response) => response.text());
  } catch (error) {
    console.warn("[NovelAI 提示词图库] 样式加载失败", error);
  }
  shadow.append(style);

  const api = createGalleryPanel({ host, shadow });
  host.__naiGalleryApi = api;

  const syncRouteVisibility = () => {
    host.style.display = location.pathname.startsWith("/image") ? "block" : "none";
  };
  syncRouteVisibility();

  let lastUrl = location.href;
  const routeTimer = window.setInterval(() => {
    if (lastUrl !== location.href) {
      lastUrl = location.href;
      syncRouteVisibility();
    }
  }, 750);

  const reloadOnDirectoryChange = (message) => {
    if (message?.type === "DIRECTORY_CHANGED") api.reload({ preserveScroll: true });
  };
  chrome.runtime.onMessage.addListener(reloadOnDirectoryChange);

  window.addEventListener("focus", api.handleWindowFocus);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(routeTimer);
    chrome.runtime.onMessage.removeListener(reloadOnDirectoryChange);
    api.destroy();
  }, { once: true });

  await api.init();
  return api;
}

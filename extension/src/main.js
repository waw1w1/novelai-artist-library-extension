import { createGalleryPanel } from "./ui.js";
import { LANGUAGE_STORAGE_KEY, getStoredLanguage } from "./i18n.js";

const HOST_ID = "nai-prompt-gallery-host";
let mountedApi = null;

export async function mountNovelAiGallery() {
  const existing = document.getElementById(HOST_ID);
  if (existing) return mountedApi;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:10000;";
  document.documentElement.append(host);

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  try {
    style.textContent = await fetch(chrome.runtime.getURL("panel.css")).then((response) => response.text());
  } catch (error) {
    console.warn("[NovelAI 提示词图库] 样式加载失败", error);
  }
  shadow.append(style);

  const api = createGalleryPanel({ host, shadow, language: await getStoredLanguage() });
  mountedApi = api;

  const isImageRoute = () => /^\/image(?:\/|$)/u.test(location.pathname);
  let active = false;
  let initialized = false;
  const syncRouteLifecycle = async () => {
    const nextActive = isImageRoute();
    host.style.display = nextActive ? "block" : "none";
    if (nextActive === active) return;
    active = nextActive;
    if (active) {
      if (!initialized) {
        initialized = true;
        await api.init();
      } else {
        await api.resume();
      }
    } else {
      api.suspend();
    }
  };

  let lastUrl = location.href;
  const routeTimer = window.setInterval(() => {
    if (lastUrl !== location.href) {
      lastUrl = location.href;
      void syncRouteLifecycle();
    }
  }, 750);

  const reloadOnDirectoryChange = (message) => {
    if (message?.type === "DIRECTORY_CHANGED" && active) api.reload({ preserveScroll: true, reloadUiState: true });
  };
  chrome.runtime.onMessage.addListener(reloadOnDirectoryChange);
  const handleLanguageChange = (changes, areaName) => {
    if (areaName === "local" && changes[LANGUAGE_STORAGE_KEY]) api.setLanguage(changes[LANGUAGE_STORAGE_KEY].newValue);
  };
  chrome.storage.onChanged.addListener(handleLanguageChange);

  window.addEventListener("focus", api.handleWindowFocus);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(routeTimer);
    chrome.runtime.onMessage.removeListener(reloadOnDirectoryChange);
    chrome.storage.onChanged.removeListener(handleLanguageChange);
    api.destroy();
  }, { once: true });

  await syncRouteLifecycle();
  return api;
}

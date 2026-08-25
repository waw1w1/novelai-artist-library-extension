import {
  captureScrollAnchor,
  getDisplayItems,
  normalizeManifest,
  restoreScrollAnchor
} from "./core.js";
import {
  blobToDataUrl,
  dataUrlToFile,
  extractImageMetadata,
  sha256Blob
} from "./metadata.js";
import {
  collectAllPrompts,
  copyText,
  formatPromptSnapshot,
  prependArtistPrompt,
  selectSnapshotActionPrompt
} from "./novelai.js";
import { storage } from "./storage-client.js";
import { createTreeLocalizer, normalizeLanguage, translateMessage } from "./i18n.js";

const KINDS = Object.freeze({ artist: "画师串", character: "角色" });
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const FILE_CACHE_LIMIT = 32;
const FILE_READ_CONCURRENCY = 4;

function debounce(callback, delay) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function baseName(name) {
  return String(name || "未命名图片").replace(/\.[^.]+$/, "");
}

function isImageFile(file) {
  return file instanceof File && (
    ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(file.type.toLowerCase()) ||
    /\.(png|webp|jpe?g|gif|avif)$/i.test(file.name)
  );
}

function safeDraggedImageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!/^(?:(?:https?|blob|data):|\.{0,2}\/)/iu.test(text)) return null;
  try {
    const url = new URL(text, globalThis.location?.href || "https://novelai.net/");
    return ["https:", "http:", "blob:", "data:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function extractDraggedImageUrls(dataTransfer, rememberedSource = null) {
  const candidates = [rememberedSource?.url];
  try {
    const uriList = dataTransfer?.getData?.("text/uri-list") || "";
    candidates.push(...uriList.split(/\r?\n/u).filter((line) => line && !line.startsWith("#")));
  } catch {
    // 继续尝试其他拖放格式。
  }
  try {
    const html = dataTransfer?.getData?.("text/html") || "";
    if (html && typeof DOMParser === "function") {
      const document = new DOMParser().parseFromString(html, "text/html");
      candidates.push(...[...document.querySelectorAll("img[src], source[srcset]")].flatMap((element) => [
        element.getAttribute("src"),
        element.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/u)[0],
      ]));
    }
  } catch {
    // HTML 片段不是有效标记时继续尝试文本和自定义格式。
  }
  try {
    const plainText = dataTransfer?.getData?.("text/plain") || "";
    const downloadUrl = dataTransfer?.getData?.("DownloadURL") || "";
    candidates.push(plainText, downloadUrl.split(":").slice(2).join(":"));
  } catch {
    // 继续尝试自定义格式。
  }
  try {
    for (const type of Array.from(dataTransfer?.types || [])) {
      if (["Files", "text/uri-list", "text/html", "text/plain", "DownloadURL"].includes(type)) continue;
      const value = String(dataTransfer?.getData?.(type) || "").replaceAll("\\/", "/");
      candidates.push(value);
      candidates.push(...(value.match(/(?:https?|blob):\/\/[^\s"'<>\\]+/giu) || []));
    }
  } catch {
    // 某些浏览器只允许在 drop 阶段读取部分字符串数据；已记录的源图片仍可使用。
  }
  return [...new Set(candidates.map(safeDraggedImageUrl).filter(Boolean))];
}

export function extractElementImageSource(element) {
  if (!element || typeof element !== "object") return null;
  const image = String(element.tagName || "").toUpperCase() === "IMG"
    ? element
    : element.querySelector?.("img[src], img[srcset], img[data-src], picture img") || null;
  const candidates = [
    image?.currentSrc,
    image?.src,
    image?.srcset?.split(",")[0]?.trim().split(/\s+/u)[0],
    image?.getAttribute?.("data-src"),
    image?.getAttribute?.("data-original"),
    image?.getAttribute?.("data-full-src"),
    element.getAttribute?.("data-src"),
    element.getAttribute?.("data-image-src"),
    element.getAttribute?.("data-image-url"),
    element.getAttribute?.("data-original-url"),
    element.getAttribute?.("data-full-src"),
    element.getAttribute?.("data-url"),
    element.getAttribute?.("href"),
  ];
  try {
    const backgroundImage = element.ownerDocument?.defaultView?.getComputedStyle?.(element)?.backgroundImage || "";
    candidates.push(...[...backgroundImage.matchAll(/url\((?:["']?)(.*?)(?:["']?)\)/giu)].map((match) => match[1]));
  } catch {
    // 样式读取失败时仍可使用元素属性和子图片。
  }
  const url = candidates.map(safeDraggedImageUrl).find(Boolean);
  if (!url) return null;
  return {
    url,
    name: image?.getAttribute?.("download")
      || image?.alt
      || image?.title
      || element.getAttribute?.("aria-label")
      || element.getAttribute?.("title")
      || "novelai-image",
  };
}

export function draggedImageFileName(source, mimeType = "") {
  const fallbackExtension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]?.replace(/[^a-z0-9]/giu, "") || "png";
  const label = String(source?.name || "").trim().replace(/[\u0000-\u001f<>:"/\\|?*]/gu, "_");
  if (label && /\.[a-z0-9]{1,10}$/iu.test(label)) return label.slice(0, 180);
  try {
    const pathName = decodeURIComponent(new URL(source?.url).pathname.split("/").at(-1) || "");
    const safePathName = pathName.replace(/[\u0000-\u001f<>:"/\\|?*]/gu, "_");
    if (safePathName && /\.[a-z0-9]{1,10}$/iu.test(safePathName)) return safePathName.slice(0, 180);
  } catch {
    // blob/data URL 没有可用文件名。
  }
  return `${label || "novelai-image"}.${fallbackExtension}`.slice(0, 180);
}

export function isPointInsideRect(clientX, clientY, rect) {
  return clientX >= rect.left && clientX <= rect.right
    && clientY >= rect.top && clientY <= rect.bottom;
}

export function clampFloatingPosition(x, y, width, height, viewportWidth, viewportHeight, margin = 8) {
  const safeWidth = Math.max(0, Number(width) || 0);
  const safeHeight = Math.max(0, Number(height) || 0);
  const safeViewportWidth = Math.max(0, Number(viewportWidth) || 0);
  const safeViewportHeight = Math.max(0, Number(viewportHeight) || 0);
  const horizontalMargin = safeWidth + margin * 2 <= safeViewportWidth ? margin : 0;
  const verticalMargin = safeHeight + margin * 2 <= safeViewportHeight ? margin : 0;
  const maxX = Math.max(horizontalMargin, safeViewportWidth - safeWidth - horizontalMargin);
  const maxY = Math.max(verticalMargin, safeViewportHeight - safeHeight - verticalMargin);
  return {
    x: Math.round(Math.min(maxX, Math.max(horizontalMargin, Number(x) || 0))),
    y: Math.round(Math.min(maxY, Math.max(verticalMargin, Number(y) || 0))),
  };
}

export function resolveImportPromptSource(metadata, snapshot, kind) {
  if (metadata?.hasNovelAiMetadata) {
    const prompt = String(metadata.prompt || "").trim();
    return {
      source: "metadata",
      prompt,
      message: prompt
        ? "已检测到 NovelAI 图片 metadata，插件提示词将优先使用图片内置提示词。"
        : "已检测到 NovelAI 图片 metadata，但其中没有可识别的正向提示词；为避免来源混淆，不会自动改用网页提示词。",
    };
  }
  const selection = selectSnapshotActionPrompt(snapshot, kind);
  return {
    source: "page",
    prompt: selection.ok ? selection.prompt : "",
    message: selection.ok
      ? "未检测到可识别的 NovelAI 图片 metadata，已将当前 NovelAI 页面提示词作为回退来源。"
      : `未检测到可识别的 NovelAI 图片 metadata，已切换到当前页面提示词作为回退来源；${selection.message}`,
  };
}

function setButtonBusy(button, busy, text = "保存中…") {
  if (!button) return;
  if (busy) {
    button.dataset.previousText = button.textContent;
    button.textContent = text;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.previousText || button.textContent;
    button.disabled = false;
    delete button.dataset.previousText;
  }
}

class GalleryPanel {
  constructor({ host, shadow, language = "en" }) {
    this.host = host;
    this.shadow = shadow;
    this.language = normalizeLanguage(language);
    this.treeLocalizer = createTreeLocalizer();
    this.lastStatus = { kind: "loading", text: "正在连接数据目录…" };
    this.manifest = normalizeManifest(null);
    this.status = { configured: false };
    this.activeKind = "artist";
    this.expanded = false;
    this.minimized = false;
    this.positions = {};
    this.positionDrag = null;
    this.suppressRestoreClickUntil = 0;
    this.initializedState = false;
    this.cardNodes = new Map();
    this.fileCache = new Map();
    this.inFlightFiles = new Map();
    this.fileReadQueue = [];
    this.activeFileReads = 0;
    this.active = false;
    this.scrollAnchors = new Map();
    this.importQueue = [];
    this.pendingImport = null;
    this.dragState = null;
    this.dropTarget = null;
    this.pageDragSource = null;
    this.suppressClickUntil = 0;
    this.lastFocusReload = 0;
    this.destroyed = false;
    this.pendingUiPatch = {};
    this.reloadGeneration = 0;
    this.directoryKey = null;

    this.root = document.createElement("div");
    this.root.className = "nai-gallery-root";
    this.root.innerHTML = `
      <div class="nai-gallery-backdrop" data-action="collapse"></div>
      <section class="nai-gallery-panel" aria-label="NovelAI 提示词图库">
        <header class="nai-gallery-header">
          <div class="nai-gallery-title-wrap">
            <span class="nai-gallery-logo" aria-hidden="true">✦</span>
            <div>
              <strong>提示词图库</strong>
              <span class="nai-gallery-path">尚未选择数据目录</span>
            </div>
          </div>
          <div class="nai-gallery-header-actions">
            <button type="button" class="nai-icon-button" data-action="pick-files" aria-label="选择图片导入" title="选择图片导入">＋</button>
            <button type="button" class="nai-icon-button" data-action="settings" aria-label="设置" title="设置">⚙</button>
            <button type="button" class="nai-icon-button" data-action="minimize" aria-label="收束为小图标" title="收束为小图标">−</button>
            <button type="button" class="nai-icon-button" data-action="expand" aria-label="展开面板" title="展开面板">⛶</button>
            <input class="nai-file-picker" type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.avif,image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden>
          </div>
        </header>
        <nav class="nai-gallery-tabs" aria-label="图库类型">
          <button type="button" data-action="switch-kind" data-kind="artist" class="is-active">画师串</button>
          <button type="button" data-action="switch-kind" data-kind="character">角色</button>
        </nav>
        <div class="nai-gallery-scroll" tabindex="0">
          <div class="nai-gallery-grid" aria-live="polite"></div>
          <div class="nai-gallery-empty" hidden>
            <span class="nai-empty-icon" aria-hidden="true">＋</span>
            <strong>这里还没有图片</strong>
            <p>把图片直接拖进面板即可保存</p>
            <button type="button" data-action="settings">选择数据目录</button>
          </div>
        </div>
        <footer class="nai-gallery-footer">
          <span class="nai-status-dot"></span>
          <span class="nai-gallery-status">正在连接数据目录…</span>
          <span class="nai-drop-hint">拖入图片 · 拖动卡片排序或拖回 NovelAI</span>
        </footer>
      </section>
      <button type="button" class="nai-gallery-minimized" data-action="restore" aria-label="恢复提示词图库" title="恢复提示词图库"><span aria-hidden="true">✦</span></button>
      <div class="nai-modal-layer" hidden></div>
      <div class="nai-toast-region" aria-live="polite"></div>
    `;
    shadow.append(this.root);
    this.root.setAttribute("lang", this.language);
    this.treeLocalizer.apply(this.root, this.language);

    this.panel = this.root.querySelector(".nai-gallery-panel");
    this.minimizedButton = this.root.querySelector(".nai-gallery-minimized");
    this.scroll = this.root.querySelector(".nai-gallery-scroll");
    this.grid = this.root.querySelector(".nai-gallery-grid");
    this.empty = this.root.querySelector(".nai-gallery-empty");
    this.modalLayer = this.root.querySelector(".nai-modal-layer");
    this.pathLabel = this.root.querySelector(".nai-gallery-path");
    this.statusLabel = this.root.querySelector(".nai-gallery-status");
    this.statusDot = this.root.querySelector(".nai-status-dot");
    this.expandButton = this.root.querySelector('[data-action="expand"]');
    this.filePicker = this.root.querySelector(".nai-file-picker");

    this.persistUiDebounced = debounce(() => {
      const patch = this.pendingUiPatch;
      this.pendingUiPatch = {};
      this.persistUiState(patch);
    }, 1000);
    this.handleWindowFocus = this.handleWindowFocus.bind(this);
    this.onRootClick = this.onRootClick.bind(this);
    this.onPanelDragOver = this.onPanelDragOver.bind(this);
    this.onPanelDragLeave = this.onPanelDragLeave.bind(this);
    this.onPanelDrop = this.onPanelDrop.bind(this);
    this.onWindowDragGuard = this.onWindowDragGuard.bind(this);
    this.onWindowExternalDragCapture = this.onWindowExternalDragCapture.bind(this);
    this.onPageImageDragStart = this.onPageImageDragStart.bind(this);
    this.onPageDragEnd = this.onPageDragEnd.bind(this);
    this.onModalKeyDown = this.onModalKeyDown.bind(this);
    this.onPositionPointerDown = this.onPositionPointerDown.bind(this);
    this.onPositionPointerMove = this.onPositionPointerMove.bind(this);
    this.onPositionPointerUp = this.onPositionPointerUp.bind(this);
    this.handleViewportResize = this.handleViewportResize.bind(this);

    this.imageObserver = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting || !this.active) continue;
            const item = this.getItem(entry.target.dataset.itemId);
            if (item) this.loadCardFile(item, entry.target);
          }
        }, { root: this.scroll, rootMargin: "450px 0px", threshold: 0.01 })
      : null;

    this.root.addEventListener("click", this.onRootClick);
    this.root.addEventListener("pointerdown", this.onPositionPointerDown);
    this.filePicker.addEventListener("change", () => {
      const files = [...this.filePicker.files].filter(isImageFile);
      this.filePicker.value = "";
      this.queueImportedFiles(files);
    });
    this.scroll.addEventListener("scroll", () => {
      const kind = this.activeKind;
      const top = this.scroll.scrollTop;
      this.scheduleUiPersist({ scroll: { [kind]: top } });
    }, { passive: true });
    this.panel.addEventListener("dragover", this.onPanelDragOver);
    this.panel.addEventListener("dragleave", this.onPanelDragLeave);
    this.panel.addEventListener("drop", this.onPanelDrop);
    window.addEventListener("dragover", this.onWindowDragGuard);
    window.addEventListener("drop", this.onWindowDragGuard);
    window.addEventListener("dragstart", this.onPageImageDragStart, true);
    window.addEventListener("dragover", this.onWindowExternalDragCapture, true);
    window.addEventListener("drop", this.onWindowExternalDragCapture, true);
    window.addEventListener("dragend", this.onPageDragEnd, true);
    window.addEventListener("pointermove", this.onPositionPointerMove, true);
    window.addEventListener("pointerup", this.onPositionPointerUp, true);
    window.addEventListener("pointercancel", this.onPositionPointerUp, true);
    window.addEventListener("resize", this.handleViewportResize);
  }

  async init() {
    this.active = true;
    await this.reload({ preserveScroll: false });
  }

  t(value) {
    return translateMessage(value, this.language);
  }

  localizePromptSnapshot(value) {
    const text = String(value || "");
    if (this.language === "zh-CN") return text;
    return text
      .replaceAll("【主提示词】", "【Main Prompt】")
      .replace(/【角色 (\d+)】/gu, "【Character $1】")
      .replaceAll("（未检测到可用提示词）", "(No usable prompts detected)")
      .replaceAll("（空）", "(Empty)");
  }

  setLanguage(language) {
    const normalized = normalizeLanguage(language);
    if (normalized === this.language) return;
    this.language = normalized;
    this.root.setAttribute("lang", normalized);
    this.treeLocalizer.apply(this.root, normalized);
    this.renderDirectoryStatus();
    this.renderPanelState();
    this.reconcileCards();
    this.setStatus(this.lastStatus.kind, this.lastStatus.text);
    this.refreshOpenModalLanguage();
  }

  refreshOpenModalLanguage() {
    const form = this.modalLayer.querySelector(".nai-editor-modal form");
    if (form && this.pendingImport) {
      const pending = this.pendingImport;
      const usesMetadata = pending.promptResolution?.source === "metadata";
      form.elements.snapshot.value = usesMetadata
        ? pending.metadata?.prompt || this.t("（检测到 NovelAI metadata，但没有可识别的正向提示词）")
        : this.localizePromptSnapshot(formatPromptSnapshot(pending.snapshot));
      form.querySelector(".nai-section-heading strong").textContent = this.t(usesMetadata ? "图片内置 NovelAI 提示词" : "当前 NovelAI 页面提示词");
      form.querySelector(".nai-section-heading span").textContent = this.t(usesMetadata ? "优先来源：图片 metadata" : "回退来源：当前页面");
      form.querySelector('[data-action="copy-snapshot"]').textContent = this.t(usesMetadata ? "复制 metadata 提示词" : "复制全部");
      form.querySelector(".nai-metadata-summary").textContent = `${this.t(pending.promptResolution?.message || "提示词来源尚未确定")} · SHA-256 ${pending.hash.slice(0, 12)}…`;
    }
    const deleteModal = this.modalLayer.querySelector(".nai-delete-modal");
    const deleteItem = this.getItem(deleteModal?.dataset.itemId);
    if (deleteModal && deleteItem) {
      deleteModal.querySelector(".nai-delete-warning").textContent = this.t(`即将永久删除“${deleteItem.title || baseName(deleteItem.originalName)}”。删除后无法通过插件撤销。`);
    }
  }

  async resume() {
    if (this.destroyed) return;
    this.active = true;
    await this.reload({ preserveScroll: true });
  }

  suspend() {
    if (this.destroyed) return;
    this.active = false;
    this.reloadGeneration += 1;
    this.imageObserver?.disconnect();
    this.fileReadQueue.splice(0);
    this.clearFileCache();
  }

  async reload({ preserveScroll = true, reloadUiState = false } = {}) {
    if (this.destroyed || !this.active) return;
    const generation = ++this.reloadGeneration;
    const anchor = preserveScroll ? captureScrollAnchor(this.scroll) : null;
    const previousDirectoryKey = this.status?.selectedAt || null;
    try {
      this.setStatus("loading", "正在读取图库…");
      const nextStatus = await storage.getStatus();
      if (generation !== this.reloadGeneration) return;
      this.status = nextStatus;
      const nextDirectoryKey = this.status?.selectedAt || null;
      this.directoryKey = nextDirectoryKey;
      if (previousDirectoryKey && nextDirectoryKey && previousDirectoryKey !== nextDirectoryKey) {
        this.clearFileCache();
        this.clearCardNodes();
        this.initializedState = false;
      }
      if (!this.status?.configured) {
        this.manifest = normalizeManifest(null);
        this.renderDirectoryStatus();
        this.reconcileCards();
        this.setStatus("warning", "请先选择项目内的数据目录");
        return;
      }
      if (!this.status.ready) {
        this.status.needsPermission = this.status.permission !== "granted";
        this.clearFileCache();
        this.manifest = normalizeManifest(null);
        this.renderDirectoryStatus();
        this.reconcileCards();
        this.setStatus("warning", this.status.error || (this.status.needsPermission ? "数据目录需要重新授权" : "数据目录需要检查"));
        return;
      }

      const result = nextStatus.manifest ? { manifest: nextStatus.manifest } : await storage.getLibrary();
      if (generation !== this.reloadGeneration) return;
      this.manifest = normalizeManifest(result?.manifest ?? result);
      if (!this.initializedState || reloadUiState) {
        const savedUi = this.manifest.ui || {};
        if (savedUi.activeKind in KINDS) this.activeKind = savedUi.activeKind;
        this.expanded = Boolean(savedUi.expanded);
        this.minimized = Boolean(savedUi.minimized);
        this.positions = this.normalizeSavedPositions(savedUi.positions);
        this.initializedState = true;
      }
      this.renderDirectoryStatus();
      this.renderPanelState();
      this.reconcileCards();
      this.setStatus("ready", `${KINDS[this.activeKind]} · ${getDisplayItems(this.manifest, this.activeKind).length} 张`);

      if (anchor) {
        await nextFrame();
        restoreScrollAnchor(this.scroll, anchor);
      } else {
        const raw = Number(this.manifest.ui?.scroll?.[this.activeKind]);
        if (Number.isFinite(raw)) this.scroll.scrollTop = Math.max(0, raw);
      }
      this.hydrateVisibleFiles();
    } catch (error) {
      if (generation !== this.reloadGeneration) return;
      this.clearFileCache();
      this.manifest = normalizeManifest(null);
      this.reconcileCards();
      this.setStatus("error", error.message || "图库读取失败");
      if (["DIRECTORY_REQUIRED", "DIRECTORY_NOT_CONFIGURED", "REAUTHORIZATION_REQUIRED", "DIRECTORY_PERMISSION_REQUIRED"].includes(error.code)) {
        this.status = {
          configured: error.code === "DIRECTORY_PERMISSION_REQUIRED" || error.code === "REAUTHORIZATION_REQUIRED",
          needsPermission: error.code === "DIRECTORY_PERMISSION_REQUIRED" || error.code === "REAUTHORIZATION_REQUIRED"
        };
        this.renderDirectoryStatus();
        this.reconcileCards();
      }
      this.toast(error.message || "图库读取失败", "error");
    }
  }

  renderDirectoryStatus() {
    const name = this.status?.directoryName || this.status?.name;
    const source = name
      ? `数据目录：${name}`
      : this.status?.needsPermission
        ? "数据目录需要重新授权"
        : "尚未选择数据目录";
    this.pathLabel.textContent = this.t(source);
  }

  renderPanelState() {
    this.root.classList.toggle("is-expanded", this.expanded);
    this.root.classList.toggle("is-minimized", this.minimized);
    this.host.style.zIndex = this.expanded && !this.minimized ? "100000" : "10000";
    this.expandButton.textContent = this.expanded ? "↙" : "⛶";
    this.expandButton.setAttribute("aria-label", this.t(this.expanded ? "收回面板" : "展开面板"));
    this.expandButton.title = this.t(this.expanded ? "收回面板" : "展开面板");
    for (const button of this.root.querySelectorAll('[data-action="switch-kind"]')) {
      const selected = button.dataset.kind === this.activeKind;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    requestAnimationFrame(() => this.applyCurrentPosition());
  }

  normalizeSavedPositions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const output = {};
    for (const key of ["compact", "minimized"]) {
      const position = value[key];
      if (position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))) {
        output[key] = { x: Math.max(0, Number(position.x)), y: Math.max(0, Number(position.y)) };
      }
    }
    return output;
  }

  currentPositionKey() {
    if (this.minimized) return "minimized";
    return this.expanded ? null : "compact";
  }

  resetInlinePosition(element) {
    for (const property of ["left", "top", "right", "bottom", "transform"]) element.style.removeProperty(property);
  }

  applyCurrentPosition() {
    this.resetInlinePosition(this.panel);
    this.resetInlinePosition(this.minimizedButton);
    const key = this.currentPositionKey();
    if (!key) return;
    const target = key === "minimized" ? this.minimizedButton : this.panel;
    const saved = this.positions[key];
    if (!saved || !target.isConnected) return;
    const rect = target.getBoundingClientRect();
    const position = clampFloatingPosition(saved.x, saved.y, rect.width, rect.height, window.innerWidth, window.innerHeight);
    this.positions[key] = position;
    target.style.left = `${position.x}px`;
    target.style.top = `${position.y}px`;
    target.style.right = "auto";
    target.style.bottom = "auto";
    target.style.transform = "none";
  }

  onPositionPointerDown(event) {
    if (event.button !== 0 || !event.isPrimary) return;
    const minimizedTarget = event.target.closest(".nai-gallery-minimized");
    const headerTarget = event.target.closest(".nai-gallery-header");
    if (!minimizedTarget && (!headerTarget || this.expanded || this.minimized)) return;
    if (headerTarget && event.target.closest("button, input, select, textarea, a")) return;
    const key = minimizedTarget ? "minimized" : "compact";
    const target = minimizedTarget || this.panel;
    const rect = target.getBoundingClientRect();
    this.positionDrag = {
      key,
      target,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      moved: false,
    };
    target.setPointerCapture?.(event.pointerId);
    this.root.classList.add("is-position-dragging");
    event.preventDefault();
  }

  onPositionPointerMove(event) {
    const drag = this.positionDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    const rect = drag.target.getBoundingClientRect();
    const position = clampFloatingPosition(
      drag.originX + deltaX,
      drag.originY + deltaY,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
    );
    drag.target.style.left = `${position.x}px`;
    drag.target.style.top = `${position.y}px`;
    drag.target.style.right = "auto";
    drag.target.style.bottom = "auto";
    drag.target.style.transform = "none";
    drag.position = position;
    event.preventDefault();
  }

  onPositionPointerUp(event) {
    const drag = this.positionDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.target.releasePointerCapture?.(event.pointerId);
    this.positionDrag = null;
    this.root.classList.remove("is-position-dragging");
    if (!drag.moved || !drag.position) return;
    this.positions[drag.key] = drag.position;
    if (drag.key === "minimized") this.suppressRestoreClickUntil = performance.now() + 300;
    void this.persistUiState({ positions: { [drag.key]: drag.position } });
  }

  handleViewportResize() {
    const key = this.currentPositionKey();
    if (!key || !this.positions[key]) return;
    this.applyCurrentPosition();
    this.scheduleUiPersist({ positions: { [key]: this.positions[key] } });
  }

  reconcileCards() {
    const items = getDisplayItems(this.manifest, this.activeKind);
    const wanted = new Set(items.map((item) => item.id));
    for (const child of [...this.grid.children]) {
      if (!wanted.has(child.dataset.itemId)) child.remove();
    }
    for (const [id, card] of this.cardNodes) {
      if (Object.prototype.hasOwnProperty.call(this.manifest.items, id)) continue;
      this.imageObserver?.unobserve(card);
      card.remove();
      this.cardNodes.delete(id);
      this.evictFile(id);
    }

    for (const item of items) {
      let card = this.cardNodes.get(item.id);
      if (!card) {
        card = this.createCard(item);
        this.cardNodes.set(item.id, card);
      }
      this.updateCard(card, item);
      this.grid.append(card);
      this.imageObserver?.observe(card);
    }

    const hasItems = items.length > 0;
    this.empty.hidden = hasItems;
    this.grid.hidden = !hasItems;
    const emptyTitle = this.empty.querySelector("strong");
    const emptyText = this.empty.querySelector("p");
    if (!this.status?.configured || !this.status?.ready) {
      emptyTitle.textContent = this.t(this.status?.configured ? "检查数据目录" : "先选择数据目录");
      emptyText.textContent = this.t(this.status?.error || (this.status?.configured
        ? "目录需要重新授权或修复清单"
        : "真实图片和清单会保存在你选择的文件夹中"));
      this.empty.querySelector("button").hidden = false;
    } else {
      emptyTitle.textContent = this.t(`还没有${KINDS[this.activeKind]}图片`);
      emptyText.textContent = this.t("把图片直接拖进面板即可保存");
      this.empty.querySelector("button").hidden = true;
    }
    if (this.status?.ready) {
      this.setStatus("ready", `${KINDS[this.activeKind]} · ${items.length} 张`);
    }
  }

  createCard(item) {
    const card = document.createElement("article");
    card.className = "nai-gallery-card is-loading";
    card.dataset.itemId = item.id;
    card.dataset.libraryItemId = item.id;
    card.draggable = true;
    card.innerHTML = `
      <button type="button" class="nai-card-heart" data-action="favorite" aria-label="收藏" title="收藏" draggable="false">♡</button>
      <button type="button" class="nai-card-edit" data-action="edit" aria-label="编辑提示词" title="编辑提示词" draggable="false">✎</button>
      <button type="button" class="nai-card-delete" data-action="delete" aria-label="删除图片" title="删除图片" draggable="false">×</button>
      <button type="button" class="nai-card-activate" aria-label="使用这张图片的提示词" draggable="false">
        <span class="nai-card-media">
          <span class="nai-image-loader">正在读取…</span>
          <img alt="" draggable="false">
          <span class="nai-metadata-badge" hidden>METADATA</span>
        </span>
        <span class="nai-card-caption">
          <strong></strong>
          <span></span>
        </span>
      </button>
    `;
    card.addEventListener("dragstart", (event) => this.onCardDragStart(event, card.dataset.itemId));
    card.addEventListener("dragend", () => this.onCardDragEnd());
    this.treeLocalizer.apply(card, this.language);
    return card;
  }

  updateCard(card, item) {
    card.dataset.favorite = String(Boolean(item.favorite));
    card.classList.toggle("is-favorite", Boolean(item.favorite));
    card.querySelector(".nai-card-heart").textContent = item.favorite ? "♥" : "♡";
    card.querySelector(".nai-card-heart").title = this.t(item.favorite ? "取消置顶" : "爱心置顶");
    card.querySelector(".nai-card-heart").setAttribute("aria-label", this.t(item.favorite ? "取消置顶" : "爱心置顶"));
    card.querySelector(".nai-card-caption strong").textContent = item.title || baseName(item.originalName);
    const prompt = item.actionPrompt || this.t("尚未填写提示词");
    card.querySelector(".nai-card-caption span").textContent = Array.from(prompt).slice(0, 120).join("");
    card.querySelector("img").alt = this.t(`${item.title || this.t(KINDS[item.kind])}预览`);
    const badge = card.querySelector(".nai-metadata-badge");
    badge.hidden = !(item.metadata?.hasMetadata || item.hasMetadata);
  }

  async hydrateVisibleFiles() {
    if (!this.active) return;
    const items = getDisplayItems(this.manifest, this.activeKind);
    if (this.imageObserver) {
      this.imageObserver.disconnect();
      for (const item of items) {
        const card = this.cardNodes.get(item.id);
        if (card) this.imageObserver.observe(card);
      }
      return;
    }
    for (const item of items.slice(0, FILE_READ_CONCURRENCY)) {
      const card = this.cardNodes.get(item.id);
      if (card) this.loadCardFile(item, card);
    }
  }

  loadCardFile(item, card) {
    this.ensureFileLoaded(item).catch((error) => {
      if (!this.active || !card.isConnected) return;
      card.classList.remove("is-loading");
      card.classList.add("has-image-error");
      card.querySelector(".nai-image-loader").textContent = this.t("图片读取失败");
      console.warn("[NovelAI 提示词图库] 图片读取失败", item.id, error);
    });
  }

  runFileRead(task) {
    return new Promise((resolve, reject) => {
      this.fileReadQueue.push({ task, resolve, reject });
      this.drainFileReads();
    });
  }

  drainFileReads() {
    while (this.active && this.activeFileReads < FILE_READ_CONCURRENCY && this.fileReadQueue.length) {
      const entry = this.fileReadQueue.shift();
      this.activeFileReads += 1;
      Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => {
        this.activeFileReads -= 1;
        this.drainFileReads();
      });
    }
  }

  async ensureFileLoaded(item) {
    const existing = this.fileCache.get(item.id);
    if (existing && (!item.sha256 || existing.sha256 === item.sha256)) {
      this.fileCache.delete(item.id);
      this.fileCache.set(item.id, existing);
      return existing;
    }
    if (existing) {
      URL.revokeObjectURL(existing.objectUrl);
      this.fileCache.delete(item.id);
    }
    if (this.inFlightFiles.has(item.id)) return this.inFlightFiles.get(item.id);
    const promise = this.runFileRead(() => this.fetchAndCacheFile(item));
    this.inFlightFiles.set(item.id, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightFiles.get(item.id) === promise) this.inFlightFiles.delete(item.id);
    }
  }

  async fetchAndCacheFile(item) {
    const generation = this.reloadGeneration;
    const directoryKey = this.directoryKey;
    const expectedSha = item.sha256 || null;
    const result = await storage.getFile(item.id);
    const currentItem = this.manifest.items?.[item.id];
    if (
      generation !== this.reloadGeneration ||
      directoryKey !== this.directoryKey ||
      !currentItem ||
      (expectedSha && currentItem.sha256 !== expectedSha)
    ) {
      return null;
    }
    const file = await dataUrlToFile(
      result.dataUrl,
      result.name || item.originalName || `${item.id}.png`,
      result.lastModified || item.lastModified || Date.now()
    );
    const objectUrl = URL.createObjectURL(file);
    const cached = { file, objectUrl, sha256: result.sha256 || item.sha256 };
    this.fileCache.set(item.id, cached);
    this.enforceFileCacheLimit();
    const card = this.cardNodes.get(item.id);
    if (card) {
      card.querySelector("img").src = objectUrl;
      card.classList.remove("is-loading", "has-image-error");
    }
    return cached;
  }

  enforceFileCacheLimit() {
    while (this.fileCache.size > FILE_CACHE_LIMIT) {
      const oldestId = this.fileCache.keys().next().value;
      this.evictFile(oldestId);
    }
  }

  evictFile(id) {
    const cached = this.fileCache.get(id);
    if (!cached) return;
    URL.revokeObjectURL(cached.objectUrl);
    this.fileCache.delete(id);
    const image = this.cardNodes.get(id)?.querySelector("img");
    if (image?.src === cached.objectUrl) image.removeAttribute("src");
  }

  getItem(id) {
    return this.manifest.items?.[id] || null;
  }

  async onRootClick(event) {
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      const action = actionButton.dataset.action;
      if (["favorite", "save-import", "save-edit"].includes(action) && !event.isTrusted) return;
      if (action === "pick-files") {
        this.filePicker.click();
      } else if (action === "settings") {
        try {
          await storage.openSettings();
        } catch (error) {
          this.toast(error.message || "无法打开设置页", "error");
        }
      } else if (action === "expand" || action === "collapse") {
        if (action === "collapse" && !this.expanded) return;
        await this.toggleExpanded();
      } else if (action === "minimize") {
        this.setMinimized(true);
      } else if (action === "restore") {
        if (performance.now() < this.suppressRestoreClickUntil) return;
        this.setMinimized(false);
      } else if (action === "switch-kind") {
        await this.switchKind(actionButton.dataset.kind);
      } else if (action === "favorite") {
        const card = actionButton.closest(".nai-gallery-card");
        if (card) await this.toggleFavorite(card.dataset.itemId, actionButton);
      } else if (action === "edit") {
        const card = actionButton.closest(".nai-gallery-card");
        if (card) this.openItemEditor(card.dataset.itemId);
      } else if (action === "delete") {
        const card = actionButton.closest(".nai-gallery-card");
        if (card) this.openDeleteConfirm(card.dataset.itemId);
      } else {
        await this.handleModalAction(action, actionButton);
      }
      return;
    }

    const card = event.target.closest(".nai-gallery-card");
    if (card && performance.now() >= this.suppressClickUntil) {
      await this.activateItem(card.dataset.itemId);
    }
  }

  async activateItem(id) {
    const item = this.getItem(id);
    if (!item?.actionPrompt?.trim()) {
      this.toast("请先点右上角编辑按钮填写提示词", "warning");
      return;
    }
    try {
      if (item.kind === "artist") {
        const result = await prependArtistPrompt(item.actionPrompt.trim());
        if (result === false || result?.ok === false) throw new Error(result?.error || "未能写入提示词框");
        this.toast("画师串已添加到正向提示词顶部", "success");
      } else {
        const copied = await copyText(item.actionPrompt.trim());
        if (!copied) throw new Error("浏览器未允许写入剪贴板");
        this.toast("角色 tag 已复制到剪贴板", "success");
      }
    } catch (error) {
      this.toast(error.message || "操作失败", "error");
    }
  }

  async toggleExpanded() {
    const anchor = captureScrollAnchor(this.scroll);
    this.expanded = !this.expanded;
    this.renderPanelState();
    await nextFrame();
    restoreScrollAnchor(this.scroll, anchor);
    this.scheduleUiPersist({ expanded: this.expanded });
  }

  setMinimized(minimized) {
    if (this.minimized === minimized) return;
    this.minimized = minimized;
    this.renderPanelState();
    void this.persistUiState({ minimized });
  }

  async switchKind(kind) {
    if (!(kind in KINDS) || kind === this.activeKind) return;
    const previousKind = this.activeKind;
    const previousTop = this.scroll.scrollTop;
    this.scrollAnchors.set(previousKind, captureScrollAnchor(this.scroll));
    this.activeKind = kind;
    this.renderPanelState();
    this.reconcileCards();
    await nextFrame();
    const savedAnchor = this.scrollAnchors.get(kind);
    if (savedAnchor) restoreScrollAnchor(this.scroll, savedAnchor);
    else this.scroll.scrollTop = Number(this.manifest.ui?.scroll?.[kind]) || 0;
    this.setStatus("ready", `${KINDS[kind]} · ${getDisplayItems(this.manifest, kind).length} 张`);
    this.hydrateVisibleFiles();
    this.scheduleUiPersist({ activeKind: kind, scroll: { [previousKind]: previousTop } });
  }

  async toggleFavorite(id, button) {
    if (!this.status?.ready) return;
    const anchor = captureScrollAnchor(this.scroll);
    const operationGeneration = this.reloadGeneration;
    const operationDirectoryKey = this.directoryKey;
    button.disabled = true;
    try {
      const result = await storage.toggleFavorite(id);
      if (!this.isOperationCurrent(operationGeneration, operationDirectoryKey)) {
        await this.reload({ preserveScroll: true });
        return;
      }
      this.manifest = normalizeManifest(result?.manifest ?? result);
      this.reconcileCards();
      await nextFrame();
      restoreScrollAnchor(this.scroll, anchor);
    } catch (error) {
      this.toast(error.message || "收藏状态保存失败", "error");
    } finally {
      button.disabled = false;
    }
  }

  onCardDragStart(event, id) {
    if (event.target.closest(".nai-card-heart, .nai-card-edit, .nai-card-delete")) {
      event.preventDefault();
      return;
    }
    const item = this.getItem(id);
    const cached = this.fileCache.get(id);
    if (!item || !cached?.file) {
      event.preventDefault();
      this.toast("图片仍在准备，请稍后再拖", "warning");
      return;
    }
    try {
      event.dataTransfer.clearData();
      const addedFile = event.dataTransfer.items.add(cached.file);
      if (!addedFile || !Array.from(event.dataTransfer.types || []).includes("Files")) {
        throw new Error("File 未加入拖拽数据");
      }
      event.dataTransfer.effectAllowed = "copyMove";
    } catch (error) {
      event.preventDefault();
      this.toast("当前浏览器未能准备拖出文件", "error");
      return;
    }
    this.dragState = { id, favorite: Boolean(item.favorite), kind: item.kind };
    this.root.classList.add("is-internal-drag");
    this.root.classList.toggle("is-dragging-favorite", Boolean(item.favorite));
    this.root.classList.toggle("is-dragging-normal", !item.favorite);
    for (const card of this.grid.children) {
      const blocked = (card.dataset.favorite === "true") !== Boolean(item.favorite);
      card.classList.toggle("is-blocked-drop", blocked);
      card.classList.toggle("is-drag-source", card.dataset.itemId === id);
    }
  }

  onCardDragEnd() {
    this.suppressClickUntil = performance.now() + 350;
    this.clearDragVisuals();
  }

  clearDragVisuals() {
    this.dragState = null;
    this.dropTarget = null;
    this.root.classList.remove("is-internal-drag", "is-dragging-favorite", "is-dragging-normal", "is-file-hover");
    for (const card of this.grid.children) {
      card.classList.remove("is-blocked-drop", "is-drag-source", "drop-before", "drop-after");
    }
  }

  hasInternalDrag(event) {
    return Boolean(this.dragState && event.dataTransfer);
  }

  onPanelDragOver(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    if (this.hasInternalDrag(event)) {
      event.preventDefault();
      this.clearDropMarkers();
      const card = event.target.closest(".nai-gallery-card");
      if (!card || card.dataset.itemId === this.dragState.id) {
        event.dataTransfer.dropEffect = "none";
        return;
      }
      const samePartition = (card.dataset.favorite === "true") === this.dragState.favorite;
      if (!samePartition) {
        event.dataTransfer.dropEffect = "none";
        return;
      }
      const rect = card.getBoundingClientRect();
      const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      card.classList.add(position === "before" ? "drop-before" : "drop-after");
      this.dropTarget = { id: card.dataset.itemId, position };
      event.dataTransfer.dropEffect = "move";
      this.autoScroll(event.clientY);
    } else if (types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      this.root.classList.add("is-file-hover");
      this.autoScroll(event.clientY);
    }
  }

  onPanelDragLeave(event) {
    if (!this.panel.contains(event.relatedTarget)) {
      this.root.classList.remove("is-file-hover");
      this.clearDropMarkers();
    }
  }

  async onPanelDrop(event) {
    if (this.hasInternalDrag(event)) {
      event.preventDefault();
      event.stopPropagation();
      const target = this.dropTarget;
      const drag = this.dragState;
      this.clearDragVisuals();
      if (!target || !drag) return;
      const anchor = captureScrollAnchor(this.scroll);
      const operationGeneration = this.reloadGeneration;
      const operationDirectoryKey = this.directoryKey;
      try {
        const result = await storage.reorderItems({
          kind: drag.kind,
          dragId: drag.id,
          targetId: target.id,
          position: target.position
        });
        if (!this.isOperationCurrent(operationGeneration, operationDirectoryKey)) return;
        this.manifest = normalizeManifest(result?.manifest ?? result);
        this.reconcileCards();
        await nextFrame();
        restoreScrollAnchor(this.scroll, anchor);
      } catch (error) {
        this.toast(error.message || "排序保存失败", "error");
      }
      return;
    }

    const files = [...(event.dataTransfer?.files || [])].filter(isImageFile);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    this.root.classList.remove("is-file-hover");
    this.queueImportedFiles(files);
  }

  queueImportedFiles(files) {
    if (!files.length) return;
    if (!this.status?.ready) {
      this.toast(this.status?.configured ? "请先在设置中检查或重新授权数据目录" : "请先在设置中选择项目内的数据目录", "warning");
      storage.openSettings().catch((error) => this.toast(error.message || "无法打开设置页", "error"));
      return;
    }
    const supportedFiles = files.filter((file) => {
      if (file.size <= MAX_IMAGE_BYTES) return true;
      this.toast(`${file.name} 超过 32 MiB，无法通过当前 Edge 消息通道安全保存`, "error");
      return false;
    });
    this.importQueue.push(...supportedFiles);
    if (!this.pendingImport && this.modalLayer.hidden) this.startNextImport();
  }

  onWindowDragGuard(event) {
    if (this.dragState && Array.from(event.dataTransfer?.types || []).includes("Files")) {
      // 在冒泡阶段兜底防止浏览器导航；NovelAI 的目标监听器会先收到事件。
      if (!event.defaultPrevented) event.preventDefault();
    }
  }

  onPageImageDragStart(event) {
    if (!this.active || this.host.contains(event.target)) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    const pointElements = event.target?.ownerDocument?.elementsFromPoint?.(event.clientX, event.clientY) || [];
    this.pageDragSource = [...path, ...pointElements]
      .map(extractElementImageSource)
      .find(Boolean) || null;
    queueMicrotask(() => {
      if (this.pageDragSource) return;
      const [url] = extractDraggedImageUrls(event.dataTransfer);
      if (url) this.pageDragSource = { url, name: "novelai-history-image" };
    });
  }

  onPageDragEnd() {
    this.pageDragSource = null;
    this.root.classList.remove("is-file-hover");
  }

  isPointInsidePanel(event) {
    const rect = this.panel.getBoundingClientRect();
    return isPointInsideRect(event.clientX, event.clientY, rect);
  }

  hasExternalImagePayload(dataTransfer) {
    const types = Array.from(dataTransfer?.types || []);
    return Boolean(
      this.pageDragSource
      || types.includes("Files")
      || types.includes("text/uri-list")
      || types.includes("text/html")
      || types.includes("text/plain")
      || types.includes("DownloadURL")
      || types.some((type) => /image|novelai|nai/iu.test(type)),
    );
  }

  onWindowExternalDragCapture(event) {
    if (!this.active || this.dragState || !this.isPointInsidePanel(event) || !this.hasExternalImagePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.root.classList.add("is-file-hover");
    if (event.type === "dragover") {
      this.autoScroll(event.clientY);
      return;
    }

    const transfer = event.dataTransfer;
    const files = [
      ...Array.from(transfer?.files || []),
      ...Array.from(transfer?.items || []).map((item) => {
        try { return item.kind === "file" ? item.getAsFile() : null; } catch { return null; }
      }),
    ].filter((file, index, all) => file && isImageFile(file) && all.indexOf(file) === index);
    const source = this.pageDragSource ? { ...this.pageDragSource } : null;
    const urls = extractDraggedImageUrls(transfer, source);
    this.pageDragSource = null;
    this.root.classList.remove("is-file-hover");
    if (files.length) {
      this.queueImportedFiles(files);
      return;
    }
    void this.importDraggedPageImage(urls, source);
  }

  async importDraggedPageImage(urls, source) {
    if (!urls.length) {
      this.toast("没有从拖动内容中读取到图片，请尝试拖动图片本身。", "error");
      return;
    }
    this.setStatus("loading", "正在读取拖入的 NovelAI 图片…");
    let lastError = null;
    for (const url of urls) {
      try {
        const response = await fetch(url, { credentials: "include", cache: "force-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const mimeType = blob.type.toLowerCase();
        if (!mimeType.startsWith("image/")) throw new Error("响应不是图片");
        const file = new File([blob], draggedImageFileName({ ...source, url }, mimeType), {
          type: mimeType,
          lastModified: Date.now(),
        });
        if (!isImageFile(file)) throw new Error("图片格式不受支持");
        this.queueImportedFiles([file]);
        this.setStatus("ready", `${KINDS[this.activeKind]} · ${getDisplayItems(this.manifest, this.activeKind).length} 张`);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    this.setStatus("ready", `${KINDS[this.activeKind]} · ${getDisplayItems(this.manifest, this.activeKind).length} 张`);
    this.toast(`无法读取拖入的网页图片：${lastError?.message || "未知错误"}`, "error");
  }

  clearDropMarkers() {
    this.dropTarget = null;
    for (const card of this.grid.children) card.classList.remove("drop-before", "drop-after");
  }

  autoScroll(clientY) {
    const rect = this.scroll.getBoundingClientRect();
    const edge = Math.min(72, rect.height * 0.18);
    if (clientY < rect.top + edge) this.scroll.scrollTop -= 18;
    else if (clientY > rect.bottom - edge) this.scroll.scrollTop += 18;
  }

  startNextImport() {
    const file = this.importQueue.shift();
    if (!file) {
      this.pendingImport = null;
      this.closeModal();
      return;
    }
    this.pendingImport = { file };
    this.openKindChooser(file);
  }

  openKindChooser(file) {
    const modal = this.createModal("保存这张图片", "先选择图片用途，下一步可以填写提示词。", "nai-kind-modal");
    const preview = document.createElement("div");
    preview.className = "nai-import-preview-row";
    const image = document.createElement("img");
    const previewUrl = URL.createObjectURL(file);
    image.src = previewUrl;
    const cleanupPreview = () => URL.revokeObjectURL(previewUrl);
    image.addEventListener("load", cleanupPreview, { once: true });
    image.addEventListener("error", cleanupPreview, { once: true });
    modal.element.__cleanup = cleanupPreview;
    image.alt = file.name;
    const name = document.createElement("span");
    name.textContent = file.name;
    preview.append(image, name);
    modal.body.append(preview);

    const choices = document.createElement("div");
    choices.className = "nai-kind-choices";
    choices.innerHTML = `
      <button type="button" data-action="choose-import-kind" data-kind="artist"><strong>画师串</strong><span>点击图片时写入正向提示词顶部</span></button>
      <button type="button" data-action="choose-import-kind" data-kind="character"><strong>角色</strong><span>点击图片时复制角色 tag</span></button>
    `;
    modal.body.append(choices);
    modal.footer.innerHTML = '<button type="button" class="nai-secondary" data-action="cancel-import">取消这张</button>';
    this.showModal(modal.element);
  }

  async prepareImport(kind) {
    const file = this.pendingImport?.file;
    if (!file) return;
    this.showLoadingModal("正在读取原图和 metadata…");
    try {
      const buffer = await file.arrayBuffer();
      const [hash, dataUrl, metadata] = await Promise.all([
        sha256Blob(buffer),
        blobToDataUrl(buffer, file.type),
        Promise.resolve(extractImageMetadata(buffer, file.type)),
      ]);
      const snapshot = metadata.hasNovelAiMetadata ? null : collectAllPrompts();
      const promptResolution = resolveImportPromptSource(metadata, snapshot, kind);
      this.pendingImport = { file, kind, hash, dataUrl, snapshot, metadata, promptResolution };
      this.openImportEditor();
    } catch (error) {
      this.toast(error.message || "图片读取失败", "error");
      this.startNextImport();
    }
  }

  openImportEditor() {
    const pending = this.pendingImport;
    const modal = this.createModal("填写插件提示词", "原图会按原始字节保存，不会重编码。", "nai-editor-modal");
    const form = document.createElement("form");
    form.className = "nai-editor-form";
    form.addEventListener("submit", (event) => event.preventDefault());

    const usesMetadata = pending.promptResolution?.source === "metadata";
    const snapshotText = usesMetadata
      ? pending.metadata?.prompt || this.t("（检测到 NovelAI metadata，但没有可识别的正向提示词）")
      : this.localizePromptSnapshot(formatPromptSnapshot(pending.snapshot));
    form.innerHTML = `
      <section class="nai-prompt-snapshot">
        <div class="nai-section-heading"><strong></strong><span></span></div>
        <textarea name="snapshot" readonly></textarea>
        <div class="nai-inline-actions">
          <button type="button" class="nai-secondary" data-action="copy-snapshot">复制全部</button>
          <button type="button" class="nai-secondary" data-action="refresh-snapshot">重新读取</button>
          <button type="button" class="nai-secondary" data-action="use-snapshot">填入下方</button>
        </div>
      </section>
      <div class="nai-form-row two-columns">
        <label>用途<select name="kind"><option value="artist">画师串</option><option value="character">角色</option></select></label>
        <label>名称<input name="title" maxlength="100" autocomplete="off"></label>
      </div>
      <label>插件保存的提示词<textarea name="actionPrompt" rows="5" placeholder="把上方需要的提示词复制或粘贴到这里"></textarea></label>
      <div class="nai-metadata-summary"></div>
      <div class="nai-form-error" hidden></div>
    `;
    form.elements.snapshot.value = snapshotText;
    const snapshotHeading = form.querySelector(".nai-section-heading strong");
    const snapshotDescription = form.querySelector(".nai-section-heading span");
    snapshotHeading.textContent = this.t(usesMetadata ? "图片内置 NovelAI 提示词" : "当前 NovelAI 页面提示词");
    snapshotDescription.textContent = this.t(usesMetadata ? "优先来源：图片 metadata" : "回退来源：当前页面");
    form.querySelector('[data-action="copy-snapshot"]').textContent = this.t(usesMetadata ? "复制 metadata 提示词" : "复制全部");
    form.querySelector('[data-action="copy-snapshot"]').hidden = usesMetadata && !pending.metadata?.prompt;
    form.querySelector('[data-action="refresh-snapshot"]').hidden = usesMetadata;
    form.querySelector('[data-action="use-snapshot"]').hidden = usesMetadata;
    form.elements.kind.value = pending.kind;
    form.elements.title.value = baseName(pending.file.name);
    form.elements.actionPrompt.value = pending.promptResolution?.prompt || "";
    const metaSummary = form.querySelector(".nai-metadata-summary");
    metaSummary.classList.toggle("has-metadata", usesMetadata);
    metaSummary.textContent = `${this.t(pending.promptResolution?.message || "提示词来源尚未确定")} · SHA-256 ${pending.hash.slice(0, 12)}…`;
    modal.body.append(form);
    modal.footer.innerHTML = `
      <button type="button" class="nai-secondary" data-action="cancel-import">取消这张</button>
      <button type="button" class="nai-primary" data-action="save-import">保存</button>
    `;
    this.showModal(modal.element);
  }

  openItemEditor(id) {
    const item = this.getItem(id);
    if (!item) return;
    const modal = this.createModal("编辑图片提示词", "只修改插件提示词，不会改写原图 metadata。", "nai-editor-modal");
    modal.element.dataset.itemId = id;
    const form = document.createElement("form");
    form.className = "nai-editor-form";
    form.addEventListener("submit", (event) => event.preventDefault());
    form.innerHTML = `
      <div class="nai-form-row two-columns">
        <label>用途<select name="kind"><option value="artist">画师串</option><option value="character">角色</option></select></label>
        <label>名称<input name="title" maxlength="100" autocomplete="off"></label>
      </div>
      <label>插件保存的提示词<textarea name="actionPrompt" rows="7" placeholder="输入画师串或角色 tag"></textarea></label>
      <div class="nai-form-error" hidden></div>
    `;
    form.elements.kind.value = item.kind;
    form.elements.title.value = item.title || baseName(item.originalName);
    form.elements.actionPrompt.value = item.actionPrompt || "";
    modal.body.append(form);
    modal.footer.innerHTML = `
      <button type="button" class="nai-secondary" data-action="close-modal">取消</button>
      <button type="button" class="nai-primary" data-action="save-edit">保存修改</button>
    `;
    this.showModal(modal.element);
  }

  openDeleteConfirm(id) {
    const item = this.getItem(id);
    if (!item) return;
    const modal = this.createModal("删除这张图片？", "此操作会从图库和本地 images 文件夹中删除该图片。", "nai-delete-modal");
    modal.element.dataset.itemId = id;
    const warning = document.createElement("p");
    warning.className = "nai-delete-warning";
    warning.textContent = this.t(`即将永久删除“${item.title || baseName(item.originalName)}”。删除后无法通过插件撤销。`);
    modal.body.append(warning);
    modal.footer.innerHTML = `
      <button type="button" class="nai-secondary" data-action="close-modal">取消</button>
      <button type="button" class="nai-danger-button" data-action="confirm-delete">确认删除</button>
    `;
    this.showModal(modal.element);
  }

  createModal(title, description, className = "") {
    const element = document.createElement("div");
    element.className = `nai-modal ${className}`;
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-modal", "true");
    element.innerHTML = `
      <header><div><h2></h2><p></p></div><button type="button" data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="nai-modal-body"></div>
      <footer class="nai-modal-footer"></footer>
    `;
    element.querySelector("h2").textContent = this.t(title);
    element.querySelector("header p").textContent = this.t(description);
    return {
      element,
      body: element.querySelector(".nai-modal-body"),
      footer: element.querySelector(".nai-modal-footer")
    };
  }

  showModal(element) {
    if (this.modalLayer.hidden) this.modalReturnFocus = this.shadow.activeElement || document.activeElement;
    this.modalLayer.firstElementChild?.__cleanup?.();
    this.modalLayer.replaceChildren(element);
    this.treeLocalizer.apply(element, this.language);
    this.modalLayer.hidden = false;
    this.host.style.zIndex = "100000";
    this.modalLayer.addEventListener("keydown", this.onModalKeyDown);
    requestAnimationFrame(() => {
      element.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([readonly]):not([disabled]), button:not([disabled]):not([hidden])')?.focus();
    });
  }

  closeModal() {
    this.modalLayer.firstElementChild?.__cleanup?.();
    this.modalLayer.removeEventListener("keydown", this.onModalKeyDown);
    this.modalLayer.hidden = true;
    this.modalLayer.replaceChildren();
    this.host.style.zIndex = this.expanded ? "100000" : "10000";
    this.modalReturnFocus?.focus?.({ preventScroll: true });
    this.modalReturnFocus = null;
  }

  onModalKeyDown(event) {
    if (event.key === "Escape") {
      const closeButton = this.modalLayer.querySelector('[data-action="close-modal"]:not([hidden])');
      if (closeButton) {
        event.preventDefault();
        closeButton.click();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...this.modalLayer.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && this.shadow.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && this.shadow.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  showLoadingModal(text) {
    const modal = this.createModal("请稍候", text, "nai-loading-modal");
    modal.element.querySelector('[data-action="close-modal"]').hidden = true;
    modal.body.innerHTML = '<div class="nai-big-loader" aria-hidden="true"></div>';
    this.showModal(modal.element);
  }

  async handleModalAction(action, button) {
    if (action === "close-modal") {
      if (this.pendingImport) {
        this.pendingImport = null;
        this.startNextImport();
      } else this.closeModal();
    } else if (action === "cancel-import") {
      this.pendingImport = null;
      this.startNextImport();
    } else if (action === "choose-import-kind") {
      await this.prepareImport(button.dataset.kind);
    } else if (action === "copy-snapshot") {
      const text = this.modalLayer.querySelector('[name="snapshot"]')?.value || "";
      const copied = await copyText(text);
      if (!copied) {
        this.toast("浏览器未允许写入剪贴板", "error");
        return;
      }
      this.toast("当前提示词已复制", "success");
    } else if (action === "refresh-snapshot") {
      if (this.pendingImport?.promptResolution?.source === "metadata") return;
      const snapshot = await Promise.resolve(collectAllPrompts());
      this.pendingImport.snapshot = snapshot;
      this.pendingImport.promptResolution = resolveImportPromptSource(this.pendingImport.metadata, snapshot, this.pendingImport.kind);
      this.modalLayer.querySelector('[name="snapshot"]').value = this.localizePromptSnapshot(formatPromptSnapshot(snapshot));
      this.toast("已重新读取当前提示词", "success");
    } else if (action === "use-snapshot") {
      const form = this.modalLayer.querySelector("form");
      if (this.pendingImport?.promptResolution?.source === "metadata") {
        form.elements.actionPrompt.value = this.pendingImport.metadata?.prompt || "";
        form.elements.actionPrompt.focus();
        return;
      }
      const selection = selectSnapshotActionPrompt(this.pendingImport?.snapshot, form.elements.kind.value);
      if (!selection.ok) {
        this.toast(selection.message, "warning");
        return;
      }
      form.elements.actionPrompt.value = selection.prompt;
      form.elements.actionPrompt.focus();
    } else if (action === "save-import") {
      await this.savePendingImport(button);
    } else if (action === "save-edit") {
      await this.saveItemEdit(button);
    } else if (action === "confirm-delete") {
      await this.deleteItem(button);
    }
  }

  async deleteItem(button) {
    const modal = this.modalLayer.querySelector(".nai-delete-modal");
    const id = modal?.dataset.itemId;
    if (!id || !this.getItem(id)) return;
    const anchor = captureScrollAnchor(this.scroll);
    const operationGeneration = this.reloadGeneration;
    const operationDirectoryKey = this.directoryKey;
    setButtonBusy(button, true, this.t("删除中…"));
    try {
      const result = await storage.deleteItem(id);
      if (!this.isOperationCurrent(operationGeneration, operationDirectoryKey)) {
        this.closeModal();
        await this.reload({ preserveScroll: true });
        return;
      }
      this.evictFile(id);
      this.manifest = normalizeManifest(result?.manifest ?? result);
      this.closeModal();
      this.reconcileCards();
      await nextFrame();
      restoreScrollAnchor(this.scroll, anchor);
      this.toast(result?.warning || "图片已从图库和本地目录中删除", result?.warning ? "warning" : "success");
    } catch (error) {
      this.toast(error.message || "图片删除失败", "error");
      setButtonBusy(button, false);
    }
  }

  async savePendingImport(button) {
    const form = this.modalLayer.querySelector("form");
    const pending = this.pendingImport;
    if (!form || !pending) return;
    const title = form.elements.title.value.trim() || baseName(pending.file.name);
    const actionPrompt = form.elements.actionPrompt.value.trim();
    if (!actionPrompt) {
      this.showFormError(form, "请填写要保存的画师串或角色 tag。");
      form.elements.actionPrompt.focus();
      return;
    }
    setButtonBusy(button, true, this.t("保存中…"));
    this.showFormError(form, "");
    const anchor = captureScrollAnchor(this.scroll);
    const operationGeneration = this.reloadGeneration;
    const operationDirectoryKey = this.directoryKey;
    try {
      const result = await storage.importItem({
        kind: form.elements.kind.value,
        title,
        actionPrompt,
        originalName: pending.file.name,
        mimeType: pending.file.type || "application/octet-stream",
        lastModified: pending.file.lastModified,
        originalSize: pending.file.size,
        dataUrl: pending.dataUrl,
        sha256: pending.hash,
        metadata: {
          hasMetadata: Boolean(pending.metadata?.hasMetadata),
          hasNovelAiMetadata: Boolean(pending.metadata?.hasNovelAiMetadata),
          prompt: pending.metadata?.prompt || "",
          summary: pending.metadata?.summary || ""
        }
      });
      if (!this.isOperationCurrent(operationGeneration, operationDirectoryKey)) {
        this.pendingImport = null;
        this.importQueue = [];
        this.closeModal();
        await this.reload({ preserveScroll: true });
        return;
      }
      this.manifest = normalizeManifest(result?.manifest ?? result);
      this.pendingImport = null;
      this.reconcileCards();
      await nextFrame();
      restoreScrollAnchor(this.scroll, anchor);
      this.toast("图片和原始 metadata 已保存", "success");
      this.startNextImport();
      this.hydrateVisibleFiles();
    } catch (error) {
      this.showFormError(form, error.message || "保存失败");
      setButtonBusy(button, false);
    }
  }

  async saveItemEdit(button) {
    const modal = this.modalLayer.querySelector(".nai-modal");
    const form = modal?.querySelector("form");
    const id = modal?.dataset.itemId;
    if (!form || !id) return;
    const actionPrompt = form.elements.actionPrompt.value.trim();
    if (!actionPrompt) {
      this.showFormError(form, "提示词不能为空。");
      return;
    }
    const anchor = captureScrollAnchor(this.scroll);
    const operationGeneration = this.reloadGeneration;
    const operationDirectoryKey = this.directoryKey;
    setButtonBusy(button, true, this.t("保存中…"));
    try {
      const result = await storage.updateItem(id, {
        kind: form.elements.kind.value,
        title: form.elements.title.value.trim() || "未命名",
        actionPrompt
      });
      if (!this.isOperationCurrent(operationGeneration, operationDirectoryKey)) {
        this.closeModal();
        await this.reload({ preserveScroll: true });
        return;
      }
      this.manifest = normalizeManifest(result?.manifest ?? result);
      this.reconcileCards();
      this.closeModal();
      await nextFrame();
      restoreScrollAnchor(this.scroll, anchor);
      this.toast("提示词修改已保存", "success");
      this.hydrateVisibleFiles();
    } catch (error) {
      this.showFormError(form, error.message || "保存失败");
      setButtonBusy(button, false);
    }
  }

  showFormError(form, message) {
    const element = form.querySelector(".nai-form-error");
    if (!element) return;
    element.hidden = !message;
    element.textContent = this.t(message);
  }

  scheduleUiPersist(patch) {
    this.pendingUiPatch = {
      ...this.pendingUiPatch,
      ...patch,
      ...(patch.scroll ? {
        scroll: { ...(this.pendingUiPatch.scroll || {}), ...patch.scroll }
      } : {}),
      ...(patch.positions ? {
        positions: { ...(this.pendingUiPatch.positions || {}), ...patch.positions }
      } : {}),
    };
    this.persistUiDebounced();
  }

  async persistUiState(changes = {}) {
    if (!this.status?.configured) return;
    const operationGeneration = this.reloadGeneration;
    const operationDirectoryKey = this.directoryKey;
    try {
      const result = await storage.setUiState(changes);
      if (result?.ui && this.isOperationCurrent(operationGeneration, operationDirectoryKey)) {
        this.manifest = { ...this.manifest, ui: result.ui };
      }
    } catch {
      // UI 状态保存失败不应打断图库操作。
    }
  }

  setStatus(kind, text) {
    this.lastStatus = { kind, text };
    this.statusLabel.textContent = this.t(text);
    this.statusDot.dataset.status = kind;
  }

  isOperationCurrent(generation, directoryKey) {
    return generation === this.reloadGeneration && directoryKey === this.directoryKey;
  }

  toast(message, kind = "info") {
    const toast = document.createElement("div");
    toast.className = `nai-toast is-${kind}`;
    toast.textContent = this.t(message);
    this.root.querySelector(".nai-toast-region").append(toast);
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    window.setTimeout(() => {
      toast.classList.remove("is-visible");
      window.setTimeout(() => toast.remove(), 180);
    }, 2600);
  }

  handleWindowFocus() {
    if (!this.active) return;
    const now = Date.now();
    if (now - this.lastFocusReload < 800) return;
    this.lastFocusReload = now;
    this.reload({ preserveScroll: true });
  }

  destroy() {
    this.destroyed = true;
    window.removeEventListener("dragover", this.onWindowDragGuard);
    window.removeEventListener("drop", this.onWindowDragGuard);
    window.removeEventListener("dragstart", this.onPageImageDragStart, true);
    window.removeEventListener("dragover", this.onWindowExternalDragCapture, true);
    window.removeEventListener("drop", this.onWindowExternalDragCapture, true);
    window.removeEventListener("dragend", this.onPageDragEnd, true);
    window.removeEventListener("pointermove", this.onPositionPointerMove, true);
    window.removeEventListener("pointerup", this.onPositionPointerUp, true);
    window.removeEventListener("pointercancel", this.onPositionPointerUp, true);
    window.removeEventListener("resize", this.handleViewportResize);
    this.imageObserver?.disconnect();
    this.clearFileCache();
    this.root.remove();
  }

  clearFileCache() {
    for (const cached of this.fileCache.values()) URL.revokeObjectURL(cached.objectUrl);
    this.fileCache.clear();
    this.inFlightFiles.clear();
    for (const card of this.cardNodes.values()) {
      card.classList.add("is-loading");
      card.classList.remove("has-image-error");
      card.querySelector("img").removeAttribute("src");
      card.querySelector(".nai-image-loader").textContent = this.t("正在读取…");
    }
  }

  clearCardNodes() {
    this.imageObserver?.disconnect();
    for (const card of this.cardNodes.values()) card.remove();
    this.cardNodes.clear();
  }
}

export function createGalleryPanel(context) {
  return new GalleryPanel(context);
}

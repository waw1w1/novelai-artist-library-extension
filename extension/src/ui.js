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
  prependArtistPrompt
} from "./novelai.js";
import { storage } from "./storage-client.js";

const KINDS = Object.freeze({ artist: "画师串", character: "角色" });

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
  constructor({ host, shadow }) {
    this.host = host;
    this.shadow = shadow;
    this.manifest = normalizeManifest(null);
    this.status = { configured: false };
    this.activeKind = "artist";
    this.expanded = false;
    this.initializedState = false;
    this.cardNodes = new Map();
    this.fileCache = new Map();
    this.scrollAnchors = new Map();
    this.importQueue = [];
    this.pendingImport = null;
    this.dragState = null;
    this.dropTarget = null;
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
      <div class="nai-modal-layer" hidden></div>
      <div class="nai-toast-region" aria-live="polite"></div>
    `;
    shadow.append(this.root);

    this.panel = this.root.querySelector(".nai-gallery-panel");
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
    }, 240);
    this.handleWindowFocus = this.handleWindowFocus.bind(this);
    this.onRootClick = this.onRootClick.bind(this);
    this.onPanelDragOver = this.onPanelDragOver.bind(this);
    this.onPanelDragLeave = this.onPanelDragLeave.bind(this);
    this.onPanelDrop = this.onPanelDrop.bind(this);
    this.onWindowDragGuard = this.onWindowDragGuard.bind(this);

    this.root.addEventListener("click", this.onRootClick);
    this.filePicker.addEventListener("change", () => {
      const files = [...this.filePicker.files].filter(isImageFile);
      this.filePicker.value = "";
      this.queueImportedFiles(files);
    });
    this.scroll.addEventListener("scroll", () => {
      const kind = this.activeKind;
      const top = this.scroll.scrollTop;
      this.scrollAnchors.set(kind, captureScrollAnchor(this.scroll));
      this.scheduleUiPersist({ scroll: { [kind]: top } });
    }, { passive: true });
    this.panel.addEventListener("dragover", this.onPanelDragOver);
    this.panel.addEventListener("dragleave", this.onPanelDragLeave);
    this.panel.addEventListener("drop", this.onPanelDrop);
    window.addEventListener("dragover", this.onWindowDragGuard);
    window.addEventListener("drop", this.onWindowDragGuard);
  }

  async init() {
    await this.reload({ preserveScroll: false });
  }

  async reload({ preserveScroll = true } = {}) {
    if (this.destroyed) return;
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

      const result = await storage.getLibrary();
      if (generation !== this.reloadGeneration) return;
      this.manifest = normalizeManifest(result?.manifest ?? result);
      if (!this.initializedState) {
        const savedUi = this.manifest.ui || {};
        if (savedUi.activeKind in KINDS) this.activeKind = savedUi.activeKind;
        this.expanded = Boolean(savedUi.expanded);
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
    this.pathLabel.textContent = name
      ? `数据目录：${name}`
      : this.status?.needsPermission
        ? "数据目录需要重新授权"
        : "尚未选择数据目录";
  }

  renderPanelState() {
    this.root.classList.toggle("is-expanded", this.expanded);
    this.expandButton.textContent = this.expanded ? "↙" : "⛶";
    this.expandButton.setAttribute("aria-label", this.expanded ? "收回面板" : "展开面板");
    this.expandButton.title = this.expanded ? "收回面板" : "展开面板";
    for (const button of this.root.querySelectorAll('[data-action="switch-kind"]')) {
      const selected = button.dataset.kind === this.activeKind;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  reconcileCards() {
    const items = getDisplayItems(this.manifest, this.activeKind);
    const wanted = new Set(items.map((item) => item.id));
    for (const child of [...this.grid.children]) {
      if (!wanted.has(child.dataset.itemId)) child.remove();
    }

    for (const item of items) {
      let card = this.cardNodes.get(item.id);
      if (!card) {
        card = this.createCard(item);
        this.cardNodes.set(item.id, card);
      }
      this.updateCard(card, item);
      this.grid.append(card);
    }

    const hasItems = items.length > 0;
    this.empty.hidden = hasItems;
    this.grid.hidden = !hasItems;
    const emptyTitle = this.empty.querySelector("strong");
    const emptyText = this.empty.querySelector("p");
    if (!this.status?.configured || !this.status?.ready) {
      emptyTitle.textContent = this.status?.configured ? "检查数据目录" : "先选择数据目录";
      emptyText.textContent = this.status?.error || (this.status?.configured
        ? "目录需要重新授权或修复清单"
        : "真实图片和清单会保存在你选择的文件夹中");
      this.empty.querySelector("button").hidden = false;
    } else {
      emptyTitle.textContent = `还没有${KINDS[this.activeKind]}图片`;
      emptyText.textContent = "把图片直接拖进面板即可保存";
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
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.innerHTML = `
      <button type="button" class="nai-card-heart" data-action="favorite" aria-label="收藏" title="收藏" draggable="false">♡</button>
      <button type="button" class="nai-card-edit" data-action="edit" aria-label="编辑提示词" title="编辑提示词" draggable="false">✎</button>
      <div class="nai-card-media">
        <span class="nai-image-loader">正在读取…</span>
        <img alt="" draggable="false">
        <span class="nai-metadata-badge" hidden>METADATA</span>
      </div>
      <div class="nai-card-caption">
        <strong></strong>
        <span></span>
      </div>
    `;
    card.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest("button")) {
        event.preventDefault();
        this.activateItem(card.dataset.itemId);
      }
    });
    card.addEventListener("dragstart", (event) => this.onCardDragStart(event, card.dataset.itemId));
    card.addEventListener("dragend", () => this.onCardDragEnd());
    return card;
  }

  updateCard(card, item) {
    card.dataset.favorite = String(Boolean(item.favorite));
    card.classList.toggle("is-favorite", Boolean(item.favorite));
    card.querySelector(".nai-card-heart").textContent = item.favorite ? "♥" : "♡";
    card.querySelector(".nai-card-heart").title = item.favorite ? "取消置顶" : "爱心置顶";
    card.querySelector(".nai-card-heart").setAttribute("aria-label", item.favorite ? "取消置顶" : "爱心置顶");
    card.querySelector(".nai-card-caption strong").textContent = item.title || baseName(item.originalName);
    card.querySelector(".nai-card-caption span").textContent = item.actionPrompt || "尚未填写提示词";
    card.querySelector("img").alt = `${item.title || KINDS[item.kind]}预览`;
    const badge = card.querySelector(".nai-metadata-badge");
    badge.hidden = !(item.metadata?.hasMetadata || item.hasMetadata);
  }

  async hydrateVisibleFiles() {
    const items = getDisplayItems(this.manifest, this.activeKind);
    for (const item of items) {
      if (this.destroyed) return;
      this.ensureFileLoaded(item).catch((error) => {
        const card = this.cardNodes.get(item.id);
        if (card) {
          card.classList.remove("is-loading");
          card.classList.add("has-image-error");
          card.querySelector(".nai-image-loader").textContent = "图片读取失败";
        }
        console.warn("[NovelAI 提示词图库] 图片读取失败", item.id, error);
      });
    }
  }

  async ensureFileLoaded(item) {
    const existing = this.fileCache.get(item.id);
    if (existing && (!item.sha256 || existing.sha256 === item.sha256)) return existing;
    if (existing) {
      URL.revokeObjectURL(existing.objectUrl);
      this.fileCache.delete(item.id);
    }
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
    const card = this.cardNodes.get(item.id);
    if (card) {
      card.querySelector("img").src = objectUrl;
      card.classList.remove("is-loading", "has-image-error");
    }
    return cached;
  }

  getItem(id) {
    return this.manifest.items?.[id] || null;
  }

  async onRootClick(event) {
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      const action = actionButton.dataset.action;
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
      } else if (action === "switch-kind") {
        await this.switchKind(actionButton.dataset.kind);
      } else if (action === "favorite") {
        const card = actionButton.closest(".nai-gallery-card");
        if (card) await this.toggleFavorite(card.dataset.itemId, actionButton);
      } else if (action === "edit") {
        const card = actionButton.closest(".nai-gallery-card");
        if (card) this.openItemEditor(card.dataset.itemId);
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

  async switchKind(kind) {
    if (!(kind in KINDS) || kind === this.activeKind) return;
    const previousKind = this.activeKind;
    const previousTop = this.scroll.scrollTop;
    this.scrollAnchors.set(previousKind, captureScrollAnchor(this.scroll));
    await this.persistUiState({ scroll: { [previousKind]: previousTop } });
    this.activeKind = kind;
    this.renderPanelState();
    this.reconcileCards();
    await nextFrame();
    const savedAnchor = this.scrollAnchors.get(kind);
    if (savedAnchor) restoreScrollAnchor(this.scroll, savedAnchor);
    else this.scroll.scrollTop = Number(this.manifest.ui?.scroll?.[kind]) || 0;
    this.setStatus("ready", `${KINDS[kind]} · ${getDisplayItems(this.manifest, kind).length} 张`);
    this.hydrateVisibleFiles();
    this.scheduleUiPersist({ activeKind: kind });
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
    if (event.target.closest("button")) {
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
      if (file.size <= 40 * 1024 * 1024) return true;
      this.toast(`${file.name} 超过 40 MiB，无法通过当前 Edge 消息通道安全保存`, "error");
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
    image.src = URL.createObjectURL(file);
    image.onload = () => URL.revokeObjectURL(image.src);
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
      const [hash, dataUrl, snapshot] = await Promise.all([
        sha256Blob(buffer),
        blobToDataUrl(buffer, file.type),
        Promise.resolve(collectAllPrompts())
      ]);
      const metadata = await extractImageMetadata(buffer, file.type);
      this.pendingImport = { file, kind, hash, dataUrl, snapshot, metadata };
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

    const snapshotText = formatPromptSnapshot(pending.snapshot);
    form.innerHTML = `
      <section class="nai-prompt-snapshot">
        <div class="nai-section-heading"><strong>NovelAI 当前全部提示词</strong><span>包含正向与角色提示</span></div>
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
    form.elements.kind.value = pending.kind;
    form.elements.title.value = baseName(pending.file.name);
    form.elements.actionPrompt.value = pending.metadata?.prompt || "";
    const metaSummary = form.querySelector(".nai-metadata-summary");
    metaSummary.classList.toggle("has-metadata", Boolean(pending.metadata?.hasMetadata));
    metaSummary.textContent = pending.metadata?.hasMetadata
      ? `✓ 检测到原图 metadata · SHA-256 ${pending.hash.slice(0, 12)}…`
      : `未检测到可识别的提示词 metadata；原始字节仍会完整保存 · SHA-256 ${pending.hash.slice(0, 12)}…`;
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
    element.querySelector("h2").textContent = title;
    element.querySelector("header p").textContent = description;
    return {
      element,
      body: element.querySelector(".nai-modal-body"),
      footer: element.querySelector(".nai-modal-footer")
    };
  }

  showModal(element) {
    this.modalLayer.replaceChildren(element);
    this.modalLayer.hidden = false;
  }

  closeModal() {
    this.modalLayer.hidden = true;
    this.modalLayer.replaceChildren();
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
      const snapshot = await Promise.resolve(collectAllPrompts());
      this.pendingImport.snapshot = snapshot;
      this.modalLayer.querySelector('[name="snapshot"]').value = formatPromptSnapshot(snapshot);
      this.toast("已重新读取当前提示词", "success");
    } else if (action === "use-snapshot") {
      const form = this.modalLayer.querySelector("form");
      form.elements.actionPrompt.value = form.elements.snapshot.value;
      form.elements.actionPrompt.focus();
    } else if (action === "save-import") {
      await this.savePendingImport(button);
    } else if (action === "save-edit") {
      await this.saveItemEdit(button);
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
    setButtonBusy(button, true);
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
    setButtonBusy(button, true);
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
    element.textContent = message;
  }

  scheduleUiPersist(patch) {
    this.pendingUiPatch = {
      ...this.pendingUiPatch,
      ...patch,
      ...(patch.scroll ? {
        scroll: { ...(this.pendingUiPatch.scroll || {}), ...patch.scroll }
      } : {})
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
    this.statusLabel.textContent = text;
    this.statusDot.dataset.status = kind;
  }

  isOperationCurrent(generation, directoryKey) {
    return generation === this.reloadGeneration && directoryKey === this.directoryKey;
  }

  toast(message, kind = "info") {
    const toast = document.createElement("div");
    toast.className = `nai-toast is-${kind}`;
    toast.textContent = message;
    this.root.querySelector(".nai-toast-region").append(toast);
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    window.setTimeout(() => {
      toast.classList.remove("is-visible");
      window.setTimeout(() => toast.remove(), 180);
    }, 2600);
  }

  handleWindowFocus() {
    const now = Date.now();
    if (now - this.lastFocusReload < 800) return;
    this.lastFocusReload = now;
    this.reload({ preserveScroll: true });
  }

  destroy() {
    this.destroyed = true;
    window.removeEventListener("dragover", this.onWindowDragGuard);
    window.removeEventListener("drop", this.onWindowDragGuard);
    this.clearFileCache();
    this.root.remove();
  }

  clearFileCache() {
    for (const cached of this.fileCache.values()) URL.revokeObjectURL(cached.objectUrl);
    this.fileCache.clear();
    for (const card of this.cardNodes.values()) {
      card.classList.add("is-loading");
      card.classList.remove("has-image-error");
      card.querySelector("img").removeAttribute("src");
      card.querySelector(".nai-image-loader").textContent = "正在读取…";
    }
  }
}

export function createGalleryPanel(context) {
  return new GalleryPanel(context);
}

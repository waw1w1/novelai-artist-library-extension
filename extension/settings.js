import {
  LIBRARY_FILE_NAME,
  getDirectoryRecord,
  openOrCreateLibrary,
  queryDirectoryPermission,
  readLibrary,
  saveDirectoryRecord,
  testWritableDirectory,
  withLibraryWriteLock,
} from "./src/directory-db.js";

const elements = {
  permissionBadge: document.querySelector("#permission-badge"),
  directoryName: document.querySelector("#directory-name"),
  directoryDetail: document.querySelector("#directory-detail"),
  libraryStats: document.querySelector("#library-stats"),
  totalCount: document.querySelector("#total-count"),
  artistCount: document.querySelector("#artist-count"),
  characterCount: document.querySelector("#character-count"),
  chooseButton: document.querySelector("#choose-directory"),
  chooseLabel: document.querySelector("#choose-label"),
  authorizeButton: document.querySelector("#authorize-directory"),
  verifyButton: document.querySelector("#verify-directory"),
  operationStatus: document.querySelector("#operation-status"),
};

let currentRecord = null;
let busy = false;

function setOperationStatus(message, tone = "neutral") {
  elements.operationStatus.textContent = message;
  elements.operationStatus.dataset.tone = tone;
}

function setPermissionBadge(label, tone = "neutral") {
  elements.permissionBadge.textContent = label;
  elements.permissionBadge.dataset.tone = tone;
}

function setBusy(nextBusy) {
  busy = nextBusy;
  elements.chooseButton.disabled = nextBusy;
  elements.authorizeButton.disabled = nextBusy;
  elements.verifyButton.disabled = nextBusy;
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function resetStats() {
  elements.libraryStats.hidden = true;
  elements.totalCount.textContent = "0";
  elements.artistCount.textContent = "0";
  elements.characterCount.textContent = "0";
}

function showStats(library) {
  const items = Object.values(library.items);
  const artistCount = items.filter((item) => item.kind === "artist").length;
  elements.totalCount.textContent = String(items.length);
  elements.artistCount.textContent = String(artistCount);
  elements.characterCount.textContent = String(items.length - artistCount);
  elements.libraryStats.hidden = false;
}

async function announceDirectoryChange(record) {
  try {
    await chrome.storage.local.set({
      libraryDirectoryStatus: {
        name: record.name,
        selectedAt: record.selectedAt,
        changedAt: Date.now(),
      },
    });
  } catch {
    // The IndexedDB record is authoritative; this write only wakes interested UI pages.
  }
  try {
    await chrome.runtime.sendMessage({ type: "DIRECTORY_CHANGED", payload: {} });
  } catch {
    // NovelAI tabs also refresh when they regain focus, so notification failure is harmless.
  }
}

async function refreshView({ preserveMessage = false } = {}) {
  resetStats();
  elements.authorizeButton.hidden = true;
  elements.verifyButton.hidden = true;

  try {
    currentRecord = await getDirectoryRecord();
  } catch (error) {
    currentRecord = null;
    elements.directoryName.textContent = "目录授权记录已损坏";
    elements.directoryDetail.textContent = "请重新选择数据目录";
    elements.chooseLabel.textContent = "重新选择目录";
    setPermissionBadge("记录无效", "danger");
    if (!preserveMessage) {
      setOperationStatus(error.message || "无法读取目录授权记录", "danger");
    }
    return;
  }

  if (!currentRecord) {
    elements.directoryName.textContent = "尚未选择文件夹";
    elements.directoryDetail.textContent = "建议选择本项目中的 data 文件夹";
    elements.chooseLabel.textContent = "选择数据目录";
    setPermissionBadge("未设置", "neutral");
    if (!preserveMessage) {
      setOperationStatus("选择目录时，Edge 会打开 Windows 资源管理器。", "neutral");
    }
    return;
  }

  elements.directoryName.textContent = currentRecord.name || currentRecord.handle.name;
  elements.chooseLabel.textContent = "更换数据目录";
  const selectedAt = formatDate(currentRecord.selectedAt);
  elements.directoryDetail.textContent = selectedAt
    ? `已于 ${selectedAt} 选择 · ${LIBRARY_FILE_NAME}`
    : `已保存目录授权 · ${LIBRARY_FILE_NAME}`;

  const permission = await queryDirectoryPermission(currentRecord.handle, "readwrite");
  if (permission === "prompt") {
    setPermissionBadge("需要授权", "warning");
    elements.authorizeButton.hidden = false;
    if (!preserveMessage) {
      setOperationStatus("Edge 已暂停该目录的访问权限，请点击“重新授权”。", "warning");
    }
    return;
  }
  if (permission !== "granted") {
    setPermissionBadge("访问被拒绝", "danger");
    elements.authorizeButton.hidden = false;
    if (!preserveMessage) {
      setOperationStatus("目录访问已被拒绝；可尝试重新授权，或选择另一个目录。", "danger");
    }
    return;
  }

  setPermissionBadge("可读写", "success");
  elements.verifyButton.hidden = false;
  try {
    const library = await readLibrary(currentRecord.handle);
    if (!library) {
      setPermissionBadge("需要初始化", "warning");
      if (!preserveMessage) {
        setOperationStatus("目录可读写，但缺少 library.json；点击“检查目录”即可建立。", "warning");
      }
      return;
    }
    showStats(library);
    if (!preserveMessage) {
      setOperationStatus("目录和清单均可正常访问。", "success");
    }
  } catch (error) {
    setPermissionBadge("清单异常", "danger");
    if (!preserveMessage) {
      setOperationStatus(error.message || "无法读取 library.json", "danger");
    }
  }
}

async function verifyCandidate(handle) {
  let permission = await queryDirectoryPermission(handle, "readwrite");
  if (permission !== "granted" && typeof handle.requestPermission === "function") {
    permission = await handle.requestPermission({ mode: "readwrite" });
  }
  if (permission !== "granted") {
    throw new Error("未获得该目录的读写权限");
  }

  return withLibraryWriteLock(async () => {
    await testWritableDirectory(handle);
    const result = await openOrCreateLibrary(handle);
    const record = await saveDirectoryRecord(handle, {
      libraryCreated: result.created,
      verifiedAt: new Date().toISOString(),
    });
    return { ...result, record };
  });
}

async function chooseDirectory() {
  if (busy) {
    return;
  }
  if (typeof window.showDirectoryPicker !== "function") {
    setOperationStatus("当前 Edge 不支持目录选择 API，请先更新浏览器。", "danger");
    return;
  }

  const options = {
    mode: "readwrite",
    id: "novelai_quick_library",
  };
  if (currentRecord?.handle?.kind === "directory") {
    options.startIn = currentRecord.handle;
  }

  // Keep this API call directly inside the click handler so transient activation is retained.
  let pickerPromise;
  try {
    pickerPromise = window.showDirectoryPicker(options);
  } catch (error) {
    setOperationStatus(error.message || "无法打开目录选择器", "danger");
    return;
  }

  setBusy(true);
  setOperationStatus("等待选择文件夹……", "neutral");
  try {
    const candidateHandle = await pickerPromise;
    setOperationStatus("正在试写并检查清单；当前目录会保留到验证成功为止……", "neutral");
    const { manifest, created, record } = await verifyCandidate(candidateHandle);
    currentRecord = record;
    await announceDirectoryChange(record);
    showStats(manifest);
    setOperationStatus(
      created ? "新图库已建立，目录切换成功。" : "已有图库已打开，目录切换成功。",
      "success",
    );
    await refreshView({ preserveMessage: true });
  } catch (error) {
    if (error?.name === "AbortError") {
      setOperationStatus("已取消选择，原数据目录没有改变。", "warning");
    } else {
      setOperationStatus(`目录切换失败，原目录保持不变：${error.message || "未知错误"}`, "danger");
    }
    await refreshView({ preserveMessage: true });
  } finally {
    setBusy(false);
  }
}

async function authorizeDirectory() {
  if (busy || !currentRecord?.handle) {
    return;
  }

  let permissionPromise;
  try {
    // The handle was preloaded on page startup; request immediately on this click.
    permissionPromise = currentRecord.handle.requestPermission({ mode: "readwrite" });
  } catch (error) {
    setOperationStatus(error.message || "无法请求目录权限", "danger");
    return;
  }

  setBusy(true);
  setOperationStatus("正在等待 Edge 授权……", "neutral");
  try {
    const permission = await permissionPromise;
    if (permission !== "granted") {
      throw new Error("你没有授予该目录的读写权限");
    }
    const { manifest, record } = await withLibraryWriteLock(async () => {
      await testWritableDirectory(currentRecord.handle);
      const result = await openOrCreateLibrary(currentRecord.handle);
      const savedRecord = await saveDirectoryRecord(currentRecord.handle, {
        selectedAt: currentRecord.selectedAt,
        libraryCreated: currentRecord.libraryCreated || result.created,
        verifiedAt: new Date().toISOString(),
      });
      return { manifest: result.manifest, record: savedRecord };
    });
    currentRecord = record;
    await announceDirectoryChange(currentRecord);
    showStats(manifest);
    setOperationStatus("目录已重新授权，并通过读写检查。", "success");
    await refreshView({ preserveMessage: true });
  } catch (error) {
    setOperationStatus(`重新授权失败：${error.message || "未知错误"}`, "danger");
    await refreshView({ preserveMessage: true });
  } finally {
    setBusy(false);
  }
}

async function verifyCurrentDirectory() {
  if (busy || !currentRecord?.handle) {
    return;
  }
  setBusy(true);
  setOperationStatus("正在试写目录并校验清单……", "neutral");
  try {
    const permission = await queryDirectoryPermission(currentRecord.handle, "readwrite");
    if (permission !== "granted") {
      throw new Error("目录需要先重新授权");
    }
    const { manifest, created, record } = await withLibraryWriteLock(async () => {
      await testWritableDirectory(currentRecord.handle);
      const result = await openOrCreateLibrary(currentRecord.handle);
      const savedRecord = await saveDirectoryRecord(currentRecord.handle, {
        selectedAt: currentRecord.selectedAt,
        libraryCreated: currentRecord.libraryCreated || result.created,
        verifiedAt: new Date().toISOString(),
      });
      return { ...result, record: savedRecord };
    });
    currentRecord = record;
    await announceDirectoryChange(currentRecord);
    showStats(manifest);
    setOperationStatus(created ? "目录正常，已建立新的 library.json。" : "目录和现有图库均校验通过。", "success");
    await refreshView({ preserveMessage: true });
  } catch (error) {
    setOperationStatus(`目录检查失败：${error.message || "未知错误"}`, "danger");
    await refreshView({ preserveMessage: true });
  } finally {
    setBusy(false);
  }
}

elements.chooseButton.addEventListener("click", chooseDirectory);
elements.authorizeButton.addEventListener("click", authorizeDirectory);
elements.verifyButton.addEventListener("click", verifyCurrentDirectory);

if (typeof window.showDirectoryPicker !== "function") {
  elements.chooseButton.disabled = true;
  setOperationStatus("当前 Edge 不支持目录选择 API，请更新到较新的桌面版 Edge。", "danger");
} else {
  refreshView();
}

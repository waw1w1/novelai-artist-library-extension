function normalizeResponse(response) {
  if (!response) {
    throw new Error("扩展后台没有响应，请刷新页面后重试。");
  }
  if (!response.ok) {
    const error = new Error(response.error || "操作失败");
    error.code = response.code || "UNKNOWN";
    throw error;
  }
  return response.data;
}

export function sendRequest(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      try {
        resolve(normalizeResponse(response));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export const storage = {
  getStatus: () => sendRequest("GET_STATUS"),
  getLibrary: () => sendRequest("GET_LIBRARY"),
  getFile: (id) => sendRequest("GET_FILE", { id }),
  importItem: (payload) => sendRequest("IMPORT_ITEM", payload),
  updateItem: (id, changes) => sendRequest("UPDATE_ITEM", { id, changes }),
  toggleFavorite: (id) => sendRequest("TOGGLE_FAVORITE", { id }),
  reorderItems: (payload) => sendRequest("REORDER_ITEMS", payload),
  setUiState: (changes) => sendRequest("SET_UI_STATE", { changes }),
  openSettings: () => sendRequest("OPEN_SETTINGS")
};

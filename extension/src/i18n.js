export const DEFAULT_LANGUAGE = "en";
export const LANGUAGE_STORAGE_KEY = "uiLanguage";
export const SUPPORTED_LANGUAGES = Object.freeze(["en", "zh-CN"]);

const ENGLISH = Object.freeze({
  "NovelAI 提示词图库": "NovelAI Prompt Gallery",
  "提示词图库": "Prompt Gallery",
  "尚未选择数据目录": "No data directory selected",
  "选择图片导入": "Import images",
  "设置": "Settings",
  "收束为小图标": "Minimize to icon",
  "展开面板": "Expand panel",
  "收回面板": "Restore compact panel",
  "图库类型": "Gallery category",
  "画师串": "Artist Prompts",
  "角色": "Characters",
  "这里还没有图片": "No images here yet",
  "把图片直接拖进面板即可保存": "Drag images into the panel to save them",
  "选择数据目录": "Select data directory",
  "正在连接数据目录…": "Connecting to the data directory…",
  "拖入图片 · 拖动卡片排序或拖回 NovelAI": "Drop images · Reorder cards or drag originals back to NovelAI",
  "恢复提示词图库": "Restore Prompt Gallery",
  "正在读取图库…": "Loading gallery…",
  "请先选择项目内的数据目录": "Select a data directory first",
  "数据目录需要重新授权": "Data directory authorization required",
  "数据目录需要检查": "Data directory needs attention",
  "图库读取失败": "Failed to load the gallery",
  "检查数据目录": "Check data directory",
  "先选择数据目录": "Select a data directory first",
  "目录需要重新授权或修复清单": "Reauthorize the directory or repair the manifest",
  "真实图片和清单会保存在你选择的文件夹中": "Original images and the manifest are stored in your selected folder",
  "收藏": "Favorite",
  "放大观看": "Enlarge image",
  "滚轮缩放 · 按住鼠标拖动": "Wheel to zoom · Drag to pan",
  "编辑提示词": "Edit prompt",
  "删除图片": "Delete image",
  "使用这张图片的提示词": "Use this image prompt",
  "正在读取…": "Loading…",
  "取消置顶": "Remove from favorites",
  "爱心置顶": "Add to favorites",
  "尚未填写提示词": "No prompt saved",
  "图片读取失败": "Failed to load image",
  "无法打开设置页": "Unable to open settings",
  "请先点右上角编辑按钮填写提示词": "Add a prompt with the edit button first",
  "未能写入提示词框": "Unable to update the prompt field",
  "画师串已经启用": "Artist prompt enabled",
  "画师串已禁用": "Artist prompt disabled",
  "画师串已经改变": "Artist prompt changed",
  "浏览器未允许写入剪贴板": "Clipboard access was not granted",
  "角色 tag 已复制到剪贴板": "Character tags copied to the clipboard",
  "角色tag已复制": "Character tags copied",
  "操作失败": "Operation failed",
  "收藏状态保存失败": "Failed to save favorite state",
  "图片仍在准备，请稍后再拖": "The image is still loading; try dragging it again shortly",
  "当前浏览器未能准备拖出文件": "The browser could not prepare the file for dragging",
  "排序保存失败": "Failed to save ordering",
  "请先在设置中检查或重新授权数据目录": "Check or reauthorize the data directory in Settings",
  "请先在设置中选择项目内的数据目录": "Select a data directory in Settings first",
  "没有从拖动内容中读取到图片，请尝试拖动图片本身。": "No image was found in the dragged content. Drag the image itself and try again.",
  "正在读取拖入的 NovelAI 图片…": "Loading the dragged NovelAI image…",
  "响应不是图片": "The response is not an image",
  "图片格式不受支持": "Unsupported image format",
  "未知错误": "Unknown error",
  "保存这张图片": "Save this image",
  "先选择图片用途，下一步可以填写提示词。": "Choose how the image will be used, then review its prompt.",
  "点击图片时写入正向提示词顶部": "Click to prepend the saved prompt to the main prompt",
  "点击图片时复制角色 tag": "Click to copy the saved character tags",
  "取消这张": "Skip this image",
  "正在读取原图和 metadata…": "Reading the original image and metadata…",
  "图片读取失败": "Failed to read image",
  "填写插件提示词": "Save gallery prompt",
  "原图会按原始字节保存，不会重编码。": "The original bytes are preserved without re-encoding.",
  "图片内置 NovelAI 提示词": "Embedded NovelAI prompt",
  "当前 NovelAI 页面提示词": "Current NovelAI page prompts",
  "优先来源：图片 metadata": "Primary source: image metadata",
  "回退来源：当前页面": "Fallback source: current page",
  "复制 metadata 提示词": "Copy metadata prompt",
  "复制全部": "Copy all",
  "重新读取": "Refresh",
  "填入下方": "Use below",
  "用途": "Category",
  "名称": "Name",
  "插件保存的提示词": "Saved gallery prompt",
  "把上方需要的提示词复制或粘贴到这里": "Copy or paste the prompt you want to save here",
  "提示词来源尚未确定": "Prompt source has not been determined",
  "保存": "Save",
  "编辑图片提示词": "Edit image prompt",
  "只修改插件提示词，不会改写原图 metadata。": "This changes only the saved gallery prompt, not the original metadata.",
  "输入画师串或角色 tag": "Enter an artist prompt or character tags",
  "取消": "Cancel",
  "保存修改": "Save changes",
  "删除这张图片？": "Delete this image?",
  "此操作会从图库和本地 images 文件夹中删除该图片。": "This removes the item from the gallery and deletes its file from the local images folder.",
  "确认删除": "Delete permanently",
  "关闭": "Close",
  "请稍候": "Please wait",
  "当前提示词已复制": "Prompt copied",
  "已重新读取当前提示词": "Current page prompts refreshed",
  "删除中…": "Deleting…",
  "图片已从图库和本地目录中删除": "Image deleted from the gallery and local directory",
  "图片删除失败": "Failed to delete image",
  "请填写要保存的画师串或角色 tag。": "Enter the artist prompt or character tags to save.",
  "保存中…": "Saving…",
  "图片和原始 metadata 已保存": "Image and original metadata saved",
  "保存失败": "Save failed",
  "提示词不能为空。": "Prompt cannot be empty.",
  "未命名": "Untitled",
  "未命名图片": "Untitled image",
  "提示词修改已保存": "Prompt changes saved",
  "当前没有可用的主提示词。": "No usable main prompt was found.",
  "检测到多个角色，请从上方复制需要的角色段落。": "Multiple characters were detected. Copy the required character section above.",
  "当前没有可用的角色提示词。": "No usable character prompt was found.",
  "（未检测到可用提示词）": "(No usable prompts detected)",
  "（空）": "(Empty)",
  "已检测到 NovelAI 图片 metadata，插件提示词将优先使用图片内置提示词。": "NovelAI image metadata detected. The embedded prompt is used as the primary source.",
  "已检测到 NovelAI 图片 metadata，但其中没有可识别的正向提示词；为避免来源混淆，不会自动改用网页提示词。": "NovelAI image metadata was detected, but no recognizable positive prompt was found. The current page prompt will not be substituted automatically.",
  "未检测到可识别的 NovelAI 图片 metadata，已将当前 NovelAI 页面提示词作为回退来源。": "No recognizable NovelAI image metadata was detected. Current NovelAI page prompts are being used as the fallback source.",
  "（检测到 NovelAI metadata，但没有可识别的正向提示词）": "(NovelAI metadata detected, but no recognizable positive prompt was found)",

  "NovelAI 快捷图库 · 设置": "NovelAI Prompt Gallery · Settings",
  "数据目录设置": "Data Directory Settings",
  "图片和提示词会直接保存在你选择的文件夹中。": "Images and prompts are stored directly in the folder you select.",
  "本地图库": "LOCAL LIBRARY",
  "当前数据目录": "Current data directory",
  "未设置": "Not configured",
  "尚未选择文件夹": "No folder selected",
  "建议选择本项目中的 data 文件夹": "Choose a dedicated local folder for your gallery",
  "全部图片": "All images",
  "重新授权": "Reauthorize",
  "检查目录": "Check directory",
  "重置面板位置": "Reset panel position",
  "选择目录时，Edge 会打开 Windows 资源管理器。": "Edge will open the Windows folder picker when you select a directory.",
  "保存说明": "Storage information",
  "原图不重编码": "Originals are not re-encoded",
  "图片按原始字节写入 images/，保留 NovelAI PNG metadata。": "Images are written as original bytes to images/, preserving NovelAI PNG metadata.",
  "图片按原始字节写入": "Images are written as original bytes to",
  "，保留 NovelAI PNG metadata。": ", preserving NovelAI PNG metadata.",
  "写入后复验": "Verified after writing",
  "每张图片保存后会再次计算 SHA-256，避免静默损坏。": "SHA-256 is recalculated after every write to detect silent corruption.",
  "路径由你掌控": "You control the location",
  "浏览器不会向扩展暴露完整绝对路径，因此这里只显示文件夹名称。": "The browser does not expose the full absolute path, so only the folder name is shown.",
  "library.json 保存条目、排序和面板状态；图片保存在 images/。": "library.json stores items, ordering, and UI state; images are stored in images/.",
  "保存条目、排序和面板状态；图片保存在": "stores items, ordering, and UI state; images are stored in",
  "语言": "Language",
  "。": ".",
  "目录授权记录已损坏": "The saved directory authorization is invalid",
  "请重新选择数据目录": "Select the data directory again",
  "重新选择目录": "Select another directory",
  "记录无效": "Invalid record",
  "无法读取目录授权记录": "Unable to read the directory authorization record",
  "更换数据目录": "Change data directory",
  "需要授权": "Authorization required",
  "Edge 已暂停该目录的访问权限，请点击“重新授权”。": "Edge has suspended access to this directory. Click Reauthorize.",
  "访问被拒绝": "Access denied",
  "目录访问已被拒绝；可尝试重新授权，或选择另一个目录。": "Directory access was denied. Reauthorize it or select another directory.",
  "可读写": "Read/write",
  "需要初始化": "Initialization required",
  "目录可读写，但缺少 library.json；点击“检查目录”即可建立。": "The directory is writable but library.json is missing. Click Check directory to create it.",
  "目录和清单均可正常访问。": "The directory and manifest are accessible.",
  "清单异常": "Manifest error",
  "无法读取 library.json": "Unable to read library.json",
  "当前 Edge 不支持目录选择 API，请先更新浏览器。": "This Edge version does not support the directory picker API. Update the browser first.",
  "无法打开目录选择器": "Unable to open the folder picker",
  "等待选择文件夹……": "Waiting for folder selection…",
  "正在试写并检查清单；当前目录会保留到验证成功为止……": "Testing the selected folder and manifest. The current directory remains active until verification succeeds…",
  "新图库已建立，目录切换成功。": "A new gallery was created and the directory was changed.",
  "已有图库已打开，目录切换成功。": "The existing gallery was opened and the directory was changed.",
  "已取消选择，原数据目录没有改变。": "Selection canceled; the existing data directory was not changed.",
  "正在等待 Edge 授权……": "Waiting for Edge authorization…",
  "目录已重新授权，并通过读写检查。": "The directory was reauthorized and passed the read/write check.",
  "正在试写目录并校验清单……": "Testing the directory and validating the manifest…",
  "目录正常，已建立新的 library.json。": "The directory is ready and a new library.json was created.",
  "目录和现有图库均校验通过。": "The directory and existing gallery passed validation.",
  "面板和小图标已恢复到默认右下角位置。": "The panel and minimized icon were reset to the default lower-right position.",
  "当前 Edge 不支持目录选择 API，请更新到较新的桌面版 Edge。": "This Edge version does not support the directory picker API. Update to a newer desktop version.",
  "请先在扩展设置中选择数据目录": "Select a data directory in the extension settings first",
  "数据目录访问已被拒绝，请重新授权或更换目录": "Data directory access was denied. Reauthorize it or select another directory",
  "数据目录中缺少 library.json，请在设置页点击“检查目录”进行修复": "library.json is missing from the data directory. Open Settings and click Check directory",
  "所选目录中缺少 library.json，请在设置页重新验证": "library.json is missing from the selected directory. Validate it again in Settings",
  "只支持 PNG、JPEG、WebP、GIF 或 AVIF 图片": "Only PNG, JPEG, WebP, GIF, and AVIF images are supported",
  "导入图片的 SHA-256 与传入值不一致": "The imported image SHA-256 does not match the supplied value",
  "图片不能超过 32 MiB": "Images cannot exceed 32 MiB",
  "数据目录需要先重新授权": "Reauthorize the data directory first",
  "数据目录中缺少 library.json": "library.json is missing from the data directory",
  "未获得该目录的读写权限": "Read/write permission was not granted for this directory",
  "你没有授予该目录的读写权限": "You did not grant read/write permission for this directory",
});

const REVERSE_ENGLISH = new Map(Object.entries(ENGLISH).map(([zh, en]) => [en, zh]));

export function normalizeLanguage(value) {
  return value === "zh-CN" ? "zh-CN" : DEFAULT_LANGUAGE;
}

export function translateMessage(value, language = DEFAULT_LANGUAGE) {
  const text = String(value ?? "");
  const normalized = normalizeLanguage(language);
  if (normalized === "zh-CN") return REVERSE_ENGLISH.get(text) || text;
  if (ENGLISH[text]) return ENGLISH[text];
  let match = text.match(/^(画师串|角色) · (\d+) 张$/u);
  if (match) return `${ENGLISH[match[1]]} · ${match[2]} images`;
  match = text.match(/^数据目录：(.*)$/u);
  if (match) return `Data directory: ${match[1]}`;
  match = text.match(/^还没有(画师串|角色)图片$/u);
  if (match) return `No ${ENGLISH[match[1]].toLowerCase()} images yet`;
  match = text.match(/^(.*)预览$/u);
  if (match) return `${match[1]} preview`;
  match = text.match(/^即将永久删除“(.*)”。删除后无法通过插件撤销。$/u);
  if (match) return `“${match[1]}” will be permanently deleted. This cannot be undone in the extension.`;
  match = text.match(/^(.*) 超过 32 MiB，无法通过当前 Edge 消息通道安全保存$/u);
  if (match) return `${match[1]} exceeds 32 MiB and cannot be safely imported through the Edge message channel`;
  match = text.match(/^无法读取拖入的网页图片：(.*)$/u);
  if (match) return `Unable to load the dragged web image: ${translateMessage(match[1], normalized)}`;
  match = text.match(/^未检测到可识别的 NovelAI 图片 metadata，已切换到当前页面提示词作为回退来源；(.*)$/u);
  if (match) return `No recognizable NovelAI image metadata was detected. Current page prompts are being used as the fallback source; ${translateMessage(match[1], normalized)}`;
  match = text.match(/^目录切换失败，原目录保持不变：(.*)$/u);
  if (match) return `Failed to change directory; the original directory remains active: ${match[1]}`;
  match = text.match(/^重新授权失败：(.*)$/u);
  if (match) return `Reauthorization failed: ${match[1]}`;
  match = text.match(/^目录检查失败：(.*)$/u);
  if (match) return `Directory check failed: ${match[1]}`;
  match = text.match(/^重置面板位置失败：(.*)$/u);
  if (match) return `Failed to reset panel position: ${match[1]}`;
  match = text.match(/^未找到条目 (.*)$/u);
  if (match) return `Item not found: ${match[1]}`;
  match = text.match(/^条目已删除，但原图文件清理失败：(.*)$/u);
  if (match) return `The item was deleted, but its original image file could not be removed: ${match[1]}`;
  match = text.match(/^图片 (.*) 的 SHA-256 与清单不一致$/u);
  if (match) return `The SHA-256 of image ${match[1]} does not match the manifest`;
  match = text.match(/^已于 (.*) 选择 · (.*)$/u);
  if (match) return `Selected ${match[1]} · ${match[2]}`;
  match = text.match(/^已保存目录授权 · (.*)$/u);
  if (match) return `Directory authorization saved · ${match[1]}`;
  return text;
}

export function createTreeLocalizer() {
  const textSources = new WeakMap();
  const attributeSources = new WeakMap();
  const attributes = ["aria-label", "title", "placeholder"];
  function apply(root, language) {
    if (!root) return;
    const document = root.ownerDocument || root;
    const walker = document.createTreeWalker(root, globalThis.NodeFilter?.SHOW_TEXT ?? 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!textSources.has(node)) textSources.set(node, node.nodeValue);
      const source = textSources.get(node);
      const leading = source.match(/^\s*/u)?.[0] || "";
      const trailing = source.match(/\s*$/u)?.[0] || "";
      const core = source.slice(leading.length, source.length - trailing.length || undefined);
      node.nodeValue = core ? `${leading}${translateMessage(core, language)}${trailing}` : source;
    }
    const elements = [root, ...(root.querySelectorAll?.("*") || [])].filter((value) => value?.getAttribute);
    for (const element of elements) {
      let sources = attributeSources.get(element);
      if (!sources) {
        sources = {};
        for (const name of attributes) if (element.hasAttribute(name)) sources[name] = element.getAttribute(name);
        attributeSources.set(element, sources);
      }
      for (const [name, source] of Object.entries(sources)) element.setAttribute(name, translateMessage(source, language));
    }
  }
  return { apply };
}

export async function getStoredLanguage() {
  try {
    const result = await chrome.storage.local.get({ [LANGUAGE_STORAGE_KEY]: DEFAULT_LANGUAGE });
    return normalizeLanguage(result[LANGUAGE_STORAGE_KEY]);
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export async function setStoredLanguage(language) {
  const normalized = normalizeLanguage(language);
  await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: normalized });
  return normalized;
}

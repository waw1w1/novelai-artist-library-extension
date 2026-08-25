const EDITOR_SELECTOR = [
  '.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][aria-multiline="true"]',
  'textarea[aria-label*="prompt" i]',
  'textarea[placeholder*="prompt" i]',
  "textarea",
].join(",");

const NEGATIVE_CONTEXT =
  /(?:undesired\s*content|negative\s*prompt|unwanted|不希望|不期望|排除内容|负面提示|ネガティブ|\buc\b)/iu;
const CHARACTER_CONTEXT =
  /(?:character(?:\s+prompt|\s*#?\s*\d+)|char(?:acter)?[_-]?prompt|subject\s*prompt|角色(?:提示|\s*\d+)|人物提示|キャラクター(?:プロンプト|\s*\d+))/iu;
const POSITIVE_CONTEXT =
  /(?:^|\b)(?:positive\s*)?prompt(?:\b|$)|base\s*caption|main\s*prompt|图像提示词|主提示词|正向提示词|提示词/iu;

/** 保留有意义的换行，同时消除 DOM 提取产生的不可见空白。 */
export function normalizePromptText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readEditorText(editor) {
  if (!editor) {
    return "";
  }
  if ("value" in editor && typeof editor.value === "string") {
    return normalizePromptText(editor.value);
  }
  return normalizePromptText(editor.innerText || editor.textContent || "");
}

function safeMatches(element, selector) {
  try {
    return Boolean(element?.matches?.(selector));
  } catch {
    return false;
  }
}

function hasHiddenAncestor(element) {
  for (let current = element; current; current = current.parentElement) {
    if (
      current.hidden ||
      current.inert ||
      current.getAttribute?.("aria-hidden") === "true" ||
      safeMatches(current, '[data-state="closed"], [data-state="inactive"]')
    ) {
      return true;
    }
  }
  return false;
}

export function isElementVisible(element) {
  if (!element || !element.isConnected || hasHiddenAncestor(element)) {
    return false;
  }

  const view = element.ownerDocument?.defaultView;
  if (view?.getComputedStyle) {
    const style = view.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
  }

  if (typeof element.getClientRects === "function") {
    const rects = element.getClientRects();
    if (rects.length === 0 && element !== element.ownerDocument?.activeElement) {
      return false;
    }
  }

  return true;
}

function compactContext(value) {
  return normalizePromptText(value).replace(/\s+/g, " ").slice(0, 500);
}

function contextAttributes(element) {
  const attributes = [
    element.getAttribute?.("aria-label"),
    element.getAttribute?.("aria-labelledby"),
    element.getAttribute?.("title"),
    element.getAttribute?.("placeholder"),
    element.getAttribute?.("name"),
    element.getAttribute?.("id"),
    element.getAttribute?.("data-testid"),
    element.getAttribute?.("data-test-id"),
    typeof element.className === "string" ? element.className : "",
  ];
  return attributes.filter(Boolean).join(" ");
}

function collectEditorContext(editor) {
  const parts = [];
  let current = editor;

  for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
    parts.push(contextAttributes(current));

    const labelledBy = current.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const label = current.ownerDocument?.getElementById?.(id);
        if (label) {
          parts.push(compactContext(label.textContent));
        }
      }
    }

    const previous = depth <= 1 ? current.previousElementSibling : null;
    if (previous) {
      const text = compactContext(previous.textContent);
      if (text.length <= 160) {
        parts.push(text);
      }
    }

    try {
      for (const label of current.querySelectorAll(":scope > label, :scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4")) {
        const text = compactContext(label.textContent);
        if (text.length <= 160) {
          parts.push(text);
        }
      }
    } catch {
      // 旧版浏览器不支持 :scope 时，属性和相邻标签仍可完成分类。
    }

    // 只读取编辑器附近两层的正文。更高层通常同时包含 Prompt 与 UC
    // 两个页签，混入后会把正向编辑器误判为负向编辑器。
    if (depth <= 1) {
      const ownText = compactContext(current.textContent);
      const editorText = compactContext(editor.textContent);
      if (ownText && ownText.length <= 260 && ownText !== editorText) {
        parts.push(ownText.replace(editorText, ""));
      }
    }
  }

  return compactContext(parts.filter(Boolean).join(" "));
}

/** 纯函数，便于对 NovelAI UI 文案变化做测试。 */
export function classifyPromptContext(context) {
  const value = compactContext(context);
  if (NEGATIVE_CONTEXT.test(value)) {
    return "negative";
  }
  if (CHARACTER_CONTEXT.test(value)) {
    return "character";
  }
  if (POSITIVE_CONTEXT.test(value)) {
    return "main";
  }
  return "unknown";
}

function deriveCharacterLabel(context, fallbackIndex) {
  const match = String(context).match(
    /(?:character|角色|人物|キャラクター)\s*(?:#|no\.?\s*)?(\d+)/iu,
  );
  return match ? `角色 ${match[1]}` : `角色 ${fallbackIndex}`;
}

function normalizeCharacterEntry(entry, index) {
  if (typeof entry === "string") {
    return { label: `角色 ${index + 1}`, prompt: normalizePromptText(entry) };
  }
  return {
    label: normalizePromptText(entry?.label) || `角色 ${index + 1}`,
    prompt: normalizePromptText(entry?.prompt ?? entry?.text),
  };
}

/** 构造稳定、可序列化的提示词快照，不暴露 DOM 节点。 */
export function buildPromptSnapshot(mainPrompt = "", characters = []) {
  const normalizedMain = normalizePromptText(mainPrompt);
  const normalizedCharacters = characters
    .map(normalizeCharacterEntry)
    .filter((entry) => entry.prompt);

  return {
    mainPrompt: normalizedMain,
    positivePrompt: normalizedMain,
    basePrompt: normalizedMain,
    characters: normalizedCharacters,
    characterPrompts: normalizedCharacters.map((entry) => entry.prompt),
    prompts: [
      ...(normalizedMain ? [{ kind: "main", label: "主提示词", prompt: normalizedMain }] : []),
      ...normalizedCharacters.map((entry) => ({
        kind: "character",
        label: entry.label,
        prompt: entry.prompt,
      })),
    ],
  };
}

function queryEditors(root) {
  if (!root?.querySelectorAll) {
    return [];
  }
  return [...new Set(root.querySelectorAll(EDITOR_SELECTOR))].filter((editor) => {
    if (editor.disabled || editor.readOnly) {
      return false;
    }
    const editable = editor.getAttribute?.("contenteditable");
    return editable !== "false";
  });
}

function firstEditorInside(container) {
  if (!container?.querySelector) return null;
  return container.matches?.(EDITOR_SELECTOR)
    ? container
    : container.querySelector(EDITOR_SELECTOR);
}

/**
 * NovelAI 当前图像页提供了不会随 styled-components 哈希变化的语义类名。
 * 优先使用这些类名，避免把 UC 或页面上其他 textarea 误当成提示词。
 */
function collectNovelAiSemanticPrompts(root) {
  if (!root?.querySelectorAll) return null;
  const baseContainers = [...root.querySelectorAll(".prompt-input-box-base-prompt")];
  const characterContainers = [...root.querySelectorAll('[class*="prompt-input-box-character-prompts-"]')]
    .filter((container) => !String(container.className).includes("undesired-content"));
  if (!baseContainers.length && !characterContainers.length) return null;

  const baseEditors = baseContainers.map(firstEditorInside).filter(Boolean);
  let mainEditor = baseEditors.find(isElementVisible) || null;
  if (!mainEditor) {
    const fallbackCandidates = queryEditors(root)
      .filter((editor) => isElementVisible(editor))
      .map((editor) => ({ editor, kind: classifyPromptContext(collectEditorContext(editor)) }))
      .filter(({ kind }) => kind !== "negative" && kind !== "character");
    const explicit = fallbackCandidates.filter(({ kind }) => kind === "main");
    const conservative = fallbackCandidates.filter(({ kind }) => kind === "unknown");
    mainEditor = explicit[0]?.editor || (conservative.length === 1 ? conservative[0].editor : null);
  }
  const characterCandidates = new Map();
  for (const container of characterContainers) {
    const editor = firstEditorInside(container);
    if (!editor) continue;
    const className = String(container.className);
    const index = className.match(/prompt-input-box-character-prompts-(\d+)/u)?.[1]
      || String(charactersByIndex.size + 1);
    const candidates = characterCandidates.get(index) || [];
    candidates.push({ editor, prompt: readEditorText(editor), visible: isElementVisible(editor) });
    characterCandidates.set(index, candidates);
  }
  const characters = [...characterCandidates.entries()].flatMap(([index, candidates]) => {
    const selected = candidates.sort((left, right) =>
      Number(right.visible) - Number(left.visible) || Number(Boolean(right.prompt)) - Number(Boolean(left.prompt))
    ).find((candidate) => candidate.prompt);
    return selected ? [{ label: `角色 ${index}`, prompt: selected.prompt }] : [];
  });

  return {
    mainEditor,
    snapshot: buildPromptSnapshot(
      readEditorText(mainEditor),
      characters.sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { numeric: true })),
    ),
  };
}

/**
 * 收集当前主提示词和全部角色提示词。
 * 隐藏的主编辑器会被排除；明确属于角色的折叠编辑器仍会收集并去重。
 */
export function collectAllPrompts(root = globalThis.document) {
  const semantic = collectNovelAiSemanticPrompts(root);
  if (semantic) return semantic.snapshot;

  const candidates = queryEditors(root)
    .map((editor, domIndex) => {
      const context = collectEditorContext(editor);
      return {
        editor,
        domIndex,
        context,
        kind: classifyPromptContext(context),
        text: readEditorText(editor),
        visible: isElementVisible(editor),
      };
    })
    .filter((candidate) => candidate.text && candidate.kind !== "negative");

  const scoreMain = (candidate) =>
    (candidate.visible ? 1000 : 0) +
    (candidate.kind === "main" ? 300 : candidate.kind === "unknown" ? 20 : -500) -
    candidate.domIndex;

  const explicitMainCandidates = candidates.filter((candidate) => candidate.kind === "main");
  const unknownMainCandidates = candidates.filter(
    (candidate) => candidate.kind === "unknown" && candidate.visible,
  );
  const mainCandidate = (explicitMainCandidates.length
    ? explicitMainCandidates
    : unknownMainCandidates.length === 1 ? unknownMainCandidates : [])
    .sort((left, right) => scoreMain(right) - scoreMain(left))[0];

  const characterCandidates = candidates.filter(
    (candidate) =>
      candidate !== mainCandidate &&
      (candidate.kind === "character" ||
        (candidate.visible && candidate.kind === "unknown" && Boolean(mainCandidate))),
  );

  const characters = [];
  const seen = new Set();
  for (const candidate of characterCandidates) {
    const explicitLabelMatch = String(candidate.context).match(
      /(?:character|角色|人物|キャラクター)\s*(?:#|no\.?\s*)?(\d+)/iu,
    );
    const explicitLabel = explicitLabelMatch ? `角色 ${explicitLabelMatch[1]}` : "";
    // 没有角色编号的隐藏副本按内容去重；有编号时保留不同角色的相同提示词。
    const key = `${explicitLabel.toLowerCase()}\u0000${candidate.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const label = explicitLabel || deriveCharacterLabel(candidate.context, characters.length + 1);
    characters.push({ label, prompt: candidate.text });
  }

  return buildPromptSnapshot(mainCandidate?.text || "", characters);
}

/** 把提示词快照格式化为编辑弹窗中可直接复制的文本。 */
export function formatPromptSnapshot(snapshot) {
  if (typeof snapshot === "string") {
    snapshot = buildPromptSnapshot(snapshot, []);
  }
  snapshot ||= buildPromptSnapshot();

  const mainPrompt = normalizePromptText(
    snapshot.mainPrompt ?? snapshot.positivePrompt ?? snapshot.basePrompt ?? snapshot.prompt,
  );
  const sourceCharacters = Array.isArray(snapshot.characters)
    ? snapshot.characters
    : Array.isArray(snapshot.characterPrompts)
      ? snapshot.characterPrompts
      : [];
  const characters = sourceCharacters.map(normalizeCharacterEntry).filter((entry) => entry.prompt);

  if (!mainPrompt && characters.length === 0) {
    return "（未检测到可用提示词）";
  }

  const sections = [`【主提示词】\n${mainPrompt || "（空）"}`];
  for (const character of characters) {
    sections.push(`【${character.label}】\n${character.prompt}`);
  }
  return sections.join("\n\n");
}

/** 从展示快照中选择可执行提示词，绝不把“【主提示词】”等标题写入实际提示词。 */
export function selectSnapshotActionPrompt(snapshot, kind) {
  const safeSnapshot = typeof snapshot === "string" ? buildPromptSnapshot(snapshot) : (snapshot || {});
  const mainPrompt = normalizePromptText(
    safeSnapshot.mainPrompt ?? safeSnapshot.positivePrompt ?? safeSnapshot.basePrompt ?? safeSnapshot.prompt,
  );
  const sourceCharacters = Array.isArray(safeSnapshot.characters)
    ? safeSnapshot.characters
    : Array.isArray(safeSnapshot.characterPrompts) ? safeSnapshot.characterPrompts : [];
  const characters = sourceCharacters.map(normalizeCharacterEntry).filter((entry) => entry.prompt);
  if (kind === "artist") {
    return mainPrompt
      ? { ok: true, prompt: mainPrompt }
      : { ok: false, prompt: "", message: "当前没有可用的主提示词。" };
  }
  if (kind === "character" && characters.length === 1) {
    return { ok: true, prompt: characters[0].prompt };
  }
  if (kind === "character" && characters.length > 1) {
    return { ok: false, prompt: "", message: "检测到多个角色，请从上方复制需要的角色段落。" };
  }
  return { ok: false, prompt: "", message: "当前没有可用的角色提示词。" };
}

function promptTabLabel(element) {
  return compactContext(
    [
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-testid"),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function findPromptTab(root) {
  if (!root?.querySelectorAll) {
    return null;
  }
  const semanticBase = [...root.querySelectorAll(".prompt-input-box-base-prompt")]
    .find((element) => element.getBoundingClientRect?.().width > 0)
    || root.querySelector(".prompt-input-box-base-prompt");
  const baseTop = semanticBase?.getBoundingClientRect?.().top;
  const controls = root.querySelectorAll(
    '[role="tab"], button, [aria-controls], [data-state][tabindex]',
  );
  return [...controls]
    .filter((control) => isElementVisible(control) && !control.disabled)
    .map((control) => {
      const label = promptTabLabel(control);
      const rect = control.getBoundingClientRect?.();
      return { control, label, top: rect?.top ?? Number.POSITIVE_INFINITY };
    })
    .filter(({ label }) =>
      /^(?:base\s+prompt|positive\s+prompt|main\s+prompt|prompt|正向提示词|主提示词|基本提示)(?:\s|$)/iu.test(label)
      && !NEGATIVE_CONTEXT.test(label)
      && !CHARACTER_CONTEXT.test(label))
    .sort((left, right) => {
      const leftBase = /^(?:base\s+prompt|positive\s+prompt|main\s+prompt|正向提示词|主提示词|基本提示)(?:\s|$)/iu.test(left.label) ? 1 : 0;
      const rightBase = /^(?:base\s+prompt|positive\s+prompt|main\s+prompt|正向提示词|主提示词|基本提示)(?:\s|$)/iu.test(right.label) ? 1 : 0;
      if (leftBase !== rightBase) return rightBase - leftBase;
      if (Number.isFinite(baseTop)) {
        return Math.abs(left.top - baseTop) - Math.abs(right.top - baseTop);
      }
      return left.top - right.top;
    })[0]?.control;
}

function editorPositionScore(editor) {
  const context = collectEditorContext(editor);
  const kind = classifyPromptContext(context);
  let score = kind === "main" ? 1000 : kind === "unknown" ? 100 : -1000;
  if (isElementVisible(editor)) {
    score += 2000;
  }
  const rect = editor.getBoundingClientRect?.();
  if (rect) {
    score -= Math.max(0, rect.top) / 100;
    score -= Math.max(0, rect.left) / 1000;
  }
  return score;
}

function findMainPromptEditor(root) {
  const semantic = collectNovelAiSemanticPrompts(root);
  if (semantic) {
    return semantic.mainEditor && isElementVisible(semantic.mainEditor)
      ? semantic.mainEditor
      : null;
  }
  const candidates = queryEditors(root)
    .filter((editor) => isElementVisible(editor))
    .map((editor) => ({ editor, kind: classifyPromptContext(collectEditorContext(editor)) }))
    .filter(({ kind }) => kind !== "negative" && kind !== "character");
  const explicit = candidates.filter(({ kind }) => kind === "main").map(({ editor }) => editor);
  const unknown = candidates.filter(({ kind }) => kind === "unknown").map(({ editor }) => editor);
  return (explicit.length ? explicit : unknown.length === 1 ? unknown : [])
    .sort((left, right) => editorPositionScore(right) - editorPositionScore(left))[0] || null;
}

function nextFrame(view) {
  return new Promise((resolve) => {
    if (typeof view?.requestAnimationFrame === "function") {
      view.requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function settleDom(document) {
  const view = document?.defaultView || globalThis;
  await nextFrame(view);
  await nextFrame(view);
}

async function waitForMainPromptEditor(root, timeoutMs = 1000) {
  const document = root.ownerDocument || root;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const editor = findMainPromptEditor(root);
    if (editor && isElementVisible(editor) && !editor.disabled && !editor.readOnly) {
      await settleDom(document);
      if (editor.isConnected && isElementVisible(editor) && !editor.disabled && !editor.readOnly) return editor;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function artistPrefix(artistText, currentPrompt) {
  const artist = normalizePromptText(artistText);
  const current = normalizePromptText(currentPrompt);
  if (!artist) {
    return "";
  }
  if (!current) {
    return artist;
  }
  if (/[,，\n]\s*$/u.test(artist)) {
    return `${artist} `;
  }
  return `${artist}, `;
}

/** 纯函数：计算插入后完整提示词，供测试和 UI 预览使用。 */
export function prependPromptText(artistText, currentPrompt) {
  const current = normalizePromptText(currentPrompt);
  const prefix = artistPrefix(artistText, current);
  return prefix ? `${prefix}${current}` : current;
}

function alreadyStartsWithPrompt(currentPrompt, artistText) {
  const current = normalizePromptText(currentPrompt);
  const artist = normalizePromptText(artistText);
  if (!artist || !current.startsWith(artist)) {
    return false;
  }
  const rest = current.slice(artist.length);
  return rest === "" || /^[\s,，\n]/u.test(rest);
}

function dispatchInput(editor, data) {
  const view = editor.ownerDocument?.defaultView || globalThis;
  let event;
  try {
    event = new view.InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data,
    });
  } catch {
    event = new view.Event("input", { bubbles: true, composed: true });
  }
  editor.dispatchEvent(event);
}

function setNativeValue(editor, value) {
  const view = editor.ownerDocument?.defaultView;
  const prototype = safeMatches(editor, "textarea")
    ? view?.HTMLTextAreaElement?.prototype
    : view?.HTMLInputElement?.prototype;
  const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) {
    setter.call(editor, value);
  } else {
    editor.value = value;
  }
}

function insertIntoTextControl(editor, prefix) {
  const nextValue = `${prefix}${editor.value || ""}`;
  setNativeValue(editor, nextValue);
  editor.focus({ preventScroll: true });
  editor.setSelectionRange?.(prefix.length, prefix.length);
  dispatchInput(editor, prefix);
  return true;
}

function placeCaretAtStart(editor) {
  const document = editor.ownerDocument;
  const selection = document.getSelection?.();
  if (!selection) {
    return false;
  }

  const range = document.createRange();
  const firstBlock = editor.firstElementChild;
  if (firstBlock && /^(?:P|DIV)$/u.test(firstBlock.tagName)) {
    range.setStart(firstBlock, 0);
  } else {
    range.setStart(editor, 0);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function insertIntoContentEditable(editor, prefix) {
  const document = editor.ownerDocument;
  editor.focus({ preventScroll: true });
  if (!placeCaretAtStart(editor)) {
    return false;
  }

  const before = readEditorText(editor);
  let commandResult = false;
  try {
    commandResult = Boolean(document.execCommand?.("insertText", false, prefix));
  } catch {
    commandResult = false;
  }

  return commandResult || readEditorText(editor) !== before;
}

function insertPrefix(editor, prefix) {
  if ("value" in editor && typeof editor.value === "string") {
    return insertIntoTextControl(editor, prefix);
  }
  return insertIntoContentEditable(editor, prefix);
}

/**
 * 切换到 Prompt 页签，把画师串插入可见主 ProseMirror 开头，并在 UI 稳定后核对结果。
 */
export async function prependArtistPrompt(text, root = globalThis.document) {
  const artist = normalizePromptText(text);
  if (!artist || !root?.querySelectorAll) {
    return false;
  }

  const document = root.ownerDocument || root;
  const promptTab = findPromptTab(root);
  if (promptTab && promptTab.getAttribute("aria-selected") !== "true") {
    promptTab.click();
    await settleDom(document);
  }

  const editor = await waitForMainPromptEditor(root);
  if (!editor) {
    return false;
  }

  const currentPrompt = readEditorText(editor);
  if (alreadyStartsWithPrompt(currentPrompt, artist)) {
    return true;
  }

  const prefix = artistPrefix(artist, currentPrompt);
  if (!prefix || !insertPrefix(editor, prefix)) {
    return false;
  }

  await settleDom(document);
  const currentEditor = editor.isConnected ? editor : findMainPromptEditor(root);
  if (currentEditor && alreadyStartsWithPrompt(readEditorText(currentEditor), artist)) {
    return true;
  }
  return false;
}

/** 使用 Clipboard API，失败时退回隐藏 textarea + execCommand。 */
export async function copyText(text) {
  const value = String(text ?? "");
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 权限、焦点或用户激活不足时尝试传统复制方式。
  }

  const document = globalThis.document;
  if (!document?.body || typeof document.execCommand !== "function") {
    return false;
  }

  const activeElement = document.activeElement;
  const selection = document.getSelection?.();
  const savedRanges = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      savedRanges.push(selection.getRangeAt(index).cloneRange());
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed",
    inset: "0 auto auto -10000px",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });

  document.body.append(textarea);
  let copied = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    copied = Boolean(document.execCommand("copy"));
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    activeElement?.focus?.({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of savedRanges) {
        selection.addRange(range);
      }
    }
  }

  return copied;
}

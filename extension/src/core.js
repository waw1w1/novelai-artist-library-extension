/**
 * NovelAI 素材库的纯数据逻辑。
 *
 * normalMaster 始终保留某一图库的全部项目；收藏项目只是在普通展示时被
 * 过滤掉，因此取消收藏后可以回到原来的普通区位置。
 */

export const MANIFEST_SCHEMA_VERSION = 1;
export const LIBRARY_KINDS = Object.freeze(["artist", "character"]);
export const PARTITIONS = Object.freeze({
  FAVORITE: "favorite",
  NORMAL: "normal",
});

const ITEM_SELECTOR = "[data-library-item-id], [data-item-id]";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeId(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function isLibraryKind(kind) {
  return LIBRARY_KINDS.includes(kind);
}

function requireKind(kind) {
  if (!isLibraryKind(kind)) {
    throw new TypeError(`Unknown library kind: ${String(kind)}`);
  }
  return kind;
}

function emptyOrders() {
  return {
    artist: { normalMaster: [], favorites: [] },
    character: { normalMaster: [], favorites: [] },
  };
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const candidate of value) {
    const id = normalizeId(candidate);
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function removeId(list, id) {
  return list.filter((candidate) => candidate !== id);
}

function appendUnique(list, id) {
  return [...removeId(list, id), id];
}

export function createDefaultManifest() {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    items: {},
    orders: emptyOrders(),
  };
}

/**
 * 修复宽松或旧版清单，并返回全新的对象。该函数不会修改传入值。
 */
export function normalizeManifest(input) {
  const source = isRecord(input) ? input : {};
  const rawOrders = isRecord(source.orders) ? source.orders : {};
  const listedKind = new Map();

  for (const kind of LIBRARY_KINDS) {
    const order = isRecord(rawOrders[kind]) ? rawOrders[kind] : {};
    for (const id of [
      ...uniqueStrings(order.normalMaster),
      ...uniqueStrings(order.favorites),
    ]) {
      if (!listedKind.has(id)) listedKind.set(id, kind);
    }
  }

  const itemEntries = [];
  if (Array.isArray(source.items)) {
    source.items.forEach((item, index) => {
      if (isRecord(item)) itemEntries.push([String(index), item]);
    });
  } else if (isRecord(source.items)) {
    itemEntries.push(...Object.entries(source.items).filter(([, item]) => isRecord(item)));
  }

  const aliases = new Map();
  const items = {};
  const itemIds = [];

  for (const [sourceKey, rawItem] of itemEntries) {
    const id = normalizeId(rawItem.id) ?? normalizeId(sourceKey);
    if (!id || hasOwn(items, id)) continue;

    aliases.set(sourceKey, id);
    aliases.set(id, id);

    const kind = isLibraryKind(rawItem.kind)
      ? rawItem.kind
      : listedKind.get(sourceKey) ?? listedKind.get(id) ?? "artist";
    const rawFavoriteOrder = isRecord(rawOrders[kind])
      ? uniqueStrings(rawOrders[kind].favorites)
      : [];
    const favorite = typeof rawItem.favorite === "boolean"
      ? rawItem.favorite
      : rawFavoriteOrder.includes(sourceKey) || rawFavoriteOrder.includes(id);

    items[id] = {
      ...rawItem,
      id,
      kind,
      favorite,
    };
    itemIds.push(id);
  }

  const orders = emptyOrders();
  for (const kind of LIBRARY_KINDS) {
    const rawOrder = isRecord(rawOrders[kind]) ? rawOrders[kind] : {};
    const normalSeen = new Set();
    const favoriteSeen = new Set();

    for (const rawId of uniqueStrings(rawOrder.normalMaster)) {
      const id = aliases.get(rawId) ?? rawId;
      if (
        hasOwn(items, id)
        && items[id].kind === kind
        && !normalSeen.has(id)
      ) {
        normalSeen.add(id);
        orders[kind].normalMaster.push(id);
      }
    }

    // 所有项目都必须在 normalMaster 中有一个“休眠位置”。
    for (const id of itemIds) {
      if (items[id].kind === kind && !normalSeen.has(id)) {
        normalSeen.add(id);
        orders[kind].normalMaster.push(id);
      }
    }

    for (const rawId of uniqueStrings(rawOrder.favorites)) {
      const id = aliases.get(rawId) ?? rawId;
      if (
        hasOwn(items, id)
        && items[id].kind === kind
        && items[id].favorite
        && !favoriteSeen.has(id)
      ) {
        favoriteSeen.add(id);
        orders[kind].favorites.push(id);
      }
    }

    // 清单标记为收藏但收藏顺序缺失时，稳定地追加到末尾。
    for (const id of itemIds) {
      if (
        items[id].kind === kind
        && items[id].favorite
        && !favoriteSeen.has(id)
      ) {
        favoriteSeen.add(id);
        orders[kind].favorites.push(id);
      }
    }
  }

  return {
    ...source,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    items,
    orders,
  };
}

export function getDisplayItems(manifest, kind) {
  requireKind(kind);
  const normalized = normalizeManifest(manifest);
  const favoriteIds = normalized.orders[kind].favorites;
  const normalIds = normalized.orders[kind].normalMaster.filter(
    (id) => !normalized.items[id].favorite,
  );
  return [...favoriteIds, ...normalIds].map((id) => normalized.items[id]);
}

export function getDisplayIds(manifest, kind) {
  return getDisplayItems(manifest, kind).map((item) => item.id);
}

export function setFavorite(manifest, idValue, favorite) {
  const id = normalizeId(idValue);
  if (!id) throw new TypeError("A non-empty item id is required");
  if (typeof favorite !== "boolean") {
    throw new TypeError("favorite must be a boolean");
  }

  const next = normalizeManifest(manifest);
  const item = next.items[id];
  if (!item) throw new RangeError(`Unknown item: ${id}`);
  if (item.favorite === favorite) return next;

  item.favorite = favorite;
  const favorites = next.orders[item.kind].favorites;
  next.orders[item.kind].favorites = favorite
    ? appendUnique(favorites, id)
    : removeId(favorites, id);
  return next;
}

export function toggleFavorite(manifest, idValue) {
  const id = normalizeId(idValue);
  if (!id) throw new TypeError("A non-empty item id is required");
  const normalized = normalizeManifest(manifest);
  const item = normalized.items[id];
  if (!item) throw new RangeError(`Unknown item: ${id}`);
  return setFavorite(normalized, id, !item.favorite);
}

export function getItemPartition(item) {
  return item?.favorite ? PARTITIONS.FAVORITE : PARTITIONS.NORMAL;
}

export function canReorderWithinPartition(manifest, kind, dragIdValue, targetIdValue) {
  if (!isLibraryKind(kind)) return false;
  const dragId = normalizeId(dragIdValue);
  const targetId = normalizeId(targetIdValue);
  if (!dragId || !targetId) return false;

  const normalized = normalizeManifest(manifest);
  const dragItem = normalized.items[dragId];
  const targetItem = normalized.items[targetId];
  return Boolean(
    dragItem
    && targetItem
    && dragItem.kind === kind
    && targetItem.kind === kind
    && dragItem.favorite === targetItem.favorite,
  );
}

function moveRelative(list, dragId, targetId, position) {
  if (dragId === targetId) return [...list];
  const withoutDragged = list.filter((id) => id !== dragId);
  const targetIndex = withoutDragged.indexOf(targetId);
  if (targetIndex < 0) return [...list];
  const insertionIndex = position === "after" ? targetIndex + 1 : targetIndex;
  withoutDragged.splice(insertionIndex, 0, dragId);
  return withoutDragged;
}

/**
 * 仅允许同类型、同收藏分区内重排。跨分区或陈旧目标会安全地原样返回。
 */
export function reorderWithinPartition(
  manifest,
  kind,
  dragIdValue,
  targetIdValue,
  position = "before",
) {
  requireKind(kind);
  if (!["before", "after", "start", "end"].includes(position)) {
    throw new TypeError(`Unknown drop position: ${String(position)}`);
  }

  const next = normalizeManifest(manifest);
  const dragId = normalizeId(dragIdValue);
  const targetId = normalizeId(targetIdValue);
  const dragItem = dragId ? next.items[dragId] : null;
  const targetItem = targetId ? next.items[targetId] : null;

  if (
    !dragItem
    || dragItem.kind !== kind
    || (["before", "after"].includes(position) && (!targetItem || targetItem.kind !== kind))
  ) {
    return next;
  }

  if (position === "start" || position === "end") {
    const partitionIds = dragItem.favorite
      ? [...next.orders[kind].favorites]
      : next.orders[kind].normalMaster.filter((id) => !next.items[id].favorite);
    const withoutDragged = partitionIds.filter((id) => id !== dragId);
    const reordered = position === "start"
      ? [dragId, ...withoutDragged]
      : [...withoutDragged, dragId];
    applyPartitionOrder(next, kind, dragItem.favorite, reordered);
    return next;
  }

  // UI 即使失误把项目投到另一分区，数据层也必须拒绝。
  if (dragItem.favorite !== targetItem.favorite) return next;

  const partitionIds = dragItem.favorite
    ? next.orders[kind].favorites
    : next.orders[kind].normalMaster.filter((id) => !next.items[id].favorite);
  const reordered = moveRelative(partitionIds, dragId, targetId, position);
  applyPartitionOrder(next, kind, dragItem.favorite, reordered);
  return next;
}

function applyPartitionOrder(manifest, kind, favorite, reorderedIds) {
  if (favorite) {
    manifest.orders[kind].favorites = [...reorderedIds];
    return;
  }

  // 只替换普通项目槽位，收藏项目在 normalMaster 中的休眠位置不动。
  let normalIndex = 0;
  manifest.orders[kind].normalMaster = manifest.orders[kind].normalMaster.map((id) => {
    if (manifest.items[id].favorite) return id;
    const replacement = reorderedIds[normalIndex];
    normalIndex += 1;
    return replacement;
  });
}

export function addItemToManifest(manifest, rawItem) {
  if (!isRecord(rawItem)) throw new TypeError("item must be an object");
  const id = normalizeId(rawItem.id);
  if (!id) throw new TypeError("A non-empty item id is required");
  const kind = requireKind(rawItem.kind);

  const next = normalizeManifest(manifest);
  if (hasOwn(next.items, id)) throw new RangeError(`Item already exists: ${id}`);

  const favorite = rawItem.favorite === true;
  next.items[id] = { ...rawItem, id, kind, favorite };
  next.orders[kind].normalMaster.push(id);
  if (favorite) next.orders[kind].favorites.push(id);
  return next;
}

export function updateItemInManifest(manifest, idValue, patch) {
  if (!isRecord(patch)) throw new TypeError("patch must be an object");
  const id = normalizeId(idValue);
  if (!id) throw new TypeError("A non-empty item id is required");
  if (hasOwn(patch, "id") && normalizeId(patch.id) !== id) {
    throw new TypeError("An item id cannot be changed");
  }

  const next = normalizeManifest(manifest);
  const current = next.items[id];
  if (!current) throw new RangeError(`Unknown item: ${id}`);

  const oldKind = current.kind;
  const newKind = hasOwn(patch, "kind") ? requireKind(patch.kind) : oldKind;
  if (hasOwn(patch, "favorite") && typeof patch.favorite !== "boolean") {
    throw new TypeError("favorite must be a boolean");
  }
  const newFavorite = hasOwn(patch, "favorite") ? patch.favorite : current.favorite;

  next.items[id] = {
    ...current,
    ...patch,
    id,
    kind: newKind,
    favorite: newFavorite,
  };

  if (oldKind !== newKind) {
    next.orders[oldKind].normalMaster = removeId(next.orders[oldKind].normalMaster, id);
    next.orders[oldKind].favorites = removeId(next.orders[oldKind].favorites, id);
    next.orders[newKind].normalMaster = appendUnique(next.orders[newKind].normalMaster, id);
    if (newFavorite) {
      next.orders[newKind].favorites = appendUnique(next.orders[newKind].favorites, id);
    }
  } else if (current.favorite !== newFavorite) {
    next.orders[newKind].favorites = newFavorite
      ? appendUnique(next.orders[newKind].favorites, id)
      : removeId(next.orders[newKind].favorites, id);
  }

  return next;
}

export function upsertItemInManifest(manifest, rawItem) {
  if (!isRecord(rawItem)) throw new TypeError("item must be an object");
  const id = normalizeId(rawItem.id);
  if (!id) throw new TypeError("A non-empty item id is required");
  const normalized = normalizeManifest(manifest);
  return hasOwn(normalized.items, id)
    ? updateItemInManifest(normalized, id, rawItem)
    : addItemToManifest(normalized, rawItem);
}

export function removeItemFromManifest(manifest, idValue) {
  const id = normalizeId(idValue);
  if (!id) throw new TypeError("A non-empty item id is required");
  const next = normalizeManifest(manifest);
  const item = next.items[id];
  if (!item) return next;

  delete next.items[id];
  next.orders[item.kind].normalMaster = removeId(next.orders[item.kind].normalMaster, id);
  next.orders[item.kind].favorites = removeId(next.orders[item.kind].favorites, id);
  return next;
}

function anchorElements(container, options) {
  if (options?.elements) return Array.from(options.elements);
  if (typeof container?.querySelectorAll !== "function") return [];
  return Array.from(container.querySelectorAll(options?.selector ?? ITEM_SELECTOR));
}

function elementItemId(element, options) {
  if (typeof options?.getId === "function") return normalizeId(options.getId(element));
  return normalizeId(
    element?.dataset?.libraryItemId
      ?? element?.dataset?.itemId
      ?? element?.getAttribute?.("data-library-item-id")
      ?? element?.getAttribute?.("data-item-id"),
  );
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rectBottom(rect) {
  if (Number.isFinite(Number(rect?.bottom))) return Number(rect.bottom);
  return finiteNumber(rect?.top) + Math.max(0, finiteNumber(rect?.height));
}

/**
 * 记录首个可见卡片及其相对滚动容器顶部的偏移。
 * options.elements/getId 可用于测试或虚拟列表。
 */
export function captureScrollAnchor(container, options = {}) {
  if (!container || typeof container !== "object") {
    throw new TypeError("A scroll container is required");
  }

  const rawScrollTop = Math.max(0, finiteNumber(container.scrollTop));
  const containerRect = typeof container.getBoundingClientRect === "function"
    ? container.getBoundingClientRect()
    : { top: 0, bottom: finiteNumber(container.clientHeight, Number.POSITIVE_INFINITY) };
  const containerTop = finiteNumber(containerRect?.top);
  const containerBottom = rectBottom(containerRect);

  for (const element of anchorElements(container, options)) {
    const anchorId = elementItemId(element, options);
    if (!anchorId || typeof element?.getBoundingClientRect !== "function") continue;
    const rect = element.getBoundingClientRect();
    const top = finiteNumber(rect?.top);
    const bottom = rectBottom(rect);
    if (bottom > containerTop && top < containerBottom) {
      return {
        anchorId,
        offsetPx: top - containerTop,
        rawScrollTop,
      };
    }
  }

  return { anchorId: null, offsetPx: 0, rawScrollTop };
}

function clampScrollTop(container, value) {
  const scrollHeight = finiteNumber(container?.scrollHeight, Number.POSITIVE_INFINITY);
  const clientHeight = Math.max(0, finiteNumber(container?.clientHeight));
  const maxScroll = Number.isFinite(scrollHeight)
    ? Math.max(0, scrollHeight - clientHeight)
    : Number.POSITIVE_INFINITY;
  return Math.min(maxScroll, Math.max(0, finiteNumber(value)));
}

/**
 * 同步恢复锚点。调用者应在布局稳定后的 requestAnimationFrame 中调用。
 * 返回最终写入的 scrollTop，锚点已不存在时退回 rawScrollTop。
 */
export function restoreScrollAnchor(container, anchor, options = {}) {
  if (!container || typeof container !== "object") {
    throw new TypeError("A scroll container is required");
  }

  const safeAnchor = isRecord(anchor) ? anchor : {};
  const anchorId = normalizeId(safeAnchor.anchorId);
  let targetScrollTop = finiteNumber(safeAnchor.rawScrollTop);

  if (anchorId && typeof container.getBoundingClientRect === "function") {
    const element = anchorElements(container, options).find(
      (candidate) => elementItemId(candidate, options) === anchorId,
    );
    if (element && typeof element.getBoundingClientRect === "function") {
      const containerTop = finiteNumber(container.getBoundingClientRect()?.top);
      const elementTop = finiteNumber(element.getBoundingClientRect()?.top);
      const currentScrollTop = Math.max(0, finiteNumber(container.scrollTop));
      const offsetPx = finiteNumber(safeAnchor.offsetPx);
      targetScrollTop = currentScrollTop + elementTop - containerTop - offsetPx;
    }
  }

  targetScrollTop = clampScrollTop(container, targetScrollTop);
  container.scrollTop = targetScrollTop;
  return targetScrollTop;
}


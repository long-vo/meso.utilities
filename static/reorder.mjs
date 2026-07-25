// meso.utilities — hub card ordering. Pure logic behind the drag-to-reorder
// grid on the master page: it decides where a dragged card lands and keeps the
// persisted order in sync with the cards that actually exist. Dual-consumption:
// imported unchanged by the browser (`hub.js`) and by `src/reorder.test.ts`.
// Nothing here touches the DOM or storage — callers pass in ids and rectangles.

/** localStorage key holding the user's card order (an array of `data-tool` ids). */
export const ORDER_KEY = "meso-tool-order";

/**
 * Parse a stored order blob into a clean id list: strings only, no duplicates.
 * Anything unparseable (absent, corrupt, wrong shape) yields an empty list, so
 * a bad value degrades to "no custom order" rather than throwing.
 */
export function parseOrder(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  const ids = [];
  for (const id of parsed) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Merge a saved order with the ids currently on the page: saved ids keep their
 * position, ids that no longer exist are dropped, and new ids (a tool added
 * since the order was saved) are appended in their authored order. So a card
 * added later shows up at the end instead of vanishing.
 */
export function reconcileOrder(saved, ids) {
  const present = new Set(ids);
  const placed = new Set();
  const ordered = [];
  for (const id of saved ?? []) {
    if (!present.has(id) || placed.has(id)) continue;
    placed.add(id);
    ordered.push(id);
  }
  for (const id of ids) {
    if (placed.has(id)) continue;
    placed.add(id);
    ordered.push(id);
  }
  return ordered;
}

/**
 * Rebuild a full order after only the *visible* cards were rearranged: hidden
 * ids keep the slots they had, and the visible slots are refilled with
 * `visibleIds` in their new order. That's what keeps reordering under the
 * favourites filter from silently shuffling cards the user can't see — both the
 * drag and the keyboard path commit through this.
 */
export function withVisibleOrder(order, visibleIds) {
  const visible = new Set(visibleIds);
  let next = 0;
  return order.map((id) => (visible.has(id) ? visibleIds[next++] ?? id : id));
}

/**
 * Move the item at `from` so it lands at insertion index `to`, where `to` is
 * expressed in the *original* list's coordinates (0 = before the first item,
 * `items.length` = after the last). An out-of-range `from`, or a `to` that isn't
 * a number, returns a copy unchanged; an in-range `to` out of bounds is clamped.
 */
export function moveItem(items, from, to) {
  const list = [...items];
  if (!Number.isInteger(from) || from < 0 || from >= list.length) return list;
  if (!Number.isFinite(Number(to))) return list;
  const target = Math.max(0, Math.min(Number(to), list.length));
  const [item] = list.splice(from, 1);
  list.splice(target > from ? target - 1 : target, 0, item);
  return list;
}

/**
 * Shift `id` by `delta` positions (negative = towards the start). Used by the
 * keyboard path, where the grid's column count is the vertical delta. A missing
 * id, a zero delta or a move that would fall off either end is a no-op, so
 * holding an arrow key at the edge simply does nothing.
 */
export function moveBy(items, id, delta) {
  const from = items.indexOf(id);
  if (from === -1 || !Number.isFinite(delta) || delta === 0) return [...items];
  const to = Math.max(0, Math.min(from + Math.trunc(delta), items.length - 1));
  if (to === from) return [...items];
  // `moveItem` takes an insertion index: landing *after* the target when moving
  // forwards means inserting one slot further along.
  return moveItem(items, from, to > from ? to + 1 : to);
}

/** True when two rectangles overlap vertically, i.e. sit in the same grid row. */
function sameRow(a, b) {
  return a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * How much more a row counts than a column when the pointer is off the grid.
 * Cards read left-to-right, top-to-bottom, so a point below the grid belongs to
 * the last row — not to whichever column happens to be closest as the crow
 * flies.
 */
const ROW_WEIGHT = 3;

/**
 * Where a pointer at `point` should insert, given the rectangles of the cards in
 * DOM order. Returns an index in `[0, rects.length]`.
 *
 * The pointer's own row is tried first — cards whose vertical span contains it —
 * so a drag into the empty tail of a half-filled last row appends instead of
 * snapping back up to the row above. Within that row the nearest card wins, and
 * which half of it the pointer is in decides near or far side: horizontal while
 * the grid has several columns, vertical once it has collapsed to one (a narrow
 * screen), where left and right of a card mean nothing.
 *
 * Off the grid entirely — below it, or in the gutter between two rows — there is
 * no row to consult, so the nearest centre decides with rows weighted, and the
 * pointer being below that card means "after it".
 */
export function insertionIndex(rects, point) {
  if (!Array.isArray(rects) || rects.length === 0) return 0;
  let nearest = -1;
  let nearestDistance = Infinity;
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    if (point.y < rect.top || point.y > rect.top + rect.height) continue;
    const distance = Math.abs(point.x - (rect.left + rect.width / 2));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
  }
  if (nearest !== -1) {
    const rect = rects[nearest];
    const multiColumn = rects.some((one, i) =>
      rects.some((other, j) => i !== j && sameRow(one, other))
    );
    const past = multiColumn
      ? point.x > rect.left + rect.width / 2
      : point.y > rect.top + rect.height / 2;
    return past ? nearest + 1 : nearest;
  }
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    const dx = point.x - (rect.left + rect.width / 2);
    const dy = ROW_WEIGHT * (point.y - (rect.top + rect.height / 2));
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
  }
  return point.y > rects[nearest].top ? nearest + 1 : nearest;
}

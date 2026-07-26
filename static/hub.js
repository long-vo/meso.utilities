// meso.utilities — hub (master page) interactions.
import { registerCommands } from "./palette.js";
import { makeToast } from "./ui.mjs";
import {
  insertionIndex,
  moveBy,
  ORDER_KEY,
  parseOrder,
  reconcileOrder,
  withVisibleOrder,
} from "./reorder.mjs";
import { initTour } from "./tour.js";
import { SEEN_KEY, SEEN_VERSION, shouldNudge } from "./tour.mjs";

// "Share to Slack": Slack has no public post-a-message URL, and this hub has no
// backend, so we copy a ready-to-paste message to the clipboard instead.
const shareBtn = document.getElementById("share-slack");
const showToast = makeToast(document.getElementById("toast"));

async function shareToSlack() {
  const message = `meso.utilities — small tools for the team: ${location.href}`;
  try {
    await navigator.clipboard.writeText(message);
    showToast("Copied — paste it into Slack 💬");
  } catch {
    showToast("Couldn't copy — the link is in the address bar");
  }
}

if (shareBtn) shareBtn.addEventListener("click", shareToSlack);

/* ------------------------------ favourites -------------------------------
   A ☆ star at the top-right of every tool card marks it as a favourite.
   Favourites persist in localStorage and drive the favourites-only filter.
   They no longer reorder the grid — the card order is the user's own (see
   "card order" below), so starring a tool never moves it. */

const FAVORITES_KEY = "meso-fav-tools";
// Both are present on the hub page; every other page loads a different script.
const cardsSection = /** @type {HTMLElement} */ (document.querySelector(".cards"));
/** A card's tool id. The selector that collects cards requires `data-tool`,
 *  so this only falls back for a card assembled by hand.
 *  @param {HTMLElement} card */
const toolOf = (card) => card.dataset.tool ?? "";

/** Cards in their authored order, so unstarring restores the default sort. */
const originalCards = /** @type {HTMLElement[]} */ ([
  ...document.querySelectorAll(".cards .card[data-tool]"),
]);

function readFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeFavorites(ids) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
  } catch {
    /* storage may be unavailable; favourites just won't persist */
  }
}

function applyFavoriteState(button, isFavorite) {
  button.classList.toggle("is-fav", isFavorite);
  button.textContent = isFavorite ? "★" : "☆";
  button.setAttribute("aria-pressed", String(isFavorite));
  const tool = button.closest(".card")?.querySelector("h2")?.textContent ?? "this tool";
  button.setAttribute(
    "aria-label",
    isFavorite ? `Remove ${tool} from favourites` : `Add ${tool} to favourites`,
  );
  button.title = isFavorite ? "Remove from favourites" : "Add to favourites";
}

function toggleFavorite(tool, button) {
  const favorites = readFavorites();
  const isFavorite = !favorites.includes(tool);
  writeFavorites(isFavorite ? [...favorites, tool] : favorites.filter((id) => id !== tool));
  applyFavoriteState(button, isFavorite);
  applyFilter();
  showToast(isFavorite ? "Added to favourites ★" : "Removed from favourites");
}

const savedFavorites = new Set(readFavorites());
for (const card of originalCards) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fav-btn";
  button.addEventListener("click", (event) => {
    event.preventDefault(); // the card is a link — don't navigate
    event.stopPropagation();
    toggleFavorite(toolOf(card), button);
  });
  applyFavoriteState(button, savedFavorites.has(toolOf(card)));
  card.appendChild(button);
}

/* ------------------------------ card order -------------------------------
   Cards can be dragged into any order; the arrangement is a list of
   `data-tool` ids in localStorage. It's applied before the grid is revealed,
   and reconciled against the cards actually on the page, so a tool added in a
   later release lands at the end rather than disappearing. */

const orderResetBtn = document.getElementById("order-reset");

function readOrder() {
  try {
    return parseOrder(localStorage.getItem(ORDER_KEY));
  } catch {
    return []; // storage unavailable — fall back to the authored order
  }
}

function writeOrder(ids) {
  try {
    if (ids === null) localStorage.removeItem(ORDER_KEY);
    else localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch {
    /* storage may be unavailable; the order just won't persist */
  }
  if (orderResetBtn) orderResetBtn.hidden = !ids?.length;
}

/** The order the cards ship in — what "Reset order" goes back to. */
function authoredOrder() {
  return originalCards.map((card) => toolOf(card));
}

/** Every card in current DOM order (hidden ones included).
 *  @returns {HTMLElement[]} */
function domCards() {
  return /** @type {HTMLElement[]} */ ([...cardsSection.querySelectorAll(".card[data-tool]")]);
}

/** Ids in current DOM order. */
function domOrder() {
  return domCards().map((card) => toolOf(card));
}

/** Lay the grid out in `ids` order; ids are reconciled against the page first. */
function applyOrder(ids) {
  if (!cardsSection) return;
  const byTool = new Map(originalCards.map((card) => [toolOf(card), card]));
  for (const tool of reconcileOrder(ids, authoredOrder())) {
    // `reconcileOrder` only ever returns ids that are on the page, so the
    // lookup holds — but a saved order must not be able to throw here.
    const card = byTool.get(tool);
    if (card !== undefined) cardsSection.appendChild(card);
  }
}

/**
 * Persist an order — unless it's the one the cards shipped in, which is stored
 * as "no custom order" so "Reset order" stops offering to undo nothing.
 */
function saveOrder(ids) {
  writeOrder(ids.join() === authoredOrder().join() ? null : ids);
}

/** Forget the saved order and lay the cards out as authored. */
function resetOrder() {
  writeOrder(null);
  applyOrder([]);
  showToast("Default order restored");
}

applyOrder(readOrder());
// Offer the reset only when the grid isn't in its default order anyway.
if (orderResetBtn) orderResetBtn.hidden = domOrder().join() === authoredOrder().join();

orderResetBtn?.addEventListener("click", resetOrder);

/* ------------------------- drag to reorder cards -------------------------
   A ⠿ grip in each card's corner starts the drag: pointer events cover mouse,
   pen and touch alike, and the grid reorders live under the pointer (there's
   no drop preview to keep in sync — the card itself is the preview). Escape
   puts it back. The grip is a real button, so the same reordering is available
   from the keyboard with the arrow keys (Home/End for the ends). The cards are
   links, hence the click suppression after a drag and `draggable=false` to keep
   the browser's own link-dragging out of the way. */

/** Cards the user can actually see — the favourites filter hides the rest. */
function visibleCards() {
  return domCards().filter((card) => !card.classList.contains("card--hidden"));
}

/** Ids of the visible cards, in current DOM order. */
function visibleOrder() {
  return visibleCards().map((card) => toolOf(card));
}

/**
 * How many cards share the top row — the vertical step for ↑/↓. Measured from
 * the cards rather than read off `grid-template-columns`, because `auto-fill`
 * reports empty tracks too and would overstate a filtered grid.
 */
function columnCount() {
  const tops = visibleCards().map((card) => card.getBoundingClientRect().top);
  return Math.max(1, tops.filter((top) => top === tops[0]).length);
}

/**
 * Commit a new order of the *visible* cards: lay it out, and persist it with the
 * filtered-out cards left in the slots they already had.
 */
function commitVisibleOrder(order, visibleIds) {
  const full = withVisibleOrder(order, visibleIds);
  applyOrder(full);
  saveOrder(full);
  return full;
}

let drag = null;
/** Set when a drag ends, so the click it produces doesn't follow the card's link. */
let suppressClick = false;

/**
 * Put the dragged card down: undo the lift, drop the document listeners and
 * forget the drag. Returns the drag that was in flight, if any, so callers can
 * decide whether there's anything to save.
 */
function endDrag() {
  if (!drag) return null;
  const ended = drag;
  drag = null;
  document.removeEventListener("pointermove", onPointerMove);
  document.removeEventListener("pointerup", onPointerUp);
  document.removeEventListener("pointercancel", onPointerUp);
  document.removeEventListener("keydown", onDragKeyDown);
  ended.card.style.transform = "";
  ended.card.classList.remove("is-dragging");
  cardsSection.classList.remove("is-reordering");
  return ended;
}

/**
 * Follow the drag on the document rather than through `setPointerCapture` on
 * the grip: reordering re-inserts the dragged card, which implicitly releases
 * the capture and would strand the drag after its first step.
 */
function onPointerDown(event, card, grip) {
  if (event.button > 0) return;
  endDrag(); // a previous drag whose release never arrived must not block this one
  event.preventDefault(); // no text selection, no native link drag
  suppressClick = false;
  grip.focus(); // preventDefault suppresses it, and the arrow keys need it
  settleCards(); // the entrance animation would fight the drag transform
  const rect = card.getBoundingClientRect();
  drag = {
    card,
    grip,
    pointerId: event.pointerId,
    grabX: event.clientX - rect.left,
    grabY: event.clientY - rect.top,
    base: rect,
    startOrder: domOrder(),
    moved: false,
  };
  cardsSection.classList.add("is-reordering");
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", onPointerUp);
  document.addEventListener("keydown", onDragKeyDown);
}

function onPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const dx = event.clientX - (drag.base.left + drag.grabX);
  const dy = event.clientY - (drag.base.top + drag.grabY);
  // Ignore the jitter of a click so a tap on the grip isn't a (no-op) drag.
  if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
  if (!drag.moved) {
    drag.moved = true;
    drag.card.classList.add("is-dragging");
  }

  // Measure with the lift removed, so every rect is a true grid slot — the gap
  // the dragged card left behind included. That gap is what tells us the
  // pointer is already home: without it, a drag into the last row's empty tail
  // oscillates, because appending the card reflows the grid out from under the
  // very pointer position that asked for it.
  drag.card.style.transform = "";
  const cards = visibleCards();
  const rects = cards.map((card) => card.getBoundingClientRect());
  const from = cards.indexOf(drag.card);
  const target = insertionIndex(rects, { x: event.clientX, y: event.clientY });
  if (target !== from && target !== from + 1) {
    // Past the last visible card, land right after it — not after any
    // filtered-out cards trailing it, whose place the user can't see to judge.
    const before = target < cards.length
      ? cards[target]
      : cards[cards.length - 1]?.nextElementSibling ?? null;
    cardsSection.insertBefore(drag.card, before);
    drag.base = drag.card.getBoundingClientRect(); // re-anchor to the new slot
  }
  drag.card.style.transform = `translate(${event.clientX - (drag.base.left + drag.grabX)}px, ${
    event.clientY - (drag.base.top + drag.grabY)
  }px)`;
}

function onPointerUp(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const { moved, startOrder, grip } = endDrag();
  if (!moved) return;
  suppressClick = true;
  const full = commitVisibleOrder(startOrder, visibleOrder());
  grip.focus(); // laying the order out again drops focus; the arrow keys need it
  if (full.join() !== startOrder.join()) showToast("Order saved");
}

/** Escape puts the card back where the drag started. */
function onDragKeyDown(event) {
  if (event.key !== "Escape" || !drag) return;
  const { moved, startOrder, grip } = endDrag();
  suppressClick = moved; // the release still comes, and with it a click
  applyOrder(startOrder);
  grip.focus();
  if (moved) showToast("Move cancelled");
}

function onGripKeyDown(event, card, grip) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return; // ⌘←  is Back
  const columns = columnCount();
  const visible = visibleOrder();
  const steps = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -columns,
    ArrowDown: columns,
    Home: -visible.length,
    End: visible.length,
  };
  const delta = steps[event.key];
  if (delta === undefined) return;
  event.preventDefault();
  settleCards();
  const moved = moveBy(visible, toolOf(card), delta);
  if (moved.join() === visible.join()) return;
  commitVisibleOrder(domOrder(), moved);
  grip.focus(); // moving the card in the DOM can drop focus
  showToast(`Moved to position ${moved.indexOf(toolOf(card)) + 1} of ${moved.length}`);
}

for (const card of originalCards) {
  card.draggable = false;
  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "grip-btn";
  grip.innerHTML =
    `<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" focusable="false">` +
    [3, 8, 13].map((y) => `<circle cx="3" cy="${y}" r="1.4" /><circle cx="7" cy="${y}" r="1.4" />`)
      .join("") +
    `</svg>`;
  const tool = card.querySelector("h2")?.textContent ?? "this tool";
  grip.setAttribute("aria-label", `Reorder ${tool} — drag, or move with the arrow keys`);
  grip.title = "Drag to reorder (arrow keys work too)";
  grip.addEventListener("pointerdown", (event) => onPointerDown(event, card, grip));
  grip.addEventListener("keydown", (event) => onGripKeyDown(event, card, grip));
  // The grip sits inside the card's <a>: never let it navigate.
  grip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  card.appendChild(grip);
}

// Cancelling `pointerdown` doesn't stop the click that follows the release, and
// it can land on whichever card is under the pointer — swallow it in the capture
// phase so finishing a drag never navigates away. Any fresh press clears the
// flag, so a drag released off the grid can't eat an ordinary click later.
cardsSection?.addEventListener(
  "click",
  (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);
cardsSection?.addEventListener("pointerdown", () => (suppressClick = false), true);

// A drag that never gets its release — the pointer left the window, or a tab
// switch swallowed it — must not leave a card stuck to the cursor.
addEventListener("blur", () => endDrag());
document.addEventListener("visibilitychange", () => document.hidden && endDrag());

/* --------------------- show favourites only (filter) ---------------------
   A toolbar toggle hides every non-favourite card; the choice persists in
   localStorage. With the filter on and nothing starred, an empty-state hint
   replaces the grid. */

const FAV_ONLY_KEY = "meso-fav-only";

function readFavOnly() {
  return localStorage.getItem(FAV_ONLY_KEY) === "1";
}

function writeFavOnly(on) {
  try {
    localStorage.setItem(FAV_ONLY_KEY, on ? "1" : "0");
  } catch {
    /* storage may be unavailable; the choice just won't persist */
  }
}

// The toggle pill and empty-state hint live in the static HTML (so the grid
// doesn't shift when this deferred module runs); here we just wire them up.
const favFilterBtn = /** @type {HTMLElement} */ (document.getElementById("fav-filter"));
const favEmptyState = /** @type {HTMLElement} */ (document.querySelector(".cards-empty"));

/** Hide non-favourites when the filter is on; show the hint if none remain. */
function applyFilter() {
  const favOnly = readFavOnly();
  const favorites = new Set(readFavorites());
  for (const card of originalCards) {
    card.classList.toggle("card--hidden", favOnly && !favorites.has(toolOf(card)));
  }
  const hasFavorites = originalCards.some((card) => favorites.has(toolOf(card)));
  favEmptyState.hidden = !(favOnly && !hasFavorites);
  favFilterBtn.classList.toggle("is-active", favOnly);
  favFilterBtn.setAttribute("aria-pressed", String(favOnly));
}

favFilterBtn.addEventListener("click", () => {
  const favOnly = !readFavOnly();
  writeFavOnly(favOnly);
  applyFilter();
  showToast(favOnly ? "Showing favourites only" : "Showing all tools");
});

applyFilter();

// The grid starts hidden (see the html.js .cards opacity rule) so applying the
// saved order above isn't seen as a reshuffle; reveal it now that it's arranged.
cardsSection?.classList.add("is-ready");

// Once the staggered entrance has played out, retire it: re-inserting a card
// mid-reorder would otherwise replay the fade-in, and an animated transform
// outranks the inline one the drag sets — the card would snap back to its slot
// under the pointer. Reordering settles the cards immediately for that reason,
// so this timer is only for the grid nobody touches.
function settleCards() {
  cardsSection?.classList.add("is-settled");
}
setTimeout(settleCards, 900);

/* -------------------------------- the tour -------------------------------
   A focus stage over the hub: one tool per screen, Back/Continue. It reads the
   cards for everything visual (title, colour, tags, href, the illustration
   itself), so the stage and the grid can't drift; tour.mjs holds the prose.
   `originalCards` — the authored order, unfiltered — is deliberate: a dragged
   grid or the favourites filter must not reorder or skip the tour. */

const tourBtn = /** @type {HTMLElement} */ (document.getElementById("tour-start"));
const tourNudge = /** @type {HTMLElement} */ (document.getElementById("tour-nudge"));

const tour = initTour({
  cards: originalCards,
  // Hand attention back to the grid: the tool the tour ended on is scrolled to
  // and pulsed once, rather than the modal just vanishing.
  onClose: (step) => {
    const card = originalCards.find((one) => toolOf(one) === step?.id);
    if (!card || card.classList.contains("card--hidden")) return;
    card.classList.remove("is-pulse");
    void card.offsetWidth; // restart the animation if it's the same card again
    card.classList.add("is-pulse");
    card.scrollIntoView({ block: "center", behavior: "smooth" });
  },
});

function dismissNudge() {
  tourNudge.hidden = true;
  try {
    localStorage.setItem(SEEN_KEY, SEEN_VERSION);
  } catch {
    /* storage may be unavailable; the nudge just comes back next visit */
  }
}

function openTour() {
  tourNudge.hidden = true;
  tour.open(0);
}

tourBtn.hidden = false; // the launcher is hidden in the HTML until it works
tourBtn.addEventListener("click", openTour);
document.getElementById("tour-nudge-start")?.addEventListener("click", openTour);
document.getElementById("tour-nudge-dismiss")?.addEventListener("click", dismissNudge);

// Only ever a nudge — the modal never opens by itself.
try {
  tourNudge.hidden = !shouldNudge(localStorage.getItem(SEEN_KEY));
} catch {
  tourNudge.hidden = false; // storage unavailable: offer it, don't hide it
}

// The palette's cross-page entry navigates here with #tour (the tour lives on
// the hub, so from a tool page the only way in is to come back first).
if (location.hash === "#tour") {
  history.replaceState(null, "", location.pathname + location.search);
  openTour();
}

/* ---------------------------- command palette ---------------------------- */

registerCommands([
  {
    icon: "▸",
    title: "Take a tour",
    hint: "action",
    keywords: ["tour", "guide", "intro", "help", "walkthrough", "onboarding", "what", "explain"],
    run: openTour,
  },
  {
    icon: "★",
    title: "Toggle favourites-only filter",
    hint: "action",
    keywords: ["favourites", "favorites", "filter", "star"],
    run: () => favFilterBtn.click(),
  },
  {
    icon: "⠿",
    title: "Reset tool order",
    hint: "action",
    keywords: ["order", "reorder", "drag", "default", "reset", "arrange"],
    run: resetOrder,
  },
  {
    icon: "💬",
    title: "Copy Slack share message",
    hint: "action",
    keywords: ["share", "slack"],
    run: shareToSlack,
  },
]);

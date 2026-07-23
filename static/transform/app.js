// meso.utilities — browser UI for Text Transform. All text logic lives in
// transform.mjs (the module the parity tests exercise); this file only wires
// the DOM: the searchable action list, undo/redo, selection handling, stats,
// palette commands and hand-offs. Input never leaves the page.
import {
  ACTIONS,
  applyAction,
  CATEGORIES,
  filterActions,
  findAction,
  parseFavorites,
  serializeFavorites,
  toggleFavorite,
} from "./transform.mjs";
import { sendHandoff, takeHandoff } from "../handoff.mjs";
import { registerCommands, TOOL_ICONS } from "../palette.js";
import { makeToast } from "../ui.mjs";

const $ = (id) => document.getElementById(id);

const els = {
  input: $("input"),
  search: $("action-search"),
  actionList: $("action-list"),
  pattern: $("opt-pattern"),
  delimiter: $("opt-delimiter"),
  favList: $("fav-list"),
  favEmpty: $("fav-empty"),
  undo: $("undo"),
  redo: $("redo"),
  copy: $("copy"),
  clear: $("clear"),
  sendSanitize: $("send-sanitize"),
  sendDecode: $("send-decode"),
  status: $("apply-status"),
  stats: $("stats"),
  toast: $("toast"),
};

const showToast = makeToast(els.toast);

const SAMPLE = [
  "getUserAccountById",
  "spring.datasource.driver-class-name",
  "MAX_RETRY_COUNT",
  "id, firstName, last_name, e-mail",
].join("\n");

/** Icons per category, reused by the list headings and the ⌘K palette. */
const CATEGORY_ICONS = {
  "Switch case": "🔠",
  "Case toggles": "🔁",
  "Sort lines": "↕️",
  "Align": "📐",
  "Filter / remove / trim": "🧹",
  "Convert": "🔄",
  "Quotes & other": "✏️",
};

/* ------------------------------ undo / redo ------------------------------ */

const HISTORY_LIMIT = 100;
const undoStack = [];
const redoStack = [];

function updateHistoryButtons() {
  els.undo.disabled = undoStack.length === 0;
  els.redo.disabled = redoStack.length === 0;
}

function pushUndo() {
  undoStack.push(els.input.value);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(els.input.value);
  els.input.value = undoStack.pop();
  afterChange("Undone");
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(els.input.value);
  els.input.value = redoStack.pop();
  afterChange("Redone");
}

/* -------------------------------- applying ------------------------------- */

function updateStats() {
  const text = els.input.value;
  const lines = text === "" ? 0 : text.split("\n").length;
  const words = (text.match(/\S+/g) ?? []).length;
  els.stats.innerHTML = `<span>${lines} lines · ${words} words · ${text.length} chars</span>`;
}

/** Show the applied-action status; the full text lives in the tooltip since
 * long labels are ellipsized by CSS so the toolbar row never wraps. */
function setStatus(text, ok) {
  els.status.textContent = text;
  els.status.title = text;
  els.status.className = ok ? "status ok" : "status";
}

function afterChange(statusText) {
  setStatus(statusText, true);
  updateStats();
  updateHistoryButtons();
}

/** Run one action — on the selection when there is one, else on the whole text. */
function runAction(id) {
  const action = findAction(id);
  const options = { pattern: els.pattern.value, delimiter: els.delimiter.value };
  const { selectionStart: start, selectionEnd: end, value } = els.input;
  const hasSelection = start !== end;
  const target = hasSelection ? value.slice(start, end) : value;

  let result;
  try {
    result = applyAction(id, target, options);
  } catch (error) {
    showToast(error.message);
    if (action.needs === "pattern" && els.pattern.value === "") els.pattern.focus();
    setStatus("", false);
    return;
  }

  if (result === target) {
    setStatus(`${action.label} — no change`, false);
    return;
  }

  pushUndo();
  if (hasSelection) {
    els.input.value = value.slice(0, start) + result + value.slice(end);
    els.input.setSelectionRange(start, start + result.length);
  } else {
    els.input.value = result;
  }
  afterChange(hasSelection ? `${action.label} (selection)` : action.label);
}

/* ------------------------------- favourites ------------------------------ */
// Starred actions are pinned to the Favourites rail (the third column, like
// Leave's templates) — the list/toggle logic is pure and lives in transform.mjs.

const FAVORITES_KEY = "meso-fav-actions";

function readFavorites() {
  try {
    return parseFavorites(localStorage.getItem(FAVORITES_KEY));
  } catch {
    return [];
  }
}

function writeFavorites(ids) {
  try {
    localStorage.setItem(FAVORITES_KEY, serializeFavorites(ids));
  } catch {
    /* storage may be unavailable; favourites just won't persist */
  }
}

let favorites = readFavorites();

function toggleFav(id) {
  const isFavorite = !favorites.includes(id);
  favorites = toggleFavorite(favorites, id);
  writeFavorites(favorites);
  renderActions(els.search.value);
  renderFavorites();
  showToast(isFavorite ? "Added to favourites ★" : "Removed from favourites");
}

/** One list row: the action button plus its ☆/★ star. Shared by both lists. */
function buildActionRow(action) {
  const row = document.createElement("div");
  row.className = "action-row";
  row.setAttribute("role", "listitem");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "action-btn";
  button.textContent = action.label;
  if (action.needs) button.title = `Uses the ${action.needs} field under Options`;
  button.addEventListener("click", () => runAction(action.id));

  const isFavorite = favorites.includes(action.id);
  const star = document.createElement("button");
  star.type = "button";
  star.className = "fav-btn" + (isFavorite ? " is-fav" : "");
  star.textContent = isFavorite ? "★" : "☆";
  star.title = isFavorite ? "Remove from favourites" : "Add to favourites";
  star.setAttribute("aria-pressed", String(isFavorite));
  star.setAttribute(
    "aria-label",
    isFavorite ? `Remove ${action.label} from favourites` : `Add ${action.label} to favourites`,
  );
  star.addEventListener("click", () => toggleFav(action.id));

  row.append(button, star);
  return row;
}

/** The Favourites rail, in the order the actions were starred. */
function renderFavorites() {
  els.favList.innerHTML = "";
  const actions = favorites
    .map((id) => ACTIONS.find((action) => action.id === id))
    .filter(Boolean);
  els.favEmpty.hidden = actions.length > 0;
  for (const action of actions) els.favList.appendChild(buildActionRow(action));
}

/* ------------------------------ action list ------------------------------ */

/** Visible actions grouped by category, each group sorted A-Z by label. */
function displayedGroups(query) {
  const visible = filterActions(query);
  const groups = [];
  for (const category of CATEGORIES) {
    const actions = visible
      .filter((action) => action.category === category)
      .sort((a, b) => a.label.localeCompare(b.label));
    if (actions.length > 0) groups.push({ category, actions });
  }
  return groups;
}

function renderActions(query) {
  const groups = displayedGroups(query);
  els.actionList.innerHTML = "";
  if (groups.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No matching action.";
    els.actionList.appendChild(empty);
    return;
  }
  for (const { category, actions } of groups) {
    const heading = document.createElement("div");
    heading.className = "action-group";
    heading.textContent = `${CATEGORY_ICONS[category] ?? "·"} ${category}`;
    els.actionList.appendChild(heading);
    for (const action of actions) els.actionList.appendChild(buildActionRow(action));
  }
}

els.search.addEventListener("input", () => renderActions(els.search.value));
els.search.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  // Run the first action as displayed (groups in category order, A-Z inside).
  const first = displayedGroups(els.search.value)[0]?.actions[0];
  if (first) runAction(first.id);
  event.preventDefault();
});

/* -------------------------------- actions -------------------------------- */

async function copyText() {
  if (els.input.value === "") return;
  try {
    await navigator.clipboard.writeText(els.input.value);
    showToast("Copied to clipboard");
  } catch {
    showToast("Copy failed — select and copy manually");
  }
}

function clearAll() {
  if (els.input.value !== "") pushUndo();
  els.input.value = "";
  els.status.textContent = "";
  updateStats();
  els.input.focus();
}

/** Hand the current text to another tool — consumed on its page load. */
function sendTextTo(target) {
  if (els.input.value === "") return;
  if (!sendHandoff(sessionStorage, target, els.input.value, "Text Transform")) {
    showToast("Text too large to hand off — use Copy instead");
    return;
  }
  location.href = `../${target}/`;
}

/* --------------------------------- wire ---------------------------------- */

els.input.addEventListener("input", () => {
  setStatus("", false);
  updateStats();
});
els.undo.addEventListener("click", undo);
els.redo.addEventListener("click", redo);
els.copy.addEventListener("click", copyText);
els.clear.addEventListener("click", clearAll);
els.sendSanitize.addEventListener("click", () => sendTextTo("sanitize"));
els.sendDecode.addEventListener("click", () => sendTextTo("decode"));

// Ctrl/⌘+Alt+Z steps the action history back (plain Ctrl/⌘+Z stays the
// textarea's native undo for typing).
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.altKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  }
});

registerCommands([
  { icon: "📋", title: "Copy text", hint: "action", run: copyText },
  { icon: "↩", title: "Undo last transform", hint: "action", keywords: ["revert"], run: undo },
  {
    icon: TOOL_ICONS.sanitize,
    title: "Send text to Sanitize JSON",
    hint: "action",
    run: () => sendTextTo("sanitize"),
  },
  {
    icon: TOOL_ICONS.decode,
    title: "Send text to Decode Anything",
    hint: "action",
    run: () => sendTextTo("decode"),
  },
]);
// Every transform is reachable from the ⌘K palette too.
registerCommands(
  ACTIONS.map((action) => ({
    icon: CATEGORY_ICONS[action.category] ?? "·",
    title: action.label,
    hint: action.category.toLowerCase(),
    keywords: action.keywords,
    run: () => runAction(action.id),
  })),
);

// An incoming handoff from another tool wins over the default sample.
function receiveHandoff() {
  const handoff = takeHandoff(sessionStorage, "transform");
  if (!handoff) return false;
  els.input.value = handoff.text;
  showToast(`Received from ${handoff.from || "another tool"}`);
  updateStats();
  return true;
}

// Re-check on back/forward-cache restores too (Send to → Back → Send to again
// revives this page without re-running the script).
globalThis.addEventListener("pageshow", (event) => {
  if (event.persisted) receiveHandoff();
});

renderActions("");
renderFavorites();
updateHistoryButtons();
if (!receiveHandoff()) {
  els.input.value = SAMPLE;
  updateStats();
}

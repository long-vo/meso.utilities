// meso.utilities — browser UI for Shortlink.
// Imports the same pure logic the parity tests exercise; links live in this
// browser's localStorage only. A `#name` in the URL redirects to the target;
// this file owns the DOM wiring (directory, create form, export/import).
import {
  addLink,
  bookmarksToLinks,
  buildShortlinkUrl,
  decodeShare,
  displayHost,
  encodeShare,
  filterLinks,
  findDuplicateTarget,
  groupLinks,
  groupTree,
  hueForText,
  linksInGroup,
  mergeLinks,
  moveToGroup,
  normalizeGroup,
  parseBookmarksHtml,
  parseHash,
  parseImport,
  removeLink,
  renameGroup,
  renameGroupList,
  reorderLink,
  resolveDynamic,
  serializeLinks,
  STORE_KEY,
  suggestName,
  topLinks,
  updateLink,
  validateName,
  validateUrl,
} from "./shortlink.mjs";
import { registerCommands } from "../palette.js";
import { makeToast } from "../ui.mjs";

const $ = (id) => document.getElementById(id);

const els = {
  missBanner: $("miss-banner"),
  form: $("create-form"),
  editCancel: $("edit-cancel"),
  name: $("name"),
  nameError: $("name-error"),
  url: $("url"),
  urlError: $("url-error"),
  urlDup: $("url-dup"),
  group: $("group"),
  groupList: $("group-list"),
  preview: $("preview"),
  previewUrl: $("preview-url"),
  previewDyn: $("preview-dyn"),
  previewDynExample: $("preview-dyn-example"),
  add: $("add"),
  count: $("count"),
  directory: $("directory"),
  frequent: $("frequent"),
  empty: $("empty"),
  viewList: $("view-list"),
  viewGrid: $("view-grid"),
  newGroup: $("new-group"),
  filter: $("filter"),
  shareBtn: $("share"),
  exportBtn: $("export"),
  importBtn: $("import"),
  importFile: $("import-file"),
  picker: $("picker"),
  pickerTitle: $("picker-title"),
  pickerHint: $("picker-hint"),
  pickerList: $("picker-list"),
  pickAll: $("pick-all"),
  pickImport: $("pick-import"),
  pickCancel: $("pick-cancel"),
  toast: $("toast"),
};

const showToast = makeToast(els.toast);

/** localStorage key for the directory's collapsed group names. */
const COLLAPSED_KEY = "meso-shortlinks-collapsed";
/** localStorage key for the directory view ("list" or "grid"). */
const VIEW_KEY = "meso-shortlinks-view";
/** localStorage key for the persisted filter query. */
const FILTER_KEY = "meso-shortlinks-filter";
/** localStorage key for explicitly created groups (they render even empty). */
const GROUPS_KEY = "meso-shortlinks-groups";
/** localStorage key for per-link redirect counts (the "Frequently used" strip). */
const HITS_KEY = "meso-shortlinks-hits";
/** Sentinel in the collapsed set for the "Frequently used" strip — the control
 *  character keeps it from ever colliding with a real group path. */
const FREQUENT_COLLAPSE_KEY = "\u0000frequently-used";

/* -------------------------------- storage -------------------------------- */

function loadLinks() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    return data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveLinks(links) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(links));
  } catch {
    showToast("Couldn't save — this browser's storage is unavailable.");
  }
}

function loadCollapsed() {
  try {
    const data = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(collapsed) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch { /* UI state only — losing it is fine */ }
}

function loadGroups() {
  try {
    const data = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]");
    return Array.isArray(data) ? data.filter((group) => typeof group === "string") : [];
  } catch {
    return [];
  }
}

function saveGroups(groups) {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
  } catch {
    showToast("Couldn't save — this browser's storage is unavailable.");
  }
}

function loadHits() {
  try {
    const data = JSON.parse(localStorage.getItem(HITS_KEY) ?? "{}");
    return data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveHits(hits) {
  try {
    localStorage.setItem(HITS_KEY, JSON.stringify(hits));
  } catch { /* usage stats only — losing them is fine */ }
}

function bumpHit(name) {
  const hits = loadHits();
  hits[name] = (hits[name] ?? 0) + 1;
  saveHits(hits);
}

/* ------------------------------- redirect -------------------------------- */

// A `#name` visit either redirects (before the hidden page is ever shown) or
// falls through to the directory with an explanation and the name pre-filled.
// `#share=<blob>` opens the import picker with the shared links instead.
function followHash() {
  const raw = parseHash(location.hash);
  if (raw.startsWith("share=")) {
    document.documentElement.classList.remove("resolving");
    // Clear the hash so a reload doesn't re-offer the same import.
    history.replaceState(null, "", location.pathname + location.search);
    const decoded = decodeShare(raw.slice("share=".length));
    if (!decoded.ok) {
      showToast(decoded.error);
      return;
    }
    openPicker(linksToCandidates(decoded.links), "share");
    return;
  }
  if (raw !== "") {
    const links = loadLinks();
    const target = resolveDynamic(links, raw);
    if (target !== null) {
      // Count the visit on the resolved link (the head name for dynamic hits).
      bumpHit(Object.hasOwn(links, raw) ? raw : raw.split("/")[0]);
      location.replace(target);
      return;
    }
    els.missBanner.textContent =
      `No shortlink named "${raw}" in this browser — create it below, or import a ` +
      "shortlinks.json that defines it.";
    els.missBanner.hidden = false;
    if (els.name.value === "") {
      els.name.value = raw;
      syncForm();
    }
  }
  document.documentElement.classList.remove("resolving");
}

/* ------------------------------- directory ------------------------------- */

function loadView() {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function setView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch { /* UI state only — losing it is fine */ }
  els.viewList.setAttribute("aria-pressed", String(view === "list"));
  els.viewGrid.setAttribute("aria-pressed", String(view === "grid"));
  renderDirectory();
}

function loadFilter() {
  try {
    return localStorage.getItem(FILTER_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveFilter(query) {
  try {
    if (query === "") localStorage.removeItem(FILTER_KEY);
    else localStorage.setItem(FILTER_KEY, query);
  } catch { /* UI state only — losing it is fine */ }
}

function copyShortlink(name) {
  navigator.clipboard.writeText(buildShortlinkUrl(location.href, name)).then(
    () => showToast("Shortlink copied — it works wherever your shortlinks are imported."),
    () => showToast("Couldn't access the clipboard."),
  );
}

/** The name of the link loaded into the form for editing, or null. */
let editingName = null;
/** True while the name field holds a slug we derived from the URL — such a name
 *  keeps following the URL until the user types their own. */
let nameAutofilled = false;

function startEdit(name) {
  const entry = loadLinks()[name];
  if (!entry) return;
  editingName = name;
  nameAutofilled = false;
  els.name.value = name;
  els.url.value = entry.url;
  els.group.value = entry.group ?? "";
  els.add.textContent = "Save changes";
  els.editCancel.hidden = false;
  syncForm();
  els.name.focus();
  els.name.scrollIntoView({ block: "nearest" });
}

function exitEdit() {
  editingName = null;
  nameAutofilled = false;
  els.name.value = "";
  els.url.value = "";
  els.group.value = "";
  els.add.textContent = "Add shortlink";
  els.editCancel.hidden = true;
  syncForm();
}

/**
 * Auto-suggest a name from the URL while creating a link: fills the name field
 * from the URL as long as the user hasn't typed their own name (an empty field,
 * or one we filled ourselves). Never touches the name while editing.
 */
function maybeSuggestName() {
  if (editingName !== null) return;
  if (els.name.value !== "" && !nameAutofilled) return;
  const suggestion = suggestName(els.url.value, loadLinks());
  if (suggestion === "") {
    // The URL isn't usable yet — clear only a name we put there ourselves.
    if (nameAutofilled) {
      els.name.value = "";
      nameAutofilled = false;
    }
    return;
  }
  els.name.value = suggestion;
  nameAutofilled = true;
}

function deleteLink(name) {
  if (editingName === name) exitEdit();
  const hits = loadHits();
  if (Object.hasOwn(hits, name)) {
    delete hits[name];
    saveHits(hits);
  }
  const links = loadLinks();
  const removedEntry = links[name];
  saveLinks(removeLink(links, name));
  renderDirectory();
  syncForm();
  showToast(`Deleted "${name}".`, {
    label: "Undo",
    onAction: () => {
      saveLinks({ ...loadLinks(), [name]: removedEntry });
      renderDirectory();
      syncForm();
    },
  });
}

/** The link being dragged, or null. */
let dragging = null;

function clearDropMarks() {
  const marks = ".sl-drop-before, .sl-drop-after, .sl-drop-into, .sl-dragging";
  for (const el of document.querySelectorAll(marks)) {
    el.classList.remove("sl-drop-before", "sl-drop-after", "sl-drop-into", "sl-dragging");
  }
}

/**
 * Finish a drop: put the dragged link before `beforeName` (null = end) in
 * `group`, moving it there first when it comes from another group.
 */
function completeDrop(group, beforeName) {
  const draggedName = dragging.name;
  const movedGroups = dragging.group !== group;
  dragging = null;
  clearDropMarks();
  saveLinks(reorderLink(moveToGroup(loadLinks(), draggedName, group), draggedName, beforeName));
  renderDirectory();
  if (movedGroups) {
    showToast(`Moved "${draggedName}" to ${group === "" ? "Ungrouped" : `"${group}"`}.`);
  }
}

/**
 * Make a row/tile a drag source and drop target: reordering within its group,
 * or — when the dragged link comes from another group — moving it here at the
 * drop position. `axis` is where the insertion marker goes: "y" for list rows
 * (above/below), "x" for grid tiles (left/right).
 */
function wireDrag(el, name, group, axis) {
  el.draggable = true;
  el.addEventListener("dragstart", (event) => {
    dragging = { name, group };
    el.classList.add("sl-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", name);
    }
  });
  el.addEventListener("dragend", () => {
    dragging = null;
    clearDropMarks();
  });
  el.addEventListener("dragover", (event) => {
    if (!dragging || dragging.name === name) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const rect = el.getBoundingClientRect();
    const before = axis === "y"
      ? event.clientY < rect.top + rect.height / 2
      : event.clientX < rect.left + rect.width / 2;
    el.classList.toggle("sl-drop-before", before);
    el.classList.toggle("sl-drop-after", !before);
  });
  el.addEventListener("dragleave", () => el.classList.remove("sl-drop-before", "sl-drop-after"));
  el.addEventListener("drop", (event) => {
    if (!dragging || dragging.name === name) return;
    event.preventDefault();
    const before = el.classList.contains("sl-drop-before");
    const entries = groupLinks(loadLinks()).find((g) => g.group === group)?.entries ?? [];
    const index = entries.findIndex((entry) => entry.name === name);
    // Dropping after this element means "before whatever follows it" (or last).
    completeDrop(group, before ? name : entries[index + 1]?.name ?? null);
  });
}

/**
 * Make a group's container (the rows column / tile grid) a drop target for its
 * empty space — dropping past the last item (e.g. where a new line would
 * start) puts the dragged link at the end of this group, moving it here when
 * it comes from another group. Drops over an actual row/tile are handled by
 * that element's own wireDrag handlers.
 */
function wireContainerDrop(container, group) {
  const overEmptySpace = (event) =>
    dragging !== null &&
    !(event.target instanceof Element && event.target.closest(".sl-row, .sl-tile"));
  container.addEventListener("dragover", (event) => {
    if (!overEmptySpace(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const last = container.lastElementChild;
    if (last) {
      last.classList.add("sl-drop-after");
      last.classList.remove("sl-drop-before");
    }
  });
  container.addEventListener("dragleave", (event) => {
    if (event.target === container) {
      container.lastElementChild?.classList.remove("sl-drop-after");
    }
  });
  container.addEventListener("drop", (event) => {
    if (!overEmptySpace(event)) return;
    event.preventDefault();
    completeDrop(group, null);
  });
}

/**
 * Make a group header a drop target: dropping a link on it moves the link to
 * the end of that group — handy for collapsed groups and sub-group headers.
 */
function wireHeaderDrop(head, group) {
  head.addEventListener("dragover", (event) => {
    if (!dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    head.classList.add("sl-drop-into");
  });
  head.addEventListener("dragleave", () => head.classList.remove("sl-drop-into"));
  head.addEventListener("drop", (event) => {
    if (!dragging) return;
    event.preventDefault();
    completeDrop(group, null);
  });
}

/**
 * Swap a group header row for an inline rename form: Enter saves (sub-groups
 * follow along), Escape or clicking away cancels back to the directory.
 */
function startGroupRename(path, row) {
  const form = document.createElement("form");
  form.className = "sl-group-rename";
  const input = document.createElement("input");
  input.type = "text";
  input.value = path;
  input.setAttribute("aria-label", "Group name");
  input.spellcheck = false;
  form.appendChild(input);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = renameGroup(loadLinks(), path, input.value);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    saveLinks(result.links);
    // Explicitly created groups follow the rename too.
    saveGroups(renameGroupList(loadGroups(), path, input.value));
    renderDirectory();
    showToast(`Renamed to "${input.value.trim()}".`);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") renderDirectory();
  });
  input.addEventListener("blur", () => {
    // Re-render only if the form is still on screen (a save already re-rendered).
    if (form.isConnected) renderDirectory();
  });
  row.replaceChildren(form);
  input.focus();
  input.select();
}

/**
 * Show an inline "new group" input at the top of the directory: Enter creates
 * the (empty) group, Escape or clicking away cancels.
 */
function startGroupCreate() {
  const form = document.createElement("form");
  form.className = "sl-group-rename sl-group-create";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Team/Frontend";
  input.setAttribute("aria-label", "New group name");
  input.spellcheck = false;
  form.appendChild(input);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const path = normalizeGroup(input.value);
    if (path === "") {
      showToast("Enter a group name.");
      return;
    }
    if (groupTree(loadLinks(), loadGroups()).some((node) => node.path === path)) {
      showToast(`"${path}" already exists.`);
      return;
    }
    saveGroups([...loadGroups(), path]);
    renderDirectory();
    showToast(`Group "${path}" created — add links to it or drag them in.`);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") renderDirectory();
  });
  input.addEventListener("blur", () => {
    if (form.isConnected) renderDirectory();
  });
  els.directory.prepend(form);
  input.focus();
}

/** True when any ancestor group of `path` is collapsed. */
function hasCollapsedAncestor(path, collapsed) {
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    if (collapsed.has(segments.slice(0, i).join("/"))) return true;
  }
  return false;
}

/** The live filter query, restored from and persisted to localStorage. */
let filterQuery = loadFilter();

function renderDirectory() {
  const filtering = filterQuery.trim() !== "";
  const allLinks = loadLinks();
  const links = filterLinks(allLinks, filterQuery);
  // While filtering: declared-but-empty groups and collapse state get out of
  // the way — every match is visible.
  const tree = groupTree(links, filtering ? [] : loadGroups());
  const collapsed = filtering ? new Set() : loadCollapsed();
  const total = Object.keys(links).length;

  els.count.textContent = total === 0 ? "" : `(${total})`;
  els.empty.hidden = total !== 0;
  els.empty.textContent = filtering
    ? "No links match."
    : "No shortlinks yet. Name a URL on the left — it's saved in this browser instantly.";
  els.directory.replaceChildren();
  els.groupList.replaceChildren(
    ...tree.filter((node) => node.path !== "").map((node) => {
      const option = document.createElement("option");
      option.value = node.path;
      return option;
    }),
  );

  const view = loadView();

  renderFrequent(links, filtering, collapsed);

  for (let i = 0; i < tree.length; i++) {
    const { path, label, depth, entries } = tree[i];
    // A leaf has no deeper node right after it in the preorder list.
    const isLeaf = (tree[i + 1]?.depth ?? 0) <= depth;
    if (path !== "" && hasCollapsedAncestor(path, collapsed)) continue;
    const isCollapsed = collapsed.has(path);
    const indent = depth * 16;

    const headRow = document.createElement("div");
    headRow.className = "sl-group-row";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "sl-group";
    head.setAttribute("aria-expanded", String(!isCollapsed));
    head.style.paddingLeft = `${2 + indent}px`;
    const chevron = document.createElement("span");
    chevron.className = "sl-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = isCollapsed ? "▸" : "▾";
    head.appendChild(chevron);
    if (view === "grid") {
      const dot = document.createElement("span");
      dot.className = "sl-dot";
      dot.setAttribute("aria-hidden", "true");
      if (path !== "") {
        dot.classList.add("is-hued");
        dot.style.setProperty("--group-hue", String(hueForText(path)));
      }
      head.appendChild(dot);
    }
    const labelEl = document.createElement("span");
    labelEl.textContent = path === "" ? "Ungrouped" : label;
    head.append(labelEl);
    if (entries.length > 0) {
      const groupCount = document.createElement("span");
      groupCount.className = "sl-count";
      groupCount.textContent = String(entries.length);
      head.appendChild(groupCount);
    }
    headRow.appendChild(head);
    // The whole row is the collapse target (a wide, forgiving hit area); clicks
    // on the per-group action buttons or the inline rename form are excluded so
    // they don't also fold the group.
    headRow.addEventListener("click", (event) => {
      if (event.target.closest(".sl-group-edit, .sl-group-rename")) return;
      const next = loadCollapsed();
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveCollapsed(next);
      renderDirectory();
    });
    if (path !== "") {
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "sl-group-edit";
      rename.textContent = "✎";
      rename.title = "Rename group";
      rename.setAttribute("aria-label", `Rename group ${path}`);
      rename.addEventListener("click", () => startGroupRename(path, headRow));
      headRow.appendChild(rename);
      // Share just this branch (the group and its sub-groups) when it has links.
      if (Object.keys(linksInGroup(allLinks, path)).length > 0) {
        const share = document.createElement("button");
        share.type = "button";
        share.className = "sl-group-edit sl-group-share";
        share.textContent = "↗";
        share.title = "Share group";
        share.setAttribute("aria-label", `Share group ${path}`);
        share.addEventListener("click", () => shareGroup(path));
        headRow.appendChild(share);
      }
      // An empty leaf group only exists by explicit creation — deletable.
      if (entries.length === 0 && isLeaf) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "sl-group-edit sl-group-del";
        del.textContent = "✕";
        del.title = "Remove empty group";
        del.setAttribute("aria-label", `Remove empty group ${path}`);
        del.addEventListener("click", () => {
          saveGroups(loadGroups().filter((group) => normalizeGroup(group) !== path));
          renderDirectory();
          showToast(`Removed group "${path}".`);
        });
        headRow.appendChild(del);
      }
    }
    wireHeaderDrop(headRow, path);
    els.directory.appendChild(headRow);

    if (isCollapsed || entries.length === 0) continue;
    const list = document.createElement("div");
    list.className = view === "grid" ? "sl-grid" : "sl-rows";
    list.style.paddingLeft = `${12 + indent}px`;
    wireContainerDrop(list, path);
    for (const { name, url } of entries) {
      list.appendChild(
        view === "grid" ? renderTile(name, url, path) : renderRow(name, url, path),
      );
    }
    els.directory.appendChild(list);
  }
}

function renderTile(name, url, group, canDrag = true) {
  const tile = document.createElement("div");
  tile.className = "sl-tile";
  // On the tile (not the monogram) so the tile's background tint and the
  // monogram both read the same inherited hue.
  tile.style.setProperty("--tile-hue", String(hueForText(displayHost(url))));
  if (canDrag) wireDrag(tile, name, group, "x");

  const main = document.createElement("a");
  main.className = "sl-tile-main";
  main.href = url;
  main.target = "_blank";
  main.rel = "noopener";
  // Names can be clamped on the tile, so the tooltip carries both in full.
  main.title = `${name}\n${url}`;
  // Dragging anywhere on the tile must drag the tile, not the native link.
  main.draggable = false;
  const mono = document.createElement("span");
  mono.className = "sl-tile-mono";
  mono.setAttribute("aria-hidden", "true");
  mono.textContent = name.charAt(0).toUpperCase();
  const nameEl = document.createElement("span");
  nameEl.className = "sl-tile-name";
  nameEl.textContent = name;
  const host = document.createElement("span");
  host.className = "sl-tile-host";
  host.textContent = displayHost(url);
  main.append(mono, nameEl, host);

  const actions = document.createElement("div");
  actions.className = "sl-tile-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "⧉";
  copy.title = "Copy the shortlink URL";
  copy.setAttribute("aria-label", `Copy shortlink for ${name}`);
  copy.addEventListener("click", () => copyShortlink(name));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "✎";
  edit.title = "Edit name, target or group";
  edit.setAttribute("aria-label", `Edit ${name}`);
  edit.addEventListener("click", () => startEdit(name));
  const del = document.createElement("button");
  del.type = "button";
  del.className = "sl-tile-del";
  del.textContent = "✕";
  del.title = "Delete";
  del.setAttribute("aria-label", `Delete ${name}`);
  del.addEventListener("click", () => deleteLink(name));
  actions.append(copy, edit, del);

  tile.append(main, actions);
  return tile;
}

function renderRow(name, url, group, canDrag = true) {
  const row = document.createElement("div");
  row.className = "sl-row";
  if (canDrag) wireDrag(row, name, group, "y");

  const text = document.createElement("div");
  text.className = "sl-row-text";
  const nameEl = document.createElement("code");
  nameEl.className = "sl-row-name";
  nameEl.textContent = name;
  const urlEl = document.createElement("a");
  urlEl.className = "sl-row-url";
  urlEl.href = url;
  urlEl.target = "_blank";
  urlEl.rel = "noopener";
  urlEl.textContent = url;
  urlEl.title = url;
  // Dragging anywhere on the row must drag the row, not the native link.
  urlEl.draggable = false;
  text.append(nameEl, urlEl);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn btn-small";
  copy.textContent = "Copy link";
  copy.title = "Copy the shortlink URL";
  copy.addEventListener("click", () => copyShortlink(name));

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn btn-small";
  edit.textContent = "Edit";
  edit.title = "Edit name, target or group";
  edit.addEventListener("click", () => startEdit(name));

  const del = document.createElement("button");
  del.type = "button";
  del.className = "sl-del";
  del.setAttribute("aria-label", `Delete ${name}`);
  del.title = "Delete";
  del.textContent = "✕";
  del.addEventListener("click", () => deleteLink(name));

  row.append(text, copy, edit, del);
  return row;
}

/**
 * "Frequently used": the most-visited links as a speed-dial in the sticky right
 * column. Collapsible; hidden while filtering — the directory results are the
 * whole story then, and the layout reclaims the panel's track (see the
 * `.frequent[hidden]` rule in styles.css).
 */
function renderFrequent(links, filtering, collapsed) {
  els.frequent.hidden = filtering;
  els.frequent.replaceChildren();
  if (filtering) return;

  const top = topLinks(links, loadHits(), 5);
  const isCollapsed = collapsed.has(FREQUENT_COLLAPSE_KEY);

  const head = document.createElement("button");
  head.type = "button";
  head.className = "sl-group sl-frequent-head";
  head.setAttribute("aria-expanded", String(!isCollapsed));
  const chevron = document.createElement("span");
  chevron.className = "sl-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = isCollapsed ? "▸" : "▾";
  const label = document.createElement("span");
  label.textContent = "★ Frequently used";
  head.append(chevron, label);
  if (top.length > 0) {
    const count = document.createElement("span");
    count.className = "sl-count";
    count.textContent = String(top.length);
    head.appendChild(count);
  }
  head.addEventListener("click", () => {
    const next = loadCollapsed();
    if (next.has(FREQUENT_COLLAPSE_KEY)) next.delete(FREQUENT_COLLAPSE_KEY);
    else next.add(FREQUENT_COLLAPSE_KEY);
    saveCollapsed(next);
    renderDirectory();
  });
  els.frequent.appendChild(head);

  if (isCollapsed) return;

  if (top.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sl-fav-empty";
    empty.textContent = "Links you open often appear here.";
    els.frequent.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "sl-fav-list";
  for (const { name, url } of top) list.appendChild(renderFavRow(name, url));
  els.frequent.appendChild(list);
}

/**
 * A compact speed-dial row for the Frequently used column: the whole row is a
 * link that opens the target. A host-hued dot and the name identify it; the
 * full name and URL live in the tooltip, since the narrow column has no room
 * for the URL inline.
 */
function renderFavRow(name, url) {
  const row = document.createElement("a");
  row.className = "sl-fav";
  row.href = url;
  row.target = "_blank";
  row.rel = "noopener";
  row.title = `${name}\n${url}`;
  const dot = document.createElement("span");
  dot.className = "sl-dot";
  dot.setAttribute("aria-hidden", "true");
  dot.style.setProperty("--fav-hue", String(hueForText(displayHost(url))));
  const nameEl = document.createElement("code");
  nameEl.className = "sl-fav-name";
  nameEl.textContent = name;
  row.append(dot, nameEl);
  return row;
}

/* ------------------------------ create form ------------------------------ */

/** Grow/shrink the URL textarea to fit its content (min-height via CSS). */
function autosizeUrl() {
  els.url.style.height = "auto";
  // scrollHeight excludes the 1px borders; box-sizing is border-box.
  els.url.style.height = `${els.url.scrollHeight + 2}px`;
}

// Live validation: errors only appear for non-empty input, so an untouched
// form never nags; the preview shows once the name alone is valid.
function syncForm() {
  autosizeUrl();
  const links = loadLinks();
  const name = els.name.value.trim();
  const url = els.url.value.trim();

  // While editing, keeping the link's own name must not read as a duplicate.
  const others = editingName === null ? links : removeLink(links, editingName);
  const validName = validateName(name, others);
  els.nameError.hidden = name === "" || validName.ok;
  if (!validName.ok) els.nameError.textContent = validName.error;

  const validUrl = validateUrl(url);
  els.urlError.hidden = url === "" || validUrl.ok;
  if (!validUrl.ok) els.urlError.textContent = validUrl.error;

  // Warn when this exact target is already saved under another name.
  const twin = validUrl.ok ? findDuplicateTarget(others, validUrl.url) : null;
  els.urlDup.hidden = twin === null;
  if (twin !== null) els.urlDup.textContent = `Already saved as "${twin}".`;

  els.preview.hidden = !validName.ok;
  if (validName.ok) {
    els.previewUrl.textContent = buildShortlinkUrl(location.href, validName.name);
    // A {q} target is a search template — show how #name/foo fills it in.
    const dynamic = validUrl.ok && validUrl.url.includes("{q}");
    els.previewDyn.hidden = !dynamic;
    if (dynamic) {
      const example = resolveDynamic(
        { [validName.name]: { url: validUrl.url } },
        `${validName.name}/foo`,
      );
      els.previewDynExample.textContent = `#${validName.name}/foo → ${example}`;
    }
  } else {
    els.previewDyn.hidden = true;
  }
}

function onCreate(event) {
  event.preventDefault();
  if (editingName !== null) {
    const result = updateLink(loadLinks(), editingName, {
      name: els.name.value,
      url: els.url.value,
      group: els.group.value,
    });
    if (!result.ok) {
      showToast(result.error);
      syncForm();
      return;
    }
    saveLinks(result.links);
    const updated = els.name.value.trim();
    // A rename carries the link's visit count along.
    if (updated !== editingName) {
      const hits = loadHits();
      if (Object.hasOwn(hits, editingName)) {
        hits[updated] = hits[editingName];
        delete hits[editingName];
        saveHits(hits);
      }
    }
    exitEdit();
    renderDirectory();
    showToast(`"${updated}" updated.`);
    return;
  }
  const result = addLink(loadLinks(), els.name.value, els.url.value, els.group.value);
  if (!result.ok) {
    showToast(result.error);
    syncForm();
    return;
  }
  saveLinks(result.links);
  const created = els.name.value.trim();
  els.name.value = "";
  els.url.value = "";
  nameAutofilled = false;
  // The group stays — adding several links to one group is the common flow.
  renderDirectory();
  syncForm();
  els.missBanner.hidden = true;
  showToast(`"${created}" added.`);
  els.name.focus();
}

/* ------------------------------ export/import ---------------------------- */

function onShare() {
  const links = loadLinks();
  const count = Object.keys(links).length;
  if (count === 0) {
    showToast("Nothing to share yet.");
    return;
  }
  const base = location.href.split("#")[0].replace(/index\.html$/, "");
  navigator.clipboard.writeText(`${base}#share=${encodeShare(links)}`).then(
    () =>
      showToast(
        `Share link copied — ${count} link${count === 1 ? "" : "s"} inside; ` +
          "the receiver picks which to import.",
      ),
    () => showToast("Couldn't access the clipboard."),
  );
}

/** Copy a share link carrying just one group's branch (its sub-groups too). */
function shareGroup(path) {
  const subset = linksInGroup(loadLinks(), path);
  const count = Object.keys(subset).length;
  if (count === 0) {
    showToast(`"${path}" has no links to share.`);
    return;
  }
  const base = location.href.split("#")[0].replace(/index\.html$/, "");
  navigator.clipboard.writeText(`${base}#share=${encodeShare(subset)}`).then(
    () =>
      showToast(
        `Share link copied — ${count} link${count === 1 ? "" : "s"} from "${path}"; ` +
          "the receiver picks which to import.",
      ),
    () => showToast("Couldn't access the clipboard."),
  );
}

function onExport() {
  const links = loadLinks();
  if (Object.keys(links).length === 0) {
    showToast("Nothing to export yet.");
    return;
  }
  const blob = new Blob([serializeLinks(links) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "shortlinks.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function onImportFile() {
  const file = els.importFile.files?.[0];
  els.importFile.value = "";
  if (!file) return;
  const text = await file.text();
  // A shortlinks.json starts with "{"; anything else is treated as a browser
  // bookmarks export (the Netscape bookmarks.html format). Both go through the
  // picker so a merge never silently replaces existing links.
  if (text.trimStart().startsWith("{")) {
    const parsed = parseImport(text);
    if (!parsed.ok) {
      showToast(parsed.error);
      return;
    }
    openPicker(linksToCandidates(parsed.links), "json");
    return;
  }
  const parsed = parseBookmarksHtml(text);
  if (!parsed.ok) {
    showToast(parsed.error);
    return;
  }
  openPicker(bookmarksToLinks(parsed.bookmarks, loadLinks()));
}

/** A Links map as picker candidates (no bookmark titles). */
function linksToCandidates(links) {
  return Object.entries(links).map(([name, entry]) => ({
    name,
    title: "",
    url: entry.url,
    group: entry.group ?? "",
    order: entry.order,
  }));
}

/* ----------------------------- bookmark picker ---------------------------- */

// The candidates behind the currently open picker, in render order; each row's
// checkbox lives in `checkboxes` at the same index.
let pickerCandidates = [];
/** What the open picker imports: "bookmark" or (shared) "link" — for wording. */
let pickerNoun = "bookmark";
let pickerCheckboxes = [];

function openPicker(candidates, source = "bookmarks") {
  pickerNoun = source === "bookmarks" ? "bookmark" : "link";
  els.pickerTitle.textContent = source === "bookmarks"
    ? "Import from bookmarks"
    : source === "share"
    ? "Import shared links"
    : "Import shortlinks";
  els.pickerHint.textContent = source === "bookmarks"
    ? "Pick the bookmarks to turn into shortlinks — names come from the titles, folders " +
      "become groups."
    : "Pick which to import — a “replaces” tag marks a name you already have; importing it " +
      "overwrites yours (undo from the toast).";
  // Names already in this browser: candidates keeping one overwrite it on import.
  const existing = loadLinks();
  // Same ordering as the directory: groups A→Z with ungrouped last (stable, so
  // bookmarks keep their file order inside a group).
  pickerCandidates = [...candidates].sort((a, b) =>
    a.group === b.group
      ? 0
      : a.group === ""
      ? 1
      : b.group === ""
      ? -1
      : a.group.localeCompare(b.group)
  );
  candidates = pickerCandidates;
  pickerCheckboxes = [];
  els.pickerList.replaceChildren();

  let lastGroup = null;
  for (const candidate of candidates) {
    if (candidate.group !== lastGroup) {
      lastGroup = candidate.group;
      const head = document.createElement("p");
      head.className = "sl-picker-group";
      head.textContent = candidate.group === "" ? "Ungrouped" : candidate.group;
      els.pickerList.appendChild(head);
    }
    const row = document.createElement("label");
    row.className = "sl-pick-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", syncPickerState);
    const text = document.createElement("span");
    text.className = "sl-row-text";
    const nameEl = document.createElement("code");
    nameEl.className = "sl-row-name";
    nameEl.textContent = candidate.name;
    const urlEl = document.createElement("span");
    urlEl.className = "sl-row-url";
    urlEl.textContent = candidate.title === ""
      ? candidate.url
      : `${candidate.title} — ${candidate.url}`;
    urlEl.title = candidate.url;
    text.append(nameEl, urlEl);
    row.append(checkbox, text);
    if (Object.hasOwn(existing, candidate.name)) {
      const tag = document.createElement("span");
      tag.className = "sl-pick-conflict";
      tag.textContent = "replaces";
      tag.title = `Overwrites the existing "${candidate.name}"`;
      row.appendChild(tag);
    }
    pickerCheckboxes.push(checkbox);
    els.pickerList.appendChild(row);
  }

  els.pickAll.checked = true;
  syncPickerState();
  els.picker.hidden = false;
  els.directory.hidden = true;
  els.empty.hidden = true;
}

function closePicker() {
  els.picker.hidden = true;
  els.directory.hidden = false;
  pickerCandidates = [];
  pickerCheckboxes = [];
  renderDirectory();
}

function syncPickerState() {
  const selected = pickerCheckboxes.filter((checkbox) => checkbox.checked).length;
  els.pickAll.checked = selected === pickerCheckboxes.length;
  els.pickImport.disabled = selected === 0;
  els.pickImport.textContent = `Import selected (${selected})`;
}

function onPickAll() {
  for (const checkbox of pickerCheckboxes) checkbox.checked = els.pickAll.checked;
  syncPickerState();
}

function onPickImport() {
  const chosen = pickerCandidates.filter((_, index) => pickerCheckboxes[index].checked);
  const imported = {};
  for (const { name, url, group, order } of chosen) {
    imported[name] = group === "" ? { url } : { url, group };
    if (typeof order === "number") imported[name].order = order;
  }
  const before = loadLinks();
  const { links, added, replaced } = mergeLinks(before, imported);
  const noun = pickerNoun;
  saveLinks(links);
  closePicker();
  syncForm();
  const message = replaced > 0
    ? `Imported ${added} added, ${replaced} replaced.`
    : `Imported ${added} ${noun}${added === 1 ? "" : "s"}.`;
  showToast(
    message,
    added + replaced === 0 ? undefined : {
      label: "Undo",
      onAction: () => {
        saveLinks(before);
        renderDirectory();
        syncForm();
      },
    },
  );
}

/* --------------------------------- wire ---------------------------------- */

els.form.addEventListener("submit", onCreate);
els.editCancel.addEventListener("click", exitEdit);
// The URL field is a textarea (long URLs wrap into view), but it must behave
// like an input: Enter submits, and pasted line breaks are stripped — a URL
// can't contain them, and wrapped copies from mails/chats often do.
els.url.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    els.form.requestSubmit();
  }
});
els.url.addEventListener("input", () => {
  if (/[\r\n]/.test(els.url.value)) {
    els.url.value = els.url.value.replace(/[\r\n]+/g, "");
  }
  maybeSuggestName();
  syncForm();
});
els.name.addEventListener("input", () => {
  // The user is naming the link themselves — stop mirroring the URL.
  nameAutofilled = false;
  syncForm();
});
els.newGroup.addEventListener("click", startGroupCreate);
els.shareBtn.addEventListener("click", onShare);
els.filter.addEventListener("input", () => {
  filterQuery = els.filter.value;
  saveFilter(filterQuery);
  renderDirectory();
});
els.filter.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && els.filter.value !== "") {
    els.filter.value = "";
    filterQuery = "";
    saveFilter("");
    renderDirectory();
  }
});
els.viewList.addEventListener("click", () => setView("list"));
els.viewGrid.addEventListener("click", () => setView("grid"));
els.exportBtn.addEventListener("click", onExport);
els.importBtn.addEventListener("click", () => els.importFile.click());
els.importFile.addEventListener("change", onImportFile);
els.pickAll.addEventListener("change", onPickAll);
els.pickImport.addEventListener("click", onPickImport);
els.pickCancel.addEventListener("click", closePicker);
addEventListener("hashchange", followHash);

// Every saved shortlink is openable from the palette; the provider function
// re-reads storage each time the palette renders, so the list never goes stale.
registerCommands(() =>
  Object.entries(loadLinks()).map(([name, entry]) => ({
    icon: "🔗",
    title: `Open ${name}`,
    hint: "open",
    keywords: [displayHost(entry.url), entry.group ?? ""],
    run: () => globalThis.open(entry.url, "_blank", "noopener"),
  }))
);

registerCommands([
  {
    icon: "🔗",
    title: "New shortlink",
    hint: "action",
    keywords: ["add", "create", "link", "name"],
    run: () => els.name.focus(),
  },
  {
    icon: "⬇️",
    title: "Export shortlinks",
    hint: "action",
    keywords: ["download", "backup", "json", "file"],
    run: onExport,
  },
  {
    icon: "⬆️",
    title: "Import shortlinks",
    hint: "action",
    keywords: ["upload", "restore", "merge", "json", "file"],
    run: () => els.importFile.click(),
  },
  {
    icon: "📁",
    title: "New group",
    hint: "action",
    keywords: ["folder", "empty", "create", "organize"],
    run: startGroupCreate,
  },
  {
    icon: "🀄",
    title: "Toggle list / grid view",
    hint: "action",
    keywords: ["view", "tiles", "layout", "switch"],
    run: () => setView(loadView() === "grid" ? "list" : "grid"),
  },
]);

els.filter.value = filterQuery;
setView(loadView());
syncForm();
followHash();

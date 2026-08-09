// meso.utilities — Log Analysis: DOM wiring.
//
// All parsing, grouping and filtering lives in `loganalysis.mjs` (and is covered
// by `src/loganalysis.test.ts`); this file only moves data between that module
// and the page. The one non-obvious rule it follows: a group's records are
// rendered when the group is first opened, not when the timeline is drawn. A
// merged set is routinely thousands of records whose bodies include whole PDFs,
// and building all of that up front costs seconds for output nobody has looked
// at yet.

import {
  analyse,
  buildGroups,
  CASE_LABELS,
  contextAround,
  densityBuckets,
  DOSSIER_LABELS,
  facetCounts,
  filterRecords,
  formatMs,
  groupIds,
  LEVELS,
  parseQuery,
  pinnedMarkdown,
  recordSummary,
  recordText,
  restStats,
  shortUrl,
  spanSummary,
} from "./loganalysis.mjs";
import { buildFlow, flowMermaid, INBOUND_LANE } from "./flow.mjs";
import { foldWebhooks } from "./webhooks.mjs";
import { clusterProblems, messageText, parseThrowable, problemIndex } from "./problems.mjs";
import { gunzip, unzipEntries } from "./unzip.mjs";
import { sendHandoff, takeHandoff } from "../handoff.mjs";
import { registerCommands, TOOL_ICONS } from "../palette.js";
import { escapeHtml, highlightJson, makeToast } from "../ui.mjs";

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const els = {
  dropZone: $("drop-zone"),
  /** @type {HTMLInputElement} */ fileInput: /** @type {any} */ ($("file-input")),
  sourceList: $("source-list"),
  parseStatus: $("parse-status"),
  example: $("example"),
  pasteDetails: /** @type {HTMLDetailsElement} */ (/** @type {any} */ ($("paste-details"))),
  /** @type {HTMLTextAreaElement} */ paste: /** @type {any} */ ($("paste")),
  pasteAdd: $("paste-add"),
  clear: $("clear"),
  groupSwitch: $("group-body"),
  /** @type {HTMLInputElement} */ linkAliases: /** @type {any} */ ($("link-aliases")),
  /** @type {HTMLInputElement} */ query: /** @type {any} */ ($("query")),
  /** @type {HTMLInputElement} */ idFind: /** @type {any} */ ($("id-find")),
  idList: $("id-list"),
  levels: $("levels"),
  /** @type {HTMLInputElement} */ restOnly: /** @type {any} */ ($("rest-only")),
  /** @type {HTMLInputElement} */ badOnly: /** @type {any} */ ($("bad-only")),
  /** @type {HTMLInputElement} */ minMs: /** @type {any} */ ($("min-ms")),
  apps: $("apps"),
  categories: $("categories"),
  files: $("files"),
  /** @type {HTMLSelectElement} */ threads: /** @type {any} */ ($("threads")),
  /** @type {HTMLInputElement} */ viewName: /** @type {any} */ ($("view-name")),
  saveView: $("save-view"),
  viewList: $("view-list"),
  /** @type {HTMLInputElement} */ showMeta: /** @type {any} */ ($("show-meta")),
  reset: $("reset"),
  expandAll: $("expand-all"),
  counts: $("counts"),
  copy: $("copy"),
  copyPinned: $("copy-pinned"),
  pinnedTools: $("pinned-tools"),
  download: $("download"),
  downloadPinned: $("download-pinned"),
  sendSanitize: $("send-sanitize"),
  filterPills: $("filter-pills"),
  density: $("density"),
  densityAxis: $("density-axis"),
  overview: $("overview"),
  groups: $("groups"),
  viewSwitch: $("view-switch"),
  viewTitle: $("view-title"),
  restView: $("rest-view"),
  flowView: $("flow-view"),
};

/** Trailing debounce. Filtering re-groups and redraws the whole timeline —
 * per-keystroke on a 50k-record merge that is felt lag, not responsiveness. */
function debounce(fn, wait = 150) {
  let timer = 0;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, wait);
  };
}

const showToast = makeToast($("toast"));

/** Loaded files, in the order they were added — which is the merge tie-break. */
/** @type {{ file: string, text: string, offsetMs?: number }[]} */
let sources = [];
/** @type {ReturnType<typeof analyse>} */
let model = analyse([]);
/** Inbound notifications and webhooks, folded from the merged records.
 *
 * Held beside the model rather than inside `analyse()`: webhooks.mjs imports
 * loganalysis.mjs, so folding them there would make the two circular. Same
 * arrangement problems.mjs already has. */
/** @type {ReturnType<typeof foldWebhooks>} */
let events = [];
/** Groups currently rendered, so the copy button and expand-all can reach them. */
/** @type {ReturnType<typeof buildGroups>} */
let shownGroups = [];
let groupMode = "correlation";

/** Which of the two views the result panel is showing. */
let view = "timeline";
/** Records the timeline last showed, so the counts line survives a view switch. */
let shownCount = 0;

/** Selected facet values. Empty set means "no filter on this facet". */
const selected = {
  /** @type {Set<string>} */ levels: new Set(),
  /** @type {Set<string>} */ apps: new Set(),
  /** @type {Set<string>} */ categories: new Set(),
  /** @type {Set<string>} */ files: new Set(),
  /** @type {Set<string>} */ ids: new Set(),
  /** @type {Set<number>} */ spanIds: new Set(),
  /** @type {Set<number>} */ webhookIds: new Set(),
};

/** The brushed time window, or null. Labels are source timestamps, not
 * reformatted clocks — see {@link clockAt}. */
/** @type {{ fromMs: number, toMs: number, fromText: string, toText: string } | null} */
let windowSel = null;
/**
 * Pinned records, keyed `file\0line` rather than by merge index. The index moves
 * every time a file is added or a clock is shifted — the record does not — and
 * keying on the position meant collecting evidence and then losing the lot the
 * moment the next log off the ticket was dropped in.
 */
/** @type {Set<string>} */
const pinned = new Set();
/** The stable identity of a record, independent of where the merge put it. */
const pinKey = (record) => `${record.file}\0${record.line}`;

/**
 * Throwables, parsed on demand and remembered per merge position. Rows fill
 * lazily per group, so this grows with what has actually been looked at instead
 * of costing a pass over every record at load.
 */
/** @type {Map<number, ReturnType<typeof parseThrowable>>} */
const throwables = new Map();

/**
 * Problem clusters over the whole loaded set, rebuilt once per load.
 *
 * Not per render, and not against the active filters — for the same reason
 * `facetCounts` isn't: a headline that moves as you click turns "5 problems" into
 * a moving target. Problem *grouping* does cluster the filtered set, so the
 * groups answer for the filters while this stays the stable summary.
 */
/** @type {ReturnType<typeof clusterProblems>} */
let problems = [];
/** The current search terms, so lazily-rendered rows can highlight them. */
/** @type {string[]} */
let activeTerms = [];
/** Position of the n/p match cursor within the shown rows, or -1. */
let matchAt = -1;

/* ------------------------------ loading ------------------------------ */

/**
 * Stacked, the sidebar sits above the timeline, so a log that has just been
 * loaded lands below the fold — 1767px of controls below it, before the fields
 * were folded. The result is scrolled to on the load that ends an empty page and
 * on no other: re-parsing after a clock shift or a removed file leaves the reader
 * where they were.
 */
function revealResult(wasEmpty) {
  if (!wasEmpty || model.records.length === 0) return;
  if (!matchMedia("(max-width: 1080px)").matches) return;
  els.groups.closest(".panel")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

/**
 * Size the app and thread columns to the widest value the loaded log holds.
 *
 * Every row is its own grid, so a `max-content` track would be measured per row
 * and the columns would stop lining up down the page — which is most of what
 * makes a merged timeline skimmable. One measurement, handed to every row
 * through a custom property on the container, keeps the column straight *and*
 * lets the whole value show: `ivy immediate job pool-thread-3` is 31 characters
 * against a track that was 132px, so a third of it was ellipsis.
 *
 * Measured over the whole loaded set and not the filtered one, for the reason
 * `facetCounts` and the overview are: a column that resizes as filters are
 * clicked moves every row on the page under the pointer.
 *
 * `ch` is exact here because the row is monospace. The tracks stay
 * `minmax(0, …)` so a window with no room for the full width still degrades to
 * the ellipsis rather than pushing the message out of the panel.
 */
function sizeColumns() {
  let app = 0;
  let thread = 0;
  for (const record of model.records) {
    app = Math.max(app, (record.app || record.file).length);
    thread = Math.max(thread, record.thread.length);
  }
  // Nothing loaded leaves the authored widths in place rather than collapsing
  // both columns to `0ch`.
  /** @param {string} name @param {number} width */
  const setWidth = (name, width) => {
    if (width > 0) els.groups.style.setProperty(name, `${width}ch`);
    else els.groups.style.removeProperty(name);
  };
  setWidth("--la-app-w", app);
  setWidth("--la-thread-w", thread);
}

/** Re-parse everything and redraw. Called whenever the source list changes. */
function reload() {
  const wasEmpty = model.records.length === 0;
  model = analyse(sources);
  // A file that has just gone away must not keep filtering the view.
  for (const value of [...selected.files]) {
    if (!sources.some((source) => source.file === value)) selected.files.delete(value);
  }
  for (const value of [...selected.ids]) {
    if (!model.index.has(value)) selected.ids.delete(value);
  }
  events = foldWebhooks(model.records);
  // Spans and events are both renumbered by the re-fold, so neither filter can
  // survive it.
  selected.spanIds.clear();
  selected.webhookIds.clear();
  // The groups are keyed by this log's dossiers, so a fold state from the previous
  // one names nothing. Reseeded on the next render.
  openIdGroups.clear();
  idGroupsSeeded = false;
  // Pins survive — they name a file and a line, not a merge position — but a pin
  // in a file that has just been removed has nothing left to point at. The
  // window is absolute time, so it needs no reconciling at all.
  for (const key of [...pinned]) {
    const file = key.slice(0, key.indexOf("\0"));
    if (!sources.some((source) => source.file === file)) pinned.delete(key);
  }
  // Keyed by merge position, which just changed.
  throwables.clear();
  problems = clusterProblems(model.records, model.index, model.aliases, {
    link: els.linkAliases.checked,
  });
  updatePinnedUi();
  renderSources();
  renderFacets();
  renderDensity();
  sizeColumns();
  render();
  revealResult(wasEmpty);
}

function renderSources() {
  els.sourceList.innerHTML = "";
  for (const source of sources) {
    const count = model.records.filter((record) => record.file === source.file).length;
    const row = document.createElement("div");
    row.className = "source-row";
    row.innerHTML = `<span class="source-name">${escapeHtml(source.file)}</span>` +
      `<span class="source-count">${count} rec</span>`;
    // Clock offset for the merge — the fix for Ivy logging local time while
    // the pods log UTC. Whole hours cover the team's timezones; displayed
    // timestamps stay exactly as logged.
    const shift = document.createElement("select");
    shift.className = "source-offset";
    shift.title = "Shift this file's clock in the merged timeline — shown times stay as logged";
    shift.setAttribute("aria-label", `Clock offset for ${source.file}`);
    for (let hours = -12; hours <= 12; hours++) {
      const option = document.createElement("option");
      option.value = String(hours);
      option.textContent = hours === 0 ? "±0 h" : `${hours > 0 ? "+" : ""}${hours} h`;
      shift.append(option);
    }
    shift.value = String((source.offsetMs ?? 0) / 3_600_000);
    shift.addEventListener("change", () => {
      source.offsetMs = Number(shift.value) * 3_600_000;
      reload();
    });
    row.append(shift);
    const drop = document.createElement("button");
    drop.type = "button";
    // Shares the saved-view row's delete button, which is the same act on the
    // same kind of row. `chip-x` was never a button style — it tints a span
    // inside Leave's wheel chips, so this rendered as a raw user-agent button.
    drop.className = "source-del";
    drop.title = `Remove ${source.file}`;
    drop.setAttribute("aria-label", `Remove ${source.file}`);
    drop.textContent = "×";
    drop.addEventListener("click", () => {
      sources = sources.filter((entry) => entry.file !== source.file);
      reload();
    });
    row.append(drop);
    els.sourceList.append(row);
  }

  const { summary } = model;
  // Time-only, unless the merge crosses midnight — then "23:59 → 00:12" would
  // hide a day boundary, so the dates come along (sans milliseconds).
  const window = multiDay()
    ? `${summary.fromTs.slice(0, 19)} → ${summary.toTs.slice(0, 19)}`
    : `${summary.fromTs.slice(11)} → ${summary.toTs.slice(11)}`;
  els.parseStatus.textContent = sources.length === 0
    ? "Nothing loaded yet."
    : `${summary.records} records · ${window}` +
      (summary.apps.length ? ` · ${summary.apps.join(", ")}` : "");
}

/** Zip entries worth reading as logs; the rest is skipped with a count. */
const TEXT_ENTRY_RE = /\.(log|txt|out)$/i;

/**
 * One dropped file, as text sources: a `.gz` unpacks to its single log, a
 * `.zip` to every text entry it holds (named `bundle.zip/entry`), anything
 * else is read as-is.
 * @param {File} file
 * @returns {Promise<{ sources: { file: string, text: string }[], skipped: number }>}
 */
async function readSources(file) {
  if (/\.gz$/i.test(file.name)) {
    const bytes = await gunzip(new Uint8Array(await file.arrayBuffer()));
    return {
      sources: [{ file: file.name.replace(/\.gz$/i, ""), text: new TextDecoder().decode(bytes) }],
      skipped: 0,
    };
  }
  if (/\.zip$/i.test(file.name)) {
    const entries = await unzipEntries(new Uint8Array(await file.arrayBuffer()));
    const texts = entries.filter((entry) => TEXT_ENTRY_RE.test(entry.name));
    return {
      sources: texts.map((entry) => ({
        file: `${file.name}/${entry.name}`,
        text: new TextDecoder().decode(entry.bytes),
      })),
      skipped: entries.length - texts.length,
    };
  }
  return { sources: [{ file: file.name, text: await file.text() }], skipped: 0 };
}

/** Add files, skipping ones already loaded under the same name. */
async function addFiles(list) {
  const added = [];
  let skipped = 0;
  for (const file of list) {
    /** @type {{ file: string, text: string }[]} */
    let unpacked;
    try {
      const result = await readSources(file);
      unpacked = result.sources;
      skipped += result.skipped;
    } catch (error) {
      showToast(`Could not read ${file.name} — ${error instanceof Error ? error.message : error}`);
      continue;
    }
    for (const source of unpacked) {
      if (sources.some((entry) => entry.file === source.file)) continue;
      sources.push(source);
      added.push(source.file);
    }
  }
  reload();
  const note = skipped
    ? ` Skipped ${skipped} zip ${skipped === 1 ? "entry" : "entries"} (not .log/.txt/.out).`
    : "";
  if (added.length) {
    showToast(`Added ${added.length} file${added.length === 1 ? "" : "s"}.${note}`);
  } else if (note) {
    showToast(`Nothing to add.${note}`);
  } else {
    showToast("Those files are already loaded.");
  }
}

/** A pasted log gets a numbered name so several pastes stay distinguishable. */
function addPasted(text, name) {
  if (!text.trim()) {
    showToast("Nothing to add — paste a log first.");
    return;
  }
  let file = name ?? "pasted log";
  let n = 2;
  while (sources.some((source) => source.file === file)) file = `${name ?? "pasted log"} ${n++}`;
  sources.push({ file, text });
  reload();
}

/* ------------------------------- facets ------------------------------- */

/**
 * Build one chip group. `counts` comes from the whole parsed set, never the
 * filtered one — see the note on `facetCounts`. A click flips the chip in
 * place rather than rebuilding the list: a rebuild destroys the focused
 * element, which throws a keyboard user back to the top of the page.
 */
function renderChips(host, entries, set, extraClass = "") {
  host.innerHTML = "";
  for (const entry of entries) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip ${extraClass}`.trim();
    if (set.has(entry.value)) chip.classList.add("is-on");
    chip.setAttribute("aria-pressed", String(set.has(entry.value)));
    chip.innerHTML = `${escapeHtml(entry.value)} <span class="chip-count">${entry.count}</span>`;
    chip.addEventListener("click", () => {
      const on = !set.has(entry.value);
      if (on) set.add(entry.value);
      else set.delete(entry.value);
      chip.classList.toggle("is-on", on);
      chip.setAttribute("aria-pressed", String(on));
      render();
    });
    host.append(chip);
  }
  if (entries.length === 0) host.innerHTML = '<span class="hint">None in this log.</span>';
}

function renderFacets() {
  const facets = facetCounts(model.records);
  renderChips(
    els.levels,
    facets.levels,
    selected.levels,
  );
  for (const chip of els.levels.querySelectorAll(".chip")) {
    const level = chip.textContent?.trim().split(" ")[0] ?? "";
    if (LEVELS.includes(level)) chip.classList.add("chip-level", `level-${level.toLowerCase()}`);
  }
  renderChips(els.apps, facets.apps, selected.apps);
  renderChips(els.categories, facets.categories, selected.categories);
  renderChips(els.files, facets.files, selected.files);

  const chosen = els.threads.value;
  els.threads.innerHTML = '<option value="">Any thread</option>';
  for (const entry of facets.threads) {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = `${entry.value} (${entry.count})`;
    els.threads.append(option);
  }
  els.threads.value = facets.threads.some((entry) => entry.value === chosen) ? chosen : "";

  renderIds();
}

/**
 * Which identifier groups are unfolded.
 *
 * Session state, deliberately not `localStorage`: a group is keyed by a dossier
 * id, so persisting the fold would write one key per dossier of every log ever
 * opened and never clean any of them up. Held here instead, so it survives a
 * re-render and a filter keystroke but not a reload.
 * @type {Set<string>}
 */
const openIdGroups = new Set();
/** Whether {@link openIdGroups} has been seeded for the loaded log. */
let idGroupsSeeded = false;

/**
 * One identifier row: the value, what it is called, and how much it explains.
 *
 * `onToggle` lets the row's group update its own selected count. `render()` does
 * not rebuild the facet lists — a rebuild would destroy the focused row — so
 * anything derived from the selection has to be kept in step by hand.
 */
function idRow(facet, onToggle) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "id-row";
  if (selected.ids.has(facet.value)) row.classList.add("is-on");
  row.setAttribute("aria-pressed", String(selected.ids.has(facet.value)));
  const labels = facet.labels.length ? facet.labels.join(", ") : "unlabelled";
  // The per-id file count means nothing while only one file is loaded.
  const files = sources.length > 1
    ? ` · ${facet.files.length} ${facet.files.length === 1 ? "file" : "files"}`
    : "";
  row.innerHTML = `<span class="id-value">${escapeHtml(facet.value)}</span>` +
    `<span class="id-meta"><span class="id-label">${escapeHtml(labels)}</span>` +
    `<span class="id-count">${facet.count} rec${files}</span></span>`;
  row.addEventListener("click", () => {
    // In place, not a rebuild — the rebuild would destroy the focused row.
    const on = !selected.ids.has(facet.value);
    if (on) selected.ids.add(facet.value);
    else selected.ids.delete(facet.value);
    row.classList.toggle("is-on", on);
    row.setAttribute("aria-pressed", String(on));
    onToggle?.();
    render();
  });
  return row;
}

/**
 * The identifiers, grouped by the REST calls that relate them.
 *
 * Folded by their own heading with the chevron at the panel's right edge, per the
 * project's foldable-sections convention — but *not* wearing the sidebar labels'
 * gradient, because these sit one level inside a field body and reading as equal
 * to "Identifiers" above them would flatten the hierarchy.
 *
 * While the filter box has something in it every group with a match is forced
 * open: you are searching, and a hit hidden behind a fold is a hit you cannot
 * see. The fold state is remembered underneath, so clearing the box restores it.
 */
function renderIds() {
  const needle = els.idFind.value.trim().toLowerCase();
  const groups = groupIds(
    model.records,
    model.spans,
    model.index,
    model.aliases,
    els.linkAliases.checked,
    events,
  );
  // The busiest group starts open — one dossier's ids are what a reader came for,
  // and every group folded is a wall of chevrons with nothing to read.
  if (!idGroupsSeeded && groups.length) {
    openIdGroups.add(groups[0].slug);
    idGroupsSeeded = true;
  }

  const hits = (facet) =>
    !needle ||
    facet.value.toLowerCase().includes(needle) ||
    facet.labels.some((label) => label.toLowerCase().includes(needle));

  els.idList.innerHTML = "";
  let shown = 0;
  let total = 0;
  let rendered = 0;

  for (const group of groups) {
    // Selected ids stay listed even when the search box excludes them, so a
    // filter can always be switched off where it was switched on.
    const members = group.ids.filter((facet) => hits(facet) || selected.ids.has(facet.value));
    if (members.length === 0) continue;
    total += members.length;

    const open = needle ? true : openIdGroups.has(group.slug);
    const bodyId = `id-group-${rendered}`;
    rendered++;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "id-group-head";
    head.setAttribute("aria-controls", bodyId);
    head.setAttribute("aria-expanded", String(open));
    const meta = [
      `${members.length} ${plural(members.length, "id")}`,
      group.calls ? `${group.calls} ${plural(group.calls, "call")}` : "",
      group.received ? `${group.received} received` : "",
      group.services.length ? group.services.join(", ") : "",
    ].filter(Boolean).join(" · ");
    head.innerHTML = `<span class="id-group-line">` +
      `<span class="id-group-title">${escapeHtml(group.title)}</span>` +
      `<span class="caret" aria-hidden="true">${open ? "▾" : "▸"}</span></span>` +
      `<span class="id-group-meta"><span>${escapeHtml(meta)}</span>` +
      `<span class="id-group-on" hidden></span></span>`;

    // How many of this group's ids are filtering the view — the one thing worth
    // knowing about a group folded shut, and the reason it is kept in step by
    // hand rather than falling out of a rebuild that never happens.
    const badge = /** @type {HTMLElement} */ (head.querySelector(".id-group-on"));
    const syncBadge = () => {
      const chosen = members.filter((facet) => selected.ids.has(facet.value)).length;
      badge.textContent = chosen ? `${chosen} selected` : "";
      badge.hidden = chosen === 0;
    };
    syncBadge();

    const body = document.createElement("div");
    body.id = bodyId;
    body.className = "id-group-body";
    body.hidden = !open;
    for (const facet of members) {
      // The cap is over the whole list, not per group: a log with three hundred
      // ids spread over ten dossiers is as slow to build as one flat list of them.
      if (shown >= 200) break;
      body.append(idRow(facet, syncBadge));
      shown++;
    }

    head.addEventListener("click", () => {
      // Toggled in place for the same reason a row is: rebuilding would throw
      // focus back to the top of the sidebar.
      const next = body.hidden;
      body.hidden = !next;
      head.setAttribute("aria-expanded", String(next));
      const caret = head.querySelector(".caret");
      if (caret) caret.textContent = next ? "▾" : "▸";
      if (next) openIdGroups.add(group.slug);
      else openIdGroups.delete(group.slug);
    });

    const wrap = document.createElement("div");
    wrap.className = "id-group";
    wrap.append(head, body);
    els.idList.append(wrap);
  }

  if (rendered === 0) {
    els.idList.innerHTML = '<span class="hint">No identifiers found.</span>';
    return;
  }
  if (total > shown) {
    const more = document.createElement("span");
    more.className = "hint";
    more.textContent = `Showing ${shown} of ${total} — type above to narrow.`;
    els.idList.append(more);
  }
}

/* ------------------------------ rendering ------------------------------ */

function currentFilters() {
  const minMs = Number(els.minMs.value);
  return {
    levels: [...selected.levels],
    apps: [...selected.apps],
    categories: [...selected.categories],
    files: [...selected.files],
    threads: els.threads.value ? [els.threads.value] : [],
    ids: [...selected.ids],
    spanIds: [...selected.spanIds],
    webhookIds: [...selected.webhookIds],
    query: els.query.value.trim(),
    restOnly: els.restOnly.checked,
    badOnly: els.badOnly.checked,
    minMs: Number.isFinite(minMs) && minMs > 0 ? minMs : 0,
    fromMs: windowSel ? windowSel.fromMs : null,
    toMs: windowSel ? windowSel.toMs : null,
  };
}

/** `1 record`, `2 records` — the stat labels singularize honestly. */
function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

/**
 * The overview strip: what was loaded, and what is worth looking at. The
 * failed/errors/warnings tiles are buttons that toggle the matching filter —
 * the tile announcing a problem is also the way to it, instead of sending the
 * reader hunting for a checkbox mid-sidebar.
 */
function renderOverview() {
  const { summary } = model;
  if (summary.records === 0) {
    els.overview.hidden = true;
    return;
  }
  els.overview.hidden = false;
  const stat = (label, value, cls = "", act = "") => {
    const inner = `<span class="log-stat-n">${escapeHtml(String(value))}</span>` +
      `<span class="log-stat-l">${escapeHtml(label)}</span>`;
    if (!act) return `<div class="log-stat ${cls}">${inner}</div>`;
    const acts = STAT_ACTIONS[act];
    return `<button type="button" class="log-stat ${cls}" data-act="${act}" ` +
      `aria-pressed="${acts.pressed()}" title="${escapeHtml(acts.title)}">${inner}</button>`;
  };
  els.overview.innerHTML = [
    stat(plural(summary.records, "record"), summary.records),
    stat(plural(summary.files, "file"), summary.files),
    stat("window", formatMs(summary.ms) || "—"),
    stat(plural(summary.restCalls, "REST call"), summary.restCalls),
    summary.restFailed ? stat("REST failed", summary.restFailed, "is-bad", "failed") : "",
    summary.errors ? stat(plural(summary.errors, "error"), summary.errors, "is-bad", "errors") : "",
    summary.warns ? stat(plural(summary.warns, "warning"), summary.warns, "is-warn", "warns") : "",
    // How many *distinct* things went wrong, which is the number the error count
    // never tells you: four hundred ERROR records are routinely five problems.
    problems.length
      ? stat(plural(problems.length, "problem"), problems.length, "", "problems")
      : "",
    problems.length
      ? `<div class="log-worst" title="${escapeHtml(problems[0].message)}">` +
        `worst: <b>×${problems[0].count}</b> ` +
        // A cluster with no throwable has an empty `type`, and an empty string is
        // not nullish — so the fallback has to test truthiness, or the line reads
        // "worst: ×214" with nothing after it.
        `${escapeHtml(problems[0].type ? shortType(problems[0].type) : problems[0].message)}</div>`
      : "",
    summary.slowest
      ? `<div class="log-slowest" title="${escapeHtml(spanSummary(summary.slowest))}">` +
        `slowest: <b>${escapeHtml(formatMs(summary.slowest.ms))}</b> ` +
        `${escapeHtml(summary.slowest.method)} ` +
        `${escapeHtml(shortUrl(summary.slowest.url))}</div>`
      : "",
  ].join("");
}

/** What each actionable overview tile toggles, and how it reads its state. */
const STAT_ACTIONS = {
  failed: {
    title: "Show only failed or unanswered REST calls",
    pressed: () => els.badOnly.checked,
    toggle: () => {
      els.badOnly.checked = !els.badOnly.checked;
    },
  },
  errors: {
    title: "Show only ERROR records",
    pressed: () => selected.levels.has("ERROR"),
    toggle: () => toggleLevel("ERROR"),
  },
  warns: {
    title: "Show only WARN records",
    pressed: () => selected.levels.has("WARN"),
    toggle: () => toggleLevel("WARN"),
  },
  problems: {
    title: "Group the timeline by distinct failure",
    pressed: () => groupMode === "problem",
    // Sets the mode without rendering — the delegated handler below renders once
    // for every tile, and going through the button would render twice.
    toggle: () => setGroup(groupMode === "problem" ? "correlation" : "problem"),
  },
};

function toggleLevel(level) {
  if (selected.levels.has(level)) selected.levels.delete(level);
  else selected.levels.add(level);
}

/**
 * How many records the timeline will open without being asked.
 *
 * Every group opening is what a reader wants and what a filtered view needs, but
 * "every" has to stop somewhere: a group's rows are built when it first opens
 * (that laziness is the reason a large merge is usable at all), so opening an
 * unfiltered fifty-thousand-record log would build every row in one synchronous
 * pass and hang the tab. Groups past this budget stay closed, and **Expand all**
 * — whose label flips to match — opens them deliberately.
 *
 * The number only ever bites unfiltered on a big log: filtering is what makes the
 * shown set small, so the case this protects is the one where nobody has asked
 * for a specific record yet.
 */
const AUTO_OPEN_RECORDS = 3000;

/** True when the loaded window crosses midnight — dates then stop being noise. */
function multiDay() {
  const { summary } = model;
  return summary.records > 0 && summary.fromTs.slice(0, 10) !== summary.toTs.slice(0, 10);
}

function render() {
  const filters = currentFilters();
  activeTerms = parseQuery(filters.query);
  matchAt = -1;
  const kept = filterRecords(model.records, filters, model.spans);
  // Clustered over what is *shown*, unlike the overview's stable headline: the
  // groups have to answer for the filters currently applied. Only in this mode —
  // it is a pass over the records, and the other modes have no use for it.
  const clusters = groupMode === "problem"
    ? problemIndex(clusterProblems(kept, model.index, model.aliases, {
      link: els.linkAliases.checked,
    }))
    : new Map();
  shownGroups = buildGroups(kept, {
    mode: groupMode,
    index: model.index,
    aliases: model.aliases,
    spans: model.spans,
    link: els.linkAliases.checked,
    problems: clusters,
  });

  shownCount = kept.length;
  renderOverview();
  renderPills(filters);
  updateDensityOverlay();
  // Owns the counts line too, since the view decides what it counts.
  applyView();

  els.groups.innerHTML = "";
  if (model.records.length === 0) {
    els.groups.append(emptyState(
      "Drop log files anywhere on this page to begin — or paste a log into the sidebar. " +
        "Everything is parsed in this tab; nothing is uploaded.",
      [
        ["Try with sample log", () => els.example.click()],
        ["Choose files…", () => els.fileInput.click()],
      ],
    ));
    return;
  }
  if (kept.length === 0) {
    // The way back is a button right here, not a pointer to one that may sit
    // two screens up in a folded sidebar field.
    els.groups.append(emptyState(
      "No records match these filters.",
      [["Reset filters", () => els.reset.click()]],
    ));
    return;
  }
  // Every group starts open, on this render and every filtered one after it: a
  // search that narrows to four matches and then leaves three of five groups
  // collapsed is a filter hiding its own results.
  const days = multiDay();
  let budget = AUTO_OPEN_RECORDS;
  let anyClosed = false;
  for (const group of shownGroups) {
    // The budget is spent *after* the test, so the first group always opens —
    // one dominant dossier is the common shape here, and a timeline that opens
    // nothing at all would be worse than a slow one.
    const open = budget > 0;
    budget -= group.records.length;
    if (!open) anyClosed = true;
    els.groups.append(groupEl(group, open, days));
  }
  // Kept honest: with everything already open the button's job is the reverse.
  els.expandAll.textContent = anyClosed ? "Expand all" : "Collapse all";
}

/** The timeline's empty state: a sentence plus the action that ends it. */
function emptyState(text, actions) {
  const wrap = document.createElement("div");
  wrap.className = "hint groups-empty";
  const line = document.createElement("span");
  line.textContent = text;
  wrap.append(line);
  const row = document.createElement("div");
  row.className = "btn-row";
  for (const [label, run] of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-small";
    btn.textContent = label;
    btn.addEventListener("click", run);
    row.append(btn);
  }
  wrap.append(row);
  return wrap;
}

/**
 * One removable pill per active filter, beside the counts they explain — the
 * sidebar holds the controls, but "why am I seeing 4 of 10 records" must be
 * answerable where the records are.
 */
function renderPills(filters) {
  const clip = (text, cap = 26) => text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
  /** @type {{ text: string, full?: string, undo: () => void }[]} */
  const pills = [];
  for (const level of filters.levels) {
    pills.push({ text: level, undo: () => selected.levels.delete(level) });
  }
  for (const app of filters.apps) {
    pills.push({ text: `app ${clip(app)}`, full: app, undo: () => selected.apps.delete(app) });
  }
  for (const cat of filters.categories) {
    pills.push({
      text: `logger ${clip(cat)}`,
      full: cat,
      undo: () => selected.categories.delete(cat),
    });
  }
  for (const file of filters.files) {
    pills.push({ text: `file ${clip(file)}`, full: file, undo: () => selected.files.delete(file) });
  }
  for (const thread of filters.threads) {
    pills.push({
      text: `thread ${clip(thread)}`,
      full: thread,
      undo: () => {
        els.threads.value = "";
      },
    });
  }
  for (const id of filters.ids) {
    pills.push({ text: `id ${clip(id, 14)}`, full: id, undo: () => selected.ids.delete(id) });
  }
  for (const spanId of filters.spanIds) {
    const span = model.spans[spanId];
    if (!span) continue;
    pills.push({
      text: `call ${clip(`${span.method} ${shortUrl(span.url)}`, 28)}`,
      full: spanSummary(span),
      undo: () => selected.spanIds.delete(spanId),
    });
  }
  for (const eventAt of filters.webhookIds) {
    const event = events[eventAt];
    if (!event) continue;
    pills.push({
      text: `received ${clip(event.label, 24)}`,
      full: `${event.label} received by ${event.to}${event.status ? ` — ${event.status}` : ""}`,
      undo: () => selected.webhookIds.delete(eventAt),
    });
  }
  if (filters.query) {
    pills.push({
      text: `search “${clip(filters.query, 18)}”`,
      full: filters.query,
      undo: () => {
        els.query.value = "";
      },
    });
  }
  if (filters.restOnly) {
    pills.push({
      text: "only REST calls",
      undo: () => {
        els.restOnly.checked = false;
      },
    });
  }
  if (filters.badOnly) {
    pills.push({
      text: "failed or unanswered",
      undo: () => {
        els.badOnly.checked = false;
      },
    });
  }
  if (filters.minMs) {
    pills.push({
      text: `slower than ${filters.minMs} ms`,
      undo: () => {
        els.minMs.value = "";
      },
    });
  }
  if (windowSel) {
    pills.push({
      text: `window ${windowSel.fromText} → ${windowSel.toText}`,
      undo: () => {
        windowSel = null;
      },
    });
  }

  els.filterPills.hidden = pills.length === 0;
  els.filterPills.innerHTML = "";
  pills.forEach((entry, index) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "chip is-on";
    pill.setAttribute("aria-label", `Remove filter: ${entry.full ?? entry.text}`);
    if (entry.full) pill.title = entry.full;
    pill.innerHTML = `${escapeHtml(entry.text)}<span class="chip-x-mark" aria-hidden="true">` +
      "×</span>";
    pill.addEventListener("click", () => {
      entry.undo();
      renderFacets();
      render();
      refocusPills(index);
    });
    els.filterPills.append(pill);
  });
  if (pills.length > 1) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "chip";
    clear.textContent = "Reset all";
    clear.addEventListener("click", () => {
      els.reset.click();
      els.groups.focus();
    });
    els.filterPills.append(clear);
  }
}

/** After a pill removal rebuilds the row, keep keyboard focus inside it. */
function refocusPills(index) {
  const remaining = els.filterPills.querySelectorAll("button");
  if (remaining.length === 0) {
    els.groups.focus();
    return;
  }
  /** @type {HTMLElement} */ (remaining[Math.min(index, remaining.length - 1)]).focus();
}

/* --------------------------- the three views --------------------------- */

/**
 * Show the view that is selected, and hide the controls belonging to the others.
 *
 * The density strip and the filter pills are timeline instruments — they brush
 * and explain a set of *records*. The REST table lists calls over the whole
 * loaded log, and the flow diagram answers to the identifier selection alone, so
 * leaving those two on above either would claim a relationship that isn't there.
 */
function applyView() {
  const rest = view === "rest";
  const flow = view === "flow";
  // Built once here so the counts line, the diagram and Copy all describe the
  // same flow. Driven by the identifier selection alone — never `currentFilters`.
  shownFlow = flow ? buildFlow(model.records, model.spans, [...selected.ids], events) : null;
  els.groups.hidden = rest || flow;
  els.restView.hidden = !rest;
  els.flowView.hidden = !flow;
  els.viewTitle.textContent = rest ? "REST calls" : flow ? "Flow" : "Timeline";
  els.density.hidden = rest || flow || strip.length === 0;
  els.densityAxis.hidden = els.density.hidden;
  els.filterPills.hidden = rest || flow || els.filterPills.children.length === 0;
  // Copy and download hand over whatever is on screen, so the labels have to
  // name it. Pointing "Copy shown" at the timeline while a table of calls is
  // what's shown copied the view you are not looking at.
  els.copy.textContent = rest ? "Copy calls" : flow ? "Copy as Mermaid" : "Copy shown";
  els.copy.title = rest
    ? "Copy every REST call as a table"
    : flow
    ? "Copy the flow as Mermaid sequenceDiagram source"
    : "Copy every record currently shown";
  els.download.title = rest
    ? "Download every REST call as a table"
    : flow
    ? "Download the flow as a Mermaid .mmd file"
    : "Download every record currently shown";
  // Counted in the terms of whatever is on screen. "10 of 10 records · 3 groups"
  // above a table of calls describes the view you are not looking at.
  els.counts.textContent = model.records.length === 0
    ? ""
    : rest
    ? `${model.spans.length} ${plural(model.spans.length, "call")} · ` +
      `${model.summary.restFailed} failed or unanswered`
    : flow
    ? flowCounts()
    : `${shownCount} of ${model.records.length} records · ${shownGroups.length} ` +
      `${shownGroups.length === 1 ? "group" : "groups"}`;
  if (rest) renderRestView();
  if (flow) renderFlowView();
}

/** Sort state for the calls table: which accessor, and which direction. */
let restSort = { key: "ms", dir: -1 };

/**
 * The calls table's columns: a key, a heading, and what to sort on. Durations and
 * statuses fall back to -1 rather than being dropped, so an unanswered call sorts
 * to one end instead of scattering through the middle.
 */
/** @type {{ key: string, label: string, read: (span: any) => string | number }[]} */
const REST_COLUMNS = [
  { key: "time", label: "Time", read: (span) => span.tsText },
  { key: "service", label: "Service", read: (span) => span.service },
  { key: "method", label: "Method", read: (span) => span.method },
  { key: "url", label: "URL", read: (span) => span.url },
  { key: "status", label: "Status", read: (span) => span.status ?? -1 },
  { key: "ms", label: "Duration", read: (span) => span.ms ?? -1 },
];

/** The per-service rollup, then every call, sorted by whichever column was picked. */
function renderRestView() {
  els.restView.innerHTML = "";
  if (model.spans.length === 0) {
    els.restView.append(emptyState(
      model.records.length === 0
        ? "Load a log and any REST calls it logged will be listed here."
        : "No REST calls in this log — nothing matched the `Invoking REST service …` shape.",
      model.records.length === 0 ? [["Try with sample log", () => els.example.click()]] : [],
    ));
    return;
  }

  const stats = restStats(model.spans);
  const rollup = document.createElement("table");
  rollup.className = "rest-table rest-rollup";
  rollup.innerHTML = "<caption>Per service</caption><thead><tr>" +
    ["Service", "Calls", "Failed", "No answer", "p50", "p95", "Slowest"]
      .map((head) => `<th scope="col">${head}</th>`).join("") +
    "</tr></thead><tbody>" +
    stats.map((row) =>
      "<tr>" +
      `<td class="rest-service">${escapeHtml(row.service)}</td>` +
      `<td class="rest-n">${row.calls}</td>` +
      `<td class="rest-n${row.failed ? " is-bad" : ""}">${row.failed || "—"}</td>` +
      `<td class="rest-n${row.unanswered ? " is-bad" : ""}">${row.unanswered || "—"}</td>` +
      `<td class="rest-n">${escapeHtml(formatMs(row.p50) || "—")}</td>` +
      `<td class="rest-n">${escapeHtml(formatMs(row.p95) || "—")}</td>` +
      // Tested against `slowest`, not `maxMs`: with every call unanswered maxMs
      // is 0, and `formatMs(0)` is a truthy "0 ms" that would report a hung
      // integration as the fastest thing in the log.
      `<td class="rest-n">${row.slowest ? escapeHtml(formatMs(row.maxMs)) : "—"}</td>` +
      "</tr>"
    ).join("") +
    "</tbody>";
  els.restView.append(rollup);

  const note = document.createElement("p");
  note.className = "hint";
  // Said plainly, because the sidebar is right there and full of filters that
  // look like they ought to apply.
  note.textContent = "Every REST call in the loaded log. The sidebar's filters narrow the " +
    "timeline, not this table — pick a call to take its records back there.";
  els.restView.append(note);

  const column = REST_COLUMNS.find((entry) => entry.key === restSort.key) ?? REST_COLUMNS[0];
  const sorted = [...model.spans].sort((a, b) => {
    const av = column.read(a);
    const bv = column.read(b);
    // Ties fall back to the order the calls were logged in, so a re-sort of
    // equal rows doesn't shuffle them.
    if (av === bv) return a.id - b.id;
    return (av > bv ? 1 : -1) * restSort.dir;
  });

  const table = document.createElement("table");
  table.className = "rest-table rest-calls";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const { key, label } of REST_COLUMNS) {
    const th = document.createElement("th");
    th.scope = "col";
    const on = restSort.key === key;
    th.setAttribute("aria-sort", on ? (restSort.dir === -1 ? "descending" : "ascending") : "none");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `rest-sort${on ? " is-on" : ""}`;
    button.textContent = on ? `${label} ${restSort.dir === -1 ? "↓" : "↑"}` : label;
    button.addEventListener("click", () => {
      // Same column flips direction; a new column starts descending, which is
      // what you want first for every one of them except the clock.
      restSort = on ? { key, dir: restSort.dir * -1 } : { key, dir: key === "time" ? 1 : -1 };
      renderRestView();
    });
    th.append(button);
    headRow.append(th);
  }
  // The Show column has no heading to sort by, but the row still needs the cell.
  headRow.append(document.createElement("th"));
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (const span of sorted) {
    const tr = document.createElement("tr");
    if (!span.complete) tr.classList.add("is-bad");
    else if (!span.ok) tr.classList.add("is-bad");
    tr.innerHTML = `<td class="rest-n">${escapeHtml(span.tsText.slice(11) || "—")}</td>` +
      `<td class="rest-service">${escapeHtml(span.service)}</td>` +
      `<td>${escapeHtml(span.method)}</td>` +
      `<td class="rest-url" title="${escapeHtml(span.url)}">${
        escapeHtml(shortUrl(span.url))
      }</td>` +
      `<td class="rest-n">${span.complete ? span.status ?? "?" : "no answer"}</td>` +
      `<td class="rest-n">${escapeHtml(formatMs(span.ms) || "—")}</td>`;
    const pick = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-ghost btn-small";
    button.textContent = "Show";
    button.title = "Filter the timeline to this call's records";
    button.addEventListener("click", () => {
      selected.spanIds.clear();
      selected.spanIds.add(span.id);
      setView("timeline");
      render();
      showToast(`Filtered to ${span.method} ${shortUrl(span.url)}.`);
    });
    pick.append(button);
    tr.append(pick);
    body.append(tr);
  }
  table.append(body);
  els.restView.append(table);
}

/* ------------------------------ flow view ------------------------------ */

/**
 * The flow diagram's geometry, in pixels.
 *
 * Kept here rather than in `flow.mjs` for the same reason the density strip's
 * sizing is: the module decides what the steps *are*, the view decides how wide
 * a lane is. `step` covers a request arrow and its response, 24px apart.
 */
const FLOW = {
  gutter: 96,
  lane: 200,
  head: 46,
  step: 64,
  padB: 24,
  selfOut: 46,
  barW: 9,
  /** Sideways step for a bar that opens while another is still running. */
  barGap: 11,
  /** A sub-row handling time still has to be visible, so a bar never goes thinner. */
  barMin: 16,
  /** Below this a bar has no room beside it for the finish timestamp. */
  barLabel: 24,
  /** Right margin the finish timestamps need, added only when one is drawn. */
  finPad: 160,
};

/** Lane names run to `document-basket-service`; past this they are cut and the
 * full name lives in the step's tooltip instead. */
const LANE_CHARS = 22;

/** The flow last built, so the counts line, the diagram and Copy agree. */
/** @type {ReturnType<typeof buildFlow> | null} */
let shownFlow = null;

/**
 * How many of a flow's lanes are systems.
 *
 * The inbound lane is a stand-in for whoever pushed a message in from outside
 * these logs, not a system anyone could go and look at, so it is a lane the
 * diagram draws but not a service anything counts. Shared by the counts line and
 * the diagram's accessible name, which otherwise disagree about one number.
 * @param {string[]} participants
 * @returns {number}
 */
function serviceCount(participants) {
  return participants.filter((name) => name !== INBOUND_LANE).length;
}

/** `9 calls · 6 received · 4 services · 2 failed or unanswered`. */
function flowCounts() {
  if (!shownFlow || shownFlow.steps.length === 0) return "";
  const { participants, failed, calls, inbound } = shownFlow;
  const services = serviceCount(participants);
  // Counted apart because they are different findings: an outbound call that
  // failed is this system's problem, an inbound message never handled is a
  // message it dropped.
  return [
    calls ? `${calls} ${plural(calls, "call")}` : "",
    inbound ? `${inbound} received` : "",
    `${services} ${plural(services, "service")}`,
    failed ? `${failed} failed or unanswered` : "",
  ].filter(Boolean).join(" · ");
}

/** Unfold the Identifiers field and put the cursor in its filter box. */
function revealIds() {
  const button = document.querySelector('#controls .field-collapse[aria-controls="ids-body"]');
  if (button instanceof HTMLElement && button.getAttribute("aria-expanded") === "false") {
    button.click();
  }
  els.idFind.focus();
  els.idFind.scrollIntoView({ block: "nearest" });
}

/**
 * Where each handled webhook was still being worked on: an activation bar down
 * the receiver's lifeline, from the row the message arrived on to the moment its
 * `Handled` line landed.
 *
 * The point is what a duration printed on one row cannot show — that the work
 * was still running while later rows happened. In the onboarding logs one webhook
 * takes 13 s, during which the next notification arrives and the next webhook is
 * received; without a bar those read as a tidy sequence rather than as overlap.
 *
 * Rows sit at fixed intervals ordered by time, not scaled to it, so a bar's foot
 * is placed proportionally between the two rows its finish falls between. That
 * puts the end in the right place *relative to the other events*, which is the
 * question being asked. It does mean bar lengths are not to scale with each other
 * — a 1 ms bar and a 13 s bar are not 13000× apart — and scaling the rows to time
 * instead would blow the diagram apart on any log with a quiet stretch in it.
 * @param {import("./flow.mjs").Flow} flow
 */
function flowBars(flow) {
  const { head, step: stepH, barMin } = FLOW;
  const rowY = (n) => head + n * stepH + 30;
  /** @type {{ to: number, top: number, bottom: number, depth: number, at: string }[]} */
  const bars = [];

  flow.steps.forEach((step, n) => {
    if (step.kind !== "webhook" || step.endTs === null || step.ts === null) return;
    // The last row that had already happened when this finished.
    let j = n;
    while (j + 1 < flow.steps.length) {
      const next = flow.steps[j + 1].ts;
      if (next === null || next > step.endTs) break;
      j++;
    }
    let bottom;
    const after = j + 1 < flow.steps.length ? flow.steps[j + 1].ts : null;
    const here = flow.steps[j].ts;
    if (after !== null && here !== null && after > here) {
      const part = (step.endTs - here) / (after - here);
      bottom = rowY(j) + Math.max(0, Math.min(1, part)) * stepH;
    } else {
      // Still in flight when the log ends: the bar runs off the last row rather
      // than stopping neatly on it, which is the honest picture.
      bottom = rowY(flow.steps.length - 1) + stepH * 0.6;
    }
    const top = rowY(n) - 8;
    bars.push({
      to: step.to,
      top,
      bottom: Math.max(bottom, top + barMin),
      depth: 0,
      at: step.endTsText,
    });
  });

  // Nesting: a bar opening on a lane that already has one running steps aside, so
  // two concurrent handlings are two bars rather than one drawn over the other.
  bars.forEach((bar, i) => {
    bar.depth = bars.filter((other, k) =>
      k < i && other.to === bar.to && other.bottom > bar.top
    ).length;
  });
  return bars;
}

/**
 * What a step points back at: a REST span or an inbound event. One attribute or
 * the other, so the click wiring can tell which filter to set from the DOM alone.
 * @param {import("./flow.mjs").FlowStep} step
 * @returns {string}
 */
function stepRef(step) {
  return step.kind === "rest" ? `data-span="${step.spanId}"` : `data-event="${step.eventId}"`;
}

/** How many identifiers a tooltip lists before it stops being a tooltip. */
const TITLE_IDS = 8;

/**
 * How near the top of a tooltip an identifier belongs — the same order the
 * Identifiers sidebar ranks by, so the two agree about what matters: the dossier
 * a call was about, then the case within it, then everything else.
 * @param {string} label
 * @returns {number}
 */
function idRank(label) {
  if (!label) return 3;
  const lower = label.toLowerCase();
  if (DOSSIER_LABELS.some((known) => known.toLowerCase() === lower)) return 0;
  if (CASE_LABELS.some((known) => known.toLowerCase() === lower)) return 1;
  return 2;
}

/**
 * The identifiers written across a step's own records — its request line, its
 * body, and whatever came back.
 *
 * Both sweeps, not just the labelled one. A gateway exchange writes its dossier
 * nowhere but inside `http.uri='…/documents/48dcaa2c-…'`, with no `xxxId=` key in
 * front of it, so only the bare UUID sweep ever sees it — reading `labelled`
 * alone left exactly the calls this exists for with an empty tooltip. A bare
 * value some label already claimed is dropped, so an id written both ways lists
 * once, under the name the log gave it.
 *
 * Deduped on label *and* value, because the same id is normally written on both
 * legs (a dossier posted in the request comes back in the response) and listing
 * it twice would spend the tooltip on nothing; but one label legitimately
 * carries several values in one call, so the label alone is not the key.
 * `sort` is stable, so within a rank the order is the order the log wrote them.
 * @param {number[]} at indices into the merged records
 * @returns {string[]} `label value`, best first, capped
 */
function stepIds(at) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** Values some label named, so the bare sweep does not repeat them. */
  /** @type {Set<string>} */
  const named = new Set();
  /** @type {{ label: string, value: string }[]} */
  const found = [];
  for (const i of at) {
    for (const id of model.records[i]?.labelled ?? []) {
      const key = `${id.label} ${id.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(id);
      named.add(id.value);
    }
  }
  for (const i of at) {
    for (const value of model.records[i]?.ids ?? []) {
      if (named.has(value) || seen.has(value)) continue;
      seen.add(value);
      found.push({ label: "", value });
    }
  }
  found.sort((a, b) => idRank(a.label) - idRank(b.label));
  const lines = found.slice(0, TITLE_IDS).map((id) => `${id.label} ${id.value}`.trim());
  // A response body listing a document per line runs to dozens; say what was cut
  // rather than let the list read as all of them.
  if (found.length > TITLE_IDS) lines.push(`+${found.length - TITLE_IDS} more`);
  return lines;
}

/**
 * What a step's tooltip says: what was called, and which records it concerned.
 *
 * The row already carries the times, the outcome and both ends, and the diagram
 * is read by scanning those — so the tooltip spends itself on the two things the
 * row physically cannot hold. The URL in full, because the label truncates it
 * from the left. Then the identifiers out of this call's own request and
 * response, which is the question a sequence diagram otherwise leaves open:
 * `POST /document-baskets` twice over tells you nothing until you can see that
 * one was for this dossier and one was not.
 *
 * Newline-separated, which browsers render as separate lines in the tooltip.
 * Native `title` rather than a hover card because it is what every other tooltip
 * in this tool uses — the REST table's URLs, the lane headings above these very
 * steps — and a second, prettier mechanism for one diagram would be the odd one
 * out rather than an improvement.
 * @param {import("./flow.mjs").FlowStep} step
 * @returns {string}
 */
function stepTitle(step) {
  const what = step.kind === "rest" ? `${step.method} ${step.url}`.trim() : step.label;
  const source = step.kind === "rest"
    ? (step.spanId === null ? null : model.spans[step.spanId])
    : (step.eventId === null ? null : events[step.eventId]);
  return [what, ...stepIds(source?.records ?? [])].join("\n");
}

/**
 * One step's arrows, labels and hit target.
 *
 * The request is solid and the response dashed, which is the sequence-diagram
 * convention Mermaid also follows. A 2xx return stays in the neutral line colour
 * — only a failure takes `--danger`, because colouring success green as well
 * turns a forty-call flow into a traffic light nobody can scan.
 *
 * A call nothing answered gets a short dotted stub and a note rather than a
 * return arrow: drawing one would claim a response that never came. The stub
 * points back toward the caller, so it never runs off the diagram's edge.
 * @param {import("./flow.mjs").FlowStep} step
 * @param {number} n position in the flow
 * @param {string[]} participants
 * @param {number} width
 * @returns {string}
 */
function flowStepSvg(step, n, participants, width) {
  const { gutter, lane, head, step: stepH, selfOut } = FLOW;
  const cx = (at) => gutter + at * lane + lane / 2;
  const reqY = head + n * stepH + 30;
  const resY = reqY + 24;
  const from = cx(step.from);
  const to = cx(step.to);
  const bad = !step.complete || !step.ok;
  const rowY = head + n * stepH + 4;
  const inbound = step.kind === "webhook";
  const label = `${step.tsText} — ${participants[step.from]} ` +
    `${inbound ? "sent" : "to"} ${participants[step.to]}, ` +
    `${step.label}, ${step.result}. ` +
    `Show ${inbound ? "this message" : "this call"}'s records.`;

  const parts = [
    `<title>${escapeHtml(stepTitle(step))}</title>`,
    bad
      ? `<rect class="flow-band" x="${gutter - 8}" y="${rowY}" width="${
        width - gutter + 8
      }" height="${stepH - 8}" rx="4" />`
      : "",
    `<rect class="flow-hit" x="0" y="${rowY}" width="${width}" height="${stepH - 8}" />`,
    `<text class="flow-ts" x="${gutter - 18}" y="${reqY + 4}" text-anchor="end">${
      escapeHtml(step.tsText.slice(11) || step.tsText)
    }</text>`,
  ];

  if (step.from === step.to) {
    // A service calling itself: a lane cannot arrow to itself, so the request
    // loops out to the right and comes back one row down.
    parts.push(
      `<path class="flow-req" d="M${from} ${reqY} h${selfOut} V${resY} H${from}" ` +
        `marker-end="url(#flow-ah)" />`,
      `<text class="flow-label" x="${from + selfOut + 8}" y="${reqY + 4}">${
        escapeHtml(step.label)
      }</text>`,
      `<text class="flow-result${bad ? " is-bad" : ""}" x="${from + selfOut + 8}" y="${resY + 4}">${
        escapeHtml(step.result)
      }</text>`,
    );
    return `<g class="flow-step flow-${step.kind}${bad ? " is-bad" : ""}" role="button" ` +
      `tabindex="0" ${stepRef(step)} aria-label="${escapeHtml(label)}">${parts.join("")}</g>`;
  }

  const mid = (from + to) / 2;
  parts.push(
    `<line class="flow-req${inbound ? " flow-async" : ""}" x1="${from}" y1="${reqY}" x2="${to}" ` +
      `y2="${reqY}" marker-end="url(#flow-ah${inbound && bad ? "-bad" : ""})" />`,
    `<text class="flow-label" x="${mid}" y="${reqY - 8}" text-anchor="middle">${
      escapeHtml(step.label)
    }</text>`,
  );

  if (inbound) {
    // One arrow, not two: nothing was sent back to the sender. A `Handled` line is
    // the receiver finishing its work, so the outcome — the status carried, the
    // time taken, whether it was ignored — sits under the arrow that delivered it.
    parts.push(
      `<text class="flow-result${bad ? " is-bad" : ""}" x="${mid}" y="${reqY + 15}" ` +
        `text-anchor="middle">${escapeHtml(step.result)}</text>`,
    );
  } else if (step.complete) {
    parts.push(
      `<line class="flow-ret${step.ok ? "" : " is-bad"}" x1="${to}" y1="${resY}" x2="${from}" ` +
        `y2="${resY}" marker-end="url(#flow-ah${step.ok ? "" : "-bad"})" />`,
      `<text class="flow-result${step.ok ? "" : " is-bad"}" x="${mid}" y="${resY - 8}" ` +
        `text-anchor="middle">${escapeHtml(step.result)}</text>`,
    );
  } else {
    const dir = from > to ? 1 : -1;
    const endX = to + dir * 56;
    parts.push(
      `<line class="flow-ret flow-unanswered" x1="${to}" y1="${resY}" x2="${endX}" y2="${resY}" />`,
      `<text class="flow-result is-bad" x="${endX + dir * 8}" y="${resY + 4}" ` +
        `text-anchor="${dir === 1 ? "start" : "end"}">${escapeHtml(step.result)}</text>`,
    );
  }

  return `<g class="flow-step flow-${step.kind}${bad ? " is-bad" : ""}" role="button" ` +
    `tabindex="0" ${stepRef(step)} aria-label="${escapeHtml(label)}">${parts.join("")}</g>`;
}

/**
 * The selected identifiers' calls as a sequence diagram.
 *
 * Three empty states rather than one, because each has a different way out: no
 * log yet, no identifier picked, or an identifier that no REST call mentions.
 * The last is a real answer — it says the integration was never called for this
 * dossier — so it names the timeline's record count instead of looking broken.
 */
function renderFlowView() {
  els.flowView.innerHTML = "";
  if (model.records.length === 0) {
    els.flowView.append(emptyState(
      "Drop log files anywhere on this page to begin — or paste a log into the sidebar.",
      [
        ["Try with sample log", () => els.example.click()],
        ["Choose files…", () => els.fileInput.click()],
      ],
    ));
    return;
  }
  if (selected.ids.size === 0) {
    els.flowView.append(emptyState(
      "Pick an identifier — a dossier or a case id — to trace the messages between services.",
      [["Choose an identifier", revealIds]],
    ));
    return;
  }
  const flow = shownFlow;
  if (!flow || flow.steps.length === 0) {
    const many = selected.ids.size > 1;
    els.flowView.append(emptyState(
      `No REST calls or inbound messages mention ` +
        `${many ? "these identifiers" : "this identifier"}. ` +
        `The timeline still has ${shownCount} ${plural(shownCount, "record")}.`,
      [["Back to the timeline", () => {
        setView("timeline");
        applyView();
      }]],
    ));
    return;
  }

  const { gutter, lane, head, step, padB, barW, barGap, barLabel, finPad } = FLOW;
  const cx = (at) => gutter + at * lane + lane / 2;
  const bars = flowBars(flow);
  const labelled = bars.some((bar) => bar.bottom - bar.top >= barLabel && bar.at);
  // A bar can outlast the final row, and its finish timestamp needs room to the
  // right of the last lane — so the canvas answers to the bars, not only the rows.
  const width = gutter + flow.participants.length * lane + (labelled ? finPad : 0);
  const height = Math.max(
    head + flow.steps.length * step + padB,
    ...bars.map((bar) => bar.bottom + padB),
  );

  const barSvg = bars.map((bar) => {
    const x = cx(bar.to) - barW / 2 + bar.depth * barGap;
    const tall = bar.bottom - bar.top >= barLabel;
    return `<rect class="flow-act" x="${x}" y="${bar.top}" width="${barW}" height="${
      bar.bottom - bar.top
    }" rx="2" />` +
      (tall && bar.at
        ? `<text class="flow-fin" x="${x + barW + 8}" y="${bar.bottom + 4}">${
          escapeHtml(`└ finished ${bar.at.slice(11) || bar.at}`)
        }</text>`
        : "");
  }).join("");

  const lanes = flow.participants.map((name, at) => {
    const x = cx(at);
    const cut = name.length > LANE_CHARS ? `${name.slice(0, LANE_CHARS - 1)}…` : name;
    return `<g><title>${escapeHtml(name)}</title>` +
      `<rect class="flow-lane-box" x="${x - lane / 2 + 10}" y="8" width="${
        lane - 20
      }" height="30" rx="4" />` +
      `<text class="flow-lane" x="${x}" y="27" text-anchor="middle">${escapeHtml(cut)}</text>` +
      `</g>` +
      `<line class="flow-life" x1="${x}" y1="${head}" x2="${x}" y2="${height - padB / 2}" />`;
  });

  // role="group" rather than role="img": every step inside is focusable and
  // carries its own name, so the steps *are* the accessible reading of the
  // diagram — there is no second hidden list to drift out of step with it.
  const svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="group" aria-label="${
      escapeHtml(
        `Service call flow: ${flow.total} ${plural(flow.total, "call")} across ` +
          `${serviceCount(flow.participants)} ` +
          `${plural(serviceCount(flow.participants), "service")}, ` +
          `${flow.failed} failed or unanswered.`,
      )
    }">` +
    `<defs>` +
    `<marker id="flow-ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" ` +
    `orient="auto"><path d="M0 0 L8 4 L0 8 z" /></marker>` +
    `<marker id="flow-ah-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" ` +
    `markerHeight="7" orient="auto"><path class="is-bad" d="M0 0 L8 4 L0 8 z" /></marker>` +
    `</defs>` +
    lanes.join("") +
    // Behind the arrows: a bar is the background a step is drawn on, and an
    // arrowhead landing on one has to stay readable.
    barSvg +
    flow.steps.map((s, n) => flowStepSvg(s, n, flow.participants, width)).join("") +
    `</svg>`;

  const scroll = document.createElement("div");
  scroll.className = "flow-scroll";
  scroll.innerHTML = svg;
  els.flowView.append(scroll);

  // Both filters are cleared either way: picking a step means "show me this one",
  // and leaving the other kind's filter set would narrow to their intersection,
  // which is always empty.
  const jump = (node) => {
    const spanAt = node.getAttribute("data-span");
    const eventAt = node.getAttribute("data-event");
    selected.spanIds.clear();
    selected.webhookIds.clear();
    if (spanAt !== null) {
      const span = model.spans[Number(spanAt)];
      if (!span) return;
      selected.spanIds.add(Number(spanAt));
      setView("timeline");
      render();
      showToast(`Filtered to ${span.method} ${shortUrl(span.url)}.`);
      return;
    }
    const event = events[Number(eventAt)];
    if (!event) return;
    selected.webhookIds.add(Number(eventAt));
    setView("timeline");
    render();
    showToast(`Filtered to ${event.label} received by ${event.to}.`);
  };
  for (const node of scroll.querySelectorAll("[data-span], [data-event]")) {
    node.addEventListener("click", () => jump(node));
    node.addEventListener("keydown", (keyed) => {
      const key = /** @type {KeyboardEvent} */ (keyed).key;
      if (key !== "Enter" && key !== " ") return;
      keyed.preventDefault();
      jump(node);
    });
  }

  const legend = document.createElement("p");
  legend.className = "hint flow-legend";
  legend.textContent = flow.truncated
    ? `Showing the first ${flow.steps.length} of ${flow.total} messages — ` +
      `${flow.truncated} not drawn. Narrow the identifier selection to see the rest.`
    : "Solid is a request, dashed its response; a dotted arrow is a message received, " +
      "and the bar beneath one is how long its receiver was still working on it. " +
      "Pick any of them to filter the timeline to it.";
  els.flowView.append(legend);
}

/** Switch view, keeping the button row in step. Does not render. */
function setView(next) {
  view = next;
  for (const button of els.viewSwitch.querySelectorAll("[data-view]")) {
    const on = button.getAttribute("data-view") === next;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-pressed", String(on));
  }
}

/** Switch grouping, keeping the button row in step. Does not render. */
function setGroup(mode) {
  groupMode = mode;
  for (const button of els.groupSwitch.querySelectorAll("[data-group]")) {
    const on = button.getAttribute("data-group") === mode;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-pressed", String(on));
  }
}

/* --------------------------- density brush --------------------------- */

/** The strip's buckets and time axis, rebuilt when the sources change. */
/** @type {ReturnType<typeof densityBuckets>} */
let strip = [];
/** @type {HTMLElement | null} */
let stripOverlay = null;
/** Swallows the click that follows a completed drag on the strip. */
let justBrushed = false;

/**
 * A window edge, labelled with a logged timestamp — source text, never a
 * reformatted clock that could disagree with the rows. The start edge names
 * the first record at-or-after it, the end edge the last record at-or-before:
 * the records the window actually contains.
 * @param {number} ms
 * @param {"start" | "end"} [edge]
 */
function clockAt(ms, edge = "start") {
  let text = "";
  for (const record of model.records) {
    if (record.ts === null) continue;
    if (record.ts >= ms) {
      // First record inside the window; the end edge only takes it as a
      // fallback when nothing sat before it.
      if (edge === "start" || !text) text = record.tsText;
      break;
    }
    text = record.tsText;
  }
  return multiDay() ? text.slice(5) : text.slice(11);
}

/**
 * One bar per time slice over the whole loaded set; errors tint their slice.
 *
 * The eighty bars are one tab stop between them, not eighty. Each is still a
 * button — that is what gives the keyboard the same power the drag gives the
 * pointer — but only one is in the tab order at a time and the arrow keys move
 * between them, which is the roving-tabindex pattern a radio group uses. Left as
 * eighty stops they were 80 of the page's 156 focusable elements: tabbing from
 * the panel head to the first record meant eighty presses across bars 3px wide.
 */
function renderDensity() {
  strip = densityBuckets(model.records, 80);
  els.density.hidden = strip.length === 0;
  els.densityAxis.hidden = strip.length === 0;
  els.density.innerHTML = "";
  stripOverlay = null;
  if (strip.length === 0) {
    els.densityAxis.innerHTML = "";
    return;
  }
  const top = Math.max(...strip.map((bucket) => bucket.count));
  for (const bucket of strip) {
    const bar = document.createElement("button");
    bar.type = "button";
    // Only the first bar answers Tab; the rest are reached with the arrow keys
    // below, which hand the -1 on as focus moves.
    bar.tabIndex = els.density.children.length === 0 ? 0 : -1;
    bar.className = "density-bar";
    if (bucket.errors) bar.classList.add("is-err");
    else if (bucket.warns) bar.classList.add("is-warn");
    const height = bucket.count === 0 ? 2 : Math.max(3, Math.round((bucket.count / top) * 26));
    bar.style.height = `${height}px`;
    const troubles = [
      bucket.errors ? `${bucket.errors} ${bucket.errors === 1 ? "error" : "errors"}` : "",
      bucket.warns ? `${bucket.warns} ${bucket.warns === 1 ? "warning" : "warnings"}` : "",
    ].filter(Boolean).join(", ");
    // An empty slice has no record to borrow a timestamp from — don't label it
    // with a neighbour's clock.
    const label = bucket.count === 0
      ? "Empty slice. Filter to this range."
      : `${clockAt(bucket.fromMs)} — ${bucket.count} ${bucket.count === 1 ? "record" : "records"}${
        troubles ? ` (${troubles})` : ""
      }. Filter to this slice.`;
    bar.title = label;
    bar.setAttribute("aria-label", label);
    bar.addEventListener("click", () => {
      if (justBrushed) return;
      setWindow(bucket.fromMs, bucket.toMs);
    });
    els.density.append(bar);
  }
  stripOverlay = document.createElement("div");
  stripOverlay.className = "density-sel";
  stripOverlay.hidden = true;
  els.density.append(stripOverlay);
  // The axis: what window the strip covers, which nothing said before. Source
  // timestamps via clockAt, like the brush's own pill labels — a reformatted
  // clock here could disagree with the rows underneath.
  const mid = strip[0].fromMs + (strip[strip.length - 1].toMs - strip[0].fromMs) / 2;
  els.densityAxis.innerHTML = [
    clockAt(strip[0].fromMs),
    clockAt(mid),
    clockAt(strip[strip.length - 1].toMs, "end"),
  ].map((text) => `<span>${escapeHtml(text)}</span>`).join("");
  updateDensityOverlay();
}

/**
 * Arrow keys across the strip, since only one bar is in the tab order.
 *
 * Focus moves and the roving `tabindex` moves with it, so tabbing away and back
 * returns to the bar last looked at rather than to the start. Enter and Space are
 * left alone: the bars are real buttons, so those already click them.
 */
els.density.addEventListener("keydown", (event) => {
  const keys = { ArrowLeft: -1, ArrowRight: 1, Home: "first", End: "last" };
  const move = keys[event.key];
  if (move === undefined) return;
  const bars =
    /** @type {HTMLButtonElement[]} */ ([...els.density.querySelectorAll(".density-bar")]);
  if (bars.length === 0) return;
  const at = bars.indexOf(/** @type {any} */ (document.activeElement));
  const next = move === "first"
    ? 0
    : move === "last"
    ? bars.length - 1
    : Math.min(bars.length - 1, Math.max(0, (at === -1 ? 0 : at) + move));
  event.preventDefault();
  for (const bar of bars) bar.tabIndex = -1;
  bars[next].tabIndex = 0;
  bars[next].focus();
});

/** Paint the selected window onto the strip (or hide the overlay). */
function updateDensityOverlay() {
  if (!stripOverlay || strip.length === 0) return;
  if (!windowSel) {
    stripOverlay.hidden = true;
    return;
  }
  const min = strip[0].fromMs;
  const max = strip[strip.length - 1].toMs;
  const left = Math.max(0, ((windowSel.fromMs - min) / (max - min)) * 100);
  const right = Math.min(100, ((windowSel.toMs - min) / (max - min)) * 100);
  stripOverlay.hidden = false;
  stripOverlay.style.left = `${left}%`;
  stripOverlay.style.width = `${Math.max(0.5, right - left)}%`;
}

/** Apply a brushed window and redraw. */
function setWindow(fromMs, toMs) {
  windowSel = { fromMs, toMs, fromText: clockAt(fromMs), toText: clockAt(toMs, "end") };
  render();
}

/** @param {number} x viewport x → milliseconds along the strip's axis */
function stripMs(x) {
  const rect = els.density.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
  const min = strip[0].fromMs;
  const max = strip[strip.length - 1].toMs;
  return min + frac * (max - min);
}

/** @type {{ startX: number, moved: boolean } | null} */
let brushing = null;
els.density.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || strip.length === 0) return;
  brushing = { startX: event.clientX, moved: false };
  try {
    els.density.setPointerCapture(event.pointerId);
  } catch {
    /* an already-released pointer; the drag still tracks via the listeners */
  }
});
els.density.addEventListener("pointermove", (event) => {
  if (!brushing || !stripOverlay) return;
  if (Math.abs(event.clientX - brushing.startX) > 4) brushing.moved = true;
  if (!brushing.moved) return;
  const rect = els.density.getBoundingClientRect();
  const a = Math.min(brushing.startX, event.clientX);
  const b = Math.max(brushing.startX, event.clientX);
  stripOverlay.hidden = false;
  stripOverlay.style.left = `${Math.max(0, ((a - rect.left) / rect.width) * 100)}%`;
  stripOverlay.style.width = `${Math.min(100, ((b - a) / rect.width) * 100)}%`;
});
els.density.addEventListener("pointerup", (event) => {
  if (!brushing) return;
  const { startX, moved } = brushing;
  brushing = null;
  if (!moved) return; // a plain click — the bar's own handler zooms to it
  // The click event that follows this pointerup would zoom to one bar and
  // clobber the drag; swallow exactly that one.
  justBrushed = true;
  setTimeout(() => {
    justBrushed = false;
  }, 0);
  const a = Math.min(startX, event.clientX);
  const b = Math.max(startX, event.clientX);
  setWindow(stripMs(a), stripMs(b));
});

/* ------------------------- match highlighting ------------------------- */

/**
 * Wrap every occurrence of the active terms in `<mark>`, walking text nodes so
 * the JSON tinting and the escaping stay untouched — string surgery on HTML
 * would happily match inside a tag or an entity.
 * @param {HTMLElement | null} root
 */
function markTerms(root) {
  if (!root || activeTerms.length === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  /** @type {Text[]} */
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(/** @type {Text} */ (node));
  for (const text of nodes) {
    const value = text.nodeValue ?? "";
    const lower = value.toLowerCase();
    /** @type {(Text | HTMLElement)[]} */
    const parts = [];
    let at = 0;
    while (at < value.length) {
      let hit = -1;
      let term = "";
      for (const needle of activeTerms) {
        const found = lower.indexOf(needle, at);
        if (found !== -1 && (hit === -1 || found < hit)) {
          hit = found;
          term = needle;
        }
      }
      if (hit === -1) break;
      parts.push(document.createTextNode(value.slice(at, hit)));
      const mark = document.createElement("mark");
      mark.textContent = value.slice(hit, hit + term.length);
      parts.push(mark);
      at = hit + term.length;
    }
    if (parts.length === 0) continue;
    parts.push(document.createTextNode(value.slice(at)));
    text.replaceWith(...parts);
  }
}

/**
 * Hop to the next/previous matching row. With a query active every shown row
 * is a match (non-matches are filtered out), so this walks the shown records
 * in timeline order, opening their group as it lands.
 * @param {1 | -1} dir
 */
function jumpMatch(dir) {
  const counts = shownGroups.map((group) => group.records.length);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return;
  matchAt = (matchAt + dir + total) % total;
  let remaining = matchAt;
  let groupIndex = 0;
  while (remaining >= counts[groupIndex]) {
    remaining -= counts[groupIndex];
    groupIndex++;
  }
  const wrap = els.groups.children[groupIndex];
  if (!wrap) return;
  const group = /** @type {HTMLDetailsElement | null} */ (wrap.querySelector("details.log-group"));
  if (group) group.open = true;
  const summary = wrap.querySelectorAll(".log-entry > summary")[remaining];
  if (summary instanceof HTMLElement) {
    summary.scrollIntoView({ block: "center" });
    summary.focus();
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "n" && event.key !== "p") return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [contenteditable]")
  ) return;
  if (activeTerms.length === 0) return;
  event.preventDefault();
  jumpMatch(event.key === "n" ? 1 : -1);
});

/** Why a record can land outside every group, in the current mode's terms. */
const UNATTRIBUTED_HINTS = {
  correlation: "Records that mention no dossier or case id",
  request: "Records whose MDC names no requestId",
  thread: "Records that name no thread",
  rest: "Records that are not part of a REST call",
  problem: "Records that are neither errors nor warnings",
};

/**
 * One collapsible group. `<details>` carries the open/closed state so keyboard
 * and find-in-page behaviour come for free; the body is filled on first open.
 * `days` — the loaded window spans more than one day, so the header time keeps
 * its date.
 */
function groupEl(group, open, days) {
  // The wrapper exists for the toggle-all button further down, which has to sit
  // inside the group's box but outside the fold — see the comment there.
  const wrap = document.createElement("div");
  wrap.className = "log-group-wrap";
  const details = document.createElement("details");
  details.className = "log-group";
  details.open = open;

  // `.chip` carries the pill shape; chip-bad / chip-warn / chip-ok only tint it.
  const badges = [
    group.errors
      ? `<span class="chip chip-bad">${group.errors} ${plural(group.errors, "error")}</span>`
      : "",
    group.warns
      ? `<span class="chip chip-warn">${group.warns} ${plural(group.warns, "warn")}</span>`
      : "",
    group.apps.length > 1 ? `<span class="chip chip-ok">${group.apps.length} apps</span>` : "",
    group.files.length > 1 ? `<span class="chip chip-ok">${group.files.length} files</span>` : "",
    // No badge for a flagged pause: the divider drawn between the two records it
    // separates says it in place, which is where the reader can act on it.
  ].filter(Boolean).join("");

  const summary = document.createElement("summary");
  if (group.label === "Unattributed" && UNATTRIBUTED_HINTS[groupMode]) {
    summary.title = UNATTRIBUTED_HINTS[groupMode];
  }
  summary.innerHTML = `<span class="log-group-label">${escapeHtml(group.label)}</span>` +
    (group.sublabels.length
      ? `<span class="log-group-sub">${escapeHtml(group.sublabels.join(", "))}</span>`
      : "") +
    `<span class="log-group-meta">${badges}` +
    `<span class="log-group-n">${group.records.length} rec</span>` +
    // A single-record group covers no time; "0 ms" there is noise, not a fact.
    (group.ms ? `<span class="log-group-ms">${formatMs(group.ms)}</span>` : "") +
    `<span class="log-group-time">` +
    `${escapeHtml(days ? group.fromTs.slice(5) : group.fromTs.slice(11))}</span></span>`;
  details.append(summary);

  const body = document.createElement("div");
  body.className = "log-rows";
  details.append(body);
  wrap.append(details);

  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    const first = group.records[0].ts;
    const flagged = new Set(group.gapFlagged);
    group.records.forEach((record, at) => {
      // The pause gets its own row between the two it separates: it *is* the
      // finding, and a seventh column in the row grid is not where anyone looks.
      if (flagged.has(at)) body.append(gapEl(record, group.records[at - 1]));
      body.append(rowEl(record, first));
    });
  };
  if (open) fill();
  details.addEventListener("toggle", () => {
    if (details.open) fill();
  });

  // Open or close the full text of every record in this group — the per-group
  // counterpart to Expand all, which works on the groups themselves. Offered only
  // where there is more than one record for it to act on.
  //
  // It belongs to the header row but is a sibling of the `<details>`, not a child,
  // and the stylesheet floats it into place. Inside the `<summary>` it is a control
  // nested in a control, which Chrome reports and which keyboard and screen-reader
  // users get inconsistently; anywhere else inside the `<details>` it would vanish
  // whenever the group is closed, since a closed one renders none of its children —
  // absolutely positioned ones included.
  if (group.records.length > 1) {
    /** The record rows, skipping the gap dividers that sit between them. */
    const rows = () => /** @type {HTMLDetailsElement[]} */ ([...body.children].filter((el) =>
      el.classList.contains("log-entry")
    ));
    const toggleAll = document.createElement("button");
    toggleAll.type = "button";
    toggleAll.className = "log-group-btn";
    const paint = () => {
      const closed = rows().some((row) =>
        !row.open
      );
      // The chevron carries the state, as everywhere else here; the accessible
      // name has to say it in words, since "▸ details" read aloud is a shape.
      toggleAll.textContent = closed ? "▸ details" : "▾ details";
      const label = closed
        ? "Open the full text of every record in this group"
        : "Close every record in this group";
      toggleAll.title = label;
      toggleAll.setAttribute("aria-label", label);
    };
    toggleAll.addEventListener("click", () => {
      // Expanding a closed group's records has to open (and fill) the group
      // first, or there would be no rows to act on.
      details.open = true;
      fill();
      const closed = rows().some((row) => !row.open);
      for (const row of rows()) row.open = closed;
      paint();
    });
    // `toggle` does not bubble, but it does still travel the capture phase — so
    // this one listener keeps the label honest as rows are opened one at a time.
    body.addEventListener("toggle", paint, true);
    paint();
    wrap.append(toggleAll);
  }
  return wrap;
}

/** A pause in the sequence, drawn between the two records it separates. */
function gapEl(record, previous) {
  const row = document.createElement("div");
  row.className = "log-gap";
  const ms = (record.ts ?? 0) - (previous?.ts ?? 0);
  row.innerHTML = `<span class="log-gap-mark" aria-hidden="true">⤓</span>` +
    `<span>${escapeHtml(formatMs(ms))} passed here</span>`;
  return row;
}

/** A throwable parsed once and remembered — see {@link throwables}. */
function throwableOf(record) {
  if (!throwables.has(record.i)) {
    throwables.set(record.i, parseThrowable(messageText(record)));
  }
  return throwables.get(record.i);
}

/** `java.sql.SQLException` → `SQLException`: the package only costs row width. */
function shortType(type) {
  return type.split(".").pop() ?? type;
}

/**
 * A throwable as one line: the type that noticed, and — when something else
 * actually broke — the root cause after an arrow.
 */
function throwableLine(throwable) {
  const label = (link) =>
    link.message ? `${shortType(link.type)}: ${link.message}` : shortType(link.type);
  if (throwable.causes.length === 0) return label(throwable);
  return `${label(throwable)} ← ${label(throwable.rootCause)}`;
}

/** One record: a clickable one-line summary that opens the full text. */
function rowEl(record, groupStart) {
  const row = document.createElement("details");
  // Not `.log-row`: that class is Sanitize's log view, where it is a grid with a
  // line-number gutter — inheriting it turns this <details> into a grid and its
  // body is then sized by content, which overflows the panel sideways.
  row.className = "log-entry";
  const span = record.span === -1 ? null : model.spans[record.span];
  if (span) row.classList.add("has-span");
  if (span && span.complete && !span.ok) row.classList.add("is-bad");
  if (span && !span.complete) row.classList.add("is-bad");

  const delta = record.ts !== null && groupStart !== null && record.ts !== groupStart
    ? `+${formatMs(record.ts - groupStart)}`
    : "";
  // A span's head line reads better as the call it makes than as its raw text.
  // The host is dropped and the path capped, because the row truncates at the
  // panel edge and the outcome — the status and the duration — is the part worth
  // keeping. `spanSummary` keeps the full URL for the roomier group header.
  const isSpanHead = span !== null && span.records[0] === record.i;
  // A failing record's first body line is the sixty-frame stack trace's opening
  // frame, which tells the reader nothing. The throwable does. Restricted to the
  // failing levels: elsewhere a dotted capitalised name on its own line is far
  // more likely to be a Java dump than something thrown.
  const throwable = record.level === "ERROR" || record.level === "WARN"
    ? throwableOf(record)
    : null;
  const text = isSpanHead
    ? `${span.method} ${shortUrl(span.url)} → ` +
      `${span.complete ? span.status ?? "?" : "no response"}` +
      `${span.ms === null ? "" : ` · ${formatMs(span.ms)}`}`
    : throwable
    ? throwableLine(throwable)
    : recordSummary(record);

  if (pinned.has(pinKey(record))) row.classList.add("is-pinned");
  // Its merge position, so a context pass can tell which neighbours this group
  // is already showing and not draw them twice.
  row.dataset.i = String(record.i);
  const summary = document.createElement("summary");
  summary.innerHTML =
    `<span class="log-time">${escapeHtml(record.tsText.slice(11) || "—")}</span>` +
    `<span class="log-delta">${escapeHtml(delta)}</span>` +
    `<span class="log-level level-${(record.level ?? "none").toLowerCase()}">` +
    `${escapeHtml(record.level ?? "—")}</span>` +
    `<span class="log-app">${escapeHtml(record.app || record.file)}</span>` +
    `<span class="log-thread">${escapeHtml(record.thread)}</span>` +
    `<span class="log-msg">${escapeHtml(text)}</span>`;
  markTerms(/** @type {HTMLElement | null} */ (summary.querySelector(".log-msg")));
  row.append(summary);

  const detail = document.createElement("div");
  detail.className = "log-detail";
  let filled = false;
  row.addEventListener("toggle", () => {
    if (!row.open || filled) return;
    filled = true;
    detail.append(detailEl(record, row));
  });
  row.append(detail);
  return row;
}

/** One identifier as a filter chip — used by the ids row and the MDC table. */
function idChip(value) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip chip-add";
  chip.title = `Filter the timeline by ${value}`;
  chip.textContent = value;
  chip.addEventListener("click", () => {
    selected.ids.add(value);
    renderIds();
    render();
    showToast(`Filtering by ${value}.`);
  });
  return chip;
}

/**
 * Put the records either side of this one into the group's own row list.
 *
 * Siblings rather than a nested block, so the result still reads as one
 * chronological column. Some of the neighbours will belong to other dossiers —
 * they come from the unfiltered merge — so they are dimmed and tagged rather than
 * passed off as members of the group they land in. Records the group is already
 * showing are skipped; the same row twice is worse than a gap.
 * @param {HTMLElement} row the record's own `<details>`
 * @param {import("./loganalysis.mjs").LogRecord} record
 * @param {number} span how many to take on each side, 0 to clear
 */
function showContext(row, record, span) {
  const parent = row.parentElement;
  if (!parent) return;
  for (const stale of parent.querySelectorAll(`[data-context="${record.i}"]`)) stale.remove();
  if (span <= 0) return;

  const shown = new Set(
    [...parent.querySelectorAll(".log-entry:not(.is-context)")].map((el) =>
      /** @type {HTMLElement} */ (el).dataset.i
    ),
  );
  /** @param {import("./loganalysis.mjs").LogRecord} neighbour */
  const contextRow = (neighbour) => {
    // No group start: a delta measured against a group this record is not in
    // would be a number about nothing.
    const el = rowEl(neighbour, null);
    el.classList.add("is-context");
    el.dataset.context = String(record.i);
    return el;
  };
  const fresh = (list) => list.filter((entry) => !shown.has(String(entry.i)));

  const { before, after } = contextAround(model.records, record.i, span);
  for (const neighbour of fresh(before)) parent.insertBefore(contextRow(neighbour), row);
  // Reversed, so inserting each one directly after the row leaves them in order.
  for (const neighbour of fresh(after).reverse()) {
    parent.insertBefore(contextRow(neighbour), row.nextSibling);
  }
}

/**
 * A block inside an expanded record that starts folded.
 *
 * Native `<details>` rather than the sidebar's `setupCollapse`: there is one of
 * these per record, so a fold key per block would be unbounded, and the state is a
 * glance at one record rather than a preference that should outlive it. Folded to
 * begin with because expanding a record is a request to read its text — the MDC
 * table and the identifier chips are lookups you go to on purpose.
 * @param {string} label
 * @param {HTMLElement} body
 */
function foldEl(label, body) {
  const fold = document.createElement("details");
  fold.className = "log-fold";
  const summary = document.createElement("summary");
  summary.textContent = label;
  fold.append(summary, body);
  return fold;
}

/**
 * The full record: its MDC as a table, then the raw text with JSON tinted.
 * `row` is the record's `<details>`, so pinning can tint it in place.
 * @param {import("./loganalysis.mjs").LogRecord} record
 * @param {HTMLElement} row
 */
function detailEl(record, row) {
  const wrap = document.createElement("div");

  const meta = Object.entries(record.mdc);
  if (meta.length) {
    const table = document.createElement("dl");
    table.className = "log-mdc";
    for (const [key, value] of meta) {
      const term = document.createElement("dt");
      term.textContent = key;
      const def = document.createElement("dd");
      // An MDC value the id index knows is a filter, like the chips below —
      // `requestId=5511520` sitting here as dead text while the same value is
      // clickable two rows down was a seam with no reason behind it.
      if (model.index.has(value)) def.append(idChip(value));
      else def.textContent = value || "—";
      table.append(term, def);
    }
    wrap.append(foldEl("MDC", table));
  }

  if (record.ids.length) {
    const ids = document.createElement("div");
    ids.className = "log-ids";
    for (const value of record.ids) ids.append(idChip(value));
    // The row's own "Identifiers:" hint is gone — the fold's label says it now.
    wrap.append(foldEl("Identifiers", ids));
  }

  const pre = document.createElement("pre");
  pre.className = "code-out";
  // highlightJson tints keys, values and masked runs; the header and prose lines
  // it leaves alone, which is exactly right for a mixed record.
  pre.innerHTML = `<code>${highlightJson(recordText(record))}</code>`;
  markTerms(pre);
  wrap.append(pre);

  const tools = document.createElement("div");
  tools.className = "btn-row";

  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "btn btn-ghost btn-small";
  const key = pinKey(record);
  const paintPin = () => {
    const on = pinned.has(key);
    pin.textContent = on ? "★ Unpin" : "☆ Pin record";
    pin.title = on ? "Drop this record from the pinned set" : "Collect this record for Copy pinned";
    row.classList.toggle("is-pinned", on);
  };
  paintPin();
  pin.addEventListener("click", () => {
    if (pinned.has(key)) pinned.delete(key);
    else pinned.add(key);
    paintPin();
    updatePinnedUi();
  });
  tools.append(pin);

  // The way back to what the filters hid. Widens 5 → 10 → 20 and then clears, so
  // one button covers "a glance" and "actually, more" without a second control.
  const CONTEXT_STEPS = [5, 10, 20, 0];
  let step = -1;
  const context = document.createElement("button");
  context.type = "button";
  context.className = "btn btn-ghost btn-small";
  const paintContext = () => {
    const span = step === -1 ? 0 : CONTEXT_STEPS[step];
    context.textContent = span === 0 ? "± Context" : `± ${span} records`;
    context.title = span === 0
      ? "Show the records either side of this one, ignoring the filters"
      : span === 20
      ? "Hide the surrounding records again"
      : "Show more of the surrounding records";
  };
  paintContext();
  context.addEventListener("click", () => {
    step = (step + 1) % CONTEXT_STEPS.length;
    showContext(row, record, CONTEXT_STEPS[step]);
    paintContext();
  });
  tools.append(context);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn btn-ghost btn-small";
  copy.textContent = "Copy record";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(recordText(record));
    showToast("Record copied.");
  });
  tools.append(copy);

  // Log bodies carry Base64 blobs and JWTs; Decode is one hop away.
  const decode = document.createElement("button");
  decode.type = "button";
  decode.className = "btn btn-ghost btn-small";
  decode.innerHTML = `${TOOL_ICONS.decode} Decode`;
  decode.title = "Unwrap encoded payloads from this record in Decode Anything";
  decode.addEventListener("click", () => {
    if (!sendHandoff(sessionStorage, "decode", recordText(record), "Log Analysis")) {
      showToast("Too large to hand over — use Copy record instead.");
      return;
    }
    location.href = new URL("../decode/", import.meta.url).href;
  });
  tools.append(decode);

  // Inside the text box, not under it: these four act on the record whose text is
  // in that box, and standing them outside it left them reading as belonging to
  // the expansion as a whole. In flow at the end rather than floated into a
  // corner — a record is often two lines, so there is no corner free to float
  // into that would not sit on top of the text. The stylesheet fades them in.
  pre.append(tools);
  return wrap;
}

/** Keep the Copy pinned button honest about how many records it holds. */
function updatePinnedUi() {
  // The pair hides as a unit — hiding the two buttons individually would leave
  // the wrapper claiming a gap in the tools row with nothing inside it.
  els.pinnedTools.hidden = pinned.size === 0;
  els.copyPinned.textContent = `Copy pinned (${pinned.size})`;
}

/**
 * The pinned records, in merged order. Filtering the merge is what puts them in
 * order for free — the pins themselves are an unordered set of file/line keys.
 */
function pinnedRecords() {
  return model.records.filter((record) => pinned.has(pinKey(record)));
}

/** Hand a string to the browser as a file. */
function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** `log-2026-05-15-1007.log` — the loaded window, so two downloads don't collide. */
function downloadName(extension) {
  const { fromTs } = model.summary;
  const stamp = fromTs ? `-${fromTs.slice(0, 10)}-${fromTs.slice(11, 16).replace(":", "")}` : "";
  return `log${stamp}.${extension}`;
}

/**
 * The calls table as text, for when that is the view Copy is pointed at.
 *
 * Tab-separated rather than the timeline's prose headers: this is a table, and a
 * table pasted into a ticket or a spreadsheet wants its columns kept.
 */
function restText() {
  const head = REST_COLUMNS.map((column) => column.label).join("\t");
  const rows = model.spans.map((span) =>
    [
      span.tsText,
      span.service,
      span.method,
      span.url,
      span.complete ? span.status ?? "?" : "no answer",
      formatMs(span.ms) || "—",
    ].join("\t")
  );
  return [head, ...rows].join("\n");
}

/** Everything currently shown, as text — what Copy, Download and Send hand over. */
function shownText() {
  if (view === "rest") return model.spans.length === 0 ? "" : restText();
  if (view === "flow") return shownFlow ? flowMermaid(shownFlow) : "";
  return shownGroups
    .map((group) => {
      const head = `# ${group.label}` +
        (group.sublabels.length ? ` (${group.sublabels.join(", ")})` : "") +
        ` — ${group.records.length} records, ${group.fromTs} → ${group.toTs}`;
      return `${head}\n${group.records.map(recordText).join("\n")}`;
    })
    .join("\n\n");
}

/* ------------------------------- wiring ------------------------------- */

/**
 * Fold one field by its own heading, remembering the choice. The default is
 * whatever the markup and the pre-paint script in index.html already applied —
 * the authored fold of "Application & thread", and the stacked-layout folds of
 * the filter fields — so the state is decided in exactly one place. A saved
 * choice overrides it.
 */
function setupCollapse(button, body, key) {
  const caret = button.querySelector(".caret");
  let hidden = body.hidden;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) hidden = saved === "1";
  } catch {
    /* storage unavailable; keep the default */
  }
  const apply = () => {
    body.hidden = hidden;
    button.setAttribute("aria-expanded", String(!hidden));
    if (caret) caret.textContent = hidden ? "▸" : "▾";
  };
  apply();
  button.addEventListener("click", () => {
    hidden = !hidden;
    apply();
    try {
      localStorage.setItem(key, hidden ? "1" : "0");
    } catch {
      /* storage unavailable; the choice just won't persist */
    }
  });
}

for (const button of document.querySelectorAll("#controls .field-collapse")) {
  const id = button.getAttribute("aria-controls");
  if (!id) continue;
  const body = document.getElementById(id);
  if (body) setupCollapse(button, body, `meso-loganalysis-${id}-collapsed`);
}

els.dropZone.addEventListener("click", () => els.fileInput.click());
els.dropZone.addEventListener("keydown", (event) => {
  const key = /** @type {KeyboardEvent} */ (event).key;
  if (key === "Enter" || key === " ") {
    event.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files) addFiles([...els.fileInput.files]);
  els.fileInput.value = "";
});
// Drops land anywhere on the page, not only on the zone — the zone is the
// visual affordance, and it lights up whichever corner the drag enters from.
// Guarded to file drags, so dragging text into the paste box still works.
// dragenter/dragleave fire per element boundary; the counter pairs them up.
let dragDepth = 0;
const draggingFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
document.addEventListener("dragenter", (event) => {
  if (!draggingFiles(event)) return;
  dragDepth++;
  els.dropZone.classList.add("is-drag");
});
document.addEventListener("dragover", (event) => {
  if (draggingFiles(event)) event.preventDefault();
});
document.addEventListener("dragleave", () => {
  if (dragDepth > 0 && --dragDepth === 0) els.dropZone.classList.remove("is-drag");
});
document.addEventListener("drop", (event) => {
  dragDepth = 0;
  els.dropZone.classList.remove("is-drag");
  if (!draggingFiles(event)) return;
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if (files && files.length) addFiles([...files]);
});

els.pasteAdd.addEventListener("click", () => {
  addPasted(els.paste.value);
  els.paste.value = "";
  els.pasteDetails.open = false;
});
els.clear.addEventListener("click", () => {
  sources = [];
  for (const set of Object.values(selected)) set.clear();
  reload();
  showToast("Cleared.");
});
els.example.addEventListener("click", () => {
  if (!sources.some((source) => source.file === EXAMPLE_NAME)) {
    sources.push({ file: EXAMPLE_NAME, text: EXAMPLE_LOG });
  }
  reload();
  showToast("Sample log loaded.");
});

for (const button of els.groupSwitch.querySelectorAll("[data-group]")) {
  button.addEventListener("click", () => {
    setGroup(button.getAttribute("data-group") ?? "correlation");
    render();
  });
}

for (const button of els.viewSwitch.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    setView(button.getAttribute("data-view") ?? "timeline");
    applyView();
  });
}

// The identifier groups follow the same alias link the timeline's grouping does,
// so this one has to rebuild the sidebar list too — `render()` redraws the
// timeline and leaves the facet lists alone.
els.linkAliases.addEventListener("change", () => {
  renderIds();
  render();
});
els.restOnly.addEventListener("change", render);
els.badOnly.addEventListener("change", render);
// Typing filters are debounced; the discrete controls above re-render at once.
els.minMs.addEventListener("input", debounce(render));
els.threads.addEventListener("change", render);
els.query.addEventListener("input", debounce(render));
els.idFind.addEventListener("input", debounce(renderIds));

// The actionable overview tiles. Delegated: the strip is rebuilt per render,
// and re-rendering destroys the clicked button — focus is handed to its
// freshly-built twin, which summarize() guarantees exists (the tile only
// renders when its count is non-zero, and counts ignore filters).
els.overview.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-act]") : null;
  if (!target) return;
  const act = target.getAttribute("data-act") ?? "";
  const action = STAT_ACTIONS[act];
  if (!action) return;
  action.toggle();
  renderFacets();
  render();
  /** @type {HTMLElement | null} */ (els.overview.querySelector(`[data-act="${act}"]`))?.focus();
});

/* ---------------------------- saved views ---------------------------- */

/**
 * The grouping and the filters, kept by name.
 *
 * A view is the question, not the log it was asked of: no records are stored here,
 * so applying one puts its filters onto whatever is loaded at the time. That is the
 * useful half — the same investigation runs again on next week's log — and it is
 * why a restored view can legitimately show nothing, which the filter pills above
 * the timeline then explain and undo.
 *
 * `pinned` stays out on purpose. Those are records, keyed to a file and a line; a
 * name for a filter set has no business dragging evidence along behind it.
 */
const VIEWS_KEY = "meso-loganalysis-views";

/** @returns {{ name: string, state: Record<string, any> }[]} */
function readViews() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    // Unreadable or unavailable storage reads as "none saved" rather than taking
    // the sidebar down with it.
    return [];
  }
}

/** @param {{ name: string, state: Record<string, any> }[]} views */
function writeViews(views) {
  try {
    localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
    return true;
  } catch {
    showToast("Browser storage is unavailable — the view was not saved.");
    return false;
  }
}

/** Everything the sidebar and the brush contribute to what is on screen. */
function snapshotView() {
  return {
    group: groupMode,
    view,
    links: els.linkAliases.checked,
    query: els.query.value,
    idFind: els.idFind.value,
    minMs: els.minMs.value,
    restOnly: els.restOnly.checked,
    badOnly: els.badOnly.checked,
    thread: els.threads.value,
    window: windowSel,
    facets: Object.fromEntries(
      Object.entries(selected).map(([facet, values]) => [facet, [...values]]),
    ),
  };
}

/** @param {Record<string, any>} state */
function restoreView(state) {
  setGroup(state.group ?? "correlation");
  setView(state.view ?? "timeline");
  els.linkAliases.checked = !!state.links;
  els.query.value = state.query ?? "";
  els.idFind.value = state.idFind ?? "";
  els.minMs.value = state.minMs ?? "";
  els.restOnly.checked = !!state.restOnly;
  els.badOnly.checked = !!state.badOnly;
  windowSel = state.window ?? null;
  for (const [facet, values] of Object.entries(selected)) {
    // `selected` mixes Set<string> with Set<number>, and iterating it widens the
    // two into a union whose `add` accepts nothing at all.
    const set = /** @type {Set<any>} */ (values);
    set.clear();
    for (const value of state.facets?.[facet] ?? []) set.add(value);
  }
  renderFacets();
  // After the rebuild, not before: renderFacets writes the option list from this
  // log's threads, and a thread this log has never seen then simply leaves the
  // select where it belongs, on "Any thread".
  els.threads.value = state.thread ?? "";
  render();
}

/** The line under a view's name: how it groups, and how much it narrows. */
function viewSummary(state) {
  const facets = Object.values(state.facets ?? {}).reduce((n, list) => n + list.length, 0);
  const rest = [state.query, state.minMs, state.thread, state.window].filter(Boolean).length +
    (state.restOnly ? 1 : 0) + (state.badOnly ? 1 : 0);
  const total = facets + rest;
  const label = els.groupSwitch.querySelector(`[data-group="${state.group}"]`)?.textContent ??
    state.group;
  return `${label} · ${total} ${total === 1 ? "filter" : "filters"}`;
}

function renderViews() {
  els.viewList.innerHTML = "";
  const views = readViews();
  if (views.length === 0) {
    els.viewList.innerHTML = '<span class="hint">Nothing saved yet.</span>';
    return;
  }
  for (const entry of views) {
    const row = document.createElement("div");
    row.className = "view-row";
    // Two buttons side by side rather than one with the other inside it: applying
    // and deleting are separate acts, and a control nested in a control is neither
    // reliably reachable nor reliably announced.
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "id-row";
    apply.innerHTML = `<span class="id-value">${escapeHtml(entry.name)}</span>` +
      `<span class="id-meta"><span class="id-label">` +
      `${escapeHtml(viewSummary(entry.state))}</span></span>`;
    apply.addEventListener("click", () => {
      restoreView(entry.state);
      showToast(`Showing “${entry.name}”.`);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "view-del";
    remove.textContent = "×";
    remove.title = `Delete “${entry.name}”`;
    remove.setAttribute("aria-label", `Delete saved view ${entry.name}`);
    remove.addEventListener("click", () => {
      if (!writeViews(readViews().filter((saved) => saved.name !== entry.name))) return;
      renderViews();
      showToast(`Deleted “${entry.name}”.`);
    });

    row.append(apply, remove);
    els.viewList.append(row);
  }
}

function saveCurrentView() {
  const name = els.viewName.value.trim();
  if (!name) {
    els.viewName.focus();
    showToast("Give the view a name first.");
    return;
  }
  // Same name overwrites rather than doubling up: the second save of "REST
  // failures" is a correction, not a rival.
  const views = readViews().filter((saved) => saved.name !== name);
  views.push({ name, state: snapshotView() });
  if (!writeViews(views)) return;
  els.viewName.value = "";
  renderViews();
  showToast(`Saved “${name}”.`);
}

els.saveView.addEventListener("click", saveCurrentView);
els.viewName.addEventListener("keydown", (event) => {
  if (/** @type {KeyboardEvent} */ (event).key !== "Enter") return;
  event.preventDefault();
  saveCurrentView();
});
renderViews();

/**
 * Whether an expanded record carries its MDC and identifier blocks at all.
 *
 * A display choice rather than a filter, so it is remembered like the fold states
 * around it instead of being cleared by Reset filters. The flag rides `<html>` and
 * the stylesheet does the hiding, which means the checkbox changes every record
 * already on the page without rebuilding one of them — the blocks are built either
 * way, and two folded rows cost nothing to carry unseen.
 */
const SHOW_META_KEY = "meso-loganalysis-show-meta";
const paintMeta = () =>
  document.documentElement.toggleAttribute("data-record-meta", els.showMeta.checked);
try {
  els.showMeta.checked = localStorage.getItem(SHOW_META_KEY) === "1";
} catch {
  /* storage unavailable; off, as authored */
}
paintMeta();
els.showMeta.addEventListener("change", () => {
  paintMeta();
  try {
    localStorage.setItem(SHOW_META_KEY, els.showMeta.checked ? "1" : "0");
  } catch {
    /* storage unavailable; the choice just won't persist */
  }
});

els.reset.addEventListener("click", () => {
  for (const set of Object.values(selected)) set.clear();
  els.query.value = "";
  els.idFind.value = "";
  els.minMs.value = "";
  els.restOnly.checked = false;
  els.badOnly.checked = false;
  els.threads.value = "";
  windowSel = null;
  renderFacets();
  render();
});

els.expandAll.addEventListener("click", () => {
  const groups = els.groups.querySelectorAll("details.log-group");
  const anyClosed = [...groups].some((group) => !(/** @type {HTMLDetailsElement} */ (group).open));
  for (const group of groups) /** @type {HTMLDetailsElement} */ (group).open = anyClosed;
  els.expandAll.textContent = anyClosed ? "Collapse all" : "Expand all";
});

els.copy.addEventListener("click", async () => {
  const text = shownText();
  if (!text) {
    showToast("Nothing to copy.");
    return;
  }
  await navigator.clipboard.writeText(text);
  showToast(view === "flow" ? "Copied the flow as Mermaid." : "Copied what's shown.");
});

els.copyPinned.addEventListener("click", async () => {
  const records = pinnedRecords();
  if (records.length === 0) return;
  await navigator.clipboard.writeText(pinnedMarkdown(records));
  showToast(
    `Copied ${records.length} pinned record${records.length === 1 ? "" : "s"} ` +
      "as Markdown.",
  );
});

els.download.addEventListener("click", () => {
  const text = shownText();
  if (!text) {
    showToast("Nothing to download.");
    return;
  }
  download(text, downloadName(view === "flow" ? "mmd" : "log"));
  showToast(view === "flow" ? "Downloaded the flow as Mermaid." : "Downloaded what's shown.");
});

els.downloadPinned.addEventListener("click", () => {
  const records = pinnedRecords();
  if (records.length === 0) return;
  download(pinnedMarkdown(records), downloadName("md"));
  showToast(`Downloaded ${records.length} pinned record${records.length === 1 ? "" : "s"}.`);
});

els.sendSanitize.addEventListener("click", () => {
  const text = shownText();
  if (!text) {
    showToast("Nothing to send — load a log first.");
    return;
  }
  if (!sendHandoff(sessionStorage, "sanitize", text, "Log Analysis")) {
    showToast("Too large to hand over — use Copy shown instead.");
    return;
  }
  location.href = new URL("../sanitize/", import.meta.url).href;
});

registerCommands([
  {
    icon: TOOL_ICONS.loganalysis,
    title: "Log Analysis: group by dossier",
    run: () => pickGroup("correlation"),
    keywords: ["correlation", "case", "dossier", "group"],
  },
  {
    icon: TOOL_ICONS.loganalysis,
    title: "Log Analysis: group by problem",
    run: () => pickGroup("problem"),
    keywords: ["problem", "error", "exception", "stack", "trace", "cluster", "group"],
  },
  {
    icon: TOOL_ICONS.loganalysis,
    title: "Log Analysis: REST calls table",
    run: () => {
      setView("rest");
      applyView();
    },
    keywords: ["rest", "table", "latency", "p95", "slow", "service"],
  },
  {
    icon: TOOL_ICONS.loganalysis,
    title: "Log Analysis: group by thread",
    run: () => pickGroup("thread"),
    keywords: ["thread", "concurrency", "group"],
  },
  {
    icon: TOOL_ICONS.loganalysis,
    title: "Log Analysis: group by request",
    run: () => pickGroup("request"),
    keywords: ["request", "requestid", "group"],
  },
  {
    icon: TOOL_ICONS.loganalysis,
    title: "Log Analysis: flow diagram",
    run: () => {
      setView("flow");
      applyView();
    },
    keywords: ["flow", "sequence", "diagram", "mermaid", "trace", "service", "call"],
  },
  {
    icon: TOOL_ICONS.loganalysis,
    title: "Log Analysis: only failed REST calls",
    run: () => {
      els.badOnly.checked = true;
      render();
    },
    keywords: ["rest", "failed", "error", "5xx", "timeout"],
  },
  {
    icon: TOOL_ICONS.loganalysis,
    title: "Log Analysis: reset filters",
    run: () => els.reset.click(),
    keywords: ["reset", "clear", "filters"],
  },
]);

/** Switch grouping from the palette, keeping the button row in step. */
function pickGroup(mode) {
  const button = els.groupSwitch.querySelector(`[data-group="${mode}"]`);
  if (button) /** @type {HTMLElement} */ (button).click();
}

/** A log handed over from another tool (Sanitize masks, then sends it here). */
function receiveHandoff() {
  const entry = takeHandoff(sessionStorage, "loganalysis");
  if (!entry) return false;
  addPasted(entry.text, entry.from ? `from ${entry.from}` : "handoff");
  showToast(entry.from ? `Loaded from ${entry.from}.` : "Log loaded.");
  return true;
}

addEventListener("pageshow", (event) => {
  if (event.persisted) receiveHandoff();
});

const EXAMPLE_NAME = "sample — three apps.log";
/**
 * A made-up two-dossier flow across three applications, in the real Ivy shape:
 * a scheduled case, a webhook that names both the case and its dossier (which is
 * what teaches the alias), a REST call that mentions the case only in its URL,
 * and one call that never answers.
 */
const EXAMPLE_LOG = [
  "[2026-05-15 10:07:36.708][DEBUG][runtimelog.demo-sob.demo-sob-api.rest_client]" +
  "[http-nio-8080-exec-25]{application=demo-sob, requestId=3134255, session=0 SYSTEM}",
  "Invoking REST service demoId (0f5458dd-1ea8-4e2c-990c-dd86b68a45f0) call to POST " +
  "https://demo-id.example/api/demoid/document-baskets",
  "[2026-05-15 10:07:37.051][INFO ][runtimelog.demo-sob.demo-sob-api.rest_client]" +
  "[http-nio-8080-exec-25]{application=demo-sob, requestId=3134255, session=0 SYSTEM}",
  "REST service demoId (0f5458dd-1ea8-4e2c-990c-dd86b68a45f0) call to POST " +
  "https://demo-id.example/api/demoid/document-baskets successful executed in 342 [ms]. " +
  "Response status was 200 ",
  "[2026-05-15 10:07:37.060][INFO ][runtimelog.demo-sob.demo-sob-api.user_code]" +
  "[http-nio-8080-exec-25]{application=demo-sob, requestId=3134255, session=0 SYSTEM}",
  "Created document basket: class PostDocumentBasketResponse {",
  "    extCaseId: 11111111-1111-4111-8111-111111111111",
  "    documentBasketId: 22222222-2222-4222-8222-222222222222",
  "    documentBasketStatus: OUTSTANDING",
  "    signers: [class Signer {",
  "        ubiIdCaseId: 33333333-3333-4333-8333-333333333333",
  "        signingStatus: OUTSTANDING",
  "    }]",
  "}",
  "[2026-05-15 10:09:53.135][INFO ][runtimelog.demo-id.demo-id-api.user_code]" +
  "[http-nio-8080-exec-4]{application=demo-id, requestId=1469317, session=0 SYSTEM}",
  "Received notification: class IdentificationNotificationRequest {",
  "    ubiIdCaseId: 33333333-3333-4333-8333-333333333333",
  "    extCaseId: 11111111-1111-4111-8111-111111111111",
  "    status: VERIFICATION_PENDING",
  "}",
  "[2026-05-15 10:10:03.379][INFO ][runtimelog.demo-id.demo-id-api.event]" +
  "[ivy immediate job pool-thread-3]{application=demo-id, requestId=1469375}",
  "Process Start Event Bean AutoProcessStarterEventBean fires [reason=Timerinterval elapsed.]",
  "[2026-05-15 10:11:41.159][WARN ][runtimelog.demo-bank.demo-bank.user_code]" +
  "[http-nio-8080-exec-12]{application=demo-bank, requestId=5511300}",
  "The refresh token does not exist or invalid. Session is not authorized: The token is null.",
  "[2026-05-15 10:13:54.889][DEBUG][runtimelog.demo-bank.demo-bank-api.rest_client]" +
  "[http-nio-8080-exec-3]{application=demo-bank, requestId=5511520}",
  "Invoking REST service demoId (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET " +
  "https://demo-id.example/api/demoid/cases/33333333-3333-4333-8333-333333333333/files.zip",
  "[2026-05-15 10:14:03.067][INFO ][runtimelog.demo-bank.demo-bank-api.rest_client]" +
  "[http-nio-8080-exec-3]{application=demo-bank, requestId=5511520}",
  "REST service demoId (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET " +
  "https://demo-id.example/api/demoid/cases/33333333-3333-4333-8333-333333333333/files.zip " +
  "successful executed in 7 [s]. Response status was 200 ",
  "[2026-05-15 10:14:30.182][DEBUG][runtimelog.demo-bank.demo-bank.rest_client]" +
  "[thread-ivy-env-1654]{application=demo-bank, requestId=5511777}",
  "Invoking REST service demoDoc (3ccb67cc-36bf-4d77-bb5d-0261a3fe526e) call to POST " +
  "https://demo-doc.example/api/documents/generate",
  "[2026-05-15 10:14:31.400][INFO ][runtimelog.demo-bank.demo-bank-api.user_code]" +
  "[http-nio-8080-exec-2]{application=demo-bank, requestId=5511800}",
  "Backoffice task creation probe has been executed. " +
  "dossierId = 44444444-4444-4444-8444-444444444444",
].join("\n");

if (!receiveHandoff()) reload();

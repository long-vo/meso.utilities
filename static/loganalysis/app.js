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
  contextAround,
  densityBuckets,
  facetCounts,
  filterRecords,
  formatMs,
  LEVELS,
  parseQuery,
  pinnedMarkdown,
  rankedIds,
  recordSummary,
  recordText,
  restStats,
  spanSummary,
} from "./loganalysis.mjs";
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
  overview: $("overview"),
  groups: $("groups"),
  viewSwitch: $("view-switch"),
  viewTitle: $("view-title"),
  restView: $("rest-view"),
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

/** Re-parse everything and redraw. Called whenever the source list changes. */
function reload() {
  model = analyse(sources);
  // A file that has just gone away must not keep filtering the view.
  for (const value of [...selected.files]) {
    if (!sources.some((source) => source.file === value)) selected.files.delete(value);
  }
  for (const value of [...selected.ids]) {
    if (!model.index.has(value)) selected.ids.delete(value);
  }
  // Spans are renumbered by the re-fold, so a span filter cannot survive it.
  selected.spanIds.clear();
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
  render();
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
    drop.className = "chip-x";
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

function renderIds() {
  const needle = els.idFind.value.trim().toLowerCase();
  const all = rankedIds(model.index);
  const matching = needle
    ? all.filter((facet) =>
      facet.value.toLowerCase().includes(needle) ||
      facet.labels.some((label) => label.toLowerCase().includes(needle))
    )
    : all;
  // Selected ids stay listed even when the search box excludes them, so a filter
  // can always be switched off where it was switched on.
  const pinned = all.filter((facet) => selected.ids.has(facet.value) && !matching.includes(facet));
  const list = [...pinned, ...matching].slice(0, 200);
  const total = pinned.length + matching.length;

  els.idList.innerHTML = "";
  if (list.length === 0) {
    els.idList.innerHTML = '<span class="hint">No identifiers found.</span>';
    return;
  }
  for (const facet of list) {
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
      render();
    });
    els.idList.append(row);
  }
  if (total > list.length) {
    const more = document.createElement("span");
    more.className = "hint";
    more.textContent = `Showing ${list.length} of ${total} — type above to narrow.`;
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

/** Path and last segment only — full integration URLs are 120 characters wide. */
function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.length > 48
      ? `…${parsed.pathname.slice(-48)}${parsed.search}`
      : parsed.pathname + parsed.search;
  } catch {
    return url;
  }
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

/* ---------------------------- the two views ---------------------------- */

/**
 * Show the view that is selected, and hide the controls belonging to the other.
 *
 * The density strip and the filter pills are timeline instruments — they brush
 * and explain a set of *records*. The REST table lists calls over the whole
 * loaded log, so leaving those two on above it would claim a relationship that
 * isn't there.
 */
function applyView() {
  const rest = view === "rest";
  els.groups.hidden = rest;
  els.restView.hidden = !rest;
  els.viewTitle.textContent = rest ? "REST calls" : "Timeline";
  els.density.hidden = rest || strip.length === 0;
  els.filterPills.hidden = rest || els.filterPills.children.length === 0;
  // Counted in the terms of whatever is on screen. "10 of 10 records · 3 groups"
  // above a table of calls describes the view you are not looking at.
  els.counts.textContent = model.records.length === 0
    ? ""
    : rest
    ? `${model.spans.length} ${plural(model.spans.length, "call")} · ` +
      `${model.summary.restFailed} failed or unanswered`
    : `${shownCount} of ${model.records.length} records · ${shownGroups.length} ` +
      `${shownGroups.length === 1 ? "group" : "groups"}`;
  if (rest) renderRestView();
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

/** One bar per time slice over the whole loaded set; errors tint their slice. */
function renderDensity() {
  strip = densityBuckets(model.records, 80);
  els.density.hidden = strip.length === 0;
  els.density.innerHTML = "";
  stripOverlay = null;
  if (strip.length === 0) return;
  const top = Math.max(...strip.map((bucket) => bucket.count));
  for (const bucket of strip) {
    const bar = document.createElement("button");
    bar.type = "button";
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
  updateDensityOverlay();
}

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
    // Only when a pause is out of character for this group — see gapStats. A
    // static chip like the others; the divider inside the group is what points
    // at the row, and none of these badges is a control.
    group.gapFlagged.length
      ? `<span class="chip chip-warn">gap ${formatMs(group.gapMs)}</span>`
      : "",
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

  wrap.append(tools);
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

/** Everything currently shown, as text — what Copy and Send hand over. */
function shownText() {
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

els.linkAliases.addEventListener("change", render);
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
  showToast("Copied what's shown.");
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
  download(text, downloadName("log"));
  showToast("Downloaded what's shown.");
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

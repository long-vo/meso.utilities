// meso.utilities — Team Availability UI wiring. All parsing, date math and
// aggregation live in ./availability.mjs and ./xlsx.mjs (pure, parity-tested);
// this file only moves data between them, the DOM and localStorage. Names and
// absences are personal data: nothing here is ever sent to a server, but
// `copyShareLink` packs a filtered slice of them *into a URL*, which whoever
// holds the link can read — that is the one way data leaves this browser.
import { readWorkbook } from "./xlsx.mjs";
import {
  addDays,
  applyDayCodes,
  applyLocationHolidays,
  balanceTotals,
  capacityGrid,
  capacityText,
  capacityTint,
  capacityTotals,
  clampAnchor,
  codeInfo,
  dayCounts,
  decodeShare,
  encodeShare,
  HISTORY_LIMIT,
  historyText,
  holidayName,
  HOLIDAYS_CH_ZURICH,
  isWeekend,
  KIND_LABELS,
  leavableDays,
  leaveHandoffDefaults,
  leaveHandoffText,
  lowCoverage,
  mergeModels,
  monthSpans,
  outDatesLabelText,
  outDatesText,
  outInRange,
  outOn,
  packModel,
  parseQuarterCsv,
  parseVacationWorkbook,
  personSummary,
  prettyDay,
  pushHistory,
  recordOnGrid,
  remoteOn,
  revertDayCodes,
  shortDay,
  splitHoliday,
  summaryText,
  trimNumber,
  unpackModel,
  viewDates,
  viewLabel,
  WEEKDAYS,
  weekSlices,
  yearFromFilename,
} from "./availability.mjs";
// The type+duration → day-code mapping is Leave's to define (it owns the leave
// vocabulary); importing it keeps the dialog's marks byte-identical to the ones
// Leave's own "save to grid" queues.
import { availabilityUpdate } from "../leave/leave.mjs";
import { DEMO_CH_TEAM, demoModel } from "./demo.mjs";
import { drainUpdates, INBOX_KEY, sendHandoff } from "../handoff.mjs";
import { registerCommands, TOOL_ICONS } from "../palette.js";
import { parseHidden, serializeHidden } from "../sidebar.mjs";
import { makeToast } from "../ui.mjs";

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const els = {
  dropZone: $("drop-zone"),
  fileInput: /** @type {HTMLInputElement} */ ($("file-input")),
  importStatus: $("import-status"),
  importUpdated: $("import-updated"),
  demoLoad: $("demo-load"),
  patternToggle: /** @type {HTMLInputElement} */ ($("pattern-toggle")),
  csvText: /** @type {HTMLTextAreaElement} */ ($("csv-text")),
  csvQuarter: /** @type {HTMLSelectElement} */ ($("csv-quarter")),
  csvImport: $("csv-import"),
  year: /** @type {HTMLInputElement} */ ($("year-input")),
  viewMonth: $("view-month"),
  viewQuarter: $("view-quarter"),
  viewPeriod: $("view-period"),
  navPrev: $("nav-prev"),
  navToday: $("nav-today"),
  navNext: $("nav-next"),
  teamChips: $("team-chips"),
  memberField: $("member-field"),
  memberChips: $("member-chips"),
  nameFilter: /** @type {HTMLInputElement} */ ($("name-filter")),
  bulkTeam: /** @type {HTMLSelectElement} */ ($("bulk-team")),
  bulkVn: $("bulk-vn"),
  bulkCh: $("bulk-ch"),
  tagList: $("tag-list"),
  warningsDetails: $("warnings-details"),
  warningsSummary: $("warnings-summary"),
  warningsList: $("warnings-list"),
  historyDetails: $("history-details"),
  historySummary: $("history-summary"),
  historyWarn: $("history-warn"),
  historyList: $("history-list"),
  historyClear: $("history-clear"),
  legend: $("legend"),
  legendBody: $("legend-body"),
  legendToggle: $("legend-toggle"),
  legendRail: $("legend-rail"),
  exportJson: $("export-json"),
  exportView: $("export-view"),
  shareLink: $("share-link"),
  importJson: $("import-json"),
  jsonInput: /** @type {HTMLInputElement} */ ($("json-input")),
  clearData: $("clear-data"),
  stripStatus: $("strip-status"),
  copyStrip: $("copy-strip"),
  dayPick: /** @type {HTMLInputElement} */ ($("day-pick")),
  dayReset: $("day-reset"),
  strip: $("strip"),
  stripToggle: $("strip-toggle"),
  rangeLabel: $("range-label"),
  selLabel: $("sel-label"),
  selClear: $("sel-clear"),
  sendLeave: /** @type {HTMLButtonElement} */ ($("send-leave")),
  leaveDialog: /** @type {HTMLDialogElement} */ ($("leave-dialog")),
  leaveDialogDays: $("leave-dialog-days"),
  leaveMark: /** @type {HTMLInputElement} */ ($("leave-mark")),
  leaveMarkNote: $("leave-mark-note"),
  leaveName: /** @type {HTMLSelectElement} */ ($("leave-name")),
  leaveType: /** @type {HTMLSelectElement} */ ($("leave-type")),
  leaveDuration: /** @type {HTMLSelectElement} */ ($("leave-duration")),
  yearDialog: /** @type {HTMLDialogElement} */ ($("year-dialog")),
  yearPerson: /** @type {HTMLSelectElement} */ ($("year-person")),
  yearKind: $("year-kind"),
  yearTotals: $("year-totals"),
  yearKinds: $("year-kinds"),
  yearMonths: $("year-months"),
  yearRanges: $("year-ranges"),
  heatmap: $("heatmap"),
  heatmapWrap: $("heatmap-wrap"),
  capacity: $("capacity"),
  copyCapacity: $("copy-capacity"),
  capWarn: $("cap-warn"),
  balTitle: $("bal-title"),
  balances: $("balances"),
  lowThreshold: /** @type {HTMLInputElement} */ ($("low-threshold")),
  lowThresholdOut: $("low-threshold-out"),
  shareOffer: $("share-offer"),
  shareOfferText: $("share-offer-text"),
  shareOfferLoad: $("share-offer-load"),
  shareOfferDiscard: $("share-offer-discard"),
  confirmDialog: /** @type {HTMLDialogElement} */ ($("confirm-dialog")),
  confirmTitle: $("confirm-title"),
  confirmText: $("confirm-text"),
  confirmOk: $("confirm-ok"),
};
const toast = makeToast($("toast"));

const STORE_KEY = "meso-availability";
/**
 * Past this many people on public holiday, the strip shows one chip for the
 * whole cohort instead of one per person: a VN holiday puts the entire roster
 * in that list, which buries the day's real absences.
 */
const HOLIDAY_COLLAPSE_AT = 4;
const KIND_LEGEND = [
  ["working", "In office", "w"],
  ["remote", "Remote", "r rm ra"],
  ["onsite", "Onsite", "ch"],
  ["leave", "Leave", "p m a"],
  ["planned", "Planned", "v"],
  ["core", "Core leave", "c"],
  ["sick", "Sick", "s sm sa"],
  ["social", "Social ins.", "si"],
  ["holiday", "Holiday", "h"],
  ["weekend", "Weekend", "e"],
  ["unknown", "Unknown", "?"],
];

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ------------------------------- state ------------------------------- */

/**
 * Spelled out rather than inferred: every field that starts as `null` would
 * otherwise be typed `null`, and a `!== null` guard would narrow it to `never`.
 *
 * @type {{
 *   model: import("./availability.mjs").Model | null,
 *   year: number,
 *   tags: Record<string, "VN" | "CH">,
 *   teams: string[],
 *   members: string[],
 *   view: { mode: "month" | "quarter", anchor: string },
 *   nameFilter: string,
 *   history: import("./availability.mjs").HistoryEntry[],
 *   updatedAt: number | null,
 *   pickedDay: string | null,
 *   focus: { row: number, col: number } | null,
 *   sel: { name: string, from: string, to: string, anchor?: string, code?: string } | null,
 *   lowThreshold: number,
 *   patterns: boolean,
 * }}
 */
const state = {
  model: null, // reconciled model straight from the parser (location untagged)
  year: new Date().getFullYear(),
  tags: {}, // person name → "VN" | "CH"
  teams: [], // selected team keys (lowercase); empty = everyone
  // Names picked out of the selected teams; empty = the whole team. Only ever
  // holds people the current team selection covers — see renderMemberChips.
  members: [],
  view: { mode: "month", anchor: todayIso() },
  nameFilter: "",
  // Changes another tool recorded here, newest first. Persisted with the model.
  history: [],
  // When the model was last imported — not when it was last edited, which the
  // history panel stamps per record. Says how fresh the workbook data is.
  updatedAt: null,
  pickedDay: null, // the day the strip reports on; null = today
  focus: null, // heatmap cell holding the grid's single tab stop; see markFocusable
  // One person's run of days picked in the grid, for handing to Leave:
  // { name, from, to, code } with from ≤ to. Transient — never saved.
  sel: null,
  // Percent of a week's maximum below which a team-week is flagged thin. What
  // counts as thin is a team's own call, so it is a control, not a constant;
  // 0 turns the flagging off.
  lowThreshold: 60,
  // Per-kind patterns over the day hues, for colour-blind readers. Persisted:
  // whoever needs them needs them every visit.
  patterns: false,
};

/**
 * Dimensions of the last-rendered heatmap. The keyboard handler needs them on
 * every arrow press and must not re-derive the model to get them.
 */
/** @type {{ rows: number, cols: number, dates: string[] }} */
let gridDims = { rows: 0, cols: 0, dates: [] };

/**
 * The ARIA grid pattern wants one tab stop for the whole grid, not 6,400 of
 * them: every cell is focusable but only the one at `state.focus` is reachable
 * by Tab, and the arrow keys move that. Row -1 is the day-header row, where
 * Enter picks the day.
 */
function markFocusable(cell, row, col) {
  cell.dataset.r = String(row);
  cell.dataset.c = String(col);
  const focus = state.focus;
  cell.tabIndex = focus !== null && focus.row === row && focus.col === col ? 0 : -1;
}

function gridCell(row, col) {
  return /** @type {HTMLElement | null} */ (
    els.heatmap.querySelector(`[data-r="${row}"][data-c="${col}"]`)
  );
}

/**
 * Column half of the hover crosshair. CSS cannot select "every cell in column
 * N" across sibling row grids, and the obvious workaround — one tall band
 * painted out of the hovered cell — is absolutely positioned inside the
 * scrolling wrapper, so it extends the scrollable area and the grid scrolls
 * forever. Marking the column's own cells keeps every overlay inside the grid.
 *
 * @param {string | null} col the cells' `data-c`, or null to clear
 */
let hoverCol = null;
function setHoverColumn(col) {
  if (col === hoverCol) return; // pointer moved within one column — nothing to do
  for (const cell of els.heatmap.querySelectorAll(".is-col-hover")) {
    cell.classList.remove("is-col-hover");
  }
  hoverCol = col;
  if (col === null) return;
  for (const cell of els.heatmap.querySelectorAll(`[data-c="${col}"]`)) {
    cell.classList.add("is-col-hover");
  }
}

/* ------------------------- grid selection → Leave ------------------------- */

/**
 * What the current pick is made of, as {@link leavableDays} reads it off the
 * cells in {@link paintSelection}. `reason` drives the disabled button — and is
 * re-checked inside {@link sendToLeave}, so the ⌘K command refuses exactly the
 * picks the button does; a disabled button stops the pointer, not another way
 * in. `markable` drives the dialog's mark checkbox.
 */
let selSummary = leavableDays([]);

/**
 * Paint `state.sel` onto the cells and update the panel head. Selection is
 * repainted in place rather than through `renderAll`: a drag crosses a cell
 * boundary many times a second, and re-rendering a 92-column grid that often
 * drops the pointer's own cell out from under it mid-drag.
 */
function paintSelection() {
  const sel = state.sel;
  /** @type {Array<{ date: string, code: string, outside: boolean }>} */
  const picked = [];
  for (
    const cell of /** @type {NodeListOf<HTMLElement>} */ (
      els.heatmap.querySelectorAll(".hm-cell")
    )
  ) {
    const date = cell.dataset.date ?? "";
    const inRange = sel !== null && cell.dataset.person === sel.name &&
      date >= sel.from && date <= sel.to;
    cell.classList.toggle("is-sel", inRange);
    // Round only the ends, so a run reads as one band instead of a row of tiles.
    cell.classList.toggle("is-sel-start", inRange && date === sel.from);
    cell.classList.toggle("is-sel-end", inRange && date === sel.to);
    // Collected in the same pass that paints: a drag repaints many times a
    // second, and these cells are already in hand.
    if (inRange) {
      picked.push({
        date,
        code: cell.dataset.code ?? "",
        outside: cell.dataset.outside === "1",
      });
    }
  }
  selSummary = leavableDays(picked);
  const blocked = selSummary.reason;
  // The button stays on screen whatever the pick — a control that only appears
  // once the selection has been discovered is a control nobody discovers the
  // selection from. Disabled states carry the reason in their title, and the
  // pick still paints when it can't be requested: seeing what you grabbed is
  // how you know what to fix, which a vanishing button never says.
  els.sendLeave.disabled = sel === null || blocked !== null;
  els.sendLeave.title = sel === null
    ? "Click a cell or drag along a row to pick days first"
    : blocked === null
    ? "Open Leave Request with the picked person and dates filled in"
    : `Nothing to request — the pick is ${blocked} only`;
  els.selClear.hidden = sel === null;
  // Days the workbook never covered are still real dates to request, so they
  // are a note rather than a refusal — but nothing can be written to them, and
  // saying so in the label beats letting the dialog's tick do nothing.
  const note = blocked !== null
    ? ` · ${blocked} only — nothing to request`
    : selSummary.outside === 0
    ? ""
    : ` · ${selSummary.outside} outside the imported range`;
  els.selLabel.textContent = sel === null
    ? ""
    : `${sel.name} · ${
      sel.from === sel.to ? prettyDay(sel.from) : `${shortDay(sel.from)}–${shortDay(sel.to)}`
    }${note}`;
}

/** Replace the selection (null clears it) and repaint. */
function setSelection(sel) {
  state.sel = sel;
  paintSelection();
}

/** Selection from one cell, or — when extending — from the anchor out to it. */
function selectCell(cell, extend) {
  const { person, date, code } = cell.dataset;
  if (person === undefined || date === undefined) return;
  const sel = state.sel;
  if (extend && sel !== null && sel.name === person) {
    // The anchor is whichever end the extension did not move to.
    const anchor = sel.anchor ?? sel.from;
    setSelection({
      ...sel,
      from: date < anchor ? date : anchor,
      to: date < anchor ? anchor : date,
    });
    return;
  }
  setSelection({ name: person, from: date, to: date, anchor: date, code });
}

/** Widen the current selection to `cell`, which a drag guarantees is in-row. */
function dragTo(cell) {
  const sel = state.sel;
  const date = cell.dataset.date;
  if (sel === null || date === undefined) return;
  // The anchor is set whenever a selection is made; fall back to its start.
  const anchor = sel.anchor ?? sel.from;
  const from = date < anchor ? date : anchor;
  const to = date < anchor ? anchor : date;
  if (from === sel.from && to === sel.to) return; // still inside the same run
  setSelection({ ...sel, from, to });
}

/**
 * Offer the selection to the Leave tool: a dialog confirms (or adjusts) who,
 * which leave type and which duration before anything is handed over. Every
 * field is editable; the grid pick only supplies the starting values.
 */
function sendToLeave() {
  if (state.sel === null || state.model === null) {
    toast("Pick days in the grid first — click a cell, or drag along a row");
    return;
  }
  if (selSummary.reason !== null) {
    toast(`Nothing to request — the pick is ${selSummary.reason} only`);
    return;
  }
  els.leaveName.replaceChildren(
    ...state.model.people.map((person) => new Option(person.name, person.name)),
  );
  els.leaveDialogDays.textContent = state.sel.from === state.sel.to
    ? prettyDay(state.sel.from)
    : `${prettyDay(state.sel.from)} – ${prettyDay(state.sel.to)}`;
  const defaults = leaveHandoffDefaults(state.sel);
  els.leaveName.value = state.sel.name;
  // A pick with no leave-type equivalent (a working day, a holiday) lands on
  // annual — the same reading the Leave form gives a null type.
  els.leaveType.value = defaults.type ?? "annual";
  els.leaveDuration.value = defaults.duration;
  // A tick that would write nothing is worse than no tick: `markOnGrid` runs
  // immediately before navigating to Leave, so it has no way to report back — a
  // silent no-op is all the user would get. Say it here, before the choice.
  const { markable, outside, weekend } = selSummary;
  els.leaveMark.disabled = markable === 0;
  // Ticked by default: a request filed from the grid is nearly always meant to
  // show on it. It writes day codes and books the balance, so it is re-derived
  // on every open rather than remembered — and never left ticked when there is
  // nothing to write, because a disabled box still reports `checked`.
  els.leaveMark.checked = markable > 0;
  els.leaveMarkNote.hidden = markable > 0 && outside === 0;
  els.leaveMarkNote.textContent = markable === 0
    ? outside > 0
      ? "These days are outside the imported range, so there is nothing on the grid to mark — " +
        "the request itself still goes through."
      : "There is nothing on the grid to mark for these days — the request itself still goes " +
        "through."
    : `${outside} of these days ${outside === 1 ? "is" : "are"} outside the imported range and ` +
      `won't be marked${weekend > 0 ? " (weekends are skipped too)" : ""} — ${markable} will.`;
  els.leaveDialog.showModal();
}

/**
 * Write the dialog's request onto the heatmap itself — the same pipeline the
 * Leave-tool inbox uses (`applyQueuedUpdates`), minus the queue: the model is
 * right here, so the change lands, persists and is recorded before navigation.
 * `applyDayCodes` books the days against the person's leave balance too, so the
 * balances panel reflects the request the moment the grid does.
 */
function markOnGrid(update) {
  if (state.model === null) return;
  const result = applyDayCodes(state.model, update);
  if (result.name === null || result.written === 0) return;
  state.model = result.model;
  state.history = pushHistory(state.history, {
    name: result.name,
    from: update.from,
    to: update.to,
    code: update.code,
    days: result.written,
    at: Date.now(),
    source: "Send to Leave",
    before: result.before,
  });
  saveState();
  renderAll();
}

/**
 * The dialog's send path, on submit rather than on the dialog's close event —
 * submit fires synchronously and names its button, while close is fired from a
 * queued task that at least one embedded Chromium drops entirely. The dates
 * ride in sessionStorage, not the URL: a leave request names a person, and a
 * URL is the one part of a page that gets pasted into chats and logged by
 * proxies.
 */
// The dialog always contains the form; it is authored in the same document.
/** @type {HTMLFormElement} */ (els.leaveDialog.querySelector("form"))
  .addEventListener("submit", (event) => {
    const submitter = /** @type {HTMLButtonElement | null} */ (event.submitter);
    if (submitter?.value !== "send" || state.sel === null) return;
    const fields = {
      name: els.leaveName.value,
      type: els.leaveType.value,
      duration: els.leaveDuration.value,
    };
    if (els.leaveMark.checked) {
      const update = availabilityUpdate({
        ...fields,
        startDate: state.sel.from,
        endDate: state.sel.to,
      });
      if (update !== null) markOnGrid(update);
    }
    const text = leaveHandoffText({ ...state.sel, ...fields });
    if (!sendHandoff(sessionStorage, "leave", text, "Team Availability")) {
      toast("Could not hand over — browser storage is unavailable");
      return;
    }
    location.href = "../leave/";
  });

/* ------------------------------ house confirm ------------------------------ */

/** The pending confirm's resolver, if one is open. One dialog, one question. */
/** @type {((ok: boolean) => void) | null} */
let confirmResolve = null;

// Resolved on submit rather than on close, like the leave dialog above: submit
// fires synchronously and names its button, while close is fired from a queued
// task that at least one embedded Chromium drops entirely.
/** @type {HTMLFormElement} */ (els.confirmDialog.querySelector("form"))
  .addEventListener("submit", (event) => {
    const ok = /** @type {HTMLButtonElement | null} */ (event.submitter)?.value === "ok";
    confirmResolve?.(ok);
    confirmResolve = null;
  });
// Escape closes without submitting; the question was declined, not abandoned.
els.confirmDialog.addEventListener("cancel", () => {
  confirmResolve?.(false);
  confirmResolve = null;
});

/**
 * The house replacement for native `confirm()`, which blocks the renderer,
 * takes no styling and cannot mark its destructive button as such.
 *
 * @param {{ title: string, text: string, action: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
function confirmDialog(opts) {
  els.confirmTitle.textContent = opts.title;
  els.confirmText.textContent = opts.text;
  els.confirmOk.textContent = opts.action;
  els.confirmOk.classList.toggle("btn-danger", opts.danger === true);
  els.confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

/** Hand the tab stop and DOM focus to `state.focus`, taking both off `from`. */
function moveGridFocus(from) {
  const previous = gridCell(from.row, from.col);
  if (previous !== null) previous.tabIndex = -1;
  const focus = state.focus;
  const next = focus === null ? null : gridCell(focus.row, focus.col);
  if (next !== null) {
    next.tabIndex = 0;
    next.focus();
  }
}

/** Arrow-key navigation over the heatmap, per the ARIA grid pattern. */
function onGridKeydown(event) {
  const { rows, cols, dates } = gridDims;
  if (cols === 0 || state.focus === null) return;
  const from = state.focus;
  let { row, col } = from;
  switch (event.key) {
    case "ArrowLeft":
      col--;
      break;
    case "ArrowRight":
      col++;
      break;
    case "ArrowUp":
      row--;
      break;
    case "ArrowDown":
      row++;
      break;
    case "PageUp":
      row -= 10;
      break;
    case "PageDown":
      row += 10;
      break;
    case "Home":
      col = 0;
      if (event.ctrlKey) row = -1;
      break;
    case "End":
      col = cols - 1;
      if (event.ctrlKey) row = rows - 1;
      break;
    case "Enter":
    case " ":
      event.preventDefault();
      // The header row picks the strip's day; a person's row picks days to send
      // to Leave, with Shift extending the run — the keyboard's answer to a drag.
      if (from.row === -1) pickDay(dates[from.col]);
      else selectCell(gridCell(from.row, from.col), event.shiftKey);
      return;
    case "Escape":
      if (state.sel === null) return;
      event.preventDefault();
      setSelection(null);
      return;
    default:
      return;
  }
  event.preventDefault();
  state.focus = {
    row: Math.max(-1, Math.min(rows - 1, row)),
    col: Math.max(0, Math.min(cols - 1, col)),
  };
  moveGridFocus(from);
}

/** The day the strip reports on. Transient like the view anchor — not saved. */
function stripDay() {
  return state.pickedDay ?? todayIso();
}

/**
 * Point the strip at `date`; picking today is the same as picking nothing.
 * The heatmap follows, so the strip and the grid never disagree about which
 * day is under discussion — a no-op when the day was clicked in the grid.
 */
function pickDay(date) {
  state.pickedDay = date === todayIso() ? null : date;
  state.view.anchor = date;
  renderAll();
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw === null) return;
    const saved = JSON.parse(raw);
    if (saved === null || typeof saved !== "object" || saved.v !== 1) return;
    state.model = unpackModel(saved.model) ?? null;
    if (Number.isInteger(saved.year)) state.year = saved.year;
    if (saved.tags && typeof saved.tags === "object") state.tags = saved.tags;
    if (Array.isArray(saved.teams)) state.teams = saved.teams.filter((t) => typeof t === "string");
    if (Array.isArray(saved.members)) {
      state.members = saved.members.filter((m) => typeof m === "string");
    }
    if (saved.view && (saved.view.mode === "month" || saved.view.mode === "quarter")) {
      state.view.mode = saved.view.mode;
    }
    if (Array.isArray(saved.history)) {
      state.history = saved.history.filter((e) => e !== null && typeof e === "object");
    }
    if (Number.isInteger(saved.updatedAt) && saved.updatedAt > 0) {
      state.updatedAt = saved.updatedAt;
    }
    if (Number.isInteger(saved.lowThreshold) && saved.lowThreshold >= 0) {
      state.lowThreshold = Math.min(100, saved.lowThreshold);
    }
    if (saved.patterns === true) state.patterns = true;
    // The anchor is not persisted, so a reload starts it at today — clamp it the
    // same way an import does, or a stored other-year workbook reopens on an
    // empty month.
    if (state.model !== null) {
      state.view.anchor = clampAnchor(state.view.anchor, state.model.days);
    }
  } catch {
    /* corrupted or unavailable storage — start fresh */
  }
}

let saveTimer = 0;

/** Write `state` to localStorage now — the debounced {@link saveState} lands here. */
function saveStateNow() {
  saveTimer = 0;
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        v: 1,
        year: state.year,
        tags: state.tags,
        teams: state.teams,
        members: state.members,
        lowThreshold: state.lowThreshold,
        patterns: state.patterns,
        history: state.history,
        updatedAt: state.updatedAt,
        view: { mode: state.view.mode },
        model: state.model === null ? null : packModel(state.model),
      }),
    );
  } catch {
    toast("Could not save to this browser's storage");
  }
}

/**
 * Schedule a save. Rendering ends here, and a run of chip clicks or month
 * steps would otherwise serialise the whole model — people × days — on every
 * one of them. Trailing debounce; the `pagehide` listener in the boot section
 * flushes it, so navigating to Leave (or closing the tab) can't lose the write.
 */
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 250);
}

/** Flush a pending save immediately — the page may be going away. */
function flushSave() {
  if (saveTimer === 0) return;
  clearTimeout(saveTimer);
  saveStateNow();
}

/** The model as rendered: location tags applied, CH holidays overlaid. */
function displayModel() {
  if (state.model === null) return null;
  return applyLocationHolidays(state.model, state.tags, HOLIDAYS_CH_ZURICH);
}

/** A team's display name. The workbook has people with the team cell empty, and
 *  an unlabelled row reads as a rendering fault rather than as missing data. */
function teamLabel(team) {
  return team === "" ? "(no team)" : team;
}

/** What one heatmap cell means, naming the holiday when a built-in set knows
 *  it — "Public holiday" alone doesn't say whether it's Tet or Bundesfeier.
 *  An empty cell has two quite different causes, and only one of them can be
 *  written to, so the two are named apart rather than both reading "no data". */
function cellMeaning(info, code, date, location, outside) {
  if (info === null) return outside ? "outside the imported range" : "no data";
  const named = info.kind === "holiday" ? holidayName(date, location) : null;
  return named === null ? `${info.label} (${code})` : `${named} — ${info.label} (${code})`;
}

/** Team key → display label, latest spelling wins (labels drift per quarter). */
function teamLabels(model) {
  const labels = new Map();
  for (const person of model.people) {
    if (person.team !== "") labels.set(person.team.toLowerCase(), person.team);
  }
  return labels;
}

function visiblePeople(model) {
  const needle = state.nameFilter.trim().toLowerCase();
  return model.people
    .filter((p) => state.teams.length === 0 || state.teams.includes(p.team.toLowerCase()))
    .filter((p) => state.members.length === 0 || state.members.includes(p.name))
    .filter((p) => needle === "" || p.name.toLowerCase().includes(needle))
    .sort((a, b) =>
      a.team.toLowerCase().localeCompare(b.team.toLowerCase()) || a.name.localeCompare(b.name)
    );
}

/** The dates the heatmap currently shows. */
function visibleRange() {
  return viewDates(state.view.mode, state.view.anchor);
}

/* ------------------------------- rendering ------------------------------- */

function renderAll() {
  const model = displayModel();
  document.body.classList.toggle("has-model", model !== null);
  els.legendRail.hidden = model === null; // the layout drops the rail column too
  renderImportStatus();
  renderTeamChips(model);
  // Before anything reads `visiblePeople` or `filterActive`: this prunes members
  // the current team selection no longer covers.
  renderMemberChips(model);
  els.exportView.hidden = !filterActive();
  // Same range the heatmap draws, so the two can't name different periods.
  els.viewPeriod.textContent = viewLabel(visibleRange());
  renderTags(model);
  renderWarnings();
  renderHistory();
  renderStrip(model);
  renderHeatmap(model);
  renderCapacity(model);
  renderBalances(model);
  // The year dialog is modal, so nothing on this page can change the model
  // behind it — but another tab saving a leave request can: `storage` fires
  // here and applies it. Left alone, the dialog would go on showing the year as
  // it was before the request landed.
  if (els.yearDialog.open) renderYearSummary();
  saveState();
}

function renderImportStatus() {
  els.year.value = String(state.year);
  // The sample-data offer belongs to the empty state only: once anything real
  // (or the sample itself) is loaded, the drop zone is the way to change data.
  els.demoLoad.hidden = state.model !== null;
  if (state.model === null) {
    els.importStatus.textContent = "Nothing imported yet.";
    els.importUpdated.hidden = true;
    return;
  }
  els.importStatus.textContent = `${
    peopleCount(state.model.people.length)
  } · ${state.model.days.length} days · year ${state.year}`;
  // Absent for a model stored by a build that did not record it — a made-up
  // time would be worse than none, so the line stays away.
  els.importUpdated.hidden = state.updatedAt === null;
  els.importUpdated.textContent = state.updatedAt === null
    ? ""
    : `Updated ${stamp(state.updatedAt)}`;
}

function renderTeamChips(model) {
  els.teamChips.textContent = "";
  if (model === null) return;
  for (const [key, label] of [...teamLabels(model)].sort((a, b) => a[0].localeCompare(b[0]))) {
    const chip = el("button", "chip chip-btn", label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(state.teams.includes(key)));
    if (state.teams.includes(key)) chip.classList.add("is-active");
    chip.addEventListener("click", () => {
      state.teams = state.teams.includes(key)
        ? state.teams.filter((t) => t !== key)
        : [...state.teams, key];
      renderAll();
    });
    els.teamChips.appendChild(chip);
  }
}

/**
 * The selected teams' people, as chips that narrow the view to individuals —
 * one labelled list per team, in the heatmap's own team-then-name order, so two
 * teams' rosters never read as a single merged column of names.
 *
 * Hidden until a team is picked: unfiltered, this is the entire roster, which is
 * what the name filter is for.
 *
 * Also where `state.members` is pruned — deselecting a team must not leave that
 * team's people filtering the view from a control that is no longer on screen.
 */
function renderMemberChips(model) {
  els.memberChips.textContent = "";
  const picked = model === null
    ? []
    : model.people.filter((p) => state.teams.includes(p.team.toLowerCase()));
  // A selected team the current workbook doesn't have (a key left over from
  // another import) leaves nothing to list — the same as no team at all.
  if (picked.length === 0) {
    els.memberField.hidden = true;
    state.members = [];
    return;
  }
  els.memberField.hidden = false;
  const names = new Set(picked.map((p) => p.name));
  state.members = state.members.filter((m) => names.has(m));
  const labels = teamLabels(/** @type {import("./availability.mjs").Model} */ (model));
  for (const key of [...state.teams].sort((a, b) => a.localeCompare(b))) {
    const members = picked
      .filter((p) => p.team.toLowerCase() === key)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (members.length === 0) continue;
    const label = labels.get(key) ?? teamLabel(key);
    const group = el("div", "member-group");
    group.appendChild(el("span", "member-group-label", label));
    const chips = el("div", "chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", `Filter by ${label} member`);
    for (const person of members) {
      const chip = el("button", "chip chip-btn", person.name);
      chip.type = "button";
      const active = state.members.includes(person.name);
      chip.setAttribute("aria-pressed", String(active));
      if (active) chip.classList.add("is-active");
      chip.addEventListener("click", () => {
        state.members = active
          ? state.members.filter((m) => m !== person.name)
          : [...state.members, person.name];
        renderAll();
      });
      chips.appendChild(chip);
    }
    group.appendChild(chips);
    els.memberChips.appendChild(group);
  }
}

function renderTags(model) {
  els.tagList.textContent = "";
  els.bulkTeam.textContent = "";
  if (model === null) return;
  for (const [key, label] of [...teamLabels(model)].sort((a, b) => a[0].localeCompare(b[0]))) {
    const option = el("option", "", label);
    option.value = key;
    els.bulkTeam.appendChild(option);
  }
  const people = [...model.people].sort((a, b) => a.name.localeCompare(b.name));
  for (const person of people) {
    const row = el("div", "tag-row");
    const who = el("span", "tag-who");
    who.append(el("span", "", person.name), el("span", "tag-team", person.team));
    const pair = el("span", "btn-row tag-pair");
    for (const loc of ["VN", "CH"]) {
      const btn = el("button", "btn btn-ghost btn-small", loc);
      btn.type = "button";
      const active = (state.tags[person.name] ?? "VN") === loc;
      if (active) btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", String(active));
      btn.addEventListener("click", () => {
        if (loc === "CH") state.tags[person.name] = "CH";
        else delete state.tags[person.name]; // VN is the default — keep tags sparse
        renderAll();
      });
      pair.appendChild(btn);
    }
    row.append(who, pair);
    els.tagList.appendChild(row);
  }
}

function renderWarnings() {
  const warnings = state.model === null ? [] : state.model.warnings;
  els.warningsDetails.hidden = warnings.length === 0;
  els.warningsSummary.textContent = `Workbook warnings (${warnings.length})`;
  els.warningsList.textContent = "";
  for (const w of warnings) els.warningsList.appendChild(el("li", "", w.message));
}

/**
 * The log of changes other tools recorded here. It answers the question the
 * grid itself cannot — "why does my row say sick leave?" — so each line names
 * the tool that asked and when it was applied.
 */
function renderHistory() {
  els.historyDetails.hidden = state.history.length === 0;
  els.historySummary.textContent = `Recorded changes (${state.history.length})`;
  els.historyList.textContent = "";
  let stale = 0;
  state.history.forEach((entry, index) => {
    const item = el("li");
    const text = el("div", "history-text");
    text.append(el("span", "history-line", historyText(entry)));
    text.append(
      el("span", "history-meta", `${entry.source ?? "another tool"} · ${stamp(entry.at)}`),
    );
    // A record only carries what it overwrote if it was applied by a build that
    // recorded it. Older ones can be deleted but not undone, and saying so on
    // the line beats leaving the user to wonder why the grid did not move.
    const undoable = Object.keys(entry.before ?? {}).length > 0;
    if (!undoable) text.lastChild.textContent += " · can't be undone";
    // The record is the master copy of what this tool wrote; the grid can move
    // out from under it — most often an imported workbook that predates the
    // request. Compared against the raw model, not `displayModel()`, whose
    // holiday overlay would read as a change nobody made. Appended after the
    // meta line above, which edits itself through `lastChild`.
    const standing = state.model === null ? null : recordOnGrid(state.model, entry);
    if (standing !== null && standing.kept < standing.days) {
      stale++;
      item.classList.add("is-stale");
      const lost = standing.days - standing.kept;
      text.append(el(
        "span",
        "history-stale",
        standing.kept === 0
          ? "⚠ no longer on the grid"
          : `⚠ ${lost} of ${standing.days} days no longer on the grid`,
      ));
    }
    const del = el("button", "history-del", "×");
    del.type = "button";
    del.title = undoable
      ? "Delete this record and put those days back"
      : "Delete this record — its days stay as they are";
    del.setAttribute("aria-label", `Delete record: ${historyText(entry)}`);
    del.addEventListener("click", () => deleteHistoryEntry(index));
    item.append(text, del);
    els.historyList.appendChild(item);
  });
  // Said once at the top as well as per record: after an import that wiped
  // several, the panel is the only place the loss is visible at all, and the
  // list can be scrolled past its first entry.
  els.historyWarn.hidden = stale === 0;
  els.historyWarn.textContent = "";
  if (stale > 0) {
    const badge = el("span", "cap-warn-badge");
    badge.append(
      el("span", "cap-warn-mark", "⚠"),
      ` ${stale} of ${state.history.length} not on the grid`,
    );
    badge.title = "These days were written by this tool but the grid no longer shows them — " +
      "usually a workbook imported over them. Re-file the request, or delete the record.";
    els.historyWarn.appendChild(badge);
  }
}

/**
 * Delete one record and undo what it did. Forgetting the log while leaving the
 * days it wrote would make the panel a liar, so the two move together — and
 * because that touches the roster, the toast offers the change back.
 */
function deleteHistoryEntry(index) {
  const entry = state.history[index];
  if (entry === undefined) return;
  const reapply = () => {
    if (state.model === null) return;
    const result = applyDayCodes(state.model, entry);
    if (result.written > 0) state.model = result.model;
    state.history = [...state.history.slice(0, index), entry, ...state.history.slice(index)];
    saveState();
    renderAll();
    toast(`Restored: ${historyText(entry)}`);
  };

  const result = state.model === null ? null : revertDayCodes(state.model, entry);
  if (result !== null && result.restored > 0) state.model = result.model;
  state.history = state.history.filter((_, i) => i !== index);
  saveState();
  renderAll();

  const restored = result?.restored ?? 0;
  const kept = result?.kept ?? 0;
  const what = restored > 0
    ? `Put ${restored} ${restored === 1 ? "day" : "days"} back`
    : "Record deleted — the days were left as they are";
  toast(
    kept > 0 ? `${what} · ${kept} changed since, left alone` : what,
    { label: "Undo", onAction: reapply },
  );
}

/** "26.07 14:32" — local time, since the reader is the person it happened to. */
function stamp(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "unknown time";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderLegend() {
  els.legend.textContent = "";
  for (const [kind, label, codes] of KIND_LEGEND) {
    const row = el("div", "legend-row");
    row.append(
      el("span", `dot dot-${kind}`),
      el("span", "", label),
      el("span", "legend-codes", codes),
    );
    els.legend.appendChild(row);
  }
}

function stripEntryChip(entry, detail, titleDetail) {
  const chip = el("span", "chip strip-chip");
  chip.append(el("span", `dot dot-${entry.kind}`), ` ${entry.name} `);
  chip.append(el("span", "strip-detail", detail ?? entry.label));
  chip.title = `${entry.team} — ${titleDetail ?? detail ?? entry.label}`;
  return chip;
}

/** One chip standing in for a whole public-holiday cohort; names go in the
 *  tooltip, because on a VN holiday there are sixty of them. */
function holidayChip(entries) {
  const chip = el("span", "chip strip-chip");
  chip.append(el("span", "dot dot-holiday"), " Public holiday ");
  chip.append(el("span", "strip-detail", `${entries.length} people`));
  chip.title = entries.map((e) => e.name).join(", ");
  return chip;
}

/**
 * The scannable "27.07 · 8   28.07 · 11" index over the week's by-person
 * chips: how many are out each working day, and a click to report on that day.
 */
function dayIndexRow(model, from, to) {
  const row = el("div", "day-index");
  const current = stripDay();
  for (const entry of dayCounts(model, from, to)) {
    const cell = el("button", "day-index-cell");
    cell.type = "button";
    const allOff = entry.holiday > 0 && entry.count === 0;
    cell.append(
      el("span", "di-day", shortDay(entry.date)),
      el("span", "di-count", allOff ? "hol" : String(entry.count)),
    );
    cell.title = `${prettyDay(entry.date)} — ${entry.count} out` +
      (entry.holiday > 0 ? `, ${entry.holiday} on public holiday` : "") +
      " · click to report on this day";
    if (entry.date === current) cell.classList.add("is-current");
    if (allOff) cell.classList.add("is-holiday");
    cell.addEventListener("click", () => pickDay(entry.date));
    row.appendChild(cell);
  }
  return row;
}

function renderStrip(model) {
  els.strip.textContent = "";
  if (model === null) {
    els.stripStatus.textContent = "";
    els.dayPick.value = "";
    els.dayReset.hidden = true;
    els.strip.appendChild(el("p", "hint", "Import the workbook to see who's out."));
    return;
  }
  const day = stripDay();
  const isToday = day === todayIso();
  const weekend = isWeekend(day);
  const { holiday, other } = splitHoliday(outOn(model, day));
  const away = remoteOn(model, day);
  const to = addDays(day, 6);
  const week = outInRange(model, day, to);
  els.stripStatus.textContent = prettyDay(day);
  els.dayPick.value = day;
  els.dayReset.hidden = isToday;

  // The heading keeps its three parts apart: what it lists, when, how many.
  const section = (label, when, count) => {
    const wrap = el("div", "strip-group");
    const head = el("h3", "strip-title");
    head.append(
      el("span", "st-label", label),
      el("span", "st-when", when),
      el("span", "st-count", `- ${peopleCount(count)}`),
    );
    wrap.appendChild(head);
    els.strip.appendChild(wrap);
    return wrap;
  };
  const chipsIn = (wrap) => {
    const box = el("div", "chips");
    wrap.appendChild(box);
    return box;
  };
  // "today" reads better than the date when it *is* today, which it usually is.
  const when = isToday ? "today" : prettyDay(day);
  const nothingScheduled = () => el("span", "hint", "Weekend — nobody scheduled.");

  const outBox = chipsIn(section("Out", when, holiday.length + other.length));
  if (weekend) outBox.appendChild(nothingScheduled());
  if (holiday.length > HOLIDAY_COLLAPSE_AT) outBox.appendChild(holidayChip(holiday));
  else for (const entry of holiday) outBox.appendChild(stripEntryChip(entry));
  for (const entry of other) outBox.appendChild(stripEntryChip(entry));
  if (!weekend && holiday.length === 0 && other.length === 0) {
    outBox.appendChild(el("span", "hint", "Everyone's available."));
  }

  const awayBox = chipsIn(section("Remote / onsite", when, away.length));
  if (away.length === 0) {
    awayBox.appendChild(weekend ? nothingScheduled() : el("span", "hint", "Nobody remote."));
  }
  for (const entry of away) awayBox.appendChild(stripEntryChip(entry));

  const weekWrap = section("7 days", `${shortDay(day)} – ${shortDay(to)}`, week.length);
  weekWrap.appendChild(dayIndexRow(model, day, to));
  const weekBox = chipsIn(weekWrap);
  if (week.length === 0) weekBox.appendChild(el("span", "hint", "No absences planned."));
  for (const person of week) {
    weekBox.appendChild(stripEntryChip(
      { ...person, kind: person.dates[0].kind },
      outDatesText(person.dates),
      outDatesLabelText(person.dates),
    ));
  }
}

/** The last period + picked day the grid auto-scrolled for. A re-render that
 *  changes neither (a filter keystroke, a chip toggle) must not yank a
 *  manually scrolled grid back to today. */
let scrolledTo = "";

/**
 * Bring the reported-on day's column — or failing that today's — into the
 * wrapper's view when the period or pick changes. Without this, "Today" on a
 * quarter can land the right answer three screens off to the right, and
 * nothing on screen says so.
 */
function scrollDayIntoView() {
  const key = `${state.view.mode}|${state.view.anchor}|${state.pickedDay ?? ""}`;
  if (key === scrolledTo) return;
  scrolledTo = key;
  const target = /** @type {HTMLElement | null} */ (
    els.heatmap.querySelector(".hm-head.is-picked") ??
      els.heatmap.querySelector(".hm-head.is-today")
  );
  if (target === null) return;
  const wrap = els.heatmapWrap;
  // The sticky name column covers the wrapper's left edge, so "visible" starts
  // past it, not at zero.
  const nameW = els.heatmap.querySelector(".hm-corner")?.getBoundingClientRect().width ?? 0;
  const left = target.offsetLeft;
  const inView = left >= wrap.scrollLeft + nameW &&
    left + target.offsetWidth <= wrap.scrollLeft + wrap.clientWidth;
  if (inView) return;
  wrap.scrollLeft = Math.max(0, left - nameW - (wrap.clientWidth - nameW - target.offsetWidth) / 2);
}

function renderHeatmap(model) {
  // Re-rendering replaces every cell, so a keyboard user mid-navigation would
  // lose focus to <body>; only steal it back if they had it to begin with.
  const hadFocus = els.heatmap.contains(document.activeElement);
  els.heatmap.textContent = "";
  if (model === null) {
    gridDims = { rows: 0, cols: 0, dates: [] };
    els.rangeLabel.textContent = "";
    els.heatmap.appendChild(
      el("p", "hint hm-empty", "The heatmap appears here once a workbook is imported."),
    );
    return;
  }
  const dates = visibleRange();
  const people = visiblePeople(model);
  const today = todayIso();
  // The view axis is the whole month or quarter; the data axis is what the
  // workbook covered, and month navigation is not clamped to it. A day in the
  // first but not the second draws a blank cell that looks exactly like a day
  // the workbook left empty — and only one of the two can be marked.
  const imported = new Set(model.days);
  const picked = state.pickedDay;
  // Row -1 is the day-header row; 0.. are people. Clamped every render because
  // filtering and month navigation change the grid under the focused cell.
  if (state.focus === null) state.focus = { row: 0, col: Math.max(0, dates.indexOf(today)) };
  state.focus = {
    row: Math.max(-1, Math.min(people.length - 1, state.focus.row)),
    col: Math.max(0, Math.min(dates.length - 1, state.focus.col)),
  };
  gridDims = { rows: people.length, cols: dates.length, dates };
  hoverCol = null; // the marked cells are about to be replaced
  els.heatmap.style.setProperty("--hm-cols", String(dates.length));
  // The month row is decorative — each day header carries the full date — so it
  // is left out of the a11y tree and out of these counts.
  els.heatmap.setAttribute("aria-rowcount", String(people.length + 1));
  els.heatmap.setAttribute("aria-colcount", String(dates.length + 1));
  const frag = document.createDocumentFragment();

  // Month labels above the day numbers: a 92-column quarter view otherwise
  // gives no clue which month a column belongs to.
  const monthRow = el("div", "hm-row hm-month-row");
  monthRow.setAttribute("role", "presentation");
  monthRow.appendChild(el("div", "hm-corner hm-corner-month"));
  for (const span of monthSpans(dates)) {
    const cell = el("div", "hm-month", span.label);
    cell.style.gridColumn = `span ${span.days}`;
    monthRow.appendChild(cell);
  }
  frag.appendChild(monthRow);

  const head = el("div", "hm-row hm-head-row");
  head.setAttribute("role", "row");
  head.setAttribute("aria-rowindex", "1");
  const corner = el("div", "hm-corner", "Person");
  corner.setAttribute("role", "columnheader");
  corner.setAttribute("aria-colindex", "1");
  head.appendChild(corner);
  dates.forEach((date, col) => {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    const cell = el("div", "hm-head");
    cell.setAttribute("role", "columnheader");
    cell.setAttribute("aria-colindex", String(col + 2));
    // Two letters, not one: a bare "T" is both Tuesday and Thursday.
    cell.append(el("span", "hm-dom", date.slice(8)), el("span", "hm-dow", WEEKDAYS[wd]));
    if (isWeekend(date)) cell.classList.add("is-weekend");
    if (date === today) cell.classList.add("is-today");
    if (date === picked) cell.classList.add("is-picked");
    if (date.endsWith("-01")) cell.classList.add("m-start");
    cell.title = `${prettyDay(date)} — report on this day`;
    cell.setAttribute(
      "aria-label",
      `${prettyDay(date)}${
        date === picked ? ", reporting on this day" : ", press Enter to report"
      }`,
    );
    markFocusable(cell, -1, col);
    cell.addEventListener("click", () => {
      // Clicking a header focuses it, which makes the re-render below put focus
      // back on the grid's tab stop — and that is row 0 of today's column until
      // the grid has been used, so the click would land the caret on a cell in
      // some other column. The pointer moves the tab stop here, exactly as it
      // does for a cell (see the `pointerdown` handler).
      state.focus = { row: -1, col };
      pickDay(date);
    });
    head.appendChild(cell);
  });
  frag.appendChild(head);

  let lastTeam = null;
  people.forEach((person, r) => {
    const row = el("div", "hm-row");
    row.setAttribute("role", "row");
    row.setAttribute("aria-rowindex", String(r + 2));
    // Rows are sorted team-then-name; a rule between teams turns 70 rows into
    // a handful of readable blocks.
    const teamKey = person.team.toLowerCase();
    if (lastTeam !== null && teamKey !== lastTeam) row.classList.add("is-team-start");
    lastTeam = teamKey;
    const name = el("div", "hm-name");
    name.setAttribute("role", "rowheader");
    name.setAttribute("aria-colindex", "1");
    name.dataset.person = person.name;
    name.title = `${person.name} — click for the whole imported year`;
    name.append(el("span", "hm-person", person.name), el("span", "hm-team", person.team));
    if (person.location === "CH") name.appendChild(el("span", "hm-loc", "CH"));
    row.appendChild(name);
    dates.forEach((date, col) => {
      const code = person.days[date];
      const info = code === undefined ? null : codeInfo(code);
      const cell = el("div", "hm-cell");
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-colindex", String(col + 2));
      // Who and when the cell stands for — the selection reads these back.
      cell.dataset.person = person.name;
      cell.dataset.date = date;
      if (code !== undefined) cell.dataset.code = code;
      if (!imported.has(date)) cell.dataset.outside = "1";
      if (info === null) cell.classList.add("is-blank");
      else {
        cell.classList.add(`k-${info.kind}`);
        if (info.half !== null) cell.classList.add(`half-${info.half}`);
      }
      if (date === today) cell.classList.add("is-today");
      if (date === picked) cell.classList.add("is-picked");
      if (date.endsWith("-01")) cell.classList.add("m-start");
      cell.title = `${person.name} — ${prettyDay(date)} — ${
        cellMeaning(info, code, date, person.location, !imported.has(date))
      }`;
      cell.setAttribute("aria-label", `${cell.title}, press Enter to pick for a leave request`);
      markFocusable(cell, r, col);
      row.appendChild(cell);
    });
    frag.appendChild(row);
  });
  els.heatmap.appendChild(frag);
  // The cells are new objects; a selection made before this render needs
  // repainting onto them (a month step or a filter change re-renders).
  paintSelection();
  if (hadFocus) gridCell(state.focus.row, state.focus.col)?.focus();
  scrollDayIntoView();
  els.rangeLabel.textContent = `${dates[0]} → ${dates[dates.length - 1]} · ${
    peopleCount(people.length)
  }`;
}

/**
 * The line beside the capacity heading — the tool's actual conclusion, which
 * the raw numbers only imply. Names the thinnest weeks first, because that is
 * the one a reader wants.
 */
function renderCoverageWarning(low) {
  els.capWarn.textContent = "";
  els.capWarn.hidden = low.length === 0;
  if (low.length === 0) return;
  const worst = [...low].sort((a, b) => a.ratio - b.ratio);
  const badge = el("span", "cap-warn-badge");
  badge.append(
    el("span", "cap-warn-mark", "⚠"),
    ` ${low.length} team-${low.length === 1 ? "week" : "weeks"} below ${state.lowThreshold}%`,
  );
  badge.title = worst
    .map((l) =>
      `${teamLabel(l.team)} ${shortDay(l.from)}: ${trimNumber(l.available)}/${
        trimNumber(l.possible)
      } (${Math.round(l.ratio * 100)}%)`
    )
    .join("\n");
  els.capWarn.appendChild(badge);
  const worstFew = worst.slice(0, 3)
    .map((l) => `${teamLabel(l.team)} ${shortDay(l.from)} (${Math.round(l.ratio * 100)}%)`)
    .join(", ");
  els.capWarn.appendChild(
    el("span", "cap-warn-list", worstFew + (worst.length > 3 ? ", …" : "")),
  );
}

function renderCapacity(model) {
  els.capacity.textContent = "";
  if (model === null) return;
  const weeks = weekSlices(visibleRange());
  const filtered = { ...model, people: visiblePeople(model) };

  const table = el("table", "cap-table");
  const thead = el("thead");
  const headRow = el("tr");
  headRow.append(el("th", "cap-team", "Team"), el("th", "", "People"));
  for (const week of weeks) {
    // Labelled by the week's first *visible* day. Naming a month's edge week
    // after its Monday pointed at a date that isn't on screen — a three-day
    // stub read as "29.06", right next to full weeks.
    const th = el("th", "", shortDay(week.from));
    th.title = `${prettyDay(week.from)} – ${prettyDay(week.to)}` +
      (week.days < 7 ? ` · part week, ${week.days} of 7 days in view` : "");
    if (week.days < 7) th.classList.add("is-partial");
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const grid = capacityGrid(filtered, weeks);
  const threshold = state.lowThreshold / 100;
  const low = lowCoverage(grid, weeks, threshold);
  const lowKeys = new Set(low.map((l) => `${l.team.toLowerCase()}|${l.from}`));
  renderCoverageWarning(low);

  const tbody = el("tbody");
  for (const row of grid) {
    const tr = el("tr");
    tr.append(el("td", "cap-team", teamLabel(row.team)), el("td", "", String(row.members)));
    weeks.forEach((week, i) => {
      const cell = row.cells[i] ?? null;
      // Nothing imported for that week; printing a bare 0 would read as "this
      // team has no capacity at all".
      if (cell === null) {
        const td = el("td", "cap-nodata", "–");
        td.title = "No data imported for this week";
        tr.appendChild(td);
        return;
      }
      const td = el("td");
      const share = Math.round((cell.available / cell.possible) * 100);
      td.append(
        el("span", "cap-have", trimNumber(cell.available)),
        el("span", "cap-of", `/${trimNumber(cell.possible)}`),
      );
      td.title = `${trimNumber(cell.available)} of ${
        trimNumber(cell.possible)
      } person-days available — ${share}%`;
      if (lowKeys.has(`${row.team.toLowerCase()}|${week.from}`)) {
        td.classList.add("is-low");
        td.title += ` · below the ${state.lowThreshold}% mark`;
      } else {
        // Below-full weeks warm up as they approach the threshold, so the
        // table has a shape before anything crosses the hard line. The flagged
        // cells keep their own stronger tint — no double paint.
        const tint = capacityTint(cell.available / cell.possible, threshold);
        if (tint > 0) {
          td.classList.add("has-tint");
          td.style.setProperty("--cap-tint", `${tint}%`);
        }
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  // The "Everyone" sum — one team alone would only repeat its own row.
  if (grid.length > 1) {
    const totals = capacityTotals(grid, weeks.length);
    const tfoot = el("tfoot");
    const totalRow = el("tr");
    totalRow.append(el("td", "cap-team", "Everyone"), el("td", "", String(totals.members)));
    weeks.forEach((_week, index) => {
      const sum = totals.cells[index];
      if (sum === null) {
        const td = el("td", "cap-nodata", "–");
        td.title = "No data imported for this week";
        totalRow.appendChild(td);
        return;
      }
      const td = el("td");
      td.append(
        el("span", "cap-have", trimNumber(sum.available)),
        el("span", "cap-of", `/${trimNumber(sum.possible)}`),
      );
      td.title = `${trimNumber(sum.available)} of ${
        trimNumber(sum.possible)
      } person-days available across every visible team`;
      totalRow.appendChild(td);
    });
    tfoot.appendChild(totalRow);
    table.appendChild(tfoot);
  }
  els.capacity.appendChild(table);
}

/** The capacity table as text on the clipboard — the standup artefact. */
async function copyCapacity() {
  const model = displayModel();
  if (model === null) {
    toast("Import the workbook first");
    return;
  }
  const weeks = weekSlices(visibleRange());
  const grid = capacityGrid({ ...model, people: visiblePeople(model) }, weeks);
  try {
    await navigator.clipboard.writeText(capacityText(grid, weeks));
    toast("Capacity table copied");
  } catch {
    toast("Could not copy — clipboard unavailable");
  }
}

/**
 * The balance table's columns, in the sheet's own order: what the year counts,
 * then what is left of it. The heading of the carry-over column is the previous
 * year, exactly as the sheet heads it — the workbook year is what the rest of
 * the page already runs on, so it needs no separate plumbing. Each column
 * carries the phrase its cells' tooltips use, since a bare `2025` above a
 * column of small numbers says nothing on its own.
 *
 * `kind` names the day code behind the number for the columns the grid can show
 * its working for — see {@link balanceDetail}.
 */
function balanceColumns() {
  const previous = state.year - 1;
  return [
    { key: "working", head: "Working", what: "working days" },
    { key: "carry", head: String(previous), what: `days carried over from ${previous}` },
    { key: "allowance", head: "Annual", what: "annual leave for the year" },
    { key: "planned", head: "Planned", what: "planned days", kind: "planned" },
    { key: "dayOffs", head: "Day offs", what: "days taken", kind: "leave" },
    { key: "annual", head: "Annual", what: "annual leave left", left: true },
    { key: "core", head: "Core", what: "core leave left", kind: "core" },
    { key: "sick", head: "Sick", what: "sick leave left", kind: "sick" },
  ];
}

/** How many leading columns of {@link balanceColumns} are counted days rather
 *  than remainders — the span of the "Recorded" group header. */
const BALANCE_RECORDED = 5;

/** How many absences a breakdown tooltip spells out before it stops naming them
 *  — a year of single days would otherwise run off the screen. */
const BALANCE_DETAIL_RANGES = 8;

/**
 * The workbook days behind one balance number, for the columns that have day
 * codes to point at: which absences the person actually recorded, grouped the
 * way the year dialog groups them.
 *
 * Deliberately counted over the imported days rather than the year — a quarter
 * import cannot add up to a whole-year balance — so the line says which days it
 * counted instead of implying the two numbers must agree. For `Core` and `Sick`
 * they cannot agree in any case: the column is what is *left*, the breakdown is
 * what was taken.
 *
 * @param {ReturnType<typeof personSummary>} summary
 * @param {ReturnType<typeof balanceColumns>[number]} column
 */
function balanceDetail(summary, column) {
  if (column.kind === undefined || summary === null) return "";
  const label = KIND_LABELS[column.kind];
  const ranges = summary.ranges.filter((r) => r.kind === column.kind);
  if (ranges.length === 0) return `\n\nNo ${label.toLowerCase()} on the imported days.`;
  const total = summary.kinds.find((k) => k.kind === column.kind)?.days ?? 0;
  const lines = ranges.slice(0, BALANCE_DETAIL_RANGES).map((range) =>
    `${shortDay(range.from)}${range.from === range.to ? "" : `–${shortDay(range.to)}`} ` +
    `${range.label} · ${dayCount(range.days)}`
  );
  const rest = ranges.length - lines.length;
  if (rest > 0) lines.push(`+ ${rest} more`);
  return `\n\n${label} on the imported days — ${dayCount(total)}\n${lines.join("\n")}`;
}

/** One balance cell: the number, or an explicit "not recorded" dash. Negative
 *  is not a rendering accident — that allowance is overdrawn. */
function balanceCell(value, column, summary) {
  const detail = balanceDetail(summary, column);
  if (value === null || value === undefined) {
    const td = el("td", "cap-nodata", "–");
    td.title = `${column.what}: not recorded${detail}`;
    if (column.left) td.classList.add("bal-sep");
    if (detail !== "") td.classList.add("bal-detail");
    return td;
  }
  const td = el("td", "bal-num", trimNumber(value));
  td.title = `${column.what}: ${trimNumber(value)}` + (value < 0 ? " — overdrawn" : "") + detail;
  if (value < 0) td.classList.add("is-neg");
  if (column.left) td.classList.add("bal-sep");
  if (detail !== "") td.classList.add("bal-detail");
  return td;
}

/**
 * The year's leave accounting per person, from the workbook's "General" sheet:
 * the days it counts (working, carried over, the annual allowance, planned and
 * taken) beside what is left of each allowance. Unlike everything else on this
 * page the numbers are the whole year's, not the visible period's — the heading
 * says so, and the table deliberately has no week columns to suggest otherwise.
 *
 * The two groups share one header row because the sheet's own arithmetic ties
 * them together (`Annual left = carried over + allowance − planned − taken`),
 * and `Annual` heads a column in each — which is precisely why the group
 * headings above them are not decoration.
 *
 * Follows the team/name filter and its sort, so it reads as the heatmap's own
 * roster. Hidden outright when nothing carried a balance (the CSV path imports
 * quarter grids only): an empty table would read as "everyone is at zero".
 */
function renderBalances(model) {
  els.balances.textContent = "";
  const people = model === null
    ? []
    : visiblePeople(model).filter((p) => p.balance !== undefined && p.balance !== null);
  els.balTitle.hidden = people.length === 0;
  els.balances.hidden = people.length === 0;
  if (people.length === 0) return;
  const columns = balanceColumns();

  const table = el("table", "cap-table bal-table");
  const thead = el("thead");
  const groupRow = el("tr");
  const who = el("th", "bal-who", "Person");
  const team = el("th", "bal-team", "Team");
  for (const cell of [who, team]) cell.rowSpan = 2;
  const recorded = el("th", "bal-group", "Recorded");
  recorded.colSpan = BALANCE_RECORDED;
  const remaining = el("th", "bal-group bal-sep", "Remaining");
  remaining.colSpan = columns.length - BALANCE_RECORDED;
  groupRow.append(who, team, recorded, remaining);
  const headRow = el("tr");
  for (const column of columns) {
    const classes = [column.left ? "bal-sep" : "", column.kind === undefined ? "" : "bal-detail"];
    const th = el("th", classes.filter((c) => c !== "").join(" "), column.head);
    th.title = column.kind === undefined
      ? column.what
      : `${column.what} — hover a cell for the days behind it`;
    headRow.appendChild(th);
  }
  thead.append(groupRow, headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const person of people) {
    const tr = el("tr");
    tr.append(el("td", "bal-who", person.name), el("td", "bal-team", teamLabel(person.team)));
    // One summary per person, shared by the columns that break down — it walks
    // the whole imported axis, so doing it per cell would walk it three times.
    const summary = personSummary(model, person.name);
    for (const column of columns) {
      tr.appendChild(balanceCell(person.balance[column.key], column, summary));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const totals = balanceTotals(people);
  const tfoot = el("tfoot");
  const totalRow = el("tr");
  totalRow.append(
    el("td", "bal-who", "Total"),
    el("td", "bal-team", peopleCount(totals.people)),
  );
  for (const column of columns) {
    const td = el("td", "bal-num", trimNumber(totals[column.key]));
    if (column.left) td.classList.add("bal-sep");
    totalRow.appendChild(td);
  }
  tfoot.appendChild(totalRow);
  table.appendChild(tfoot);
  els.balances.appendChild(table);
}

/* --------------------- one person's imported year --------------------- */

/**
 * The leave types the year dialog hides until asked. WFH is not an absence at
 * all, and every VN row carries the same handful of public-holiday runs — left
 * ticked, the two of them bury the days someone actually took off. They stay in
 * the chips and the month bars, which are the whole person by design.
 */
const YEAR_KINDS_OFF = ["remote", "holiday"];
/** Types currently unticked. Off is what's remembered rather than on, so a type
 *  the current person happens not to have keeps its state for the next one. */
let yearKindsOff = new Set(YEAR_KINDS_OFF);

/** "1 day" / "8 days" / "0.5 days" — half-day counts are never singular. */
function dayCount(days) {
  return `${trimNumber(days)} ${days === 1 ? "day" : "days"}`;
}

/** The person whose row holds the grid's tab stop, or null — the focus starts
 *  on the header row, which is nobody. */
function focusedPerson() {
  const model = displayModel();
  if (model === null || state.focus === null || state.focus.row < 0) return null;
  return visiblePeople(model)[state.focus.row]?.name ?? null;
}

/**
 * Open the year dialog on `name`. The roster it offers is the visible one, so
 * the dialog stays inside whatever the filters have narrowed the page to, and
 * the person is a control rather than a heading because the grid's names are
 * rowheaders outside its roving tabindex — the select is the keyboard way in.
 */
function openYearSummary(name) {
  const model = displayModel();
  if (model === null) {
    toast("Import a workbook first — there is no year to summarise yet");
    return;
  }
  const people = visiblePeople(model);
  if (people.length === 0) {
    toast("Nobody is visible — clear the team or name filter first");
    return;
  }
  els.yearPerson.replaceChildren(...people.map((p) => new Option(p.name, p.name)));
  els.yearPerson.value = people.some((p) => p.name === name) ? name : people[0].name;
  renderYearSummary(true); // a fresh open shows everything, whatever the last one filtered to
  els.yearDialog.showModal();
}

/**
 * Fill the dialog from the picked person — also the select's change handler, so
 * flipping between people re-renders in place.
 *
 * The chips and the absence list count in code shares ("8 days WFH"), while the
 * totals line counts availability, so the two deliberately disagree: WFH costs
 * no availability but is still a day worth naming. The line spells out which
 * number it is rather than leaving the reader to reconcile them.
 *
 * @param {boolean} [reset] drop the leave-type filter — what a fresh open wants,
 *   where switching person mid-dialog keeps whatever kind is being read.
 */
function renderYearSummary(reset) {
  const model = displayModel();
  const summary = model === null ? null : personSummary(model, els.yearPerson.value);
  if (summary === null) {
    // Only reachable from `renderAll`, when an import that replaced the roster
    // took this person with it. Showing their old year over the new data would
    // be a lie; closing says what happened.
    if (els.yearDialog.open) {
      els.yearDialog.close();
      toast(`${els.yearPerson.value} is not in the imported data any more`);
    }
    return;
  }
  renderYearKinds(summary, reset === true);

  const where = summary.location === "CH" ? " · CH" : "";
  els.yearTotals.textContent = summary.possible === 0
    ? `${teamLabel(summary.team)}${where} — no days imported for this person`
    : `${teamLabel(summary.team)}${where} — ${trimNumber(summary.out)} of ${summary.possible} ` +
      `days out, ${trimNumber(summary.worked)} worked`;

  els.yearKinds.replaceChildren(
    ...summary.kinds.map((kind) => {
      const chip = el("span", "chip");
      chip.append(
        el("span", `dot dot-${kind.kind}`),
        ` ${kind.label} `,
        el("span", "strip-detail", dayCount(kind.days)),
      );
      return chip;
    }),
  );
  els.yearKinds.hidden = summary.kinds.length === 0;

  // Bars scale against the heaviest month rather than against the month's own
  // length: the question a distribution answers is which month was the busy
  // one, and a percentage-of-month bar flattens that out. They count what the
  // chips count, so a month of remote work is not drawn as an empty one.
  const worst = Math.max(0, ...summary.months.map((m) => m.days));
  els.yearMonths.replaceChildren(
    ...summary.months.map((month) => {
      const cell = el("div", "year-month");
      const bar = el("div", "year-bar");
      bar.style.setProperty("--h", String(worst === 0 ? 0 : (month.days / worst) * 100));
      cell.append(bar, el("span", "year-month-label", month.label.slice(0, 3)));
      cell.title = `${month.label} — ${dayCount(month.days)} recorded, ` +
        `${trimNumber(month.out)} of ${month.possible} out`;
      return cell;
    }),
  );

  renderYearRanges(summary);
}

/** The absence list, filtered to the ticked types — the only part a type toggle
 *  redraws, so ticking one does not pull the focus off the box you ticked. */
function renderYearRanges(summary) {
  const ranges = summary.ranges.filter((r) => !yearKindsOff.has(r.kind));
  els.yearRanges.replaceChildren(
    ...ranges.map((range) => {
      const item = el("li", "year-range");
      item.append(
        el("span", `dot dot-${range.kind}`),
        el(
          "span",
          "year-range-days",
          range.from === range.to
            ? shortDay(range.from)
            : `${shortDay(range.from)}–${shortDay(range.to)}`,
        ),
        el("span", "year-range-label", range.label),
        el("span", "strip-detail", trimNumber(range.days)),
      );
      return item;
    }),
  );
  if (ranges.length === 0) {
    // Two quite different empty lists: one the workbook explains, one the
    // reader's own filter does — and only the second has an obvious fix.
    els.yearRanges.appendChild(el(
      "li",
      "hint",
      summary.ranges.length === 0
        ? "Nothing recorded on the imported days."
        : "Nothing of the ticked types — tick another above.",
    ));
  }
}

/**
 * Refill the type toggles from the kinds this person actually has, so no box
 * leads anywhere empty. What is *off* is what's remembered, in `yearKindsOff`:
 * a person without sick days must not silently re-tick sick leave for the next
 * person who has it.
 *
 * @param {NonNullable<ReturnType<typeof personSummary>>} summary
 * @param {boolean} reset
 */
function renderYearKinds(summary, reset) {
  if (reset) yearKindsOff = new Set(YEAR_KINDS_OFF);
  els.yearKind.replaceChildren(
    ...summary.kinds.map((kind) => {
      const label = el("label", "year-kind-toggle");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = kind.kind;
      box.checked = !yearKindsOff.has(kind.kind);
      box.addEventListener("change", () => {
        if (box.checked) yearKindsOff.delete(kind.kind);
        else yearKindsOff.add(kind.kind);
        const model = displayModel();
        const current = model === null ? null : personSummary(model, els.yearPerson.value);
        if (current !== null) renderYearRanges(current);
      });
      label.append(box, el("span", `dot dot-${kind.kind}`), ` ${kind.label}`);
      return label;
    }),
  );
}

/* ------------------------------- imports ------------------------------- */

/**
 * Adopt a freshly parsed model. The workbook is a whole year and `replace`s;
 * every partial payload (a CSV quarter, a JSON export, a share link) merges by
 * name, so importing one team's slice never drops the rest of the roster.
 * Either way the view is pulled onto data that exists.
 *
 * @param {ReturnType<typeof parseVacationWorkbook>} incoming
 * @param {number} year @param {boolean} replace
 */
function adoptModel(incoming, year, replace) {
  state.model = replace || state.model === null ? incoming : mergeModels(state.model, incoming);
  state.year = year;
  state.updatedAt = Date.now();
  state.view.anchor = clampAnchor(state.view.anchor, state.model.days);
  state.pickedDay = null; // the old pick may not exist in the new data
  // Changes queued by Leave Request wait for a roster to write into, so the
  // import that finally provides one is when they apply.
  applyQueuedUpdates();
}

/** "1 person" / "7 people" — import toasts routinely carry a count of one. */
function peopleCount(n) {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** Send a dropped or chosen file to the importer its extension implies — the
 *  drop zone used to hand a .json export straight to the zip reader. */
function routeFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) return importJsonFile(file);
  if (name.endsWith(".csv")) return importCsvFile(file);
  if (name.endsWith(".xlsx")) return importWorkbookFile(file);
  toast(`Don't know how to read ${file.name} — drop an .xlsx, .csv or .json`);
}

async function importWorkbookFile(file) {
  const loaded = state.model === null ? 0 : state.model.people.length;
  if (loaded > 0) {
    const ok = await confirmDialog({
      title: "Replace the imported data?",
      text: `${file.name} replaces the ${peopleCount(loaded)} already loaded — ` +
        "a workbook covers the whole year, so it replaces rather than merges.",
      action: "Replace",
      danger: true,
    });
    if (!ok) return;
  }
  els.importStatus.textContent = `Parsing ${file.name}…`;
  try {
    const sheets = await readWorkbook(await file.arrayBuffer());
    const year = yearFromFilename(file.name) ?? (Number(els.year.value) || state.year);
    const model = parseVacationWorkbook(sheets, { year });
    adoptModel(model, year, true);
    toast(
      `Imported ${peopleCount(model.people.length)}` +
        (model.warnings.length > 0 ? ` · ${model.warnings.length} warnings` : ""),
    );
  } catch (err) {
    toast(`Import failed: ${err instanceof Error ? err.message : err}`);
  }
  renderAll();
}

/**
 * Import one quarter of CSV; the panel's quarter picker says which.
 * @returns {boolean} whether it parsed — the paste box only clears on success.
 */
function importCsvText(text) {
  if (text.trim() === "") {
    toast("Paste a quarter sheet as CSV first");
    return false;
  }
  let ok = false;
  try {
    const quarter = Number(els.csvQuarter.value);
    const year = Number(els.year.value) || state.year;
    const incoming = parseQuarterCsv(text, { year, quarter });
    // A sheet without the `No. + h w v p c s r` header parses to nobody rather
    // than throwing — reporting that as an import would be a false success.
    if (incoming.people.length === 0) {
      throw new Error("no roster rows found — is this a quarter sheet?");
    }
    adoptModel(incoming, year, false);
    toast(`Imported Q${quarter} (${peopleCount(incoming.people.length)})`);
    ok = true;
  } catch (err) {
    toast(`CSV import failed: ${err instanceof Error ? err.message : err}`);
  }
  renderAll();
  return ok;
}

async function importCsvFile(file) {
  importCsvText(await file.text());
}

function importCsv() {
  if (importCsvText(els.csvText.value)) els.csvText.value = "";
}

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportJson() {
  if (state.model === null) {
    toast("Nothing to export yet");
    return;
  }
  downloadJson(
    { v: 1, year: state.year, tags: state.tags, model: packModel(state.model) },
    `availability-${state.year}.json`,
  );
}

/** Is the heatmap currently narrowed by a team, member or name filter? */
function filterActive() {
  return state.teams.length > 0 || state.members.length > 0 || state.nameFilter.trim() !== "";
}

/**
 * Export only the people the current filter shows — e.g. one team's slice for
 * its lead. Tags are pruned to the included people so a slice never carries
 * the rest of the roster's names.
 */
function exportViewJson() {
  if (state.model === null || !filterActive()) {
    toast("Filter by team or name first");
    return;
  }
  const people = visiblePeople(state.model);
  if (people.length === 0) {
    toast("Nothing matches the current filter");
    return;
  }
  const names = new Set(people.map((p) => p.name));
  const tags = Object.fromEntries(
    Object.entries(state.tags).filter(([name]) => names.has(name)),
  );
  const slug = state.teams.length > 0
    ? state.teams.map((t) => t.replace(/[^a-z0-9]+/gi, "-")).join("+").slice(0, 40)
    : "filtered";
  downloadJson(
    {
      v: 1,
      year: state.year,
      tags,
      model: packModel({ people, days: state.model.days, warnings: state.model.warnings }),
    },
    `availability-${state.year}-${slug}.json`,
  );
  toast(`Exported ${peopleCount(people.length)} (current view)`);
}

/**
 * Copy a link that carries the current view's data in its URL fragment.
 * Fragments are never sent in HTTP requests, so nothing reaches the (public)
 * host — but the link itself is the data: whoever holds it can read it.
 */
async function copyShareLink() {
  if (state.model === null) {
    toast("Import the workbook first");
    return;
  }
  const people = visiblePeople(state.model);
  if (people.length === 0) {
    toast("Nothing matches the current filter");
    return;
  }
  const names = new Set(people.map((p) => p.name));
  const tags = Object.fromEntries(
    Object.entries(state.tags).filter(([name]) => names.has(name)),
  );
  const payload = {
    v: 1,
    year: state.year,
    tags,
    // Warnings describe the original workbook — noise for a recipient.
    model: packModel({ people, days: state.model.days, warnings: [] }),
  };
  const url = `${location.origin}${location.pathname}#share=${await encodeShare(payload)}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    toast("Could not copy — clipboard unavailable");
    return;
  }
  const kb = (url.length / 1024).toFixed(1);
  const scope = people.length === state.model.people.length ? "everyone" : "current view";
  const size = url.length > 8000 ? ` · long link (${kb} KB), some apps truncate` : ` · ${kb} KB`;
  toast(`Link copied — ${people.length} people (${scope})${size}. Anyone with it can read them.`);
}

/**
 * The share payload waiting on the banner's Load button, or null. Held here
 * rather than resolved inline because the question is answered by a DOM click
 * now: a native `confirm()` blocks the renderer and can only be dismissed by
 * hand, which made the scheduled workbook refresh impossible to finish.
 */
let pendingShare = null;

/** Offer the payload an opened `#share=` link carries, for review. */
async function consumeShareFragment() {
  const match = /^#share=(.+)$/.exec(location.hash);
  if (match === null) return;
  const payload = await decodeShare(match[1]);
  const model = payload === null ? null : unpackModel(payload.model);
  if (model === null || model.people.length === 0) {
    toast("This share link is corrupted or from a newer version");
    return;
  }
  // A whole-workbook refresh sets `replace`; a shared slice leaves it off and
  // merges, so one team's export can never wipe the roster it lands in.
  const replace = payload.replace === true;
  const teams = [...new Set(model.people.map((p) => p.team).filter((t) => t !== ""))];
  const who = teams.length > 0 ? ` (${teams.slice(0, 6).join(", ")})` : "";
  pendingShare = { model, payload, replace };
  // `?auto=1` takes the payload without asking — the unattended refresh has
  // nobody to click Load. It lives in the query string, not inside the opaque
  // payload, so a recipient can see it on the link and strip it.
  if (new URLSearchParams(location.search).get("auto") === "1") {
    acceptShare();
    return;
  }
  els.shareOfferText.textContent =
    `This link carries availability for ${peopleCount(model.people.length)}${who}. ` +
    (replace
      ? "Loading it replaces the data in this browser; your location tags are kept."
      : "Loading it merges into the data already in this browser.");
  els.shareOfferLoad.textContent = replace ? "Replace" : "Merge";
  els.shareOffer.hidden = false;
  els.shareOfferLoad.focus();
}

/** Take the offered payload. */
function acceptShare() {
  if (pendingShare === null) return;
  const { model, payload, replace } = pendingShare;
  pendingShare = null;
  els.shareOffer.hidden = true;
  // Only drop the fragment once it has actually been taken. Clearing it before
  // the question left a declined link with nothing to retry or bookmark. `auto`
  // goes with it, so a link pasted into this tab afterwards is still asked about.
  const params = new URLSearchParams(location.search);
  params.delete("auto");
  const query = params.size > 0 ? `?${params}` : "";
  history.replaceState(null, "", location.pathname + query);
  adoptModel(model, Number.isInteger(payload.year) ? payload.year : state.year, replace);
  if (payload.tags && typeof payload.tags === "object") {
    state.tags = { ...state.tags, ...payload.tags };
  }
  toast(`${replace ? "Loaded" : "Merged"} ${peopleCount(model.people.length)} from the link`);
  renderAll();
}

/** Decline it — the fragment stays put so the link can still be retried. */
function discardShare() {
  pendingShare = null;
  els.shareOffer.hidden = true;
}

function importJsonFile(file) {
  file.text().then((text) => {
    try {
      const payload = JSON.parse(text);
      const model = unpackModel(payload.model);
      if (model === null) throw new Error("not an availability export");
      // Merged, not replaced: an "Export view" slice is one team out of many,
      // and it must not wipe the roster it is imported into.
      adoptModel(model, Number.isInteger(payload.year) ? payload.year : state.year, false);
      if (payload.tags && typeof payload.tags === "object") {
        state.tags = { ...state.tags, ...payload.tags };
      }
      toast(`Merged ${peopleCount(model.people.length)} from ${file.name}`);
    } catch (err) {
      toast(`Import failed: ${err instanceof Error ? err.message : err}`);
    }
    renderAll();
  });
}

/* ------------------------------- wiring ------------------------------- */

els.dropZone.addEventListener("click", () => els.fileInput.click());
els.dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});
["dragover", "dragenter"].forEach((type) =>
  els.dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("is-drag");
  })
);
["dragleave", "drop"].forEach((type) =>
  els.dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("is-drag");
  })
);
els.dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) routeFile(file);
});
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  if (file) routeFile(file);
  els.fileInput.value = "";
});
els.csvImport.addEventListener("click", importCsv);

els.year.addEventListener("change", () => {
  const year = Number(els.year.value);
  if (Number.isInteger(year) && year >= 2000 && year <= 2100) {
    state.year = year;
    renderAll(); // the status line reports the year — saveState alone left it stale
  }
});

els.shareOfferLoad.addEventListener("click", acceptShare);
els.shareOfferDiscard.addEventListener("click", discardShare);
els.shareOffer.addEventListener("keydown", (e) => {
  if (e.key === "Escape") discardShare();
});

// Wrapped, not passed straight in: the handler's Event argument would land on
// `reset` and clear the leave-type filter on every change.
els.yearPerson.addEventListener("change", () => renderYearSummary());

// Delegated, not per row: every filter change and month step rebuilds the rows,
// and a listener bound in `renderHeatmap` would be re-attached on each of them.
els.heatmap.addEventListener("click", (event) => {
  const name = /** @type {HTMLElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.(".hm-name") ?? null
  );
  if (name?.dataset.person !== undefined) openYearSummary(name.dataset.person);
});

els.heatmap.addEventListener("keydown", onGridKeydown);
els.heatmap.addEventListener("pointerover", (event) => {
  const cell = /** @type {HTMLElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.("[data-c]") ?? null
  );
  setHoverColumn(cell === null ? null : cell.dataset.c);
});
els.heatmap.addEventListener("pointerleave", () => setHoverColumn(null));

/**
 * Drag along one person's row to pick a run of days. The move/up listeners sit
 * on `document`, not on the cell: the pointer regularly leaves the grid on the
 * way to the last column, and a drag that ends out there must still commit.
 */
function onDragMove(event) {
  const cell = event.target?.closest?.(".hm-cell") ?? null;
  // Leaving the row ends nothing — it just stops widening, so a wobble upwards
  // mid-drag does not silently retarget the request at the person above.
  if (cell !== null && cell.dataset.person === state.sel?.name) dragTo(cell);
}
function onDragEnd() {
  document.removeEventListener("pointermove", onDragMove);
}

/** True while a long-press drag owns the touch. The non-passive `touchmove`
 *  handler below suppresses scrolling only then — ordinary panning over the
 *  grid stays the browser's (see the `touch-action` rule in the stylesheet). */
let touchDragging = false;
/** How long a touch must hold still before it becomes a drag, in ms. */
const TOUCH_DRAG_MS = 350;
els.heatmap.addEventListener("touchmove", (event) => {
  if (touchDragging) event.preventDefault();
}, { passive: false });

/**
 * A touch on a cell: a plain tap picks the one day, holding still for a beat
 * starts a drag along the row — and moving early is a pan, which the browser
 * keeps. Mouse users get the immediate drag below; a finger can't be asked to
 * tell "drag to select" from "drag to scroll" without the hold.
 */
function onTouchDown(cell, event) {
  const startX = event.clientX;
  const startY = event.clientY;
  const timer = setTimeout(() => {
    touchDragging = true;
    selectCell(cell, false);
    document.addEventListener("pointermove", onDragMove);
  }, TOUCH_DRAG_MS);
  const settle = () => {
    clearTimeout(timer);
    document.removeEventListener("pointermove", watchMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", settle);
    touchDragging = false;
    onDragEnd();
  };
  const watchMove = (e) => {
    // Moving before the hold completes means a pan — stand down and let it be.
    if (!touchDragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) settle();
  };
  const onUp = () => {
    if (!touchDragging) selectCell(cell, false); // a plain tap picks one day
    settle();
  };
  document.addEventListener("pointermove", watchMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", settle);
}

els.heatmap.addEventListener("pointerdown", (event) => {
  const cell = /** @type {HTMLElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.(".hm-cell") ?? null
  );
  if (cell === null || event.button !== 0) return;
  if (event.pointerType === "touch") {
    onTouchDown(cell, event); // no preventDefault — panning stays native
    return;
  }
  event.preventDefault(); // a drag across cells would otherwise select their text
  selectCell(cell, event.shiftKey);
  // preventDefault took the click's focus with it; the grid's tab stop follows
  // the pointer so the arrow keys carry on from where the drag started.
  const previous = state.focus;
  state.focus = { row: Number(cell.dataset.r), col: Number(cell.dataset.c) };
  moveGridFocus(previous);
  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", onDragEnd, { once: true });
});
els.sendLeave.addEventListener("click", sendToLeave);
els.selClear.addEventListener("click", () => setSelection(null));
els.copyCapacity.addEventListener("click", copyCapacity);
els.demoLoad.addEventListener("click", () => {
  const year = new Date().getFullYear();
  adoptModel(demoModel(year), year, true);
  // The CH team's tags drive the location badge and the Zürich holiday
  // overlay — the same path a real import's manual tagging takes.
  for (const person of state.model?.people ?? []) {
    if (person.team === DEMO_CH_TEAM) state.tags[person.name] = "CH";
  }
  toast(
    `Loaded ${peopleCount(state.model?.people.length ?? 0)} of sample data — ` +
      "drop a real workbook any time",
  );
  renderAll();
});

/** Overlay per-kind patterns on the day hues — hue alone fails colour-blind
 *  readers. One class on <body>; the stylesheet does the rest. */
function applyPatterns() {
  document.body.classList.toggle("av-patterns", state.patterns);
  els.patternToggle.checked = state.patterns;
}
els.patternToggle.addEventListener("change", () => {
  state.patterns = els.patternToggle.checked;
  applyPatterns();
  saveState();
});

// Touch has no hover, and this page explains itself through tooltips — so on
// coarse pointers a tap surfaces the same text in the toast. Delegated once;
// mouse users keep their tooltips without hearing everything twice.
if (matchMedia("(pointer: coarse)").matches) {
  document.addEventListener("click", (event) => {
    const holder = /** @type {HTMLElement | null} */ (
      /** @type {HTMLElement} */ (event.target).closest?.(
        ".hm-cell[title], .hm-head[title], .cap-table td[title], .cap-table th[title], " +
          ".cap-warn-badge[title]",
      ) ?? null
    );
    if (holder !== null && holder.title !== "") toast(holder.title);
  });
}
els.historyClear.addEventListener("click", () => {
  if (state.history.length === 0) return;
  // The days themselves stay: this forgets the log, not the leave. Nothing on
  // the grid moves, so putting the log back is the whole of the undo — and the
  // records are the only copy of what wrote those days, so one misplaced click
  // must not be the end of them.
  const cleared = state.history;
  state.history = [];
  renderHistory();
  saveState();
  toast(
    `${cleared.length} ${cleared.length === 1 ? "record" : "records"} forgotten — ` +
      "the days themselves are unchanged",
    {
      label: "Undo",
      onAction: () => {
        // Whatever arrived while the toast was up stays: a request applied in
        // the meantime is newer than anything being restored.
        state.history = [...state.history, ...cleared].slice(0, HISTORY_LIMIT);
        renderHistory();
        saveState();
        toast(`${cleared.length} ${cleared.length === 1 ? "record" : "records"} back`);
      },
    },
  );
});

els.lowThreshold.addEventListener("input", () => {
  const percent = Number(els.lowThreshold.value);
  if (!Number.isFinite(percent)) return;
  state.lowThreshold = Math.max(0, Math.min(100, Math.round(percent)));
  els.lowThresholdOut.textContent = state.lowThreshold === 0 ? "off" : `${state.lowThreshold}%`;
  renderCapacity(displayModel());
  saveState();
});

els.dayPick.addEventListener("change", () => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(els.dayPick.value)) pickDay(els.dayPick.value);
});
els.dayReset.addEventListener("click", () => pickDay(todayIso()));

function setViewMode(mode) {
  state.view.mode = mode;
  els.viewMonth.classList.toggle("is-active", mode === "month");
  els.viewMonth.setAttribute("aria-pressed", String(mode === "month"));
  els.viewQuarter.classList.toggle("is-active", mode === "quarter");
  els.viewQuarter.setAttribute("aria-pressed", String(mode === "quarter"));
  renderAll();
}
els.viewMonth.addEventListener("click", () => setViewMode("month"));
els.viewQuarter.addEventListener("click", () => setViewMode("quarter"));

function shiftAnchor(months) {
  const year = Number(state.view.anchor.slice(0, 4));
  const month = Number(state.view.anchor.slice(5, 7)) - 1 + months;
  const shifted = new Date(Date.UTC(year, month, 1));
  state.view.anchor = shifted.toISOString().slice(0, 10);
  renderAll();
}
els.navPrev.addEventListener("click", () => shiftAnchor(state.view.mode === "month" ? -1 : -3));
els.navNext.addEventListener("click", () => shiftAnchor(state.view.mode === "month" ? 1 : 3));
els.navToday.addEventListener("click", () => {
  state.view.anchor = todayIso();
  renderAll();
});

// Debounced: each keystroke otherwise rebuilds the full grid — ~6,600 elements
// in quarter view — plus two tables, several times per word.
let nameFilterTimer = 0;
els.nameFilter.addEventListener("input", () => {
  clearTimeout(nameFilterTimer);
  nameFilterTimer = setTimeout(() => {
    state.nameFilter = els.nameFilter.value;
    els.exportView.hidden = !filterActive();
    const model = displayModel();
    renderHeatmap(model);
    renderCapacity(model);
    renderBalances(model);
  }, 150);
});

els.bulkVn.addEventListener("click", () => bulkTag("VN"));
els.bulkCh.addEventListener("click", () => bulkTag("CH"));
function bulkTag(loc) {
  if (state.model === null) return;
  const key = els.bulkTeam.value;
  for (const person of state.model.people) {
    if (person.team.toLowerCase() !== key) continue;
    if (loc === "CH") state.tags[person.name] = "CH";
    else delete state.tags[person.name];
  }
  renderAll();
}

els.exportJson.addEventListener("click", exportJson);
els.exportView.addEventListener("click", exportViewJson);
els.shareLink.addEventListener("click", copyShareLink);
els.importJson.addEventListener("click", () => els.jsonInput.click());
els.jsonInput.addEventListener("change", () => {
  const file = els.jsonInput.files?.[0];
  if (file) importJsonFile(file);
  els.jsonInput.value = "";
});
els.clearData.addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Clear this browser's data?",
    text: "Forgets the imported workbook, location tags, filters and recorded changes. " +
      "Nothing outside this browser is touched.",
    action: "Clear",
    danger: true,
  });
  if (!ok) return;
  // Everything cleared is held for the toast's Undo: the model may exist
  // nowhere else (a merged CSV, days written by Leave), and one misplaced
  // click must not be the end of it.
  const kept = {
    model: state.model,
    tags: state.tags,
    teams: state.teams,
    members: state.members,
    nameFilter: state.nameFilter,
    history: state.history,
    updatedAt: state.updatedAt,
  };
  state.model = null;
  state.tags = {};
  state.teams = [];
  state.members = [];
  state.nameFilter = "";
  state.pickedDay = null;
  state.focus = null;
  state.sel = null;
  state.history = [];
  state.updatedAt = null;
  els.nameFilter.value = "";
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing to clean */
  }
  renderAll();
  toast("Cleared — nothing outside this browser was touched", {
    label: "Undo",
    onAction: () => {
      Object.assign(state, kept);
      els.nameFilter.value = kept.nameFilter;
      renderAll();
      toast("Put everything back");
    },
  });
});

async function copySummary() {
  const model = displayModel();
  if (model === null) {
    toast("Import the workbook first");
    return;
  }
  try {
    await navigator.clipboard.writeText(summaryText(model, stripDay()));
    toast("Summary copied");
  } catch {
    toast("Could not copy — clipboard unavailable");
  }
}
els.copyStrip.addEventListener("click", copySummary);

registerCommands([
  {
    icon: "📥",
    title: "Import workbook, CSV or export…",
    hint: "action",
    keywords: ["xlsx", "csv", "json"],
    run: () => els.fileInput.click(),
  },
  { icon: "📋", title: "Copy who's-out summary", hint: "action", run: copySummary },
  {
    icon: "📋",
    title: "Copy capacity table",
    hint: "action",
    keywords: ["capacity", "team", "week", "standup"],
    run: copyCapacity,
  },
  {
    icon: TOOL_ICONS.availability,
    title: "Person year summary…",
    hint: "action",
    keywords: ["person", "year", "who", "history"],
    // Whoever the page is already about: the picked row, else the focused one
    // (which is the header row, and so nobody, until the grid is used). The
    // dialog falls back to the first visible person on its own.
    run: () => openYearSummary(state.sel?.name ?? focusedPerson() ?? ""),
  },
  {
    icon: TOOL_ICONS.leave,
    title: "Send picked days to Leave Request",
    hint: "action",
    keywords: ["leave", "request", "selection", "grid"],
    run: sendToLeave,
  },
  {
    icon: "📆",
    title: "Report on today",
    hint: "action",
    keywords: ["day", "pick", "strip"],
    run: () => pickDay(todayIso()),
  },
  {
    icon: "🔁",
    title: "Switch Month / Quarter view",
    hint: "action",
    keywords: ["zoom", "view"],
    run: () => setViewMode(state.view.mode === "month" ? "quarter" : "month"),
  },
  {
    icon: "📆",
    title: "Jump to today",
    hint: "action",
    run: () => {
      state.view.anchor = todayIso();
      renderAll();
    },
  },
  { icon: "⬇️", title: "Export availability data", hint: "action", run: exportJson },
  {
    icon: "⬇️",
    title: "Export current view (filtered)",
    hint: "action",
    keywords: ["team", "slice"],
    run: exportViewJson,
  },
  {
    icon: "🔗",
    title: "Copy share link (current view)",
    hint: "action",
    keywords: ["share", "url", "link", "send"],
    run: copyShareLink,
  },
]);

/**
 * Apply the leave requests Leave Request queued for this grid.
 *
 * Nothing is drained until there is a workbook to write into — what is drained
 * is gone, and a change dropped because the roster hadn't been imported yet is
 * exactly the change the user expected to find here. Days that can't be written
 * are reported rather than swallowed: an unmatched name is usually a typo in
 * the Leave form, and only the user can tell.
 */
function applyQueuedUpdates() {
  if (state.model === null) return;
  const queued = drainUpdates(localStorage, "availability");
  if (queued.length === 0) return;
  let model = state.model;
  let written = 0;
  let skipped = 0;
  const missing = [];
  for (const entry of queued) {
    // The queue crossed a storage boundary, so its payload is `unknown` until
    // `applyDayCodes` validates it — which it does, returning a null name for
    // anything it cannot use.
    const data = /** @type {{ name: string, from: string, to: string, code: string }} */ (
      entry.data
    );
    const { from, at } = entry;
    const result = applyDayCodes(model, data);
    if (result.name === null) {
      missing.push(String(data?.name ?? "").trim() || "someone unnamed");
      continue;
    }
    model = result.model;
    written += result.written;
    skipped += result.weekend + result.outside;
    // Record what actually landed, not what was asked for: the panel exists to
    // explain the days on screen. A request that wrote nothing (a whole weekend,
    // say) changed nothing to explain.
    if (result.written > 0) {
      state.history = pushHistory(state.history, {
        name: result.name,
        from: data.from,
        to: data.to,
        code: data.code,
        days: result.written,
        at: typeof at === "number" && at > 0 ? at : Date.now(),
        source: from || "another tool",
        // What these days held before — deleting the record puts it back.
        before: result.before,
      });
    }
  }
  if (written > 0) {
    state.model = model;
    saveState();
    renderAll();
  }
  const parts = [];
  if (written > 0) parts.push(`${written} ${written === 1 ? "day" : "days"} from Leave Request`);
  if (skipped > 0) parts.push(`${skipped} skipped (weekend or outside the imported range)`);
  if (missing.length > 0) parts.push(`no row for ${[...new Set(missing)].join(", ")}`);
  if (parts.length > 0) toast(parts.join(" · "));
}

/**
 * Fold one panel's body away behind the chevron in its heading, remembering
 * the choice. Distinct from the shared sidebar/rail toggles: those drop a whole
 * layout column, this only hides a panel's contents while its head — the day
 * picker and Copy summary, for the strip — stays reachable. The panels here
 * are filled by render, so a collapsed body has nothing to flash before this
 * runs and needs no pre-paint script.
 */
function setupCollapse(button, body, key) {
  const caret = button.querySelector(".caret");
  let hidden = false;
  try {
    hidden = parseHidden(localStorage.getItem(key));
  } catch {
    /* storage unavailable; start expanded */
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
      localStorage.setItem(key, serializeHidden(hidden));
    } catch {
      /* storage unavailable; the choice just won't persist */
    }
  });
}

/* ------------------------------- boot ------------------------------- */

setupCollapse(els.stripToggle, els.strip, `${STORE_KEY}-strip-collapsed`);
setupCollapse(els.legendToggle, els.legendBody, `${STORE_KEY}-legend-collapsed`);
// Every field in the controls sidebar folds the same way, keyed off the body it
// controls — the inline script at the end of that section restores these before
// first paint and derives the key identically.
for (const button of document.querySelectorAll("#controls .field-collapse")) {
  const body = $(String(button.getAttribute("aria-controls")));
  setupCollapse(button, body, `${STORE_KEY}-${body.id}-collapsed`);
}
loadState();
els.lowThreshold.value = String(state.lowThreshold);
els.lowThresholdOut.textContent = state.lowThreshold === 0 ? "off" : `${state.lowThreshold}%`;
applyPatterns();
renderLegend();
setViewMode(state.view.mode); // also triggers the first renderAll()
applyQueuedUpdates();
// The queue is durable and shared by every tab, so this page can be open while
// another one saves a request: `storage` fires here when *another* tab writes,
// and `pageshow` covers coming back through the bfcache.
addEventListener("storage", (event) => {
  if (event.key === INBOX_KEY) applyQueuedUpdates();
});
addEventListener("pageshow", (event) => {
  if (event.persisted) applyQueuedUpdates();
});
// Saves are debounced (see saveState); leaving for Leave — or closing the tab —
// must not race the timer.
addEventListener("pagehide", flushSave);
consumeShareFragment(); // async — re-renders if a #share= link is accepted
// Clicking a share link while already on this page changes only the hash
// (same-document navigation, no reload) — handle that arrival too.
addEventListener("hashchange", consumeShareFragment);

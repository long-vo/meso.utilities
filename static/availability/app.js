// meso.utilities — Team Availability UI wiring. All parsing, date math and
// aggregation live in ./availability.mjs and ./xlsx.mjs (pure, parity-tested);
// this file only moves data between them, the DOM and localStorage. Names and
// absences are personal data: nothing here is ever sent to a server, but
// `copyShareLink` packs a filtered slice of them *into a URL*, which whoever
// holds the link can read — that is the one way data leaves this browser.
import { readWorkbook } from "./xlsx.mjs";
import {
  addDays,
  applyLocationHolidays,
  capacityGrid,
  clampAnchor,
  codeInfo,
  dayCounts,
  decodeShare,
  encodeShare,
  holidayName,
  HOLIDAYS_CH_ZURICH,
  isWeekend,
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
  prettyDay,
  remoteOn,
  shortDay,
  splitHoliday,
  summaryText,
  trimNumber,
  unpackModel,
  viewDates,
  WEEKDAYS,
  weekSlices,
  yearFromFilename,
} from "./availability.mjs";
import { registerCommands } from "../palette.js";
import { makeToast } from "../ui.mjs";

const $ = (id) => document.getElementById(id);
const els = {
  dropZone: $("drop-zone"),
  fileInput: $("file-input"),
  importStatus: $("import-status"),
  csvText: $("csv-text"),
  csvQuarter: $("csv-quarter"),
  csvImport: $("csv-import"),
  year: $("year-input"),
  viewMonth: $("view-month"),
  viewQuarter: $("view-quarter"),
  navPrev: $("nav-prev"),
  navToday: $("nav-today"),
  navNext: $("nav-next"),
  teamChips: $("team-chips"),
  nameFilter: $("name-filter"),
  bulkTeam: $("bulk-team"),
  bulkVn: $("bulk-vn"),
  bulkCh: $("bulk-ch"),
  tagList: $("tag-list"),
  warningsDetails: $("warnings-details"),
  warningsSummary: $("warnings-summary"),
  warningsList: $("warnings-list"),
  legend: $("legend"),
  legendRail: $("legend-rail"),
  exportJson: $("export-json"),
  exportView: $("export-view"),
  shareLink: $("share-link"),
  importJson: $("import-json"),
  jsonInput: $("json-input"),
  clearData: $("clear-data"),
  stripStatus: $("strip-status"),
  copyStrip: $("copy-strip"),
  dayPick: $("day-pick"),
  dayReset: $("day-reset"),
  strip: $("strip"),
  rangeLabel: $("range-label"),
  heatmap: $("heatmap"),
  capacity: $("capacity"),
  capWarn: $("cap-warn"),
  lowThreshold: $("low-threshold"),
  lowThresholdOut: $("low-threshold-out"),
  shareOffer: $("share-offer"),
  shareOfferText: $("share-offer-text"),
  shareOfferLoad: $("share-offer-load"),
  shareOfferDiscard: $("share-offer-discard"),
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

const state = {
  model: null, // reconciled model straight from the parser (location untagged)
  year: new Date().getFullYear(),
  tags: {}, // person name → "VN" | "CH"
  teams: [], // selected team keys (lowercase); empty = everyone
  view: { mode: "month", anchor: todayIso() },
  nameFilter: "",
  pickedDay: null, // the day the strip reports on; null = today
  focus: null, // heatmap cell holding the grid's single tab stop; see markFocusable
  // Percent of a week's maximum below which a team-week is flagged thin. What
  // counts as thin is a team's own call, so it is a control, not a constant;
  // 0 turns the flagging off.
  lowThreshold: 60,
};

/**
 * Dimensions of the last-rendered heatmap. The keyboard handler needs them on
 * every arrow press and must not re-derive the model to get them.
 */
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
  cell.tabIndex = state.focus.row === row && state.focus.col === col ? 0 : -1;
}

function gridCell(row, col) {
  return els.heatmap.querySelector(`[data-r="${row}"][data-c="${col}"]`);
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

/** Hand the tab stop and DOM focus to `state.focus`, taking both off `from`. */
function moveGridFocus(from) {
  const previous = gridCell(from.row, from.col);
  if (previous !== null) previous.tabIndex = -1;
  const next = gridCell(state.focus.row, state.focus.col);
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
      if (from.row !== -1) return; // only the header row picks a day
      event.preventDefault();
      pickDay(dates[from.col]);
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
    if (saved.view && (saved.view.mode === "month" || saved.view.mode === "quarter")) {
      state.view.mode = saved.view.mode;
    }
    if (Number.isInteger(saved.lowThreshold) && saved.lowThreshold >= 0) {
      state.lowThreshold = Math.min(100, saved.lowThreshold);
    }
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

function saveState() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        v: 1,
        year: state.year,
        tags: state.tags,
        teams: state.teams,
        lowThreshold: state.lowThreshold,
        view: { mode: state.view.mode },
        model: state.model === null ? null : packModel(state.model),
      }),
    );
  } catch {
    toast("Could not save to this browser's storage");
  }
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
 *  it — "Public holiday" alone doesn't say whether it's Tet or Bundesfeier. */
function cellMeaning(info, code, date, location) {
  if (info === null) return "no data";
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
  els.exportView.hidden = !filterActive();
  renderImportStatus();
  renderTeamChips(model);
  renderTags(model);
  renderWarnings();
  renderStrip(model);
  renderHeatmap(model);
  renderCapacity(model);
  saveState();
}

function renderImportStatus() {
  els.year.value = String(state.year);
  if (state.model === null) {
    els.importStatus.textContent = "Nothing imported yet.";
    return;
  }
  els.importStatus.textContent = `${
    peopleCount(state.model.people.length)
  } · ${state.model.days.length} days · year ${state.year}`;
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
    cell.addEventListener("click", () => pickDay(date));
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
    name.append(el("span", "hm-person", person.name), el("span", "hm-team", person.team));
    if (person.location === "CH") name.appendChild(el("span", "hm-loc", "CH"));
    row.appendChild(name);
    dates.forEach((date, col) => {
      const code = person.days[date];
      const info = code === undefined ? null : codeInfo(code);
      const cell = el("div", "hm-cell");
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-colindex", String(col + 2));
      if (info === null) cell.classList.add("is-blank");
      else {
        cell.classList.add(`k-${info.kind}`);
        if (info.half !== null) cell.classList.add(`half-${info.half}`);
      }
      if (date === today) cell.classList.add("is-today");
      if (date === picked) cell.classList.add("is-picked");
      if (date.endsWith("-01")) cell.classList.add("m-start");
      cell.title = `${person.name} — ${prettyDay(date)} — ${
        cellMeaning(info, code, date, person.location)
      }`;
      cell.setAttribute("aria-label", cell.title);
      markFocusable(cell, r, col);
      row.appendChild(cell);
    });
    frag.appendChild(row);
  });
  els.heatmap.appendChild(frag);
  if (hadFocus) gridCell(state.focus.row, state.focus.col)?.focus();
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
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  els.capacity.appendChild(table);
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
  state.view.anchor = clampAnchor(state.view.anchor, state.model.days);
  state.pickedDay = null; // the old pick may not exist in the new data
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
  if (
    loaded > 0 && !confirm(
      `Replace the ${loaded} people already loaded with ${file.name}?\n\n` +
        "A workbook covers the whole year, so it replaces rather than merges.",
    )
  ) return;
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

/** Is the heatmap currently narrowed by a team or name filter? */
function filterActive() {
  return state.teams.length > 0 || state.nameFilter.trim() !== "";
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
  // the question left a declined link with nothing to retry or bookmark.
  history.replaceState(null, "", location.pathname + location.search);
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

els.heatmap.addEventListener("keydown", onGridKeydown);
els.heatmap.addEventListener("pointerover", (event) => {
  const cell = event.target.closest?.("[data-c]") ?? null;
  setHoverColumn(cell === null ? null : cell.dataset.c);
});
els.heatmap.addEventListener("pointerleave", () => setHoverColumn(null));

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

els.nameFilter.addEventListener("input", () => {
  state.nameFilter = els.nameFilter.value;
  els.exportView.hidden = !filterActive();
  const model = displayModel();
  renderHeatmap(model);
  renderCapacity(model);
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
els.clearData.addEventListener("click", () => {
  if (!confirm("Forget the imported workbook, tags and filters?")) return;
  state.model = null;
  state.tags = {};
  state.teams = [];
  state.nameFilter = "";
  state.pickedDay = null;
  state.focus = null;
  els.nameFilter.value = "";
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing to clean */
  }
  renderAll();
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

/* ------------------------------- boot ------------------------------- */

loadState();
els.lowThreshold.value = String(state.lowThreshold);
els.lowThresholdOut.textContent = state.lowThreshold === 0 ? "off" : `${state.lowThreshold}%`;
renderLegend();
setViewMode(state.view.mode); // also triggers the first renderAll()
consumeShareFragment(); // async — re-renders if a #share= link is accepted
// Clicking a share link while already on this page changes only the hash
// (same-document navigation, no reload) — handle that arrival too.
addEventListener("hashchange", consumeShareFragment);

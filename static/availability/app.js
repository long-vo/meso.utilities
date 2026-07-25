// meso.utilities — Team Availability UI wiring. All parsing, date math and
// aggregation live in ./availability.mjs and ./xlsx.mjs (pure, parity-tested);
// this file only moves data between them, the DOM and localStorage. Names and
// absences are personal data: they stay in this browser (no share-URLs).
import { readWorkbook } from "./xlsx.mjs";
import {
  applyLocationHolidays,
  codeInfo,
  HOLIDAYS_CH_ZURICH,
  mergeModels,
  mondayOf,
  nextDate,
  outInRange,
  outOn,
  packModel,
  parseQuarterCsv,
  parseVacationWorkbook,
  quarterDates,
  remoteOn,
  teamCapacity,
  unpackModel,
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
  importJson: $("import-json"),
  jsonInput: $("json-input"),
  clearData: $("clear-data"),
  stripStatus: $("strip-status"),
  copyStrip: $("copy-strip"),
  strip: $("strip"),
  rangeLabel: $("range-label"),
  heatmap: $("heatmap"),
  capacity: $("capacity"),
};
const toast = makeToast($("toast"));

const STORE_KEY = "meso-availability";
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const KIND_LEGEND = [
  ["working", "In office", "w"],
  ["remote", "Remote", "r rm ra"],
  ["onsite", "Onsite", "ch"],
  ["leave", "Leave", "p m a"],
  ["planned", "Planned", "v"],
  ["core", "Core leave", "c cm ca"],
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

function addDays(iso, n) {
  let d = iso;
  for (let i = 0; i < n; i++) d = nextDate(d);
  return d;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function prettyDay(iso) {
  const day = WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
  return `${day} ${iso.slice(8)}.${iso.slice(5, 7)}.`;
}

/* ------------------------------- state ------------------------------- */

const state = {
  model: null, // reconciled model straight from the parser (location untagged)
  year: new Date().getFullYear(),
  tags: {}, // person name → "VN" | "CH"
  teams: [], // selected team keys (lowercase); empty = everyone
  view: { mode: "month", anchor: todayIso() },
  nameFilter: "",
};

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
  const anchor = state.view.anchor;
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  if (state.view.mode === "quarter") {
    return quarterDates(year, Math.floor((month - 1) / 3) + 1);
  }
  const dates = [];
  let d = `${anchor.slice(0, 7)}-01`;
  while (d.slice(0, 7) === anchor.slice(0, 7)) {
    dates.push(d);
    d = nextDate(d);
  }
  return dates;
}

/* ------------------------------- rendering ------------------------------- */

function renderAll() {
  const model = displayModel();
  document.body.classList.toggle("has-model", model !== null);
  els.legendRail.hidden = model === null; // the layout drops the rail column too
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
  const n = state.model.people.length;
  els.importStatus.textContent =
    `${n} people · ${state.model.days.length} days · year ${state.year}`;
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

function stripEntryChip(entry, withDates) {
  const chip = el("span", "chip strip-chip");
  chip.append(el("span", `dot dot-${entry.kind}`), ` ${entry.name} `);
  const detail = withDates ?? entry.label;
  chip.append(el("span", "strip-detail", detail));
  chip.title = `${entry.team} — ${detail}`;
  return chip;
}

function renderStrip(model) {
  els.strip.textContent = "";
  if (model === null) {
    els.stripStatus.textContent = "";
    els.strip.appendChild(el("p", "hint", "Import the workbook to see who's out."));
    return;
  }
  const today = todayIso();
  const week = outInRange(model, today, addDays(today, 6));
  const out = outOn(model, today);
  const away = remoteOn(model, today);
  els.stripStatus.textContent = prettyDay(today);

  const section = (title) => {
    const wrap = el("div", "strip-group");
    wrap.appendChild(el("h3", "strip-title", title));
    const box = el("div", "chips");
    wrap.appendChild(box);
    els.strip.appendChild(wrap);
    return box;
  };

  const outBox = section(`Out today (${out.length})`);
  if (out.length === 0) outBox.appendChild(el("span", "hint", "Everyone's available."));
  for (const entry of out) outBox.appendChild(stripEntryChip(entry));

  const awayBox = section(`Remote / onsite today (${away.length})`);
  if (away.length === 0) awayBox.appendChild(el("span", "hint", "Nobody remote."));
  for (const entry of away) awayBox.appendChild(stripEntryChip(entry));

  const weekBox = section(`Next 7 days (${week.length})`);
  if (week.length === 0) weekBox.appendChild(el("span", "hint", "No absences planned."));
  for (const person of week) {
    const dates = person.dates
      .map((d) => `${prettyDay(d.date).slice(3)} ${d.code}`)
      .join(", ");
    const chip = stripEntryChip({ ...person, kind: person.dates[0].kind }, dates);
    weekBox.appendChild(chip);
  }
}

function summaryText(model) {
  const today = todayIso();
  const out = outOn(model, today);
  const away = remoteOn(model, today);
  const week = outInRange(model, today, addDays(today, 6));
  const lines = [`Availability ${prettyDay(today)}`];
  lines.push(
    out.length === 0
      ? "Out today: nobody"
      : `Out today: ${out.map((o) => `${o.name} (${o.label})`).join(", ")}`,
  );
  if (away.length > 0) {
    lines.push(`Remote/onsite: ${away.map((a) => `${a.name} (${a.label})`).join(", ")}`);
  }
  if (week.length > 0) {
    lines.push("Next 7 days:");
    for (const person of week) {
      const dates = person.dates.map((d) => `${d.date.slice(8)}.${d.date.slice(5, 7)}. ${d.code}`);
      lines.push(`  ${person.name}: ${dates.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function renderHeatmap(model) {
  els.heatmap.textContent = "";
  if (model === null) {
    els.rangeLabel.textContent = "";
    els.heatmap.appendChild(
      el("p", "hint hm-empty", "The heatmap appears here once a workbook is imported."),
    );
    return;
  }
  const dates = visibleRange();
  const people = visiblePeople(model);
  const today = todayIso();
  els.heatmap.style.setProperty("--hm-cols", String(dates.length));
  els.heatmap.setAttribute("aria-rowcount", String(people.length + 1));
  const frag = document.createDocumentFragment();

  const head = el("div", "hm-row hm-head-row");
  head.setAttribute("role", "row");
  const corner = el("div", "hm-corner", "Person");
  corner.setAttribute("role", "columnheader");
  head.appendChild(corner);
  for (const date of dates) {
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    const cell = el("div", "hm-head");
    cell.setAttribute("role", "columnheader");
    cell.append(el("span", "hm-dom", date.slice(8)), el("span", "hm-dow", WEEKDAYS[wd][0]));
    if (wd === 0 || wd === 6) cell.classList.add("is-weekend");
    if (date === today) cell.classList.add("is-today");
    if (date.endsWith("-01")) cell.classList.add("m-start");
    cell.title = date;
    head.appendChild(cell);
  }
  frag.appendChild(head);

  for (const person of people) {
    const row = el("div", "hm-row");
    row.setAttribute("role", "row");
    const name = el("div", "hm-name");
    name.setAttribute("role", "rowheader");
    name.append(el("span", "hm-person", person.name), el("span", "hm-team", person.team));
    if (person.location === "CH") name.appendChild(el("span", "hm-loc", "CH"));
    row.appendChild(name);
    for (const date of dates) {
      const code = person.days[date];
      const info = code === undefined ? null : codeInfo(code);
      const cell = el("div", "hm-cell");
      cell.setAttribute("role", "gridcell");
      if (info === null) cell.classList.add("is-blank");
      else {
        cell.classList.add(`k-${info.kind}`);
        if (info.half !== null) cell.classList.add(`half-${info.half}`);
      }
      if (date === today) cell.classList.add("is-today");
      if (date.endsWith("-01")) cell.classList.add("m-start");
      const what = info === null ? "no data" : `${info.label} (${code})`;
      cell.title = `${person.name} — ${prettyDay(date)} — ${what}`;
      cell.setAttribute("aria-label", cell.title);
      row.appendChild(cell);
    }
    frag.appendChild(row);
  }
  els.heatmap.appendChild(frag);
  els.rangeLabel.textContent = `${dates[0]} → ${dates[dates.length - 1]} · ${people.length} people`;
}

function renderCapacity(model) {
  els.capacity.textContent = "";
  if (model === null) return;
  const dates = visibleRange();
  const inRange = new Set(dates);
  const weeks = [...new Set(dates.map((d) => mondayOf(d)))];
  const filtered = { ...model, people: visiblePeople(model) };

  const table = el("table", "cap-table");
  const thead = el("thead");
  const headRow = el("tr");
  headRow.append(el("th", "cap-team", "Team"), el("th", "", "People"));
  for (const monday of weeks) headRow.appendChild(el("th", "", prettyDay(monday).slice(3)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  /** @type {Map<string, { label: string, members: number, cells: number[] }>} */
  const rows = new Map();
  weeks.forEach((monday, index) => {
    // Clamp each week to the visible range so edge weeks don't leak out of it.
    let from = monday;
    while (!inRange.has(from) && from <= dates[dates.length - 1]) from = nextDate(from);
    let to = from;
    for (let d = from; d <= addDays(monday, 6); d = nextDate(d)) if (inRange.has(d)) to = d;
    for (const team of teamCapacity(filtered, from, to)) {
      let row = rows.get(team.team.toLowerCase());
      if (row === undefined) {
        row = { label: team.team, members: team.members, cells: [] };
        rows.set(team.team.toLowerCase(), row);
      }
      row.cells[index] = team.available;
    }
  });

  const tbody = el("tbody");
  for (const row of [...rows.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    const tr = el("tr");
    tr.append(el("td", "cap-team", row.label), el("td", "", String(row.members)));
    for (let i = 0; i < weeks.length; i++) {
      const value = row.cells[i];
      tr.appendChild(el("td", "", value === undefined ? "–" : trimNumber(value)));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  els.capacity.appendChild(table);
}

function trimNumber(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/* ------------------------------- imports ------------------------------- */

async function importWorkbookFile(file) {
  els.importStatus.textContent = `Parsing ${file.name}…`;
  try {
    const sheets = await readWorkbook(await file.arrayBuffer());
    const year = yearFromFilename(file.name) ?? (Number(els.year.value) || state.year);
    const model = parseVacationWorkbook(sheets, { year });
    state.model = model;
    state.year = year;
    toast(
      `Imported ${model.people.length} people` +
        (model.warnings.length > 0 ? ` · ${model.warnings.length} warnings` : ""),
    );
  } catch (err) {
    toast(`Import failed: ${err instanceof Error ? err.message : err}`);
  }
  renderAll();
}

function importCsv() {
  const text = els.csvText.value;
  if (text.trim() === "") {
    toast("Paste a quarter sheet as CSV first");
    return;
  }
  try {
    const quarter = Number(els.csvQuarter.value);
    const year = Number(els.year.value) || state.year;
    const incoming = parseQuarterCsv(text, { year, quarter });
    state.model = state.model === null ? incoming : mergeModels(state.model, incoming);
    state.year = year;
    els.csvText.value = "";
    toast(`Imported Q${quarter} (${incoming.people.length} people)`);
  } catch (err) {
    toast(`CSV import failed: ${err instanceof Error ? err.message : err}`);
  }
  renderAll();
}

function exportJson() {
  if (state.model === null) {
    toast("Nothing to export yet");
    return;
  }
  const payload = {
    v: 1,
    year: state.year,
    tags: state.tags,
    model: packModel(state.model),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `availability-${state.year}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importJsonFile(file) {
  file.text().then((text) => {
    try {
      const payload = JSON.parse(text);
      const model = unpackModel(payload.model);
      if (model === null) throw new Error("not an availability export");
      state.model = model;
      if (Number.isInteger(payload.year)) state.year = payload.year;
      if (payload.tags && typeof payload.tags === "object") state.tags = payload.tags;
      toast(`Loaded ${model.people.length} people from ${file.name}`);
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
  if (file) importWorkbookFile(file);
});
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  if (file) importWorkbookFile(file);
  els.fileInput.value = "";
});
els.csvImport.addEventListener("click", importCsv);

els.year.addEventListener("change", () => {
  const year = Number(els.year.value);
  if (Number.isInteger(year) && year >= 2000 && year <= 2100) {
    state.year = year;
    saveState();
  }
});

function setViewMode(mode) {
  state.view.mode = mode;
  els.viewMonth.classList.toggle("is-active", mode === "month");
  els.viewMonth.setAttribute("aria-selected", String(mode === "month"));
  els.viewQuarter.classList.toggle("is-active", mode === "quarter");
  els.viewQuarter.setAttribute("aria-selected", String(mode === "quarter"));
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
    await navigator.clipboard.writeText(summaryText(model));
    toast("Summary copied");
  } catch {
    toast("Could not copy — clipboard unavailable");
  }
}
els.copyStrip.addEventListener("click", copySummary);

registerCommands([
  {
    icon: "📥",
    title: "Import vacation workbook…",
    hint: "action",
    run: () => els.fileInput.click(),
  },
  { icon: "📋", title: "Copy out-today summary", hint: "action", run: copySummary },
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
]);

/* ------------------------------- boot ------------------------------- */

loadState();
renderLegend();
setViewMode(state.view.mode); // also triggers the first renderAll()

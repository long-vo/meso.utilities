// meso.utilities — Team Availability model: turns the team's vacation
// workbook (as plain value grids, e.g. from ./xlsx.mjs) into one reconciled
// people × days model, plus the aggregations the UI renders. Everything here
// is pure and side-effect free; the DOM lives in app.js. The workbook quirks
// this module absorbs are documented in docs/plan-availability-heatmap.md
// ("Workbook facts the parser must honor").

/**
 * @typedef {{ working: number | null, carry: number | null, allowance: number | null,
 *   planned: number | null, dayOffs: number | null,
 *   annual: number | null, core: number | null, sick: number | null }} Balance
 *   One person's leave accounting, as the "General" sheet records it: the days
 *   it counts (`working`, `carry` from the previous year, the year's annual
 *   `allowance`, `planned`, and `dayOffs` taken) and what is left of each
 *   allowance (`annual`, `core`, `sick`). A field is null when that cell was
 *   blank; negative means overdrawn. The sheet's own arithmetic is
 *   `annual = carry + allowance - planned - dayOffs`, which is why the two
 *   groups belong to one record.
 * @typedef {{ name: string, team: string, location: "VN" | "CH",
 *   days: Record<string, string>, balance?: Balance }} Person
 *   `days` maps ISO dates ("2026-07-01") to the raw lowercase day code.
 *   `balance` is absent for anyone the balance block does not list.
 * @typedef {{ sheet: string, ref: string, value: string, message: string }} Warning
 * @typedef {{ people: Person[], days: string[], warnings: Warning[] }} Model
 */

// --- day codes ---------------------------------------------------------------

/**
 * The workbook legend. `weight` is the fraction of a working day the person
 * is available (halves are exact in binary floats), `half` marks which half
 * of the day the code describes, `kind` groups codes for rendering.
 */
export const CODES = {
  w: { kind: "working", label: "Working", weight: 1, half: null },
  e: { kind: "weekend", label: "Weekend", weight: 0, half: null },
  h: { kind: "holiday", label: "Public holiday", weight: 0, half: null },
  v: { kind: "planned", label: "Planned vacation", weight: 0, half: null },
  p: { kind: "leave", label: "Annual leave", weight: 0, half: null },
  m: { kind: "leave", label: "Off morning", weight: 0.5, half: "am" },
  a: { kind: "leave", label: "Off afternoon", weight: 0.5, half: "pm" },
  c: { kind: "core", label: "Core leave", weight: 0, half: null },
  cm: { kind: "core", label: "Core leave (morning)", weight: 0.5, half: "am" },
  ca: { kind: "core", label: "Core leave (afternoon)", weight: 0.5, half: "pm" },
  s: { kind: "sick", label: "Sick leave", weight: 0, half: null },
  sm: { kind: "sick", label: "Sick leave (morning)", weight: 0.5, half: "am" },
  sa: { kind: "sick", label: "Sick leave (afternoon)", weight: 0.5, half: "pm" },
  r: { kind: "remote", label: "WFH", weight: 1, half: null },
  rm: { kind: "remote", label: "Remote (morning)", weight: 1, half: "am" },
  ra: { kind: "remote", label: "Remote (afternoon)", weight: 1, half: "pm" },
  ch: { kind: "onsite", label: "Onsite", weight: 1, half: null },
  si: { kind: "social", label: "Social leave", weight: 0, half: null },
};

const UNKNOWN_CODE = { kind: "unknown", label: "Unknown code", weight: 1, half: null };

/**
 * Look a day code up in the legend. Unknown codes count as working (weight 1)
 * so dirty cells never silently shrink a team's capacity; the parser already
 * flagged them as warnings.
 *
 * @param {string} code
 * @returns {{ kind: string, label: string, weight: number, half: "am" | "pm" | null }}
 */
export function codeInfo(code) {
  return CODES[code] ?? UNKNOWN_CODE;
}

// --- built-in holiday sets ---------------------------------------------------
// Maintained by hand, one year ahead — extend when the new vacation workbook
// arrives. Zürich: the legal public holidays of the canton.

export const HOLIDAYS_CH_ZURICH = [
  { date: "2025-01-01", name: "Neujahr" },
  { date: "2025-01-02", name: "Berchtoldstag" },
  { date: "2025-04-18", name: "Karfreitag" },
  { date: "2025-04-21", name: "Ostermontag" },
  { date: "2025-05-01", name: "Tag der Arbeit" },
  { date: "2025-05-29", name: "Auffahrt" },
  { date: "2025-06-09", name: "Pfingstmontag" },
  { date: "2025-08-01", name: "Bundesfeier" },
  { date: "2025-12-25", name: "Weihnachten" },
  { date: "2025-12-26", name: "Stephanstag" },
  { date: "2026-01-01", name: "Neujahr" },
  { date: "2026-01-02", name: "Berchtoldstag" },
  { date: "2026-04-03", name: "Karfreitag" },
  { date: "2026-04-06", name: "Ostermontag" },
  { date: "2026-05-01", name: "Tag der Arbeit" },
  { date: "2026-05-14", name: "Auffahrt" },
  { date: "2026-05-25", name: "Pfingstmontag" },
  { date: "2026-08-01", name: "Bundesfeier" },
  { date: "2026-12-25", name: "Weihnachten" },
  { date: "2026-12-26", name: "Stephanstag" },
  { date: "2027-01-01", name: "Neujahr" },
  { date: "2027-01-02", name: "Berchtoldstag" },
  { date: "2027-03-26", name: "Karfreitag" },
  { date: "2027-03-29", name: "Ostermontag" },
  { date: "2027-05-01", name: "Tag der Arbeit" },
  { date: "2027-05-06", name: "Auffahrt" },
  { date: "2027-05-17", name: "Pfingstmontag" },
  { date: "2027-08-01", name: "Bundesfeier" },
  { date: "2027-12-25", name: "Weihnachten" },
  { date: "2027-12-26", name: "Stephanstag" },
];

// Informational only — VN holidays already reach the model as `h` day codes.
// 2026 set as published in the vacation workbook's own holiday sheet.
export const HOLIDAYS_VN = [
  { date: "2026-01-01", name: "New Year's Day" },
  { date: "2026-02-16", name: "Tet Holiday" },
  { date: "2026-02-17", name: "Tet Holiday" },
  { date: "2026-02-18", name: "Tet Holiday" },
  { date: "2026-02-19", name: "Tet Holiday" },
  { date: "2026-02-20", name: "Tet Holiday" },
  { date: "2026-04-27", name: "Hung Kings Commemoration (observed)" },
  { date: "2026-04-30", name: "Reunification Day" },
  { date: "2026-05-01", name: "Labor Day" },
  { date: "2026-09-02", name: "National Day" },
  { date: "2026-09-03", name: "National Day" },
  { date: "2026-11-24", name: "Vietnam Cultural Day (company)" },
];

/**
 * Which public holiday falls on `iso` for someone in `location` — the reason
 * both sets above carry names. VN holidays reach the model as `h` codes and CH
 * ones through {@link applyLocationHolidays}; either way the code alone says
 * only "public holiday", and this says *which*.
 *
 * Null when the relevant set doesn't list that date, which is normal outside
 * the years it covers (VN: 2026 only) — callers fall back to the generic label.
 *
 * @param {string} iso
 * @param {"VN" | "CH"} location
 * @returns {string | null}
 */
export function holidayName(iso, location) {
  const set = location === "CH" ? HOLIDAYS_CH_ZURICH : HOLIDAYS_VN;
  return set.find((h) => h.date === iso)?.name ?? null;
}

// --- small date helpers --------------------------------------------------------

/** @param {number} year @param {number} month 1-based */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Calendar days in one quarter — 90/91 for Q1, 91, 92, 92. This is the number
 * of date columns a quarter sheet has, not a count of working days.
 * @param {number} year @param {number} quarter 1–4
 */
export function daysInQuarter(year, quarter) {
  const first = (quarter - 1) * 3 + 1;
  return daysInMonth(year, first) + daysInMonth(year, first + 1) + daysInMonth(year, first + 2);
}

/**
 * Every ISO date of a quarter, in order — the workbook's date headers are
 * never trusted (stale years, day-number serials), only positions are.
 * @param {number} year @param {number} quarter 1–4
 * @returns {string[]}
 */
export function quarterDates(year, quarter) {
  const dates = [];
  for (let m = (quarter - 1) * 3 + 1; m <= quarter * 3; m++) {
    for (let d = 1; d <= daysInMonth(year, m); d++) {
      dates.push(`${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }
  return dates;
}

/** The next calendar day of an ISO date, DST-proof via UTC. @param {string} iso */
export function nextDate(iso) {
  const t = Date.parse(`${iso}T00:00:00Z`) + 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** `iso` shifted by `n` calendar days (negative shifts back). @param {string} iso */
export function addDays(iso, n) {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * True when `iso` is a Saturday or Sunday. The `e` day code says the same
 * thing for the cells the workbook filled in; this answers for the ones it
 * did not — a blank or mis-coded weekend cell must not read as a working day.
 *
 * @param {string} iso
 */
export function isWeekend(iso) {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Two-letter weekday names, indexed by `getUTCDay()`. */
export const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `"2026-07-25"` → `"Sa 25.07"` — the day heading the strip and tooltips use. */
export function prettyDay(iso) {
  const day = WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
  return `${day} ${iso.slice(8)}.${iso.slice(5, 7)}`;
}

/** `"2026-07-25"` → `"25.07"` — the compact form used inside chips. */
export function shortDay(iso) {
  return `${iso.slice(8)}.${iso.slice(5, 7)}`;
}

/** A half-day-capable person-day count for display: `6.5`, `8`, never `8.0`. */
export function trimNumber(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** The Monday of the week containing `iso` (capacity groups by week). @param {string} iso */
export function mondayOf(iso) {
  const t = new Date(`${iso}T00:00:00Z`);
  const sinceMonday = (t.getUTCDay() + 6) % 7;
  return new Date(t.getTime() - sinceMonday * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Pull the workbook year out of a filename like `mesoneer-Vacation-2026.xlsx`
 * (the last 19xx/20xx group wins). Null when there is none.
 * @param {string} filename
 * @returns {number | null}
 */
export function yearFromFilename(filename) {
  const all = String(filename).match(/(?:19|20)\d{2}/g);
  return all === null ? null : Number(all[all.length - 1]);
}

// --- workbook parsing ----------------------------------------------------------

const TOTAL_COLUMNS = ["h", "w", "v", "p", "c", "s", "r"];
const MONTH_COLUMNS = 3; // per-month working-day counts sit between totals and dates

/** "3rd quarter" / "Q3" → 3, anything else → 0. @param {string} name */
function quarterOfSheetName(name) {
  const m = /^(?:([1-4])(?:st|nd|rd|th)\s+quarter|q([1-4]))$/i.exec(clean(name) ?? "");
  return m === null ? 0 : Number(m[1] ?? m[2]);
}

/** Normalize a cell to a trimmed string (nbsp included), null when empty. */
function clean(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\u00a0/g, " ").trim();
  return s === "" ? null : s;
}

/** @param {unknown} value */
function isNumeric(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") return Number.isFinite(Number(value));
  return false;
}

/** Zero-based row/col → A1-style reference for warnings. */
function cellRef(row, col) {
  let name = "";
  for (let c = col + 1; c > 0; c = Math.floor((c - 1) / 26)) {
    name = String.fromCharCode(64 + ((c - 1) % 26) + 1) + name;
  }
  return `${name}${row + 1}`;
}

/**
 * Find the header row by its signature: the `h w v p c s r` totals run,
 * with the `No.` column to its left. Tolerant of the whole block shifting
 * by rows or columns between workbook years.
 *
 * @param {Array<Array<unknown>>} rows
 * @returns {{ row: number, noCol: number, dateStart: number } | null}
 */
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cells = rows[r] ?? [];
    for (let c = 0; c + TOTAL_COLUMNS.length <= cells.length; c++) {
      const run = TOTAL_COLUMNS.every((t, i) => clean(cells[c + i])?.toLowerCase() === t);
      if (!run) continue;
      let noCol = -1;
      for (let k = 0; k < c; k++) {
        if (/^no\.?$/i.test(clean(cells[k]) ?? "")) noCol = k;
      }
      if (noCol === -1) noCol = c - 3; // No. | Team | Name sit directly left of the totals
      if (noCol < 0) continue;
      return { row: r, noCol, dateStart: c + TOTAL_COLUMNS.length + MONTH_COLUMNS };
    }
  }
  return null;
}

/**
 * One quarter grid → its roster slice. Trailing per-person week-aggregate
 * columns are trimmed by only reading `daysInQuarter` columns, and the
 * per-team summary rows below the roster are never reached because the scan
 * stops at the first row without a numeric `No.`.
 *
 * @param {Array<Array<unknown>>} rows
 * @param {string} sheetName used in warnings
 * @param {number} year
 * @param {number} quarter 1–4
 * @param {Warning[]} warnings appended to in place
 * @returns {Array<{ name: string, team: string, days: Record<string, string> }>}
 */
function parseQuarterGrid(rows, sheetName, year, quarter, warnings) {
  const header = findHeader(rows);
  if (header === null) {
    warnings.push({
      sheet: sheetName,
      ref: "",
      value: "",
      message: `${sheetName}: no header row (No. + h w v p c s r) found — sheet skipped`,
    });
    return [];
  }
  const dates = quarterDates(year, quarter);
  const people = [];
  for (let r = header.row + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    if (!isNumeric(cells[header.noCol])) break; // roster ends before the summary rows
    const name = clean(cells[header.noCol + 2]);
    if (name === null) {
      warnings.push({
        sheet: sheetName,
        ref: cellRef(r, header.noCol + 2),
        value: "",
        message: `${sheetName}!${
          cellRef(r, header.noCol + 2)
        }: roster row without a name — skipped`,
      });
      continue;
    }
    const team = clean(cells[header.noCol + 1]) ?? "";
    /** @type {Record<string, string>} */
    const days = {};
    for (let i = 0; i < dates.length; i++) {
      const raw = clean(cells[header.dateStart + i]);
      if (raw === null) continue; // day not filled in — no data, not "out"
      const code = raw.toLowerCase();
      if (CODES[code] === undefined) {
        const ref = cellRef(r, header.dateStart + i);
        warnings.push({
          sheet: sheetName,
          ref,
          value: raw,
          message: `${sheetName}!${ref}: unknown day code "${raw}" — counted as working`,
        });
      }
      days[dates[i]] = code;
    }
    people.push({ name, team, days });
  }
  return people;
}

// --- leave balances ------------------------------------------------------------
// The workbook's "General" sheet carries a second, unrelated table: one row per
// person with the year's leave accounting — the days it counts and what is left
// of each allowance.

const BALANCE_COLUMNS = ["annual leave", "core leave", "sick leave"];
const NAME_HEADER = /^associate name$/i;

/**
 * The counted columns, between the name and the three `remain` ones. Each is
 * found by its own header rather than by an offset from the block, so a column
 * that moves — or that a future workbook drops — costs only itself.
 *
 * `carry` is headed by the bare previous-year number (`2025` in the 2026
 * workbook), which is why it matches a pattern and not a word; `allowance` is
 * the sheet's `Annual` / `Leave` header split over two rows, so only its first
 * line is matched.
 */
/** @type {Array<[key: string, header: RegExp]>} */
const RECORDED_COLUMNS = [
  ["working", /^working$/],
  ["carry", /^(?:19|20)\d{2}$/],
  ["allowance", /^annual(?: leave)?$/],
  ["planned", /^planned$/],
  ["dayOffs", /^day ?offs?$/],
];

/**
 * Every field of a {@link Balance}, in the sheet's own left-to-right order —
 * the counted columns, then the three remainders. Exported because the UI, the
 * totals and the storage validator must agree on this list.
 */
export const BALANCE_FIELDS = [
  ...RECORDED_COLUMNS.map(([key]) => key),
  "annual",
  "core",
  "sick",
];

/** A header cell as a comparable label: trimmed, lowercase, runs of space collapsed. */
function label(value) {
  return clean(value)?.toLowerCase().replace(/\s+/g, " ") ?? null;
}

/** @param {unknown} value @returns {number | null} */
function numberOrNull(value) {
  return isNumeric(value) ? Number(value) : null;
}

/**
 * Find the balance block by its own signature: the three `Annual leave |
 * Core leave | Sick Leave` columns with an `Associate Name` column to their
 * left. Like {@link findHeader}, positions come from the signature so the
 * block may shift between workbook years. `recorded` maps each counted column
 * to its own index, or to -1 when this workbook has no such column.
 *
 * @param {Array<Array<unknown>>} rows
 * @returns {{ row: number, nameCol: number, firstCol: number,
 *   recorded: Record<string, number> } | null}
 */
function findBalanceHeader(rows) {
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    for (let c = 0; c + BALANCE_COLUMNS.length <= cells.length; c++) {
      if (!BALANCE_COLUMNS.every((h, i) => label(cells[c + i]) === h)) continue;
      let nameCol = -1;
      for (let k = 0; k < c; k++) {
        if (NAME_HEADER.test(clean(cells[k]) ?? "")) nameCol = k;
      }
      if (nameCol === -1) continue;
      // Searched strictly between the name and the remainders, so `Annual` can
      // never be answered by the `Annual leave` remainder column itself.
      /** @type {Record<string, number>} */
      const recorded = {};
      for (const [key, pattern] of RECORDED_COLUMNS) {
        recorded[key] = -1;
        for (let k = nameCol + 1; k < c; k++) {
          if (pattern.test(label(cells[k]) ?? "")) recorded[key] = k;
        }
      }
      return { row: r, nameCol, firstCol: c, recorded };
    }
  }
  return null;
}

/**
 * The leave balances of one sheet — an empty array when the sheet has no
 * balance block, which is how {@link parseVacationWorkbook} tells the General
 * sheet apart from the holiday one without matching on sheet names.
 *
 * Two rows below the header are deliberately not people: the `remain` label
 * row that spells the columns out, and roster rows that are still entirely
 * blank (a joiner with nothing recorded yet). Both are skipped by the same
 * rule — a row with no number in it carries no balance. The block ends where
 * the name column does, which is what keeps the legend further down the sheet
 * out of the result.
 *
 * @param {Array<Array<unknown>>} rows
 * @returns {Array<{ name: string } & Balance>}
 */
export function parseBalanceSheet(rows) {
  const header = findBalanceHeader(rows);
  if (header === null) return [];
  const entries = [];
  for (let r = header.row + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    const name = clean(cells[header.nameCol]);
    if (name === null) break;
    /** @type {{ name: string } & Balance} */
    const entry = /** @type {any} */ ({ name });
    for (const [key] of RECORDED_COLUMNS) {
      const col = header.recorded[key];
      entry[key] = col === -1 ? null : numberOrNull(cells[col]);
    }
    entry.annual = numberOrNull(cells[header.firstCol]);
    entry.core = numberOrNull(cells[header.firstCol + 1]);
    entry.sick = numberOrNull(cells[header.firstCol + 2]);
    if (BALANCE_FIELDS.every((key) => entry[key] === null)) continue;
    entries.push(entry);
  }
  return entries;
}

/**
 * What one day under `code` contributes to a person's leave accounting: the
 * fraction of the day worked, and the fraction not worked booked against the
 * allowance its kind belongs to. Codes that are not leave (working, remote,
 * onsite) only ever touch `working`; `carry` and `allowance` are the year's
 * grant rather than activity, so nothing here moves them.
 *
 * An empty code is no data, not a worked day — the day contributes nothing at
 * all, exactly as it contributes to neither side of {@link teamCapacity}.
 *
 * The signs are the sheet's own arithmetic, which is what keeps
 * `annual = carry + allowance - planned - dayOffs` true after any change:
 * a day booked as annual leave adds to `dayOffs` and takes the same amount off
 * `annual`.
 *
 * @param {string} code
 * @returns {Partial<Balance>}
 */
function dayEffect(code) {
  if (code === "" || code === undefined || code === null) return {};
  const info = codeInfo(code);
  const off = 1 - info.weight; // the fraction of the day not worked
  const effect = { working: info.weight };
  if (info.kind === "planned") {
    effect.planned = off;
    effect.annual = -off;
  } else if (info.kind === "leave") {
    effect.dayOffs = off;
    effect.annual = -off;
  } else if (info.kind === "core") {
    effect.core = -off;
  } else if (info.kind === "sick") {
    effect.sick = -off;
  }
  return effect;
}

/**
 * Move a balance by the day-code changes `changes` describes — one
 * `[before, after]` pair per day. This is what makes a request written onto the
 * grid show up in the balances too, instead of the two disagreeing until the
 * next workbook lands.
 *
 * Exactly reversible: replaying the same pairs swapped puts the balance back,
 * which is what lets {@link revertDayCodes} undo a change in full.
 *
 * A field that was never recorded (null) stays null — marking days cannot
 * invent a balance the workbook does not have — and a person with no balance at
 * all is returned untouched.
 *
 * @param {Balance | undefined} balance
 * @param {Array<[string, string]>} changes
 * @returns {Balance | undefined}
 */
export function shiftBalance(balance, changes) {
  if (balance === undefined || balance === null) return balance;
  const moved = { ...balance };
  for (const [before, after] of changes) {
    const from = dayEffect(before);
    const to = dayEffect(after);
    for (const key of BALANCE_FIELDS) {
      const delta = (to[key] ?? 0) - (from[key] ?? 0);
      if (delta !== 0 && typeof moved[key] === "number") moved[key] += delta;
    }
  }
  return moved;
}

/**
 * Sum a group's balances for a totals line, one total per {@link BALANCE_FIELDS}
 * entry. People without a balance are ignored (`people` counts only the ones
 * that have one), and a null field contributes nothing rather than reading as a
 * zero someone earned.
 *
 * @param {Person[]} people
 * @returns {Record<string, number>} `people` plus one key per balance field
 */
export function balanceTotals(people) {
  const totals = { people: 0 };
  for (const key of BALANCE_FIELDS) totals[key] = 0;
  for (const person of people) {
    if (person.balance === undefined || person.balance === null) continue;
    totals.people++;
    for (const key of BALANCE_FIELDS) {
      const value = person.balance[key];
      if (typeof value === "number" && Number.isFinite(value)) totals[key] += value;
    }
  }
  return totals;
}

/**
 * Parse the whole vacation workbook (all `1st quarter` … `4th quarter`
 * sheets; the "General" sheet contributes leave balances, other sheets are
 * ignored) into one reconciled model.
 *
 * People are matched across quarters by trimmed name; the team label of the
 * latest quarter a person appears in wins (labels drift, e.g. `Pragma` →
 * `pragma`). Every date-header cell is ignored — dates derive from quarter +
 * column position + `year` only. `location` starts as `"VN"` for everyone;
 * see {@link applyLocationHolidays} for CH tagging.
 *
 * @param {Array<{ name: string, rows: Array<Array<unknown>> }>} sheets
 *   e.g. the result of `readWorkbook` from ./xlsx.mjs
 * @param {{ year: number }} opts the workbook year (see {@link yearFromFilename})
 * @returns {Model}
 */
export function parseVacationWorkbook(sheets, opts) {
  if (!opts || !Number.isInteger(opts.year)) {
    throw new TypeError("parseVacationWorkbook needs { year }");
  }
  /** @type {Warning[]} */
  const warnings = [];
  /** @type {Map<string, Person>} */
  const byName = new Map();
  /** @type {string[]} */
  const days = [];
  let quartersSeen = 0;
  /** @type {ReturnType<typeof parseBalanceSheet>} */
  let balances = [];
  let balanceSheet = "";

  for (const sheet of sheets) {
    const quarter = quarterOfSheetName(sheet.name);
    if (quarter === 0) {
      // The balance block lives on a non-quarter sheet ("General" in the real
      // workbook); the first sheet carrying one wins.
      if (balances.length === 0) {
        balances = parseBalanceSheet(sheet.rows);
        if (balances.length > 0) balanceSheet = sheet.name;
      }
      continue;
    }
    quartersSeen++;
    const roster = parseQuarterGrid(sheet.rows, sheet.name, opts.year, quarter, warnings);
    if (roster.length > 0) days.push(...quarterDates(opts.year, quarter));
    for (const entry of roster) {
      const existing = byName.get(entry.name);
      if (existing === undefined) {
        byName.set(entry.name, {
          name: entry.name,
          team: entry.team,
          location: "VN",
          days: entry.days,
        });
      } else {
        if (entry.team !== "") existing.team = entry.team; // the later quarter wins
        Object.assign(existing.days, entry.days);
      }
    }
  }

  if (quartersSeen === 0) {
    throw new Error('no quarter sheets found (expected names like "1st quarter")');
  }

  // Balances join to the roster by name — the quarter grids decide who exists,
  // so a balance row matching nobody is reported rather than inventing a person.
  const byLower = new Map([...byName.values()].map((p) => [p.name.toLowerCase(), p]));
  for (const entry of balances) {
    const person = byLower.get(entry.name.toLowerCase());
    if (person === undefined) {
      warnings.push({
        sheet: balanceSheet,
        ref: "",
        value: entry.name,
        message:
          `${balanceSheet}: leave balances for "${entry.name}" match nobody in the quarter ` +
          `sheets — ignored`,
      });
      continue;
    }
    const balance = /** @type {Balance} */ ({});
    for (const key of BALANCE_FIELDS) balance[key] = entry[key];
    person.balance = balance;
  }

  return { people: [...byName.values()], days: [...new Set(days)].sort(), warnings };
}

/**
 * The CSV fallback: one exported quarter sheet (for browsers without
 * DecompressionStream). Same grid rules as the xlsx path; warnings cite the
 * synthetic sheet name `Qn`.
 *
 * @param {string} text CSV of a single quarter sheet
 * @param {{ year: number, quarter: number }} opts
 * @returns {Model}
 */
export function parseQuarterCsv(text, opts) {
  const quarterOk = opts && Number.isInteger(opts.quarter) && opts.quarter >= 1 &&
    opts.quarter <= 4;
  if (!quarterOk || !Number.isInteger(opts.year)) {
    throw new TypeError("parseQuarterCsv needs { year, quarter (1-4) }");
  }
  return parseVacationWorkbook([{ name: `Q${opts.quarter}`, rows: parseCsv(text) }], {
    year: opts.year,
  });
}

/**
 * Minimal CSV parser: quoted fields, doubled-quote escapes, CR/LF endings.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  const push = () => {
    row.push(field);
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") push();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      push();
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    push();
    rows.push(row);
  }
  return rows;
}

// --- aggregations ----------------------------------------------------------------

/**
 * Everyone who is not fully available on `date` (weekends excluded — being
 * off on Saturday is not news). Includes holidays so mixed VN/CH teams see
 * who has the day off; the `kind` field lets callers group.
 *
 * @param {Model} model
 * @param {string} date ISO
 * @returns {Array<{ name: string, team: string, location: string, code: string,
 *   kind: string, label: string, weight: number }>}
 */
export function outOn(model, date) {
  const out = [];
  for (const person of model.people) {
    const code = person.days[date];
    if (code === undefined) continue;
    const info = codeInfo(code);
    if (info.weight >= 1 || info.kind === "weekend") continue;
    out.push({
      name: person.name,
      team: person.team,
      location: person.location,
      code,
      kind: info.kind,
      label: info.label,
      weight: info.weight,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everyone working away from the office on `date` — remote or onsite codes.
 * The out-today strip shows this as its own group: these people are available,
 * just not in the building.
 *
 * @param {Model} model
 * @param {string} date ISO
 * @returns {Array<{ name: string, team: string, location: string, code: string,
 *   kind: string, label: string, half: "am" | "pm" | null }>}
 */
export function remoteOn(model, date) {
  const away = [];
  for (const person of model.people) {
    const code = person.days[date];
    if (code === undefined) continue;
    const info = codeInfo(code);
    if (info.kind !== "remote" && info.kind !== "onsite") continue;
    away.push({
      name: person.name,
      team: person.team,
      location: person.location,
      code,
      kind: info.kind,
      label: info.label,
      half: info.half,
    });
  }
  return away.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Per person, every not-fully-available day in `from..to` (inclusive,
 * weekends excluded). People with nothing to report are omitted.
 *
 * @param {Model} model
 * @param {string} from ISO @param {string} to ISO
 * @returns {Array<{ name: string, team: string, location: string,
 *   dates: Array<{ date: string, code: string, kind: string, label: string, weight: number }> }>}
 */
export function outInRange(model, from, to) {
  const result = [];
  for (const person of model.people) {
    const dates = [];
    for (let d = from; d <= to; d = nextDate(d)) {
      const code = person.days[d];
      if (code === undefined) continue;
      const info = codeInfo(code);
      if (info.weight >= 1 || info.kind === "weekend") continue;
      dates.push({ date: d, code, kind: info.kind, label: info.label, weight: info.weight });
    }
    if (dates.length > 0) {
      result.push({ name: person.name, team: person.team, location: person.location, dates });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compress one person's out-days (as {@link outInRange} lists them) into
 * ranges of consecutive days sharing one code — `27.07.–31.07. c` instead of
 * five single-day entries. Gaps consisting solely of weekend days are
 * bridged: being off Friday and Monday reads as one absence.
 *
 * `days` counts what the range actually covers in {@link codeShare} terms, so
 * a Friday-to-Monday absence is two days rather than the four the endpoints
 * span, and a range of half-days is half a day each.
 *
 * @param {Array<{ date: string, code: string, kind: string, label: string, weight: number }>}
 *   entries one person's out-days, ascending
 * @returns {Array<{ from: string, to: string, code: string, kind: string, label: string,
 *   weight: number, days: number }>}
 */
export function groupOutDates(entries) {
  const groups = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (
      last !== undefined && entry.code === last.code && onlyWeekendsBetween(last.to, entry.date)
    ) {
      last.to = entry.date;
      last.days += codeShare(entry.code);
    } else {
      groups.push({
        from: entry.date,
        to: entry.date,
        code: entry.code,
        kind: entry.kind,
        label: entry.label,
        weight: entry.weight,
        days: codeShare(entry.code),
      });
    }
  }
  return groups;
}

/**
 * How much of a day the code *describes* — a full day, or the half its `half`
 * names. Deliberately not `1 - weight`: WFH weighs a full working day (the
 * person is available) but still describes a whole day of working from home,
 * and `1 - weight` would report that as nothing at all.
 *
 * @param {string} code
 */
function codeShare(code) {
  return codeInfo(code).half === null ? 1 : 0.5;
}

/** True when `b` follows `a` with nothing but weekend days in between. */
function onlyWeekendsBetween(a, b) {
  let d = nextDate(a);
  while (d < b) {
    if (!isWeekend(d)) return false;
    d = nextDate(d);
  }
  return d === b;
}

/** One person's grouped out-days, dates only: `"27.07–31.07, 03.08"`.
 * @param {Parameters<typeof groupOutDates>[0]} dates */
export function outDatesText(dates) {
  return groupOutDates(dates)
    .map((g) => `${shortDay(g.from)}${g.from === g.to ? "" : `–${shortDay(g.to)}`}`)
    .join(", ");
}

/** The same ranges with their reason spelled out: `"27.07–31.07 Annual leave"`.
 * @param {Parameters<typeof groupOutDates>[0]} dates */
export function outDatesLabelText(dates) {
  return groupOutDates(dates)
    .map((g) => `${shortDay(g.from)}${g.from === g.to ? "" : `–${shortDay(g.to)}`} ${g.label}`)
    .join(", ");
}

/**
 * Split an {@link outOn} list into the public-holiday cohort and everyone
 * else. On a VN public holiday every VN person carries `h`, which would
 * otherwise bury the day's real absences under sixty identical chips.
 *
 * @param {ReturnType<typeof outOn>} entries
 * @returns {{ holiday: ReturnType<typeof outOn>, other: ReturnType<typeof outOn> }}
 */
export function splitHoliday(entries) {
  return {
    holiday: entries.filter((e) => e.kind === "holiday"),
    other: entries.filter((e) => e.kind !== "holiday"),
  };
}

/**
 * How many people are out on each working day of `from..to` — the strip's
 * per-day index over a week of by-person chips. Weekend days are left out
 * (there is nothing to be absent from) and the public-holiday cohort is
 * counted separately, so a holiday reads as a holiday and not as "70 out".
 *
 * @param {Model} model
 * @param {string} from ISO @param {string} to ISO
 * @returns {Array<{ date: string, count: number, holiday: number }>}
 */
export function dayCounts(model, from, to) {
  const counts = [];
  for (let d = from; d <= to; d = nextDate(d)) {
    if (isWeekend(d)) continue;
    const { holiday, other } = splitHoliday(outOn(model, d));
    counts.push({ date: d, count: other.length, holiday: holiday.length });
  }
  return counts;
}

/**
 * The plain-text standup summary for `date` — what the 📋 button copies.
 * Weekends and public holidays are named rather than reported as "nobody",
 * and the per-day index lets a reader find the day they care about before
 * reading the seventy per-person lines under it.
 *
 * @param {Model} model
 * @param {string} date ISO
 * @returns {string}
 */
export function summaryText(model, date) {
  const { holiday, other } = splitHoliday(outOn(model, date));
  const away = remoteOn(model, date);
  const lines = [`Availability ${prettyDay(date)}`];
  if (isWeekend(date)) {
    lines.push("Weekend — nobody scheduled");
  } else {
    if (holiday.length > 0) lines.push(`Public holiday — ${holiday.length} off`);
    if (other.length > 0) {
      lines.push(`Out: ${other.map((o) => `${o.name} (${o.label})`).join(", ")}`);
    } else if (holiday.length === 0) {
      lines.push("Out: nobody");
    }
    if (away.length > 0) {
      lines.push(`Remote/onsite: ${away.map((a) => `${a.name} (${a.label})`).join(", ")}`);
    }
  }
  const to = addDays(date, 6);
  const counts = dayCounts(model, date, to);
  if (counts.length > 0) {
    lines.push(
      `Per day: ${
        counts
          .map((c) => `${shortDay(c.date)} ${c.holiday > 0 && c.count === 0 ? "holiday" : c.count}`)
          .join(" · ")
      }`,
    );
  }
  const week = outInRange(model, date, to);
  if (week.length > 0) {
    lines.push("Next 7 days:");
    for (const person of week) lines.push(`  ${person.name}: ${outDatesLabelText(person.dates)}`);
  }
  return lines.join("\n");
}

/**
 * Available person-days per team over `from..to` (inclusive). `available`
 * sums the day weights (weekends and holidays weigh 0), `out` sums the
 * missing fraction of known non-weekend days, so `available + out` equals
 * the team's theoretical working days in the range. Days that were never
 * filled in contribute to neither. Teams group case-insensitively (label
 * drift), the latest spelling wins.
 *
 * @param {Model} model
 * @param {string} from ISO @param {string} to ISO
 * @returns {Array<{ team: string, members: number, available: number, out: number }>}
 */
export function teamCapacity(model, from, to) {
  /** @type {Map<string, { team: string, members: number, available: number, out: number }>} */
  const teams = new Map();
  for (const person of model.people) {
    const key = person.team.toLowerCase();
    let entry = teams.get(key);
    if (entry === undefined) {
      entry = { team: person.team, members: 0, available: 0, out: 0 };
      teams.set(key, entry);
    }
    entry.team = person.team;
    entry.members++;
    for (let d = from; d <= to; d = nextDate(d)) {
      const code = person.days[d];
      if (code === undefined) continue;
      const info = codeInfo(code);
      entry.available += info.weight;
      if (info.kind !== "weekend") entry.out += 1 - info.weight;
    }
  }
  return [...teams.values()].sort((a, b) => a.team.localeCompare(b.team));
}

/**
 * Kind → the label of the full-day code that stands for it (`leave` → "Annual
 * leave", `remote` → "WFH"). Every kind has exactly one code with `half: null`,
 * so this names a kind without a second table to keep in step with {@link CODES}.
 */
export const KIND_LABELS = Object.fromEntries(
  Object.values(CODES).filter((info) => info.half === null).map((info) => [info.kind, info.label]),
);

/** Kinds a summary chip would only clutter the row with: the two that mean
 *  "nothing happened", plus `unknown` — a dirty cell weighs a full working day
 *  everywhere else, and a chip for it would read as a real absence. */
const UNCHIPPED_KINDS = new Set(["weekend", "working", "unknown"]);

/**
 * Everything the imported axis records about one person, independent of the
 * month or quarter the heatmap happens to show: their days by kind, the run of
 * months, and every absence as a grouped range.
 *
 * Two counting bases live here on purpose, because no single one is honest:
 *
 * - `kinds`, each month's `days` and each range's `days` count in
 *   {@link codeShare} terms, which is what "8 days WFH" means. WFH and onsite
 *   earn a chip even though they cost no availability. The month run shares
 *   that basis so the distribution can't show an empty month for someone the
 *   chips above it credit with a fortnight of remote work.
 * - `out` and `worked` stay weight-based (`1 - weight` / `weight`), matching
 *   {@link teamCapacity}, and so `out` is *not* the sum of the chips.
 *
 * `possible` is every day the axis holds a code for that isn't a weekend, which
 * makes `out + worked === possible` exactly. Weekends and days the workbook
 * left blank count towards nothing at all, the same way {@link teamCapacity}
 * skips them.
 *
 * The month run comes from {@link monthSpans} over the model's own axis — a
 * workbook covering two years gets more than twelve buckets, and a month with
 * no absence in it keeps its (empty) bucket, because a gap in the distribution
 * is data.
 *
 * @param {Model} model
 * @param {string} name roster spelling
 * @returns {{ name: string, team: string, location: string,
 *   kinds: Array<{ kind: string, label: string, days: number }>,
 *   months: Array<{ month: string, label: string, days: number, out: number, possible: number }>,
 *   ranges: ReturnType<typeof groupOutDates>,
 *   out: number, worked: number, possible: number } | null}
 *   `null` when the roster has no such person.
 */
export function personSummary(model, name) {
  const person = model.people.find((p) => p.name === name);
  if (person === undefined) return null;

  const months = monthSpans(model.days)
    .map((span) => ({ month: span.month, label: span.label, days: 0, out: 0, possible: 0 }));
  const byMonth = new Map(months.map((month) => [month.month, month]));
  /** @type {Map<string, number>} */
  const kindDays = new Map();
  /** @type {Parameters<typeof groupOutDates>[0]} */
  const entries = [];
  let out = 0;
  let worked = 0;
  let possible = 0;

  for (const date of model.days) {
    const code = person.days[date];
    if (code === undefined) continue;
    const info = codeInfo(code);
    if (info.kind === "weekend") continue;
    out += 1 - info.weight;
    worked += info.weight;
    possible++;
    const month = byMonth.get(date.slice(0, 7));
    if (month !== undefined) {
      month.out += 1 - info.weight;
      month.possible++;
    }
    if (UNCHIPPED_KINDS.has(info.kind)) continue;
    if (month !== undefined) month.days += codeShare(code);
    kindDays.set(info.kind, (kindDays.get(info.kind) ?? 0) + codeShare(code));
    entries.push({ date, code, kind: info.kind, label: info.label, weight: info.weight });
  }

  const kinds = [...kindDays]
    .map(([kind, days]) => ({ kind, label: KIND_LABELS[kind] ?? kind, days }))
    .sort((a, b) => b.days - a.days || a.kind.localeCompare(b.kind));

  return {
    name: person.name,
    team: person.team,
    location: person.location,
    kinds,
    months,
    ranges: groupOutDates(entries),
    out,
    worked,
    possible,
  };
}

// --- handoff to Leave --------------------------------------------------------------

/**
 * Day-code kinds → the Leave tool's leave types. Kinds with no leave equivalent
 * (working, onsite, holiday, weekend, social-insurance, unknown) are absent, and
 * the target then keeps its own default rather than guessing.
 */
const LEAVE_TYPE_BY_KIND = {
  planned: "annual",
  leave: "annual",
  core: "core",
  sick: "sick",
  remote: "wfh",
};

/**
 * Sort a picked run of grid cells into the days a leave request could cover and
 * the days it could not. A weekend is not a day off anyone has to ask for, and a
 * public holiday is already free — booking one would spend a leave day on a day
 * nobody works. Everything else counts, blank cells included: no data recorded
 * for a Tuesday is not a reason to refuse a request for it.
 *
 * `reason` names what a pick is made of when it holds no leavable day at all —
 * the wording the UI puts in front of a refused pick — and is null whenever
 * there is something to request, including for an empty pick.
 *
 * `outside` and `markable` answer a different question: not "can this be
 * requested" but "can it be written onto the grid". A day the workbook never
 * covered is still a real date someone can ask for, so it never sets `reason`;
 * it simply has no column to be marked in. `markable` counts the days
 * {@link applyDayCodes} would actually write — everything that is neither a
 * weekend nor outside the imported range — so a caller can tell beforehand
 * whether marking would do anything at all.
 *
 * Cells are `{ date, code, outside }` triples rather than a model slice on
 * purpose: the caller reads them straight off the grid, so the answer covers
 * exactly what is on screen (the CH holiday overlay included) without
 * rebuilding the model on every step of a drag.
 *
 * @param {Array<{ date?: string, code?: string, outside?: boolean }>} picked
 * @returns {{ leavable: number, weekend: number, holiday: number, outside: number,
 *   markable: number, reason: string | null }}
 */
export function leavableDays(picked) {
  /** @type {{ leavable: number, weekend: number, holiday: number, outside: number,
   *   markable: number, reason: string | null }} */
  const summary = { leavable: 0, weekend: 0, holiday: 0, outside: 0, markable: 0, reason: null };
  for (const cell of picked) {
    const date = cell?.date ?? "";
    const kind = codeInfo(cell?.code ?? "").kind;
    // The calendar answers for the cells the workbook left blank; the day code
    // answers for the ones it filled in.
    const weekend = kind === "weekend" || (date !== "" && isWeekend(date));
    const outside = cell?.outside === true;
    if (weekend) summary.weekend++;
    else if (kind === "holiday") summary.holiday++;
    else summary.leavable++;
    if (outside) summary.outside++;
    if (!weekend && !outside) summary.markable++;
  }
  if (summary.leavable === 0) {
    if (summary.weekend > 0 && summary.holiday > 0) summary.reason = "weekend and public holiday";
    else if (summary.holiday > 0) summary.reason = "public holiday";
    else if (summary.weekend > 0) summary.reason = "weekend";
  }
  return summary;
}

/**
 * The leave type and duration a grid pick implies — what {@link leaveHandoffText}
 * sends when nothing overrides them, exposed so the send-to-Leave dialog can
 * prefill its fields with the same reading. A half-day code only describes a
 * single day, so a multi-day pick is always full days.
 *
 * @param {{ code?: string, from: string, to: string }} selection
 * @returns {{ type: string | null, duration: "full"|"morning"|"afternoon" }}
 */
export function leaveHandoffDefaults({ code, from, to }) {
  const info = codeInfo(code ?? "");
  const half = from === to ? info.half : null;
  return {
    type: LEAVE_TYPE_BY_KIND[info.kind] ?? null,
    duration: half === "am" ? "morning" : half === "pm" ? "afternoon" : "full",
  };
}

/**
 * The handoff payload for a grid selection: who, which days, and which leave
 * type the picked code implies. An explicit `type` or `duration` (the dialog's
 * override path) replaces the code-derived one; absent, the defaults apply.
 *
 * @param {{ name: string, code?: string, from: string, to: string,
 *   type?: string, duration?: string }} selection
 * @returns {string} the envelope text `parseLeaveHandoff` reads
 */
export function leaveHandoffText({ name, code, from, to, type, duration }) {
  const defaults = leaveHandoffDefaults({ code, from, to });
  return JSON.stringify({
    v: 1,
    name: String(name ?? ""),
    type: type ?? defaults.type,
    duration: duration ?? defaults.duration,
    from,
    to,
  });
}

/**
 * Write a leave request's day code onto one person's row — the return path of
 * the Leave handoff, so a request made from the grid lands back in it.
 *
 * Three things are deliberately *not* written, and are reported instead of
 * silently dropped: an unknown person (the roster comes from the workbook, and
 * a leave form must not invent a row), days outside the imported range (the
 * grid has no column for them), and weekends (a request spanning one covers the
 * working days around it, and overwriting `e` would claim someone worked) —
 * weekends by the calendar as well as by the code, so a row the workbook has
 * not filled in yet is not the one place a Saturday can be booked.
 *
 * The person's leave balance moves with the days ({@link shiftBalance}), so the
 * grid and the balances panel never disagree about the same absence.
 *
 * The model is copied, never mutated: callers hold the old one until they
 * choose to swap it in.
 *
 * Every overwritten code is returned in `before` (an empty string where the cell
 * had none), which is what makes the change undoable — see {@link revertDayCodes}.
 *
 * @param {Model} model
 * @param {{ name: string, from: string, to: string, code: string }} update
 * @returns {{ model: Model, name: string | null, written: number, weekend: number,
 *   outside: number, before: Record<string, string> }} `name` is the roster's
 *   spelling, or null when nobody matched.
 */
export function applyDayCodes(model, update) {
  const nothing = { model, name: null, written: 0, weekend: 0, outside: 0, before: {} };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  // `nextDate` throws on an unparsable date, and this input crossed a storage
  // boundary — check before stepping through the range with it.
  if (!iso.test(update?.from ?? "") || !iso.test(update?.to ?? "")) return nothing;
  const wanted = String(update?.name ?? "").trim().toLowerCase();
  const person = model.people.find((p) => p.name.toLowerCase() === wanted) ?? null;
  if (person === null) return nothing;
  const known = new Set(model.days);
  const days = { ...person.days };
  /** @type {Record<string, string>} */
  const before = {};
  /** @type {Array<[string, string]>} */
  const changes = [];
  let written = 0;
  let weekend = 0;
  let outside = 0;
  for (let date = update.from; date <= update.to; date = nextDate(date)) {
    if (!known.has(date)) {
      outside++;
      continue;
    }
    // The `e` code answers for the cells the workbook filled in, the calendar
    // for the ones it left blank — the same rule {@link leavableDays} previews
    // with. Reading the code alone would write leave onto a joiner's blank
    // Saturday and book it against their balance.
    if (codeInfo(days[date] ?? "").kind === "weekend" || isWeekend(date)) {
      weekend++;
      continue;
    }
    before[date] = days[date] ?? "";
    changes.push([before[date], update.code]);
    days[date] = update.code;
    written++;
  }
  // The days and the balance describe the same absence, so they move together.
  const balance = shiftBalance(person.balance, changes);
  return {
    model: {
      ...model,
      people: model.people.map((p) =>
        p === person ? { ...p, days, ...(balance === undefined ? {} : { balance }) } : p
      ),
    },
    name: person.name,
    written,
    weekend,
    outside,
    before,
  };
}

/**
 * Put back what an applied change overwrote — deleting a recorded change undoes
 * it rather than just forgetting it happened.
 *
 * A day is only restored while it still holds the code that change wrote: if
 * something later moved that day again, the newer value is the true one and
 * resurrecting an older code would be a silent regression. Those days are
 * counted as `kept` so the caller can say so.
 *
 * What the days give back, the balance gives back too — but only for the days
 * actually restored, so a partial undo leaves a partially booked balance rather
 * than crediting days that are still taken.
 *
 * @param {Model} model
 * @param {{ name: string, code: string, before?: Record<string, string> }} entry
 * @returns {{ model: Model, name: string | null, restored: number, kept: number }}
 */
export function revertDayCodes(model, entry) {
  const before = entry?.before ?? null;
  const wanted = String(entry?.name ?? "").trim().toLowerCase();
  const person = model.people.find((p) => p.name.toLowerCase() === wanted) ?? null;
  if (person === null || before === null || typeof before !== "object") {
    return { model, name: person?.name ?? null, restored: 0, kept: 0 };
  }
  const days = { ...person.days };
  /** @type {Array<[string, string]>} */
  const changes = [];
  let restored = 0;
  let kept = 0;
  for (const [date, previous] of Object.entries(before)) {
    if ((days[date] ?? "") !== entry.code) {
      kept++;
      continue;
    }
    // "" means the cell had no code at all; restoring must leave it blank
    // again, not write an empty string the legend would call unknown.
    if (previous === "") delete days[date];
    else days[date] = previous;
    changes.push([entry.code, previous]);
    restored++;
  }
  // Only the days actually put back are unbooked; the ones a later change moved
  // on keep the balance that change gave them.
  const balance = shiftBalance(person.balance, changes);
  return {
    model: {
      ...model,
      people: model.people.map((p) =>
        p === person ? { ...p, days, ...(balance === undefined ? {} : { balance }) } : p
      ),
    },
    name: person.name,
    restored,
    kept,
  };
}

/** How many recorded changes are kept. Old enough to answer "who changed my
 *  row?", short enough that the panel stays readable and the state stays small. */
export const HISTORY_LIMIT = 20;

/**
 * @typedef {Object} HistoryEntry
 * @property {string} name Roster spelling of the person the days belong to.
 * @property {string} from ISO date @property {string} to ISO date
 * @property {string} code The day code written.
 * @property {number} days How many days actually took it (weekends are skipped).
 * @property {number} at When it was applied (epoch ms).
 * @property {string} [source] The tool that asked for it, e.g. "Leave Request".
 * @property {Record<string, string>} [before] What each written day held before
 *   (empty string where the cell had none) — what {@link revertDayCodes} needs
 *   to undo the change rather than merely forget it.
 */

/**
 * Add an applied change to the history, newest first, capped at `limit`.
 * Returns a new array — the caller swaps it in, so a render mid-update never
 * sees a half-written list.
 *
 * @param {HistoryEntry[]} history
 * @param {HistoryEntry} entry
 * @param {number} [limit]
 * @returns {HistoryEntry[]}
 */
export function pushHistory(history, entry, limit = HISTORY_LIMIT) {
  const list = Array.isArray(history) ? history : [];
  return [entry, ...list].slice(0, Math.max(0, limit));
}

/**
 * One history line: who, which days, and what was written there — the code's
 * own legend label, so the line says "Sick leave" rather than "s".
 *
 * @param {{ name: string, from: string, to: string, code: string, days: number }} entry
 * @returns {string}
 */
export function historyText(entry) {
  const when = entry.from === entry.to
    ? shortDay(entry.from)
    : `${shortDay(entry.from)}–${shortDay(entry.to)}`;
  const days = `${entry.days} ${entry.days === 1 ? "day" : "days"}`;
  return `${entry.name} · ${when} · ${codeInfo(entry.code).label} (${days})`;
}

/**
 * How much of a recorded change the grid still shows. The record is the master
 * copy of what this tool wrote: importing a fresh workbook replaces the days
 * wholesale, and a request HR has not entered yet simply vanishes from the grid
 * while its record stays. Comparing the two is what lets the panel say so
 * instead of leaving the change silently undone.
 *
 * `before` names exactly the days the change wrote — weekends and days outside
 * the imported range were skipped — which is what makes this checkable at all.
 * A record from a build that did not keep `before` falls back to the range's
 * working days, the closest stand-in available.
 *
 * A person the roster no longer holds counts as nothing kept: the days are as
 * gone as the row is.
 *
 * @param {Model} model
 * @param {HistoryEntry} entry
 * @returns {{ days: number, kept: number }} how many days the record wrote, and
 *   how many of them still carry its code
 */
export function recordOnGrid(model, entry) {
  const dates = Object.keys(entry.before ?? {});
  if (dates.length === 0) {
    for (let d = entry.from; d <= entry.to; d = nextDate(d)) {
      if (!isWeekend(d)) dates.push(d);
    }
  }
  const wanted = String(entry.name ?? "").trim().toLowerCase();
  const person = model.people.find((p) => p.name.toLowerCase() === wanted);
  if (person === undefined) return { days: dates.length, kept: 0 };
  let kept = 0;
  for (const date of dates) {
    if (person.days[date] === entry.code) kept++;
  }
  return { days: dates.length, kept };
}

// --- view framing ----------------------------------------------------------------
// The day axis the heatmap draws, and how the capacity table carves it up.

/**
 * Every ISO date one view shows: the anchor's whole month, or its whole
 * quarter. The anchor is any date inside the period.
 *
 * @param {"month" | "quarter"} mode
 * @param {string} anchor ISO
 * @returns {string[]}
 */
export function viewDates(mode, anchor) {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  if (mode === "quarter") return quarterDates(year, Math.floor((month - 1) / 3) + 1);
  const dates = [];
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    dates.push(`${anchor.slice(0, 7)}-${String(d).padStart(2, "0")}`);
  }
  return dates;
}

/**
 * Carve a view's day axis into calendar weeks, each clamped to the axis.
 * `from`/`to` are the week's first and last *visible* day, so a month's edge
 * week is a three-day stub — which the capacity table must label by `from`,
 * not by a `monday` that is not on screen at all.
 *
 * @param {string[]} dates ascending, as {@link viewDates} returns them
 * @returns {Array<{ monday: string, from: string, to: string, days: number }>}
 */
export function weekSlices(dates) {
  const inRange = new Set(dates);
  const slices = [];
  for (const monday of [...new Set(dates.map((d) => mondayOf(d)))]) {
    let from = "";
    let to = "";
    let days = 0;
    for (let d = monday, i = 0; i < 7; d = nextDate(d), i++) {
      if (!inRange.has(d)) continue;
      if (from === "") from = d;
      to = d;
      days++;
    }
    slices.push({ monday, from, to, days });
  }
  return slices;
}

/**
 * The month runs across a view's day axis, for the heatmap's month header
 * row: `[{ month: "2026-07", label: "Jul 2026", days: 31 }]`. A quarter view
 * gets three spans, a month view one.
 *
 * @param {string[]} dates ascending
 * @returns {Array<{ month: string, label: string, days: number }>}
 */
export function monthSpans(dates) {
  const spans = [];
  for (const date of dates) {
    const month = date.slice(0, 7);
    const last = spans[spans.length - 1];
    if (last !== undefined && last.month === month) {
      last.days++;
      continue;
    }
    spans.push({
      month,
      label: `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`,
      days: 1,
    });
  }
  return spans;
}

/**
 * Pull `anchor` into the span `days` covers — the nearest end wins, an anchor
 * already inside is returned unchanged. Without this, importing a workbook
 * for any year but the current one lands the heatmap on an empty month.
 *
 * @param {string} anchor ISO
 * @param {string[]} days the model's day axis, ascending
 * @returns {string}
 */
export function clampAnchor(anchor, days) {
  if (days.length === 0) return anchor;
  const first = days[0];
  const last = days[days.length - 1];
  if (anchor < first) return first;
  if (anchor > last) return last;
  return anchor;
}

/**
 * The capacity table's grid: one row per team, one cell per week of `weeks`.
 * A cell is `null` when nothing was imported for that week — a zero maximum is
 * missing data, not a team with no capacity, and the two must never render
 * alike. Rows come back sorted by team label.
 *
 * @param {Model} model
 * @param {ReturnType<typeof weekSlices>} weeks
 * @returns {Array<{ team: string, members: number,
 *   cells: Array<{ available: number, possible: number } | null> }>}
 */
export function capacityGrid(model, weeks) {
  /** @type {Map<string, { team: string, members: number, cells: Array<object | null> }>} */
  const rows = new Map();
  weeks.forEach((week, index) => {
    for (const team of teamCapacity(model, week.from, week.to)) {
      let row = rows.get(team.team.toLowerCase());
      if (row === undefined) {
        row = { team: team.team, members: team.members, cells: [] };
        rows.set(team.team.toLowerCase(), row);
      }
      // `available + out` is the week's theoretical maximum: without it a part
      // week's smaller number reads as a capacity collapse.
      const possible = team.available + team.out;
      row.cells[index] = possible === 0 ? null : { available: team.available, possible };
    }
  });
  return [...rows.values()].sort((a, b) => a.team.localeCompare(b.team));
}

/**
 * The team-weeks in a {@link capacityGrid} that fall below `threshold` of their
 * own maximum — the conclusion the capacity numbers imply but never state.
 * `threshold` is a fraction (0.6 = 60%); 0 reports nothing.
 *
 * @param {ReturnType<typeof capacityGrid>} grid
 * @param {ReturnType<typeof weekSlices>} weeks
 * @param {number} threshold
 * @returns {Array<{ team: string, from: string, to: string, available: number,
 *   possible: number, ratio: number }>}
 */
export function lowCoverage(grid, weeks, threshold) {
  const low = [];
  for (const row of grid) {
    weeks.forEach((week, index) => {
      const cell = row.cells[index];
      if (cell === null || cell === undefined) return;
      const ratio = cell.available / cell.possible;
      if (ratio >= threshold) return;
      low.push({
        team: row.team,
        from: week.from,
        to: week.to,
        available: cell.available,
        possible: cell.possible,
        ratio,
      });
    });
  }
  return low;
}

// --- CH overlay ------------------------------------------------------------------

/**
 * Apply per-person location tags and overlay a holiday set for the CH-tagged
 * people: on a listed holiday their `w`/`r`/`rm`/`ra`/`ch` becomes `h` (they
 * are off even though the VN-centric sheet says working). Existing non-working
 * codes — and weekends — are left alone, as is every VN person. Pure: returns
 * a new model, inputs are not mutated.
 *
 * @param {Model} model
 * @param {Record<string, "VN" | "CH">} tags person name → location
 * @param {Array<string | { date: string }>} holidays ISO dates,
 *   e.g. `HOLIDAYS_CH_ZURICH`
 * @returns {Model}
 */
export function applyLocationHolidays(model, tags, holidays) {
  const dates = holidays.map((h) => (typeof h === "string" ? h : h.date));
  const people = model.people.map((person) => {
    const location = /** @type {"VN" | "CH"} */ (tags[person.name] === "CH" ? "CH" : "VN");
    if (location === "VN") return person.location === "VN" ? person : { ...person, location };
    /** @type {Record<string, string>} */
    const days = { ...person.days };
    for (const date of dates) {
      const code = days[date];
      // Only *known* working codes convert. An unknown code also weighs 1, but
      // its warning says "counted as working" — quietly turning it into a
      // holiday would contradict that and destroy the value the warning cites.
      if (code === undefined || CODES[code] === undefined) continue;
      if (codeInfo(code).weight >= 1) days[date] = "h";
    }
    return { ...person, location, days };
  });
  return { people, days: model.days, warnings: model.warnings };
}

// --- persistence & merging ---------------------------------------------------------

/**
 * Compact JSON form for localStorage: one comma-joined code string per person,
 * aligned to the model's day axis (roughly 10× smaller than the raw model).
 * Codes are URI-encoded so even a dirty cell containing a comma survives.
 *
 * `balance` is only written for the people who have one, so a payload from a
 * source without balances (a CSV quarter) stays exactly as it was.
 *
 * @param {Model} model
 * @returns {{ v: 1, days: string, warnings: Warning[],
 *   people: Array<{ name: string, team: string, location: string, codes: string,
 *     balance?: Balance }> }}
 */
export function packModel(model) {
  return {
    v: 1,
    days: model.days.join(","),
    people: model.people.map((person) => ({
      name: person.name,
      team: person.team,
      location: person.location,
      codes: model.days.map((d) => encodeURIComponent(person.days[d] ?? "")).join(","),
      ...(person.balance === undefined || person.balance === null
        ? {}
        : { balance: person.balance }),
    })),
    warnings: model.warnings,
  };
}

/**
 * One packed `balance` field back into a {@link Balance}, or undefined for
 * anything that is not one. Every field is validated: this crosses a storage
 * boundary (localStorage, a JSON export, a share link), and a string where a
 * number belongs would reach the totals line as `"3" + 2`.
 *
 * @param {unknown} packed
 * @returns {Balance | undefined}
 */
function unpackBalance(packed) {
  if (packed === null || typeof packed !== "object") return undefined;
  const balance = /** @type {Balance} */ ({});
  for (const key of BALANCE_FIELDS) {
    const value = /** @type {Record<string, unknown>} */ (packed)[key];
    balance[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return balance;
}

/**
 * Inverse of {@link packModel}. Returns null for anything malformed or from
 * a future version — callers fall back to an empty state instead of crashing
 * on a stale localStorage entry.
 *
 * @param {unknown} packed
 * @returns {Model | null}
 */
export function unpackModel(packed) {
  if (packed === null || typeof packed !== "object") return null;
  const p = /** @type {{ v?: unknown, days?: unknown, people?: unknown, warnings?: unknown }} */ (
    packed
  );
  if (p.v !== 1 || typeof p.days !== "string" || !Array.isArray(p.people)) return null;
  const axis = p.days === "" ? [] : p.days.split(",");
  const people = [];
  for (const q of p.people) {
    if (q === null || typeof q !== "object") return null;
    if (typeof q.name !== "string" || typeof q.codes !== "string") return null;
    /** @type {Record<string, string>} */
    const days = {};
    const codes = q.codes.split(",");
    for (let i = 0; i < axis.length; i++) {
      const code = codes[i];
      if (code !== undefined && code !== "") days[axis[i]] = decodeURIComponent(code);
    }
    const balance = unpackBalance(q.balance);
    people.push({
      name: q.name,
      team: typeof q.team === "string" ? q.team : "",
      location: /** @type {"VN" | "CH"} */ (q.location === "CH" ? "CH" : "VN"),
      days,
      ...(balance === undefined ? {} : { balance }),
    });
  }
  return { people, days: axis, warnings: Array.isArray(p.warnings) ? p.warnings : [] };
}

/**
 * Encode a share payload for a URL fragment: JSON → gzip → base64url. Day
 * codes are extremely repetitive, so gzip typically shrinks the payload by
 * an order of magnitude. Fragments never leave the browser (they are not
 * sent in HTTP requests), so the data stays client-side — but anyone holding
 * the finished link can read it.
 *
 * @param {object} payload JSON-serializable share payload
 * @returns {Promise<string>} base64url text, safe inside `#share=…`
 */
export async function encodeShare(payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const stream = new Blob([/** @type {BlobPart} */ (json)]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Inverse of {@link encodeShare}. Returns the parsed payload object, or null
 * for anything that does not decode — garbage, truncated links, non-gzip
 * data. Callers still validate the payload's shape (e.g. via
 * {@link unpackModel}).
 *
 * @param {string} encoded
 * @returns {Promise<object | null>}
 */
export async function decodeShare(encoded) {
  try {
    const b64 = String(encoded).replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const json = new TextDecoder().decode(await new Response(stream).arrayBuffer());
    const payload = JSON.parse(json);
    return payload !== null && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Merge a partial model into an existing one — the CSV path imports one
 * quarter at a time. Same reconciliation rules as the workbook parser: match
 * by name, the incoming team label wins when present, incoming days win per
 * date, an incoming balance replaces the held one (a payload without balances
 * leaves them alone). Pure: neither input is mutated.
 *
 * @param {Model} base
 * @param {Model} incoming
 * @returns {Model}
 */
export function mergeModels(base, incoming) {
  /** @type {Map<string, Person>} */
  const byName = new Map(
    base.people.map((person) => [person.name, { ...person, days: { ...person.days } }]),
  );
  for (const person of incoming.people) {
    const existing = byName.get(person.name);
    if (existing === undefined) {
      byName.set(person.name, { ...person, days: { ...person.days } });
    } else {
      if (person.team !== "") existing.team = person.team;
      if (person.balance !== undefined) existing.balance = person.balance;
      Object.assign(existing.days, person.days);
    }
  }
  return {
    people: [...byName.values()],
    days: [...new Set([...base.days, ...incoming.days])].sort(),
    warnings: [...base.warnings, ...incoming.warnings],
  };
}

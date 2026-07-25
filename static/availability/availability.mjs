// meso.utilities — Team Availability model: turns the team's vacation
// workbook (as plain value grids, e.g. from ./xlsx.mjs) into one reconciled
// people × days model, plus the aggregations the UI renders. Everything here
// is pure and side-effect free; the DOM lives in app.js. The workbook quirks
// this module absorbs are documented in docs/plan-availability-heatmap.md
// ("Workbook facts the parser must honor").

/**
 * @typedef {{ name: string, team: string, location: "VN" | "CH",
 *   days: Record<string, string> }} Person
 *   `days` maps ISO dates ("2026-07-01") to the raw lowercase day code.
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
  r: { kind: "remote", label: "Working remotely", weight: 1, half: null },
  rm: { kind: "remote", label: "Remote (morning)", weight: 1, half: "am" },
  ra: { kind: "remote", label: "Remote (afternoon)", weight: 1, half: "pm" },
  ch: { kind: "onsite", label: "Onsite", weight: 1, half: null },
  si: { kind: "social", label: "Social-insurance leave", weight: 0, half: null },
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

// --- small date helpers --------------------------------------------------------

/** @param {number} year @param {number} month 1-based */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Working span of one quarter. @param {number} year @param {number} quarter 1–4 */
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

/**
 * Parse the whole vacation workbook (all `1st quarter` … `4th quarter`
 * sheets; holiday/summary sheets are ignored) into one reconciled model.
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

  for (const sheet of sheets) {
    const quarter = quarterOfSheetName(sheet.name);
    if (quarter === 0) continue;
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
    const location = tags[person.name] === "CH" ? "CH" : "VN";
    if (location === "VN") return person.location === "VN" ? person : { ...person, location };
    /** @type {Record<string, string>} */
    const days = { ...person.days };
    for (const date of dates) {
      const info = codeInfo(days[date] ?? "");
      if (days[date] !== undefined && info.weight >= 1) days[date] = "h";
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
 * @param {Model} model
 * @returns {{ v: 1, days: string, warnings: Warning[],
 *   people: Array<{ name: string, team: string, location: string, codes: string }> }}
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
    })),
    warnings: model.warnings,
  };
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
    people.push({
      name: q.name,
      team: typeof q.team === "string" ? q.team : "",
      location: q.location === "CH" ? "CH" : "VN",
      days,
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
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
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
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
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
 * date. Pure: neither input is mutated.
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
      Object.assign(existing.days, person.days);
    }
  }
  return {
    people: [...byName.values()],
    days: [...new Set([...base.days, ...incoming.days])].sort(),
    warnings: [...base.warnings, ...incoming.warnings],
  };
}

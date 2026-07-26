/**
 * Parity tests for the Team Availability model. Run with `deno task test`.
 *
 * All data here is synthetic — the real vacation workbook holds personal data
 * and must never be committed. The `grid()` helper below rebuilds the real
 * file's quarter-sheet shape (legend noise, a lookalike label row, the
 * `No. | Team | Name | h w v p c s r | 3 month counts | one column per day`
 * header, trailing week-aggregate columns, per-team summary rows) so the
 * quirks documented in docs/plan-availability-heatmap.md stay covered.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import {
  addDays,
  applyDayCodes,
  applyLocationHolidays,
  BALANCE_FIELDS,
  balanceTotals,
  capacityGrid,
  clampAnchor,
  codeInfo,
  CODES,
  dayCounts,
  daysInQuarter,
  decodeShare,
  encodeShare,
  groupOutDates,
  HISTORY_LIMIT,
  historyText,
  holidayName,
  HOLIDAYS_CH_ZURICH,
  HOLIDAYS_VN,
  isWeekend,
  leavableDays,
  leaveHandoffDefaults,
  leaveHandoffText,
  lowCoverage,
  mergeModels,
  mondayOf,
  monthSpans,
  nextDate,
  outDatesLabelText,
  outDatesText,
  outInRange,
  outOn,
  packModel,
  parseBalanceSheet,
  parseCsv,
  parseQuarterCsv,
  parseVacationWorkbook,
  personSummary,
  prettyDay,
  pushHistory,
  quarterDates,
  recordOnGrid,
  remoteOn,
  revertDayCodes,
  shiftBalance,
  shortDay,
  splitHoliday,
  summaryText,
  teamCapacity,
  trimNumber,
  unpackModel,
  viewDates,
  weekSlices,
  yearFromFilename,
} from "../static/availability/availability.mjs";

type Model = ReturnType<typeof parseVacationWorkbook>;
type Cell = string | number | boolean | null;

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function assertThrows(fn: () => unknown, includes: string): void {
  try {
    fn();
  } catch (err) {
    const text = String(err);
    if (!text.includes(includes)) {
      throw new Error(`error should mention "${includes}", got: ${text}`);
    }
    return;
  }
  throw new Error(`expected an error mentioning "${includes}"`);
}

function person(model: Model, name: string) {
  const p = model.people.find((x) => x.name === name);
  if (p === undefined) throw new Error(`person not found: ${name}`);
  return p;
}

/** Rebuild a quarter sheet the way the real workbook lays it out. */
function grid(opts: {
  people: Array<[name: string, team: string, codes: Array<Cell>]>;
  nDays: number;
  extraWeekCols?: number;
  rowShift?: number;
  colShift?: number;
  summaryRows?: boolean;
}): Cell[][] {
  const rs = opts.rowShift ?? 0;
  const cs = opts.colShift ?? 0;
  const rows: Cell[][] = [];
  rows[0] = [null, "Vacation plan"];
  rows[2] = [null, "w", "Working", null, "s", "Sick leave"]; // legend noise
  // Lookalike label row: has No./Team/Name but no h..r run — must not match.
  const label: Cell[] = [];
  label[cs + 1] = "No. ";
  label[cs + 2] = "Team";
  label[cs + 3] = "Associate Name";
  rows[10 + rs] = label;
  const hdr: Cell[] = [];
  hdr[cs + 1] = "No. "; // the real file pads with a non-breaking space
  hdr[cs + 2] = "T";
  hdr[cs + 3] = "N";
  ["h", "w", "v", "p", "c", "s", "r"].forEach((t, i) => hdr[cs + 4 + i] = t);
  hdr[cs + 11] = "M1";
  hdr[cs + 12] = "M2";
  hdr[cs + 13] = "M3";
  // Date headers are junk on purpose: the parser must ignore their values.
  for (let i = 0; i < opts.nDays; i++) hdr[cs + 14 + i] = 45000 + i;
  for (let i = 0; i < (opts.extraWeekCols ?? 0); i++) {
    hdr[cs + 14 + opts.nDays + i] = `Week ${i + 1}`;
  }
  rows[11 + rs] = hdr;
  opts.people.forEach(([name, team, codes], i) => {
    const row: Cell[] = [];
    row[cs + 1] = i + 1;
    row[cs + 2] = team;
    row[cs + 3] = name;
    row[cs + 4] = 2; // quarter totals — junk, never read
    row[cs + 5] = 60;
    codes.forEach((c, j) => row[cs + 14 + j] = c);
    for (let k = 0; k < (opts.extraWeekCols ?? 0); k++) row[cs + 14 + opts.nDays + k] = 0;
    rows.push(row);
  });
  if (opts.summaryRows) {
    rows.push([]);
    const w: Cell[] = [];
    w[cs + 19] = "W2";
    rows.push(w);
    const s1: Cell[] = [];
    s1[cs + 13] = "aeon";
    s1[cs + 14] = 0;
    s1[cs + 15] = 3;
    rows.push(s1);
    const s2: Cell[] = [];
    s2[cs + 13] = "mortal";
    s2[cs + 14] = 5;
    rows.push(s2);
  }
  return rows;
}

/** The General sheet's balance columns, by the field name the parser gives them. */
type BalanceField =
  | "working"
  | "carry"
  | "allowance"
  | "planned"
  | "dayOffs"
  | "annual"
  | "core"
  | "sick";
const BALANCE_COL: Record<BalanceField, number> = {
  working: 5,
  carry: 6,
  allowance: 7,
  planned: 8,
  dayOffs: 9,
  annual: 10,
  core: 11,
  sick: 12,
};
/** Every field null / zero — what a test's expected entry or total starts from.
 *  Spread first so the key order matches what the parser builds. */
const NO_BALANCE = Object.fromEntries(
  Object.keys(BALANCE_COL).map((k) => [k, null]),
) as Record<BalanceField, number | null>;
const NO_BALANCE_TOTALS = Object.fromEntries(Object.keys(BALANCE_COL).map((k) => [k, 0]));

/**
 * Rebuild the "General" sheet's leave-balance block the way the real workbook
 * lays it out: an unrelated per-team summary table above it, a two-row header
 * (`Working | 2025 | Annual/Leave | Planned | Day Offs | Annual leave |
 * Core leave | Sick Leave` over `remain | remain | remain`), then a stray
 * totals cell and the code legend below the last person.
 */
function general(opts: {
  people: Array<[name: string, values: Partial<Record<BalanceField, Cell>>]>;
  rowShift?: number;
  colShift?: number;
  year?: number;
}): Cell[][] {
  const rs = opts.rowShift ?? 0;
  const cs = opts.colShift ?? 0;
  const rows: Cell[][] = [];
  rows[1] = [null, "TODAY", 46228.6];
  // The month/week summary tables that sit above the block — no `Associate
  // Name`, so the header scan must walk past them.
  const summary: Cell[] = [];
  summary[cs + 2] = "Team";
  summary[cs + 3] = "Members";
  summary[cs + 4] = "Jan";
  rows[3] = summary;
  rows[4] = [null, null, "mortal", 9, 101];
  const hdr: Cell[] = [];
  hdr[cs + 1] = "No. ";
  hdr[cs + 2] = "ID";
  hdr[cs + 3] = "Team";
  hdr[cs + 4] = "Associate Name";
  hdr[cs + 5] = "Working "; // the real file pads it with a trailing space
  hdr[cs + 6] = (opts.year ?? 2026) - 1; // headed by the bare year, as a number
  hdr[cs + 7] = "Annual"; // the allowance — its "Leave" sits in the row below
  hdr[cs + 8] = "Planned";
  hdr[cs + 9] = "Day Offs";
  hdr[cs + 10] = "Annual leave";
  hdr[cs + 11] = "Core leave";
  hdr[cs + 12] = "Sick Leave";
  rows[20 + rs] = hdr;
  const sub: Cell[] = [];
  sub[cs + 1] = "No. ";
  sub[cs + 4] = "Associate Name"; // the sub-header repeats it — not a person
  sub[cs + 7] = "Leave";
  sub[cs + 10] = "remain";
  sub[cs + 11] = "remain";
  sub[cs + 12] = "remain";
  rows[21 + rs] = sub;
  opts.people.forEach(([name, values], i) => {
    const row: Cell[] = [];
    row[cs + 1] = i + 1;
    row[cs + 4] = name;
    for (const [field, value] of Object.entries(values)) {
      row[cs + BALANCE_COL[field as BalanceField]] = value as Cell;
    }
    rows.push(row);
  });
  const stray: Cell[] = []; // a leftover formula cell with no name beside it
  stray[cs + 10] = 0;
  rows.push(stray);
  rows.push([]);
  const legend: Cell[] = []; // "s | Sick leave" — `s` sits in the name column
  legend[cs + 1] = "w";
  legend[cs + 4] = "s";
  legend[cs + 5] = "Sick leave";
  rows.push(legend);
  return rows;
}

Deno.test("date helpers: quarter spans, leap years, next day", () => {
  assertEquals(daysInQuarter(2026, 1), 90);
  assertEquals(daysInQuarter(2028, 1), 91, "2028 is a leap year");
  assertEquals(daysInQuarter(2026, 2), 91);
  assertEquals(daysInQuarter(2026, 3), 92);
  assertEquals(daysInQuarter(2026, 4), 92);
  const q1 = quarterDates(2026, 1);
  assertEquals([q1[0], q1[89], q1.length], ["2026-01-01", "2026-03-31", 90]);
  assertEquals(nextDate("2026-02-28"), "2026-03-01");
  assertEquals(nextDate("2028-02-28"), "2028-02-29");
});

Deno.test("yearFromFilename: last plausible year wins", () => {
  assertEquals(yearFromFilename("mesoneer-Vacation-2026.xlsx"), 2026);
  assertEquals(yearFromFilename("vacation-2025-rev2026.xlsx"), 2026);
  assertEquals(yearFromFilename("vacation-plan.xlsx"), null);
});

Deno.test("parseVacationWorkbook: canonical layout — positions beat header values", () => {
  const rows = grid({ people: [["Anh Pham", "mortal", ["w", "p", "sm"]]], nDays: 90 });
  const model = parseVacationWorkbook([{ name: "1st quarter", rows }], { year: 2026 });
  assertEquals(model.people.length, 1);
  const anh = person(model, "Anh Pham");
  assertEquals(anh.team, "mortal");
  assertEquals(anh.location, "VN");
  assertEquals(anh.days["2026-01-01"], "w");
  assertEquals(anh.days["2026-01-02"], "p");
  assertEquals(anh.days["2026-01-03"], "sm");
  assertEquals(model.days.length, 90);
  assertEquals(model.warnings, []);
});

Deno.test("parseVacationWorkbook: survives the block shifting by a row and columns", () => {
  const rows = grid({
    people: [["Giang Pham", "EL", ["r", "w"]]],
    nDays: 90,
    rowShift: 1,
    colShift: 2,
  });
  const model = parseVacationWorkbook([{ name: "1st quarter", rows }], { year: 2026 });
  assertEquals(person(model, "Giang Pham").days["2026-01-01"], "r");
  assertEquals(person(model, "Giang Pham").days["2026-01-02"], "w");
  assertEquals(model.warnings, []);
});

Deno.test("parseVacationWorkbook: leap-day cell lands on 2028-02-29", () => {
  const codes: Cell[] = [];
  codes[59] = "v"; // Jan (31) + Feb 29th (index 31 + 28)
  const rows = grid({ people: [["Long Vo", "mortal", codes]], nDays: 91 });
  const model = parseVacationWorkbook([{ name: "1st quarter", rows }], { year: 2028 });
  assertEquals(person(model, "Long Vo").days["2028-02-29"], "v");
});

Deno.test("parseVacationWorkbook: trailing week columns and summary rows are ignored", () => {
  const rows = grid({
    people: [["Tam Tran", "PO", Array(91).fill("w")]],
    nDays: 91,
    extraWeekCols: 4, // numeric per-person aggregates after the last day
    summaryRows: true, // per-team weekly off-counts below the roster
  });
  const model = parseVacationWorkbook([{ name: "2nd quarter", rows }], { year: 2026 });
  assertEquals(model.people.length, 1, "summary rows must not become people");
  const tam = person(model, "Tam Tran");
  assertEquals(Object.keys(tam.days).length, 91, "week aggregates must not become days");
  assertEquals(tam.days["2026-06-30"], "w");
  assertEquals(model.warnings, [], "junk aggregate cells must not warn");
});

Deno.test("parseBalanceSheet: every column of the block, without the rows around them", () => {
  const rows = general({
    people: [
      // The sheet's own arithmetic: 0 + 12 - 0 - 6 = 6 left.
      ["Long Vo", {
        working: 235,
        carry: 0,
        allowance: 12,
        planned: 0,
        dayOffs: 6,
        annual: 6,
        core: 0,
        sick: 3,
      }],
      // Overdrawn, in both the carry-over and the remainder — real data.
      ["Tung Huynh", {
        working: 230.5,
        carry: -3,
        allowance: 12,
        planned: 3,
        dayOffs: 6.5,
        annual: -0.5,
        core: 0,
        sick: 1,
      }],
      // A joiner the block lists but has barely filled in.
      ["Vinh Nguyen", { working: 56, carry: 0, allowance: 2 }],
      ["Nhan Tran", {}], // nothing recorded yet — carries no balance at all
    ],
  });
  assertEquals(parseBalanceSheet(rows), [
    {
      name: "Long Vo",
      working: 235,
      carry: 0,
      allowance: 12,
      planned: 0,
      dayOffs: 6,
      annual: 6,
      core: 0,
      sick: 3,
    },
    {
      name: "Tung Huynh",
      working: 230.5,
      carry: -3,
      allowance: 12,
      planned: 3,
      dayOffs: 6.5,
      annual: -0.5,
      core: 0,
      sick: 1,
    },
    { name: "Vinh Nguyen", ...NO_BALANCE, working: 56, carry: 0, allowance: 2 },
  ]);
});

Deno.test("parseBalanceSheet: found by signature, not position; absent block yields nothing", () => {
  const shifted = general({
    people: [["Long Vo", { working: 235, annual: 6 }]],
    rowShift: 3,
    colShift: 2,
    year: 2028,
  });
  assertEquals(parseBalanceSheet(shifted), [
    { name: "Long Vo", ...NO_BALANCE, working: 235, annual: 6 },
  ], "the carry column is headed by whatever year the workbook precedes");
  const quarter = grid({ people: [["Long Vo", "mortal", ["w"]]], nDays: 90 });
  assertEquals(parseBalanceSheet(quarter), [], "a quarter sheet carries no balance block");
});

Deno.test("parseVacationWorkbook: balances join the roster by name", () => {
  const rows = grid({
    people: [
      ["Long Vo", "mortal", ["w", "p"]],
      ["Anh Pham", "mortal", ["w", "w"]],
    ],
    nDays: 90,
  });
  const model = parseVacationWorkbook([
    { name: "Vietnam Public Holidays", rows: [[null, "2026-01-01"]] },
    {
      name: "General",
      rows: general({
        people: [["long vo", { allowance: 12, dayOffs: 6, annual: 6, core: 0, sick: 3 }], [
          "Ghost",
          { annual: 1 },
        ]],
      }),
    },
    { name: "1st quarter", rows },
  ], { year: 2026 });
  assertEquals(person(model, "Long Vo").balance, {
    ...NO_BALANCE,
    allowance: 12,
    dayOffs: 6,
    annual: 6,
    core: 0,
    sick: 3,
  });
  assertEquals(person(model, "Anh Pham").balance, undefined, "unlisted people get no balance");
  assertEquals(model.warnings.length, 1);
  assertEquals(model.warnings[0].value, "Ghost");
  assertEquals(model.warnings[0].sheet, "General");
});

Deno.test("shiftBalance: books days against the allowance their code belongs to", () => {
  const start = {
    working: 235,
    carry: 0,
    allowance: 12,
    planned: 0,
    dayOffs: 6,
    annual: 6,
    core: 5,
    sick: 3,
  };
  // The sheet's own arithmetic must survive every change made here.
  const holds = (b: Record<string, number | null>) =>
    b.annual === (b.carry ?? 0) + (b.allowance ?? 0) - (b.planned ?? 0) - (b.dayOffs ?? 0);
  assertEquals(holds(start), true, "the fixture itself must satisfy the invariant");

  // A worked day booked as annual leave: off the working days, onto the day
  // offs, and the same amount off what is left.
  const annual = shiftBalance(start, [["w", "p"], ["w", "p"]]) as Record<string, number>;
  assertEquals(annual, { ...start, working: 233, dayOffs: 8, annual: 4 });
  assertEquals(holds(annual), true);

  // Planned vacation books against `planned`, not `dayOffs` — the sheet keeps
  // the two apart, and both take the same amount off `annual`.
  assertEquals(shiftBalance(start, [["w", "v"]]), {
    ...start,
    working: 234,
    planned: 1,
    annual: 5,
  });
  // Core and sick have no counted column, only a remainder.
  assertEquals(shiftBalance(start, [["w", "c"]]), { ...start, working: 234, core: 4 });
  assertEquals(shiftBalance(start, [["w", "s"]]), { ...start, working: 234, sick: 2 });
  // Half-day codes move half a day.
  assertEquals(shiftBalance(start, [["w", "m"]]), {
    ...start,
    working: 234.5,
    dayOffs: 6.5,
    annual: 5.5,
  });
  // Remote is not leave and is still a worked day: nothing moves at all.
  assertEquals(shiftBalance(start, [["w", "r"]]), start);
  // A day with no code was never a worked day, so booking it leaves `working`
  // alone — there was nothing there to take off.
  assertEquals(shiftBalance(start, [["", "p"]]), { ...start, dayOffs: 7, annual: 5 });

  // Exactly reversible — the property the undo path rests on.
  const changes: Array<[string, string]> = [["w", "p"], ["", "c"], ["w", "sm"]];
  const there = shiftBalance(start, changes);
  const back = shiftBalance(there, changes.map(([a, b]) => [b, a]));
  assertEquals(back, start, "replaying the pairs swapped restores the balance");

  // Marking days cannot invent a balance the workbook never recorded.
  assertEquals(
    shiftBalance({ ...start, annual: null, dayOffs: null }, [["w", "p"]]),
    { ...start, working: 234, dayOffs: null, annual: null },
  );
  assertEquals(shiftBalance(undefined, [["w", "p"]]), undefined, "no balance, nothing to move");
});

Deno.test("balanceTotals: sums what is there, counts only people who have a balance", () => {
  const rows = grid({
    people: [["Long Vo", "mortal", ["w"]], ["Anh Pham", "mortal", ["w"]], [
      "Tam Tran",
      "PO",
      ["w"],
    ]],
    nDays: 90,
  });
  const model = parseVacationWorkbook([
    {
      name: "General",
      rows: general({
        people: [
          ["Long Vo", {
            working: 235,
            carry: 0,
            allowance: 12,
            dayOffs: 6,
            annual: 6,
            core: 0.5,
            sick: 3,
          }],
          ["Anh Pham", {
            working: 230,
            carry: -1,
            allowance: 12,
            dayOffs: 11,
            annual: -1,
            sick: 2,
          }],
        ],
      }),
    },
    { name: "1st quarter", rows },
  ], { year: 2026 });
  assertEquals(balanceTotals(model.people), {
    people: 2,
    working: 465,
    carry: -1,
    allowance: 24,
    planned: 0, // neither row filled it in — a sum of nothing, not a wrong sum
    dayOffs: 17,
    annual: 5,
    core: 0.5,
    sick: 5,
  });
  assertEquals(balanceTotals([]), { people: 0, ...NO_BALANCE_TOTALS });
});

Deno.test("codeInfo: the full legend is mapped; unknown codes count as working", () => {
  assertEquals(Object.keys(CODES).length, 18);
  assertEquals(codeInfo("w").weight, 1);
  assertEquals(codeInfo("r").kind, "remote");
  assertEquals(codeInfo("ch").weight, 1);
  assertEquals(codeInfo("sm"), {
    kind: "sick",
    label: "Sick leave (morning)",
    weight: 0.5,
    half: "am",
  });
  assertEquals(codeInfo("si").weight, 0);
  assertEquals(codeInfo("w+aq54"), {
    kind: "unknown",
    label: "Unknown code",
    weight: 1,
    half: null,
  });
});

Deno.test("parseVacationWorkbook: dirty cells warn with coordinates and stay visible", () => {
  const rows = grid({ people: [["Phat Le", "capoo", ["w", "w", "w+AQ54"]]], nDays: 92 });
  const model = parseVacationWorkbook([{ name: "4th quarter", rows }], { year: 2026 });
  assertEquals(model.warnings.length, 1);
  assertEquals(model.warnings[0].sheet, "4th quarter");
  assertEquals(model.warnings[0].ref, "Q13", "0-based row 12 / col 16 is Q13");
  assertEquals(model.warnings[0].value, "w+AQ54");
  assertEquals(person(model, "Phat Le").days["2026-10-03"], "w+aq54");
});

Deno.test("parseVacationWorkbook: roster rows without a name warn and are skipped", () => {
  const rows = grid({
    people: [["", "pika", ["w"]], ["Phuc Nguyen", "pika", ["w"]]],
    nDays: 90,
  });
  const model = parseVacationWorkbook([{ name: "1st quarter", rows }], { year: 2026 });
  assertEquals(model.people.length, 1);
  assertEquals(model.warnings.length, 1);
  assertEquals(model.warnings[0].message.includes("without a name"), true);
});

Deno.test("parseVacationWorkbook: reconciles people across quarters, latest team wins", () => {
  const q1 = grid({
    people: [["Anh Pham", "Pragma", ["p"]], ["Chi Ho", "capy", ["w"]]],
    nDays: 90,
  });
  const q3 = grid({ people: [["Anh Pham", "pragma", ["v"]]], nDays: 92 });
  const model = parseVacationWorkbook(
    [{ name: "1st quarter", rows: q1 }, { name: "3RD QUARTER", rows: q3 }],
    { year: 2026 },
  );
  assertEquals(model.people.length, 2);
  const anh = person(model, "Anh Pham");
  assertEquals(anh.team, "pragma", "the later quarter's spelling wins");
  assertEquals(anh.days["2026-01-01"], "p");
  assertEquals(anh.days["2026-07-01"], "v");
  assertEquals(person(model, "Chi Ho").days["2026-01-01"], "w");
  assertEquals(model.days.length, 90 + 92);
});

Deno.test("parseVacationWorkbook: duplicate names inside one quarter merge, later row wins", () => {
  const rows = grid({
    people: [["Tri Vo", "mortal", ["w", "p"]], ["Tri Vo", "mortal", ["s"]]],
    nDays: 90,
  });
  const model = parseVacationWorkbook([{ name: "1st quarter", rows }], { year: 2026 });
  assertEquals(model.people.length, 1);
  assertEquals(person(model, "Tri Vo").days["2026-01-01"], "s");
  assertEquals(person(model, "Tri Vo").days["2026-01-02"], "p");
});

Deno.test("parseVacationWorkbook: a quarter sheet without the header signature is skipped", () => {
  const model = parseVacationWorkbook(
    [{ name: "2nd quarter", rows: [["nothing", "here"]] }],
    { year: 2026 },
  );
  assertEquals(model.people, []);
  assertEquals(model.days, []);
  assertEquals(model.warnings.length, 1);
  assertEquals(model.warnings[0].message.includes("sheet skipped"), true);
});

Deno.test("parseVacationWorkbook: rejects inputs it cannot work with", () => {
  assertThrows(
    () => parseVacationWorkbook([{ name: "General", rows: [] }], { year: 2026 }),
    "no quarter sheets",
  );
  // deno-lint-ignore no-explicit-any
  assertThrows(() => parseVacationWorkbook([], undefined as any), "needs { year }");
});

Deno.test("outOn: weekends stay quiet, holidays and halves show up, sorted by name", () => {
  const rows = grid({
    people: [
      ["Tho Bui", "a", ["e", "h", "w"]],
      ["Mai Bui", "a", ["p", "w", "sm"]],
      ["Duc Le", "b", ["w", "w", "w"]],
    ],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const day1 = outOn(model, "2026-07-01");
  assertEquals(day1.length, 1, "weekend code e is not 'out'");
  assertEquals([day1[0].name, day1[0].code, day1[0].weight], ["Mai Bui", "p", 0]);
  const day2 = outOn(model, "2026-07-02");
  assertEquals([day2[0].name, day2[0].kind], ["Tho Bui", "holiday"]);
  const day3 = outOn(model, "2026-07-03");
  assertEquals([day3[0].name, day3[0].code, day3[0].weight], ["Mai Bui", "sm", 0.5]);
});

Deno.test("outInRange: collects each person's not-fully-available days", () => {
  const rows = grid({
    people: [
      ["Tho Bui", "a", ["e", "h", "w"]],
      ["Mai Bui", "a", ["p", "w", "sm"]],
      ["Duc Le", "b", ["w", "w", "w"]],
    ],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const range = outInRange(model, "2026-07-01", "2026-07-03");
  assertEquals(range.length, 2, "fully-working people are omitted");
  assertEquals(range[0].name, "Mai Bui");
  assertEquals(range[0].dates.map((d) => [d.date, d.code]), [
    ["2026-07-01", "p"],
    ["2026-07-03", "sm"],
  ]);
  assertEquals(range[1].name, "Tho Bui");
  assertEquals(range[1].dates.map((d) => [d.date, d.code]), [["2026-07-02", "h"]]);
});

Deno.test("groupOutDates: same-code runs collapse, weekends bridge, changes split", () => {
  const entry = (date: string, code: string) => ({
    date,
    code,
    kind: codeInfo(code).kind,
    label: codeInfo(code).label,
    weight: codeInfo(code).weight,
  });
  // 2026-07-01 is a Wednesday; 04/05 are the weekend.
  const grouped = groupOutDates([
    entry("2026-07-01", "p"),
    entry("2026-07-02", "p"),
    entry("2026-07-03", "p"), // Friday …
    entry("2026-07-06", "p"), // … Monday — weekend gap bridges
    entry("2026-07-07", "sm"), // code change splits
    entry("2026-07-09", "p"), // Wednesday 08.07 is a working-day gap — no bridge
  ]);
  assertEquals(grouped.map((g) => [g.from, g.to, g.code]), [
    ["2026-07-01", "2026-07-06", "p"],
    ["2026-07-07", "2026-07-07", "sm"],
    ["2026-07-09", "2026-07-09", "p"],
  ]);
  assertEquals(grouped[0].label, "Annual leave");
  assertEquals(groupOutDates([]), []);
});

Deno.test("groupOutDates: accepts outInRange output directly", () => {
  const rows = grid({
    people: [["Cuong Ngo", "dexi", ["c", "c", "c", "e", "e", "c", "v"]]],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const [person] = outInRange(model, "2026-07-01", "2026-07-07");
  assertEquals(groupOutDates(person.dates).map((g) => [g.from, g.to, g.code]), [
    ["2026-07-01", "2026-07-06", "c"],
    ["2026-07-07", "2026-07-07", "v"],
  ]);
});

Deno.test("groupOutDates: days counts the run, not the span it reaches across", () => {
  const rows = grid({
    people: [["Cuong Ngo", "dexi", ["c", "c", "c", "e", "e", "c", "sm", "sa"]]],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const [person] = outInRange(model, "2026-07-01", "2026-07-08");
  assertEquals(groupOutDates(person.dates).map((g) => [g.from, g.to, g.days]), [
    // Wed–Fri plus the bridged Monday: four days off, not the six the range spans.
    ["2026-07-01", "2026-07-06", 4],
    ["2026-07-07", "2026-07-07", 0.5],
    ["2026-07-08", "2026-07-08", 0.5],
  ]);
});

/* -------- one person's whole imported axis -------- */

/** 2026-07-01 is a Wednesday; 04/05 are the weekend. The quarter sheet runs
 *  Jul–Sep, so the month run is three buckets wide however little is filled. */
function summaryPersonModel(codes: Cell[]) {
  const rows = grid({ people: [["Mai Bui", "aeon", codes]], nDays: 92 });
  return parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
}

Deno.test("personSummary: chips count code shares, out stays weight-based", () => {
  //         Wed  Thu  Fri  Sa   Su   Mon   Tue  Wed
  const codes = ["p", "m", "r", "e", "e", "rm", "w", "zz"];
  const summary = personSummary(summaryPersonModel(codes), "Mai Bui");
  if (summary === null) throw new Error("expected a summary");
  assertEquals(summary.team, "aeon");
  assertEquals(
    summary.kinds,
    [
      { kind: "leave", label: "Annual leave", days: 1.5 }, // p + half of m
      { kind: "remote", label: "WFH", days: 1.5 }, // r + half of rm
    ],
    "WFH earns a chip of its own, which 1 - weight would have counted as nothing",
  );
  // Weekends contribute to none of the three; the working day and the dirty
  // cell count as worked, and neither gets a chip.
  assertEquals([summary.out, summary.worked, summary.possible], [1.5, 4.5, 6]);
  assertEquals(summary.out + summary.worked, summary.possible);
});

Deno.test("personSummary: the month run covers the axis, absence or not", () => {
  const summary = personSummary(summaryPersonModel(["p", "m", "r"]), "Mai Bui");
  if (summary === null) throw new Error("expected a summary");
  // `days` counts what the chips count and `out` what availability costs, so a
  // month of nothing but WFH is a month with something in it.
  assertEquals(summary.months.map((m) => [m.label, m.days, m.out, m.possible]), [
    ["Jul 2026", 2.5, 1.5, 3],
    ["Aug 2026", 0, 0, 0], // a month with nothing in it keeps its (empty) bucket
    ["Sep 2026", 0, 0, 0],
  ]);
});

Deno.test("personSummary: ranges bridge a weekend and cover every chipped kind", () => {
  const codes = ["p", "p", "p", "e", "e", "p", "r", "r"];
  const summary = personSummary(summaryPersonModel(codes), "Mai Bui");
  if (summary === null) throw new Error("expected a summary");
  assertEquals(summary.ranges.map((r) => [r.from, r.to, r.code, r.days]), [
    ["2026-07-01", "2026-07-06", "p", 4],
    // WFH is in the list too, so every chip has ranges that account for it.
    ["2026-07-07", "2026-07-08", "r", 2],
  ]);
  assertEquals(
    summary.kinds.map((k) => k.days),
    summary.kinds.map((k) =>
      summary.ranges.filter((r) => r.kind === k.kind).reduce((n, r) => n + r.days, 0)
    ),
    "chips and ranges count on the same basis",
  );
});

Deno.test("personSummary: unknown name is null, an empty row is zeros", () => {
  const model = summaryPersonModel([]);
  assertEquals(personSummary(model, "Nobody At All"), null);
  const summary = personSummary(model, "Mai Bui");
  if (summary === null) throw new Error("a person with no days is still a person");
  assertEquals(summary.kinds, []);
  assertEquals(summary.ranges, []);
  assertEquals([summary.out, summary.worked, summary.possible], [0, 0, 0]);
  assertEquals(summary.months.length, 3);
});

Deno.test("teamCapacity: hand-computed sums, case-insensitive team grouping", () => {
  const rows = grid({
    people: [
      ["P One", "x", ["w", "w", "p", "sm", "r"]],
      ["P Two", "X", ["w", "h", "v", "w", "w"]],
      ["P Three", "y", ["e", "e", "e", "e", "e"]],
    ],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const teams = teamCapacity(model, "2026-07-01", "2026-07-05");
  assertEquals(teams.length, 2, "x and X are one team");
  assertEquals(teams[0], { team: "X", members: 2, available: 6.5, out: 3.5 });
  assertEquals(teams[1], { team: "y", members: 1, available: 0, out: 0 });
});

Deno.test("teamCapacity: available + out equals known non-weekend days", () => {
  const codes = Object.keys(CODES); // every legend code exactly once
  const rows = grid({ people: [["All Codes", "z", codes]], nDays: 92 });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const [z] = teamCapacity(model, "2026-07-01", "2026-07-31");
  assertEquals(z.available, 8, "1×w + 3×remote + 1×ch + 6×half");
  assertEquals(z.out, 9, "6×full-off + 6×half");
  assertEquals(z.available + z.out, codes.length - 1, "everything but the weekend");
});

Deno.test("applyLocationHolidays: CH overlay rewrites working days only, purely", () => {
  const rows = grid({
    people: [["Long Vo", "mortal", ["w", "p", "r", "e"]], ["Anh Vo", "mortal", ["w", "w"]]],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const tagged = applyLocationHolidays(
    model,
    { "Long Vo": "CH" },
    ["2026-07-01", "2026-07-02", "2026-07-04", "2026-12-25"],
  );
  const long = person(tagged, "Long Vo");
  assertEquals(long.location, "CH");
  assertEquals(long.days["2026-07-01"], "h", "working day on a CH holiday becomes h");
  assertEquals(long.days["2026-07-02"], "p", "already-off days keep their code");
  assertEquals(long.days["2026-07-03"], "r", "non-holiday remote day untouched");
  assertEquals(long.days["2026-07-04"], "e", "weekends stay weekends");
  assertEquals(person(tagged, "Anh Vo").days["2026-07-01"], "w", "VN people untouched");
  assertEquals(person(model, "Long Vo").days["2026-07-01"], "w", "input model not mutated");
  assertEquals(person(model, "Long Vo").location, "VN");
});

Deno.test("applyLocationHolidays: a dirty code survives a CH holiday untouched", () => {
  // An unknown code weighs 1 like `w` does, but its warning promised the cell
  // would be "counted as working" and kept visible — the overlay must not eat it.
  const rows = grid({
    people: [["Long Vo", "mortal", ["w", "w+AQ54", "r"]]],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  assertEquals(model.warnings.length, 1, "the dirty cell warned");
  const tagged = applyLocationHolidays(
    model,
    { "Long Vo": "CH" },
    ["2026-07-01", "2026-07-02", "2026-07-03"],
  );
  const long = person(tagged, "Long Vo");
  assertEquals(long.days["2026-07-01"], "h", "a known working code still converts");
  assertEquals(long.days["2026-07-02"], "w+aq54", "the dirty code is left alone");
  assertEquals(long.days["2026-07-03"], "h", "remote converts too");
});

Deno.test("holidayName: names the day per location, null outside the built-in sets", () => {
  assertEquals(holidayName("2026-08-01", "CH"), "Bundesfeier");
  assertEquals(holidayName("2026-02-16", "VN"), "Tet Holiday");
  assertEquals(holidayName("2026-11-24", "VN"), "Vietnam Cultural Day (company)");
  assertEquals(holidayName("2026-08-01", "VN"), null, "Swiss national day is not a VN holiday");
  assertEquals(holidayName("2026-07-15", "CH"), null, "an ordinary working day");
  assertEquals(holidayName("2031-01-01", "CH"), null, "beyond the maintained years");
});

Deno.test("HOLIDAYS_VN: every entry is a named ISO date", () => {
  assertEquals(HOLIDAYS_VN.length > 0, true);
  for (const h of HOLIDAYS_VN) {
    assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(h.date), true, h.date);
    assertEquals(h.name.length > 0, true, h.date);
  }
});

Deno.test("HOLIDAYS: object form plugs straight into the overlay; dates are ISO", () => {
  for (const h of HOLIDAYS_CH_ZURICH) {
    assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(h.date), true, h.date);
  }
  assertEquals(HOLIDAYS_CH_ZURICH.some((h) => h.date === "2026-05-14"), true, "Auffahrt 2026");
  const rows = grid({ people: [["Long Vo", "mortal", Array(92).fill("w")]], nDays: 92 });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const tagged = applyLocationHolidays(model, { "Long Vo": "CH" }, HOLIDAYS_CH_ZURICH);
  assertEquals(person(tagged, "Long Vo").days["2026-08-01"], "h", "Bundesfeier applied");
});

Deno.test("parseCsv: quotes, escaped quotes, CRLF and bare CR", () => {
  assertEquals(parseCsv('a,"b ""q"", c",d\r\nx\ry,"z\nz"'), [
    ["a", 'b "q", c', "d"],
    ["x"],
    ["y", "z\nz"],
  ]);
});

Deno.test("parseQuarterCsv: one exported quarter equals the xlsx path", () => {
  const rows = grid({
    people: [["Vo, Long", "mortal", ["w", "p", "sm"]]],
    nDays: 92,
    extraWeekCols: 2,
    summaryRows: true,
  });
  const csv = rows
    .map((row) => {
      const cells: string[] = [];
      for (let i = 0; i < row.length; i++) {
        const v = row[i];
        const s = v === null || v === undefined ? "" : String(v);
        cells.push(/[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
      }
      return cells.join(",");
    })
    .join("\r\n");
  const fromCsv = parseQuarterCsv(csv, { year: 2026, quarter: 3 });
  const fromRows = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  assertEquals(fromCsv.people, fromRows.people, "same model through either path");
  assertEquals(fromCsv.days, fromRows.days);
  assertEquals(person(fromCsv, "Vo, Long").days["2026-07-02"], "p", "quoted comma name");
  assertThrows(() => parseQuarterCsv("x", { year: 2026, quarter: 5 }), "quarter (1-4)");
});

Deno.test("mondayOf: snaps any day to its week's Monday, across year ends too", () => {
  assertEquals(mondayOf("2026-07-25"), "2026-07-20", "Saturday");
  assertEquals(mondayOf("2026-07-20"), "2026-07-20", "Monday stays");
  assertEquals(mondayOf("2026-07-26"), "2026-07-20", "Sunday belongs to the same week");
  assertEquals(mondayOf("2026-01-04"), "2025-12-29", "first week can start last year");
});

Deno.test("remoteOn: lists remote and onsite people, not the office ones", () => {
  const rows = grid({
    people: [
      ["Tuyen Nguyen", "capoo", ["w"]],
      ["Linh Vo", "pika", ["rm"]],
      ["Bao Huynh", "capy", ["ch"]],
      ["Mai Bui", "a", ["p"]],
    ],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const away = remoteOn(model, "2026-07-01");
  assertEquals(away.map((x) => [x.name, x.code, x.kind, x.half]), [
    ["Bao Huynh", "ch", "onsite", null],
    ["Linh Vo", "rm", "remote", "am"],
  ]);
});

Deno.test("packModel/unpackModel: survives a JSON round-trip, commas and all", () => {
  const rows = grid({
    people: [["Long Vo", "mortal", ["w", "p", "x,y", null, "sm"]]],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  assertEquals(model.warnings.length, 1, "x,y is a dirty cell");
  const restored = unpackModel(JSON.parse(JSON.stringify(packModel(model))));
  assertEquals(restored, model, "byte-for-byte model round-trip");
  assertEquals(person(restored as Model, "Long Vo").days["2026-07-03"], "x,y");
  assertEquals(person(restored as Model, "Long Vo").days["2026-07-04"], undefined);
});

Deno.test("unpackModel: rejects malformed or future payloads with null", () => {
  assertEquals(unpackModel(null), null);
  assertEquals(unpackModel("nope"), null);
  assertEquals(unpackModel({ v: 2, days: "", people: [] }), null);
  assertEquals(unpackModel({ v: 1, days: "", people: [{ name: 1, codes: "" }] }), null);
});

Deno.test("packModel/unpackModel: balances travel; only real numbers survive", () => {
  const rows = grid({
    people: [["Long Vo", "mortal", ["w"]], ["Anh Pham", "mortal", ["w"]]],
    nDays: 90,
  });
  const model = parseVacationWorkbook([
    {
      name: "General",
      rows: general({ people: [["Long Vo", { working: 235, annual: 6, sick: -1 }]] }),
    },
    { name: "1st quarter", rows },
  ], { year: 2026 });
  const packed = packModel(model);
  assertEquals(packed.people[1].balance, undefined, "a person without one stays without one");
  const restored = unpackModel(JSON.parse(JSON.stringify(packed)));
  assertEquals(restored, model, "byte-for-byte model round-trip, balances and all");

  // The payload crosses a storage boundary — a string where a number belongs
  // would reach the totals line as string concatenation.
  const dirty = unpackModel({
    v: 1,
    days: "2026-01-01",
    people: [{
      name: "Long Vo",
      codes: "w",
      balance: { working: "235", annual: "6", core: 2, sick: null },
    }],
  }) as Model;
  assertEquals(dirty.people[0].balance, { ...NO_BALANCE, core: 2 });
});

Deno.test("encodeShare/decodeShare: fragment-safe gzip round-trip", async () => {
  const rows = grid({
    people: [
      ["Long Vo", "mortal", Array(92).fill("w")],
      ["Anh Pham", "mortal", ["p", "v", "sm"]],
    ],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const payload = { v: 1, year: 2026, tags: { "Long Vo": "CH" }, model: packModel(model) };
  const encoded = await encodeShare(payload);
  assertEquals(/^[A-Za-z0-9_-]+$/.test(encoded), true, "base64url only — no +, / or =");
  assertEquals(
    encoded.length < JSON.stringify(payload).length / 3,
    true,
    "repetitive day codes must compress well",
  );
  const decoded = await decodeShare(encoded);
  assertEquals(decoded, payload, "payload survives the round-trip");
  assertEquals(unpackModel((decoded as { model: unknown }).model), model);
});

Deno.test("encodeShare: a replace flag survives the round trip, absence means merge", async () => {
  // The scheduled workbook refresh marks its payload `replace` so a whole-year
  // import drops people who left; a shared slice omits it and merges.
  const rows = grid({ people: [["Long Vo", "mortal", ["w", "p"]]], nDays: 92 });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const packed = packModel(model);
  const refresh = { v: 1, year: 2026, tags: {}, replace: true, model: packed };
  const slice = { v: 1, year: 2026, tags: {}, model: packed };
  const decodedRefresh = await decodeShare(await encodeShare(refresh)) as { replace?: unknown };
  const decodedSlice = await decodeShare(await encodeShare(slice)) as { replace?: unknown };
  assertEquals(decodedRefresh.replace, true);
  assertEquals(decodedSlice.replace, undefined, "an old link carries no flag");
  // The page reads it as `payload.replace === true`, so anything else merges.
  assertEquals(decodedSlice.replace === true, false);
  // The flag rides alongside the model without disturbing it.
  assertEquals(unpackModel((decodedRefresh as { model: unknown }).model), model);
});

Deno.test("decodeShare: garbage in, null out", async () => {
  assertEquals(await decodeShare("definitely not a share link"), null);
  assertEquals(await decodeShare(""), null);
  // Valid base64url, but the bytes are not gzip.
  assertEquals(await decodeShare(btoa("plain text").replace(/=+$/, "")), null);
});

/* -------- helpers that moved out of app.js (were untested there) -------- */

Deno.test("addDays: shifts both ways across months, years and leap days", () => {
  assertEquals(addDays("2026-07-25", 6), "2026-07-31");
  assertEquals(addDays("2026-07-25", 7), "2026-08-01");
  assertEquals(addDays("2026-07-25", 0), "2026-07-25");
  assertEquals(addDays("2026-01-01", -1), "2025-12-31");
  assertEquals(addDays("2028-02-28", 1), "2028-02-29", "leap year");
  assertEquals(addDays("2026-02-28", 1), "2026-03-01");
});

Deno.test("isWeekend: answers from the calendar, not from the `e` day code", () => {
  // 2026-07-25 is a Saturday, 26th the Sunday, 27th the Monday.
  assertEquals([24, 25, 26, 27].map((d) => isWeekend(`2026-07-${d}`)), [
    false,
    true,
    true,
    false,
  ]);
});

Deno.test("prettyDay / shortDay / trimNumber: display forms", () => {
  assertEquals(prettyDay("2026-07-25"), "Sa 25.07");
  assertEquals(prettyDay("2026-07-01"), "We 01.07");
  assertEquals(shortDay("2026-07-01"), "01.07");
  assertEquals(trimNumber(8), "8", "whole days carry no decimal");
  assertEquals(trimNumber(6.5), "6.5");
  assertEquals(trimNumber(0), "0");
});

Deno.test("viewDates: a whole month or a whole quarter around the anchor", () => {
  const july = viewDates("month", "2026-07-25");
  assertEquals([july.length, july[0], july[30]], [31, "2026-07-01", "2026-07-31"]);
  assertEquals(viewDates("month", "2026-02-10").length, 28);
  assertEquals(viewDates("month", "2028-02-10").length, 29, "leap February");
  const q3 = viewDates("quarter", "2026-08-14");
  assertEquals([q3.length, q3[0], q3[91]], [92, "2026-07-01", "2026-09-30"]);
  assertEquals(viewDates("quarter", "2026-01-31")[0], "2026-01-01");
});

Deno.test("weekSlices: edge weeks are clamped to the view, `from` is on screen", () => {
  // July 2026 starts on a Wednesday and ends on a Friday, so both edge weeks
  // are stubs — the capacity table used to label the first one "29.06".
  const slices = weekSlices(viewDates("month", "2026-07-25"));
  assertEquals(slices.map((s) => [s.monday, s.from, s.to, s.days]), [
    ["2026-06-29", "2026-07-01", "2026-07-05", 5],
    ["2026-07-06", "2026-07-06", "2026-07-12", 7],
    ["2026-07-13", "2026-07-13", "2026-07-19", 7],
    ["2026-07-20", "2026-07-20", "2026-07-26", 7],
    ["2026-07-27", "2026-07-27", "2026-07-31", 5],
  ]);
  assertEquals(slices.reduce((n, s) => n + s.days, 0), 31, "every day lands in exactly one week");
  assertEquals(weekSlices([]), []);
  assertEquals(weekSlices(["2026-07-25"]), [{
    monday: "2026-07-20",
    from: "2026-07-25",
    to: "2026-07-25",
    days: 1,
  }]);
});

Deno.test("monthSpans: one span per month run, in view order", () => {
  assertEquals(monthSpans(viewDates("quarter", "2026-08-14")), [
    { month: "2026-07", label: "Jul 2026", days: 31 },
    { month: "2026-08", label: "Aug 2026", days: 31 },
    { month: "2026-09", label: "Sep 2026", days: 30 },
  ]);
  assertEquals(monthSpans(viewDates("month", "2026-02-01")), [
    { month: "2026-02", label: "Feb 2026", days: 28 },
  ]);
  assertEquals(monthSpans([]), []);
});

Deno.test("clampAnchor: pulls the view into the imported span", () => {
  const days = ["2026-07-01", "2026-08-15", "2026-09-30"];
  assertEquals(clampAnchor("2027-03-04", days), "2026-09-30", "anchor after the data");
  assertEquals(clampAnchor("2025-01-01", days), "2026-07-01", "anchor before the data");
  assertEquals(clampAnchor("2026-08-20", days), "2026-08-20", "already inside — untouched");
  assertEquals(clampAnchor("2027-03-04", []), "2027-03-04", "nothing imported — untouched");
});

Deno.test("splitHoliday: the public-holiday cohort separates from real absences", () => {
  const rows = grid({
    people: [
      ["Mai Bui", "a", ["p"]],
      ["Tho Bui", "a", ["h"]],
      ["Duc Le", "b", ["h"]],
    ],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const { holiday, other } = splitHoliday(outOn(model, "2026-07-01"));
  assertEquals(holiday.map((h) => h.name), ["Duc Le", "Tho Bui"]);
  assertEquals(other.map((o) => o.name), ["Mai Bui"]);
  assertEquals(splitHoliday([]), { holiday: [], other: [] });
});

Deno.test("dayCounts: weekends skipped, holidays counted apart from absences", () => {
  // Indices run 2026-07-01 (We) … 04/05 are the weekend, 06 the Monday.
  const rows = grid({
    people: [
      ["Mai Bui", "a", ["p", "p", "w", "e", "e", "p", "w"]],
      ["Tho Bui", "a", ["h", "w", "w", "e", "e", "w", "w"]],
    ],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  assertEquals(dayCounts(model, "2026-07-01", "2026-07-07"), [
    { date: "2026-07-01", count: 1, holiday: 1 },
    { date: "2026-07-02", count: 1, holiday: 0 },
    { date: "2026-07-03", count: 0, holiday: 0 },
    { date: "2026-07-06", count: 1, holiday: 0 },
    { date: "2026-07-07", count: 0, holiday: 0 },
  ]);
});

Deno.test("outDatesText / outDatesLabelText: chip text from grouped out-days", () => {
  const rows = grid({
    people: [["Mai Bui", "a", ["p", "p", "p", "e", "e", "p", "sm"]]],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const [mai] = outInRange(model, "2026-07-01", "2026-07-07");
  assertEquals(outDatesText(mai.dates), "01.07–06.07, 07.07");
  assertEquals(
    outDatesLabelText(mai.dates),
    "01.07–06.07 Annual leave, 07.07 Sick leave (morning)",
  );
  assertEquals(outDatesText([]), "");
});

/* -------- capacity grid & low-coverage flagging -------- */

/**
 * Two teams over the first ten days of Q3 2026 (01.07 is a Wednesday, so the
 * first week is a 5-day stub covering 01–05.07 with only 3 working days).
 * `thin` is deliberately gutted in the second week, `solid` is not.
 */
function coverageModel() {
  const rows = grid({
    people: [
      // 01,02,03 | 04,05 weekend | 06,07,08,09,10
      ["Thin One", "thin", ["w", "w", "w", "e", "e", "p", "p", "p", "p", "w"]],
      ["Thin Two", "thin", ["w", "w", "w", "e", "e", "p", "p", "c", "w", "w"]],
      ["Solid One", "solid", ["w", "w", "w", "e", "e", "w", "w", "w", "r", "w"]],
    ],
    nDays: 92,
  });
  return parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
}

Deno.test("capacityGrid: one row per team, part weeks keep their own maximum", () => {
  const weeks = weekSlices(viewDates("month", "2026-07-10"));
  const rows = capacityGrid(coverageModel(), weeks);
  assertEquals(rows.map((r) => [r.team, r.members]), [["solid", 1], ["thin", 2]]);
  // Week 1 = 01–05.07: 3 working days. Week 2 = 06–12.07: 5 working days.
  assertEquals(
    rows[1].cells[0],
    { available: 6, possible: 6 },
    "thin, stub week: 2 people × 3 days",
  );
  assertEquals(rows[1].cells[1], { available: 3, possible: 10 }, "thin, week 2: 7 of 10 lost");
  assertEquals(rows[0].cells[1], { available: 5, possible: 5 }, "solid, week 2: remote counts");
  assertEquals(rows[0].cells[2], null, "no data past 10.07 — null, never a zero");
  assertEquals(capacityGrid(coverageModel(), []), []);
});

Deno.test("lowCoverage: flags team-weeks under the threshold, ignores no-data weeks", () => {
  const weeks = weekSlices(viewDates("month", "2026-07-10"));
  const rows = capacityGrid(coverageModel(), weeks);
  const low = lowCoverage(rows, weeks, 0.6);
  assertEquals(low.map((l) => [l.team, l.from, l.available, l.possible]), [
    ["thin", "2026-07-06", 3, 10],
  ], "only thin's second week is under 60%");
  assertEquals(low[0].ratio, 0.3);
  // A full week at exactly the threshold is not "below" it.
  assertEquals(lowCoverage(rows, weeks, 0.3).length, 0, "0.3 is not < 0.3");
  assertEquals(lowCoverage(rows, weeks, 0.31).length, 1);
  assertEquals(lowCoverage(rows, weeks, 0), [], "a zero threshold reports nothing");
  // The other three non-null cells sit at exactly 100%, and 1 is not < 1.
  assertEquals(lowCoverage(rows, weeks, 1).length, 1, "a fully covered week is never below 100%");
});

Deno.test("lowCoverage: an entirely unimported range yields nothing, not everything", () => {
  const weeks = weekSlices(viewDates("month", "2026-01-15"));
  const rows = capacityGrid(coverageModel(), weeks);
  assertEquals(rows.every((r) => r.cells.every((c) => c === null)), true);
  assertEquals(lowCoverage(rows, weeks, 0.6), []);
});

/* -------- the copied standup summary -------- */

/** 2026-07-01 is a Wednesday; 04/05 are the weekend, 09.07 a Thursday. */
function summaryModel() {
  const rows = grid({
    people: [
      ["Mai Bui", "a", ["p", "p", "p", "e", "e", "p", "w", "w", "h"]],
      ["Tho Bui", "a", ["h", "w", "w", "e", "e", "w", "w", "w", "h"]],
      ["Duc Le", "b", ["r", "w", "w", "e", "e", "w", "w", "w", "h"]],
    ],
    nDays: 92,
  });
  return parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
}

Deno.test("summaryText: a working day names absences, remotes and the per-day index", () => {
  assertEquals(summaryText(summaryModel(), "2026-07-01").split("\n"), [
    "Availability We 01.07",
    "Public holiday — 1 off",
    "Out: Mai Bui (Annual leave)",
    "Remote/onsite: Duc Le (WFH)",
    "Per day: 01.07 1 · 02.07 1 · 03.07 1 · 06.07 1 · 07.07 0",
    "Next 7 days:",
    "  Mai Bui: 01.07–06.07 Annual leave",
    "  Tho Bui: 01.07 Public holiday",
  ]);
});

Deno.test("summaryText: a weekend says so instead of 'Out: nobody'", () => {
  const lines = summaryText(summaryModel(), "2026-07-04").split("\n");
  assertEquals(lines[0], "Availability Sa 04.07");
  assertEquals(lines[1], "Weekend — nobody scheduled");
  assertEquals(lines.some((l) => l.startsWith("Out:")), false, "no misleading 'nobody'");
  assertEquals(
    lines[2],
    "Per day: 06.07 1 · 07.07 0 · 08.07 0 · 09.07 holiday · 10.07 0",
    "a day everyone is off reads as the holiday it is, not as 3 absences",
  );
});

Deno.test("summaryText: a full public holiday collapses to one line", () => {
  const lines = summaryText(summaryModel(), "2026-07-09").split("\n");
  assertEquals(lines[0], "Availability Th 09.07");
  assertEquals(lines[1], "Public holiday — 3 off");
  assertEquals(lines.some((l) => l.startsWith("Out:")), false, "everyone off is not 'Out: nobody'");
});

Deno.test("mergeModels: reconciles like the workbook parser, purely", () => {
  const q1 = parseVacationWorkbook(
    [{ name: "1st quarter", rows: grid({ people: [["Anh Pham", "Pragma", ["p"]]], nDays: 90 }) }],
    { year: 2026 },
  );
  const q3 = parseVacationWorkbook(
    [{
      name: "3rd quarter",
      rows: grid({
        people: [["Anh Pham", "pragma", ["v"]], ["Khoi Le", "Pragma", ["w"]]],
        nDays: 92,
      }),
    }],
    { year: 2026 },
  );
  const merged = mergeModels(q1, q3);
  assertEquals(merged.people.length, 2);
  const anh = person(merged, "Anh Pham");
  assertEquals(anh.team, "pragma");
  assertEquals(anh.days["2026-01-01"], "p");
  assertEquals(anh.days["2026-07-01"], "v");
  assertEquals(merged.days.length, 90 + 92);
  assertEquals(person(q1, "Anh Pham").team, "Pragma", "base model not mutated");
  assertEquals(person(q1, "Anh Pham").days["2026-07-01"], undefined);
});

Deno.test("mergeModels: a balance-less payload leaves the held balances alone", () => {
  const held = { working: 235, annual: 6, core: 0, sick: 3 };
  const workbook = parseVacationWorkbook([
    { name: "General", rows: general({ people: [["Anh Pham", held]] }) },
    { name: "1st quarter", rows: grid({ people: [["Anh Pham", "Pragma", ["p"]]], nDays: 90 }) },
  ], { year: 2026 });
  // The CSV path imports a quarter grid, which carries no balance block at all.
  const csvOnly = parseVacationWorkbook(
    [{ name: "3rd quarter", rows: grid({ people: [["Anh Pham", "Pragma", ["v"]]], nDays: 92 }) }],
    { year: 2026 },
  );
  assertEquals(
    person(mergeModels(workbook, csvOnly), "Anh Pham").balance,
    { ...NO_BALANCE, ...held },
    "a quarter import must not wipe the balances a workbook brought",
  );
  assertEquals(
    person(mergeModels(csvOnly, workbook), "Anh Pham").balance,
    { ...NO_BALANCE, ...held },
    "and the other way round it supplies them",
  );
  assertEquals(person(workbook, "Anh Pham").days["2026-07-01"], undefined, "inputs untouched");
});

Deno.test("leaveHandoffText: carries who and when, and maps the code to a leave type", () => {
  const read = (text: string) => JSON.parse(text);

  // A planned-vacation range: annual leave over full days.
  assertEquals(
    read(leaveHandoffText({ name: "Anh Pham", code: "v", from: "2026-07-27", to: "2026-07-29" })),
    {
      v: 1,
      name: "Anh Pham",
      type: "annual",
      duration: "full",
      from: "2026-07-27",
      to: "2026-07-29",
    },
  );
  // Every kind the Leave tool has a type for.
  const typeOf = (code: string) =>
    read(leaveHandoffText({ name: "X", code, from: "2026-07-27", to: "2026-07-27" })).type;
  assertEquals(typeOf("p"), "annual", "annual leave");
  assertEquals(typeOf("c"), "core", "core leave");
  assertEquals(typeOf("s"), "sick", "sick leave");
  assertEquals(typeOf("si"), "social", "social leave");
  assertEquals(typeOf("r"), "wfh", "remote is WFH");
  // Kinds with no leave equivalent leave the target on its own default.
  assertEquals(typeOf("w"), null, "a working day implies no leave type");
  assertEquals(typeOf("ch"), null, "onsite is not a leave type");
  assertEquals(typeOf("h"), null, "a public holiday is not requested");
  assertEquals(typeOf("e"), null, "nor is a weekend");
  assertEquals(typeOf("?"), null, "unknown codes carry no type");

  // A half-day code describes one day, so it only sets a half duration there.
  const half = (from: string, to: string) =>
    read(leaveHandoffText({ name: "X", code: "sm", from, to })).duration;
  assertEquals(half("2026-07-27", "2026-07-27"), "morning", "morning half of a single day");
  assertEquals(
    read(leaveHandoffText({ name: "X", code: "sa", from: "2026-07-27", to: "2026-07-27" }))
      .duration,
    "afternoon",
    "afternoon half of a single day",
  );
  assertEquals(half("2026-07-27", "2026-07-28"), "full", "a multi-day pick is always full days");

  // A cell with no code at all still hands over the dates.
  assertEquals(
    read(leaveHandoffText({ name: "Anh Pham", from: "2026-07-27", to: "2026-07-27" })),
    { v: 1, name: "Anh Pham", type: null, duration: "full", from: "2026-07-27", to: "2026-07-27" },
  );

  // The dialog's override path: an explicit type or duration replaces the
  // code-derived one, and what is not overridden keeps its derived value.
  assertEquals(
    read(leaveHandoffText({
      name: "Anh Pham",
      code: "v",
      from: "2026-07-27",
      to: "2026-07-29",
      type: "sick",
      duration: "morning",
    })),
    {
      v: 1,
      name: "Anh Pham",
      type: "sick",
      duration: "morning",
      from: "2026-07-27",
      to: "2026-07-29",
    },
  );
  assertEquals(
    read(
      leaveHandoffText({
        name: "X",
        code: "sm",
        from: "2026-07-27",
        to: "2026-07-27",
        type: "wfh",
      }),
    ),
    { v: 1, name: "X", type: "wfh", duration: "morning", from: "2026-07-27", to: "2026-07-27" },
  );
});

Deno.test("leavableDays: a pick offers a request only when a day could be taken off", () => {
  // 2026-07-04/05 are the quarter's first Saturday and Sunday.
  const sat = "2026-07-04";
  const sun = "2026-07-05";
  const mon = "2026-07-06";

  // Nothing to request: a weekend is not a day anyone has to ask for.
  assertEquals(leavableDays([{ date: sat, code: "e" }, { date: sun, code: "e" }]), {
    leavable: 0,
    weekend: 2,
    holiday: 0,
    outside: 0,
    markable: 0,
    reason: "weekend",
  });
  // A public holiday is already free — booking it would spend a leave day on a
  // day nobody works.
  assertEquals(leavableDays([{ date: mon, code: "h" }]).reason, "public holiday");
  assertEquals(
    leavableDays([{ date: sat, code: "e" }, { date: mon, code: "h" }]).reason,
    "weekend and public holiday",
  );

  // One workable day is enough — a Friday-to-Monday pick is the normal case.
  const across = leavableDays([
    { date: "2026-07-03", code: "w" },
    { date: sat, code: "e" },
    { date: sun, code: "e" },
    { date: mon, code: "w" },
  ]);
  assertEquals([across.leavable, across.weekend, across.reason], [2, 2, null]);

  // A day the workbook never filled in is still a day you can ask for.
  assertEquals(leavableDays([{ date: mon, code: "" }]).reason, null);
  assertEquals(leavableDays([{ date: mon }]).reason, null);
  // Days already marked as leave stay requestable: filing the HR request for
  // days blocked on the grid is what the button is for.
  assertEquals(leavableDays([{ date: mon, code: "p" }]).reason, null);
  assertEquals(leavableDays([{ date: mon, code: "c" }]).reason, null);

  // The calendar answers for a blank weekend cell; the code answers when the
  // sheet marked one itself.
  assertEquals(leavableDays([{ date: sat, code: "" }]).reason, "weekend");
  assertEquals(leavableDays([{ date: mon, code: "e" }]).reason, "weekend");

  // An empty pick is not a refusal — there is simply nothing picked yet.
  assertEquals(leavableDays([]), {
    leavable: 0,
    weekend: 0,
    holiday: 0,
    outside: 0,
    markable: 0,
    reason: null,
  });
});

Deno.test("leavableDays: days outside the imported range are requestable but not markable", () => {
  const sat = "2026-08-01";
  const mon = "2026-08-03";
  const tue = "2026-08-04";

  // A month the workbook never covered is still a month someone can ask off:
  // the dates are real, so this is a note about marking, never a refusal.
  const none = leavableDays([
    { date: mon, code: "", outside: true },
    { date: tue, code: "", outside: true },
  ]);
  assertEquals(none, {
    leavable: 2,
    weekend: 0,
    holiday: 0,
    outside: 2,
    markable: 0,
    reason: null,
  });

  // Straddling the boundary: only the imported side can be written to.
  const straddle = leavableDays([
    { date: "2026-07-30", code: "w" },
    { date: "2026-07-31", code: "w" },
    { date: sat, code: "", outside: true },
    { date: mon, code: "", outside: true },
  ]);
  assertEquals([straddle.markable, straddle.outside, straddle.weekend, straddle.reason], [
    2,
    2,
    1,
    null,
  ]);

  // An all-weekend pick is still refused whether or not it was imported — the
  // two questions are independent.
  assertEquals(leavableDays([{ date: sat, code: "", outside: true }]).reason, "weekend");
});

Deno.test("leavableDays: `markable` equals what applyDayCodes would actually write", () => {
  // 2026-07-01 is a Wednesday; the model covers Q3 only, so August 2026 is in
  // view but never imported.
  const rows = grid({
    people: [["Mai Bui", "a", ["w", "w", "w", "e", "e", "w", "w"]]],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  const imported = new Set(model.days);
  const person0 = model.people[0];

  for (const [from, to] of [["2026-07-02", "2026-07-07"], ["2026-09-28", "2026-10-05"]]) {
    const picked = [];
    for (let d = from; d <= to; d = nextDate(d)) {
      picked.push({
        date: d,
        code: person0.days[d] ?? "",
        outside: !imported.has(d),
      });
    }
    const written = applyDayCodes(model, { name: "Mai Bui", from, to, code: "p" }).written;
    assertEquals(
      leavableDays(picked).markable,
      written,
      `${from}..${to}: the dialog's preview must match what marking writes`,
    );
  }
});

Deno.test("leaveHandoffDefaults: the prefill matches what the handoff would send", () => {
  assertEquals(
    leaveHandoffDefaults({ code: "v", from: "2026-07-27", to: "2026-07-29" }),
    { type: "annual", duration: "full" },
  );
  assertEquals(
    leaveHandoffDefaults({ code: "sm", from: "2026-07-27", to: "2026-07-27" }),
    { type: "sick", duration: "morning" },
  );
  // No leave equivalent → no type; a multi-day pick is always full days.
  assertEquals(
    leaveHandoffDefaults({ code: "w", from: "2026-07-27", to: "2026-07-27" }),
    { type: null, duration: "full" },
  );
  assertEquals(
    leaveHandoffDefaults({ code: "sm", from: "2026-07-27", to: "2026-07-28" }),
    { type: "sick", duration: "full" },
  );
});

Deno.test("applyDayCodes: writes a leave request back onto one person's row", () => {
  // 2026-07-01 is a Wednesday, so 04/05.07 are the first weekend.
  const rows = grid({
    people: [
      ["Mai Bui", "a", ["w", "w", "w", "e", "e", "w", "w"]],
      ["Duc Le", "b", ["w", "w", "w", "e", "e", "w", "w"]],
    ],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });

  // A range across the weekend: the working days take the code, the weekend
  // keeps `e` — overwriting it would claim someone worked a Saturday.
  const across = applyDayCodes(model, {
    name: "Mai Bui",
    from: "2026-07-02",
    to: "2026-07-07",
    code: "p",
  });
  assertEquals([across.name, across.written, across.weekend, across.outside], ["Mai Bui", 4, 2, 0]);
  assertEquals(person(across.model, "Mai Bui").days["2026-07-02"], "p");
  assertEquals(person(across.model, "Mai Bui").days["2026-07-03"], "p");
  assertEquals(person(across.model, "Mai Bui").days["2026-07-04"], "e", "Saturday untouched");
  assertEquals(person(across.model, "Mai Bui").days["2026-07-06"], "p");
  assertEquals(person(across.model, "Duc Le").days["2026-07-02"], "w", "nobody else moves");
  assertEquals(person(model, "Mai Bui").days["2026-07-02"], "w", "the input model is not mutated");

  // The roster comes from the workbook: a name it doesn't know is reported,
  // not added.
  const unknown = applyDayCodes(model, {
    name: "Nobody Here",
    from: "2026-07-02",
    to: "2026-07-02",
    code: "p",
  });
  assertEquals([unknown.name, unknown.written], [null, 0]);
  assertEquals(unknown.model.people.length, 2, "no row invented");
  // Matching ignores case — the form's spelling need not match the sheet's.
  assertEquals(
    applyDayCodes(model, { name: "mai bui", from: "2026-07-02", to: "2026-07-02", code: "s" }).name,
    "Mai Bui",
  );

  // Days the grid has no column for are counted, not written: the quarter
  // starts on 01.07, so 29/30.06 have nowhere to go.
  const outside = applyDayCodes(model, {
    name: "Mai Bui",
    from: "2026-06-29",
    to: "2026-07-02",
    code: "p",
  });
  assertEquals([outside.written, outside.outside], [2, 2]);

  // Input that crossed a storage boundary: never step a range with it blindly.
  const bad = applyDayCodes(model, { name: "Mai Bui", from: "nope", to: "2026-07-02", code: "p" });
  assertEquals([bad.name, bad.written], [null, 0]);
});

Deno.test("applyDayCodes/revertDayCodes: marked days book against the balance, undo gives it back", () => {
  const held = {
    working: 235,
    carry: 0,
    allowance: 12,
    planned: 0,
    dayOffs: 6,
    annual: 6,
    core: 5,
    sick: 3,
  };
  const rows = grid({
    people: [
      ["Mai Bui", "a", ["w", "w", "w", "e", "e", "w", "w"]],
      ["Duc Le", "b", ["w", "w", "w", "e", "e", "w", "w"]],
    ],
    nDays: 92,
  });
  const model = parseVacationWorkbook([
    { name: "General", rows: general({ people: [["Mai Bui", held]] }) },
    { name: "3rd quarter", rows },
  ], { year: 2026 });

  // Four working days across a weekend, booked as annual leave.
  const update = { name: "Mai Bui", from: "2026-07-02", to: "2026-07-07", code: "p" };
  const marked = applyDayCodes(model, update);
  assertEquals(marked.written, 4);
  assertEquals(person(marked.model, "Mai Bui").balance, {
    ...held,
    working: 231,
    dayOffs: 10,
    annual: 2,
  }, "the two weekend days are not booked — they were never worked");
  assertEquals(person(model, "Mai Bui").balance, held, "the input model is not mutated");
  assertEquals(person(marked.model, "Duc Le").balance, undefined, "nobody else's moves");

  // Undo puts back exactly what was taken.
  const undone = revertDayCodes(marked.model, { ...update, code: "p", before: marked.before });
  assertEquals(undone.restored, 4);
  assertEquals(person(undone.model, "Mai Bui").balance, held, "the balance comes back whole");

  // A day something later moved on is kept, and so is the booking that later
  // change gave it. Re-coding 06.07 from annual to sick already handed its
  // annual day back and took a sick one, so undoing the other three leaves the
  // annual side exactly whole and the day still paid for — out of `sick`.
  const sick = applyDayCodes(marked.model, {
    name: "Mai Bui",
    from: "2026-07-06",
    to: "2026-07-06",
    code: "s",
  });
  assertEquals(person(sick.model, "Mai Bui").balance, {
    ...held,
    working: 231,
    dayOffs: 9,
    annual: 3,
    sick: 2,
  }, "the day moves from the annual side to the sick one, not onto both");
  const partial = revertDayCodes(sick.model, { ...update, code: "p", before: marked.before });
  assertEquals([partial.restored, partial.kept], [3, 1]);
  assertEquals(person(partial.model, "Mai Bui").balance, {
    ...held,
    working: 234,
    sick: 2,
  }, "three days back; the fourth is still taken, but as sick leave");
  // Whatever the route, the sheet's own arithmetic still describes the row.
  const end = person(partial.model, "Mai Bui").balance as Record<string, number>;
  assertEquals(end.annual, end.carry + end.allowance - end.planned - end.dayOffs);
});

Deno.test("pushHistory / historyText: newest first, capped, and readable", () => {
  const entry = (name: string, at: number) => ({
    name,
    from: "2026-07-22",
    to: "2026-07-24",
    code: "s",
    days: 3,
    at,
  });

  const one = pushHistory([], entry("Mai Bui", 1));
  const two = pushHistory(one, entry("Duc Le", 2));
  assertEquals(two.map((e) => e.name), ["Duc Le", "Mai Bui"], "newest first");
  assertEquals(one.length, 1, "the input list is not mutated");

  // The cap keeps the panel readable and the stored state small.
  let many: ReturnType<typeof pushHistory> = [];
  for (let i = 0; i < 25; i++) many = pushHistory(many, entry(`P${i}`, i), 20);
  assertEquals(many.length, 20);
  assertEquals(many[0].name, "P24", "the newest survives");
  assertEquals(many[19].name, "P5", "the oldest fall off the end");
  // A corrupted list reads as empty rather than throwing on the next save.
  assertEquals(pushHistory(null as never, entry("Mai Bui", 1)).length, 1);

  // The line names the code, not the letter.
  assertEquals(
    historyText({ name: "Mai Bui", from: "2026-07-22", to: "2026-07-24", code: "s", days: 3 }),
    "Mai Bui · 22.07–24.07 · Sick leave (3 days)",
  );
  assertEquals(
    historyText({ name: "Mai Bui", from: "2026-07-22", to: "2026-07-22", code: "p", days: 1 }),
    "Mai Bui · 22.07 · Annual leave (1 day)",
    "a single day names one date and one day",
  );
});

Deno.test("recordOnGrid: a fresh import leaves the record with nothing to show", () => {
  // 01.07.2026 is a Wednesday; 04/05.07 are the weekend.
  const q3 = (codes: Cell[]) =>
    parseVacationWorkbook(
      [{ name: "3rd quarter", rows: grid({ people: [["Mai Bui", "a", codes]], nDays: 92 }) }],
      { year: 2026 },
    );
  const model = q3(["w", "w", "w", "e", "e", "w"]);
  const applied = applyDayCodes(model, {
    name: "Mai Bui",
    from: "2026-07-02",
    to: "2026-07-06",
    code: "s",
  });
  const entry = {
    name: "Mai Bui",
    from: "2026-07-02",
    to: "2026-07-06",
    code: "s",
    days: applied.written,
    at: 1,
    before: applied.before,
  };
  // The weekend was never written, so it is not held against the record.
  assertEquals(recordOnGrid(applied.model, entry), { days: 3, kept: 3 });

  // HR sends a new workbook that knows nothing of the request.
  assertEquals(recordOnGrid(model, entry), { days: 3, kept: 0 });

  // One day of it survives — a partial loss is not a whole one.
  const partial = applyDayCodes(applied.model, {
    name: "Mai Bui",
    from: "2026-07-02",
    to: "2026-07-02",
    code: "p",
  });
  assertEquals(recordOnGrid(partial.model, entry), { days: 3, kept: 2 });

  // An import that drops the person takes their days with them.
  assertEquals(recordOnGrid(q3([]), { ...entry, name: "Ghost" }), { days: 3, kept: 0 });

  // A record from a build that kept no `before` falls back to working days.
  const legacy = { ...entry, before: undefined };
  assertEquals(recordOnGrid(applied.model, legacy), { days: 3, kept: 3 });
  assertEquals(recordOnGrid(model, legacy), { days: 3, kept: 0 });
});

Deno.test("revertDayCodes: deleting a record puts the days back", () => {
  // 01.07.2026 is a Wednesday; 04/05.07 are the weekend.
  const rows = grid({
    people: [["Mai Bui", "a", ["w", "v", "", "e", "e", "w", "w"]]],
    nDays: 92,
  });
  const model = parseVacationWorkbook([{ name: "3rd quarter", rows }], { year: 2026 });
  assertEquals(person(model, "Mai Bui").days["2026-07-03"], undefined, "the blank cell is blank");

  const applied = applyDayCodes(model, {
    name: "Mai Bui",
    from: "2026-07-01",
    to: "2026-07-03",
    code: "s",
  });
  // What was overwritten is recorded, including the cell that held nothing.
  assertEquals(applied.before, { "2026-07-01": "w", "2026-07-02": "v", "2026-07-03": "" });

  const back = revertDayCodes(applied.model, {
    name: "Mai Bui",
    code: "s",
    before: applied.before,
  });
  assertEquals([back.name, back.restored, back.kept], ["Mai Bui", 3, 0]);
  assertEquals(person(back.model, "Mai Bui").days["2026-07-01"], "w");
  assertEquals(person(back.model, "Mai Bui").days["2026-07-02"], "v", "the old code, not just 'w'");
  assertEquals(
    person(back.model, "Mai Bui").days["2026-07-03"],
    undefined,
    "a cell that held nothing goes back to holding nothing, not an empty code",
  );
  assertEquals(person(applied.model, "Mai Bui").days["2026-07-01"], "s", "input not mutated");

  // A day that moved on since is left alone: the newer value is the true one.
  const later = applyDayCodes(applied.model, {
    name: "Mai Bui",
    from: "2026-07-02",
    to: "2026-07-02",
    code: "p",
  });
  const partial = revertDayCodes(later.model, {
    name: "Mai Bui",
    code: "s",
    before: applied.before,
  });
  assertEquals([partial.restored, partial.kept], [2, 1]);
  assertEquals(person(partial.model, "Mai Bui").days["2026-07-02"], "p", "the newer code stands");

  // Nothing to undo: an unknown person, or a record from before `before` existed.
  assertEquals(revertDayCodes(model, { name: "Nobody", code: "s", before: {} }).name, null);
  assertEquals(revertDayCodes(model, { name: "Mai Bui", code: "s" }).restored, 0, "no before map");
});

/* ---------------------------------------------------------------------------
 * Data consistency
 *
 * The tests above each pin one function's output. These pin the *relationships*
 * between them over one realistic half-year model: the aggregations must agree
 * with the per-day readings they summarise, the round-trips must lose nothing,
 * and the mutations must be exactly undoable. A function can be individually
 * correct and still disagree with its neighbours, which is the class of bug the
 * grid and the balances panel show to a reader as two different truths.
 * ------------------------------------------------------------------------- */

/** Sum with the tolerance half-days need (0.5 is exact, but sums of ~200 aren't). */
function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/** One quarter of day codes on the real calendar: weekends carry `e`, weekdays
 *  cycle the legend, and every eighth weekday is left blank or dirtied so the
 *  no-data and unknown-code paths are part of the fixture rather than a footnote. */
function quarterCodes(year: number, quarter: number, seed: number): Cell[] {
  const spread = ["w", "w", "p", "r", "v", "m", "c", "s", "ch", "sa", "si", "h", "cm", "ra"];
  return quarterDates(year, quarter).map((iso, i) => {
    if (isWeekend(iso)) return "e";
    const n = i + seed;
    if (n % 8 === 0) return ""; // never filled in — no data, not "out"
    if (n % 23 === 0) return "zz"; // a dirty cell: counted as working, and warned about
    return spread[n % spread.length];
  });
}

/** Two quarters, six people across three teams, balances for all but one — the
 *  shape every relationship below is checked against. */
function wideModel(): Model {
  const roster: Array<[string, string]> = [
    ["Anh Pham", "mortal"],
    ["Long Vo", "mortal"],
    ["Giang Pham", "Pragma"],
    ["Tam Tran", "pragma"], // same team, drifted label
    ["Vinh Nguyen", "EL"],
    ["Nhan Tran", "EL"], // deliberately absent from the balance block
  ];
  const sheet = (quarter: number, name: string) => ({
    name,
    rows: grid({
      people: roster.map(([who, team], i) =>
        [who, team, quarterCodes(2026, quarter, i * 5 + quarter)] as [string, string, Cell[]]
      ),
      nDays: daysInQuarter(2026, quarter),
    }),
  });
  return parseVacationWorkbook([
    sheet(1, "1st quarter"),
    sheet(2, "2nd quarter"),
    {
      name: "General",
      rows: general({
        // The sheet's own arithmetic holds for each: carry + allowance - planned
        // - dayOffs = annual. Nhan Tran is not listed at all.
        people: roster.slice(0, 5).map((
          [who],
          i,
        ) =>
          [who, {
            working: 200 + i,
            carry: i % 3,
            allowance: 12,
            planned: 2,
            dayOffs: 4 + (i % 2),
            annual: (i % 3) + 12 - 2 - (4 + (i % 2)),
            core: 3,
            sick: 5,
          }] as [string, Partial<Record<BalanceField, Cell>>]
        ),
      }),
    },
  ], { year: 2026 });
}

const WIDE = wideModel();
const AXIS_FROM = WIDE.days[0];
const AXIS_TO = WIDE.days[WIDE.days.length - 1];

Deno.test("consistency: the fixture is the wide, dirty model these tests assume", () => {
  assertEquals(WIDE.people.length, 6);
  assertEquals([WIDE.days.length, AXIS_FROM, AXIS_TO], [181, "2026-01-01", "2026-06-30"]);
  assertEquals(WIDE.warnings.length > 0, true, "the dirty cells must warn");
  assertEquals(person(WIDE, "Nhan Tran").balance, undefined, "one person carries no balance");
  assertEquals(person(WIDE, "Anh Pham").balance?.annual, 6);
  const blanks = WIDE.days.filter((d) => person(WIDE, "Anh Pham").days[d] === undefined);
  assertEquals(blanks.length > 0, true, "the model must hold never-filled-in days");
});

Deno.test("consistency: every kind has exactly one full-day code", () => {
  // `personSummary` names a kind through the one code whose `half` is null
  // (KIND_LABELS), and `codeShare` reads a half as 0.5 of a day. A kind with two
  // full-day codes would make the first silently ambiguous, one with none would
  // leave a chip labelled by its bare kind.
  const fullDay = new Map<string, string[]>();
  const halves = new Set<string>();
  for (const [code, info] of Object.entries(CODES)) {
    if (info.half === null) fullDay.set(info.kind, [...(fullDay.get(info.kind) ?? []), code]);
    else halves.add(info.kind);
    assertEquals(info.weight >= 0 && info.weight <= 1, true, `${code}: weight out of range`);
    assertEquals(codeInfo(code), info, `${code}: codeInfo disagrees with the table`);
  }
  for (const [kind, codes] of fullDay) {
    assertEquals(codes.length, 1, `kind "${kind}" has ${codes.length} full-day codes: ${codes}`);
  }
  for (const kind of halves) {
    assertEquals(fullDay.has(kind), true, `kind "${kind}" has halves but no full-day code`);
  }
});

Deno.test("consistency: outOn, remoteOn and outInRange read each day alike", () => {
  for (const date of WIDE.days) {
    const out = outOn(WIDE, date);
    const away = remoteOn(WIDE, date);
    // Being absent and being merely elsewhere are different answers to the same
    // question — the strip renders them as separate groups, so they must not
    // both claim the same person.
    const both = out.filter((o) => away.some((a) => a.name === o.name)).map((o) => o.name);
    assertEquals(both, [], `${date}: counted as out and as remote at once`);
    // The range form must agree with the single-day form on a single day.
    assertEquals(
      outInRange(WIDE, date, date).map((p) => [p.name, p.dates[0].code]),
      out.map((o) => [o.name, o.code]),
      `${date}: outInRange(d, d) != outOn(d)`,
    );
    for (const o of out) {
      assertEquals(isWeekend(date), false, `${date}: ${o.name} reported out on a weekend`);
    }
  }
});

Deno.test("consistency: dayCounts is exactly the per-day split of outOn", () => {
  const counts = dayCounts(WIDE, AXIS_FROM, AXIS_TO);
  const expect = WIDE.days.filter((d) => !isWeekend(d)).map((date) => {
    const { holiday, other } = splitHoliday(outOn(WIDE, date));
    return { date, count: other.length, holiday: holiday.length };
  });
  assertEquals(counts, expect);
  // splitHoliday must lose nobody: the two cohorts partition the input.
  for (const date of WIDE.days) {
    const all = outOn(WIDE, date);
    const { holiday, other } = splitHoliday(all);
    assertEquals(
      holiday.length + other.length,
      all.length,
      `${date}: splitHoliday dropped someone`,
    );
  }
});

Deno.test("consistency: teamCapacity reconciles with the roster and with personSummary", () => {
  const teams = teamCapacity(WIDE, AXIS_FROM, AXIS_TO);
  assertEquals(teams.map((t) => t.team), ["EL", "mortal", "pragma"], "case-insensitive grouping");
  assertEquals(teams.reduce((n, t) => n + t.members, 0), WIDE.people.length);

  for (const team of teams) {
    const members = WIDE.people.filter((p) => p.team.toLowerCase() === team.team.toLowerCase());
    assertEquals(team.members, members.length, `${team.team}: member count`);
    let out = 0;
    let worked = 0;
    let possible = 0;
    for (const m of members) {
      const s = personSummary(WIDE, m.name)!;
      out += s.out;
      worked += s.worked;
      possible += s.possible;
    }
    assertEquals(close(worked, team.available), true, `${team.team}: worked != available`);
    assertEquals(close(out, team.out), true, `${team.team}: personSummary out != teamCapacity out`);
    // The documented identity: nothing imported falls outside these two.
    assertEquals(
      close(team.available + team.out, possible),
      true,
      `${team.team}: available + out != known non-weekend days`,
    );
  }
});

Deno.test("consistency: personSummary's two counting bases each add up", () => {
  for (const p of WIDE.people) {
    const s = personSummary(WIDE, p.name)!;
    const where = `${p.name}:`;
    // Weight basis.
    assertEquals(close(s.out + s.worked, s.possible), true, `${where} out + worked != possible`);
    assertEquals(
      close(s.months.reduce((n, m) => n + m.out, 0), s.out),
      true,
      `${where} the month run loses absence`,
    );
    assertEquals(
      close(s.months.reduce((n, m) => n + m.possible, 0), s.possible),
      true,
      `${where} the month run loses days`,
    );
    // codeShare basis — the chips, the month bars and the ranges are one count
    // seen three ways, so a month can never read empty for a chipped fortnight.
    const chips = s.kinds.reduce((n, k) => n + k.days, 0);
    assertEquals(
      close(s.months.reduce((n, m) => n + m.days, 0), chips),
      true,
      `${where} sum(months.days) != sum(kinds.days)`,
    );
    assertEquals(
      close(s.ranges.reduce((n, r) => n + r.days, 0), chips),
      true,
      `${where} sum(ranges.days) != sum(kinds.days)`,
    );
    // The absences among those ranges must name the same days outInRange does.
    const fromRanges = new Set<string>();
    for (const r of s.ranges) {
      if (r.weight >= 1) continue; // WFH/onsite are chipped but cost nothing
      for (let d = r.from; d <= r.to; d = nextDate(d)) if (!isWeekend(d)) fromRanges.add(d);
    }
    const listed = outInRange(WIDE, AXIS_FROM, AXIS_TO).find((x) => x.name === p.name);
    assertEquals(
      [...fromRanges].sort(),
      (listed?.dates ?? []).map((d) => d.date).sort(),
      `${where} the ranges and outInRange disagree about which days are absences`,
    );
  }
  assertEquals(personSummary(WIDE, "Nobody At All"), null);
});

Deno.test("consistency: groupOutDates conserves the days it groups", () => {
  for (const p of outInRange(WIDE, AXIS_FROM, AXIS_TO)) {
    const groups = groupOutDates(p.dates);
    const expect = p.dates.reduce((n, e) => n + (codeInfo(e.code).half === null ? 1 : 0.5), 0);
    assertEquals(
      close(groups.reduce((n, g) => n + g.days, 0), expect),
      true,
      `${p.name}: grouping changed the day count`,
    );
    let prev = "";
    for (const g of groups) {
      assertEquals(g.from <= g.to, true, `${p.name}: inverted range`);
      assertEquals(prev === "" || prev < g.from, true, `${p.name}: overlapping ranges`);
      prev = g.to;
    }
    // Every grouped range must describe one code, and the text forms must show
    // exactly as many ranges as there are.
    assertEquals(
      outDatesText(p.dates).split(", ").length,
      groups.length,
      `${p.name}: outDatesText range count`,
    );
    assertEquals(
      outDatesLabelText(p.dates).split(", ").length,
      groups.length,
      `${p.name}: outDatesLabelText range count`,
    );
  }
});

Deno.test("consistency: shiftBalance keeps the sheet's arithmetic and is reversible", () => {
  const start = {
    working: 235,
    carry: -3,
    allowance: 12,
    planned: 3,
    dayOffs: 6.5,
    annual: -0.5,
    core: 0,
    sick: 1,
  };
  // The identity the General sheet computes with, and that the panel shows.
  const identity = (b: Record<string, number | null>) =>
    b.carry! + b.allowance! - b.planned! - b.dayOffs! - b.annual!;
  assertEquals(identity(start), 0, "the fixture itself must satisfy it");

  const changes: Array<[string, string]> = [
    ["w", "p"],
    ["", "v"],
    ["r", "c"],
    ["w", "sm"],
    ["v", "m"],
    ["s", "w"],
    ["zz", "p"], // a dirty cell weighs a working day everywhere else, here too
  ];
  const moved = shiftBalance(start, changes)!;
  assertEquals(close(identity(moved), 0), true, "annual = carry + allowance - planned - dayOffs");
  assertEquals(
    shiftBalance(moved, changes.map(([a, b]) => [b, a] as [string, string])),
    start,
    "replaying the changes swapped must land back on the original",
  );
  // A field the workbook never recorded is not invented by marking days.
  const sparse = { ...NO_BALANCE, dayOffs: 2 };
  const after = shiftBalance(sparse, [["w", "p"]])!;
  assertEquals(after.dayOffs, 3);
  assertEquals(after.annual, null, "a null field stays null");
  assertEquals(shiftBalance(undefined, changes), undefined, "no balance stays no balance");
});

Deno.test("consistency: balanceTotals is additive over any split of the roster", () => {
  const all = balanceTotals(WIDE.people);
  for (const cut of [0, 1, 3, 5, 6]) {
    const a = balanceTotals(WIDE.people.slice(0, cut));
    const b = balanceTotals(WIDE.people.slice(cut));
    for (const key of ["people", ...BALANCE_FIELDS]) {
      assertEquals(close(all[key], a[key] + b[key]), true, `split at ${cut}: ${key} not additive`);
    }
  }
  assertEquals(all.people, 5, "the person with no balance is not counted");
  // Hand-summed against the fixture's own arithmetic.
  assertEquals(all.allowance, 60);
  assertEquals(all.core, 15);
  assertEquals(balanceTotals([]), { people: 0, ...NO_BALANCE_TOTALS });
});

Deno.test("consistency: applyDayCodes accounts for every day of its range", () => {
  const ranges = [
    ["2026-03-09", "2026-03-20"], // two clean working weeks
    ["2026-06-25", "2026-07-10"], // runs off the end of the imported axis
    ["2026-03-14", "2026-03-15"], // nothing but a weekend
    ["2026-01-01", "2026-01-01"], // a single day
  ];
  for (const [from, to] of ranges) {
    const r = applyDayCodes(WIDE, { name: "Anh Pham", from, to, code: "p" });
    let total = 0;
    for (let d = from; d <= to; d = nextDate(d)) total++;
    assertEquals(
      r.written + r.weekend + r.outside,
      total,
      `${from}..${to}: days written, skipped and dropped must sum to the range`,
    );
    assertEquals(
      Object.keys(r.before).length,
      r.written,
      `${from}..${to}: every written day must be recorded for undo`,
    );
    for (const date of Object.keys(r.before)) {
      assertEquals(isWeekend(date), false, `${from}..${to}: ${date} is a weekend and was written`);
      assertEquals(WIDE.days.includes(date), true, `${from}..${to}: ${date} is off-axis`);
    }
    // What leavableDays previews is what applyDayCodes does — including for the
    // days the workbook never filled in.
    const picked = [];
    for (let d = from; d <= to; d = nextDate(d)) {
      picked.push({
        date: d,
        code: person(WIDE, "Anh Pham").days[d] ?? "",
        outside: !WIDE.days.includes(d),
      });
    }
    assertEquals(
      leavableDays(picked).markable,
      r.written,
      `${from}..${to}: the preview and the write disagree`,
    );
  }
});

Deno.test("consistency: a blank weekend cell is still a weekend", () => {
  // A row the workbook has only partly filled in — a joiner's first weeks, a
  // leaver's last — has no code at all on its weekends. Read from the day code
  // alone, those Saturdays look markable, and a request spanning one used to be
  // written onto it and booked against the balance: a leave day spent on a day
  // nobody works. The calendar has the final say, exactly as `isWeekend` does.
  // Thu 01.01 worked, then nothing filled in at all: Fri 02.01, Sat 03.01,
  // Sun 04.01 and Mon 05.01 all hold no code.
  const codes: Cell[] = ["w", "", "", ""];
  const blank = grid({ people: [["Mai Bui", "a", codes]], nDays: 90 });
  const model = parseVacationWorkbook([{ name: "1st quarter", rows: blank }], { year: 2026 });
  assertEquals(person(model, "Mai Bui").days["2026-01-03"], undefined, "Saturday holds no code");
  assertEquals(isWeekend("2026-01-03"), true);

  const r = applyDayCodes(model, {
    name: "Mai Bui",
    from: "2026-01-01",
    to: "2026-01-05",
    code: "p",
  });
  assertEquals([r.written, r.weekend, r.outside], [3, 2, 0], "both weekend days are skipped");
  assertEquals(Object.keys(r.before), ["2026-01-01", "2026-01-02", "2026-01-05"]);
  assertEquals(person(r.model, "Mai Bui").days["2026-01-03"], undefined, "Saturday stays blank");
  assertEquals(person(r.model, "Mai Bui").days["2026-01-04"], undefined, "Sunday stays blank");
  assertEquals(outOn(r.model, "2026-01-03"), [], "nobody is out on the Saturday");
});

Deno.test("consistency: apply then revert restores the model exactly", () => {
  for (const code of ["p", "c", "s", "v", "m", "sa", "r", "h"]) {
    const applied = applyDayCodes(WIDE, {
      name: "long vo", // matched case-insensitively, restored under the roster spelling
      from: "2026-03-09",
      to: "2026-03-20",
      code,
    });
    assertEquals(applied.name, "Long Vo");
    assertEquals(applied.written > 0, true, `${code}: nothing written`);
    const back = revertDayCodes(applied.model, {
      name: "Long Vo",
      code,
      before: applied.before,
    });
    assertEquals(back.restored, applied.written, `${code}: restored != written`);
    assertEquals(back.kept, 0, `${code}: nothing should have moved on`);
    // Days *and* balance: the panel and the grid must land back together.
    assertEquals(back.model, WIDE, `${code}: apply + revert did not restore the model`);
    // While it stands, the record must read as fully present on the grid.
    const record = recordOnGrid(applied.model, {
      name: "Long Vo",
      from: "2026-03-09",
      to: "2026-03-20",
      code,
      days: applied.written,
      at: 0,
      before: applied.before,
    });
    assertEquals(
      [record.days, record.kept],
      [applied.written, applied.written],
      `${code}: recordOnGrid disagrees with what was just written`,
    );
    // …and, once undone, as standing only where the restored code happens to be
    // that same code anyway — the record is gone, the coincidence is not a write.
    const coincidental = Object.entries(applied.before)
      .filter(([, previous]) => previous === code).length;
    assertEquals(
      recordOnGrid(back.model, {
        name: "Long Vo",
        from: "2026-03-09",
        to: "2026-03-20",
        code,
        days: applied.written,
        at: 0,
        before: applied.before,
      }).kept,
      coincidental,
      `${code}: the undone record reads as standing on days it did not write`,
    );
  }
});

Deno.test("consistency: marking days moves the balance by exactly what it wrote", () => {
  const before = balanceTotals(WIDE.people);
  const applied = applyDayCodes(WIDE, {
    name: "Anh Pham",
    from: "2026-03-09",
    to: "2026-03-13",
    code: "p", // annual leave: adds to dayOffs, takes the same off annual
  });
  const after = balanceTotals(applied.model.people);
  assertEquals(after.people, before.people, "marking days changed who has a balance");
  assertEquals(
    close(after.dayOffs - before.dayOffs, -(after.annual - before.annual)),
    true,
    "a day booked off must come out of the allowance it was booked against",
  );
  const moved = person(applied.model, "Anh Pham").balance!;
  assertEquals(
    close(moved.carry! + moved.allowance! - moved.planned! - moved.dayOffs! - moved.annual!, 0),
    true,
    "the sheet's arithmetic must survive the write",
  );
  // Someone the balance block never listed is not given one by marking days.
  const nobalance = applyDayCodes(WIDE, {
    name: "Nhan Tran",
    from: "2026-03-09",
    to: "2026-03-13",
    code: "p",
  });
  assertEquals(nobalance.written > 0, true);
  assertEquals(person(nobalance.model, "Nhan Tran").balance, undefined, "a balance was invented");
});

Deno.test("consistency: packModel/unpackModel round-trips the whole model", () => {
  // Through JSON, the way localStorage and the .json export actually carry it.
  assertEquals(unpackModel(JSON.parse(JSON.stringify(packModel(WIDE)))), WIDE);

  // The separators the packed form is built from must survive inside a value.
  const dirty = {
    people: [{
      name: "Dirty Cell",
      team: "mortal",
      location: "VN" as const,
      days: { "2026-01-01": "a,b", "2026-01-02": "100%", "2026-01-03": "x y", "2026-01-06": "e" },
      balance: { ...NO_BALANCE, annual: 1.5 },
    }],
    days: ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"],
    warnings: [{ sheet: "1st quarter", ref: "AB12", value: "a,b", message: "unknown code" }],
  };
  const round = unpackModel(JSON.parse(JSON.stringify(packModel(dirty))))!;
  assertEquals(round, dirty);
  assertEquals("2026-01-04" in round.people[0].days, false, "a blank day must not materialise");
});

Deno.test("consistency: the share link round-trips the whole model", async () => {
  const encoded = await encodeShare(packModel(WIDE));
  assertEquals(/^[A-Za-z0-9_-]+$/.test(encoded), true, "must be safe in a URL fragment");
  assertEquals(unpackModel(await decodeShare(encoded)), WIDE);
  // The compression is the point: the packed form is extremely repetitive.
  assertEquals(encoded.length < JSON.stringify(packModel(WIDE)).length / 4, true);
});

Deno.test("consistency: mergeModels is idempotent on people, days and balances", () => {
  const empty = { people: [], days: [], warnings: [] };
  assertEquals(mergeModels(WIDE, empty), WIDE, "merging nothing must change nothing");

  const twice = mergeModels(WIDE, WIDE);
  assertEquals(twice.people, WIDE.people, "re-importing the same data must not duplicate people");
  assertEquals(twice.days, WIDE.days, "…nor stutter the day axis");
  // Warnings are an import log, not model state: they accumulate on purpose.
  assertEquals(twice.warnings.length, WIDE.warnings.length * 2);

  // The axis stays sorted and unique however the halves arrive.
  const second = mergeModels(
    { people: [], days: ["2026-07-02", "2026-01-05"], warnings: [] },
    { people: [], days: ["2026-01-05", "2026-04-01"], warnings: [] },
  );
  assertEquals(second.days, ["2026-01-05", "2026-04-01", "2026-07-02"]);
});

Deno.test("consistency: applyLocationHolidays is pure and idempotent", () => {
  const tags = { "Giang Pham": "CH" as const, "Tam Tran": "CH" as const };
  const snapshot = JSON.stringify(WIDE);
  const once = applyLocationHolidays(WIDE, tags, HOLIDAYS_CH_ZURICH);
  assertEquals(JSON.stringify(WIDE), snapshot, "the input model was mutated");
  assertEquals(applyLocationHolidays(once, tags, HOLIDAYS_CH_ZURICH), once, "not idempotent");

  // The overlay reinterprets working days; it must not touch the leave accounting.
  for (const p of once.people) {
    assertEquals(p.balance, person(WIDE, p.name).balance, `${p.name}: the overlay moved a balance`);
  }
  // Nor may it change how many days the axis holds for anyone.
  for (const p of once.people) {
    assertEquals(
      Object.keys(p.days).length,
      Object.keys(person(WIDE, p.name).days).length,
      `${p.name}: the overlay added or dropped a day`,
    );
  }
});

Deno.test("consistency: weekSlices and monthSpans partition the view", () => {
  for (const [mode, anchor] of [["month", "2026-02-14"], ["quarter", "2026-05-02"]] as const) {
    const dates = viewDates(mode, anchor);
    const where = `${mode} ${anchor}:`;
    const weeks = weekSlices(dates);
    assertEquals(weeks.reduce((n, w) => n + w.days, 0), dates.length, `${where} weeks lose days`);
    assertEquals(weeks[0].from, dates[0], `${where} the view's first day is off screen`);
    assertEquals(
      weeks[weeks.length - 1].to,
      dates[dates.length - 1],
      `${where} last day off screen`,
    );
    weeks.forEach((w, i) => {
      assertEquals(w.days > 0, true, `${where} an empty week slice`);
      assertEquals(mondayOf(w.from), w.monday, `${where} slice ${i} is not its own week`);
      if (i > 0) assertEquals(nextDate(weeks[i - 1].to), w.from, `${where} a gap between weeks`);
    });
    const spans = monthSpans(dates);
    assertEquals(spans.reduce((n, s) => n + s.days, 0), dates.length, `${where} months lose days`);
    assertEquals(spans.length, mode === "month" ? 1 : 3, `${where} span count`);
    // Every day of the view falls inside the model's clamp, so the two framings
    // never disagree about what is on screen.
    assertEquals(clampAnchor(anchor, WIDE.days), anchor, `${where} anchor should be in range`);
  }
  assertEquals(clampAnchor("2025-01-01", WIDE.days), AXIS_FROM, "an early anchor is pulled in");
  assertEquals(clampAnchor("2027-01-01", WIDE.days), AXIS_TO, "a late anchor is pulled in");
});

Deno.test("consistency: capacityGrid agrees with teamCapacity week by week", () => {
  const weeks = weekSlices(viewDates("quarter", "2026-05-02"));
  const rows = capacityGrid(WIDE, weeks);
  assertEquals(rows.map((r) => r.team), teamCapacity(WIDE, AXIS_FROM, AXIS_TO).map((t) => t.team));
  for (const row of rows) {
    assertEquals(row.cells.length, weeks.length, `${row.team}: one cell per week`);
    row.cells.forEach((cell, i) => {
      const week = weeks[i];
      const team = teamCapacity(WIDE, week.from, week.to)
        .find((t) => t.team.toLowerCase() === row.team.toLowerCase());
      if (cell === null) return; // nothing imported for that week — not a zero
      assertEquals(
        close(cell.available, team!.available),
        true,
        `${row.team} week ${week.from}: grid ${cell.available} vs teamCapacity ${team!.available}`,
      );
      assertEquals(
        cell.available <= cell.possible,
        true,
        `${row.team} ${week.from}: over capacity`,
      );
    });
  }
  // A week nobody has data for must read as missing, never as zero capacity.
  const unimported = weekSlices(viewDates("month", "2027-03-15"));
  for (const row of capacityGrid(WIDE, unimported)) {
    assertEquals(row.cells.every((c) => c === null), true, `${row.team}: absent data read as zero`);
  }
  assertEquals(lowCoverage(capacityGrid(WIDE, unimported), unimported, 0.8), []);
});

Deno.test("consistency: the day axis covers each quarter and each year exactly", () => {
  for (const year of [2026, 2028]) {
    let total = 0;
    for (let q = 1; q <= 4; q++) {
      const dates = quarterDates(year, q);
      assertEquals(dates.length, daysInQuarter(year, q), `${year} Q${q}: length != daysInQuarter`);
      dates.forEach((d, i) => {
        if (i > 0) assertEquals(nextDate(dates[i - 1]), d, `${year} Q${q}: a gap at ${d}`);
      });
      total += dates.length;
    }
    assertEquals(total, year === 2028 ? 366 : 365, `${year}: quarters do not tile the year`);
  }
  // addDays and nextDate must be the same walk.
  let d = "2026-02-25";
  for (let i = 0; i < 10; i++) {
    assertEquals(addDays("2026-02-25", i), d, `addDays disagrees with nextDate at +${i}`);
    d = nextDate(d);
  }
});

Deno.test("consistency: the history keeps what it says it keeps", () => {
  let history: Array<Parameters<typeof historyText>[0] & { at: number }> = [];
  function entryFor(n: number) {
    return {
      name: "Long Vo",
      from: "2026-03-09",
      to: "2026-03-09",
      code: "p",
      days: 1,
      at: n,
      before: { "2026-03-09": "w" },
    };
  }
  for (let n = 0; n < HISTORY_LIMIT + 5; n++) history = pushHistory(history, entryFor(n));
  assertEquals(history.length, HISTORY_LIMIT, "the cap must hold");
  assertEquals(history[0].at, HISTORY_LIMIT + 4, "newest first");
  assertEquals(history[history.length - 1].at, 5, "the oldest entries fall off the end");
  // The line a reader sees must describe the entry it came from.
  assertEquals(historyText(entryFor(0)), "Long Vo · 09.03 · Annual leave (1 day)");
  assertEquals(
    historyText({ ...entryFor(0), to: "2026-03-13", days: 5 }),
    "Long Vo · 09.03–13.03 · Annual leave (5 days)",
  );
});

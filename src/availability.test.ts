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
  prettyDay,
  pushHistory,
  quarterDates,
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
  assertEquals(typeOf("r"), "wfh", "remote is WFH");
  // Kinds with no leave equivalent leave the target on its own default.
  assertEquals(typeOf("w"), null, "a working day implies no leave type");
  assertEquals(typeOf("ch"), null, "onsite is not a leave type");
  assertEquals(typeOf("h"), null, "a public holiday is not requested");
  assertEquals(typeOf("e"), null, "nor is a weekend");
  assertEquals(typeOf("si"), null, "social leave has no Leave-tool equivalent");
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

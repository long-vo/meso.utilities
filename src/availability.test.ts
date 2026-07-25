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
  applyLocationHolidays,
  codeInfo,
  CODES,
  daysInQuarter,
  decodeShare,
  encodeShare,
  HOLIDAYS_CH_ZURICH,
  mergeModels,
  mondayOf,
  nextDate,
  outInRange,
  outOn,
  packModel,
  parseCsv,
  parseQuarterCsv,
  parseVacationWorkbook,
  quarterDates,
  remoteOn,
  teamCapacity,
  unpackModel,
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

Deno.test("decodeShare: garbage in, null out", async () => {
  assertEquals(await decodeShare("definitely not a share link"), null);
  assertEquals(await decodeShare(""), null);
  // Valid base64url, but the bytes are not gzip.
  assertEquals(await decodeShare(btoa("plain text").replace(/=+$/, "")), null);
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

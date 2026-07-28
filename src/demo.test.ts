/**
 * Parity tests for the Team Availability sample data
 * (static/availability/demo.mjs) — the module the empty state's "Try with
 * sample data" loads. Dependency-free like src/availability.test.ts.
 *
 * What matters here is not the particular scatter but the contract the UI
 * leans on: a whole-year axis of valid codes, determinism (a "sample" that
 * shifts under reload reads as a bug), and the showcases — a CH team for the
 * location overlay, one overdrawn balance for the balances table's warning.
 */
import { CODES, isWeekend } from "../static/availability/availability.mjs";
import { DEMO_CH_TEAM, DEMO_PEOPLE, demoModel } from "../static/availability/demo.mjs";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("demoModel: a whole-year axis of valid workbook codes", () => {
  const model = demoModel(2026);
  assert(model.days.length === 365, `expected 365 days, got ${model.days.length}`);
  assert(model.days[0] === "2026-01-01", "axis must start at Jan 1");
  assert(model.days[model.days.length - 1] === "2026-12-31", "axis must end at Dec 31");
  assert(model.people.length === DEMO_PEOPLE.length, "the whole roster must be built");
  for (const person of model.people) {
    for (const date of model.days) {
      const code = person.days[date];
      assert(code !== undefined && code in CODES, `${person.name} ${date}: bad code "${code}"`);
      if (isWeekend(date)) assert(code === "e", `${person.name} ${date}: weekends must be "e"`);
    }
    assert(
      Object.values(person.days).some((c) => c === "p"),
      `${person.name}: everyone gets at least the staggered vacation week`,
    );
  }
  // Leap years get their day too.
  assert(demoModel(2028).days.length === 366, "2028 must have 366 days");
});

Deno.test("demoModel: deterministic — the same year builds the same model", () => {
  assert(
    JSON.stringify(demoModel(2026)) === JSON.stringify(demoModel(2026)),
    "two builds of the same year must be identical",
  );
});

Deno.test("demoModel: carries the showcases the UI leans on", () => {
  const model = demoModel(2026);
  const teams = new Set(model.people.map((p) => p.team));
  assert(teams.size === 3, "three teams, so the capacity table has rows to compare");
  assert(teams.has(DEMO_CH_TEAM), "the CH team must exist for the location overlay");
  assert(
    model.people.every((p) => p.location === "VN"),
    "raw locations start VN, exactly as the parser's do — CH comes from tags",
  );
  assert(
    model.people.every((p) => typeof p.balance.annual === "number"),
    "every person carries a balance block",
  );
  assert(
    model.people.some((p) => p.balance.annual < 0),
    "one allowance is deliberately overdrawn for the balances table",
  );
  assert(model.warnings.length === 0, "sample data must not invent workbook warnings");
});

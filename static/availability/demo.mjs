// meso.utilities — Team Availability sample data. The empty state offers this
// made-up roster so the tool can be tried before any real workbook exists.
// Dual-consumption like every other module here: imported unchanged by app.js
// and by src/demo.test.ts. Deterministic on purpose (no Math.random, no
// Date.now) — the same year always builds the same model, which is what the
// parity tests pin down, and a "sample" that shifts under reload would read
// as a bug.
import { HOLIDAYS_VN, isWeekend } from "./availability.mjs";

/** The team `app.js` tags CH on load, so the sample also shows the location
 *  badge and the Zürich holiday overlay. */
export const DEMO_CH_TEAM = "Zürich";

/**
 * The sample roster: clearly fictional names (the CH team's surnames are the
 * German word for "sample"), three teams of different sizes so the capacity
 * table and team chips have something to compare.
 */
export const DEMO_PEOPLE = [
  ["An Mau", "Phoenix"],
  ["Binh Mau", "Phoenix"],
  ["Chi Mau", "Phoenix"],
  ["Dung Mau", "Phoenix"],
  ["Em Mau", "Phoenix"],
  ["Giang Thu", "Mekong"],
  ["Hoa Thu", "Mekong"],
  ["Khang Thu", "Mekong"],
  ["Linh Thu", "Mekong"],
  ["Jonas Muster", DEMO_CH_TEAM],
  ["Katja Beispiel", DEMO_CH_TEAM],
  ["Luca Probe", DEMO_CH_TEAM],
];

/**
 * Deterministic scatter for one person-day — not a random number, a fixed
 * function of the two indices, so every load of the same year agrees.
 *
 * @param {number} person @param {number} day
 * @returns {number} 0..199
 */
function scatter(person, day) {
  let x = (person + 1) * 2654435761 + (day + 1) * 40503;
  x = ((x >>> 13) ^ x) * 1274126177;
  return (((x >>> 16) ^ x) >>> 0) % 200;
}

/** The day code the scatter value stands for — mostly working, with the
 *  occasional absence spread across every kind the legend names. */
function scatterCode(value) {
  if (value < 2) return "p";
  if (value === 2) return "m";
  if (value === 3) return "a";
  if (value < 6) return "s";
  if (value < 8) return "v";
  if (value === 8) return "c";
  if (value === 9) return "si";
  if (value < 18) return "r";
  return "w";
}

/**
 * Build the sample model for `year`: every date of the year on the axis,
 * weekends and VN public holidays marked the way the real workbook marks them,
 * a light scatter of absences, one solid vacation week per person, and a
 * balance block (one allowance deliberately overdrawn, so the balances table's
 * warning has something to show).
 *
 * @param {number} year
 * @returns {{ people: Array<{ name: string, team: string, location: "VN",
 *   days: Record<string, string>,
 *   balance: { working: number, carry: number, allowance: number, planned: number,
 *     dayOffs: number, annual: number, core: number, sick: number } }>,
 *   days: string[], warnings: never[] }}
 */
export function demoModel(year) {
  /** @type {string[]} */
  const days = [];
  for (let t = Date.UTC(year, 0, 1); t <= Date.UTC(year, 11, 31); t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  // The built-in VN set covers one year; for any other, the sample simply has
  // no VN holidays — the CH overlay still demonstrates the location tags.
  const vnHolidays = new Set(
    HOLIDAYS_VN.map((h) => (typeof h === "string" ? h : h.date))
      .filter((d) => d.startsWith(`${year}-`)),
  );
  const workingDays = days.filter((d) => !isWeekend(d) && !vnHolidays.has(d)).length;
  const mondays = days.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1);

  const people = DEMO_PEOPLE.map(([name, team], index) => {
    /** @type {Record<string, string>} */
    const personDays = {};
    days.forEach((date, dayIndex) => {
      if (isWeekend(date)) {
        personDays[date] = "e";
        return;
      }
      if (vnHolidays.has(date)) {
        personDays[date] = "h";
        return;
      }
      personDays[date] = scatterCode(scatter(index, dayIndex));
    });
    // One contiguous vacation week each, staggered so the capacity table has
    // visibly thin weeks to flag.
    const monday = mondays[(index * 3 + 6) % mondays.length];
    const start = days.indexOf(monday);
    for (let offset = 0; offset < 5; offset++) {
      const date = days[start + offset];
      if (date !== undefined && personDays[date] !== "e" && personDays[date] !== "h") {
        personDays[date] = "p";
      }
    }
    // The balance block, tied to the generated days where the two can agree.
    let planned = 0;
    let taken = 0;
    let coreTaken = 0;
    let sickTaken = 0;
    for (const code of Object.values(personDays)) {
      if (code === "v") planned++;
      else if (code === "p") taken++;
      else if (code === "m" || code === "a") taken += 0.5;
      else if (code === "c") coreTaken++;
      else if (code === "s") sickTaken++;
    }
    const carry = (index % 4) * 1.5;
    // One deliberately small allowance, so somebody's Annual runs negative.
    const allowance = index === 3 ? 5 : 20;
    return {
      name,
      team,
      // "VN" for everyone, exactly as the parser starts people out — the CH
      // team gets its location through tags, the same path a real import uses.
      location: /** @type {"VN"} */ ("VN"),
      days: personDays,
      balance: {
        working: workingDays,
        carry,
        allowance,
        planned,
        dayOffs: taken,
        annual: carry + allowance - planned - taken,
        core: 5 - coreTaken,
        sick: 12 - sickTaken,
      },
    };
  });
  return { people, days, warnings: [] };
}

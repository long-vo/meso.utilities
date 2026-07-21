/**
 * Parity tests for the Leave Request builder. They pin the two exact artifacts
 * mandated by the "How to Submit a Leave Request" page: the HR leave-request
 * email (step 1) and the Outlook calendar event subject (step 2).
 *
 * The browser UI (static/leave/app.js) imports the same module under test, so
 * these assertions are the contract the on-screen output must match.
 * Run with `deno task test`.
 */
import {
  buildLeaveRequest,
  mailtoUrl,
  outlookComposeUrl,
  summarizePeriod,
  templateSummary,
} from "../static/leave/leave.mjs";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("full-day annual leave: HR email + Outlook event", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    reason: "Family trip",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.email.to, "hr.vn@mesoneer.io");
  assertEquals(result.email.cc, "");
  assertEquals(result.email.subject, "[Leave Request] John Doe - 2026-07-20");
  assertEquals(
    result.email.body,
    "Dear HR,\n\nDate off: 2026-07-20\nLeave type: Annual leave\nReason: Family trip\n\nBest regards,",
  );
  assertEquals(result.email.applicable, true);
  assertEquals(result.event.subject, "[OFF] - John Doe");
  assertEquals(result.event.recipients, "mesoneer_vn@mesoneer.io");
});

Deno.test("type mapping: bracket, leave-type label and email applicability", () => {
  const base = { name: "John Doe", duration: "full", startDate: "2026-07-20" } as const;
  const cases = [
    { type: "annual", bracket: "[OFF] - John Doe", label: "Annual leave", applicable: true },
    { type: "sick", bracket: "[Sick Leave] - John Doe", label: "Sick leave", applicable: true },
    { type: "core", bracket: "[Core Leave] - John Doe", label: "Core leave", applicable: true },
    { type: "remote", bracket: "[Remote] - John Doe", label: "Remote", applicable: false },
    { type: "wfh", bracket: "[WFH] - John Doe", label: "WFH", applicable: false },
  ] as const;
  for (const c of cases) {
    const result = buildLeaveRequest({ ...base, type: c.type });
    if (!result.ok) throw new Error(result.error);
    assertEquals(result.event.subject, c.bracket, `event subject for ${c.type}`);
    assertEquals(result.email.applicable, c.applicable, `applicability for ${c.type}`);
    assert(
      result.email.body.includes(`Leave type: ${c.label}`),
      `leave-type label for ${c.type}: ${result.email.body}`,
    );
  }
});

Deno.test("Annual and Core leave are full-day only — a half-day is coerced to full", () => {
  for (const type of ["annual", "core"] as const) {
    const result = buildLeaveRequest({
      name: "John Doe",
      type,
      duration: "morning",
      startDate: "2026-07-20",
    });
    if (!result.ok) throw new Error(result.error);
    assert(!result.event.subject.includes("Morning"), `${type} event: ${result.event.subject}`);
    assert(!result.email.subject.includes("(Morning)"), `${type} subject: ${result.email.subject}`);
    assert(!result.email.body.includes("(Morning)"), `${type} body: ${result.email.body}`);
  }
});

Deno.test("half-day morning prepends the TIME token to the event bracket", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "wfh",
    duration: "morning",
    startDate: "2026-07-20",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.event.subject, "[Morning - WFH] - John Doe");
  assertEquals(result.email.subject, "[Leave Request] John Doe - 2026-07-20 (Morning)");
});

Deno.test("half-day afternoon: TIME in event + period; blank reason renders bare label", () => {
  const result = buildLeaveRequest({
    name: "Jane Roe",
    type: "sick",
    duration: "afternoon",
    startDate: "2026-08-01",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.event.subject, "[Afternoon - Sick Leave] - Jane Roe");
  assertEquals(
    result.email.body,
    "Dear HR,\n\nDate off: 2026-08-01 (Afternoon)\nLeave type: Sick leave\nReason:\n\nBest regards,",
  );
});

Deno.test("HR email body opens with 'Dear HR,' and closes with 'Best regards,'", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
  });
  if (!result.ok) throw new Error(result.error);
  assert(result.email.body.startsWith("Dear HR,\n\n"), result.email.body);
  assert(result.email.body.endsWith("\n\nBest regards,"), result.email.body);
});

Deno.test("multi-day period: email shows a range, event subject is unchanged", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    endDate: "2026-07-24",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.email.subject, "[Leave Request] John Doe - 2026-07-20 to 2026-07-24");
  assert(
    result.email.body.includes("Date off: 2026-07-20 to 2026-07-24"),
    result.email.body,
  );
  assertEquals(result.event.subject, "[OFF] - John Doe");
});

Deno.test("end date equal to start is a single day; half-day ignores any end date", () => {
  const same = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    endDate: "2026-07-20",
  });
  if (!same.ok) throw new Error(same.error);
  assertEquals(same.email.subject, "[Leave Request] John Doe - 2026-07-20");

  const half = buildLeaveRequest({
    name: "John Doe",
    type: "sick", // half-day-allowed type (Annual/Core are full-day only)
    duration: "morning",
    startDate: "2026-07-20",
    endDate: "2026-07-24",
  });
  if (!half.ok) throw new Error(half.error);
  assertEquals(half.email.subject, "[Leave Request] John Doe - 2026-07-20 (Morning)");
});

Deno.test("team lead becomes Cc; extra recipients append to the event", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    teamLead: "lead@mesoneer.io",
    recipients: "po@mesoneer.io",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.email.cc, "lead@mesoneer.io");
  assertEquals(result.event.recipients, "mesoneer_vn@mesoneer.io; po@mesoneer.io");
});

Deno.test("mailto: encodes cc, subject and body (special chars are safe)", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    reason: "R&R at home",
    teamLead: "lead@mesoneer.io",
  });
  if (!result.ok) throw new Error(result.error);
  assert(result.email.mailto.startsWith("mailto:hr.vn@mesoneer.io?"), result.email.mailto);
  assert(result.email.mailto.includes("cc=lead%40mesoneer.io"), result.email.mailto);
  assert(
    result.email.mailto.includes(`subject=${encodeURIComponent(result.email.subject)}`),
    result.email.mailto,
  );
  assert(
    result.email.mailto.includes(`body=${encodeURIComponent(result.email.body)}`),
    result.email.mailto,
  );
  // The ampersand from the reason must be percent-encoded, never a raw separator.
  assert(!result.email.mailto.includes("R&R"), result.email.mailto);
});

Deno.test("no Cc param in the mailto when no team lead is given", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.email.cc, "");
  assert(!result.email.mailto.includes("cc="), result.email.mailto);
});

Deno.test("outlookWebUrl: office.com compose deep link with encoded fields", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    reason: "R&R at home",
    teamLead: "lead@mesoneer.io",
  });
  if (!result.ok) throw new Error(result.error);
  assert(
    result.email.outlookWebUrl.startsWith("https://outlook.office.com/mail/deeplink/compose?"),
    result.email.outlookWebUrl,
  );
  // Query-param recipients must be percent-encoded (unlike the mailto path).
  assert(result.email.outlookWebUrl.includes("to=hr.vn%40mesoneer.io"), result.email.outlookWebUrl);
  assert(result.email.outlookWebUrl.includes("cc=lead%40mesoneer.io"), result.email.outlookWebUrl);
  assert(
    result.email.outlookWebUrl.includes(`subject=${encodeURIComponent(result.email.subject)}`),
    result.email.outlookWebUrl,
  );
  assert(
    result.email.outlookWebUrl.includes(`body=${encodeURIComponent(result.email.body)}`),
    result.email.outlookWebUrl,
  );
  assert(!result.email.outlookWebUrl.includes("R&R"), result.email.outlookWebUrl);
});

Deno.test("outlookWebUrl: omits cc when no team lead is given", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
  });
  if (!result.ok) throw new Error(result.error);
  assert(!result.email.outlookWebUrl.includes("cc="), result.email.outlookWebUrl);
});

Deno.test("event.outlookWebUrl: all-day calendar deep link with dates and attendees", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    recipients: "po@mesoneer.io",
  });
  if (!result.ok) throw new Error(result.error);
  const url = result.event.outlookWebUrl;
  assert(url.startsWith("https://outlook.office.com/calendar/0/deeplink/compose?"), url);
  assert(url.includes(`subject=${encodeURIComponent(result.event.subject)}`), url);
  assert(url.includes("startdt=2026-07-20"), url);
  assert(url.includes("enddt=2026-07-20"), url); // single day → same date, boundary-safe
  assert(url.includes("allday=true"), url);
  // Attendees go in `to` (comma-separated), percent-encoded.
  assert(url.includes(`to=${encodeURIComponent("mesoneer_vn@mesoneer.io,po@mesoneer.io")}`), url);
});

Deno.test("half day ignores a stale end date (single-day period and event)", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "sick", // half-day-allowed type; Annual/Core would coerce to full day
    duration: "morning",
    startDate: "2026-07-20",
    endDate: "2026-07-24", // e.g. left over from a previous full-day selection
  });
  if (!result.ok) throw new Error(result.error);
  assert(result.email.subject.includes("2026-07-20 (Morning)"), result.email.subject);
  assert(!result.email.subject.includes("to 2026-07-24"), result.email.subject);
  // A half day is one day: the calendar event must not span a range.
  assert(result.event.outlookWebUrl.includes("startdt=2026-07-20"), result.event.outlookWebUrl);
  assert(result.event.outlookWebUrl.includes("enddt=2026-07-20"), result.event.outlookWebUrl);
});

Deno.test("event.outlookWebUrl: multi-day range spans start..end inclusive", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    endDate: "2026-07-24",
  });
  if (!result.ok) throw new Error(result.error);
  const url = result.event.outlookWebUrl;
  assert(url.includes("startdt=2026-07-20"), url);
  assert(url.includes("enddt=2026-07-24"), url);
  assert(url.includes(`to=${encodeURIComponent("mesoneer_vn@mesoneer.io")}`), url);
});

Deno.test("mailtoUrl / outlookComposeUrl build encoded links from an (edited) body", () => {
  const body = "Dear HR,\n\nEdited & tweaked\n\nBest regards,";
  const mailto = mailtoUrl(
    "hr.vn@mesoneer.io",
    "lead@mesoneer.io",
    "[Leave Request] John Doe",
    body,
  );
  assert(mailto.startsWith("mailto:hr.vn@mesoneer.io?"), mailto);
  assert(mailto.includes("cc=lead%40mesoneer.io"), mailto);
  assert(mailto.includes(`body=${encodeURIComponent(body)}`), mailto);
  assert(!mailtoUrl("hr.vn@mesoneer.io", "", "S", body).includes("cc="), "no cc when empty");

  const web = outlookComposeUrl("hr.vn@mesoneer.io", "", "[Leave Request] John Doe", body);
  assert(web.startsWith("https://outlook.office.com/mail/deeplink/compose?"), web);
  assert(web.includes("to=hr.vn%40mesoneer.io"), web);
  assert(web.includes(`body=${encodeURIComponent(body)}`), web);
  assert(!web.includes("cc="), web);
});

Deno.test("templateSummary: type label, duration, and optional reason", () => {
  assertEquals(templateSummary({ type: "annual", duration: "full" }), "Annual leave · full day");
  assertEquals(templateSummary({ type: "wfh", duration: "morning" }), "WFH · morning");
  assertEquals(templateSummary({ type: "sick", duration: "afternoon" }), "Sick leave · afternoon");
  // Full-day-only types always read "full day", even if a stray half-day slipped in.
  assertEquals(templateSummary({ type: "core", duration: "morning" }), "Core leave · full day");
  // A reason is appended when present, and ignored when blank.
  assertEquals(
    templateSummary({ type: "annual", duration: "full", reason: "Family trip" }),
    "Annual leave · full day · Family trip",
  );
  assertEquals(
    templateSummary({ type: "wfh", duration: "morning", reason: "  " }),
    "WFH · morning",
  );
});

Deno.test("validation: name, start date and date order are required", () => {
  const noName = buildLeaveRequest({
    name: "  ",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
  });
  assertEquals(noName.ok, false);
  if (noName.ok) throw new Error("expected invalid");
  assert(noName.error.toLowerCase().includes("name"), noName.error);

  const noDate = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "",
  });
  assertEquals(noDate.ok, false);
  if (noDate.ok) throw new Error("expected invalid");
  assert(noDate.error.toLowerCase().includes("date"), noDate.error);

  const backwards = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    endDate: "2026-07-10",
  });
  assertEquals(backwards.ok, false);
  if (backwards.ok) throw new Error("expected invalid");
  assert(backwards.error.toLowerCase().includes("end"), backwards.error);
});

Deno.test("summarizePeriod: single weekday, half day, and missing start", () => {
  // 2024-01-01 was a Monday.
  assertEquals(summarizePeriod("2024-01-01", "", "full"), {
    text: "1 day — Monday",
    warning: "",
  });
  assertEquals(summarizePeriod("2024-01-01", "", "morning"), {
    text: "Half day — Monday",
    warning: "",
  });
  // A half day ignores any (stale) end date.
  assertEquals(summarizePeriod("2024-01-01", "2024-01-05", "afternoon"), {
    text: "Half day — Monday",
    warning: "",
  });
  assertEquals(summarizePeriod("", "", "full"), null);
  assertEquals(summarizePeriod("not-a-date", "", "full"), null);
});

Deno.test("summarizePeriod: ranges count days and weekdays", () => {
  // Mon 2024-01-01 .. Fri 2024-01-05: a clean working week.
  assertEquals(summarizePeriod("2024-01-01", "2024-01-05", "full"), {
    text: "5 days — all weekdays",
    warning: "",
  });
  // Mon .. Sun spans one weekend; the end lands on it.
  assertEquals(summarizePeriod("2024-01-01", "2024-01-07", "full"), {
    text: "7 days — 5 weekdays, 2 weekend days",
    warning: "Ends on a Sunday.",
  });
  // An end date equal to (or before) the start reads as a single day.
  assertEquals(summarizePeriod("2024-01-01", "2024-01-01", "full"), {
    text: "1 day — Monday",
    warning: "",
  });
});

Deno.test("summarizePeriod: weekend endpoints warn", () => {
  // 2024-01-06 was a Saturday, 2024-01-07 a Sunday.
  assertEquals(summarizePeriod("2024-01-06", "", "full"), {
    text: "1 day — Saturday",
    warning: "Falls on a Saturday.",
  });
  assertEquals(summarizePeriod("2024-01-06", "2024-01-07", "full"), {
    text: "2 days — 2 weekend days",
    warning: "Starts on a Saturday. Ends on a Sunday.",
  });
});

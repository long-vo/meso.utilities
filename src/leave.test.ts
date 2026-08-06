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
  addRecipients,
  applyRecipientCompletion,
  availabilityUpdate,
  buildLeaveRequest,
  filterRecipientSuggestions,
  isValidEmailList,
  mailtoUrl,
  nextWorkingDay,
  outlookComposeUrl,
  parseEmails,
  parseLeaveHandoff,
  PROMPT_INSTRUCTIONS,
  promptText,
  recipientTokenAt,
  removeRecipient,
  summarizePeriod,
  templateSummary,
  upsertTemplate,
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
  // No note was given, so the event carries no description at all.
  assertEquals(result.event.body, "");
  assertEquals(result.event.recipients, "mesoneer_vn@mesoneer.io");
});

Deno.test("event.body: the note is the whole description, never the reason", () => {
  // The event is invited to the whole team list, so a reason typed for HR must not
  // ride along into the description.
  const result = buildLeaveRequest({
    name: "Jane Roe",
    type: "sick",
    duration: "afternoon",
    startDate: "2026-07-20",
    reason: "Dentist appointment",
    note: "Back on Wednesday",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.event.body, "Back on Wednesday");
  assert(!result.event.outlookWebUrl.includes("Dentist"), result.event.outlookWebUrl);
  // The email body is where the reason belongs.
  assert(result.email.body.includes("Reason: Dentist appointment"), result.email.body);
});

Deno.test("event.body: the note reaches the deep link, and stays out of the HR mail", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    reason: "Family trip",
    note: "Handover: Anna covers standups",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.event.body, "Handover: Anna covers standups");
  assert(
    result.event.outlookWebUrl.includes(`body=${encodeURIComponent(result.event.body)}`),
    result.event.outlookWebUrl,
  );
  assert(!result.email.body.includes("Handover"), result.email.body);
});

Deno.test("event.body: a note is trimmed, and multiple lines survive", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    note: "  Handover: Anna\nReachable on Slack  ",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.event.body, "Handover: Anna\nReachable on Slack");
  // Newlines are percent-encoded, which is how Outlook receives a line break.
  assert(result.event.outlookWebUrl.includes("%0A"), result.event.outlookWebUrl);
});

Deno.test("event.body: a blank or whitespace note sends no body param at all", () => {
  for (const note of ["", "   ", "\n"]) {
    const result = buildLeaveRequest({
      name: "John Doe",
      type: "annual",
      duration: "full",
      startDate: "2026-07-20",
      note,
    });
    if (!result.ok) throw new Error(result.error);
    assertEquals(result.event.body, "");
    // A blank `body=` would be noise; the param is left out entirely.
    assert(!result.event.outlookWebUrl.includes("body="), result.event.outlookWebUrl);
  }
});

Deno.test("event.body: Remote keeps the note even though it has no HR email", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "remote",
    duration: "full",
    startDate: "2026-07-20",
    note: "Reachable on Slack",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.email.applicable, false);
  assertEquals(result.event.body, "Reachable on Slack");
});

Deno.test("type mapping: bracket, leave-type label and email applicability", () => {
  const base = { name: "John Doe", duration: "full", startDate: "2026-07-20" } as const;
  const cases = [
    { type: "annual", bracket: "[OFF] - John Doe", label: "Annual leave", applicable: true },
    { type: "sick", bracket: "[Sick Leave] - John Doe", label: "Sick leave", applicable: true },
    { type: "core", bracket: "[Core Leave] - John Doe", label: "Core leave", applicable: true },
    {
      type: "social",
      bracket: "[Social Leave] - John Doe",
      label: "Social leave",
      applicable: true,
    },
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

Deno.test("Core and Social leave are full-day only — a half-day is coerced to full", () => {
  for (const type of ["core", "social"] as const) {
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

Deno.test("Annual leave allows a half-day: TIME token in event bracket and email period", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "morning",
    startDate: "2026-07-20",
  });
  if (!result.ok) throw new Error(result.error);
  assertEquals(result.event.subject, "[Morning - OFF] - John Doe");
  assertEquals(result.email.subject, "[Leave Request] John Doe - 2026-07-20 (Morning)");
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
    type: "sick", // half-day-allowed type (Core is full-day only)
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

Deno.test("multiple team leads: Cc lists all, mailto + Outlook fold carry every address", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    teamLead: "lead@mesoneer.io; lead2@mesoneer.io",
  });
  if (!result.ok) throw new Error(result.error);
  // Cc displays the Outlook-style "; " list.
  assertEquals(result.email.cc, "lead@mesoneer.io; lead2@mesoneer.io");
  // mailto carries a proper comma-separated Cc.
  assert(
    result.email.mailto.includes(`cc=${encodeURIComponent("lead@mesoneer.io,lead2@mesoneer.io")}`),
    result.email.mailto,
  );
  // Outlook web drops `cc`, so both leads are folded into `to` (comma-separated).
  assert(
    result.email.outlookWebUrl.includes(
      `to=${encodeURIComponent("hr.vn@mesoneer.io,lead@mesoneer.io,lead2@mesoneer.io")}`,
    ),
    result.email.outlookWebUrl,
  );
});

Deno.test("multiple PO recipients: event lists all, calendar deep link attends every address", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    recipients: "po@mesoneer.io, po2@mesoneer.io",
  });
  if (!result.ok) throw new Error(result.error);
  // Display keeps the "; " separator after the fixed recipient.
  assertEquals(
    result.event.recipients,
    "mesoneer_vn@mesoneer.io; po@mesoneer.io; po2@mesoneer.io",
  );
  // Calendar `to` attendees are comma-separated, percent-encoded.
  assert(
    result.event.outlookWebUrl.includes(
      `to=${encodeURIComponent("mesoneer_vn@mesoneer.io,po@mesoneer.io,po2@mesoneer.io")}`,
    ),
    result.event.outlookWebUrl,
  );
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
  // Query-param recipients must be percent-encoded (unlike the mailto path). Outlook
  // web ignores a `cc` param, so the team lead is folded into `to` (comma-separated).
  assert(
    result.email.outlookWebUrl.includes(
      `to=${encodeURIComponent("hr.vn@mesoneer.io,lead@mesoneer.io")}`,
    ),
    result.email.outlookWebUrl,
  );
  assert(!result.email.outlookWebUrl.includes("cc="), result.email.outlookWebUrl);
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

Deno.test("outlookWebUrl: with no team lead, `to` is HR alone (nothing folded in)", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
  });
  if (!result.ok) throw new Error(result.error);
  assert(!result.email.outlookWebUrl.includes("cc="), result.email.outlookWebUrl);
  // No cc → `to` holds HR alone (ends at the next `&`, nothing folded in).
  assert(
    result.email.outlookWebUrl.includes("to=hr.vn%40mesoneer.io&subject="),
    result.email.outlookWebUrl,
  );
});

Deno.test("event.outlookWebUrl: all-day calendar deep link with dates and attendees", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-07-20",
    recipients: "po@mesoneer.io",
    note: "Handover: Anna covers standups",
  });
  if (!result.ok) throw new Error(result.error);
  const url = result.event.outlookWebUrl;
  assert(url.startsWith("https://outlook.office.com/calendar/0/deeplink/compose?"), url);
  assert(url.includes(`subject=${encodeURIComponent(result.event.subject)}`), url);
  assert(url.includes(`body=${encodeURIComponent(result.event.body)}`), url);
  assert(url.includes("startdt=2026-07-20"), url);
  // Outlook's all-day end is exclusive, so a single day ends at 00:00 the next day.
  assert(url.includes("enddt=2026-07-21"), url);
  assert(url.includes("allday=true"), url);
  // Nobody on the team list should be asked to reply to a leave notice.
  assert(url.includes("reqresponse=false"), url);
  // Attendees go in `to` (comma-separated), percent-encoded.
  assert(url.includes(`to=${encodeURIComponent("mesoneer_vn@mesoneer.io,po@mesoneer.io")}`), url);
});

Deno.test("half day ignores a stale end date (single-day period and event)", () => {
  const result = buildLeaveRequest({
    name: "John Doe",
    type: "sick", // half-day-allowed type; Core would coerce to full day
    duration: "morning",
    startDate: "2026-07-20",
    endDate: "2026-07-24", // e.g. left over from a previous full-day selection
  });
  if (!result.ok) throw new Error(result.error);
  assert(result.email.subject.includes("2026-07-20 (Morning)"), result.email.subject);
  assert(!result.email.subject.includes("to 2026-07-24"), result.email.subject);
  // A half day is one day: the calendar event must not span a range. enddt is the
  // day after (Outlook's all-day end is exclusive).
  assert(result.event.outlookWebUrl.includes("startdt=2026-07-20"), result.event.outlookWebUrl);
  assert(result.event.outlookWebUrl.includes("enddt=2026-07-21"), result.event.outlookWebUrl);
});

Deno.test("event.outlookWebUrl: multi-day range covers the final day (exclusive end)", () => {
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
  // Last leave day is 07-24; Outlook's all-day end is exclusive, so enddt is 07-25
  // (otherwise the event would stop at 07-24 00:00 and drop the final day).
  assert(url.includes("enddt=2026-07-25"), url);
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

function built(input: Parameters<typeof buildLeaveRequest>[0]) {
  const result = buildLeaveRequest(input);
  if (!result.ok) throw new Error(result.error);
  return result;
}

Deno.test("promptText: both artifacts, numbered, with the event's own settings", () => {
  const result = built({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-08-10",
    endDate: "2026-08-12",
    reason: "Family trip",
    teamLead: "lead@mesoneer.io, lead2@mesoneer.io",
    recipients: "po@mesoneer.io",
  });
  assertEquals(
    promptText(result),
    `${PROMPT_INSTRUCTIONS.both}\n\n` +
      "--- 1. HR email ---\n\n" +
      "To: hr.vn@mesoneer.io\n" +
      "Cc: lead@mesoneer.io; lead2@mesoneer.io\n" +
      "Subject: [Leave Request] John Doe - 2026-08-10 to 2026-08-12\n\n" +
      "Dear HR,\n\nDate off: 2026-08-10 to 2026-08-12\nLeave type: Annual leave\n" +
      "Reason: Family trip\n\nBest regards,\n\n" +
      "--- 2. Outlook calendar event ---\n\n" +
      "Subject: [OFF] - John Doe\n" +
      "Invite: mesoneer_vn@mesoneer.io; po@mesoneer.io\n" +
      "When: 2026-08-10 to 2026-08-12\n" +
      "All day: yes\n" +
      "Show as: Free\n" +
      "Request responses: no",
  );
});

Deno.test("promptText: Remote/WFH drop the email section and the numbering", () => {
  for (const type of ["remote", "wfh"] as const) {
    const result = built({
      name: "John Doe",
      type,
      duration: "morning",
      startDate: "2026-08-10",
    });
    const prompt = promptText(result);
    assertEquals(
      prompt,
      `${PROMPT_INSTRUCTIONS.eventOnly}\n\n` +
        "--- Outlook calendar event ---\n\n" +
        `Subject: [Morning - ${type === "remote" ? "Remote" : "WFH"}] - John Doe\n` +
        "Invite: mesoneer_vn@mesoneer.io\n" +
        "When: 2026-08-10 (Morning)\n" +
        "All day: yes\n" +
        "Show as: Free\n" +
        "Request responses: no",
    );
    assert(!prompt.includes("HR email"), `${type}: no HR email section`);
    assert(!prompt.includes("hr.vn@mesoneer.io"), `${type}: HR is not addressed`);
  }
});

Deno.test("promptText: the edited body replaces the generated one, verbatim", () => {
  const result = built({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-08-10",
  });
  // Nothing is escaped or encoded — this is prose for an assistant to read, not a
  // URL — so "&" and the newlines must survive untouched.
  const body = "Dear HR,\n\nEdited & tweaked\n\nBest regards,";
  const prompt = promptText(result, body);
  assert(prompt.includes(`\n\n${body}\n\n--- 2.`), prompt);
  assert(!prompt.includes("Leave type: Annual leave"), "generated body is gone");
  // A non-string body falls back to the generated one rather than printing itself.
  assert(promptText(result, undefined).includes("Leave type: Annual leave"), "default body");
});

Deno.test("promptText: no Cc line when there is no Cc", () => {
  const prompt = promptText(built({
    name: "John Doe",
    type: "annual",
    duration: "full",
    startDate: "2026-08-10",
    teamLead: " ; , ",
  }));
  // Whitespace-only and separator-only input is no Cc at all, not a blank one.
  assert(!prompt.includes("Cc:"), prompt);
  assert(prompt.includes("To: hr.vn@mesoneer.io\nSubject: "), prompt);
});

Deno.test("templateSummary: type label, duration, and optional reason", () => {
  assertEquals(templateSummary({ type: "annual", duration: "full" }), "Annual leave · full day");
  assertEquals(templateSummary({ type: "wfh", duration: "morning" }), "WFH · morning");
  assertEquals(templateSummary({ type: "sick", duration: "afternoon" }), "Sick leave · afternoon");
  // Full-day-only types always read "full day", even if a stray half-day slipped in.
  assertEquals(templateSummary({ type: "core", duration: "morning" }), "Core leave · full day");
  assertEquals(
    templateSummary({ type: "social", duration: "afternoon" }),
    "Social leave · full day",
  );
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

Deno.test("parseEmails: splits on comma or semicolon, trims, drops empties", () => {
  assertEquals(parseEmails("a@x.io, b@x.io"), ["a@x.io", "b@x.io"]);
  assertEquals(parseEmails("a@x.io; b@x.io"), ["a@x.io", "b@x.io"]);
  assertEquals(parseEmails("  a@x.io ,; b@x.io ; "), ["a@x.io", "b@x.io"]);
  assertEquals(parseEmails(""), []);
  assertEquals(parseEmails(undefined), []);
});

Deno.test("isValidEmailList: blank is valid; every address must be well-formed", () => {
  assert(isValidEmailList(""), "blank is valid (optional field)");
  assert(isValidEmailList(undefined), "undefined is valid");
  assert(isValidEmailList("a@x.io"), "single address");
  assert(isValidEmailList("a@x.io, b@y.io; c@z.io"), "mixed separators");
  assert(!isValidEmailList("a@x.io, not-an-email"), "one malformed address fails the list");
  assert(!isValidEmailList("nope"), "bare token fails");
});

Deno.test("addRecipients: valid addresses go to the front, deduped and capped", () => {
  // New addresses move to the front, keeping given order.
  assertEquals(
    addRecipients(["a@x.io", "b@x.io"], ["c@x.io", "d@x.io"]),
    ["c@x.io", "d@x.io", "a@x.io", "b@x.io"],
  );
  // Case-insensitive dedupe — the newest casing wins and moves front.
  assertEquals(addRecipients(["Bob@x.io"], ["bob@x.io"]), ["bob@x.io"]);
  // Blank and invalid entries are ignored.
  assertEquals(addRecipients([], ["  ", "nope", "ok@x.io"]), ["ok@x.io"]);
  // The cap keeps the most-recent entries.
  assertEquals(addRecipients(["a@x.io", "b@x.io"], ["c@x.io"], 2), ["c@x.io", "a@x.io"]);
});

Deno.test("removeRecipient: drops the address case-insensitively, no-op otherwise", () => {
  assertEquals(removeRecipient(["a@x.io", "b@x.io"], "A@X.IO"), ["b@x.io"]);
  assertEquals(removeRecipient(["a@x.io"], "c@x.io"), ["a@x.io"]);
});

Deno.test("recipientTokenAt: finds the fragment under the caret across separators", () => {
  // Caret at the end of a second, still-typing token.
  assertEquals(recipientTokenAt("a@x.io; jo", 10), { start: 7, end: 10, prefix: "jo" });
  // Caret right after a separator → an empty prefix.
  assertEquals(recipientTokenAt("a@x.io; ", 8), { start: 7, end: 8, prefix: "" });
  // A middle token bounded on both sides.
  assertEquals(recipientTokenAt("a@x.io; jo; b@x.io", 10), { start: 7, end: 10, prefix: "jo" });
});

Deno.test("filterRecipientSuggestions: prefix match, excludes present, honours cap", () => {
  const saved = ["joanne@x.io", "john@x.io", "jordan@x.io", "kim@x.io"];
  // Prefix filters, order preserved.
  assertEquals(
    filterRecipientSuggestions(saved, "lead@x.io; jo", 13),
    ["joanne@x.io", "john@x.io", "jordan@x.io"],
  );
  // An empty prefix returns the pool minus addresses already in the field.
  assertEquals(
    filterRecipientSuggestions(["a@x.io", "b@x.io"], "a@x.io; ", 8),
    ["b@x.io"],
  );
  // Cap limits the count.
  assertEquals(filterRecipientSuggestions(saved, "jo", 2, 2), ["joanne@x.io", "john@x.io"]);
});

Deno.test("applyRecipientCompletion: replaces the token and normalises separators", () => {
  // Last token: completes and leaves no trailing separator.
  assertEquals(
    applyRecipientCompletion("lead@x.io; jo", 13, "joanne@x.io"),
    { text: "lead@x.io; joanne@x.io", caret: "lead@x.io; joanne@x.io".length },
  );
  // Middle token: the following address is kept, separator normalised to "; ".
  assertEquals(
    applyRecipientCompletion("a@x.io; jo; b@x.io", 10, "joanne@x.io"),
    { text: "a@x.io; joanne@x.io; b@x.io", caret: "a@x.io; joanne@x.io".length },
  );
  // First and only token.
  assertEquals(
    applyRecipientCompletion("jo", 2, "joanne@x.io"),
    { text: "joanne@x.io", caret: "joanne@x.io".length },
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

Deno.test("summarizePeriod: a start before `today` warns about the past", () => {
  // 2024-01-01 was a Monday; "today" is Wed 2024-06-05.
  assertEquals(summarizePeriod("2024-01-01", "", "full", "2024-06-05"), {
    text: "1 day — Monday",
    warning: "Falls in the past.",
  });
  // Half days warn the same way.
  assertEquals(summarizePeriod("2024-01-01", "", "morning", "2024-06-05"), {
    text: "Half day — Monday",
    warning: "Falls in the past.",
  });
  // A range reads "Starts", matching the weekend-warning voice.
  assertEquals(summarizePeriod("2024-01-01", "2024-01-05", "full", "2024-06-05"), {
    text: "5 days — all weekdays",
    warning: "Starts in the past.",
  });
  // Past + weekend warnings stack, past first.
  assertEquals(
    summarizePeriod("2024-01-06", "2024-01-07", "full", "2024-06-05")?.warning,
    "Starts in the past. Starts on a Saturday. Ends on a Sunday.",
  );
});

Deno.test("summarizePeriod: today itself and future dates never warn about the past", () => {
  // Same-day (or retroactive-by-hours) sick leave is a normal request.
  assertEquals(summarizePeriod("2024-06-05", "", "full", "2024-06-05")?.warning, "");
  assertEquals(summarizePeriod("2024-06-06", "", "full", "2024-06-05")?.warning, "");
  // No/blank/garbage `today` disables the check (the module stays date-free).
  assertEquals(summarizePeriod("2024-01-01", "", "full")?.warning, "");
  assertEquals(summarizePeriod("2024-01-01", "", "full", "")?.warning, "");
  assertEquals(summarizePeriod("2024-01-01", "", "full", "not-a-date")?.warning, "");
});

Deno.test("upsertTemplate: a new title appends, a matching one is overwritten in place", () => {
  const wfh = { id: "1", title: "WFH Friday", type: "wfh" };
  const sick = { id: "2", title: "Sick", type: "sick" };

  // New title → appended at the end; nothing replaced.
  assertEquals(upsertTemplate([wfh], sick), { templates: [wfh, sick], replaced: null });
  assertEquals(upsertTemplate([], wfh), { templates: [wfh], replaced: null });

  // Matching title (case-insensitive, trimmed) → overwritten in place, keeping
  // the old id and position; the replaced entry comes back for an Undo.
  const resaved = { id: "9", title: "sick", type: "annual" };
  assertEquals(upsertTemplate([wfh, sick], resaved), {
    templates: [wfh, { id: "2", title: "sick", type: "annual" }],
    replaced: sick,
  });

  // The inputs are not mutated.
  const list = [wfh];
  upsertTemplate(list, { id: "9", title: "WFH Friday", type: "remote" });
  assertEquals(list, [{ id: "1", title: "WFH Friday", type: "wfh" }]);
});

Deno.test("nextWorkingDay: weekdays pass through, weekends roll to Monday", () => {
  // 2024-01-01 was a Monday, 2024-01-05 a Friday.
  assertEquals(nextWorkingDay("2024-01-01"), "2024-01-01", "Monday is already a working day");
  assertEquals(nextWorkingDay("2024-01-05"), "2024-01-05", "Friday is already a working day");
  // 2024-01-06 Saturday and 2024-01-07 Sunday both roll to Monday the 8th.
  assertEquals(nextWorkingDay("2024-01-06"), "2024-01-08", "Saturday rolls forward");
  assertEquals(nextWorkingDay("2024-01-07"), "2024-01-08", "Sunday rolls forward");
  // Rolling across a month/year boundary: 2023-12-30 was a Saturday.
  assertEquals(nextWorkingDay("2023-12-30"), "2024-01-01", "rolls across the year boundary");
  // Unparsable input comes back untouched — the form shows its own guidance.
  assertEquals(nextWorkingDay(""), "", "blank stays blank");
  assertEquals(nextWorkingDay("not-a-date"), "not-a-date", "garbage is returned as-is");
});

Deno.test("parseLeaveHandoff: fills the form from a grid selection, or gives up", () => {
  const text = (payload: unknown) => JSON.stringify(payload);

  assertEquals(
    parseLeaveHandoff(text({
      v: 1,
      name: "Anh Pham",
      type: "annual",
      duration: "full",
      from: "2026-07-27",
      to: "2026-07-29",
    })),
    {
      name: "Anh Pham",
      type: "annual",
      duration: "full",
      startDate: "2026-07-27",
      endDate: "2026-07-29",
    },
  );

  // A payload the sender could not fully resolve still saves the date entry:
  // an unmappable type and a missing name fall back to the empty form's values.
  assertEquals(
    parseLeaveHandoff(text({
      v: 1,
      name: null,
      type: null,
      duration: "sometimes",
      from: "2026-07-27",
      to: null,
    })),
    { name: "", type: "annual", duration: "full", startDate: "2026-07-27", endDate: "2026-07-27" },
  );

  // A backwards range describes one day, the reading formatPeriod already uses.
  assertEquals(
    parseLeaveHandoff(text({ v: 1, from: "2026-07-29", to: "2026-07-27" }))?.endDate,
    "2026-07-29",
    "an end before the start collapses to the start",
  );

  // Half days survive.
  assertEquals(
    parseLeaveHandoff(text({ v: 1, duration: "afternoon", from: "2026-07-27" }))?.duration,
    "afternoon",
  );

  // Nothing usable → null, and the page keeps the state it had.
  assertEquals(parseLeaveHandoff("not json"), null, "garbage");
  assertEquals(parseLeaveHandoff(text({ v: 2, from: "2026-07-27" })), null, "a newer version");
  assertEquals(parseLeaveHandoff(text({ v: 1, to: "2026-07-27" })), null, "no start date");
  assertEquals(parseLeaveHandoff(text({ v: 1, from: "27.07.2026" })), null, "not an ISO date");
  assertEquals(parseLeaveHandoff(text(null)), null, "not an object");
});

Deno.test("availabilityUpdate: turns the request into one person's day code", () => {
  const base = { name: "Anh Pham", type: "annual", duration: "full", startDate: "2026-07-27" };

  assertEquals(
    availabilityUpdate({ ...base, endDate: "2026-07-29" }),
    { name: "Anh Pham", from: "2026-07-27", to: "2026-07-29", code: "p" },
  );

  const code = (type: string, duration: string) =>
    availabilityUpdate({ ...base, type, duration })?.code;
  assertEquals(code("annual", "full"), "p", "annual leave");
  assertEquals(code("annual", "morning"), "m");
  assertEquals(code("annual", "afternoon"), "a");
  assertEquals(code("sick", "full"), "s");
  assertEquals(code("sick", "morning"), "sm");
  assertEquals(code("sick", "afternoon"), "sa");
  assertEquals(code("remote", "full"), "r");
  assertEquals(code("wfh", "afternoon"), "ra", "WFH and Remote share the remote codes");
  // Core leave is full-day only, so its halves resolve to the full-day code
  // rather than inventing a request the form cannot make.
  assertEquals(code("core", "full"), "c");
  assertEquals(code("core", "morning"), "c");
  assertEquals(code("social", "full"), "si");
  assertEquals(code("social", "morning"), "si");
  assertEquals(code("nonsense", "full"), "p", "an unknown type falls back to annual");

  // A half day is a single date, however the To field was left.
  assertEquals(
    availabilityUpdate({ ...base, duration: "morning", endDate: "2026-07-31" }),
    { name: "Anh Pham", from: "2026-07-27", to: "2026-07-27", code: "m" },
  );
  // So is a full day whose end is missing, blank or before the start.
  const to = (endDate: string) => availabilityUpdate({ ...base, endDate })?.to;
  assertEquals(to(""), "2026-07-27", "no end date");
  assertEquals(to("2026-07-20"), "2026-07-27", "an end before the start");
  assertEquals(to("nope"), "2026-07-27", "an unparsable end");

  // Nothing to record against.
  assertEquals(availabilityUpdate({ ...base, name: "  " }), null, "no name");
  assertEquals(availabilityUpdate({ ...base, startDate: "" }), null, "no start date");
  assertEquals(availabilityUpdate({ ...base, startDate: "27.07.2026" }), null, "not an ISO date");
});

// @ts-check
/**
 * Leave-request builder — pure logic for the Leave Request tool.
 *
 * It turns one small form into the two artifacts mandated by the team's
 * "How to Submit a Leave Request" page: the HR leave-request email (step 1)
 * and the Outlook calendar event subject (step 2). No DOM, no network — the
 * browser UI and the Deno parity tests import this very file unchanged.
 */

/** Fixed recipients from the leave-request page. */
export const HR_EMAIL = "hr.vn@mesoneer.io";
export const EVENT_RECIPIENT = "mesoneer_vn@mesoneer.io";

/**
 * Leave types → the Outlook event bracket, the HR "Leave type" label, whether an
 * HR email is normally expected (Remote/WFH are not leave), and whether the type is
 * full-day only (Annual/Core leave can't be taken as a half day).
 * @type {Record<string, { bracket: string, label: string, emailApplicable: boolean,
 *   fullDayOnly?: boolean }>}
 */
export const TYPES = {
  annual: { bracket: "OFF", label: "Annual leave", emailApplicable: true, fullDayOnly: true },
  sick: { bracket: "Sick Leave", label: "Sick leave", emailApplicable: true },
  core: { bracket: "Core Leave", label: "Core leave", emailApplicable: true, fullDayOnly: true },
  remote: { bracket: "Remote", label: "Remote", emailApplicable: false },
  wfh: { bracket: "WFH", label: "WFH", emailApplicable: false },
};

/**
 * @typedef {Object} LeaveInput
 * @property {string} name Full name, e.g. "John Doe".
 * @property {"annual"|"sick"|"core"|"remote"|"wfh"} type
 * @property {"full"|"morning"|"afternoon"} duration
 * @property {string} startDate ISO date, e.g. "2026-07-20".
 * @property {string} [endDate] ISO date; a full-day period end. Ignored for half days.
 * @property {string} [reason] Optional reason for the HR email.
 * @property {string} [teamLead] Optional team-lead address; becomes the email Cc.
 * @property {string} [recipients] Optional extra event recipients (e.g. your PO).
 */

/**
 * @typedef {Object} LeaveResult
 * @property {true} ok
 * @property {{ to: string, cc: string, subject: string, body: string,
 *   mailto: string, outlookWebUrl: string, applicable: boolean }} email
 * @property {{ subject: string, recipients: string, outlookWebUrl: string }} event
 */

/**
 * Build the HR email and Outlook event from the form input.
 * @param {LeaveInput} input
 * @returns {LeaveResult | { ok: false, error: string }}
 */
export function buildLeaveRequest(input) {
  const name = String(input?.name ?? "").trim();
  const type = TYPES[input?.type] ? input.type : "annual";
  const meta = TYPES[type];
  // Annual/Core leave is full-day only, so a half-day selection is ignored for them.
  const duration = !meta.fullDayOnly &&
      (input?.duration === "morning" || input?.duration === "afternoon")
    ? input.duration
    : "full";
  const startDate = String(input?.startDate ?? "").trim();
  const endDate = String(input?.endDate ?? "").trim();
  const reason = String(input?.reason ?? "").trim();
  const teamLead = String(input?.teamLead ?? "").trim();
  const recipients = String(input?.recipients ?? "").trim();

  if (name === "") return { ok: false, error: "Enter your name." };
  if (startDate === "") return { ok: false, error: "Pick a start date." };
  if (duration === "full" && endDate !== "" && endDate < startDate) {
    return { ok: false, error: "The end date is before the start date." };
  }

  const period = formatPeriod(startDate, endDate, duration);
  const time = duration === "morning" ? "Morning" : duration === "afternoon" ? "Afternoon" : "";

  const subject = `[Leave Request] ${name} - ${period}`;
  const body = [
    "Dear HR,",
    "",
    `Date off: ${period}`,
    `Leave type: ${meta.label}`,
    reason === "" ? "Reason:" : `Reason: ${reason}`,
    "",
    "Best regards,",
  ].join("\n");

  // Outlook-web `cc` support varies by tenant (best-effort); mailto reliably carries Cc.
  // Both are also rebuilt by the UI from an edited body via the same exported helpers.
  const mailto = mailtoUrl(HR_EMAIL, teamLead, subject, body);
  const outlookWebUrl = outlookComposeUrl(HR_EMAIL, teamLead, subject, body);

  const eventBracket = time === "" ? meta.bracket : `${time} - ${meta.bracket}`;
  const eventSubject = `[${eventBracket}] - ${name}`;
  const eventRecipients = recipients === "" ? EVENT_RECIPIENT : `${EVENT_RECIPIENT}; ${recipients}`;

  // Outlook-on-the-web calendar deep link — prefills the new-event form (subject,
  // all-day, dates, attendees). "Show as Free" and "don't request a response" have no
  // URL parameters, so they stay manual (see the reminder chips). enddt is inclusive;
  // a single day repeats the date so the span is right whether Outlook treats the end
  // as inclusive or exclusive. Attendees go in `to` (comma-separated).
  const eventEnd = duration === "full" && endDate !== "" && endDate > startDate
    ? endDate
    : startDate;
  const attendees = recipients === "" ? EVENT_RECIPIENT : `${EVENT_RECIPIENT},${recipients}`;
  const eventOutlookWebUrl = "https://outlook.office.com/calendar/0/deeplink/compose?" +
    [
      `path=${encodeURIComponent("/calendar/action/compose")}`,
      "rru=addevent",
      `subject=${encodeURIComponent(eventSubject)}`,
      `startdt=${startDate}`,
      `enddt=${eventEnd}`,
      "allday=true",
      `to=${encodeURIComponent(attendees)}`,
    ].join("&");

  return {
    ok: true,
    email: {
      to: HR_EMAIL,
      cc: teamLead,
      subject,
      body,
      mailto,
      outlookWebUrl,
      applicable: meta.emailApplicable,
    },
    event: {
      subject: eventSubject,
      recipients: eventRecipients,
      outlookWebUrl: eventOutlookWebUrl,
    },
  };
}

/**
 * The human-readable "day/period" shared by the email subject and body.
 * Half days are always a single date tagged with the time of day.
 * @param {string} startDate
 * @param {string} endDate
 * @param {"full"|"morning"|"afternoon"} duration
 * @returns {string}
 */
function formatPeriod(startDate, endDate, duration) {
  if (duration === "morning") return `${startDate} (Morning)`;
  if (duration === "afternoon") return `${startDate} (Afternoon)`;
  if (endDate !== "" && endDate > startDate) return `${startDate} to ${endDate}`;
  return startDate;
}

/**
 * A `mailto:` link. `cc` is omitted when empty. Exported so the UI can rebuild the
 * link from an edited body using the same encoding.
 * @param {string} to
 * @param {string} cc
 * @param {string} subject
 * @param {string} body
 * @returns {string}
 */
export function mailtoUrl(to, cc, subject, body) {
  const params = [];
  if (cc) params.push(`cc=${encodeURIComponent(cc)}`);
  params.push(`subject=${encodeURIComponent(subject)}`);
  params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${to}?${params.join("&")}`;
}

/**
 * An Outlook-on-the-web mail compose deep link (Microsoft 365). Recipients are query
 * params, so they're percent-encoded; `cc` is omitted when empty.
 * @param {string} to
 * @param {string} cc
 * @param {string} subject
 * @param {string} body
 * @returns {string}
 */
export function outlookComposeUrl(to, cc, subject, body) {
  const params = [`to=${encodeURIComponent(to)}`];
  if (cc) params.push(`cc=${encodeURIComponent(cc)}`);
  params.push(`subject=${encodeURIComponent(subject)}`);
  params.push(`body=${encodeURIComponent(body)}`);
  return `https://outlook.office.com/mail/deeplink/compose?${params.join("&")}`;
}

/**
 * One-line summary of a saved template's reusable fields, e.g. "WFH · morning" or
 * "Annual leave · full day · Family trip". Full-day-only types always read "full day";
 * the reason is appended when present.
 * @param {{ type?: string, duration?: string, reason?: string }} fields
 * @returns {string}
 */
export function templateSummary(fields) {
  const meta = TYPES[fields?.type ?? ""] ?? TYPES.annual;
  const half = !meta.fullDayOnly &&
    (fields?.duration === "morning" || fields?.duration === "afternoon");
  const duration = half ? fields.duration : "full day";
  const reason = String(fields?.reason ?? "").trim();
  const summary = `${meta.label} · ${duration}`;
  return reason === "" ? summary : `${summary} · ${reason}`;
}

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
 * @property {string} [teamLead] Optional team-lead address(es); become the email Cc.
 *   A comma- or semicolon-separated list is accepted.
 * @property {string} [recipients] Optional extra event recipients (e.g. your PO).
 *   A comma- or semicolon-separated list is accepted.
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
  const teamLeads = parseEmails(input?.teamLead);
  const extraRecipients = parseEmails(input?.recipients);

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

  // Cc display uses Outlook's own "; " separator; the URL helpers re-split it into
  // comma-separated addresses. Outlook web's compose deeplink drops a `cc` param, so
  // its link folds the team lead(s) into `to`; mailto reliably carries a proper Cc.
  // Both are also rebuilt by the UI from an edited body via the same exported helpers.
  const cc = teamLeads.join("; ");
  const mailto = mailtoUrl(HR_EMAIL, cc, subject, body);
  const outlookWebUrl = outlookComposeUrl(HR_EMAIL, cc, subject, body);

  const eventBracket = time === "" ? meta.bracket : `${time} - ${meta.bracket}`;
  const eventSubject = `[${eventBracket}] - ${name}`;
  const eventRecipients = extraRecipients.length === 0
    ? EVENT_RECIPIENT
    : `${EVENT_RECIPIENT}; ${extraRecipients.join("; ")}`;

  // Outlook-on-the-web calendar deep link — prefills the new-event form (subject,
  // all-day, dates, attendees). "Show as Free" and "don't request a response" have no
  // URL parameters, so they stay manual (see the reminder chips). Outlook treats an
  // all-day event's end as exclusive (00:00 of the day after the last day), so enddt
  // is the day *after* the last leave day — otherwise a single day is a zero-length
  // event Outlook won't create and a range drops its final day. Attendees go in `to`.
  const lastDay = duration === "full" && endDate !== "" && endDate > startDate
    ? endDate
    : startDate;
  const eventEnd = nextDay(lastDay);
  const attendees = [EVENT_RECIPIENT, ...extraRecipients].join(",");
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
      cc,
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

/** The HTML5 email-input validity regex, applied per address (WHATWG spec). */
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Split a free-typed recipient list on commas or semicolons (Outlook uses `;`),
 * trim each, and drop the empties. Returns the addresses in order.
 * @param {string | undefined} list
 * @returns {string[]}
 */
export function parseEmails(list) {
  return String(list ?? "")
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter((address) => address !== "");
}

/**
 * Whether an optional recipient field is acceptable: blank, or a list whose every
 * address is a well-formed email. Mirrors the browser's per-address `type=email`
 * check so multi-recipient input is validated exactly as a single one used to be.
 * @param {string | undefined} list
 * @returns {boolean}
 */
export function isValidEmailList(list) {
  return parseEmails(list).every((address) => EMAIL_RE.test(address));
}

/**
 * Add addresses to the saved-recipient pool: valid ones are moved to the front
 * (most-recent-first), the list is de-duplicated case-insensitively (the newest
 * casing wins) and capped. Blank/invalid entries are ignored. Pure — the UI owns
 * the localStorage read/write.
 * @param {string[]} list Existing pool.
 * @param {string[]} addresses Addresses just used or saved.
 * @param {number} [cap] Maximum entries to keep.
 * @returns {string[]} A new pool.
 */
export function addRecipients(list, addresses, cap = 50) {
  const clean = (addresses ?? []).map((a) => String(a).trim()).filter((a) => EMAIL_RE.test(a));
  const seen = new Set();
  const out = [];
  for (const address of [...clean, ...(list ?? [])]) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Remove one address from the pool, matched case-insensitively.
 * @param {string[]} list
 * @param {string} address
 * @returns {string[]} A new pool.
 */
export function removeRecipient(list, address) {
  const key = String(address).toLowerCase();
  return (list ?? []).filter((a) => a.toLowerCase() !== key);
}

/**
 * The recipient token the caret sits in — the address fragment between the comma
 * or semicolon before the caret and the one after it. `prefix` is that fragment
 * trimmed, used to match suggestions.
 * @param {string} value Full field value.
 * @param {number} caret Caret index.
 * @returns {{ start: number, end: number, prefix: string }}
 */
export function recipientTokenAt(value, caret) {
  const text = String(value ?? "");
  let pos = Number.isInteger(caret) ? caret : text.length;
  pos = Math.max(0, Math.min(pos, text.length));
  let start = pos;
  while (start > 0 && text[start - 1] !== "," && text[start - 1] !== ";") start--;
  let end = pos;
  while (end < text.length && text[end] !== "," && text[end] !== ";") end++;
  return { start, end, prefix: text.slice(start, end).trim() };
}

/**
 * Suggestions for the token at the caret: saved addresses whose start matches the
 * token's prefix (case-insensitive), minus any already present elsewhere in the
 * field. An empty prefix returns the whole pool (minus present), recent-first.
 * @param {string[]} saved
 * @param {string} value
 * @param {number} caret
 * @param {number} [cap]
 * @returns {string[]}
 */
export function filterRecipientSuggestions(saved, value, caret, cap = 8) {
  const needle = recipientTokenAt(value, caret).prefix.toLowerCase();
  const present = new Set(parseEmails(value).map((a) => a.toLowerCase()));
  const out = [];
  for (const address of saved ?? []) {
    const key = address.toLowerCase();
    if (needle && !key.startsWith(needle)) continue;
    if (present.has(key)) continue;
    out.push(address);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Replace the token at the caret with `address`, normalising the separators
 * around it to "; ". Returns the new text and where to place the caret (just
 * after the inserted address).
 * @param {string} value
 * @param {number} caret
 * @param {string} address
 * @returns {{ text: string, caret: number }}
 */
export function applyRecipientCompletion(value, caret, address) {
  const { start, end } = recipientTokenAt(value, caret);
  const left = String(value ?? "").slice(0, start).replace(/[;,]\s*$/, "; ");
  const right = String(value ?? "").slice(end).replace(/^\s*[;,]\s*/, "; ");
  return { text: left + address + right, caret: (left + address).length };
}

/**
 * A `mailto:` link. `cc` is omitted when empty; a comma/semicolon list is
 * normalised to the comma-separated addresses mailto expects. Exported so the UI
 * can rebuild the link from an edited body using the same encoding.
 * @param {string} to
 * @param {string} cc
 * @param {string} subject
 * @param {string} body
 * @returns {string}
 */
export function mailtoUrl(to, cc, subject, body) {
  const ccList = parseEmails(cc).join(",");
  const params = [];
  if (ccList) params.push(`cc=${encodeURIComponent(ccList)}`);
  params.push(`subject=${encodeURIComponent(subject)}`);
  params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${to}?${params.join("&")}`;
}

/**
 * An Outlook-on-the-web mail compose deep link (Microsoft 365). Recipients are query
 * params, so they're percent-encoded. The deeplink/compose endpoint honours only
 * `to`, `subject` and `body` — a `cc`/`bcc` param is silently dropped — so the Cc
 * recipient(s) are folded into `to` (comma-separated) to keep the team lead on the
 * mail; the mailto path carries a proper Cc for the Outlook app.
 * @param {string} to
 * @param {string} cc
 * @param {string} subject
 * @param {string} body
 * @returns {string}
 */
export function outlookComposeUrl(to, cc, subject, body) {
  const ccList = parseEmails(cc).join(",");
  const recipients = ccList ? `${to},${ccList}` : to;
  const params = [
    `to=${encodeURIComponent(recipients)}`,
    `subject=${encodeURIComponent(subject)}`,
    `body=${encodeURIComponent(body)}`,
  ];
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

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Day of week (0 = Sunday) for an ISO date, or null when unparsable. UTC-anchored
 * so the result is the calendar day named, independent of the runtime timezone.
 * @param {string} isoDate
 * @returns {number | null}
 */
function dayOfWeek(isoDate) {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t).getUTCDay();
}

/**
 * The day after an ISO date (YYYY-MM-DD), as an ISO date. UTC-anchored so it never
 * shifts by the runtime timezone. Used for the calendar deep link's exclusive
 * all-day end date.
 * @param {string} isoDate
 * @returns {string}
 */
function nextDay(isoDate) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

/**
 * Day count and weekend feedback for the picked period, shown under the date
 * fields. Catches the two expensive mistakes: an off-by-one range and a request
 * that falls on a weekend. Follows formatPeriod's semantics: half days and an
 * end date not after the start are a single day.
 * @param {string} startDate ISO date.
 * @param {string} endDate ISO date; ignored for half days.
 * @param {"full"|"morning"|"afternoon"} duration
 * @returns {{ text: string, warning: string } | null} null when startDate is
 *   missing or unparsable.
 */
export function summarizePeriod(startDate, endDate, duration) {
  const start = String(startDate ?? "").trim();
  const startDow = dayOfWeek(start);
  if (startDow === null) return null;

  const half = duration === "morning" || duration === "afternoon";
  const end = String(endDate ?? "").trim();
  const endDow = half ? null : dayOfWeek(end);
  const isWeekend = (/** @type {number} */ dow) => dow === 0 || dow === 6;

  if (endDow === null || end <= start) {
    return {
      text: `${half ? "Half day" : "1 day"} — ${DAY_NAMES[startDow]}`,
      warning: isWeekend(startDow) ? `Falls on a ${DAY_NAMES[startDow]}.` : "",
    };
  }

  const days = Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000,
  ) + 1;
  let weekdays = 0;
  for (let i = 0; i < days; i++) {
    if (!isWeekend((startDow + i) % 7)) weekdays++;
  }
  const breakdown = weekdays === days
    ? "all weekdays"
    : weekdays === 0
    ? `${days} weekend days`
    : `${weekdays} weekday${weekdays === 1 ? "" : "s"}, ` +
      `${days - weekdays} weekend day${days - weekdays === 1 ? "" : "s"}`;

  const warnings = [];
  if (isWeekend(startDow)) warnings.push(`Starts on a ${DAY_NAMES[startDow]}.`);
  if (isWeekend(endDow)) warnings.push(`Ends on a ${DAY_NAMES[endDow]}.`);

  return { text: `${days} days — ${breakdown}`, warning: warnings.join(" ") };
}

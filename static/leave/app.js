// meso.utilities — browser UI for Leave Request.
// Imports the same builder the parity tests exercise; details never leave the
// page. "Open in mail" hands off to the local mail client via a mailto: link;
// the calendar event is copied for pasting into a new Outlook event.
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
  removeRecipient,
  summarizePeriod,
  templateSummary,
  TYPES,
} from "./leave.mjs";
import { queueUpdate, takeHandoff } from "../handoff.mjs";
import { registerCommands, TOOL_ICONS } from "../palette.js";
import { makeToast } from "../ui.mjs";

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const els = {
  name: /** @type {HTMLInputElement} */ ($("name")),
  type: /** @type {HTMLSelectElement} */ ($("type")),
  duration: /** @type {HTMLSelectElement} */ ($("duration")),
  durationHint: $("duration-hint"),
  start: /** @type {HTMLInputElement} */ ($("start")),
  end: /** @type {HTMLInputElement} */ ($("end")),
  endField: $("end-field"),
  fromSub: $("from-sub"),
  dateLabel: $("date-label"),
  dateSummary: $("date-summary"),
  reason: /** @type {HTMLInputElement} */ ($("reason")),
  reasonField: $("reason-field"),
  lead: /** @type {HTMLInputElement} */ ($("lead")),
  leadField: $("lead-field"),
  leadSave: $("lead-save"),
  recipients: /** @type {HTMLInputElement} */ ($("recipients")),
  recipientsSave: $("recipients-save"),
  formStatus: $("form-status"),
  emailCard: $("email-card"),
  emailCc: $("email-cc"),
  emailCcBlock: $("email-cc-block"),
  emailSubject: $("email-subject"),
  emailBody: /** @type {HTMLTextAreaElement} */ ($("email-body")),
  bodyReset: $("body-reset"),
  openMail: $("open-mail"),
  openOutlook: $("open-outlook"),
  copySubject: $("copy-subject"),
  saveAvailability: $("save-availability"),
  copyBody: /** @type {HTMLButtonElement} */ ($("copy-body")),
  emailDone: $("email-done"),
  eventDone: $("event-done"),
  eventTitle: $("event-title"),
  eventSubject: $("event-subject"),
  eventRecipients: $("event-recipients"),
  addEventOutlook: $("add-event-outlook"),
  copyEventSubject: $("copy-event-subject"),
  copyRecipients: $("copy-recipients"),
  tplSave: $("tpl-save"),
  tplSaveForm: $("tpl-save-form"),
  tplTitle: /** @type {HTMLInputElement} */ ($("tpl-title")),
  tplSaveCancel: $("tpl-save-cancel"),
  tplList: $("tpl-list"),
  tplEmpty: $("tpl-empty"),
  toast: $("toast"),
};

/** The latest valid result, or null while the form is incomplete. */
let current = null;

/** True once the user edits the body, so form changes stop overwriting their text. */
let bodyDirty = false;

/** Session-only step progress: the open/add actions set these, any form change
 *  clears them (an edited form describes a new request, not the one sent). */
const stepsDone = { email: false, event: false };

/** localStorage key for the remembered name (only the name is stored). */
const NAME_KEY = "meso-leave-name";
/** localStorage key for saved templates (an array of field presets). */
const TPL_KEY = "meso-leave-templates";
/** Inline bookmark glyph for saved-template rows (inherits currentColor). */
const BOOKMARK_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>';

/**
 * Actions grouped by what could actually go wrong, so one bad optional address
 * only blocks what would silently drop it:
 *  - `emailCopy` — the subject/body never carry the Cc, so only the form matters
 *    (and the HR step has to apply at all: Remote/WFH have no email).
 *  - `emailSend` — the mailto/Outlook links carry the Cc, so the CC field must be
 *    well-formed or the address the user typed would vanish without a word.
 *  - `eventCopy` / `eventSend` — same split for the PO/extra recipients field.
 */
const ACTION_GROUPS = {
  emailCopy: [els.copySubject, els.copyBody],
  emailSend: [els.openMail, els.openOutlook],
  eventCopy: [els.copyEventSubject],
  eventSend: [els.addEventOutlook, els.copyRecipients],
};

/** Which groups are live right now. The palette commands bypass the disabled
 *  buttons, so they check these flags instead (see `guarded`). */
const actionsEnabled = { emailCopy: false, emailSend: false, eventCopy: false, eventSend: false };

const EMAIL_ERROR =
  "Enter valid email addresses (comma or semicolon separated), or leave it blank.";

/** Inline error slot for an optional email field, injected right after the input
 *  (reusing .error-line) and wired up as its description. */
function attachErrorSlot(input) {
  const error = document.createElement("p");
  error.className = "error-line";
  error.id = `${input.id}-error`;
  error.hidden = true;
  input.setAttribute("aria-describedby", error.id);
  input.insertAdjacentElement("afterend", error);
  return error;
}

const leadError = attachErrorSlot(els.lead);
const recipientsError = attachErrorSlot(els.recipients);

const showToast = makeToast(els.toast);

function readInput() {
  // The form's <select>s are constrained to the union's members in the HTML,
  // but to the checker `value` is only ever a `string`.
  return /** @type {import("./leave.mjs").LeaveInput} */ ({
    name: els.name.value,
    type: els.type.value,
    duration: els.duration.value,
    startDate: els.start.value,
    endDate: els.end.value,
    reason: els.reason.value,
    teamLead: els.lead.value,
    recipients: els.recipients.value,
  });
}

/** Core and Social leave are full-day only — disable the half-day options for them. */
function syncDurationConstraint() {
  const meta = TYPES[els.type.value];
  const fullOnly = Boolean(meta?.fullDayOnly);
  for (const option of els.duration.options) {
    if (option.value !== "full") option.disabled = fullOnly;
  }
  if (fullOnly && els.duration.value !== "full") els.duration.value = "full";
  els.durationHint.hidden = !fullOnly;
  if (fullOnly) els.durationHint.textContent = `${meta.label} is full-day only.`;
}

/** Recompute both artifacts and paint them; called on every field change. */
function render() {
  syncDurationConstraint();
  // Full day → a From/To range; a half day is a single date, so hide the "To" input.
  const isHalfDay = els.duration.value !== "full";
  els.endField.hidden = isHalfDay;
  els.fromSub.hidden = isHalfDay;
  els.dateLabel.textContent = isHalfDay ? "Date" : "Dates";
  // The visible "From" marker is aria-hidden, so name the input directly.
  els.start.setAttribute("aria-label", isHalfDay ? "Date" : "From date");
  // Keep the native picker from offering an end date before the start. A value
  // typed in below the min still hits buildLeaveRequest's own conflict check.
  els.end.min = els.start.value;

  // Remote/WFH aren't leave, so no HR email is expected: hide that step. The Outlook
  // event is then the only step, so drop its "· step 2" suffix. Reason and CC feed
  // that email and nothing else, so they go with it — leaving them on screen invited
  // people to fill in fields that could not reach anywhere.
  const needsEmail = Boolean(TYPES[els.type.value]?.emailApplicable);
  els.emailCard.hidden = !needsEmail;
  els.reasonField.hidden = !needsEmail;
  els.leadField.hidden = !needsEmail;
  els.eventTitle.textContent = needsEmail ? "Outlook Event · step 2" : "Outlook Event";
  paintSteps();

  const input = readInput();
  // An invalid (but optional) address is flagged by its inline error and the
  // disabled actions; keep it out of the previews so they never show it as sent.
  // The Cc goes the same way when the HR step doesn't apply — its field is hidden.
  if (!needsEmail || !isValidEmailList(els.lead.value)) input.teamLead = "";
  if (!isValidEmailList(els.recipients.value)) input.recipients = "";
  const result = buildLeaveRequest(input);

  if (!result.ok) {
    current = null;
    els.formStatus.textContent = result.error;
    // Only a genuine conflict (end before start) is an error; the rest is guidance.
    els.formStatus.className = "status" + (/before/.test(result.error) ? " bad" : "");
    els.emailSubject.textContent = "—";
    els.eventSubject.textContent = "—";
    els.eventRecipients.textContent = "—";
    if (!bodyDirty) els.emailBody.value = "";
    els.bodyReset.hidden = !bodyDirty;
    els.emailCcBlock.hidden = true;
    els.dateSummary.hidden = true;
    setActionsEnabled(false, needsEmail);
    return;
  }

  current = result;

  const summary = summarizePeriod(
    input.startDate,
    input.endDate ?? "",
    /** @type {"full" | "morning" | "afternoon"} */ (els.duration.value),
  );
  els.dateSummary.hidden = !summary;
  if (summary) {
    els.dateSummary.textContent = summary.warning
      ? `${summary.text} · ⚠️ ${summary.warning}`
      : summary.text;
    els.dateSummary.classList.toggle("warn", summary.warning !== "");
  }

  els.emailSubject.textContent = result.email.subject;
  if (!bodyDirty) els.emailBody.value = result.email.body;
  els.bodyReset.hidden = !bodyDirty;
  els.emailCcBlock.hidden = result.email.cc === "";
  els.emailCc.textContent = result.email.cc;

  els.eventSubject.textContent = result.event.subject;
  els.eventRecipients.textContent = result.event.recipients;

  // A malformed (but optional) email must not reach the mailto/event.
  // setActionsEnabled validates both address fields and disables only the actions
  // each one would break; `current` already excludes them, so what stays enabled is
  // safe to fire.
  const { leadOk, recipientsOk } = setActionsEnabled(true, needsEmail);
  if (leadOk && recipientsOk) {
    els.formStatus.textContent = needsEmail
      ? "Ready — copy the parts you need, or open the email in your mail app."
      : "Ready — no HR email for this type; add the event to Outlook.";
    els.formStatus.className = "status ok";
  } else {
    els.formStatus.textContent = !leadOk && !recipientsOk
      ? "Fix the highlighted addresses to enable the email and event actions."
      : leadOk
      ? "Fix the recipients address to enable the event actions."
      : "Fix the CC address to enable the email actions.";
    els.formStatus.className = "status bad";
  }
}

/** Show or hide the "✓ done" badge on each step heading. */
function paintSteps() {
  els.emailDone.hidden = !stepsDone.email;
  els.eventDone.hidden = !stepsDone.event;
}

/**
 * Validate the optional email fields, paint their inline errors, and enable each
 * action group that its inputs allow.
 *
 * `type=email` alone doesn't block anything, so without this a typo would reach the
 * mailto/event; and a multi-address list needs per-address checking anyway. A hidden
 * CC field (Remote/WFH) can't be corrected by the user, so it never blocks — it is
 * simply left out of the request.
 * @param {boolean} formOk Whether the request itself builds.
 * @param {boolean} emailApplies Whether this leave type has an HR email step.
 * @returns {{ leadOk: boolean, recipientsOk: boolean }}
 */
function setActionsEnabled(formOk, emailApplies) {
  const leadOk = !emailApplies || isValidEmailList(els.lead.value); // blank is valid
  const recipientsOk = isValidEmailList(els.recipients.value);
  paintFieldError(els.lead, leadError, !leadOk);
  paintFieldError(els.recipients, recipientsError, !recipientsOk);

  actionsEnabled.emailCopy = formOk && emailApplies;
  actionsEnabled.emailSend = formOk && emailApplies && leadOk;
  actionsEnabled.eventCopy = formOk;
  actionsEnabled.eventSend = formOk && recipientsOk;
  for (const [group, buttons] of Object.entries(ACTION_GROUPS)) {
    for (const button of /** @type {HTMLButtonElement[]} */ (buttons)) {
      button.disabled = !actionsEnabled[group];
    }
  }
  return { leadOk, recipientsOk };
}

/** Show or clear one field's inline error and its invalid styling. */
function paintFieldError(input, error, invalid) {
  error.textContent = invalid ? EMAIL_ERROR : "";
  error.hidden = !invalid;
  input.setAttribute("aria-invalid", invalid ? "true" : "false");
}

async function copy(text, label) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied`);
  } catch {
    showToast("Copy failed — select the text and copy manually");
  }
}

function openMail() {
  if (!current || !actionsEnabled.emailSend) return;
  rememberRecipients(els.lead.value);
  stepsDone.email = true;
  paintSteps();
  location.href = mailtoUrl(
    current.email.to,
    current.email.cc,
    current.email.subject,
    els.emailBody.value,
  );
}

function openOutlookWeb() {
  if (!current || !actionsEnabled.emailSend) return;
  rememberRecipients(els.lead.value);
  stepsDone.email = true;
  paintSteps();
  const url = outlookComposeUrl(
    current.email.to,
    current.email.cc,
    current.email.subject,
    els.emailBody.value,
  );
  globalThis.open(url, "_blank", "noopener");
}

/** Mark the body as user-edited so re-renders keep it; reveal the reset link. */
function onBodyEdited() {
  bodyDirty = true;
  els.bodyReset.hidden = false;
}

/** Discard edits and let the body track the generated text again. */
function resetBody() {
  bodyDirty = false;
  render();
}

function addEventToOutlook() {
  if (!current || !actionsEnabled.eventSend) return;
  rememberRecipients(els.recipients.value);
  stepsDone.event = true;
  paintSteps();
  globalThis.open(current.event.outlookWebUrl, "_blank", "noopener");
}

/**
 * Queue these days for Team Availability's grid. Nothing is written here: this
 * page has no business reshaping another tool's roster, and that tool may not
 * even have a workbook imported yet. It parks the change in localStorage —
 * durable and visible to every tab — and Availability applies it, or explains
 * why it couldn't, the next time it opens.
 */
function saveToAvailability() {
  const update = availabilityUpdate(readInput());
  if (update === null) {
    showToast("Enter your name and a start date first");
    return;
  }
  if (!queueUpdate(localStorage, "availability", update, "Leave Request")) {
    showToast("Could not save — browser storage is unavailable");
    return;
  }
  const days = update.from === update.to ? update.from : `${update.from} → ${update.to}`;
  showToast(`Saved for Team Availability — ${days} as "${update.code}". Open it to see it.`);
}

/** Remember the name across visits — everything else stays per-session. */
function saveName() {
  try {
    if (els.name.value.trim() === "") localStorage.removeItem(NAME_KEY);
    else localStorage.setItem(NAME_KEY, els.name.value);
  } catch {
    /* storage unavailable; the name just won't persist */
  }
}

/* ------------------------------- templates ------------------------------- */

function loadTemplates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TPL_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function storeTemplates(templates) {
  try {
    localStorage.setItem(TPL_KEY, JSON.stringify(templates));
  } catch {
    /* storage unavailable; templates just won't persist */
  }
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `t${Date.now()}`;
}

/** The reusable fields a template captures — everything except the dates. */
function currentTemplateFields() {
  return {
    name: els.name.value,
    type: els.type.value,
    duration: els.duration.value,
    reason: els.reason.value,
    teamLead: els.lead.value,
    recipients: els.recipients.value,
  };
}

function renderTemplates() {
  const templates = loadTemplates();
  els.tplEmpty.hidden = templates.length > 0;
  els.tplList.innerHTML = "";
  for (const tpl of templates) {
    const item = document.createElement("div");
    item.className = "tpl-item";

    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "tpl-apply";
    apply.title = "Apply this template";

    const icon = document.createElement("span");
    icon.className = "tpl-icon";
    icon.innerHTML = BOOKMARK_ICON;

    const text = document.createElement("span");
    text.className = "tpl-text";
    const title = document.createElement("span");
    title.className = "tpl-title";
    title.textContent = tpl.title;
    const sub = document.createElement("span");
    sub.className = "tpl-sub";
    sub.textContent = templateSummary(tpl);
    text.append(title, sub);

    apply.append(icon, text);
    apply.addEventListener("click", () => applyTemplate(tpl));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "tpl-del";
    del.textContent = "×";
    del.title = "Delete";
    del.setAttribute("aria-label", `Delete template "${tpl.title}"`);
    del.addEventListener("click", () => deleteTemplate(tpl.id));

    item.append(apply, del);
    els.tplList.appendChild(item);
  }
}

/** Restore a template's fields, clear the dates, and let the body regenerate. */
function applyTemplate(tpl) {
  els.name.value = tpl.name ?? "";
  els.type.value = TYPES[tpl.type] ? tpl.type : "annual";
  els.duration.value = tpl.duration ?? "full";
  els.reason.value = tpl.reason ?? "";
  els.lead.value = tpl.teamLead ?? "";
  els.recipients.value = tpl.recipients ?? "";
  els.start.value = "";
  els.end.value = "";
  bodyDirty = false;
  stepsDone.email = stepsDone.event = false;
  saveName();
  render();
  els.start.focus();
  showToast(`Applied "${tpl.title}"`);
}

/** Delete with a toast Undo — a mis-click on the small × shouldn't lose a preset. */
function deleteTemplate(id) {
  const templates = loadTemplates();
  const index = templates.findIndex((tpl) => tpl.id === id);
  if (index === -1) return;
  const [removed] = templates.splice(index, 1);
  storeTemplates(templates);
  renderTemplates();
  showToast(`Deleted "${removed.title}"`, {
    label: "Undo",
    onAction: () => {
      const restored = loadTemplates();
      restored.splice(Math.min(index, restored.length), 0, removed);
      storeTemplates(restored);
      renderTemplates();
    },
  });
}

function openSaveForm() {
  els.tplSaveForm.hidden = false;
  els.tplSave.hidden = true;
  els.tplTitle.value = "";
  els.tplTitle.focus();
}

function closeSaveForm() {
  els.tplSaveForm.hidden = true;
  els.tplSave.hidden = false;
  els.tplTitle.value = "";
}

function saveTemplateFromForm(event) {
  event.preventDefault();
  const title = els.tplTitle.value.trim();
  if (title === "") {
    els.tplTitle.focus();
    return;
  }
  storeTemplates([...loadTemplates(), { id: newId(), title, ...currentTemplateFields() }]);
  renderTemplates();
  closeSaveForm();
  showToast("Template saved");
}

/* --------------------------- saved recipients ---------------------------- */
// One shared pool of previously-used addresses, offered as autocomplete in both
// email fields. Auto-saved when a request is actually used, or saved by hand.

/** localStorage key for the saved-recipient pool (a plain array of addresses). */
const RECIPIENTS_KEY = "meso-leave-recipients";

/** In-memory copy of the pool; the source of truth for the autocomplete. */
let recipients = loadRecipients();

function loadRecipients() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECIPIENTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((a) => typeof a === "string") : [];
  } catch {
    return [];
  }
}

function storeRecipients() {
  try {
    localStorage.setItem(RECIPIENTS_KEY, JSON.stringify(recipients));
  } catch {
    /* storage unavailable; the pool just won't persist */
  }
}

/** Remember every valid address in a field's value (used on send / manual save). */
function rememberRecipients(value) {
  const next = addRecipients(recipients, parseEmails(value));
  if (next.length !== recipients.length || next.some((a, i) => a !== recipients[i])) {
    recipients = next;
    storeRecipients();
  }
}

function forgetRecipient(address) {
  recipients = removeRecipient(recipients, address);
  storeRecipients();
}

/** Save a field's current addresses on demand; reports what happened. */
function manualSaveRecipients(field) {
  const before = recipients.length;
  const valid = parseEmails(field.value).filter((a) => isValidEmailList(a));
  if (valid.length === 0) {
    showToast("Enter a valid email address to save it");
    return;
  }
  rememberRecipients(field.value);
  const added = recipients.length - before;
  showToast(
    added === 0 ? "Already saved" : added === 1 ? "Recipient saved" : `${added} recipients saved`,
  );
}

// A single floating listbox, reused by both fields. Uses the shared
// .ac-menu / .ac-item styles. The id lets each field point at it with
// aria-controls / aria-activedescendant (the ARIA 1.2 combobox pattern).
const AC_MENU_ID = "recipient-ac";
const acMenu = document.createElement("div");
acMenu.className = "ac-menu";
acMenu.id = AC_MENU_ID;
acMenu.hidden = true;
acMenu.setAttribute("role", "listbox");
acMenu.setAttribute("aria-label", "Saved recipients");
document.body.appendChild(acMenu);

/** Field the menu is attached to (undefined = closed). */
let acField;
/** @type {string[]} */
let acItems = [];
let acIndex = 0;

const isAcOpen = () => !acMenu.hidden;

function closeAc() {
  acMenu.hidden = true;
  // Report the collapse on the field the menu belonged to, so a screen reader
  // isn't left believing a listbox is still open.
  if (acField) {
    acField.setAttribute("aria-expanded", "false");
    acField.removeAttribute("aria-activedescendant");
  }
  acField = undefined;
}

function renderAc() {
  acMenu.innerHTML = "";
  acItems.forEach((address, index) => {
    const item = document.createElement("div");
    item.className = "ac-item ac-item-recipient" + (index === acIndex ? " is-active" : "");
    item.id = `${AC_MENU_ID}-opt-${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === acIndex));

    const label = document.createElement("span");
    label.className = "ac-text";
    label.textContent = address;
    // mousedown (not click) so the field never blurs before we complete
    label.addEventListener("mousedown", (event) => {
      event.preventDefault();
      acceptAc(address);
    });

    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "ac-forget";
    forget.textContent = "×";
    forget.setAttribute("aria-label", `Forget ${address}`);
    forget.title = `Forget ${address}`;
    forget.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      forgetRecipient(address);
      openAcFor(acField); // re-filter; closes if nothing is left
    });

    item.append(label, forget);
    acMenu.appendChild(item);
  });
  // Keyboard focus stays in the input, so the active option is named rather than
  // focused — that's what aria-activedescendant is for.
  if (acField) acField.setAttribute("aria-activedescendant", `${AC_MENU_ID}-opt-${acIndex}`);
}

function positionAc(field) {
  const rect = field.getBoundingClientRect();
  acMenu.style.left = `${rect.left + globalThis.scrollX}px`;
  acMenu.style.top = `${rect.bottom + globalThis.scrollY + 4}px`;
  acMenu.style.minWidth = `${Math.min(rect.width, 320)}px`;
}

function openAcFor(field) {
  if (!field) return closeAc();
  const caret = field.selectionStart ?? field.value.length;
  acItems = filterRecipientSuggestions(recipients, field.value, caret);
  if (acItems.length === 0) return closeAc();
  acIndex = 0;
  acField = field;
  renderAc();
  positionAc(field);
  acMenu.hidden = false;
  field.setAttribute("aria-expanded", "true");
}

function acceptAc(address) {
  const field = acField;
  if (!field) return;
  const caret = field.selectionStart ?? field.value.length;
  const result = applyRecipientCompletion(field.value, caret, address);
  field.value = result.text;
  // type=email inputs don't support the selection API (setSelectionRange throws,
  // selectionStart is null); the caret lands at the end after assignment, which is
  // what we want when completing the trailing address.
  try {
    field.setSelectionRange(result.caret, result.caret);
  } catch {
    /* selection unsupported for this input type */
  }
  closeAc();
  field.focus();
  // notify the regular listeners (validation, previews)
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function onAcKeydown(event) {
  if (!isAcOpen() || event.target !== acField) return;
  if (event.key === "ArrowDown") {
    acIndex = (acIndex + 1) % acItems.length;
    renderAc();
    event.preventDefault();
  } else if (event.key === "ArrowUp") {
    acIndex = (acIndex - 1 + acItems.length) % acItems.length;
    renderAc();
    event.preventDefault();
  } else if (event.key === "Enter" || event.key === "Tab") {
    acceptAc(acItems[acIndex]);
    event.preventDefault();
  } else if (event.key === "Escape") {
    closeAc();
    event.preventDefault();
  }
}

/** Wire the recipient autocomplete onto one email field. */
function attachRecipientAutocomplete(field) {
  // ARIA 1.2 combobox: the input owns the popup and names the active option, so a
  // screen reader announces the suggestions the sighted user can see.
  field.setAttribute("role", "combobox");
  field.setAttribute("aria-controls", AC_MENU_ID);
  field.setAttribute("aria-haspopup", "listbox");
  field.setAttribute("aria-autocomplete", "list");
  field.setAttribute("aria-expanded", "false");
  field.addEventListener("input", () => openAcFor(field));
  field.addEventListener("focus", () => openAcFor(field));
  field.addEventListener("click", () => openAcFor(field));
  field.addEventListener("keydown", onAcKeydown);
  // Tabbing between the two fields fires this field's blur *after* the next field's
  // focus has already reopened the menu, so only close what is still ours.
  field.addEventListener("blur", () =>
    setTimeout(() => {
      if (acField === field) closeAc();
    }, 120));
}

globalThis.addEventListener("scroll", closeAc, true);
globalThis.addEventListener("resize", closeAc);

/* --------------------------------- wire ---------------------------------- */

/** A form edit describes a new request: clear the step progress, then re-render. */
function formChanged() {
  stepsDone.email = stepsDone.event = false;
  render();
}

for (const el of [els.name, els.reason, els.lead, els.recipients, els.start, els.end]) {
  el.addEventListener("input", formChanged);
}
for (const el of [els.type, els.duration]) el.addEventListener("change", formChanged);
els.name.addEventListener("input", saveName);

attachRecipientAutocomplete(els.lead);
attachRecipientAutocomplete(els.recipients);
els.leadSave.addEventListener("click", () => manualSaveRecipients(els.lead));
els.recipientsSave.addEventListener("click", () => manualSaveRecipients(els.recipients));

// Every read-only value doubles as a copy target — the toolbar buttons sit in the
// panel header, far from the value they copy, so clicking the value itself is the
// shorter path. `data-copy` names it in the toast.
for (const out of document.querySelectorAll("button.out")) {
  out.addEventListener("click", () => {
    const text = out.textContent.trim();
    // "—" is the placeholder the previews show while the form is incomplete.
    if (text === "" || text === "—") {
      showToast("Nothing to copy yet");
      return;
    }
    copy(text, /** @type {HTMLElement} */ (out).dataset.copy ?? "Value");
  });
}

els.emailBody.addEventListener("input", onBodyEdited);
els.bodyReset.addEventListener("click", resetBody);
els.openMail.addEventListener("click", openMail);
els.openOutlook.addEventListener("click", openOutlookWeb);
els.copySubject.addEventListener("click", () => copy(current?.email.subject, "Subject"));
els.copyBody.addEventListener("click", () => copy(els.emailBody.value, "Body"));
els.addEventOutlook.addEventListener("click", addEventToOutlook);
els.saveAvailability.addEventListener("click", saveToAvailability);
els.copyEventSubject.addEventListener("click", () => copy(current?.event.subject, "Event subject"));
els.copyRecipients.addEventListener(
  "click",
  () => copy(current?.event.recipients, "Recipients"),
);
els.tplSave.addEventListener("click", openSaveForm);
els.tplSaveCancel.addEventListener("click", closeSaveForm);
els.tplSaveForm.addEventListener("submit", saveTemplateFromForm);

/**
 * Palette commands stay listed even when their buttons are disabled, so they check
 * the same flag — and say why nothing happened instead of failing silently.
 * @param {keyof typeof actionsEnabled} group
 * @param {() => void} run
 */
function guarded(group, run) {
  return () => {
    if (!actionsEnabled[group]) {
      showToast(els.formStatus.textContent || "Not available yet");
      return;
    }
    run();
  };
}

registerCommands([
  {
    icon: "✉️",
    title: "Open HR email in mail app",
    hint: "action",
    run: guarded("emailSend", openMail),
  },
  {
    icon: "🌐",
    title: "Open HR email in Outlook (web)",
    hint: "action",
    keywords: ["outlook", "owa", "office"],
    run: guarded("emailSend", openOutlookWeb),
  },
  {
    icon: "📋",
    title: "Copy HR email body",
    hint: "action",
    run: guarded("emailCopy", () => copy(els.emailBody.value, "Body")),
  },
  {
    icon: "📅",
    title: "Copy Outlook event subject",
    hint: "action",
    keywords: ["calendar", "event"],
    run: guarded("eventCopy", () => copy(current?.event.subject, "Event subject")),
  },
  {
    icon: TOOL_ICONS.availability,
    title: "Save these days to Team Availability",
    hint: "action",
    keywords: ["grid", "heatmap", "roster", "availability"],
    run: saveToAvailability,
  },
  {
    icon: "🗓️",
    title: "Add leave event to Outlook (web)",
    hint: "action",
    keywords: ["calendar", "event", "outlook", "owa"],
    run: guarded("eventSend", addEventToOutlook),
  },
]);

// Restore the remembered name (see saveName) before the first render.
try {
  const savedName = localStorage.getItem(NAME_KEY);
  if (savedName) els.name.value = savedName;
} catch {
  /* storage unavailable; start with an empty name */
}
// Default the start date to the next working day (today, when today is one) so the
// tool shows live output as soon as a name is present — without opening on a
// weekend warning nobody asked for. (Browser-only convenience; the pure module
// stays date-free.) Built from local date parts — toISOString() is UTC, which is
// yesterday's date during the early morning in timezones ahead of UTC (e.g. before
// 7am in UTC+7).
const today = new Date();
els.start.value = nextWorkingDay([
  today.getFullYear(),
  String(today.getMonth() + 1).padStart(2, "0"),
  String(today.getDate()).padStart(2, "0"),
].join("-"));

/**
 * Take the days picked in Team Availability's grid: name, dates and the leave
 * type its day code implied. A remembered name is not overwritten by an empty
 * one, so a handoff that could not name the person leaves yours in place.
 */
function receiveHandoff() {
  const handoff = takeHandoff(sessionStorage, "leave");
  if (!handoff) return false;
  const fields = parseLeaveHandoff(handoff.text);
  if (fields === null) return false;
  if (fields.name !== "") {
    els.name.value = fields.name;
    saveName();
  }
  els.type.value = fields.type;
  els.duration.value = fields.duration;
  els.start.value = fields.startDate;
  els.end.value = fields.endDate;
  render();
  showToast(`Dates received from ${handoff.from || "another tool"}`);
  return true;
}

// Re-check on back/forward-cache restores too: Send to → Back → Send to again
// revives this page without re-running the script.
globalThis.addEventListener("pageshow", (event) => {
  if (event.persisted) receiveHandoff();
});

render();
renderTemplates();
if (!receiveHandoff()) els.name.focus();

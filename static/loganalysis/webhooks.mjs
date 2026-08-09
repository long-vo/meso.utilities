// @ts-check
/**
 * meso.utilities — Log Analysis: inbound notifications and webhooks folded into
 * events, so the Flow view can draw the messages a system *receives* and not only
 * the REST calls it makes.
 *
 * Whole integrations leave no `Invoking REST service` line at all. The
 * onboarding flow is one of them: sealID pushes a status to `baloise-id`, which
 * forwards it as a webhook to `balboa-bank-sob`, and every hop is an *inbound*
 * message logged by its receiver. To a REST-only reader that log is empty, when
 * in fact it is the whole story — including the status lifecycle (SCHEDULED →
 * INITIALIZED → VERIFICATION_PENDING → VERIFICATION_CONFIRMED → SIGNED →
 * DOWNLOADED) that no other view surfaces.
 *
 * Two shapes are folded, and the difference between them matters:
 *
 * 1. **Webhooks**, which pair. `Received webhook notification …` opens and
 *    `Handled webhook notification …` closes, matched on the `notificationId`
 *    both carry — *not* on thread order, because these overlap: one webhook was
 *    received at 10:13:46 and handled at 10:13:59, with another received and
 *    handled inside that window. The gap between the two is real handling time
 *    worth showing, and a `Received` with no `Handled` is a notification that was
 *    dropped on the floor — the same finding as a REST call nothing answered.
 * 2. **Notifications**, which don't. `Received notification: class …` and
 *    `Notification received. Ignore notification with status=…` are single
 *    records with nothing to pair against. They are events, not calls, and are
 *    marked as such so the diagram does not imply a response that was never due.
 *
 * The sender is named where the log names it and left blank where it does not.
 * A webhook's class *is* its sender by this codebase's convention —
 * `BaloiseIdNotificationRequest` comes from `baloise-id`, and the two spellings
 * meet in the Flow view's lane key. The upstream pushing into `baloise-id` is
 * never identified in these logs, so `from` stays empty rather than inventing a
 * system: the diagram draws those as arriving from one `inbound` lane.
 *
 * "Ignored" is deliberately *not* treated as a failure. `Ignore notification with
 * status=OUTSTANDING` is routine filtering — a receiver skipping a status it does
 * not act on — and colouring six of those red would make a healthy log look like
 * an incident. It is annotated instead; only an unhandled webhook reads as a
 * problem.
 *
 * Dual-consumption: imported unchanged by `static/loganalysis/app.js` and by
 * `src/webhooks.test.ts`.
 */

import { formatMs, recordSummary, recordText } from "./loganalysis.mjs";

/** `Received webhook notification. notification = class BaloiseIdNotificationRequest {` */
const WEBHOOK_IN_RE = /^Received webhook notification\.\s*notification\s*=\s*class\s+(\w+)/;
/** Its closing line, carrying the same `notificationId` in the body below. */
const WEBHOOK_DONE_RE = /^Handled webhook notification\.\s*notification\s*=\s*class\s+(\w+)/;
/** `Ignored processing notification due to unexpected identification status. …` */
const WEBHOOK_SKIPPED_RE = /^Ignored processing notification\b/;
/** `Received notification: class IdentificationNotificationRequest {` */
const NOTIFY_IN_RE = /^Received notification:\s*class\s+(\w+)/;
/** `Notification received. Ignore notification with status=OUTSTANDING and data={…}` */
const NOTIFY_SKIPPED_RE = /^Notification received\.\s*Ignore notification with status=(\w+)/;

/**
 * Fields read out of the record body. Each tolerates the three spellings these
 * logs mix — a pretty-printed Java dump (`notificationId: 7ff9…`), JSON
 * (`"status":"SIGNED"`) and a `toString` (`status=VERIFICATION_PENDING`) — which
 * is why the optional quote sits before the separator as well as after.
 */
const NOTIFICATION_ID_RE = /\bnotificationId"?\s*[:=]\s*"?([A-Za-z0-9._-]+)/;
const NOTIFICATION_TYPE_RE = /\bnotificationType"?\s*[:=]\s*"?([A-Za-z0-9_]+)/;
/**
 * The business status.
 *
 * Lower-case `status` with a word boundary on purpose: it must not match inside
 * `qTSPstatus` (no boundary between `P` and `s`) nor inside `documentBasketStatus`,
 * `signingStatus` or `identificationFilesStatus` (capital `S`), all of which sit
 * in the same payload and mean something else.
 */
const STATUS_RE = /\bstatus"?\s*[:=]\s*"?([A-Z][A-Z_]*)/;
/** A signing notification carries no bare `status`; this is its equivalent. */
const BASKET_STATUS_RE = /\bdocumentBasketStatus"?\s*[:=]\s*"?([A-Z][A-Z_]*)/;

/**
 * @typedef {Object} WebhookEvent
 * @property {number} id
 * @property {"webhook" | "notification"} kind webhooks pair, notifications don't
 * @property {string} from the sending system, `""` when the log never names it
 * @property {string} to the application that received it
 * @property {string} label the notification type, falling back to its class
 * @property {string} status the business status carried, `""` if none was found
 * @property {number | null} ms handling time, when a closing line paired
 * @property {number | null} endTs when handling finished, in ms
 * @property {string} endTsText the closing line's timestamp, as the log wrote it
 * @property {boolean} handled a closing line was found (webhooks only)
 * @property {boolean} skipped the receiver said it was ignoring this one
 * @property {string} result what the diagram prints beneath the arrow
 * @property {string} tsText when it arrived
 * @property {string} notificationId the pairing key, `""` when absent
 * @property {number[]} records indices of the records making up the event
 */

/**
 * The system a notification class comes from: `BaloiseIdNotificationRequest` →
 * `BaloiseId`, which the Flow view's lane key folds together with the
 * `baloise-id` application lane.
 * @param {string} name
 * @returns {string}
 */
export function senderFromClass(name) {
  const base = String(name ?? "").replace(/(?:Notification)?Request$/, "").replace(
    /Notification$/,
    "",
  );
  return base || String(name ?? "");
}

/**
 * The business status a record carries, preferring the bare `status` and falling
 * back to a signing notification's basket status.
 * @param {string} text
 * @returns {string}
 */
export function statusOf(text) {
  return STATUS_RE.exec(text)?.[1] ?? BASKET_STATUS_RE.exec(text)?.[1] ?? "";
}

/**
 * What the diagram prints under a webhook's arrow: the status it carried, whether
 * it was ignored, and how long the receiver took over it.
 * @param {WebhookEvent} event
 * @returns {string}
 */
function resultOf(event) {
  const parts = [event.status || "received"];
  if (event.skipped) parts.push("ignored");
  // Only a webhook is owed a closing line, so only a webhook can be missing one.
  if (event.kind === "webhook" && !event.handled) parts.push("not handled");
  else if (event.ms !== null) parts.push(formatMs(event.ms));
  return parts.join(" · ");
}

/**
 * Fold the inbound notifications and webhooks in a merged record set into events.
 *
 * `record.webhook` is set as a side effect — the same trick {@link foldRestSpans}
 * uses with `record.span`, and what lets picking a step in the diagram filter the
 * timeline down to the records behind it.
 * @param {import("./loganalysis.mjs").LogRecord[]} records the merged set
 * @returns {WebhookEvent[]}
 */
export function foldWebhooks(records) {
  /** @type {WebhookEvent[]} */
  const events = [];
  /** Open webhooks by notificationId — they overlap, so thread order won't do. */
  /** @type {Map<string, number>} */
  const open = new Map();
  /** The last webhook opened per file and thread, for the skip line between. */
  /** @type {Map<string, number>} */
  const lastOnLane = new Map();
  /** @type {Map<number, number | null>} */
  const openedAt = new Map();

  for (const record of records) {
    const first = recordSummary(record, 400);
    const lane = `${record.file}\0${record.thread}`;

    const done = WEBHOOK_DONE_RE.exec(first);
    if (done) {
      const id = NOTIFICATION_ID_RE.exec(recordText(record))?.[1] ?? "";
      const at = id ? open.get(id) : undefined;
      if (at !== undefined) {
        const event = events[at];
        event.handled = true;
        const from = openedAt.get(at);
        if (from !== null && from !== undefined && record.ts !== null) {
          event.ms = record.ts - from;
        }
        event.endTs = record.ts;
        event.endTsText = record.tsText;
        event.records.push(record.i);
        event.result = resultOf(event);
        record.webhook = at;
        open.delete(id);
      }
      continue;
    }

    if (WEBHOOK_SKIPPED_RE.test(first)) {
      const at = lastOnLane.get(lane);
      if (at !== undefined) {
        events[at].skipped = true;
        events[at].records.push(record.i);
        events[at].result = resultOf(events[at]);
        record.webhook = at;
      }
      continue;
    }

    const inbound = WEBHOOK_IN_RE.exec(first);
    const notify = inbound ? null : NOTIFY_IN_RE.exec(first);
    const skipped = inbound || notify ? null : NOTIFY_SKIPPED_RE.exec(first);
    if (!inbound && !notify && !skipped) continue;

    const text = recordText(record);
    const cls = inbound?.[1] ?? notify?.[1] ?? "";
    /** @type {WebhookEvent} */
    const event = {
      id: events.length,
      kind: inbound ? "webhook" : "notification",
      // Only a webhook's class names its sender; a notification's names the
      // message, and the upstream that sent it is nowhere in the log.
      from: inbound ? senderFromClass(cls) : "",
      to: record.app || record.file || "unknown",
      label: NOTIFICATION_TYPE_RE.exec(text)?.[1] ?? cls ?? "notification",
      status: skipped ? skipped[1] : statusOf(text),
      ms: null,
      endTs: null,
      endTsText: "",
      handled: false,
      skipped: Boolean(skipped),
      result: "",
      tsText: record.tsText,
      notificationId: NOTIFICATION_ID_RE.exec(text)?.[1] ?? "",
      records: [record.i],
    };
    if (!event.label) event.label = "notification";
    event.result = resultOf(event);
    events.push(event);
    record.webhook = event.id;
    if (event.kind === "webhook") {
      openedAt.set(event.id, record.ts);
      lastOnLane.set(lane, event.id);
      if (event.notificationId) open.set(event.notificationId, event.id);
    }
  }
  return events;
}

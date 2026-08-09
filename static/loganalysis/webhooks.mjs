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
 * A queue hop, which pairs like a webhook but over a broker rather than a call.
 *
 *   [PGMQ] - Published AMLA PGMQEvent: eventId=cc2f…, eventType=DOSSIER, eventAction=SAVE
 *   [PGMQ] - Received PGMQEvent and sent to queue: eventId=cc2f…
 *
 * Some services make no REST calls at all and talk entirely this way; without
 * these their Flow diagram is empty while the log is full of traffic. The gap
 * between the two lines is real queue latency, and a publish with no matching
 * receive is an event nobody picked up — the same finding as an unhandled webhook,
 * and the reason this pairs rather than standing as a single event.
 */
const QUEUE_OUT_RE = /^\[PGMQ\]\s*-?\s*Published\b.*?\bPGMQEvent\b/;
const QUEUE_IN_RE = /^\[PGMQ\]\s*-?\s*Received\b.*?\bPGMQEvent\b/;
const EVENT_ID_RE = /\beventId"?\s*[:=]\s*"?([A-Za-z0-9._-]+)/;
const EVENT_TYPE_RE = /\beventType"?\s*[:=]\s*"?([A-Za-z0-9_]+)/;
const EVENT_ACTION_RE = /\beventAction"?\s*[:=]\s*"?([A-Za-z0-9_]+)/;

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
 * What kind of notification a payload is, for the one shape that never says.
 *
 * `Notification received. Ignore notification with status=…` writes neither a
 * `notificationType` nor a `class` name, so those events used to fall back to the
 * literal word "notification" — three arrows in a row wearing a label that names
 * nothing. The payload does tell you, by the same split {@link BASKET_STATUS_RE}
 * already leans on: a signing notification names a document basket and an
 * identification one names an identity profile, and neither ever carries the
 * other's field.
 */
const BASKET_SHAPE_RE = /\bdocumentBasket(?:Id|Status)"?\s*[:=]/;
const IDENTIFICATION_SHAPE_RE = /\b(?:identityProfile|ubiIdCategory)"?\s*[:=]/;

/**
 * @typedef {Object} WebhookEvent
 * @property {number} id
 * @property {"webhook" | "notification" | "queue"} kind webhooks and queue hops
 *   pair, notifications don't
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
 * The kind of notification a payload describes, when nothing in the record names
 * it — `""` when the shape says nothing either.
 *
 * Lower case and spaced, deliberately unlike the `SIGNING_STATUS` a webhook's own
 * `notificationType` field supplies. The two sit on adjacent arrows in the Flow
 * diagram and describe the same stream, so they should read alike; but this one
 * was inferred from the payload's shape and that one was quoted from the log, and
 * styling them identically would hide the difference.
 * @param {string} text
 * @returns {string}
 */
export function labelFromShape(text) {
  if (BASKET_SHAPE_RE.test(text)) return "signing status";
  if (IDENTIFICATION_SHAPE_RE.test(text)) return "identification status";
  return "";
}

/**
 * What the diagram prints under a webhook's arrow: the status it carried, whether
 * it was ignored, and how long the receiver took over it.
 * @param {WebhookEvent} event
 * @returns {string}
 */
function resultOf(event) {
  const queue = event.kind === "queue";
  // A queue event carries no status of its own; that it went out is the news.
  const parts = [event.status || (queue ? "published" : "received")];
  if (event.skipped) parts.push("ignored");
  // Only a message someone was due to pick up can be left lying there: a
  // notification is owed nothing, so it can never be missing anything.
  if (event.kind !== "notification" && !event.handled) {
    parts.push(queue ? "not consumed" : "not handled");
  } else if (event.ms !== null) parts.push(formatMs(event.ms));
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
  /**
   * Published events awaiting a consumer, by `eventId`. Kept apart from `open`
   * rather than sharing it: the two id spaces mean different things, and a
   * `Handled webhook notification` must never close a queue event.
   */
  /** @type {Map<string, number>} */
  const queued = new Map();

  for (const record of records) {
    const first = recordSummary(record, 400);
    const lane = `${record.file}\0${record.thread}`;

    if (QUEUE_IN_RE.test(first)) {
      const id = EVENT_ID_RE.exec(recordText(record))?.[1] ?? "";
      const at = id ? queued.get(id) : undefined;
      if (at !== undefined) {
        const event = events[at];
        event.handled = true;
        // The consumer names itself, and it need not be the publisher — this hop
        // goes through a broker, so the other end is whoever picked the event up.
        event.to = record.app || record.file || event.to;
        const from = openedAt.get(at);
        if (from !== null && from !== undefined && record.ts !== null) {
          event.ms = record.ts - from;
        }
        event.endTs = record.ts;
        event.endTsText = record.tsText;
        event.records.push(record.i);
        event.result = resultOf(event);
        record.webhook = at;
        queued.delete(id);
      }
      continue;
    }

    if (QUEUE_OUT_RE.test(first)) {
      const text = recordText(record);
      const publisher = record.app || record.file || "unknown";
      const type = EVENT_TYPE_RE.exec(text)?.[1] ?? "";
      const action = EVENT_ACTION_RE.exec(text)?.[1] ?? "";
      /** @type {WebhookEvent} */
      const event = {
        id: events.length,
        kind: "queue",
        from: publisher,
        // Until a consumer picks it up the publisher is the only end named, which
        // draws as a self-loop and reads right: an event that went out and came
        // back to nobody else.
        to: publisher,
        label: [type, action].filter(Boolean).join(" ") || "PGMQEvent",
        status: "",
        ms: null,
        endTs: null,
        endTsText: "",
        handled: false,
        skipped: false,
        result: "",
        tsText: record.tsText,
        notificationId: EVENT_ID_RE.exec(text)?.[1] ?? "",
        records: [record.i],
      };
      event.result = resultOf(event);
      events.push(event);
      record.webhook = event.id;
      openedAt.set(event.id, record.ts);
      if (event.notificationId) queued.set(event.notificationId, event.id);
      continue;
    }

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
    if (!event.label) event.label = labelFromShape(text) || "notification";
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

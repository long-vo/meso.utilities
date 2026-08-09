/**
 * Tests for folding inbound notifications and webhooks into events. Run with
 * `deno task test`.
 *
 * The fixture is trimmed from the real BAL-9685 logs (already censored at source,
 * which is itself part of what is being tested — `tenantIdCensored` and the `XX`
 * substitutions have to survive parsing). It carries the two hops the onboarding
 * flow actually has: an upstream pushing statuses into `baloise-id`, and
 * `baloise-id` forwarding them as webhooks to `balboa-bank-sob`.
 *
 * The cases that matter are the ones a naive reader gets wrong: webhooks overlap
 * in time so they cannot pair by thread order, a `status` must not be read out of
 * `qTSPstatus` or `documentBasketStatus`, and a signing notification has no bare
 * `status` at all.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { analyse } from "../static/loganalysis/loganalysis.mjs";
import {
  foldWebhooks,
  labelFromShape,
  senderFromClass,
  statusOf,
} from "../static/loganalysis/webhooks.mjs";

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

const DOSSIER = "5dad36c5-15ae-4a36-8c62-b88ff8c549bd";
const PERSON = "95874504-d908-4b2a-9c41-d3eeba4654f9";
const CASE = "8df4aa9e-d4b6-449b-b620-3284ec1d3342";

/** An Ivy header for one of the two applications in this flow. */
function head(ts: string, app: string, thread: string, requestId: string): string {
  return `[${ts}][INFO ][runtimelog.${app}.${app}-api.user_code][${thread}]` +
    `{application=${app}, executionContext=SYSTEM, requestId=${requestId}, session=0 SYSTEM}`;
}

const LOG = [
  // 1. An inbound notification baloise-id ignores — routine status filtering.
  head("2026-05-15 10:07:37.232", "baloise-id", "http-nio-8080-exec-1", "1468656"),
  `Notification received. Ignore notification with status=OUTSTANDING and data=` +
  `{"id":"68d95fdc-fc5d-4bef-9475-76e6231c00b0","tenantId":"tenantIdCensored",` +
  `"extCaseId":"${DOSSIER}","extApplication":"SELF_ONBOARDING",` +
  `"documentBasketId":"affectedDocumentBasketBAL-9685","documentBasketStatus":"OUTSTANDING",` +
  `"signers":[{"extPersonId":"${PERSON}","signingStatus":"OUTSTANDING"}]}`,

  // 2. One it accepts. Note qTSPstatus, which must not be read as the status.
  head("2026-05-15 10:09:53.135", "baloise-id", "http-nio-8080-exec-4", "1469317"),
  "Received notification: class IdentificationNotificationRequest {",
  "    id: 2719dc64-cbdf-4390-a5e1-817b8d4dfb86",
  "    tenantId:tenantCENSORED",
  `    extPersonId: ${PERSON}`,
  `    extCaseId: ${DOSSIER}`,
  "    status: VERIFICATION_PENDING",
  "    qTSPstatus: NO_REGISTRATION",
  "}",

  // 3. baloise-id forwards it; balboa-bank-sob receives, skips and handles it.
  head("2026-05-15 10:09:53.167", "balboa-bank-sob", "http-nio-8080-exec-32", "3134561"),
  "Received webhook notification. notification = class BaloiseIdNotificationRequest {",
  "    notificationId: 7ff9ee0c-5f99-45eb-b893-57ccb8d13c0a",
  "    notificationType: IDENTIFICATION_STATUS",
  `    notificationData: {"ubiIdCaseId":"${CASE}","extCaseId":"${DOSSIER}",` +
  `"status":"VERIFICATION_PENDING","qTSPstatus":"NO_REGISTRATION"}`,
  "}",
  head("2026-05-15 10:09:53.168", "balboa-bank-sob", "http-nio-8080-exec-32", "3134561"),
  `Ignored processing notification due to unexpected identification status. ` +
  `IdentificationNotificationRequest(ubiIdCaseId=${CASE}, extCaseId=${DOSSIER}, ` +
  `status=VERIFICATION_PENDING).`,
  head("2026-05-15 10:09:53.400", "balboa-bank-sob", "http-nio-8080-exec-32", "3134561"),
  "Handled webhook notification. notification = class BaloiseIdNotificationRequest {",
  "    notificationId: 7ff9ee0c-5f99-45eb-b893-57ccb8d13c0a",
  "    notificationType: IDENTIFICATION_STATUS",
  `    notificationData: {"extCaseId":"${DOSSIER}","status":"VERIFICATION_PENDING"}`,
  "}",

  // 4. A webhook received on one thread and handled 13 s later, with another
  //    received *and* handled inside that window — so thread order cannot pair.
  head("2026-05-15 10:13:46.506", "balboa-bank-sob", "http-nio-8080-exec-36", "3135086"),
  "Received webhook notification. notification = class BaloiseIdNotificationRequest {",
  "    notificationId: ebc8cab2-a7fc-40e1-b5c6-9555abf3a315",
  "    notificationType: IDENTIFICATION_STATUS",
  `    notificationData: {"extCaseId":"${DOSSIER}","status":"VERIFICATION_CONFIRMED"}`,
  "}",
  head("2026-05-15 10:13:59.205", "balboa-bank-sob", "http-nio-8080-exec-32", "3135113"),
  "Received webhook notification. notification = class BaloiseIdNotificationRequest {",
  "    notificationId: 42f149b7-ab1a-4a11-99e7-1815a8c5494d",
  "    notificationType: SIGNING_STATUS",
  `    notificationData: {"extCaseId":"${DOSSIER}","documentBasketStatus":"SIGNED"}`,
  "}",
  head("2026-05-15 10:13:59.559", "balboa-bank-sob", "http-nio-8080-exec-36", "3135086"),
  "Handled webhook notification. notification = class BaloiseIdNotificationRequest {",
  "    notificationId: ebc8cab2-a7fc-40e1-b5c6-9555abf3a315",
  "    notificationType: IDENTIFICATION_STATUS",
  `    notificationData: {"extCaseId":"${DOSSIER}","status":"VERIFICATION_CONFIRMED"}`,
  "}",

  // 5. A signing notification with no bare `status` — only documentBasketStatus.
  head("2026-05-15 10:13:59.173", "baloise-id", "http-nio-8080-exec-2", "1470492"),
  "Received notification: class SigningNotificationRequest {",
  "    id: 0892db07-8d0c-4888-903e-3cecd7bb7adc",
  `    extCaseId: ${DOSSIER}`,
  "    documentBasketId: affectedDocumentBasketBAL-9685",
  "    documentBasketStatus: SIGNED",
  "    signers: [class SignersRequest {",
  `        extPersonId: ${PERSON}`,
  "        signingStatus: SIGNED",
  "    }]",
  "}",
].join("\n");

const model = analyse([{ file: "bal-9685.log", text: LOG }]);
const events = foldWebhooks(model.records);

/** A Spring Boot header for the e-portal, whose pattern does name its app. */
function pgHead(ts: string, app: string, logger: string): string {
  return `${ts} [-][-][7082617] INFO 7 --- [${app}] [ble-scheduler-1] ${logger} : `;
}

const PUBLISHER = "i.m.b.e.a.a.services.PGMQEventPublisher";
const CONSUMER = "i.m.b.e.a.w.services.PGMQEventConsumer";
const EVENT = "cc2f7856-65ae-48cf-b87e-3ef0e862bcd1";
const LOST = "da683eb5-4a4c-4e34-8b74-efba1b89afd1";
const CROSS = "add9f5ba-d930-45cc-a39b-440fc8e27a5a";

/**
 * A queue hop, three ways: one published and consumed, one published and never
 * picked up, and one consumed by a *different* service — which is the case that
 * makes the far end worth reading off the closing record rather than assuming it.
 */
const QUEUE_LOG = [
  pgHead("2026-07-01T10:20:01.828Z", "baloise-e-portal-api", PUBLISHER) +
  `[PGMQ] - Published AMLA PGMQEvent: eventId=${EVENT}, eventType=DOSSIER, eventAction=SAVE`,
  pgHead("2026-07-01T10:20:01.952Z", "baloise-e-portal-api", CONSUMER) +
  `[PGMQ] - Received PGMQEvent and sent to queue: eventId=${EVENT}`,
  pgHead("2026-07-01T10:20:04.174Z", "baloise-e-portal-api", PUBLISHER) +
  `[PGMQ] - Published AMLA PGMQEvent: eventId=${LOST}, eventType=TASK, eventAction=SAVE`,
  pgHead("2026-07-01T10:20:05.000Z", "baloise-e-portal-api", PUBLISHER) +
  `[PGMQ] - Published AMLA PGMQEvent: eventId=${CROSS}, eventType=DOSSIER, eventAction=DELETE`,
  pgHead("2026-07-01T10:20:05.400Z", "baloise-e-portal-worker", CONSUMER) +
  `[PGMQ] - Received PGMQEvent and sent to queue: eventId=${CROSS}`,
].join("\n");

const queueModel = analyse([{ file: "eportal.log", text: QUEUE_LOG }]);
const queueEvents = foldWebhooks(queueModel.records);

Deno.test("foldWebhooks: a published event pairs with the consumer that took it", () => {
  assertEquals(queueEvents.length, 3);
  const [taken] = queueEvents;
  assertEquals(taken.kind, "queue");
  assertEquals(taken.from, "baloise-e-portal-api");
  assertEquals(taken.to, "baloise-e-portal-api");
  // The event's own type and action, which is what it *is* — nothing else in the
  // line names it.
  assertEquals(taken.label, "DOSSIER SAVE");
  assertEquals(taken.handled, true);
  assertEquals(taken.notificationId, EVENT);
  // 10:20:01.828 → .952 is real queue latency, and the only place it is written.
  assertEquals(taken.ms, 124);
  assertEquals(taken.result, "published · 124 ms");
  assertEquals(taken.records.length, 2);
});

Deno.test("foldWebhooks: an event nobody consumed says so", () => {
  const lost = queueEvents.find((event) => event.notificationId === LOST)!;
  assert(lost !== undefined, "the unconsumed publish was still folded");
  assertEquals(lost.handled, false);
  assertEquals(lost.ms, null);
  assertEquals(lost.label, "TASK SAVE");
  assertEquals(lost.result, "published · not consumed");
  // With no consumer named, both ends are the publisher — which draws as the
  // self-loop the diagram already knows how to render.
  assertEquals(lost.from, lost.to);
});

Deno.test("foldWebhooks: the consumer names the far end, publisher or not", () => {
  const crossed = queueEvents.find((event) => event.notificationId === CROSS)!;
  assertEquals(crossed.from, "baloise-e-portal-api");
  assertEquals(crossed.to, "baloise-e-portal-worker", "a broker hop can cross services");
  assertEquals(crossed.label, "DOSSIER DELETE");
  assertEquals(crossed.ms, 400);
});

Deno.test("foldWebhooks: a queue event never closes a webhook, or the reverse", () => {
  // Both pair on an id out of the payload, and the two id spaces are unrelated;
  // sharing one map would let a `Handled webhook notification` consume an event.
  for (const event of queueEvents) assertEquals(event.kind, "queue");
  for (const event of events) assert(event.kind !== "queue", "no webhook folded as a queue hop");
});

/* ------------------------------ folding ------------------------------ */

Deno.test("foldWebhooks: finds every inbound message, in log order", () => {
  assertEquals(events.length, 6);
  assertEquals(
    events.map((event) => `${event.kind}:${event.to}`),
    [
      "notification:baloise-id",
      "notification:baloise-id",
      "webhook:balboa-bank-sob",
      "webhook:balboa-bank-sob",
      "notification:baloise-id",
      "webhook:balboa-bank-sob",
    ],
  );
});

Deno.test("foldWebhooks: a webhook's class names its sender, a notification's does not", () => {
  const webhooks = events.filter((event) => event.kind === "webhook");
  assert(webhooks.every((event) => event.from === "BaloiseId"), "the sender came off the class");
  const notifications = events.filter((event) => event.kind === "notification");
  assert(
    notifications.every((event) => event.from === ""),
    "the upstream is nowhere in the log, so it is left blank rather than invented",
  );
});

Deno.test("foldWebhooks: webhooks pair on notificationId, not on thread order", () => {
  // ebc8cab2 was received at 10:13:46.506 and handled at 10:13:59.559; 42f149b7
  // was received at 10:13:59.205, inside that window. Pairing by "the last open
  // webhook" would hand ebc8cab2's closing line to 42f149b7.
  const confirmed = events.find((event) =>
    event.label === "IDENTIFICATION_STATUS" &&
    event.status === "VERIFICATION_CONFIRMED"
  )!;
  assert(confirmed !== undefined, "the overlapping webhook is there");
  assertEquals(confirmed.handled, true);
  assertEquals(confirmed.ms, 13_053, "13.05 s of handling time, not the inner webhook's");
  const signing = events.find((event) => event.label === "SIGNING_STATUS")!;
  assertEquals(signing.handled, false, "the inner one was never closed in this fixture");
  assertEquals(signing.ms, null);
});

Deno.test("foldWebhooks: a handled webhook records when it finished, not just how long", () => {
  // The duration alone cannot place the finish among the other events; the
  // activation bar in the Flow view needs the absolute moment.
  const confirmed = events.find((event) => event.status === "VERIFICATION_CONFIRMED")!;
  assertEquals(confirmed.tsText, "2026-05-15 10:13:46.506");
  assertEquals(confirmed.endTsText, "2026-05-15 10:13:59.559");
  // The absolute finish and the duration have to tell the same story.
  const opened = model.records[confirmed.records[0]].ts!;
  assertEquals(confirmed.endTs! - opened, confirmed.ms);
});

Deno.test("foldWebhooks: nothing unfinished claims a finish time", () => {
  for (const event of events) {
    if (event.kind === "webhook" && event.handled) continue;
    assertEquals(event.endTs, null, `${event.label} was never handled`);
    assertEquals(event.endTsText, "");
  }
});

Deno.test("foldWebhooks: an unhandled webhook says so; a notification is never owed one", () => {
  const signing = events.find((event) => event.label === "SIGNING_STATUS")!;
  assert(signing.result.includes("not handled"), `got "${signing.result}"`);
  for (const event of events.filter((e) => e.kind === "notification")) {
    assert(
      !event.result.includes("not handled"),
      "a notification pairs with nothing, so it cannot be missing a pair",
    );
  }
});

Deno.test("foldWebhooks: an ignored message is annotated, not marked failed", () => {
  const skipped = events.filter((event) => event.skipped);
  assertEquals(skipped.length, 2, "the OUTSTANDING notification and the skipped webhook");
  for (const event of skipped) {
    assert(event.result.includes("ignored"), `got "${event.result}"`);
  }
  // The skipped webhook was still handled — ignoring is what handling it meant.
  const webhook = skipped.find((event) => event.kind === "webhook")!;
  assertEquals(webhook.handled, true);
  assertEquals(webhook.result, "VERIFICATION_PENDING · ignored · 233 ms");
});

Deno.test("foldWebhooks: the status comes from `status`, never from a longer key", () => {
  // qTSPstatus (no word boundary before `status`) and documentBasketStatus /
  // signingStatus (capital S) all sit in the same payloads.
  const pending = events.find((event) => event.label === "IdentificationNotificationRequest")!;
  assertEquals(pending.status, "VERIFICATION_PENDING", "not NO_REGISTRATION");
  const outstanding = events[0];
  assertEquals(outstanding.status, "OUTSTANDING");
});

Deno.test("foldWebhooks: a signing notification falls back to documentBasketStatus", () => {
  const signing = events.find((event) => event.label === "SigningNotificationRequest")!;
  assert(signing !== undefined, "the signing notification was folded");
  assertEquals(signing.status, "SIGNED", "there is no bare `status` in that payload");
});

Deno.test("labelFromShape: the payload names the kind when the record does not", () => {
  assertEquals(labelFromShape('{"documentBasketId":"x","signers":[]}'), "signing status");
  assertEquals(labelFromShape('{"documentBasketStatus":"SIGNED"}'), "signing status");
  assertEquals(labelFromShape("    identityProfile: 2"), "identification status");
  assertEquals(labelFromShape('{"ubiIdCategory":null}'), "identification status");
  // Nothing to go on is answered with nothing, not with a guess.
  assertEquals(labelFromShape('{"extCaseId":"x"}'), "");
});

Deno.test("foldWebhooks: an unnamed notification is labelled from its payload", () => {
  // `Notification received. Ignore notification with status=…` writes no class
  // and no notificationType, and three of them in a row all reading
  // "notification" name nothing at all.
  const ignored = events[0];
  assertEquals(ignored.kind, "notification");
  assertEquals(ignored.skipped, true);
  assertEquals(ignored.label, "signing status");
  assertEquals(ignored.result, "OUTSTANDING · ignored");
});

Deno.test("foldWebhooks: a record that names itself is never relabelled", () => {
  // The shape is only ever a fallback: a class name and a notificationType are
  // what the log actually said, and both outrank anything inferred from fields.
  const named = events.find((event) => event.label === "IdentificationNotificationRequest")!;
  assert(named !== undefined, "the class-named notification kept its class name");
  const typed = events.find((event) => event.label === "IDENTIFICATION_STATUS")!;
  assert(typed !== undefined, "and the webhook kept its notificationType");
});

Deno.test("foldWebhooks: every event's records point back at the log", () => {
  for (const event of events) {
    assert(event.records.length > 0, "an event owns at least the record that opened it");
    for (const at of event.records) {
      assertEquals(model.records[at].webhook, event.id, "and each of them points back");
    }
  }
  // The skipped-and-handled webhook owns three: received, ignored, handled.
  const webhook = events.find((event) => event.skipped && event.kind === "webhook")!;
  assertEquals(webhook.records.length, 3);
});

Deno.test("foldWebhooks: the status lifecycle comes out in order", () => {
  assertEquals(
    events.map((event) => event.status),
    [
      "OUTSTANDING",
      "VERIFICATION_PENDING",
      "VERIFICATION_PENDING",
      "VERIFICATION_CONFIRMED",
      "SIGNED",
      "SIGNED",
    ],
  );
});

Deno.test("foldWebhooks: a log with no inbound messages yields nothing", () => {
  const plain = analyse([{
    file: "quiet.log",
    text:
      "[2026-05-15 10:00:00.000][INFO ][runtimelog.a.a-api.user_code][t]{application=a}\nHello.",
  }]);
  assertEquals(foldWebhooks(plain.records), []);
});

/* ---------------------------- the small parts ---------------------------- */

Deno.test("senderFromClass: strips the notification-class suffix", () => {
  assertEquals(senderFromClass("BaloiseIdNotificationRequest"), "BaloiseId");
  assertEquals(senderFromClass("IdentificationNotificationRequest"), "Identification");
  assertEquals(senderFromClass("SomethingRequest"), "Something");
  assertEquals(senderFromClass("SomethingNotification"), "Something");
  // Nothing to strip, and never an empty lane name.
  assertEquals(senderFromClass("Gateway"), "Gateway");
  assertEquals(senderFromClass("Request"), "Request");
});

Deno.test("statusOf: reads the three spellings these logs mix", () => {
  assertEquals(statusOf("status=OUTSTANDING and data={}"), "OUTSTANDING");
  assertEquals(statusOf("    status: VERIFICATION_PENDING"), "VERIFICATION_PENDING");
  assertEquals(statusOf('{"status":"SIGNED"}'), "SIGNED");
});

Deno.test("statusOf: is not fooled by a longer key ending in status", () => {
  assertEquals(statusOf('{"qTSPstatus":"NO_REGISTRATION"}'), "");
  assertEquals(statusOf('{"signingStatus":"SIGNED"}'), "");
  assertEquals(statusOf('{"identificationFilesStatus":"MISSING"}'), "");
  // documentBasketStatus is the one deliberate fallback.
  assertEquals(statusOf('{"documentBasketStatus":"DOWNLOADED"}'), "DOWNLOADED");
  // With both present the bare status wins.
  assertEquals(statusOf('{"status":"SIGNED","documentBasketStatus":"DOWNLOADED"}'), "SIGNED");
});

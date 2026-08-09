/**
 * Tests for the Log Analysis tool's parsing, identifier extraction, REST-span
 * folding, grouping and filtering. Run with `deno task test`.
 *
 * The fixtures are trimmed from real Axon Ivy logs (ticket BAL-9685: one
 * onboarding flow spread over balboa-bank, baloise-id and sob), because the
 * things that break a log parser are all in the details of the real thing —
 * commas inside MDC values, bodies that are pretty-printed Java dumps, ids that
 * appear labelled in one file and bare in a URL in another, and a censoring pass
 * that replaces a UUID with a placeholder.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import {
  analyse,
  buildGroups,
  contextAround,
  correlationOf,
  densityBuckets,
  extractIds,
  facetCounts,
  filterRecords,
  foldRestSpans,
  formatMs,
  gapStats,
  groupIds,
  indexIds,
  mergeSources,
  parseMdc,
  parseQuery,
  parseRecords,
  parseTimestamp,
  pinnedMarkdown,
  rankedIds,
  recordSummary,
  recordText,
  resolveAliases,
  restStats,
  spanSummary,
  splitLogger,
  summarize,
} from "../static/loganalysis/loganalysis.mjs";
import { gunzip, unzipEntries } from "../static/loganalysis/unzip.mjs";
import { foldWebhooks } from "../static/loganalysis/webhooks.mjs";

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

/** Compose an Ivy header line, so the fixtures below stay readable. */
function head(
  ts: string,
  level: string,
  logger: string,
  thread: string,
  mdc: string,
): string {
  return `[${ts}][${level}][${logger}][${thread}]{${mdc}}`;
}

const DOSSIER = "5dad36c5-15ae-4a36-8c62-b88ff8c549bd";
const GOB_DOSSIER = "b463d13e-a323-469a-8243-c5d35469216c";
const CASE = "5a3cd6b2-ec73-4d3e-84a9-a81880bbfb52";
const PERSON = "40da81d4-60fd-4abf-85d0-cf7de567e261";

const BANK_LOG = [
  head(
    "2026-05-15 10:11:41.159",
    "INFO ",
    "runtimelog.balboa-bank.balboa-bank.user_code",
    "http-nio-8080-exec-9",
    "application=balboa-bank, client=10.164.11.178, executionContext=2642 (anonymous), " +
      "pmv=balboa-bank$balboa-bank$1, requestId=5511526, session=2642 (anonymous), task=6475202",
  ),
  `Finalized caseIds [${CASE}] and documentBasketId [] for dossier ${GOB_DOSSIER}`,
  // Out of order on purpose: mergeSources must sort it back.
  head(
    "2026-05-15 10:14:03.416",
    "INFO ",
    "runtimelog.balboa-bank.balboa-bank-api.user_code",
    "http-nio-8080-exec-2",
    "application=balboa-bank, requestId=5511526",
  ),
  `Backoffice task creation probe has been executed. dossierId = ${DOSSIER}`,
  head(
    "2026-05-15 10:12:17.810",
    "WARN ",
    "runtimelog.balboa-bank.balboa-bank.user_code",
    "http-nio-8080-exec-12",
    "application=balboa-bank, requestId=5511300",
  ),
  "The refresh token does not exist or invalid. Session is not authorized: The token is null.",
].join("\n");

const ID_LOG = [
  head(
    "2026-05-15 10:13:54.793",
    "INFO ",
    "runtimelog.baloise-id.baloise-id-api.user_code",
    "http-nio-8080-exec-11",
    "application=baloise-id, requestId=1470469, session=0 SYSTEM",
  ),
  "Received notification: class IdentificationNotificationRequest {",
  `    ubiIdCaseId: ${CASE}`,
  `    extPersonId: ${PERSON}`,
  `    extCaseId: ${GOB_DOSSIER}`,
  "    identityProfile: 6",
  "    status: VERIFICATION_PENDING",
  "    createdTime: 2026-05-15T08:13:54",
  "}",
  head(
    "2026-05-15 10:13:58.484",
    "INFO ",
    "runtimelog.baloise-id.baloise-id-api.user_code",
    "http-nio-8080-exec-2",
    "application=baloise-id",
  ),
  "Notification received. Ignore notification with status=DOWNLOADED and data=" +
  `{"ubiIdCaseId":"affectedUbiIdCaseIdBasketBAL-9685","extCaseId":null,"extApplication":null}`,
].join("\n");

const CASE_URL = `https://baloiseidbalgroupit.com/baloise-id/api/baloiseid/cases/${CASE}`;
const REST_LOG = [
  head(
    "2026-05-15 10:13:54.889",
    "DEBUG",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-3",
    "application=balboa-bank, requestId=5511520",
  ),
  `Invoking REST service baloise-id (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET ${CASE_URL}`,
  head(
    "2026-05-15 10:13:54.889",
    "DEBUG",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-3",
    "application=balboa-bank, requestId=5511520",
  ),
  `>> GET ${CASE_URL}`,
  "Authorization: **************************************************",
  head(
    "2026-05-15 10:13:55.035",
    "INFO ",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-3",
    "application=balboa-bank, requestId=5511520",
  ),
  `REST service baloise-id (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET ${CASE_URL} ` +
  "successful executed in 146 [ms]. Response status was 200 ",
  head(
    "2026-05-15 10:13:55.035",
    "DEBUG",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-3",
    "application=balboa-bank, requestId=5511520",
  ),
  "<< 200 ",
  "content-type: application/json",
  `{"ubiIdcaseId":"${CASE}","documentBasketId":null}`,
  // A second, slower call to the zip — seven seconds, logged in [s].
  head(
    "2026-05-15 10:13:55.125",
    "DEBUG",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-3",
    "application=balboa-bank, requestId=5511520",
  ),
  `Invoking REST service baloise-id (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET ${CASE_URL}/files.zip`,
  head(
    "2026-05-15 10:14:03.067",
    "INFO ",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-3",
    "application=balboa-bank, requestId=5511520",
  ),
  `REST service baloise-id (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET ${CASE_URL}/files.zip ` +
  "successful executed in 7 [s]. Response status was 200 ",
  // Same URL as the first call, on another thread, and it never completes.
  head(
    "2026-05-15 10:14:05.100",
    "DEBUG",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-7",
    "application=balboa-bank, requestId=5511900",
  ),
  `Invoking REST service baloise-id (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET ${CASE_URL}`,
].join("\n");

const BASKETS_URL = "https://baloiseidt.com/baloise-id/api/baloiseid/document-baskets";
/**
 * A log that writes only the wire — no `Invoking` line naming the callee, no
 * completion line carrying the duration, just `>>` and `<<`. Whole integrations
 * log this way, and every REST call in such a log used to fold into nothing.
 *
 * Three shapes, and the last two are what an excerpt does to a thread: a call
 * with both halves, a lone response whose request was never logged, and a thread
 * where the first response went missing and a second call followed it.
 */
const WIRE_LOG = [
  head(
    "2026-05-15 10:07:36.709",
    "DEBUG",
    "runtimelog.balboa-bank-sob.balboa-bank-sob-api.rest_client",
    "http-nio-8080-exec-25",
    "application=balboa-bank-sob, requestId=3134255",
  ),
  `>> POST ${BASKETS_URL}`,
  "Content-Type: application/json",
  `{"extCaseId":"${DOSSIER}","extApplication":"SELF_ONBOARDING"}`,
  head(
    "2026-05-15 10:07:37.051",
    "DEBUG",
    "runtimelog.balboa-bank-sob.balboa-bank-sob-api.rest_client",
    "http-nio-8080-exec-25",
    "application=balboa-bank-sob, requestId=3134255",
  ),
  "<< 200 ",
  "content-type: application/json",
  `{"extCaseId":"${DOSSIER}","documentBasketStatus":"OUTSTANDING"}`,
  // A response on a thread whose request is outside the excerpt.
  head(
    "2026-05-15 10:07:37.503",
    "DEBUG",
    "runtimelog.balboa-bank-sob.balboa-bank-sob-api.rest_client",
    "http-nio-8080-exec-34",
    "application=balboa-bank-sob, requestId=3134256",
  ),
  "<< 200 ",
  `{"extCaseId":"${DOSSIER}"}`,
  // Two requests on one thread, only the second answered.
  head(
    "2026-05-15 10:07:40.000",
    "DEBUG",
    "runtimelog.balboa-bank-sob.balboa-bank-sob-api.rest_client",
    "http-nio-8080-exec-9",
    "application=balboa-bank-sob, requestId=3134300",
  ),
  `>> GET ${BASKETS_URL}/434b7929`,
  head(
    "2026-05-15 10:07:41.000",
    "DEBUG",
    "runtimelog.balboa-bank-sob.balboa-bank-sob-api.rest_client",
    "http-nio-8080-exec-9",
    "application=balboa-bank-sob, requestId=3134301",
  ),
  `>> DELETE ${BASKETS_URL}/434b7929`,
  head(
    "2026-05-15 10:07:41.400",
    "DEBUG",
    "runtimelog.balboa-bank-sob.balboa-bank-sob-api.rest_client",
    "http-nio-8080-exec-9",
    "application=balboa-bank-sob, requestId=3134301",
  ),
  "<< 500 ",
].join("\n");

/* ------------------------------- parsing ------------------------------- */

Deno.test("parseMdc: splits on a comma that starts a new key, not on every comma", () => {
  const mdc = parseMdc(
    "application=balboa-bank, client=10.164.11.178, executionContext=2642 (anonymous), " +
      "request=HTTP GET Start/ProductProcess.p.json/continueOnboardingProcess.ivp(6420079.6475202.0.0), " +
      "requestId=5511585, session=0 SYSTEM",
  );
  assertEquals(mdc.application, "balboa-bank");
  assertEquals(mdc.executionContext, "2642 (anonymous)");
  assertEquals(mdc.requestId, "5511585");
  // The value keeps its own spaces; only a comma before a `key=` separates.
  assertEquals(mdc.session, "0 SYSTEM");
  assertEquals(
    mdc.request,
    "HTTP GET Start/ProductProcess.p.json/continueOnboardingProcess.ivp(6420079.6475202.0.0)",
  );
});

Deno.test("parseMdc: an empty value is kept, a blob without pairs yields nothing", () => {
  assertEquals(parseMdc("request=, requestId=7").request, "");
  assertEquals(parseMdc(""), {});
  assertEquals(parseMdc("no pairs here"), {});
});

Deno.test("splitLogger: an Ivy runtime logger yields app, pmv and category", () => {
  assertEquals(
    splitLogger("runtimelog.balboa-bank.balboa-bank-api.rest_client"),
    { app: "balboa-bank", pmv: "balboa-bank-api", category: "rest_client" },
  );
  assertEquals(
    splitLogger("runtimelog.baloise-id.baloise-id-api.event").category,
    "event",
  );
});

Deno.test("splitLogger: a platform logger takes its app from the MDC", () => {
  const parsed = splitLogger("ch.ivyteam.ivy.cm.internal.ContentManagementSystemImpl", {
    application: "balboa-bank",
  });
  // One coarse category, not one per framework class — otherwise the chip list
  // becomes a list of Java class names.
  assertEquals(parsed, { app: "balboa-bank", pmv: "", category: "platform" });
  assertEquals(splitLogger("javax.mail", {}).category, "platform");
});

Deno.test("splitLogger: a masked application is treated as absent", () => {
  // Every log that reaches a ticket has been through the sanitizer, and
  // `application=***********` must not become a filter chip.
  assertEquals(splitLogger("javax.mail", { application: "***********" }).app, "");
  assertEquals(splitLogger("javax.mail", { application: "balboa-bank" }).app, "balboa-bank");
});

Deno.test("parseTimestamp: reads Ivy's format, rejects nonsense", () => {
  const a = parseTimestamp("2026-05-15 10:11:41.159");
  const b = parseTimestamp("2026-05-15 10:11:42.159");
  assert(a !== null && b !== null, "both timestamps parse");
  // Only differences are ever used numerically, so that is what is asserted —
  // which also keeps this test independent of the machine's time zone.
  assertEquals((b as number) - (a as number), 1000);
  assertEquals(parseTimestamp("not a date"), null);
});

Deno.test("parseRecords: a record keeps its multi-line body", () => {
  const records = parseRecords(ID_LOG, "id.log");
  assertEquals(records.length, 2);
  assertEquals(records[0].level, "INFO");
  assertEquals(records[0].app, "baloise-id");
  assertEquals(records[0].category, "user_code");
  assertEquals(records[0].thread, "http-nio-8080-exec-11");
  assertEquals(records[0].file, "id.log");
  assertEquals(records[0].line, 1);
  // The whole Java dump belongs to the record above it, not to nine records.
  assert(records[0].body.includes("ubiIdCaseId"), "body holds the dump");
  assert(records[0].body.includes("createdTime: 2026-05-15T08:13:54"), "body holds the last field");
  assertEquals(records[0].body.split("\n").length, 8);
});

Deno.test("parseRecords: an indented timestamp inside a body is not a new record", () => {
  // `createdTime: 2026-05-15T08:13:54` is indented, and the loose header pattern
  // is anchored with no tolerance for leading whitespace precisely so this holds.
  const records = parseRecords(ID_LOG, "id.log");
  assertEquals(records.map((r) => r.tsText), [
    "2026-05-15 10:13:54.793",
    "2026-05-15 10:13:58.484",
  ]);
});

Deno.test("parseRecords: the level's padding is trimmed", () => {
  const records = parseRecords(BANK_LOG, "bank.log");
  assertEquals(records.map((r) => r.level), ["INFO", "INFO", "WARN"]);
});

Deno.test("parseRecords: a foreign log format still yields timed records", () => {
  const text = [
    "2026-05-15 10:00:00.000 ERROR something exploded",
    "\tat com.example.Foo.bar(Foo.java:42)",
    "2026-05-15 10:00:01.000 INFO recovered",
  ].join("\n");
  const records = parseRecords(text, "other.log");
  assertEquals(records.length, 2);
  assertEquals(records[0].level, "ERROR");
  // The stack frame stays with the record it belongs to.
  assertEquals(records[0].body, "\tat com.example.Foo.bar(Foo.java:42)");
  assertEquals(records[1].level, "INFO");
});

Deno.test("parseRecords: text with no timestamps at all is still shown", () => {
  const records = parseRecords("just some text\nand more", "notes.txt");
  assertEquals(records.length, 1);
  assertEquals(records[0].head, "just some text");
  assertEquals(records[0].body, "and more");
  assertEquals(records[0].ts, null);
});

Deno.test("recordSummary: collapses whitespace and caps the width", () => {
  const records = parseRecords(ID_LOG, "id.log");
  assertEquals(
    recordSummary(records[0]),
    "Received notification: class IdentificationNotificationRequest {",
  );
  const long = parseRecords(
    `${head("2026-05-15 10:00:00.000", "INFO ", "x.y.z", "t", "")}\n${"a".repeat(400)}`,
    "l.log",
  );
  assertEquals(recordSummary(long[0], 20).length, 20);
  assert(recordSummary(long[0], 20).endsWith("…"), "capped summary is elided");
});

/* -------------------------------- merging -------------------------------- */

Deno.test("mergeSources: orders the merged timeline by timestamp", () => {
  const records = mergeSources([
    { file: "bank.log", text: BANK_LOG },
    { file: "id.log", text: ID_LOG },
  ]);
  assertEquals(records.map((r) => r.tsText), [
    "2026-05-15 10:11:41.159",
    "2026-05-15 10:12:17.810",
    "2026-05-15 10:13:54.793",
    "2026-05-15 10:13:58.484",
    "2026-05-15 10:14:03.416",
  ]);
  // Records are renumbered so `i` indexes the merged set.
  assertEquals(records.map((r) => r.i), [0, 1, 2, 3, 4]);
  assertEquals(records.map((r) => r.file), [
    "bank.log",
    "bank.log",
    "id.log",
    "id.log",
    "bank.log",
  ]);
});

Deno.test("mergeSources: records sharing a millisecond keep their written order", () => {
  // `Invoking…` and `>> GET…` are logged in the same millisecond all over these
  // logs; a sort that reshuffled them would break every REST span.
  const records = mergeSources([{ file: "rest.log", text: REST_LOG }]);
  const at = records.filter((r) => r.tsText === "2026-05-15 10:13:54.889");
  assertEquals(at.length, 2);
  assert(recordSummary(at[0]).startsWith("Invoking REST service"), "invoke comes first");
  assert(recordSummary(at[1]).startsWith(">> GET"), "the request envelope follows");
});

Deno.test("mergeSources: two files logging the same instant keep file order", () => {
  const line = (app: string) =>
    `${head("2026-05-15 10:00:00.000", "INFO ", `runtimelog.${app}.api.user_code`, "t", "")}\nhi`;
  const records = mergeSources([
    { file: "first.log", text: line("aaa") },
    { file: "second.log", text: line("bbb") },
  ]);
  assertEquals(records.map((r) => r.file), ["first.log", "second.log"]);
});

Deno.test("mergeSources: an untimed record stays under the record above it", () => {
  const text = [
    `${head("2026-05-15 10:00:00.000", "INFO ", "runtimelog.a.b.user_code", "t", "")}`,
    "first",
    "no timestamp at all, but starts a line",
  ].join("\n");
  const records = mergeSources([{ file: "a.log", text }]);
  // The stray line is body, so there is still one record — nothing sank to the top.
  assertEquals(records.length, 1);
  assertEquals(records[0].tsText, "2026-05-15 10:00:00.000");
});

/* ------------------------------ identifiers ------------------------------ */

Deno.test("extractIds: finds labelled ids whatever the punctuation around them", () => {
  const records = parseRecords(ID_LOG, "id.log").map(extractIds);
  const labels = records[0].labelled;
  assertEquals(labels.find((l) => l.label === "ubiIdCaseId")?.value, CASE);
  assertEquals(labels.find((l) => l.label === "extCaseId")?.value, GOB_DOSSIER);
  assertEquals(labels.find((l) => l.label === "extPersonId")?.value, PERSON);
  // Quoted JSON form, on the second record.
  assertEquals(
    records[1].labelled.find((l) => l.label === "ubiIdCaseId")?.value,
    "affectedUbiIdCaseIdBasketBAL-9685",
  );
});

Deno.test("extractIds: a bracketed list and a bare UUID both count", () => {
  const records = parseRecords(BANK_LOG, "bank.log").map(extractIds);
  // `caseIds [5a3c…]` is labelled despite the brackets…
  assertEquals(records[0].labelled.find((l) => l.label === "caseIds")?.value, CASE);
  // …and `for dossier b463…` carries no id-shaped label, so only the bare sweep
  // finds it. This is the case a label-driven extractor would miss.
  assert(records[0].ids.includes(GOB_DOSSIER), "the bare dossier UUID is indexed");
  assertEquals(records[0].labelled.some((l) => l.value === GOB_DOSSIER), false);
});

Deno.test("extractIds: masked, null and enum values are not identifiers", () => {
  const text = [
    head("2026-05-15 10:00:00.000", "INFO ", "runtimelog.a.b.user_code", "t", ""),
    'data={"extCaseId":null,"tenantId":"***********","identificationMethod":"AUTO_IDENTIFICATION"}',
    "documentBasketId []",
  ].join("\n");
  const record = extractIds(parseRecords(text, "a.log")[0]);
  assertEquals(record.labelled, []);
  assertEquals(record.ids, []);
});

Deno.test("extractIds: a UUID inside a URL or a filename is found", () => {
  const text = [
    head("2026-05-15 10:00:00.000", "INFO ", "runtimelog.a.b.user_code", "t", ""),
    `Copying document from front_${CASE}.jpg. Dossier ID: ${GOB_DOSSIER}`,
  ].join("\n");
  const record = extractIds(parseRecords(text, "a.log")[0]);
  assertEquals(record.ids.sort(), [CASE, GOB_DOSSIER].sort());
});

Deno.test("extractIds: a full stop ends the sentence, not the identifier", () => {
  const text = [
    head("2026-05-15 10:00:00.000", "INFO ", "runtimelog.a.b.user_code", "t", ""),
    `[CLOSED-CRM-ISSUE] - No tracked dossier for CRM issue externalId=387340588.`,
  ].join("\n");
  const record = extractIds(parseRecords(text, "a.log")[0]);
  assertEquals(record.labelled, [{ label: "externalId", value: "387340588" }]);
});

Deno.test("extractIds: a trailing dot does not split one id into two facets", () => {
  // The bare sweep reads the UUID clean and the labelled sweep used to read it
  // with the full stop attached, so one dossier arrived as two facets and each
  // filtered to only part of its own records.
  const text = [
    head("2026-05-15 10:00:00.000", "INFO ", "runtimelog.a.b.user_code", "t", ""),
    `Activity name=SEND_REMINDER_LETTER, status=SUCCESS by dossierId=${GOB_DOSSIER}.`,
  ].join("\n");
  const record = extractIds(parseRecords(text, "a.log")[0]);
  assertEquals(record.ids, [GOB_DOSSIER]);
  assertEquals(indexIds([record]).size, 1);
});

Deno.test("extractIds: a short all-digit value is a status code, not an id", () => {
  const text = [
    head("2026-05-15 10:00:00.000", "INFO ", "runtimelog.a.b.user_code", "t", ""),
    "[DISCARD_CRM_ISSUE] - No CRM issues to be processed. " +
    "statusCodeExternalIds=[30005, 50005, 55005, 56005], page=1, messageId=314391",
  ].join("\n");
  const record = extractIds(parseRecords(text, "a.log")[0]);
  // A key ending in "Ids" holding none of them; six digits is where the real
  // numeric ids in these logs start, and this list sits a digit below it.
  assertEquals(record.labelled, [{ label: "messageId", value: "314391" }]);
});

Deno.test("indexIds: an id collects every label it is logged under, across files", () => {
  const records = mergeSources([
    { file: "bank.log", text: BANK_LOG },
    { file: "id.log", text: ID_LOG },
  ]).map(extractIds);
  const index = indexIds(records);
  const facet = index.get(CASE);
  assert(facet !== undefined, "the case id is indexed");
  assertEquals((facet as { labels: string[] }).labels.sort(), ["caseIds", "ubiIdCaseId"]);
  // Two files mention it, which is what makes the merged view worth having.
  assertEquals((facet as { files: string[] }).files.sort(), ["bank.log", "id.log"]);
  assertEquals((facet as { count: number }).count, 2);
});

Deno.test("resolveAliases: a record naming one dossier links its case ids to it", () => {
  const records = mergeSources([{ file: "id.log", text: ID_LOG }]).map(extractIds);
  const aliases = resolveAliases(records);
  assertEquals(aliases.get(CASE), GOB_DOSSIER);
  // extPersonId is off the allow-list: link on it and unrelated dossiers merge.
  assertEquals(aliases.has(PERSON), false);
});

Deno.test("resolveAliases: a record naming two dossiers teaches nothing", () => {
  const text = [
    head("2026-05-15 10:00:00.000", "INFO ", "runtimelog.a.b.user_code", "t", ""),
    `extCaseId: ${GOB_DOSSIER} and dossierId = ${DOSSIER} with ubiIdCaseId: ${CASE}`,
  ].join("\n");
  const aliases = resolveAliases(parseRecords(text, "a.log").map(extractIds));
  assertEquals(aliases.size, 0);
});

/* ------------------------------ REST spans ------------------------------ */

Deno.test("foldRestSpans: folds the four lines of a call into one span", () => {
  const records = mergeSources([{ file: "rest.log", text: REST_LOG }]);
  const spans = foldRestSpans(records);
  const first = spans[0];
  assertEquals(first.service, "baloise-id");
  assertEquals(first.method, "GET");
  assertEquals(first.url, CASE_URL);
  assertEquals(first.status, 200);
  assertEquals(first.ms, 146);
  assertEquals(first.complete, true);
  assertEquals(first.ok, true);
  // Invoking, >>, the completion line and << — all four.
  assertEquals(first.records.length, 4);
  for (const i of first.records) assertEquals(records[i].span, 0);
});

Deno.test("foldRestSpans: a duration logged in seconds becomes milliseconds", () => {
  const spans = foldRestSpans(mergeSources([{ file: "rest.log", text: REST_LOG }]));
  const zip = spans.find((s) => s.url.endsWith("/files.zip"));
  assertEquals(zip?.ms, 7000);
  assertEquals(formatMs(7000), "7.0 s");
  assertEquals(formatMs(146), "146 ms");
});

Deno.test("formatMs: minutes and hours read as minutes and hours", () => {
  assertEquals(formatMs(59_900), "59.9 s");
  assertEquals(formatMs(60_000), "1 m");
  // The sample log's window: 414.7 s is seven minutes nobody wants to divide.
  assertEquals(formatMs(414_692), "6 m 55 s");
  // Whole-second rounding first, so the seconds part can never show as 60 —
  // a millisecond short of the hour rounds up to it.
  assertEquals(formatMs(3_599_400), "59 m 59 s");
  assertEquals(formatMs(3_599_999), "1 h");
  assertEquals(formatMs(3_600_000), "1 h");
  assertEquals(formatMs(7_530_000), "2 h 6 m");
  assertEquals(formatMs(null), "");
});

Deno.test("foldRestSpans: an invocation with no completion is flagged", () => {
  const spans = foldRestSpans(mergeSources([{ file: "rest.log", text: REST_LOG }]));
  const hung = spans[spans.length - 1];
  assertEquals(hung.thread, "http-nio-8080-exec-7");
  assertEquals(hung.complete, false);
  assertEquals(hung.ok, false);
  assertEquals(hung.ms, null);
  // No duration and no status: the header has to say why, not show a blank.
  assertEquals(spanSummary(hung), `GET ${CASE_URL} → no response`);
});

Deno.test("foldRestSpans: the same URL on two threads does not cross wires", () => {
  const spans = foldRestSpans(mergeSources([{ file: "rest.log", text: REST_LOG }]));
  const sameUrl = spans.filter((s) => s.url === CASE_URL);
  // Two independent calls to one URL: the completed one on exec-3, the hung one
  // on exec-7. A URL-keyed map would have closed the wrong span.
  assertEquals(sameUrl.length, 2);
  assertEquals(sameUrl[0].thread, "http-nio-8080-exec-3");
  assertEquals(sameUrl[0].complete, true);
  assertEquals(sameUrl[1].thread, "http-nio-8080-exec-7");
  assertEquals(sameUrl[1].complete, false);
});

Deno.test("foldRestSpans: a wire-only call folds, timed by the two records' clocks", () => {
  const records = mergeSources([{ file: "wire.log", text: WIRE_LOG }]);
  const spans = foldRestSpans(records);
  const post = spans[0];
  // Nothing named the callee, so the URL's host does.
  assertEquals(post.service, "baloiseidt.com");
  assertEquals(post.method, "POST");
  assertEquals(post.url, BASKETS_URL);
  assertEquals(post.status, 200);
  assertEquals(post.complete, true);
  assertEquals(post.ok, true);
  // No `in 342 [ms]` line exists: 10:07:36.709 → 10:07:37.051 is the duration.
  assertEquals(post.ms, 342);
  // Two records, not four — this log writes neither of the other two.
  assertEquals(post.records.length, 2);
  for (const i of post.records) assertEquals(records[i].span, 0);
});

Deno.test("foldRestSpans: a response whose request was never logged is dropped", () => {
  const records = mergeSources([{ file: "wire.log", text: WIRE_LOG }]);
  const spans = foldRestSpans(records);
  // exec-34 holds a `<< 200` and nothing else. It answered something, but with
  // no method and no URL there is no call to fold and no arrow to draw.
  assertEquals(spans.some((s) => s.thread === "http-nio-8080-exec-34"), false);
  assertEquals(records.find((r) => r.thread === "http-nio-8080-exec-34")?.span, -1);
});

Deno.test("foldRestSpans: a wire request takes over a thread its answer never reached", () => {
  const spans = foldRestSpans(mergeSources([{ file: "wire.log", text: WIRE_LOG }]));
  const lane = spans.filter((s) => s.thread === "http-nio-8080-exec-9");
  assertEquals(lane.length, 2);
  // The excerpt dropped the GET's response, so it reads as unanswered…
  assertEquals(lane[0].method, "GET");
  assertEquals(lane[0].complete, false);
  assertEquals(lane[0].ms, null);
  // …and the DELETE behind it is still folded, rather than lost with it.
  assertEquals(lane[1].method, "DELETE");
  assertEquals(lane[1].status, 500);
  assertEquals(lane[1].complete, true);
  assertEquals(lane[1].ok, false);
});

Deno.test("foldRestSpans: a `>>` under an Invoking span never opens a second one", () => {
  // The `Invoking` pairing is explicit; a `>>` that disagrees with it is the
  // logger writing a redirect or a retry, not a call of its own, and folding one
  // would double every span in an ordinary log.
  const text = [
    head(
      "2026-05-15 10:13:54.889",
      "DEBUG",
      "runtimelog.balboa-bank.balboa-bank-api.rest_client",
      "http-nio-8080-exec-3",
      "application=balboa-bank",
    ),
    `Invoking REST service baloise-id (30a5cb38) call to GET ${CASE_URL}`,
    head(
      "2026-05-15 10:13:54.890",
      "DEBUG",
      "runtimelog.balboa-bank.balboa-bank-api.rest_client",
      "http-nio-8080-exec-3",
      "application=balboa-bank",
    ),
    `>> GET ${CASE_URL}/redirected`,
  ].join("\n");
  const spans = foldRestSpans(mergeSources([{ file: "rest.log", text }]));
  assertEquals(spans.length, 1);
  assertEquals(spans[0].url, CASE_URL);
});

/** A Spring Boot console header for the gateway, whose pattern names no app. */
function gwHead(ts: string, thread: string, logger: string): string {
  return `${ts} DEBUG 7 --- [${thread}] ${logger} : `;
}

/**
 * One micrometer observation block, trimmed to the fields the fold reads but
 * keeping the two that trip a careless reader: `http.status_code='UNKNOWN'`
 * ahead of the real `status`, and a nested `parentObservation` carrying a second
 * `startTimeNanos` that belongs to the inbound server request, not this call.
 */
function observation(o: {
  method: string;
  route: string;
  target: string;
  uri: string;
  seconds: string;
  nanos: string;
  status: string;
}): string {
  return `{name=http.client.requests(null), error=null, ` +
    `lowCardinalityKeyValues=[http.method='${o.method}', http.status_code='UNKNOWN', ` +
    `spring.cloud.gateway.route.id='${o.route}', ` +
    `spring.cloud.gateway.route.uri='${o.target}'], ` +
    `highCardinalityKeyValues=[http.uri='${o.uri}'], ` +
    `map=[class io.micrometer.core.instrument.LongTaskTimer$Sample=` +
    `'SampleImpl{duration(seconds)=${o.seconds}, startTimeNanos=${o.nanos}}'], ` +
    `parentObservation={name=http.server.requests(null), lowCardinalityKeyValues=[` +
    `exception='none', outcome='SUCCESS', status='${o.status}', uri='UNKNOWN'], ` +
    `map=[class io.micrometer.core.instrument.LongTaskTimer$Sample=` +
    `'SampleImpl{duration(seconds)=9.9, startTimeNanos=99999999999999999}'], ` +
    `parentObservation=null}}`;
}

const IAM = {
  method: "DELETE",
  route: "airlock_iam",
  target: "https://baloise-mock-service.okd4.dev.mesoneer.io:443",
  uri: "http://hub-service.svc.cluster.local:8080/external-iam/rest/users/8793593",
  seconds: "0.001014545",
  nanos: "15348315994714208",
  status: "200",
};

const GATEWAY_LOG = [
  // Instrumented on epoll-2 …
  gwHead(
    "2026-08-07T08:03:51.414Z",
    "or-http-epoll-2",
    "g.f.h.o.ObservedRequestHttpHeadersFilter",
  ) +
  `Client observation  ${observation(IAM)} created for the request.`,
  // … and answered on epoll-4, which is the whole reason for the pairing key.
  gwHead(
    "2026-08-07T08:03:53.210Z",
    "or-http-epoll-4",
    ".f.h.o.ObservedResponseHttpHeadersFilter",
  ) +
  `The response was handled for observation ${observation({ ...IAM, seconds: "1.799033132" })}`,
  // A second exchange nothing ever answers.
  gwHead(
    "2026-08-07T08:04:00.000Z",
    "or-http-epoll-2",
    "g.f.h.o.ObservedRequestHttpHeadersFilter",
  ) +
  `Client observation  ${
    observation({
      method: "POST",
      route: "ubidoc",
      target: "https://baloise-ubidoc-dev.okd4.dev.mesoneer.io:443",
      uri: "http://hub-service.svc.cluster.local:8080/ubidoc/api/documents/generate",
      seconds: "0.00016983",
      nanos: "15348318116053935",
      status: "200",
    })
  } created for the request.`,
].join("\n");

Deno.test("foldRestSpans: a gateway exchange folds from its observation pair", () => {
  const records = mergeSources([{ file: "hub.log", text: GATEWAY_LOG }]);
  const spans = foldRestSpans(records);
  const [proxied] = spans;
  // The route id, not the target host: it is the gateway's own name for the
  // service behind it, and the counterpart of an `Invoking` line's alias.
  assertEquals(proxied.service, "airlock_iam");
  assertEquals(proxied.method, "DELETE");
  // Neither logged field is the reached URL alone — the target's origin joined
  // to the rewritten path is. Note the default :443 drops out.
  assertEquals(
    proxied.url,
    "https://baloise-mock-service.okd4.dev.mesoneer.io/external-iam/rest/users/8793593",
  );
  // `http.status_code='UNKNOWN'` sits ahead of this and must not be read instead.
  assertEquals(proxied.status, 200);
  assertEquals(proxied.ok, true);
  // duration(seconds) on the closing line, in milliseconds.
  assertEquals(proxied.ms, 1799);
  assertEquals(proxied.records.length, 2);
  for (const i of proxied.records) assertEquals(records[i].span, 0);
});

Deno.test("foldRestSpans: a gateway pairs across threads, not along one", () => {
  const records = mergeSources([{ file: "hub.log", text: GATEWAY_LOG }]);
  const spans = foldRestSpans(records);
  // The request was instrumented on epoll-2 and the response handled on epoll-4;
  // a thread-keyed map would have closed nothing here.
  assertEquals(records[0].thread, "or-http-epoll-2");
  assertEquals(records[1].thread, "or-http-epoll-4");
  assertEquals(spans[0].complete, true);
});

Deno.test("foldRestSpans: a gateway exchange nothing answered stays open", () => {
  const spans = foldRestSpans(mergeSources([{ file: "hub.log", text: GATEWAY_LOG }]));
  assertEquals(spans.length, 2);
  const hung = spans[1];
  assertEquals(hung.service, "ubidoc");
  assertEquals(hung.complete, false);
  assertEquals(hung.status, null);
  assertEquals(hung.ms, null, "the request leg's own duration is not the call's");
});

/* ------------------------------ REST rollup ------------------------------ */

/** A span carrying only what {@link restStats} reads, so the maths stays legible. */
function fakeSpan(id: number, service: string, ms: number | null, status: number | null) {
  return {
    id,
    service,
    method: "GET",
    url: `https://example.test/${id}`,
    file: "a.log",
    thread: "t1",
    status,
    ms,
    complete: status !== null,
    ok: status !== null && status >= 200 && status < 300,
    tsText: "2026-05-15 10:00:00.000",
    records: [id],
  };
}

Deno.test("restStats: rolls the real fixture up per service", () => {
  const spans = foldRestSpans(mergeSources([{ file: "rest.log", text: REST_LOG }]));
  const [stats] = restStats(spans);
  assertEquals(stats.service, "baloise-id");
  assertEquals(stats.calls, 3);
  assertEquals(stats.failed, 0);
  // The exec-7 call never answered — counted as a call, but it has no duration
  // to contribute, so it stays out of the percentiles.
  assertEquals(stats.unanswered, 1);
  assertEquals(stats.maxMs, 7000);
  assertEquals(stats.slowest?.ms, 7000);
});

Deno.test("restStats: percentiles are nearest-rank, ascending, nulls excluded", () => {
  // Ten durations, 100…1000. Nearest-rank puts p50 at index ceil(0.5*10)-1 = 4
  // and p95 at ceil(0.95*10)-1 = 9. Pinned here because percentile definitions
  // differ and a p95 nobody can reproduce is worse than no p95 at all.
  const spans = Array.from({ length: 10 }, (_, i) => fakeSpan(i, "svc", (i + 1) * 100, 200));
  const [stats] = restStats(spans);
  assertEquals(stats.p50, 500);
  assertEquals(stats.p95, 1000);

  // A single call is its own p50 and p95 — no interpolation, no null.
  const [one] = restStats([fakeSpan(0, "svc", 250, 200)]);
  assertEquals([one.p50, one.p95], [250, 250]);

  // Every call unanswered: there is no duration to take a percentile of, and
  // reporting 0 ms would read as "instant" rather than "never came back".
  const [dark] = restStats([fakeSpan(0, "svc", null, null), fakeSpan(1, "svc", null, null)]);
  assertEquals([dark.p50, dark.p95, dark.maxMs], [null, null, 0]);
  assertEquals([dark.calls, dark.unanswered], [2, 2]);
});

Deno.test("restStats: a non-2xx is failed, an absent response is unanswered", () => {
  const [stats] = restStats([
    fakeSpan(0, "svc", 120, 200),
    fakeSpan(1, "svc", 90, 500),
    fakeSpan(2, "svc", 80, 404),
    fakeSpan(3, "svc", null, null),
  ]);
  // The two counts are kept apart: a 500 answered and told you it broke, a
  // hung call told you nothing, and they point at different problems.
  assertEquals(stats.failed, 2);
  assertEquals(stats.unanswered, 1);
  assertEquals(stats.calls, 4);
});

Deno.test("restStats: services sort by call count, busiest first", () => {
  const rows = restStats([
    fakeSpan(0, "quiet", 100, 200),
    fakeSpan(1, "busy", 100, 200),
    fakeSpan(2, "busy", 100, 200),
  ]);
  assertEquals(rows.map((row) => row.service), ["busy", "quiet"]);
  assertEquals(restStats([]), []);
});

Deno.test("filterRecords: spanIds narrows to the records of one call", () => {
  const records = mergeSources([{ file: "rest.log", text: REST_LOG }]);
  const spans = foldRestSpans(records);
  const kept = filterRecords(records, { spanIds: [spans[0].id] }, spans);
  assertEquals(kept.map((r) => r.i), spans[0].records);
  // Records belonging to no span are excluded, not passed through.
  const none = filterRecords(records, { spanIds: [999] }, spans);
  assertEquals(none.length, 0);
});

/* ------------------------------- grouping ------------------------------- */

const ALL_SOURCES = [
  { file: "bank.log", text: BANK_LOG },
  { file: "id.log", text: ID_LOG },
  { file: "rest.log", text: REST_LOG },
];

Deno.test("correlationOf: a bare id in a URL resolves through the global index", () => {
  const { records, index, aliases } = analyse(ALL_SOURCES);
  // The REST records mention the case only inside the request URL. The label
  // comes from another file entirely, and the alias map turns it into a dossier.
  const restRecord = records.find((r) => recordSummary(r).startsWith("Invoking REST service"));
  assert(restRecord !== undefined, "the invoke record exists");
  assertEquals(correlationOf(restRecord!, index, aliases), GOB_DOSSIER);
});

Deno.test("correlationOf: linking off leaves the case id as its own key", () => {
  const { records, index, aliases } = analyse(ALL_SOURCES);
  const restRecord = records.find((r) => recordSummary(r).startsWith("Invoking REST service"))!;
  assertEquals(correlationOf(restRecord, index, aliases, false), CASE);
});

Deno.test("correlationOf: a dossier id logged in the record itself wins", () => {
  const { records, index, aliases } = analyse(ALL_SOURCES);
  const probe = records.find((r) => recordSummary(r).includes("Backoffice task creation"))!;
  assertEquals(correlationOf(probe, index, aliases), DOSSIER);
});

Deno.test("buildGroups: correlation mode gathers one flow across three files", () => {
  const { records, index, aliases, spans } = analyse(ALL_SOURCES);
  const groups = buildGroups(records, { mode: "correlation", index, aliases, spans });
  const gob = groups.find((g) => g.key === GOB_DOSSIER);
  assert(gob !== undefined, "the GOB dossier has a group");
  assertEquals(gob!.files.sort(), ["bank.log", "id.log", "rest.log"]);
  assertEquals(gob!.sublabels.sort(), ["extCaseId"]);
  assert(gob!.records.length > 5, "it collects the whole flow");
});

Deno.test("buildGroups: records matching no key land in a trailing Unattributed group", () => {
  const { records, index, aliases, spans } = analyse(ALL_SOURCES);
  const groups = buildGroups(records, { mode: "correlation", index, aliases, spans });
  const last = groups[groups.length - 1];
  assertEquals(last.label, "Unattributed");
  // The refresh-token warning mentions no id at all — hidden would be worse.
  assert(
    last.records.some((r) => recordSummary(r).startsWith("The refresh token")),
    "the id-less warning is kept",
  );
});

Deno.test("buildGroups: groups are ordered by when they start", () => {
  const { records, index, aliases, spans } = analyse(ALL_SOURCES);
  const groups = buildGroups(records, { mode: "correlation", index, aliases, spans })
    .filter((g) => g.label !== "Unattributed");
  const starts = groups.map((g) => g.records[0].ts as number);
  assertEquals(starts.slice().sort((a, b) => a - b), starts);
});

Deno.test("buildGroups: thread mode separates the two REST threads", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  const groups = buildGroups(records, { mode: "thread", spans });
  const labels = groups.map((g) => g.label);
  assert(labels.includes("http-nio-8080-exec-3"), "the busy thread is a group");
  assert(labels.includes("http-nio-8080-exec-7"), "the hung thread is its own group");
  const busy = groups.find((g) => g.label === "http-nio-8080-exec-3")!;
  assertEquals(busy.records.length, 6);
});

Deno.test("buildGroups: request mode keys on requestId within a file", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  const groups = buildGroups(records, { mode: "request", spans });
  const shared = groups.find((g) => g.label === "requestId 5511526")!;
  // Both bank.log records carry requestId 5511526, minutes apart.
  assertEquals(shared.records.length, 2);
  assertEquals(shared.ms, 142257);
});

Deno.test("buildGroups: rest mode makes each call a group headed by its outcome", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  const groups = buildGroups(records, { mode: "rest", spans });
  assertEquals(groups.length, 4); // three spans plus everything that is not a call
  assert(groups[0].label.includes("→ 200"), "the header states the outcome");
  assert(groups[0].label.includes("146 ms"), "and the duration");
});

Deno.test("buildGroups: none mode is one flat group of everything", () => {
  const { records } = analyse(ALL_SOURCES);
  const groups = buildGroups(records, { mode: "none" });
  assertEquals(groups.length, 1);
  assertEquals(groups[0].records.length, records.length);
});

Deno.test("buildGroups: a group counts its own errors and warnings", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  const groups = buildGroups(records, { mode: "thread", spans });
  const warned = groups.find((g) => g.label === "http-nio-8080-exec-12")!;
  assertEquals(warned.warns, 1);
  assertEquals(warned.errors, 0);
});

/* ------------------------------- filtering ------------------------------- */

Deno.test("filterRecords: no filters keeps everything", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  assertEquals(filterRecords(records, {}, spans).length, records.length);
});

Deno.test("filterRecords: an id filter matches wherever the id appears", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  const kept = filterRecords(records, { ids: [CASE] }, spans);
  // Labelled in two files, bare inside the REST URLs — all of it comes back:
  // `caseIds [5a3c…]` in bank.log, `ubiIdCaseId: 5a3c…` in id.log, and all
  // seven rest.log records, every one of which carries the id in its URL or body.
  assertEquals(kept.length, 9);
  assertEquals(new Set(kept.map((r) => r.file)).size, 3);
});

Deno.test("filterRecords: several ids are OR, different facets are AND", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  // The nine records mentioning the case, plus the one naming the SOB dossier.
  const both = filterRecords(records, { ids: [CASE, DOSSIER] }, spans);
  assertEquals(both.length, 10);
  const narrowed = filterRecords(records, { ids: [CASE, DOSSIER], apps: ["baloise-id"] }, spans);
  assertEquals(narrowed.length, 1);
  assertEquals(narrowed[0].app, "baloise-id");
});

Deno.test("filterRecords: levels drop records that declare another level", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  const warns = filterRecords(records, { levels: ["WARN"] }, spans);
  assertEquals(warns.length, 1);
  assert(recordSummary(warns[0]).startsWith("The refresh token"), "the warning survives");
});

Deno.test("filterRecords: the query hides non-matching records and ignores case", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  assertEquals(filterRecords(records, { query: "refresh token" }, spans).length, 1);
  assertEquals(filterRecords(records, { query: "REFRESH TOKEN" }, spans).length, 1);
  // It searches the body too, not just the header.
  assertEquals(filterRecords(records, { query: "VERIFICATION_PENDING" }, spans).length, 1);
  assertEquals(filterRecords(records, { query: "nothing matches this" }, spans).length, 0);
});

Deno.test("filterRecords: restOnly keeps only records belonging to a call", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  const rest = filterRecords(records, { restOnly: true }, spans);
  assertEquals(rest.length, 7);
  for (const record of rest) assert(record.span !== -1, "every kept record is part of a span");
});

Deno.test("filterRecords: badOnly surfaces the call that never answered", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  const bad = filterRecords(records, { badOnly: true }, spans);
  assertEquals(bad.length, 1);
  assertEquals(bad[0].thread, "http-nio-8080-exec-7");
});

Deno.test("filterRecords: minMs keeps the slow call and drops the fast one", () => {
  const { records, spans } = analyse(ALL_SOURCES);
  const slow = filterRecords(records, { minMs: 1000 }, spans);
  // Only the seven-second zip download qualifies: its invoke and its completion.
  assertEquals(slow.length, 2);
  for (const record of slow) {
    assert(spans[record.span].url.endsWith("/files.zip"), "only the zip call is slow");
  }
});

/* ------------------------------- summaries ------------------------------- */

Deno.test("facetCounts: tallies the facets a reader filters by", () => {
  const facets = facetCounts(analyse(ALL_SOURCES).records);
  assertEquals(facets.levels.find((l) => l.value === "WARN")?.count, 1);
  // bank.log's three records plus all seven from rest.log.
  assertEquals(facets.apps.find((a) => a.value === "balboa-bank")?.count, 10);
  assertEquals(facets.apps.find((a) => a.value === "baloise-id")?.count, 2);
  assertEquals(facets.categories.find((c) => c.value === "rest_client")?.count, 7);
  assertEquals(facets.files.length, 3);
  // Threads are ranked by how much they carry, so the busiest is first.
  assertEquals(facets.threads[0].value, "http-nio-8080-exec-3");
});

Deno.test("summarize: reports the shape of what was loaded", () => {
  const { records, spans, summary } = analyse(ALL_SOURCES);
  assertEquals(summary.records, records.length);
  assertEquals(summary.files, 3);
  assertEquals(summary.apps.sort(), ["balboa-bank", "baloise-id"]);
  assertEquals(summary.warns, 1);
  assertEquals(summary.errors, 0);
  assertEquals(summary.restCalls, 3);
  assertEquals(summary.restFailed, 1);
  assertEquals(summary.slowest?.ms, 7000);
  assertEquals(summary.fromTs, "2026-05-15 10:11:41.159");
  assertEquals(summary.toTs, "2026-05-15 10:14:05.100");
  assertEquals(spans.length, 3);
});

Deno.test("summarize: an empty set does not throw", () => {
  const summary = summarize([], []);
  assertEquals(summary.records, 0);
  assertEquals(summary.ms, null);
  assertEquals(summary.slowest, null);
});

Deno.test("rankedIds: dossier ids sort above case ids, then by weight", () => {
  const { index } = analyse(ALL_SOURCES);
  const ranked = rankedIds(index);
  const dossiers = [GOB_DOSSIER, DOSSIER];
  assert(dossiers.includes(ranked[0].value), "a dossier id leads the list");
  assert(dossiers.includes(ranked[1].value), "the other dossier is next");
  assertEquals(ranked[2].value, CASE);
  // The person id is labelled but is neither dossier nor case, so it ranks below.
  const person = ranked.findIndex((f) => f.value === PERSON);
  assert(person > 2, "an unrelated labelled id ranks lower");
});

Deno.test("analyse: an empty source list yields an empty, usable result", () => {
  const result = analyse([]);
  assertEquals(result.records, []);
  assertEquals(result.spans, []);
  assertEquals(result.summary.records, 0);
  assertEquals(rankedIds(result.index), []);
  assertEquals(groupIds(result.records, result.spans, result.index, result.aliases), []);
});

/* ------------------------- identifier groups ------------------------- */

Deno.test("groupIds: files a call's ids under the same key the timeline groups by", () => {
  const { records, spans, index, aliases } = analyse(ALL_SOURCES);
  const groups = groupIds(records, spans, index, aliases);
  // REST_LOG's calls are to /baloiseid/cases/<CASE>, and CASE resolves to
  // GOB_DOSSIER through the alias map — the same resolution correlationOf does,
  // which is the whole point of reusing it.
  const anchored = groups.filter((group) => group.key !== "");
  assert(anchored.length > 0, "at least one group is anchored on a correlation id");
  for (const group of anchored) {
    const first = records.find((record) => record.ids.includes(group.ids[0].value))!;
    assert(first !== undefined, `${group.title} names ids the log actually has`);
  }
  const gob = groups.find((group) => group.key === GOB_DOSSIER);
  assert(gob !== undefined, "the dossier the REST calls belong to has its own group");
  assert(gob!.calls > 0, "and it was formed by REST calls");
  assert(gob!.ids.some((facet) => facet.value === CASE), "the case travelled with it");
});

Deno.test("groupIds: the heading names the anchor by its label", () => {
  const { records, spans, index, aliases } = analyse(ALL_SOURCES);
  const gob = groupIds(records, spans, index, aliases).find((g) => g.key === GOB_DOSSIER)!;
  assert(gob.title.includes(GOB_DOSSIER), "the heading carries the id");
  assert(/^(dossierId|extCaseId) /.test(gob.title), `labelled heading, got "${gob.title}"`);
});

Deno.test("groupIds: records the services a group's calls went to", () => {
  const { records, spans, index, aliases } = analyse(ALL_SOURCES);
  const groups = groupIds(records, spans, index, aliases);
  const withCalls = groups.filter((group) => group.calls > 0);
  assert(withCalls.length > 0, "some group was formed by calls");
  assert(
    withCalls.every((group) => group.services.length > 0),
    "a group formed by calls names the services they went to",
  );
  assert(
    withCalls.some((group) => group.services.includes("baloise-id")),
    "and baloise-id is among them",
  );
});

Deno.test("groupIds: inbound messages relate ids the same way a REST call does", () => {
  // A whole integration can be webhook-only — the onboarding flow logs no
  // `Invoking REST service` line at all — and grouping that log by calls alone
  // would file every id under the catch-all.
  const inbound = [
    "[2026-05-15 10:00:00.000][INFO ][runtimelog.bank.bank-api.user_code][t-1]{application=bank}",
    "Received webhook notification. notification = class BaloiseIdNotificationRequest {",
    "    notificationId: 11111111-1111-4111-8111-111111111111",
    "    notificationType: IDENTIFICATION_STATUS",
    `    notificationData: {"extCaseId":"${DOSSIER}","status":"VERIFICATION_PENDING"}`,
    "}",
  ].join("\n");
  const alt = analyse([{ file: "hook.log", text: inbound }]);
  const events = foldWebhooks(alt.records);
  const bare = groupIds(alt.records, alt.spans, alt.index, alt.aliases, true);
  assertEquals(bare[0].title, "No calls or messages", "without events, nothing relates them");
  const withEvents = groupIds(alt.records, alt.spans, alt.index, alt.aliases, true, events);
  const anchored = withEvents.find((group) => group.key === DOSSIER);
  assert(anchored !== undefined, "the webhook filed its ids under the dossier it named");
  assertEquals(anchored!.received, 1);
  assertEquals(anchored!.calls, 0);
  assertEquals(anchored!.services, ["BaloiseId"], "the sender is the other party");
});

Deno.test("groupIds: ids no exchange mentions collect in a trailing group", () => {
  const { records, spans, index, aliases } = analyse(ALL_SOURCES);
  const groups = groupIds(records, spans, index, aliases);
  const last = groups[groups.length - 1];
  assertEquals(last.title, "No calls or messages");
  assertEquals(last.calls, 0);
  assertEquals(last.services, []);
  // Nothing is lost: every indexed id is in exactly one bucket or another.
  const listed = new Set(groups.flatMap((group) => group.ids.map((facet) => facet.value)));
  for (const value of index.keys()) {
    assert(listed.has(value), `${value} is listed somewhere`);
  }
});

Deno.test("groupIds: the alias link moves the sidebar groups and the timeline together", () => {
  const { records, spans, index, aliases } = analyse(ALL_SOURCES);
  const linked = groupIds(records, spans, index, aliases, true);
  const unlinked = groupIds(records, spans, index, aliases, false);
  // Unlinked, a call naming only the case can no longer reach its dossier, so it
  // files under the case itself — exactly what the timeline does with Link off.
  assert(
    linked.some((group) => group.key === GOB_DOSSIER),
    "linked, the calls file under the dossier",
  );
  assert(
    unlinked.some((group) => group.key === CASE),
    "unlinked, they file under the case they name",
  );
});

Deno.test("groupIds: busiest group first, catch-alls last", () => {
  const { records, spans, index, aliases } = analyse(ALL_SOURCES);
  const groups = groupIds(records, spans, index, aliases);
  const anchored = groups.filter((group) => group.key !== "");
  for (let i = 1; i < anchored.length; i++) {
    assert(anchored[i - 1].calls >= anchored[i].calls, "anchored groups sort by call count");
  }
  const titles = groups.map((group) => group.title);
  const catchAll = titles.findIndex((title) =>
    title === "Unattributed" || title === "No calls or messages"
  );
  if (catchAll !== -1) {
    assert(
      titles.slice(catchAll).every((t) => t === "Unattributed" || t === "No calls or messages"),
      "nothing anchored sorts below a catch-all",
    );
  }
});

Deno.test("groupIds: every group has a unique fold key", () => {
  const { records, spans, index, aliases } = analyse(ALL_SOURCES);
  const groups = groupIds(records, spans, index, aliases);
  const slugs = groups.map((group) => group.slug);
  assertEquals(new Set(slugs).size, slugs.length, "both catch-alls share key '' but not slug");
});

/* ------------------------- Spring Boot console logs ------------------------- */
// Trimmed from the real e-portal pod logs: the integration hub writes the plain
// Boot pattern, the api adds the `[traceId][dossierId][userId]` MDC prefix and
// the application-name group. The details that break a naive regex are all
// here: a five-letter ERROR flush against the brackets, `%5p` padding, a
// left-truncated thread name, and a stack trace as the only body.

const SPRING_TRACE = "a31d01feb66e855275ef3294db6d3c0e";
const SPRING_DOSSIER = "22c44ccb-12c7-4564-b187-7a4d11bcd0a4";

const HUB_LOG = [
  "Start importing trusted certificates",
  "[entrypoint] DEBUG - Bootstrapping BALOISE-E-PORTAL-INTEGRATION-HUB",
  "2026-08-07T08:00:18.831Z  INFO 7 --- [           main] " +
  ".BaloiseEPortalIntegrationHubApplication : Starting application with PID 7",
  "2026-08-07T08:00:23.527Z DEBUG 7 --- [or-http-epoll-4] " +
  "o.s.c.g.h.RoutePredicateHandlerMapping   : Route matched: gwg",
].join("\n");

const API_LOG = [
  `2026-08-07T08:02:51.302Z [${SPRING_TRACE}][${SPRING_DOSSIER}][-] INFO 7 --- ` +
  "[baloise-e-portal-api] [nio-8080-exec-5] b.e.a.a.s.DefaultIdentityDocumentService : " +
  `Deleted upload document file: name=${SPRING_DOSSIER}_ID_FRONT.jpeg`,
  `2026-08-07T08:03:50.609Z [${SPRING_TRACE}][-][-] INFO 7 --- ` +
  "[baloise-e-portal-api] [io-8080-exec-10] i.m.b.e.a.a.s.DossierCompleteService     : " +
  `Moved uploaded docs to official folder: dossierId=${SPRING_DOSSIER}`,
  `2026-08-07T08:10:39.066Z [${SPRING_TRACE}][-][-]ERROR 7 --- ` +
  "[baloise-e-portal-api] [nio-8080-exec-2] i.m.b.e.a.c.e.ExceptionHandlerAdvice     : " +
  "Access denied for authorize user occurred: reason=Resource does not satisfy scope conditions",
  "",
  "org.springframework.security.access.AccessDeniedException: Resource does not satisfy scope",
  "\tat org.springframework.security.authorization.method.ThrowingMethodAccessDeniedHandler",
].join("\n");

Deno.test("parseRecords: the plain Spring Boot console header", () => {
  const records = parseRecords(HUB_LOG, "hub.log");
  // Entry-point preamble folds into one synthetic record, then the two heads.
  assertEquals(records.length, 3);
  assertEquals(records[0].ts, null);
  const [, start, route] = records;
  assertEquals(start.level, "INFO");
  assertEquals(start.thread, "main", "the %15t padding is trimmed");
  assertEquals(start.logger, ".BaloiseEPortalIntegrationHubApplication");
  assertEquals(start.category, "BaloiseEPortalIntegrationHubApplication");
  assertEquals(start.app, "", "the plain pattern names no application");
  assertEquals(start.msg, "Starting application with PID 7");
  assertEquals(recordSummary(start), "Starting application with PID 7");
  assertEquals(start.tsText, "2026-08-07 08:00:18.831", "T and Z normalised for display");
  assert(start.ts !== null && route.ts !== null && route.ts > start.ts, "timestamps parse");
});

/** The same gateway, with the boot line Spring Boot really writes. */
const HUB_BOOTED = HUB_LOG.replace(
  "Starting application with PID 7",
  "Starting BaloiseEPortalIntegrationHubApplication v2.1.0-SNAPSHOT using Java 21.0.8 " +
    "with PID 7 (/apps/baloise-e-portal-integration-hub.jar started by 1001320000 in /apps)",
);

Deno.test("parseRecords: a file that names no application takes it from the boot line", () => {
  // The gateway's log pattern has no application slot, so every one of its
  // records would join a merged timeline anonymous — missing from the
  // Applications facet, and named in the Flow diagram by its pod filename.
  const records = parseRecords(HUB_BOOTED, "hub.log");
  for (const record of records) {
    assertEquals(record.app, "baloise-e-portal-integration-hub", `line ${record.line}`);
  }
});

Deno.test("parseRecords: the jar name is the one the platform elsewhere prints", () => {
  // The API logs both: a boot line naming the jar, and an application in its own
  // pattern. They agree, which is why the jar wins over the class beside it —
  // `BaloiseEPortalApiApplication` would have been a third spelling.
  const booted = [
    "2026-08-07T08:00:21.973Z [-][-][-] INFO 7 --- [baloise-e-portal-api] [           main] " +
    "i.m.b.e.a.BaloiseEPortalApiApplication   : Starting BaloiseEPortalApiApplication " +
    "v2.1.0-SNAPSHOT using Java 21.0.8 with PID 7 (/apps/baloise-e-portal-api.jar " +
    "started by 1001320000 in /apps)",
  ].join("\n");
  const [record] = parseRecords(booted, "api.log");
  assertEquals(record.app, "baloise-e-portal-api");
});

Deno.test("parseRecords: a file that names itself is never renamed by its banner", () => {
  // API_LOG's pattern prints an application on every line and carries no boot
  // line; the banner rule must not reach into a file that already answered.
  for (const record of parseRecords(API_LOG, "api.log")) {
    assertEquals(record.app, "baloise-e-portal-api");
  }
  // And with no boot line to read, an unnamed file stays unnamed rather than
  // being given a guess.
  assertEquals(parseRecords(HUB_LOG, "hub.log")[1].app, "");
});

Deno.test("parseRecords: the e-portal MDC prefix, app name and flush ERROR", () => {
  const records = parseRecords(API_LOG, "api.log");
  assertEquals(records.length, 3);
  const [deleted, moved, denied] = records;
  assertEquals(deleted.app, "baloise-e-portal-api");
  assertEquals(deleted.mdc.traceId, SPRING_TRACE);
  assertEquals(deleted.mdc.dossierId, SPRING_DOSSIER);
  assertEquals(deleted.mdc.userId, undefined, "a lone dash is logback's empty marker");
  assertEquals(deleted.thread, "nio-8080-exec-5");
  assertEquals(moved.mdc.dossierId, undefined);
  // ERROR is five letters, so %5p leaves no space after the bracket run.
  assertEquals(denied.level, "ERROR");
  assertEquals(denied.thread, "nio-8080-exec-2");
  assert(
    recordSummary(denied).startsWith("Access denied for authorize user"),
    "the row summary is the header message, not the stack trace",
  );
  assert(denied.body.includes("AccessDeniedException"), "the stack trace is the body");
  assert(
    recordText(denied).endsWith("ThrowingMethodAccessDeniedHandler"),
    "head plus body reproduce the record verbatim",
  );
});

Deno.test("Spring MDC ids are indexed, labelled and correlate across files", () => {
  const model = analyse([
    { file: "hub.log", text: HUB_LOG },
    { file: "api.log", text: API_LOG },
  ]);
  const trace = model.index.get(SPRING_TRACE);
  assert(trace !== undefined, "the 32-hex traceId is indexed despite having no dashes");
  assertEquals(trace?.labels, ["traceId"]);
  const dossier = model.index.get(SPRING_DOSSIER);
  assert(dossier?.labels.includes("dossierId") === true, "the MDC slot names the dossier");
  // All three api records join the dossier's group: one names it in the MDC
  // slot, one in the message text, and the ERROR only shares their traceId —
  // which resolveAliases links to the dossier.
  const groups = buildGroups(model.records, {
    mode: "correlation",
    index: model.index,
    aliases: model.aliases,
    spans: model.spans,
  });
  const flow = groups.find((group) => group.label === SPRING_DOSSIER);
  assertEquals(flow?.records.length, 3);
  // The hub file opens with an untimed entrypoint preamble; the window must
  // come from the first stamped record, not from it.
  assertEquals(model.summary.fromTs, "2026-08-07 08:00:18.831");
});

Deno.test("request grouping keys a traceId globally, not per file", () => {
  const model = analyse([{ file: "api.log", text: API_LOG }]);
  const groups = buildGroups(model.records, {
    mode: "request",
    index: model.index,
    aliases: model.aliases,
    spans: model.spans,
  });
  assertEquals(groups.length, 1);
  assertEquals(groups[0].label, `trace ${SPRING_TRACE}`);
  assertEquals(groups[0].records.length, 3);
});

/* ----------------------- search terms and time window ----------------------- */

Deno.test("parseQuery: whitespace splits, quotes group, everything lower-cases", () => {
  assertEquals(parseQuery('Dossier "official folder"  500'), ["dossier", "official folder", "500"]);
  assertEquals(parseQuery("  "), []);
  assertEquals(parseQuery('""'), []);
});

Deno.test("filterRecords: every term must match (AND), phrases stay whole", () => {
  const records = parseRecords(API_LOG, "api.log");
  const both = filterRecords(records, { query: `document ${SPRING_DOSSIER}` });
  assertEquals(both.length, 1, "only the DocumentService record carries both terms");
  const phrase = filterRecords(records, { query: '"official folder"' });
  assertEquals(phrase.length, 1);
  assertEquals(recordSummary(phrase[0]).includes("official folder"), true);
  // The same two words unquoted match nothing extra here, but "folder official"
  // quoted would: the phrase is positional, the terms are not.
  assertEquals(filterRecords(records, { query: '"folder official"' }).length, 0);
});

Deno.test("filterRecords: a time window keeps its slice and drops untimed records", () => {
  const records = mergeSources([{ file: "hub.log", text: HUB_LOG }]);
  const timed = records.filter((r) => r.ts !== null);
  const [first, second] = timed;
  const onlySecond = filterRecords(records, { fromMs: second.ts, toMs: second.ts });
  assertEquals(onlySecond.length, 1);
  assertEquals(onlySecond[0].line, second.line);
  // The preamble record inherits no clock of its own; mergeSources leaves the
  // leading one at null, and a window must not guess it into range.
  const preamble = parseRecords(HUB_LOG, "hub.log")[0];
  assertEquals(preamble.ts, null);
  assertEquals(
    filterRecords([preamble], { fromMs: first.ts as number }).length,
    0,
  );
});

Deno.test("densityBuckets: counts land in their slices, errors are tallied", () => {
  const records = mergeSources([{ file: "api.log", text: API_LOG }]);
  const buckets = densityBuckets(records, 2);
  assertEquals(buckets.length, 2);
  // 08:02:51 and 08:03:50 sit in the first half of the 08:02:51→08:10:39
  // window; the ERROR at the end lands in — and closes — the second.
  assertEquals(buckets[0].count, 2);
  assertEquals(buckets[1].count, 1);
  assertEquals(buckets[1].errors, 1);
  assertEquals(buckets[0].fromMs, records.find((r) => r.ts !== null)?.ts);
  // No axis without at least two distinct timestamps.
  assertEquals(densityBuckets([], 4), []);
  assertEquals(densityBuckets([records[0]], 4), []);
});

/* ------------------------------ context & gaps ------------------------------ */

/** A log of one record per given clock, so the gap arithmetic below reads plainly. */
function clockLog(times: string[]): string {
  return times
    .map((ts) => `${head(ts, "INFO ", "runtimelog.a.a.user_code", "t1", "")}\nline at ${ts}`)
    .join("\n");
}

Deno.test("contextAround: neighbours either side, clamped at both ends", () => {
  const records = mergeSources([{
    file: "a.log",
    text: clockLog([
      "2026-05-15 10:00:00.000",
      "2026-05-15 10:00:01.000",
      "2026-05-15 10:00:02.000",
      "2026-05-15 10:00:03.000",
      "2026-05-15 10:00:04.000",
    ]),
  }]);

  const middle = contextAround(records, 2, 2);
  assertEquals(middle.before.map((r) => r.i), [0, 1]);
  assertEquals(middle.after.map((r) => r.i), [3, 4]);

  // At the ends one side is simply empty — never wrapped, never short-changed.
  assertEquals(contextAround(records, 0, 2).before, []);
  assertEquals(contextAround(records, 0, 2).after.map((r) => r.i), [1, 2]);
  assertEquals(contextAround(records, 4, 2).after, []);
  assertEquals(contextAround(records, 4, 2).before.map((r) => r.i), [2, 3]);

  // A span wider than the log clamps instead of overrunning.
  assertEquals(contextAround(records, 2, 99).before.map((r) => r.i), [0, 1]);
  assertEquals(contextAround(records, 2, 99).after.map((r) => r.i), [3, 4]);

  const none = contextAround(records, 2, 0);
  assertEquals([none.before.length, none.after.length], [0, 0]);
  // Out of range asks for context around nothing, and gets nothing.
  const off = contextAround(records, 9, 2);
  assertEquals([off.before.length, off.after.length], [0, 0]);
});

Deno.test("gapStats: flags the outlier gap, indexed by the record it precedes", () => {
  const records = mergeSources([{
    file: "a.log",
    text: clockLog([
      "2026-05-15 10:00:00.000",
      "2026-05-15 10:00:01.000",
      "2026-05-15 10:00:02.000",
      // The hang: ten seconds against a one-second cadence.
      "2026-05-15 10:00:12.000",
      "2026-05-15 10:00:13.000",
    ]),
  }]);
  const stats = gapStats(records);
  assertEquals(stats.medianMs, 1000);
  assertEquals(stats.largestMs, 10_000);
  // The index names the record the gap sits *before*, so it is never 0.
  assertEquals(stats.largestAt, 3);
  assertEquals(stats.flagged, [3]);
});

Deno.test("gapStats: the absolute floor stops a sub-second pause reading as a hang", () => {
  // Gaps 100, 100, 600 ms: the 600 clears 5x the 100 ms median, but a pause this
  // short is cadence, not a stall — the 1 s floor is what rejects it.
  const records = mergeSources([{
    file: "a.log",
    text: clockLog([
      "2026-05-15 10:00:00.000",
      "2026-05-15 10:00:00.100",
      "2026-05-15 10:00:00.200",
      "2026-05-15 10:00:00.800",
    ]),
  }]);
  const stats = gapStats(records);
  assertEquals(stats.medianMs, 100);
  assertEquals(stats.largestMs, 600);
  assertEquals(stats.largestAt, 3);
  assertEquals(stats.flagged, []);
});

Deno.test("gapStats: a zero median leaves the floor to do the work", () => {
  // Three records in the same millisecond, then a three-second gap. The median
  // gap is 0, so the 5x test passes for everything and only the floor filters.
  const records = mergeSources([{
    file: "a.log",
    text: clockLog([
      "2026-05-15 10:00:00.000",
      "2026-05-15 10:00:00.000",
      "2026-05-15 10:00:00.000",
      "2026-05-15 10:00:03.000",
    ]),
  }]);
  const stats = gapStats(records);
  assertEquals(stats.medianMs, 0);
  assertEquals(stats.flagged, [3]);
});

Deno.test("gapStats: nothing to measure across, and nothing invented", () => {
  const one = mergeSources([{ file: "a.log", text: clockLog(["2026-05-15 10:00:00.000"]) }]);
  assertEquals(gapStats(one), { medianMs: 0, largestMs: 0, largestAt: -1, flagged: [] });
  assertEquals(gapStats([]), { medianMs: 0, largestMs: 0, largestAt: -1, flagged: [] });
  // Every record in the same millisecond: real records, but no gap to name.
  const flat = mergeSources([{
    file: "a.log",
    text: clockLog(["2026-05-15 10:00:00.000", "2026-05-15 10:00:00.000"]),
  }]);
  assertEquals(gapStats(flat).largestAt, -1);
  assertEquals(gapStats(flat).flagged, []);
});

Deno.test("buildGroups: a group carries its own largest gap", () => {
  const records = mergeSources([{
    file: "a.log",
    text: clockLog([
      "2026-05-15 10:00:00.000",
      "2026-05-15 10:00:01.000",
      "2026-05-15 10:00:02.000",
      "2026-05-15 10:00:12.000",
    ]),
  }]);
  for (const record of records) extractIds(record);
  const [group] = buildGroups(records, { mode: "none" });
  assertEquals(group.gapMs, 10_000);
  assertEquals(group.gapAt, 3);
});

/* ------------------------------ pinned markdown ------------------------------ */

Deno.test("pinnedMarkdown: header per record, fences outgrow inner backticks", () => {
  const records = parseRecords(
    [
      head("2026-05-15 10:11:41.159", "WARN ", "runtimelog.demo.demo.user_code", "exec-1", ""),
      "A body quoting ```json fences``` inside it.",
    ].join("\n"),
    "a*.log",
  );
  const markdown = pinnedMarkdown(records);
  assertEquals(markdown.startsWith("**a\\*.log · 2026-05-15 10:11:41.159 · WARN**"), true);
  // Three backticks appear in the body, so the fence uses four.
  assertEquals(markdown.includes("\n````text\n"), true);
  assertEquals(markdown.trimEnd().endsWith("````"), true);
  assertEquals(markdown.includes("```json fences```"), true);
});

/* ------------------------------ source offsets ------------------------------ */

Deno.test("mergeSources: offsetMs shifts ordering and deltas, never the text", () => {
  const ivy = head("2026-05-15 10:00:00.000", "INFO ", "runtimelog.a.a.user_code", "t1", "") +
    "\nIvy side.";
  const pod = "2026-05-15 08:01:00.000 INFO 7 --- [           main] c.Some : Pod side.";
  // The pod clock is UTC, two hours behind the Ivy wall clock: unshifted it
  // sorts first, shifted by +2 h it lands one minute after the Ivy record.
  const unshifted = mergeSources([
    { file: "ivy.log", text: ivy },
    { file: "pod.log", text: pod },
  ]);
  assertEquals(unshifted[0].file, "pod.log");
  const shifted = mergeSources([
    { file: "ivy.log", text: ivy },
    { file: "pod.log", text: pod, offsetMs: 2 * 3_600_000 },
  ]);
  assertEquals(shifted[0].file, "ivy.log");
  assertEquals(shifted[1].file, "pod.log");
  assertEquals(
    (shifted[1].ts as number) - (shifted[0].ts as number),
    60_000,
    "deltas use the shifted clock",
  );
  assertEquals(shifted[1].tsText, "2026-05-15 08:01:00.000", "displayed text stays as logged");
});

/* ---------------------------------- unzip ---------------------------------- */

/** Build a minimal zip in memory. CRCs are zeroed — the reader ignores them. */
function buildZip(entries: { name: string; data: Uint8Array; method: 0 | 8 }[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, entry.method, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, entry.data);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(10, entry.method, true);
    dv.setUint32(20, entry.data.length, true);
    dv.setUint32(24, entry.data.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    central.push(dir);
    offset += local.length + entry.data.length;
  }
  const cdSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, eocd];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function compress(text: string, format: "deflate-raw" | "gzip"): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)]).stream()
    .pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

Deno.test("unzipEntries: stored and deflated entries come back, directories don't", async () => {
  const deflated = await compress("deflated line\n", "deflate-raw");
  const zip = buildZip([
    { name: "logs/", data: new Uint8Array(0), method: 0 },
    { name: "logs/api.log", data: new TextEncoder().encode("stored line\n"), method: 0 },
    { name: "logs/hub.log", data: deflated, method: 8 },
  ]);
  // The directory entry lies about its compressed size being 0 — fine either way.
  const entries = await unzipEntries(zip);
  assertEquals(entries.map((e) => e.name), ["logs/api.log", "logs/hub.log"]);
  assertEquals(new TextDecoder().decode(entries[0].bytes), "stored line\n");
  assertEquals(new TextDecoder().decode(entries[1].bytes), "deflated line\n");
});

Deno.test("unzipEntries: refuses what is not a zip", async () => {
  let failed = "";
  try {
    await unzipEntries(new TextEncoder().encode("just a log line"));
  } catch (error) {
    failed = String(error);
  }
  assertEquals(failed.includes("Not a zip archive"), true);
});

Deno.test("gunzip: a .gz round-trips", async () => {
  const packed = await compress("gzipped log\n", "gzip");
  assertEquals(new TextDecoder().decode(await gunzip(packed)), "gzipped log\n");
});

/**
 * Tests for the Log Analysis tool's problem digest: JVM throwable parsing,
 * message normalisation and the clustering that turns four hundred ERROR rows
 * into the handful of distinct things that actually went wrong.
 *
 * The fixtures are shaped like the real thing in both formats the tool parses as
 * first-class — an Axon Ivy record, whose message *is* its body, and a Spring
 * Boot pod record, whose message rides on the header line with only the stack
 * trace continuing below. That difference is the whole reason `messageText`
 * exists, so it is exercised in both shapes rather than one.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import {
  clusterProblems,
  FRAMEWORK_PREFIXES,
  messageText,
  normalizeMessage,
  parseThrowable,
  problemIndex,
} from "../static/loganalysis/problems.mjs";
import {
  analyse,
  buildGroups,
  extractIds,
  mergeSources,
} from "../static/loganalysis/loganalysis.mjs";

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

const DOSSIER_A = "5dad36c5-15ae-4a36-8c62-b88ff8c549bd";
const DOSSIER_B = "b463d13e-a323-469a-8243-c5d35469216c";

/** An Ivy header, whose record body carries the whole message. */
function ivy(ts: string, level: string, body: string[]): string {
  return [
    `[${ts}][${level}][runtimelog.demo-bank.demo-bank.user_code][http-nio-8080-exec-3]` +
    `{application=demo-bank, requestId=5511520}`,
    ...body,
  ].join("\n");
}

/** A Spring Boot pod header, whose message sits on the header line itself. */
function spring(ts: string, level: string, msg: string, trace: string[] = []): string {
  return [
    `${ts} ${level} 7 --- [e-portal-api] [nio-8080-exec-5] b.e.DossierService : ${msg}`,
    ...trace,
  ].join("\n");
}

const TRACE = [
  "com.example.SigningException: could not sign the dossier",
  "\tat com.example.sign.Signer.sign(Signer.java:88)",
  "\tat org.springframework.web.Dispatcher.handle(Dispatcher.java:1040)",
  "\tat java.base/java.lang.Thread.run(Thread.java:840)",
  "Caused by: java.sql.SQLException: connection reset by peer",
  "\tat com.example.db.Pool.borrow(Pool.java:210)",
  "\t... 34 more",
];

/* ------------------------------ throwables ------------------------------ */

Deno.test("parseThrowable: the chain, its root, and the first frame that is ours", () => {
  const found = parseThrowable(TRACE.join("\n"));
  assert(found !== null, "the trace is recognised");
  assertEquals(found!.type, "com.example.SigningException");
  assertEquals(found!.message, "could not sign the dossier");
  assertEquals(found!.causes.map((cause) => cause.type), ["java.sql.SQLException"]);
  // The root cause is what the reader is actually hunting: the outermost type
  // says which layer noticed, the root says what broke.
  assertEquals(found!.rootCause.type, "java.sql.SQLException");
  assertEquals(found!.rootCause.message, "connection reset by peer");
  // Spring and the JDK own three of the four frames; the useful one is ours.
  assertEquals(found!.topFrame, "com.example.sign.Signer.sign");
  assertEquals(found!.frames, 4);
});

Deno.test("parseThrowable: a chain several deep roots at the last cause", () => {
  const found = parseThrowable([
    "com.example.OuterException: outer",
    "\tat com.example.A.a(A.java:1)",
    "Caused by: com.example.MiddleException: middle",
    "\tat com.example.B.b(B.java:2)",
    "Caused by: java.io.IOException: broken pipe",
    "\tat com.example.C.c(C.java:3)",
  ].join("\n"));
  assertEquals(found!.causes.length, 2);
  assertEquals(found!.rootCause.type, "java.io.IOException");
  assertEquals(found!.rootCause.message, "broken pipe");
});

Deno.test("parseThrowable: a declaration with no frames still counts", () => {
  // Spring logs plenty of these — a one-line failure with no trace attached.
  const found = parseThrowable("java.lang.IllegalStateException: pool already closed");
  assertEquals(found!.type, "java.lang.IllegalStateException");
  assertEquals(found!.message, "pool already closed");
  assertEquals(found!.frames, 0);
  // No frame to prefer, and none invented.
  assertEquals(found!.topFrame, "");
  // Its own root, since nothing wrapped it.
  assertEquals(found!.rootCause.type, "java.lang.IllegalStateException");
});

Deno.test("parseThrowable: a type carrying no message keeps an empty one", () => {
  const found = parseThrowable([
    "java.lang.NullPointerException",
    "\tat com.example.A.a(A.java:1)",
  ].join("\n"));
  assertEquals(found!.type, "java.lang.NullPointerException");
  assertEquals(found!.message, "");
});

Deno.test("parseThrowable: prose and payloads are not exceptions", () => {
  assertEquals(parseThrowable("Backoffice task creation probe has been executed."), null);
  assertEquals(parseThrowable('{"ubiIdCaseId":"abc","status":"OUTSTANDING"}'), null);
  assertEquals(parseThrowable(""), null);
  // A dotted lowercase name is a logger or a package, not a throwable.
  assertEquals(parseThrowable("ch.ivyteam.ivy.cm.internal.ContentManagement: loaded"), null);
  // A pretty-printed Java dump names a class without throwing one.
  assertEquals(
    parseThrowable("Received notification: class DemoRequest {\n    status: OK\n}"),
    null,
  );
});

Deno.test("parseThrowable: `Suppressed:` joins the chain like a cause", () => {
  const found = parseThrowable([
    "com.example.TryException: main failure",
    "\tat com.example.A.a(A.java:1)",
    "\tSuppressed: java.io.IOException: close failed",
    "\t\tat com.example.B.b(B.java:2)",
  ].join("\n"));
  assertEquals(found!.type, "com.example.TryException");
  assertEquals(found!.causes.map((c) => c.type), ["java.io.IOException"]);
});

Deno.test("parseThrowable: every framework prefix falls back to the first frame", () => {
  // A trace entirely inside frameworks has no frame of "ours" to prefer, so the
  // first one is still named rather than reporting nothing.
  const found = parseThrowable([
    "java.lang.IllegalStateException: nope",
    "\tat org.springframework.web.Dispatcher.handle(Dispatcher.java:1)",
    "\tat java.base/java.lang.Thread.run(Thread.java:840)",
  ].join("\n"));
  assertEquals(found!.topFrame, "org.springframework.web.Dispatcher.handle");
  assert(FRAMEWORK_PREFIXES.length > 0, "the prefix list is reviewable, not empty");
});

/* ----------------------------- message text ----------------------------- */

Deno.test("messageText: Ivy carries its message in the body, Spring on the header", () => {
  const [ivyRecord] = mergeSources([{
    file: "ivy.log",
    text: ivy("2026-05-15 10:00:00.000", "ERROR", TRACE),
  }]);
  // Ivy's `msg` is empty by construction, so the body has to be what is read.
  assertEquals(ivyRecord.msg, "");
  assert(messageText(ivyRecord).startsWith("com.example.SigningException"), "Ivy body is used");

  const [springRecord] = mergeSources([{
    file: "pod.log",
    text: spring("2026-08-07T08:00:18.831Z", "ERROR", "Failed to sign dossier", TRACE),
  }]);
  assertEquals(springRecord.msg, "Failed to sign dossier");
  // Header message first, then the trace below it — so the throwable is found
  // even though the message line itself is not a declaration.
  assertEquals(messageText(springRecord).split("\n")[0], "Failed to sign dossier");
  assertEquals(parseThrowable(messageText(springRecord))!.type, "com.example.SigningException");
});

/* ------------------------------ normalising ------------------------------ */

Deno.test("normalizeMessage: the parts that vary per occurrence become placeholders", () => {
  assertEquals(
    normalizeMessage(`Could not sign dossier ${DOSSIER_A}`),
    "Could not sign dossier {id}",
  );
  assertEquals(
    normalizeMessage("Timed out at 2026-05-15T10:00:00.123Z"),
    "Timed out at {ts}",
  );
  // Long digit runs are ids and counters; short ones are status codes and counts,
  // and collapsing those would merge a 404 into a 500.
  assertEquals(normalizeMessage("requestId=5511520 returned 500"), "requestId={n} returned 500");
  assertEquals(normalizeMessage("retry 2 of 3"), "retry 2 of 3");
  assertEquals(normalizeMessage("token a1b2c3d4e5f60718"), "token {hex}");
  assertEquals(normalizeMessage("  spread   over\n  lines  "), "spread over lines");
});

Deno.test("normalizeMessage: two occurrences of one problem collapse to one key", () => {
  const a = normalizeMessage(`Signing failed for dossier ${DOSSIER_A}, request 5511520`);
  const b = normalizeMessage(`Signing failed for dossier ${DOSSIER_B}, request 9900011`);
  assertEquals(a, b);
  // …while a genuinely different sentence does not.
  assert(a !== normalizeMessage(`Upload failed for dossier ${DOSSIER_A}, request 5511520`), "kept");
});

/* ------------------------------ clustering ------------------------------ */

/**
 * Two occurrences of one failure on different dossiers, plus a different one.
 * The dossiers are written `dossierId = …`, the way the logs really label them:
 * a bare UUID after the *word* "dossier" is found by the id sweep but teaches
 * nothing about what it is, so `correlationOf` would rightly not claim it.
 */
const PROBLEM_LOG = [
  ivy("2026-05-15 10:00:00.000", "ERROR", [
    `Signing failed for dossierId = ${DOSSIER_A}`,
    ...TRACE,
  ]),
  ivy("2026-05-15 10:00:05.000", "INFO ", ["All good here."]),
  ivy("2026-05-15 10:00:10.000", "ERROR", [
    `Signing failed for dossierId = ${DOSSIER_B}`,
    ...TRACE,
  ]),
  ivy("2026-05-15 10:00:20.000", "WARN ", [
    `The refresh token does not exist for dossierId = ${DOSSIER_A}`,
  ]),
  ivy("2026-05-15 10:00:30.000", "ERROR", [
    "com.example.MailException: smtp unreachable",
    "\tat com.example.mail.Sender.send(Sender.java:12)",
  ]),
].join("\n");

function problemModel() {
  const records = mergeSources([{ file: "bank.log", text: PROBLEM_LOG }]);
  for (const record of records) extractIds(record);
  return records;
}

Deno.test("clusterProblems: one problem, two occurrences, both dossiers named", () => {
  const records = problemModel();
  const { index, aliases } = analyse([{ file: "bank.log", text: PROBLEM_LOG }]);
  const clusters = clusterProblems(records, index, aliases);

  // Busiest first: the SQLException hit twice, the others once each.
  assertEquals(clusters[0].count, 2);
  assertEquals(clusters[0].level, "ERROR");
  // Keyed on the *root* cause: the same connection reset under any wrapper is
  // one problem, and that is the type worth showing.
  assertEquals(clusters[0].type, "java.sql.SQLException");
  assertEquals(clusters[0].firstTs, "2026-05-15 10:00:00.000");
  assertEquals(clusters[0].lastTs, "2026-05-15 10:00:10.000");
  // The reverse lookup: which business cases did this one failure touch?
  assertEquals(clusters[0].dossiers.sort(), [DOSSIER_A, DOSSIER_B].sort());
  assertEquals(clusters[0].records.length, 2);
});

Deno.test("clusterProblems: distinct failures stay distinct", () => {
  const records = problemModel();
  const { index, aliases } = analyse([{ file: "bank.log", text: PROBLEM_LOG }]);
  const types = clusterProblems(records, index, aliases).map((c) => c.type);
  assert(types.includes("java.sql.SQLException"), "the wrapped SQL failure");
  assert(types.includes("com.example.MailException"), "the mail failure");
  // The WARN carries no throwable at all, and still earns its own cluster.
  const plain = clusterProblems(records, index, aliases).find((c) => c.type === "");
  assert(plain !== undefined, "a plain warning clusters too");
  assertEquals(plain!.level, "WARN");
  assert(plain!.message.startsWith("The refresh token does not exist"), "message kept readable");
});

Deno.test("clusterProblems: only the levels asked for, INFO never among them", () => {
  const records = problemModel();
  const { index, aliases } = analyse([{ file: "bank.log", text: PROBLEM_LOG }]);
  const all = clusterProblems(records, index, aliases);
  assertEquals(all.some((c) => c.level === "INFO"), false);
  // Narrowing to ERROR drops the WARN cluster entirely.
  const errors = clusterProblems(records, index, aliases, { levels: ["ERROR"] });
  assertEquals(errors.every((c) => c.level === "ERROR"), true);
  assertEquals(errors.length, 2);
  assertEquals(clusterProblems([], index, aliases), []);
});

Deno.test("buildGroups: problem mode ranks worst-first and leaves the rest out", () => {
  const records = problemModel();
  const { index, aliases } = analyse([{ file: "bank.log", text: PROBLEM_LOG }]);
  const problems = problemIndex(clusterProblems(records, index, aliases));
  const groups = buildGroups(records, { mode: "problem", index, aliases, problems });

  // Worst first, by how many of the *shown* records fell into it.
  assertEquals(groups[0].records.length, 2);
  assert(groups[0].label.startsWith("SQLException: connection reset"), groups[0].label);
  // The bare class name, not java.sql. — the package only costs header width.
  assertEquals(groups[0].label.includes("java.sql."), false);
  assertEquals(groups[0].sublabels, ["com.example.sign.Signer.sign"]);

  // The INFO record belongs to no cluster, so it lands in Unattributed rather
  // than vanishing — the same contract every other mode keeps.
  const last = groups[groups.length - 1];
  assertEquals(last.label, "Unattributed");
  assertEquals(last.records.length, 1);
  assertEquals(last.records[0].level, "INFO");
});

Deno.test("problemIndex: every record of every cluster maps back to it", () => {
  const records = problemModel();
  const { index, aliases } = analyse([{ file: "bank.log", text: PROBLEM_LOG }]);
  const clusters = clusterProblems(records, index, aliases);
  const map = problemIndex(clusters);
  for (const cluster of clusters) {
    for (const i of cluster.records) assertEquals(map.get(i)?.key, cluster.key);
  }
  // The INFO record was never clustered, so it is absent rather than mapped.
  const info = records.find((r) => r.level === "INFO")!;
  assertEquals(map.has(info.i), false);
  assertEquals(problemIndex([]).size, 0);
});

Deno.test("clusterProblems: apps and files come along for the ride", () => {
  const records = problemModel();
  const { index, aliases } = analyse([{ file: "bank.log", text: PROBLEM_LOG }]);
  const [worst] = clusterProblems(records, index, aliases);
  assertEquals(worst.apps, ["demo-bank"]);
  assertEquals(worst.files, ["bank.log"]);
  // `firstIndex` points at a real record, so the UI can jump straight to it.
  assertEquals(records[worst.firstIndex].level, "ERROR");
});

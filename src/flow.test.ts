/**
 * Tests for the Log Analysis Flow view's pure layer: turning the selected
 * identifiers into a sequence of service-to-service steps, and emitting that as
 * Mermaid source. Run with `deno task test`.
 *
 * The fixtures are two apps' REST client logs over one dossier — a call that
 * succeeds, one that 500s, one nothing ever answers, and one belonging to a
 * different dossier that must stay out. The interesting cases are all about
 * *which* span joins the flow: the id is as likely to be in a response body as
 * in the URL that was called.
 *
 * Dependency-free on purpose (no remote std import) so it runs offline.
 */
import { analyse, shortUrl } from "../static/loganalysis/loganalysis.mjs";
import { buildFlow, flowMermaid, laneKey, MAX_STEPS } from "../static/loganalysis/flow.mjs";

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
function head(ts: string, level: string, logger: string, thread: string, mdc: string): string {
  return `[${ts}][${level}][${logger}][${thread}]{${mdc}}`;
}

const DOSSIER = "5dad36c5-15ae-4a36-8c62-b88ff8c549bd";
const OTHER = "b463d13e-a323-469a-8243-c5d35469216c";
const CASE = "5a3cd6b2-ec73-4d3e-84a9-a81880bbfb52";

const CASE_URL = `https://baloiseidbalgroupit.com/baloise-id/api/baloiseid/cases/${CASE}`;
const DOC_URL = "https://docstore.balgroupit.com/documents/front.jpg";

/**
 * balboa-bank → baloise-id, succeeds. The dossier id is only in the response body.
 *
 * Note the service is invoked as `baloiseId` — the alias in *this* caller's REST
 * client config — while the same system logs itself as `application=baloise-id`
 * in ID_LOG below. That mismatch is real and it used to split the diagram in two.
 */
const BANK_LOG = [
  head(
    "2026-05-15 10:13:54.889",
    "DEBUG",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-3",
    "application=balboa-bank, requestId=5511520",
  ),
  `Invoking REST service baloiseId (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET ${CASE_URL}`,
  head(
    "2026-05-15 10:13:55.035",
    "INFO ",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-3",
    "application=balboa-bank, requestId=5511520",
  ),
  `REST service baloiseId (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET ${CASE_URL} ` +
  "successful executed in 146 [ms]. Response status was 200 ",
  head(
    "2026-05-15 10:13:55.036",
    "DEBUG",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-3",
    "application=balboa-bank, requestId=5511520",
  ),
  "<< 200 ",
  "content-type: application/json",
  `{"ubiIdcaseId":"${CASE}","dossierId":"${DOSSIER}"}`,
].join("\n");

/** baloise-id → document-store: one 500, then a retry nothing answers. */
const ID_LOG = [
  head(
    "2026-05-15 10:13:56.100",
    "DEBUG",
    "runtimelog.baloise-id.baloise-id-api.rest_client",
    "http-nio-8080-exec-11",
    `application=baloise-id, dossierId=${DOSSIER}, requestId=1470469`,
  ),
  `Invoking REST service document-store (aa11bb22-cc33-dd44-ee55-ff6677889900) call to PUT ${DOC_URL}`,
  head(
    "2026-05-15 10:13:57.300",
    "ERROR",
    "runtimelog.baloise-id.baloise-id-api.rest_client",
    "http-nio-8080-exec-11",
    `application=baloise-id, dossierId=${DOSSIER}, requestId=1470469`,
  ),
  `REST service document-store (aa11bb22-cc33-dd44-ee55-ff6677889900) call to PUT ${DOC_URL} ` +
  "failed in 1200 [ms]. Response status was 500 ",
  head(
    "2026-05-15 10:13:58.000",
    "DEBUG",
    "runtimelog.baloise-id.baloise-id-api.rest_client",
    "http-nio-8080-exec-11",
    `application=baloise-id, dossierId=${DOSSIER}, requestId=1470469`,
  ),
  `Invoking REST service document-store (aa11bb22-cc33-dd44-ee55-ff6677889900) call to PUT ${DOC_URL}`,
].join("\n");

/** A different dossier's traffic, which must never appear in our flow. */
const OTHER_LOG = [
  head(
    "2026-05-15 10:14:10.000",
    "DEBUG",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-9",
    `application=balboa-bank, dossierId=${OTHER}, requestId=5511999`,
  ),
  `Invoking REST service baloiseId (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET ${CASE_URL}x`,
  head(
    "2026-05-15 10:14:10.500",
    "INFO ",
    "runtimelog.balboa-bank.balboa-bank-api.rest_client",
    "http-nio-8080-exec-9",
    `application=balboa-bank, dossierId=${OTHER}, requestId=5511999`,
  ),
  `REST service baloiseId (30a5cb38-5242-4987-a2a6-16d82cee5826) call to GET ${CASE_URL}x ` +
  "successful executed in 20 [ms]. Response status was 200 ",
].join("\n");

const model = analyse([
  { file: "bank.log", text: BANK_LOG },
  { file: "id.log", text: ID_LOG },
  { file: "other.log", text: OTHER_LOG },
]);

/* ------------------------------ buildFlow ------------------------------ */

Deno.test("buildFlow: no ids selected is an empty flow, not the whole log", () => {
  const flow = buildFlow(model.records, model.spans, []);
  assertEquals(flow.steps.length, 0);
  assertEquals(flow.participants.length, 0);
  assertEquals(flow.total, 0);
});

Deno.test("buildFlow: a span joins on an id in its response body, not just its URL", () => {
  // The bank's call to /cases/<case> never writes the dossier id in the URL or
  // the invoking line — it arrives in the `<< 200` body.
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  const bank = flow.steps.find((step) => step.method === "GET");
  assert(bank !== undefined, "the bank's GET joined the flow through its response body");
  assertEquals(bank!.status, 200);
  assertEquals(bank!.ms, 146);
});

Deno.test("buildFlow: lanes are the caller's app and the service it called", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  // First appearance order: the bank calls baloise-id, which then calls the store.
  assertEquals(flow.participants, ["balboa-bank", "baloise-id", "document-store"]);
  const [first] = flow.steps;
  assertEquals(flow.participants[first.from], "balboa-bank");
  assertEquals(flow.participants[first.to], "baloise-id");
});

Deno.test("buildFlow: another dossier's calls stay out", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  assert(
    flow.steps.every((step) => !step.url.endsWith("x")),
    "the other dossier's GET was excluded",
  );
  const other = buildFlow(model.records, model.spans, [OTHER]);
  assertEquals(other.steps.length, 1);
  // No record in *this* flow is logged by baloise-id itself, so the only name
  // available for the lane is the caller's alias for it. Honest, not a fallback.
  assertEquals(other.participants, ["balboa-bank", "baloiseId"]);
});

Deno.test("buildFlow: a service's alias and its own app name are one lane", () => {
  // The bug this guards: balboa-bank invokes `baloiseId`, and baloise-id logs
  // itself as `application=baloise-id`. Keyed on the literal string those are two
  // lanes, and the diagram breaks into `balboa-bank → baloiseId` beside
  // `baloise-id → document-store` — the chain the view exists to show, severed.
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  assertEquals(flow.participants.length, 3, "three systems, not four lanes");
  assert(!flow.participants.includes("baloiseId"), "the alias did not get its own lane");
  // The middle lane is both a callee (of the bank) and a caller (of the store),
  // which is what makes the diagram one connected chain.
  const bank = flow.steps.find((step) => step.method === "GET")!;
  const store = flow.steps.find((step) => step.status === 500)!;
  assertEquals(bank.to, store.from);
  assertEquals(flow.participants[bank.to], "baloise-id");
});

Deno.test("buildFlow: the system's own name wins the label, whichever came first", () => {
  // Here the alias is seen first (bank.log sorts earliest), so the label has to be
  // upgraded in place when baloise-id's own records turn up later.
  const forward = buildFlow(model.records, model.spans, [DOSSIER]);
  assertEquals(forward.participants[1], "baloise-id");
  // And the reverse order must not downgrade it back to the alias.
  const reversed = analyse([
    { file: "id.log", text: ID_LOG },
    { file: "bank.log", text: BANK_LOG },
  ]);
  const flow = buildFlow(reversed.records, reversed.spans, [DOSSIER]);
  assert(flow.participants.includes("baloise-id"), "still labelled by its own name");
  assert(!flow.participants.includes("baloiseId"), "the alias never overwrites it");
});

Deno.test("buildFlow: a failed call keeps its status and reads as failed", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  const failed = flow.steps.find((step) => step.status === 500);
  assert(failed !== undefined, "the 500 is in the flow");
  assertEquals(failed!.complete, true);
  assertEquals(failed!.ok, false);
  assertEquals(failed!.result, "500 · 1.2 s");
});

Deno.test("buildFlow: an unanswered call says so rather than inventing a status", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  const hung = flow.steps.find((step) => !step.complete);
  assert(hung !== undefined, "the call nothing answered is in the flow");
  assertEquals(hung!.status, null);
  assertEquals(hung!.result, "no response logged");
});

Deno.test("buildFlow: counts the failures, unanswered included", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  assertEquals(flow.steps.length, 3);
  assertEquals(flow.failed, 2, "the 500 and the unanswered retry");
});

Deno.test("buildFlow: a step carries the span it came from, so it can be clicked back", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  for (const step of flow.steps) {
    assertEquals(step.kind, "rest", "this fixture is REST-only");
    assertEquals(model.spans[step.spanId!].url, step.url);
    assertEquals(step.eventId, null);
  }
});

Deno.test("buildFlow: the label shortens the URL to its path", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  const bank = flow.steps.find((step) => step.method === "GET")!;
  assertEquals(bank.label, `GET ${shortUrl(CASE_URL)}`);
  assertEquals(bank.url, CASE_URL, "the full URL survives for the tooltip");
});

Deno.test("buildFlow: a caller with no application falls back to its file", () => {
  // A foreign log parsed by the loose tier: a bare timestamp header with the
  // message beneath it, so there is no Ivy logger and no MDC — `app` is empty
  // and the filename is all there is to name the lane by.
  const foreign = [
    "2026-05-15 10:15:00",
    `Invoking REST service document-store (x) call to PUT ${DOC_URL}?d=${DOSSIER}`,
    "2026-05-15 10:15:01",
    `REST service document-store (x) call to PUT ${DOC_URL}?d=${DOSSIER} ` +
    "successful executed in 30 [ms]. Response status was 201 ",
  ].join("\n");
  const alt = analyse([{ file: "gateway.log", text: foreign }]);
  const flow = buildFlow(alt.records, alt.spans, [DOSSIER]);
  assertEquals(flow.steps.length, 1);
  assertEquals(flow.participants, ["gateway.log", "document-store"]);
});

Deno.test("buildFlow: caps the steps and reports what it dropped", () => {
  const lines: string[] = [];
  for (let i = 0; i < MAX_STEPS + 7; i++) {
    const url = `${DOC_URL}/${i}?d=${DOSSIER}`;
    lines.push(
      head(
        `2026-05-15 11:00:${String(i % 60).padStart(2, "0")}.000`,
        "DEBUG",
        "runtimelog.balboa-bank.balboa-bank-api.rest_client",
        `thread-${i}`,
        "application=balboa-bank",
      ),
      `Invoking REST service document-store (x) call to PUT ${url}`,
      head(
        `2026-05-15 11:00:${String(i % 60).padStart(2, "0")}.500`,
        "INFO ",
        "runtimelog.balboa-bank.balboa-bank-api.rest_client",
        `thread-${i}`,
        "application=balboa-bank",
      ),
      `REST service document-store (x) call to PUT ${url} successful executed in 5 [ms]. ` +
        "Response status was 200 ",
    );
  }
  const big = analyse([{ file: "many.log", text: lines.join("\n") }]);
  const flow = buildFlow(big.records, big.spans, [DOSSIER]);
  assertEquals(flow.steps.length, MAX_STEPS);
  assertEquals(flow.total, MAX_STEPS + 7);
  assertEquals(flow.truncated, 7);
});

/* ----------------------------- flowMermaid ----------------------------- */

Deno.test("flowMermaid: declares participants under generated aliases", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  const text = flowMermaid(flow);
  const lines = text.split("\n");
  assertEquals(lines[0], "sequenceDiagram");
  assert(
    lines.includes("    participant P0 as balboa-bank"),
    "hyphenated service names are safe behind a P<n> alias",
  );
  assert(lines.includes("    participant P2 as document-store"), "every lane is declared");
});

Deno.test("flowMermaid: picks the arrow from how the call turned out", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  const text = flowMermaid(flow);
  assert(text.includes("P0->>P1: GET "), "a request is a solid arrow");
  assert(text.includes("P1-->>P0: 200 · 146 ms"), "a 2xx returns with a dashed arrow");
  assert(text.includes("P2--xP1: 500 · 1.2 s"), "a failure returns crossed");
  assert(
    text.includes("Note over P2: no response logged"),
    "an unanswered call gets a note, never a return arrow it did not send",
  );
});

Deno.test("flowMermaid: an unanswered call draws no return arrow", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  const returns = flowMermaid(flow).split("\n").filter((line) =>
    line.includes("-->>") || line.includes("--x")
  );
  assertEquals(returns.length, 2, "two of the three calls answered");
});

Deno.test("flowMermaid: an empty flow is an empty string, not a bare header", () => {
  assertEquals(flowMermaid(buildFlow(model.records, model.spans, [])), "");
});

Deno.test("flowMermaid: says when the cap hid calls", () => {
  const flow = buildFlow(model.records, model.spans, [DOSSIER]);
  assert(!flowMermaid(flow).includes("further calls"), "nothing hidden, nothing claimed");
  const capped = { ...flow, truncated: 12 };
  assert(
    flowMermaid(capped).includes("Note over P0: 12 further calls not shown"),
    "a truncated diagram admits it",
  );
});

/* ------------------------------- laneKey ------------------------------- */

Deno.test("laneKey: folds case and drops separators", () => {
  assertEquals(laneKey("baloiseId"), "baloiseid");
  assertEquals(laneKey("baloise-id"), "baloiseid");
  assertEquals(laneKey("baloise_id"), "baloiseid");
  assertEquals(laneKey("BALOISE ID"), "baloiseid");
  assertEquals(laneKey("m_IDeal"), "mideal");
});

Deno.test("laneKey: keeps genuinely different services apart", () => {
  assert(
    laneKey("document-store") !== laneKey("document-store-v2"),
    "a version suffix is a different service, not a spelling of the same one",
  );
  assert(laneKey("baloise-id") !== laneKey("balboa-bank"), "unrelated names stay unrelated");
});

Deno.test("laneKey: a name of only separators keeps itself rather than keying empty", () => {
  // Otherwise every such lane would collapse into one.
  assertEquals(laneKey("---"), "---");
  assertEquals(laneKey("__"), "__");
  assert(laneKey("---") !== laneKey("__"), "and they stay apart from each other");
});

/* ------------------------------- shortUrl ------------------------------- */

Deno.test("shortUrl: keeps the path and query, truncating from the left", () => {
  assertEquals(shortUrl("https://host/a/b?x=1"), "/a/b?x=1");
  const long = `https://host/baloise-id/api/baloiseid/cases/${CASE}/files.zip`;
  const short = shortUrl(long);
  assert(short.startsWith("…"), "a long path is cut at the front");
  assert(short.endsWith("/files.zip"), "the end identifies the call, so it survives");
});

Deno.test("shortUrl: hands back what it cannot parse", () => {
  assertEquals(shortUrl("/relative/path"), "/relative/path");
  assertEquals(shortUrl("{baseUrl}/cases/{id}"), "{baseUrl}/cases/{id}");
});

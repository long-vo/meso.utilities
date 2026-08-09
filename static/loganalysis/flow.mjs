// @ts-check
/**
 * meso.utilities — Log Analysis: the selected identifiers' REST calls as a
 * sequence of service-to-service steps, ready to be drawn as a sequence diagram
 * or emitted as Mermaid source.
 *
 * Three decisions shape everything here:
 *
 * 1. **A span joins the flow when *any* of its records mentions a selected id.**
 *    A REST call is four records — `Invoking …`, `>> POST …` with headers and
 *    body, the completion line, `<< 200` with the response — and the dossier id
 *    is usually in the *body*, not the invoking line. Testing only the record
 *    that opened the span would drop most of the calls worth seeing.
 * 2. **Only the identifier selection is honoured — never the other filters.**
 *    The point of the diagram is a complete picture of one dossier's traffic.
 *    Narrowing the timeline to ERROR is exactly when you want the flow intact,
 *    and a sequence diagram of two orphan arrows explains nothing. This matches
 *    the density strip and the facet counts, both of which read the whole parsed
 *    set (see the note on `facetCounts`).
 * 3. **Lanes are first-appearance order, and the caller is the *app*.** The
 *    logs name the callee (`Invoking REST service baloise-id …`) but never the
 *    caller, so the caller lane comes from the record's own `app`, falling back
 *    to its file — a foreign or loosely-parsed log has no app, and the filename
 *    is the honest name for it rather than a blank column.
 * 4. **One system's two spellings are one lane.** A service is named twice in a
 *    merged log: by itself, in its own records (`application=baloise-id`), and by
 *    whoever calls it, from that caller's REST client config
 *    (`Invoking REST service baloiseId`). Keyed on the literal string those
 *    become two lanes, and the diagram falls into disconnected halves —
 *    `balboa-bank-sob → baloiseId` beside `baloise-id → m_IDeal`, with nothing
 *    joining them, which is precisely the chain the view exists to show. So lanes
 *    are keyed on {@link laneKey} and the system's own name for itself wins the
 *    label.
 *
 * Alias linking is deliberately *not* applied. The Identifiers filter is a
 * literal `record.ids.includes(id)` test — the dossier-to-case linking only ever
 * affected grouping — so a flow driven by that selection matches the timeline
 * beside it. Expanding through aliases here would show calls the filter it came
 * from would not.
 *
 * Dual-consumption: imported unchanged by `static/loganalysis/app.js` and by
 * `src/flow.test.ts`.
 */

import { formatMs, shortUrl } from "./loganalysis.mjs";

/**
 * How many steps a diagram will draw.
 *
 * A busy dossier runs to a few hundred calls; past this the diagram is a
 * scrollbar with arrows in it, and the honest move is to say so rather than
 * render for a minute. The count that was dropped is reported so the view can.
 */
export const MAX_STEPS = 200;

/**
 * The lane an inbound message with no named sender arrives from.
 *
 * The upstream pushing into `baloise-id` is nowhere in these logs — a receiver
 * logs what it got, not who dialled it — so the diagram says "from outside these
 * logs" rather than inventing a system name for it.
 */
export const INBOUND_LANE = "inbound";

/**
 * @typedef {Object} FlowStep
 * @property {"rest" | "webhook"} kind an outbound call, or a message received
 * @property {number} from index into {@link Flow.participants} — the caller
 * @property {number} to index into {@link Flow.participants} — the service called
 * @property {string} method `POST`, or `""` for an inbound message
 * @property {string} url the full URL, for a tooltip; `""` for an inbound message
 * @property {string} label `POST /baloiseid/cases`, or the notification type
 * @property {string} result `201 · 342 ms`, `500 · 1.2 s`, `no response logged`,
 *   `VERIFICATION_PENDING · 13.1 s`
 * @property {number | null} status
 * @property {number | null} ms
 * @property {boolean} complete a completion line was found
 * @property {boolean} ok completed well — a 2xx, or a webhook that was handled
 * @property {string} tsText when the call was invoked, or the message arrived
 * @property {number | null} ts the same moment in ms, for placing an activation bar
 * @property {number | null} endTs when a webhook's handling finished, in ms
 * @property {string} endTsText that moment as the log wrote it, `""` for a REST step
 * @property {number | null} spanId index into the span list, for a REST step
 * @property {number | null} eventId index into the event list, for an inbound step
 */

/**
 * @typedef {Object} Flow
 * @property {string[]} participants lane names, in order of first appearance
 * @property {FlowStep[]} steps in log order, capped at {@link MAX_STEPS}
 * @property {number} total steps before the cap
 * @property {number} truncated how many the cap dropped
 * @property {number} failed steps that failed or went unanswered
 * @property {number} calls REST calls among the steps
 * @property {number} inbound messages received among the steps
 */

/**
 * The lane a record's application occupies.
 * @param {{ app?: string, file?: string }} record
 * @returns {string}
 */
function callerOf(record) {
  return record.app || record.file || "unknown";
}

/**
 * The key two spellings of one system share: case folded, separators dropped, so
 * `baloiseId`, `baloise-id` and `baloise_id` all key as `baloiseid`.
 *
 * Deliberately blunt. The names being reconciled are a service's own application
 * name and the alias a caller's REST client was configured with, and across these
 * logs they differ by exactly this much — case and hyphens. Anything cleverer
 * (prefix or edit-distance matching) starts merging `document-store` with
 * `document-store-v2`, which are two real services.
 *
 * A name made only of separators would key as the empty string and pull every
 * such lane together, so those keep their literal name instead.
 * @param {string} name
 * @returns {string}
 */
export function laneKey(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") || String(name ?? "");
}

/**
 * How a call turned out, in the words the diagram prints beside its return
 * arrow. An incomplete span is not a failure with a missing status — it is a
 * call nothing ever answered, which is its own finding and reads as one.
 * @param {{ complete: boolean, status: number | null, ms: number | null }} span
 * @returns {string}
 */
function resultOf(span) {
  if (!span.complete) return "no response logged";
  const status = span.status ?? "?";
  const took = span.ms === null ? "" : ` · ${formatMs(span.ms)}`;
  return `${status}${took}`;
}

/**
 * Build the sequence for a set of selected identifiers.
 *
 * Two sources, one timeline. An outbound REST call and an inbound webhook are the
 * same thing to a reader — a message between two systems at a moment — so they
 * are merged and sorted by the record that opened them rather than kept in
 * separate passes. That sort is also what puts the lanes in time order: lanes are
 * assigned as the merged sequence is walked, so a diagram of a log whose first
 * event is an inbound notification opens with the `inbound` lane, not with
 * whichever app happened to make the first REST call.
 *
 * `records`, `spans` and `events` are the whole parsed set, not a filtered one —
 * see the module note. With no ids selected the flow is empty by design: the view
 * says so and points at the Identifiers field, which is a better answer than
 * drawing every message in the log as one unreadable diagram.
 * @param {import("./loganalysis.mjs").LogRecord[]} records the merged set
 * @param {import("./loganalysis.mjs").RestSpan[]} spans
 * @param {string[]} ids the selected identifier values
 * @param {import("./webhooks.mjs").WebhookEvent[]} [events] inbound messages
 * @returns {Flow}
 */
export function buildFlow(records, spans, ids, events = []) {
  /** @type {Flow} */
  const empty = {
    participants: [],
    steps: [],
    total: 0,
    truncated: 0,
    failed: 0,
    calls: 0,
    inbound: 0,
  };
  const anySpans = spans && spans.length;
  const anyEvents = events && events.length;
  if (!ids || ids.length === 0 || (!anySpans && !anyEvents)) return empty;

  const wanted = new Set(ids);
  /** @type {string[]} */
  const participants = [];
  /** @type {Map<string, number>} */
  const laneAt = new Map();
  /** Lanes already labelled by the system's own application name. */
  /** @type {Set<string>} */
  const named = new Set();
  /**
   * The lane for a participant, merging the two spellings of one system.
   *
   * `own` marks the name as the system's own — the application it logs under,
   * rather than the alias a caller knows it by. That name wins the label even if
   * the alias got there first, because it is the one the rest of the tool shows:
   * the application filter, the record rows and the group headers all say
   * `baloise-id`, and a lane reading `baloiseId` beside them looks like a
   * different box.
   * @param {string} name
   * @param {boolean} own
   */
  const lane = (name, own) => {
    const key = laneKey(name);
    let at = laneAt.get(key);
    if (at === undefined) {
      at = participants.length;
      participants.push(name);
      laneAt.set(key, at);
      if (own) named.add(key);
      return at;
    }
    if (own && !named.has(key)) {
      participants[at] = name;
      named.add(key);
    }
    return at;
  };

  // Merged and sorted before any lane is assigned — see the note above.
  /** @type {{ at: number, span?: any, event?: any }[]} */
  const sources = [];
  for (const span of spans ?? []) {
    if (span.records.length) sources.push({ at: span.records[0], span });
  }
  for (const event of events ?? []) {
    if (event.records.length) sources.push({ at: event.records[0], event });
  }
  sources.sort((a, b) => a.at - b.at);

  /** @type {FlowStep[]} */
  const steps = [];
  let total = 0;

  for (const source of sources) {
    // `records[i]` and `record.i` agree by construction — mergeSources numbers
    // records by their merged position.
    /** @type {import("./loganalysis.mjs").LogRecord[]} */
    const own = [];
    for (const i of (source.span ?? source.event).records) {
      const record = records[i];
      if (record) own.push(record);
    }
    if (own.length === 0) continue;
    if (!own.some((record) => record.ids.some((id) => wanted.has(id)))) continue;

    total++;
    if (steps.length >= MAX_STEPS) continue;

    if (source.span) {
      const span = source.span;
      steps.push({
        kind: "rest",
        // The invoking record is the one that names the caller.
        from: lane(callerOf(own[0]), true),
        to: lane(span.service, false),
        method: span.method,
        url: span.url,
        label: `${span.method} ${shortUrl(span.url)}`,
        result: resultOf(span),
        status: span.status,
        ms: span.ms,
        complete: span.complete,
        ok: span.ok,
        tsText: span.tsText,
        ts: own[0].ts,
        // A REST call's wait is already drawn as its request/response pair, so it
        // grows no activation bar — one would restate the arrows above it.
        endTs: null,
        endTsText: "",
        spanId: span.id,
        eventId: null,
      });
      continue;
    }

    const event = source.event;
    // The receiver logs the message, so *it* is the record's own application —
    // the reverse of a REST call, where the record's app is the caller.
    steps.push({
      kind: "webhook",
      from: lane(event.from || INBOUND_LANE, false),
      to: lane(event.to, true),
      method: "",
      url: "",
      label: event.label,
      result: event.result,
      status: null,
      ms: event.ms,
      // A notification is owed no acknowledgement, so it is complete on arrival;
      // only a webhook can be left hanging.
      complete: event.kind === "notification" || event.handled,
      ok: event.kind === "notification" || event.handled,
      tsText: event.tsText,
      ts: own[0].ts,
      endTs: event.endTs,
      endTsText: event.endTsText,
      spanId: null,
      eventId: event.id,
    });
  }

  return {
    participants,
    steps,
    calls: steps.filter((step) => step.kind === "rest").length,
    inbound: steps.filter((step) => step.kind === "webhook").length,
    total,
    truncated: total - steps.length,
    failed: steps.filter((step) => !step.complete || !step.ok).length,
  };
}

/**
 * The flow as Mermaid `sequenceDiagram` source, for pasting into a Jira comment
 * or a Confluence page — both of which render it.
 *
 * Participants are declared under generated `P0`/`P1` aliases rather than their
 * own names: a service named with a hyphen, a dot or a space is legal in these
 * logs and would break the diagram if written as a bare Mermaid identifier.
 *
 * A failed response uses `--x` (Mermaid's crossed arrow) and an unanswered call
 * gets no return arrow at all, only a note — drawing one would claim a response
 * that never came.
 *
 * An inbound message is one arrow, not two, and an async one (`-)`): nothing was
 * sent back to its sender. Its outcome — the status it carried, how long the
 * receiver took, whether it was ignored — rides in the arrow's own text instead
 * of a return arrow, since a `Handled` line is the receiver finishing work, not
 * a reply.
 * @param {Flow} flow
 * @returns {string}
 */
export function flowMermaid(flow) {
  if (!flow || flow.steps.length === 0) return "";
  const lines = ["sequenceDiagram"];
  flow.participants.forEach((name, at) => {
    lines.push(`    participant P${at} as ${name}`);
  });
  for (const step of flow.steps) {
    const from = `P${step.from}`;
    const to = `P${step.to}`;
    if (step.kind === "webhook") {
      lines.push(`    ${from}-)${to}: ${step.label} · ${step.result}`);
      continue;
    }
    lines.push(`    ${from}->>${to}: ${step.label}`);
    if (!step.complete) lines.push(`    Note over ${to}: ${step.result}`);
    else lines.push(`    ${to}${step.ok ? "-->>" : "--x"}${from}: ${step.result}`);
  }
  if (flow.truncated) {
    lines.push(`    Note over P0: ${flow.truncated} further calls not shown`);
  }
  return lines.join("\n");
}

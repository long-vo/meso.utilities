// @ts-check
/**
 * meso.utilities — Log Analysis: turn flat log files into grouped, filterable
 * sequences. Two formats are parsed as first-class records: Axon Ivy logs
 * (`[ts][LEVEL][logger][thread]{mdc}` headers) and the Spring Boot console
 * output of the e-portal pods (see {@link SPRING_HEAD_RE}); anything else
 * degrades to timestamp-led records so a foreign file still merges.
 *
 * The unit here is the *record*, not the line. An Ivy log writes a header line
 * (timestamp, level, logger, thread, MDC) followed by a body that runs until the
 * next header — and the bodies are where the interesting things live: a
 * `class BaloiseIdNotificationRequest { … }` dump, a JSON payload, a REST
 * envelope. Splitting on newlines turns one event into forty orphan lines, so
 * everything below works on records that keep their body attached. A Spring
 * record inverts that shape — its message rides on the header line and only
 * stack traces continue below — which is what the {@link LogRecord.msg} field
 * absorbs.
 *
 * Two ideas carry the rest of the module:
 *
 * 1. **Identifiers are indexed by value, not by label.** One case id shows up as
 *    `caseIds [5a3c…]`, as `"ubiIdCaseId":"5a3c…"`, inside the URL
 *    `/baloiseid/cases/5a3c…/files.zip` and inside the filename
 *    `front_5a3c….jpg`. A label-driven filter misses the last two. So labelled
 *    occurrences teach us what an id *is called*, a bare-UUID sweep finds it
 *    everywhere else, and filtering matches the value.
 * 2. **Aliases link the apps together.** A record carrying both
 *    `ubiIdCaseId: 8df4…` and `extCaseId: 5dad…` teaches us that case belongs to
 *    that dossier, which lets records mentioning only the case id join the
 *    dossier's group. That is what makes three separate app logs read as one
 *    story. The linking follows a deliberately narrow label allow-list: link on
 *    `extPersonId` or `documentId` too and every dossier collapses into one blob.
 *
 * Dual-consumption: imported unchanged by `static/loganalysis/app.js` and by
 * `src/loganalysis.test.ts`.
 */

/** Canonical levels, most severe first — the order filter chips render in. */
export const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

/** Spellings that mean one of {@link LEVELS} under a different name. */
const LEVEL_ALIASES = { FATAL: "ERROR", SEVERE: "ERROR", WARNING: "WARN" };

/**
 * A full Ivy header: `[ts][LEVEL][logger][thread]{mdc}`. The level is padded to
 * five characters in the source (`INFO `), and the MDC braces are optional
 * because a few platform loggers emit none.
 */
const HEAD_RE =
  /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\]\[([A-Za-z]+)\s*\]\[([^\]]*)\]\[([^\]]*)\](?:\s*\{(.*)\})?\s*$/;

/**
 * A Spring Boot console header, as the e-portal services write it:
 *
 *   2026-08-07T08:00:18.831Z  INFO 7 --- [           main] o.s.c.SomeClass : msg
 *   2026-08-07T08:02:51.302Z [a31d…][22c4…][-] INFO 7 --- [e-portal-api] [nio-8080-exec-5] b.SomeClass : msg
 *
 * The optional bracket run before the level is the team's logback MDC prefix,
 * `[%X{traceId}][%X{dossierId}][%X{userId}]` — see {@link parseBracketMdc}. The
 * level is right-aligned (`%5p`), so a five-letter ERROR sits flush against the
 * brackets with no space, which is why the gap is `\s*`. After `---` come one
 * bracket group (the thread) or two (application name, then thread) — the
 * application group demands two so a lone `[main]` backtracks into the thread
 * slot. Unlike Ivy, the message rides on the header line itself; only stack
 * traces continue below.
 */
const SPRING_HEAD_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}(?:Z|[+-]\d{2}:?\d{2})?)\s*((?:\[[^\]]*\])*)\s*(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\d+\s+---\s+(?:\[([^\]]+)\]\s+)?\[\s*([^\]]*?)\s*\]\s+(\S+)\s+:\s?(.*)$/;

/**
 * The e-portal's positional MDC slots. A `-` is logback's empty marker
 * (`%X{traceId:--}`), so it counts as absent; slots beyond the known three keep
 * a positional name rather than being dropped.
 * @param {string} run the bracket run, e.g. `[a31d…][22c4…][-]`
 * @returns {Record<string, string>}
 */
export function parseBracketMdc(run) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!run) return out;
  const names = ["traceId", "dossierId", "userId"];
  run.slice(1, -1).split("][").forEach((value, i) => {
    const text = value.trim();
    if (text && text !== "-") out[names[i] ?? `mdc${i + 1}`] = text;
  });
  return out;
}

/**
 * A line that opens a record in some *other* log format — a leading timestamp,
 * bracketed or bare. Anchored with no tolerance for leading whitespace, which is
 * what stops an indented `createdTime: 2026-05-15T08:09:50` inside a body dump
 * from being mistaken for a new record.
 */
const LOOSE_HEAD_RE = /^\[?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\]?[\s|]*/;

const LEVEL_RE = /\b(FATAL|SEVERE|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\b/;

/** Characters of a loose line searched for a level, so a body word can't retag it. */
const HEAD_CHARS = 200;

/**
 * Split an MDC blob into key/value pairs.
 *
 * The separator is a comma *followed by another key*, not a bare comma: values
 * themselves contain commas and parens — `executionContext=2642 (anonymous)`,
 * `session=0 SYSTEM`, request paths carrying `(6420079.6475202.0.0)`. Splitting
 * on `", "` alone shreds those.
 * @param {string} blob
 * @returns {Record<string, string>}
 */
export function parseMdc(blob) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!blob) return out;
  for (const part of blob.split(/,\s(?=[A-Za-z][\w.]*=)/)) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/**
 * Pull the application, process model version and category out of a logger name.
 *
 * Ivy's own `runtimelog.<app>.<pmv>.<category>` carries all three. Anything else
 * is a platform logger (`ch.ivyteam.ivy.cm.internal.…`, `javax.mail`,
 * `org.apache.http.…`); those get the application from the MDC and a single
 * `platform` category, so the category chips stay a short, meaningful list
 * instead of one entry per framework class.
 * @param {string} logger
 * @param {Record<string, string>} mdc
 */
export function splitLogger(logger, mdc = {}) {
  const parts = String(logger ?? "").split(".");
  if (parts[0] === "runtimelog" && parts.length >= 3) {
    return { app: parts[1], pmv: parts[2], category: parts.slice(3).join(".") || "runtime" };
  }
  return { app: unmasked(mdc.application), pmv: unmasked(mdc.pmv), category: "platform" };
}

/**
 * An MDC value the sanitizer has replaced with a run of asterisks counts as
 * absent. Without this, a censored log — which is the only kind that gets shared
 * on a ticket — grows an `***********` chip in the application filter, which
 * names nothing and matches everything the platform loggers touched.
 * @param {string | undefined} value
 * @returns {string}
 */
function unmasked(value) {
  const text = String(value ?? "");
  return /^\*+$/.test(text) ? "" : text;
}

/**
 * Milliseconds for an Ivy timestamp, or null when it cannot be read.
 *
 * Parsed as local time deliberately: the logs carry no zone, and only
 * *differences* (durations, ordering) are used numerically. Everything displayed
 * comes from {@link LogRecord.tsText}, the untouched source text, so no reader
 * ever sees a clock this function shifted.
 * @param {string} text
 * @returns {number | null}
 */
export function parseTimestamp(text) {
  const iso = String(text ?? "").replace(" ", "T").replace(",", ".");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The level a line announces, or null. Uppercase only: lower-case "error" in
 * prose is a message, not a level.
 * @param {string} line
 * @returns {string | null}
 */
export function detectLevel(line) {
  const match = LEVEL_RE.exec(String(line ?? "").slice(0, HEAD_CHARS));
  if (!match) return null;
  return LEVEL_ALIASES[/** @type {keyof typeof LEVEL_ALIASES} */ (match[1])] ?? match[1];
}

/**
 * @typedef {Object} LogRecord
 * @property {number} i index within the merged set, assigned by {@link mergeSources}
 * @property {string} file source file name
 * @property {number} line 1-based line number of the header
 * @property {number | null} ts milliseconds, for ordering and durations only
 * @property {string} tsText the timestamp exactly as logged
 * @property {string | null} level
 * @property {string} logger
 * @property {string} app
 * @property {string} pmv
 * @property {string} category
 * @property {string} thread
 * @property {Record<string, string>} mdc
 * @property {string} head the header line verbatim
 * @property {string} body everything under the header, newline-joined
 * @property {string} msg the message when the format puts it on the header line
 *   (Spring); "" for formats whose message is the body (Ivy)
 * @property {string[]} ids identifier values mentioned anywhere in the record
 * @property {{ label: string, value: string }[]} labelled labelled id occurrences
 * @property {number} span index into the span list, or -1
 */

/**
 * Header + body, which is what search runs over.
 * @param {LogRecord} record
 * @returns {string}
 */
export function recordText(record) {
  return record.body ? `${record.head}\n${record.body}` : record.head;
}

/**
 * The one-line summary a row shows: the header-line message when the format
 * carries one (Spring), otherwise the first meaningful line of the body.
 * Collapsed to single spaces and capped, because a JSON payload's first line can
 * be four thousand characters wide.
 * @param {LogRecord} record
 * @param {number} [cap]
 */
export function recordSummary(record, cap = 200) {
  const first = record.msg ||
    (record.body.split("\n").find((line) => line.trim() !== "") ?? "");
  const flat = first.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/**
 * Parse one log file into records.
 *
 * Four tiers, tried per line: a full Ivy header; a Spring Boot console header
 * (the e-portal pod logs); failing those a bare leading timestamp (some other
 * tool's format), which still yields a time and a level; failing that the line
 * belongs to the record above it. A file whose very first line is none of these
 * gets a synthetic record so nothing is silently dropped — this tool has to
 * show whatever it is handed.
 * @param {string} text
 * @param {string} [file]
 * @returns {LogRecord[]}
 */
export function parseRecords(text, file = "log") {
  /** @type {LogRecord[]} */
  const records = [];
  /** @type {string[]} */
  let body = [];
  const flush = () => {
    if (records.length) records[records.length - 1].body = body.join("\n").replace(/\s+$/, "");
    body = [];
  };

  const lines = String(text ?? "").split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const strict = HEAD_RE.exec(line);
    if (strict) {
      flush();
      const mdc = parseMdc(strict[5] ?? "");
      const { app, pmv, category } = splitLogger(strict[3], mdc);
      records.push({
        i: records.length,
        file,
        line: n + 1,
        ts: parseTimestamp(strict[1]),
        tsText: strict[1],
        level: detectLevel(strict[2]) ?? strict[2].trim().toUpperCase(),
        logger: strict[3],
        app,
        pmv,
        category,
        thread: strict[4],
        mdc,
        head: line,
        body: "",
        msg: "",
        ids: [],
        labelled: [],
        span: -1,
      });
      continue;
    }
    const spring = SPRING_HEAD_RE.exec(line);
    if (spring) {
      flush();
      const mdc = parseBracketMdc(spring[2]);
      const app = spring[4] ?? "";
      if (app) mdc.application = app;
      records.push({
        i: records.length,
        file,
        line: n + 1,
        ts: parseTimestamp(spring[1]),
        // Normalised for display only (`head` keeps the line verbatim): the
        // shared `T`/`Z`-less shape is what lets `.slice(11)` cut a clean
        // time out of Ivy and Spring records alike.
        tsText: spring[1].replace("T", " ").replace(/Z$/, ""),
        level: detectLevel(spring[3]) ?? spring[3],
        logger: spring[6],
        app,
        pmv: "",
        // One chip per class, not per abbreviated package path — `o.s.c.g.…`
        // prefixes differ per depth and would shred the logger facet.
        category: spring[6].split(".").pop() ?? "",
        thread: spring[5],
        mdc,
        head: line,
        body: "",
        msg: spring[7] ?? "",
        ids: [],
        labelled: [],
        span: -1,
      });
      continue;
    }
    const loose = LOOSE_HEAD_RE.exec(line);
    if (loose) {
      flush();
      records.push({
        i: records.length,
        file,
        line: n + 1,
        ts: parseTimestamp(loose[1]),
        tsText: loose[1],
        level: detectLevel(line),
        logger: "",
        app: "",
        pmv: "",
        category: "",
        thread: "",
        mdc: {},
        head: line,
        body: "",
        msg: "",
        ids: [],
        labelled: [],
        span: -1,
      });
      continue;
    }
    if (records.length === 0) {
      if (line.trim() === "") continue;
      records.push({
        i: 0,
        file,
        line: n + 1,
        ts: null,
        tsText: "",
        level: detectLevel(line),
        logger: "",
        app: "",
        pmv: "",
        category: "",
        thread: "",
        mdc: {},
        head: line,
        body: "",
        msg: "",
        ids: [],
        labelled: [],
        span: -1,
      });
      continue;
    }
    body.push(line);
  }
  flush();
  return records;
}

/**
 * Merge the records of several files into one timeline.
 *
 * Ordering is by timestamp, then by the order the files were given, then by line
 * — so two records logged in the same millisecond (which happens constantly:
 * `Invoking…` and `>> POST…` share a timestamp) keep their original sequence
 * instead of shuffling. A record with no readable timestamp inherits the one
 * above it so it stays where it was written rather than sinking to the top.
 * A source may carry `offsetMs`, which shifts its records' *numeric* clocks in
 * the merge — the fix for one incident logged by Ivy in local time and by the
 * pods in UTC. Displayed text stays exactly as logged; only ordering, deltas
 * and the window move.
 * @param {{ file: string, text: string, offsetMs?: number }[]} sources
 * @returns {LogRecord[]}
 */
export function mergeSources(sources) {
  /** @type {{ record: LogRecord, source: number }[]} */
  const all = [];
  (sources ?? []).forEach((source, index) => {
    const offset = source.offsetMs ?? 0;
    let last = /** @type {number | null} */ (null);
    for (const record of parseRecords(source.text, source.file)) {
      if (record.ts !== null && offset) record.ts += offset;
      if (record.ts === null) record.ts = last;
      else last = record.ts;
      all.push({ record, source: index });
    }
  });
  all.sort((a, b) => {
    const at = a.record.ts;
    const bt = b.record.ts;
    if (at !== bt) {
      if (at === null) return -1;
      if (bt === null) return 1;
      return at - bt;
    }
    if (a.source !== b.source) return a.source - b.source;
    return a.record.line - b.record.line;
  });
  return all.map((entry, index) => {
    entry.record.i = index;
    return entry.record;
  });
}

/* ------------------------------ REST spans ------------------------------ */

const INVOKE_RE = /^Invoking REST service (.+?) \(([^)]*)\) call to ([A-Z]+) (\S+)/;
const DONE_RE =
  /^REST service (.+?) \(([^)]*)\) call to ([A-Z]+) (\S+) (.+?) in ([\d.,]+) \[(ms|s)\]\./;
const STATUS_RE = /Response status was (\d+)/;
const SEND_RE = /^>> ([A-Z]+) (\S+)/;
const RECV_RE = /^<< (\d+)\b/;

/**
 * @typedef {Object} RestSpan
 * @property {number} id
 * @property {string} service
 * @property {string} method
 * @property {string} url
 * @property {string} file
 * @property {string} thread
 * @property {number | null} status
 * @property {number | null} ms
 * @property {boolean} complete a completion line was found
 * @property {boolean} ok completed with a 2xx
 * @property {string} tsText when the call was invoked
 * @property {number[]} records indices of the records making up the span
 */

/**
 * Milliseconds for a duration written as `257 [ms]` or `1 [s]`.
 * @param {string} value
 * @param {string} unit
 * @returns {number | null}
 */
function durationMs(value, unit) {
  const n = Number(String(value).replace(",", "."));
  if (Number.isNaN(n)) return null;
  return unit === "s" ? Math.round(n * 1000) : Math.round(n);
}

/**
 * Fold each REST call's four records into one span.
 *
 * A call is logged as `Invoking REST service …` → `>> POST …` (headers, body) →
 * `REST service … in 342 [ms]. Response status was 200` → `<< 200` (headers,
 * body). Pairing is per file *and* thread, tracking the open call on that
 * thread: within one thread the four lines are strictly sequential, and across
 * threads the same URL is called concurrently all over these logs, so a
 * URL-keyed map would cross the wires.
 *
 * `records[].span` is set as a side effect, which is what lets a row render as
 * part of its call. An `Invoking` that never completes stays `complete: false` —
 * exactly the trace a hung integration leaves behind, and worth surfacing.
 * @param {LogRecord[]} records
 * @returns {RestSpan[]}
 */
export function foldRestSpans(records) {
  /** @type {RestSpan[]} */
  const spans = [];
  /** @type {Map<string, number>} */
  const open = new Map();
  /** @type {Map<string, number>} */
  const justClosed = new Map();

  for (const record of records) {
    const lane = `${record.file}\0${record.thread}`;
    const first = recordSummary(record, 4000);

    const invoke = INVOKE_RE.exec(first);
    if (invoke) {
      const span = {
        id: spans.length,
        service: invoke[1],
        method: invoke[3],
        url: invoke[4],
        file: record.file,
        thread: record.thread,
        status: /** @type {number | null} */ (null),
        ms: /** @type {number | null} */ (null),
        complete: false,
        ok: false,
        tsText: record.tsText,
        records: [record.i],
      };
      spans.push(span);
      open.set(lane, span.id);
      record.span = span.id;
      continue;
    }

    const done = DONE_RE.exec(first);
    if (done) {
      const id = open.get(lane);
      const span = id === undefined ? null : spans[id];
      if (span && span.method === done[3] && span.url === done[4]) {
        span.complete = true;
        span.ms = durationMs(done[6], done[7]);
        const status = STATUS_RE.exec(first);
        span.status = status ? Number(status[1]) : null;
        span.ok = span.status !== null && span.status >= 200 && span.status < 300;
        span.records.push(record.i);
        record.span = span.id;
        open.delete(lane);
        justClosed.set(lane, span.id);
      }
      continue;
    }

    const send = SEND_RE.exec(first);
    if (send) {
      const id = open.get(lane);
      if (id !== undefined && spans[id].method === send[1] && spans[id].url === send[2]) {
        spans[id].records.push(record.i);
        record.span = id;
      }
      continue;
    }

    if (RECV_RE.test(first)) {
      const id = justClosed.get(lane);
      if (id !== undefined) {
        spans[id].records.push(record.i);
        record.span = id;
        justClosed.delete(lane);
      }
    }
  }
  return spans;
}

/**
 * @typedef {Object} ServiceStats
 * @property {string} service
 * @property {number} calls
 * @property {number} failed answered, but not with a 2xx
 * @property {number} unanswered never answered at all
 * @property {number | null} p50 null when no call has a readable duration
 * @property {number | null} p95
 * @property {number} maxMs
 * @property {RestSpan | null} slowest
 */

/**
 * Nearest-rank percentile of an ascending list: the value at position
 * `ceil(q · n)`, 1-based.
 *
 * Spelled out rather than borrowed because percentile definitions genuinely
 * differ — linear interpolation would report a p95 that no single call ever
 * took, and a latency figure a reader cannot find in the table below it is worse
 * than none. This one always names a real observation.
 * @param {number[]} ascending
 * @param {number} q
 * @returns {number | null}
 */
function percentile(ascending, q) {
  if (ascending.length === 0) return null;
  const rank = Math.ceil(q * ascending.length);
  return ascending[Math.min(ascending.length - 1, Math.max(0, rank - 1))];
}

/**
 * Roll {@link foldRestSpans}'s output up per service.
 *
 * `failed` and `unanswered` stay separate counts on purpose: a 500 answered and
 * said it broke, a hung call said nothing at all, and the two send you looking
 * in different places. Calls with no readable duration count towards `calls` but
 * are kept out of the percentiles — folding them in as 0 ms would report a hung
 * integration as the fastest thing in the log.
 *
 * Rows come back busiest-first, matching {@link facetCounts}'s ordering, since
 * the table that renders them offers its own sorting anyway.
 * @param {RestSpan[]} spans
 * @returns {ServiceStats[]}
 */
export function restStats(spans) {
  /** @type {Map<string, RestSpan[]>} */
  const byService = new Map();
  for (const span of spans ?? []) {
    const list = byService.get(span.service);
    if (list) list.push(span);
    else byService.set(span.service, [span]);
  }

  return [...byService.entries()]
    .map(([service, list]) => {
      const durations = list
        .map((span) => span.ms)
        .filter((ms) => /** @type {number | null} */ (ms) !== null)
        .sort((a, b) => /** @type {number} */ (a) - /** @type {number} */ (b));
      let slowest = /** @type {RestSpan | null} */ (null);
      for (const span of list) {
        if (
          span.ms !== null && (slowest === null || span.ms > /** @type {number} */ (slowest.ms))
        ) {
          slowest = span;
        }
      }
      return {
        service,
        calls: list.length,
        failed: list.filter((span) => span.complete && !span.ok).length,
        unanswered: list.filter((span) => !span.complete).length,
        p50: percentile(/** @type {number[]} */ (durations), 0.5),
        p95: percentile(/** @type {number[]} */ (durations), 0.95),
        maxMs: slowest?.ms ?? 0,
        slowest,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.service.localeCompare(b.service));
}

/**
 * One-line label for a span: what it called, how it went, how long it took.
 * @param {RestSpan} span
 * @returns {string}
 */
export function spanSummary(span) {
  const status = span.complete ? (span.status ?? "?") : "no response";
  const took = span.ms === null ? "" : ` · ${formatMs(span.ms)}`;
  return `${span.method} ${span.url} → ${status}${took}`;
}

/**
 * Human duration: `342 ms`, `1.4 s`, `6 m 55 s`, `2 h 5 m`. Raw seconds stop at
 * the minute: nobody reads `414.7 s` as seven minutes.
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function formatMs(ms) {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  // Round to whole seconds first, then split, so 3 599 999 ms can't come out
  // as "59 m 60 s".
  const total = Math.round(ms / 1000);
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m} m ${s} s` : `${m} m`;
  }
  const minutes = Math.round(total / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} m` : `${h} h`;
}

/* ---------------------------- identifiers ---------------------------- */

/**
 * A labelled identifier: a key whose name ends in id/ids/key/keys, and its
 * value. One pattern has to cover four spellings the logs actually use:
 *
 * - `dossierId = 5dad…`   — spaced `=`
 * - `ubiIdCaseId: 8df4…`  — `:` inside a pretty-printed Java dump
 * - `"extCaseId":"5dad…"` — JSON, where a quote closes the *label* before the
 *   colon, which is why the `"?` sits before the separator as well as after
 * - `caseIds [5a3c…]`     — no separator at all, just a bracketed list
 *
 * The bracket alternative requires the bracket rather than accepting any
 * whitespace: `label value` with nothing between them would let the next word in
 * a sentence be read as an id.
 */
const LABELLED_ID_RE =
  /\b([A-Za-z][A-Za-z0-9_]*(?:[Ii][Dd]s?|[Kk]eys?))"?\s*(?:[:=]\s*\[?\s*|\[\s*)"?([A-Za-z0-9][A-Za-z0-9._@-]{4,})"?/g;

/**
 * A UUID anywhere in the text, in group 1.
 *
 * `\b` cannot open this pattern: the logs write `front_5a3c….jpg`, and `_` is a
 * word character, so there is no boundary between it and the UUID — the
 * attachment filenames would go unindexed. A leading non-hex character is
 * matched and discarded instead, which also stops a UUID being found inside a
 * longer hex run. Written with a capture group rather than a lookbehind so the
 * pattern holds on older WebKit.
 */
const BARE_UUID_RE =
  /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})(?![0-9a-fA-F])/g;

/**
 * Values that are never a useful facet: a sanitizer's mask, an absent value, or
 * a bare word with neither a digit nor a hyphen in it (which is how
 * `identificationMethod: AUTO_IDENTIFICATION`-style enums would otherwise
 * arrive, since their keys can end in "id").
 * @param {string} value
 * @returns {boolean}
 */
function usableId(value) {
  if (!value || value.startsWith("*")) return false;
  if (value === "null" || value === "undefined") return false;
  return /[\d-]/.test(value);
}

/**
 * Find the identifiers a record mentions, labelled and bare.
 *
 * Mutates `record.ids` and `record.labelled` — the record is the natural home
 * for this, and every consumer wants it there.
 * @param {LogRecord} record
 */
export function extractIds(record) {
  const text = recordText(record);
  /** @type {Set<string>} */
  const ids = new Set();
  /** @type {{ label: string, value: string }[]} */
  const labelled = [];

  for (const match of text.matchAll(LABELLED_ID_RE)) {
    const value = match[2];
    if (!usableId(value)) continue;
    labelled.push({ label: match[1], value });
    ids.add(value);
  }
  for (const match of text.matchAll(BARE_UUID_RE)) ids.add(match[1]);

  // MDC entries whose key names an id count as labelled occurrences too. The
  // text sweep alone would miss a Spring traceId: the bracket prefix carries no
  // label, and 32 hex characters without dashes match no UUID.
  for (const [key, value] of Object.entries(record.mdc)) {
    if (!/(?:[Ii][Dd]s?|[Kk]eys?)$/.test(key)) continue;
    if (!usableId(value)) continue;
    labelled.push({ label: key, value });
    ids.add(value);
  }

  record.ids = [...ids];
  record.labelled = labelled;
  return record;
}

/**
 * @typedef {Object} IdFacet
 * @property {string} value
 * @property {string[]} labels every name this id has been logged under
 * @property {number} count records mentioning it
 * @property {string[]} files
 * @property {string[]} apps
 * @property {string} firstTs
 * @property {string} lastTs
 */

/**
 * Index every identifier across the merged records.
 *
 * The labels are the point: they are what lets a bare id inside a URL be
 * recognised as a case id later, and they are what the filter list shows so a
 * reader can tell a dossier from a person.
 * @param {LogRecord[]} records
 * @returns {Map<string, IdFacet>}
 */
export function indexIds(records) {
  /** @type {Map<string, IdFacet & { labelSet: Set<string>, fileSet: Set<string>, appSet: Set<string> }>} */
  const index = new Map();
  for (const record of records) {
    for (const value of record.ids) {
      let facet = index.get(value);
      if (!facet) {
        facet = {
          value,
          labels: [],
          count: 0,
          files: [],
          apps: [],
          firstTs: record.tsText,
          lastTs: record.tsText,
          labelSet: new Set(),
          fileSet: new Set(),
          appSet: new Set(),
        };
        index.set(value, facet);
      }
      facet.count++;
      facet.lastTs = record.tsText;
      facet.fileSet.add(record.file);
      if (record.app) facet.appSet.add(record.app);
    }
    for (const { label, value } of record.labelled) {
      index.get(value)?.labelSet.add(label);
    }
  }
  for (const facet of index.values()) {
    facet.labels = [...facet.labelSet];
    facet.files = [...facet.fileSet];
    facet.apps = [...facet.appSet];
  }
  return /** @type {Map<string, IdFacet>} */ (index);
}

/** Labels that name the business case a whole flow belongs to. */
export const DOSSIER_LABELS = ["dossierId", "extCaseId"];

/**
 * Labels naming a sub-case that belongs to one dossier. Kept short on purpose:
 * `extPersonId`, `notificationId` and `documentId` are all shared across
 * dossiers or fan out per document, and linking on them merges unrelated flows
 * into a single useless group. `traceId` qualifies because the e-portal's MDC
 * scopes a trace to one request serving one dossier — it is what lets a stack
 * trace whose dossier slot is empty still join the dossier that request was
 * about (and, like every alias, it obeys the "Link cases" toggle).
 */
export const CASE_LABELS = [
  "ubiIdCaseId",
  "ubiIdcaseId",
  "caseId",
  "caseIds",
  "documentBasketId",
  "traceId",
];

/**
 * Is `label` one of `list`, ignoring case? The logs are inconsistent about it —
 * `ubiIdCaseId` in one app, `ubiIdcaseId` in another's response body.
 * @param {string[]} list
 * @param {string} label
 * @returns {boolean}
 */
function inList(list, label) {
  return list.some((name) => name.toLowerCase() === label.toLowerCase());
}

/**
 * Learn which case ids belong to which dossier.
 *
 * Only records naming exactly one dossier teach anything — a record mentioning
 * two would make the mapping ambiguous, and guessing there is how unrelated
 * dossiers end up merged. First mapping wins, so a later ambiguous record cannot
 * rewrite a link already established.
 * @param {LogRecord[]} records
 * @returns {Map<string, string>} case id → dossier id
 */
export function resolveAliases(records) {
  /** @type {Map<string, string>} */
  const aliases = new Map();
  for (const record of records) {
    const dossiers = new Set(
      record.labelled.filter((p) => inList(DOSSIER_LABELS, p.label)).map((p) => p.value),
    );
    if (dossiers.size !== 1) continue;
    const dossier = [...dossiers][0];
    for (const { label, value } of record.labelled) {
      if (!inList(CASE_LABELS, label)) continue;
      if (value === dossier || aliases.has(value)) continue;
      aliases.set(value, dossier);
    }
  }
  return aliases;
}

/* ------------------------------ grouping ------------------------------ */

/** Grouping dimensions offered by the UI, in selector order. */
export const GROUP_MODES = ["correlation", "problem", "request", "thread", "rest", "none"];

/**
 * Which correlation id a record belongs to.
 *
 * Priority matters. A dossier id logged *in this record* wins outright. Failing
 * that, any id the global index knows to be a dossier id counts — that is how a
 * bare id inside `/baloiseid/cases/5a3c…/files.zip` is recognised. Failing that,
 * a case id resolved through the alias map, so baloise-id's case-only records
 * join their dossier. A case id with no known dossier groups under itself, which
 * still beats dropping it into Unattributed.
 * @param {LogRecord} record
 * @param {Map<string, IdFacet>} index
 * @param {Map<string, string>} aliases
 * @param {boolean} [link] follow the alias map
 * @returns {string | null}
 */
export function correlationOf(record, index, aliases, link = true) {
  /** @param {string} value */
  const labels = (value) => index.get(value)?.labels ?? [];
  const own = record.labelled.find((p) => inList(DOSSIER_LABELS, p.label));
  if (own) return own.value;
  for (const value of record.ids) {
    if (labels(value).some((label) => inList(DOSSIER_LABELS, label))) return value;
  }
  if (link) {
    for (const value of record.ids) {
      const dossier = aliases.get(value);
      if (dossier) return dossier;
    }
  }
  for (const value of record.ids) {
    if (labels(value).some((label) => inList(CASE_LABELS, label))) return value;
  }
  return null;
}

/**
 * How far above a group's own cadence a pause has to sit before it is called
 * out, and the floor below which no pause is worth calling out at all. **Both**
 * conditions apply, and each covers the other's blind spot: the multiple alone
 * would flag nothing in a group whose records arrive in one burst and everything
 * in a group with a steady cadence, while the floor alone would flag a 3 ms
 * pause between records logged microseconds apart. Exported because they are the
 * one judgement call in {@link gapStats} — the numbers a reader may disagree
 * with, rather than something derived.
 */
export const GAP_MULTIPLE = 5;
export const GAP_FLOOR_MS = 1000;

/**
 * Where the time went inside a run of records.
 *
 * The interesting fact about a four-minute dossier flow is rarely its total; it
 * is that three of those minutes passed between two adjacent records while an
 * integration sat waiting. Deltas from the group's start (which the rows already
 * show) cannot surface that — every record after the stall looks equally late.
 * So this measures the step between neighbours and reports which steps are out
 * of character for the group they sit in.
 *
 * Indices name the record a gap sits *before*, never the one it follows, so an
 * index is directly the row that gets the marker and is never 0. Records with no
 * readable clock contribute no gap and do not break the chain — the record after
 * one is measured against the last record that did have a clock.
 * @param {LogRecord[]} records
 * @returns {{ medianMs: number, largestMs: number, largestAt: number, flagged: number[] }}
 */
export function gapStats(records) {
  /** @type {{ at: number, ms: number }[]} */
  const gaps = [];
  let previous = /** @type {number | null} */ (null);
  (records ?? []).forEach((record, index) => {
    if (record.ts === null) return;
    if (previous !== null) gaps.push({ at: index, ms: record.ts - previous });
    previous = record.ts;
  });
  const none = { medianMs: 0, largestMs: 0, largestAt: -1, flagged: /** @type {number[]} */ ([]) };
  if (gaps.length === 0) return none;

  const sorted = gaps.map((gap) => gap.ms).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  let largestMs = 0;
  let largestAt = -1;
  for (const gap of gaps) {
    if (gap.ms > largestMs) {
      largestMs = gap.ms;
      largestAt = gap.at;
    }
  }
  // Every record in the same millisecond is a real group with no gap to name;
  // `largestAt` stays -1 rather than pointing at a zero-length pause.
  const threshold = Math.max(GAP_FLOOR_MS, medianMs * GAP_MULTIPLE);
  return {
    medianMs,
    largestMs,
    largestAt,
    flagged: gaps.filter((gap) => gap.ms >= threshold).map((gap) => gap.at),
  };
}

/**
 * @typedef {Object} LogGroup
 * @property {string} key
 * @property {string} label what the group header shows
 * @property {string[]} sublabels the id's known names, or the request path
 * @property {LogRecord[]} records
 * @property {string} fromTs
 * @property {string} toTs
 * @property {number | null} ms wall time the group covers
 * @property {number} errors
 * @property {number} warns
 * @property {string[]} apps
 * @property {string[]} files
 * @property {number} gapMs the largest pause between two of its records
 * @property {number} gapAt index of the record that pause sits before, or -1
 * @property {number[]} gapFlagged every index whose pause is out of character
 */

/**
 * Bucket records into groups for the chosen mode.
 *
 * Records that match no key land in a trailing "Unattributed" group rather than
 * disappearing: a filter that silently hides records is worse than one that
 * shows you a pile it could not classify. Groups are ordered by when they start,
 * because the reader is following a sequence — except in `problem` mode, which is
 * not a sequence but a ranking, and is ordered worst-first.
 *
 * `problems` is the record-index → cluster map from `problems.mjs`, handed in
 * finished rather than computed here: clustering is only wanted when that mode is
 * on, and taking it as an argument keeps the dependency between the two modules
 * pointing one way.
 * @param {LogRecord[]} records
 * @param {{ mode?: string, index?: Map<string, IdFacet>, aliases?: Map<string, string>,
 *   spans?: RestSpan[], link?: boolean,
 *   problems?: Map<number, { key: string, label: string, topFrame?: string, apps?: string[] }> }} [options]
 * @returns {LogGroup[]}
 */
export function buildGroups(records, options = {}) {
  const {
    mode = "correlation",
    index = new Map(),
    aliases = new Map(),
    spans = [],
    link = true,
    problems = new Map(),
  } = options;

  /** @type {Map<string, LogGroup>} */
  const groups = new Map();
  /** @type {LogRecord[]} */
  const orphans = [];

  for (const record of records) {
    let key = null;
    let label = "";
    /** @type {string[]} */
    let sublabels = [];

    if (mode === "none") {
      key = "all";
      label = "All records";
    } else if (mode === "correlation") {
      key = correlationOf(record, index, aliases, link);
      if (key !== null) {
        label = key;
        sublabels = index.get(key)?.labels ?? [];
      }
    } else if (mode === "request") {
      // Ivy requestIds are per-app counters, so they stay scoped to their
      // file; a W3C traceId is globally unique and deliberately is not — the
      // whole point of a trace is joining one request across pods.
      if (record.mdc.requestId) {
        key = `${record.file}\0${record.mdc.requestId}`;
        label = `requestId ${record.mdc.requestId}`;
        sublabels = [record.mdc.request || record.file].filter(Boolean);
      } else if (record.mdc.traceId) {
        key = `trace\0${record.mdc.traceId}`;
        label = `trace ${record.mdc.traceId}`;
        sublabels = [record.app || record.file].filter(Boolean);
      }
    } else if (mode === "thread") {
      if (record.thread) {
        key = `${record.file}\0${record.thread}`;
        label = record.thread;
        sublabels = [record.file];
      }
    } else if (mode === "rest") {
      if (record.span !== -1 && spans[record.span]) {
        key = `span-${record.span}`;
        label = spanSummary(spans[record.span]);
        sublabels = [spans[record.span].service];
      }
    } else if (mode === "problem") {
      const problem = problems.get(record.i);
      if (problem) {
        key = problem.key;
        label = problem.label;
        // The frame that names our own code is the most useful subtitle a
        // failure can carry; without one, say which applications it hit.
        sublabels = problem.topFrame ? [problem.topFrame] : (problem.apps ?? []);
      }
    }

    if (key === null) {
      orphans.push(record);
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label,
        sublabels,
        records: [],
        fromTs: record.tsText,
        toTs: record.tsText,
        ms: null,
        errors: 0,
        warns: 0,
        apps: [],
        files: [],
        gapMs: 0,
        gapAt: -1,
        gapFlagged: [],
      };
      groups.set(key, group);
    }
    group.records.push(record);
  }

  /**
   * Fill in the numbers a group header shows, once its records are all in.
   * @param {LogGroup} group
   * @returns {LogGroup}
   */
  const finish = (group) => {
    const first = group.records[0];
    const last = group.records[group.records.length - 1];
    group.fromTs = first.tsText;
    group.toTs = last.tsText;
    group.ms = first.ts !== null && last.ts !== null ? last.ts - first.ts : null;
    group.errors = group.records.filter((record) => record.level === "ERROR").length;
    group.warns = group.records.filter((record) => record.level === "WARN").length;
    group.apps = [...new Set(group.records.map((record) => record.app).filter(Boolean))];
    group.files = [...new Set(group.records.map((record) => record.file))];
    const gaps = gapStats(group.records);
    group.gapMs = gaps.largestMs;
    group.gapAt = gaps.largestAt;
    group.gapFlagged = gaps.flagged;
    return group;
  };

  const out = [...groups.values()].map(finish);
  out.sort((a, b) => {
    // Problems are a ranking, not a sequence: the reader wants the one that
    // happened most, and counted over what is *shown* rather than over the whole
    // log, so the order answers for the filters currently applied.
    if (mode === "problem") return b.records.length - a.records.length;
    const at = a.records[0].ts;
    const bt = b.records[0].ts;
    if (at === null || bt === null) return 0;
    return at - bt;
  });
  if (orphans.length) {
    out.push(finish({
      key: "\0unattributed",
      label: "Unattributed",
      sublabels: [],
      records: orphans,
      fromTs: "",
      toTs: "",
      ms: null,
      errors: 0,
      warns: 0,
      apps: [],
      files: [],
      gapMs: 0,
      gapAt: -1,
      gapFlagged: [],
    }));
  }
  return out;
}

/* ------------------------------ filtering ------------------------------ */

/**
 * @typedef {Object} Filters
 * @property {string[]} [levels]
 * @property {string[]} [apps]
 * @property {string[]} [categories]
 * @property {string[]} [files]
 * @property {string[]} [threads]
 * @property {string[]} [ids] any one of these matches (OR)
 * @property {string} [query] search terms — see {@link parseQuery}
 * @property {boolean} [restOnly]
 * @property {boolean} [badOnly] non-2xx or unanswered REST calls
 * @property {number} [minMs] slower-than threshold for REST calls
 * @property {number[]} [spanIds] only the records of these REST calls
 * @property {number | null} [fromMs] time window start, inclusive
 * @property {number | null} [toMs] time window end, inclusive
 */

/**
 * Split a search box value into terms: whitespace-separated, with double
 * quotes grouping a phrase. Every term must match (AND) — "dossier 500" means
 * records mentioning both — because that is what a reader narrowing a log
 * means, and OR is what the id filters already do.
 * @param {string} text
 * @returns {string[]} lower-cased terms
 */
export function parseQuery(text) {
  /** @type {string[]} */
  const terms = [];
  for (const match of String(text ?? "").matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (match[1] ?? match[2]).trim().toLowerCase();
    if (term) terms.push(term);
  }
  return terms;
}

/**
 * @param {string[] | undefined} selected
 * @param {string} value
 * @returns {boolean}
 */
function anyOf(selected, value) {
  return !selected || selected.length === 0 || selected.includes(value);
}

/**
 * Apply the reading filters.
 *
 * Facet families combine with AND, selections within one family with OR — "these
 * two dossiers, at ERROR, from balboa-bank" is what a reader means. Unlike the
 * Sanitize log view, the query *hides* non-matching records: this is a search
 * tool over merged logs, and highlighting alone would leave thousands of rows to
 * scroll. The REST filters only ever apply to records that belong to a span.
 * @param {LogRecord[]} records
 * @param {Filters} [filters]
 * @param {RestSpan[]} [spans]
 */
export function filterRecords(records, filters = {}, spans = []) {
  const needles = parseQuery(filters.query ?? "");
  const levels = filters.levels ?? [];

  return records.filter((record) => {
    // A record with no clock cannot be placed inside a time window, so an
    // active window hides it rather than guessing.
    if (filters.fromMs != null && (record.ts === null || record.ts < filters.fromMs)) return false;
    if (filters.toMs != null && (record.ts === null || record.ts > filters.toMs)) return false;
    if (levels.length && !(record.level !== null && levels.includes(record.level))) return false;
    if (!anyOf(filters.apps, record.app)) return false;
    if (!anyOf(filters.categories, record.category)) return false;
    if (!anyOf(filters.files, record.file)) return false;
    if (!anyOf(filters.threads, record.thread)) return false;
    if (filters.ids && filters.ids.length) {
      if (!filters.ids.some((id) => record.ids.includes(id))) return false;
    }
    const span = record.span === -1 ? null : spans[record.span] ?? null;
    // Picking a call out of the REST table narrows to exactly its records, so a
    // record belonging to no span is excluded rather than passed through.
    if (filters.spanIds && filters.spanIds.length) {
      if (record.span === -1 || !filters.spanIds.includes(record.span)) return false;
    }
    if (filters.restOnly && !span) return false;
    if (filters.badOnly) {
      if (!span || (span.complete && span.ok)) return false;
    }
    if (filters.minMs) {
      if (!span || span.ms === null || span.ms < filters.minMs) return false;
    }
    if (needles.length) {
      const hay = recordText(record).toLowerCase();
      if (!needles.every((needle) => hay.includes(needle))) return false;
    }
    return true;
  });
}

/**
 * The records either side of one record, taken from the **unfiltered** merged
 * set — `grep -C` for the timeline.
 *
 * This exists because {@link filterRecords} is destructive by design: narrowing
 * to one dossier at ERROR is what makes a merged log readable, and it is also
 * what hides the four DEBUG records immediately before the failure that say why
 * it failed. Without a way back to the neighbours, the only recourse is clearing
 * the filters and hunting by timestamp, which loses your place.
 *
 * `index` is a position in `records`, which is why callers pass the merged set
 * and a `record.i` — the two agree by construction ({@link mergeSources} numbers
 * records by their merged position).
 * @param {LogRecord[]} records the merged set, before filtering
 * @param {number} index
 * @param {number} span how many to take on each side
 * @returns {{ before: LogRecord[], after: LogRecord[] }}
 */
export function contextAround(records, index, span) {
  const all = records ?? [];
  if (index < 0 || index >= all.length || span <= 0) return { before: [], after: [] };
  return {
    before: all.slice(Math.max(0, index - span), index),
    after: all.slice(index + 1, index + 1 + span),
  };
}

/**
 * Fixed-width time buckets over the loaded set — the data behind the density
 * strip. Untimed records are ignored; an empty array means there is no axis
 * to draw (no records, or all in the same millisecond).
 * @param {LogRecord[]} records
 * @param {number} [n]
 * @returns {{ fromMs: number, toMs: number, count: number, errors: number, warns: number }[]}
 */
export function densityBuckets(records, n = 80) {
  /** @type {number[]} */
  const timed = [];
  /** @type {LogRecord[]} */
  const stamped = [];
  for (const record of records) {
    if (record.ts === null) continue;
    timed.push(record.ts);
    stamped.push(record);
  }
  if (timed.length === 0) return [];
  const min = Math.min(...timed);
  const max = Math.max(...timed);
  if (max <= min) return [];
  const width = (max - min) / n;
  const buckets = Array.from({ length: n }, (_, index) => ({
    fromMs: min + index * width,
    toMs: min + (index + 1) * width,
    count: 0,
    errors: 0,
    warns: 0,
  }));
  for (const record of stamped) {
    const bucket =
      buckets[Math.min(n - 1, Math.floor((/** @type {number} */ (record.ts) - min) / width))];
    bucket.count++;
    if (record.level === "ERROR") bucket.errors++;
    else if (record.level === "WARN") bucket.warns++;
  }
  return buckets;
}

/**
 * Pinned records as a Markdown ticket comment: a bold header per record
 * (file · timestamp · level) with the record fenced verbatim below. Fences
 * outgrow any backtick run inside a body, so a record cannot break out.
 * @param {LogRecord[]} records
 * @returns {string}
 */
export function pinnedMarkdown(records) {
  return records
    .map((record) => {
      const text = recordText(record);
      const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length + 1);
      const fence = "`".repeat(Math.max(3, ...runs));
      const head = [record.file, record.tsText || "no timestamp", record.level ?? ""]
        .filter(Boolean)
        .join(" · ")
        .replace(/([*_`\\])/g, "\\$1");
      return `**${head}**\n\n${fence}text\n${text}\n${fence}`;
    })
    .join("\n\n");
}

/**
 * Counts for the filter chips, over every parsed record.
 *
 * Deliberately *not* recomputed against the active filters: a count that shifts
 * as you click turns "INFO 412" into a moving target and makes an unselected
 * chip read as empty when it is merely excluded by another facet. The header's
 * shown/total pair is what reports the filtered size.
 * @param {LogRecord[]} records
 */
export function facetCounts(records) {
  /** @param {(r: LogRecord) => string} pick */
  const tally = (pick) => {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const record of records) {
      const key = pick(record);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };

  const levels = LEVELS
    .map((level) => ({ value: level, count: records.filter((r) => r.level === level).length }))
    .filter((entry) => entry.count > 0);

  return {
    levels,
    apps: tally((r) => r.app),
    categories: tally((r) => r.category),
    files: tally((r) => r.file),
    threads: tally((r) => r.thread),
  };
}

/**
 * Headline numbers for the loaded set: what was parsed, how long it spans, and
 * how much of it went wrong.
 * @param {LogRecord[]} records
 * @param {RestSpan[]} [spans]
 */
export function summarize(records, spans = []) {
  // The window comes from stamped records only — a Spring pod log opens with
  // an untimed entrypoint preamble, and "from " reads as a bug.
  const stamped = records.filter((record) => record.ts !== null);
  const timed = stamped.map((record) => /** @type {number} */ (record.ts));
  let slowest = /** @type {RestSpan | null} */ (null);
  let worstMs = -1;
  for (const span of spans) {
    if (span.ms !== null && span.ms > worstMs) {
      worstMs = span.ms;
      slowest = span;
    }
  }
  return {
    records: records.length,
    files: [...new Set(records.map((r) => r.file))].length,
    apps: [...new Set(records.map((r) => r.app).filter(Boolean))],
    fromTs: stamped.length ? stamped[0].tsText : "",
    toTs: stamped.length ? stamped[stamped.length - 1].tsText : "",
    ms: timed.length ? Math.max(...timed) - Math.min(...timed) : null,
    errors: records.filter((r) => r.level === "ERROR").length,
    warns: records.filter((r) => r.level === "WARN").length,
    restCalls: spans.length,
    restFailed: spans.filter((span) => !span.complete || !span.ok).length,
    slowest,
  };
}

/**
 * Everything the UI needs from a set of files, in one call: merged records with
 * their ids and spans, the id index, the alias map and the headline numbers.
 * @param {{ file: string, text: string, offsetMs?: number }[]} sources
 * @returns {{ records: LogRecord[], spans: RestSpan[], index: Map<string, IdFacet>,
 *   aliases: Map<string, string>, facets: ReturnType<typeof facetCounts>,
 *   summary: ReturnType<typeof summarize> }}
 */
export function analyse(sources) {
  const records = mergeSources(sources);
  for (const record of records) extractIds(record);
  const spans = foldRestSpans(records);
  const index = indexIds(records);
  const aliases = resolveAliases(records);
  return {
    records,
    spans,
    index,
    aliases,
    facets: facetCounts(records),
    summary: summarize(records, spans),
  };
}

/**
 * The id facets worth offering as filters, best first.
 *
 * Ranked by how much of the log an id explains, then alphabetically. Ids
 * mentioned once are kept — a `notificationId` appearing in exactly one record
 * is still the fastest way to find that record — but dossier and case ids sort
 * to the top, which is where a reader starts.
 * @param {Map<string, IdFacet>} index
 * @param {number} [limit]
 * @returns {IdFacet[]}
 */
export function rankedIds(index, limit = 400) {
  /**
   * How near the top of the filter list an id belongs.
   * @param {IdFacet} facet
   * @returns {number}
   */
  const weight = (facet) => {
    if (facet.labels.some((label) => inList(DOSSIER_LABELS, label))) return 0;
    if (facet.labels.some((label) => inList(CASE_LABELS, label))) return 1;
    return facet.labels.length ? 2 : 3;
  };
  return [...index.values()]
    .sort((a, b) => weight(a) - weight(b) || b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

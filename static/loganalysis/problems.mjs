// @ts-check
/**
 * meso.utilities — Log Analysis: the problem digest.
 *
 * Four hundred ERROR records are almost never four hundred problems. They are
 * the same five failures, once per dossier that hit them, and the work of
 * reading a merged log is mostly the work of noticing that. This module does
 * that noticing: it recognises a JVM throwable inside a record, reduces a
 * message to the shape it shares with its repeats, and folds the repeats into
 * one cluster carrying how often it happened, when it started and stopped, and
 * — the lookup nothing else here offers — which business cases it touched.
 *
 * Two decisions shape everything below:
 *
 * 1. **Clusters key on the root cause, not the outermost type.** `SigningException
 *    caused by SQLException` and `UploadException caused by SQLException` are one
 *    problem: the database went away. Keying on the wrapper would report it as
 *    two, and the wrapper is the layer that noticed rather than the thing that
 *    broke.
 * 2. **Normalisation is deliberately timid.** Every id and timestamp collapsed to
 *    a placeholder is a repeat correctly merged; every status code or small count
 *    collapsed is two different problems wrongly merged, silently and
 *    irreversibly. So UUIDs, timestamps, long hex runs and long digit runs go,
 *    and `500` stays a `500`.
 *
 * Nothing here is called from `analyse()`. On a merge of tens of megabytes an
 * extra eager pass over every record is felt, and none of this is needed until
 * something is rendered — rows fill lazily per group, and the digest is built
 * when it is asked for.
 *
 * Dual-consumption: imported unchanged by `static/loganalysis/app.js` and by
 * `src/problems.test.ts`.
 */

import { correlationOf, recordSummary } from "./loganalysis.mjs";

/**
 * Packages whose frames say where a failure passed through rather than where it
 * came from. The first frame *outside* this list is the one worth putting on a
 * row, since it names our own code.
 *
 * A heuristic, and exported for exactly that reason: "which package is the
 * application" cannot be derived from a log, so this is a list to be argued with
 * and amended rather than a fact. `ch.ivyteam.` earns its place because the Ivy
 * engine's own frames wrap every user-code failure in these logs.
 */
export const FRAMEWORK_PREFIXES = [
  "java.",
  "javax.",
  "jakarta.",
  "jdk.",
  "sun.",
  "com.sun.",
  "org.springframework.",
  "org.apache.",
  "org.hibernate.",
  "org.eclipse.",
  "org.jboss.",
  "org.slf4j.",
  "ch.qos.logback.",
  "ch.ivyteam.",
  "io.netty.",
  "reactor.",
  "okhttp3.",
  "com.fasterxml.",
];

/**
 * A dotted type name whose last segment is capitalised — `com.example.Signer`,
 * `java.sql.SQLException`. The dot is required and the capital is required,
 * which between them is what stops a logger name (`ch.ivyteam.ivy.cm.internal`)
 * or a lower-case package path being read as a thrown type.
 */
const TYPE_PATTERN = String.raw`[\w$]+(?:\.[\w$]+)*\.[A-Z][\w$]*`;

/**
 * A throwable declaration: the head of a trace, or a `Caused by:` /
 * `Suppressed:` line inside one. Leading whitespace is allowed because a
 * suppressed exception is indented under its parent.
 */
const DECL_RE = new RegExp(
  String.raw`^\s*(Caused by: |Suppressed: )?(${TYPE_PATTERN})(?::[ \t]?(.*))?$`,
);

/** A stack frame: `\tat com.example.Bar.baz(Bar.java:42)`. */
const FRAME_RE = /^\s+at\s+(?:[\w.$/]+\/)?([\w$.<>]+)\(/;

/** Type suffixes that make a declaration unambiguous without a `Caused by:`. */
const THROWABLE_SUFFIX_RE = /(?:Exception|Error|Throwable)$/;

/**
 * @typedef {Object} ThrowableLink
 * @property {string} type fully-qualified class name
 * @property {string} message its message, or "" when it threw without one
 */

/**
 * @typedef {Object} Throwable
 * @property {string} type the outermost type — the layer that noticed
 * @property {string} message the outermost message
 * @property {ThrowableLink[]} causes every `Caused by:` / `Suppressed:`, in order
 * @property {ThrowableLink} rootCause the last cause, or the outermost if none
 * @property {string} topFrame first frame outside {@link FRAMEWORK_PREFIXES}
 * @property {number} frames how many frames the whole trace carries
 */

/**
 * Read one line as a throwable declaration, or return null.
 *
 * Without a `Caused by:` prefix the type has to end in Exception, Error or
 * Throwable. That suffix requirement is what keeps prose out: a log body is full
 * of dotted capitalised names — `class PostDocumentBasketResponse`, a bean name,
 * a Java dump's type line — and any of them would otherwise be claimed as a
 * thrown exception the moment it appeared on a line of its own.
 * @param {string} line
 * @returns {ThrowableLink | null}
 */
function declaration(line) {
  const match = DECL_RE.exec(line);
  if (!match) return null;
  const [, prefix, type, message] = match;
  if (!prefix && !THROWABLE_SUFFIX_RE.test(type)) return null;
  return { type, message: (message ?? "").trim() };
}

/** @param {string} frame */
function isFramework(frame) {
  return FRAMEWORK_PREFIXES.some((prefix) => frame.startsWith(prefix));
}

/**
 * Find the JVM throwable a record's text describes, or null.
 *
 * A trace may have no frames at all (Spring logs plenty of one-line failures),
 * so frames are counted rather than required — what makes this a throwable is a
 * recognised declaration, not a stack.
 * @param {string} text
 * @returns {Throwable | null}
 */
export function parseThrowable(text) {
  /** @type {ThrowableLink[]} */
  const chain = [];
  /** @type {string[]} */
  const frames = [];
  for (const line of String(text ?? "").split("\n")) {
    const frame = FRAME_RE.exec(line);
    if (frame) {
      frames.push(frame[1]);
      continue;
    }
    const link = declaration(line);
    if (link) chain.push(link);
  }
  if (chain.length === 0) return null;
  const [outermost, ...causes] = chain;
  return {
    type: outermost.type,
    message: outermost.message,
    causes,
    rootCause: causes.length ? causes[causes.length - 1] : outermost,
    topFrame: frames.find((frame) => !isFramework(frame)) ?? frames[0] ?? "",
    frames: frames.length,
  };
}

/**
 * A record's own words: the header-line message when the format carries one
 * (Spring), then whatever continues below it (the stack trace). For Ivy, whose
 * `msg` is empty by construction, this is simply the body.
 *
 * Deliberately *not* `recordText` — that includes the header line, whose
 * bracketed timestamp and level would be read as part of the message and would
 * defeat both the throwable parse and the normalisation.
 * @param {import("./loganalysis.mjs").LogRecord} record
 * @returns {string}
 */
export function messageText(record) {
  return [record.msg, record.body].filter(Boolean).join("\n");
}

const UUID_RE = /\b[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\b/g;
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?Z?/g;
const HEX_RUN_RE = /\b[0-9a-fA-F]{16,}\b/g;
/** Four digits or more: an id, a counter, a timestamp fragment — never a status. */
const LONG_NUMBER_RE = /\b\d{4,}\b/g;

/**
 * Reduce a message to the shape it shares with its own repeats.
 *
 * The ordering matters: UUIDs and timestamps contain digit runs, so they have to
 * go before {@link LONG_NUMBER_RE} gets to them, or one occurrence normalises to
 * `{n}-{n}-…` and the next to something subtly different, and the two never meet.
 *
 * Short numbers survive on purpose. `500` and `404` are the difference between
 * "the downstream broke" and "we asked for the wrong thing", and a normaliser
 * that merges them hides that with no way to notice it happened.
 * @param {string} text
 * @returns {string}
 */
export function normalizeMessage(text) {
  return String(text ?? "")
    .replace(UUID_RE, "{id}")
    .replace(TIMESTAMP_RE, "{ts}")
    .replace(HEX_RUN_RE, "{hex}")
    .replace(LONG_NUMBER_RE, "{n}")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * @typedef {Object} Problem
 * @property {string} key
 * @property {string} level
 * @property {string} type root-cause class name, or "" for a message with no throwable
 * @property {string} message a readable example, un-normalised
 * @property {string} label the group header text, composed once here so
 *   `buildGroups` needs no import back into this module
 * @property {string} topFrame first non-framework frame of the first occurrence
 * @property {number} count records in this cluster
 * @property {string} firstTs
 * @property {string} lastTs
 * @property {number} firstIndex `record.i` of the earliest occurrence
 * @property {string[]} apps
 * @property {string[]} files
 * @property {string[]} dossiers correlation ids this problem touched
 * @property {number[]} records every `record.i` in the cluster
 */

/**
 * Fold the failing records into distinct problems, worst first.
 *
 * `dossiers` is the reason this takes the id index and the alias map: it answers
 * "how far did this spread", which is the question a ticket actually asks and
 * which no per-record view can answer. It reuses `correlationOf`, so an error
 * whose record names only a case id still counts towards the dossier that case
 * belongs to.
 *
 * Ties on count break by first appearance, so a stable, chronological order
 * comes out of an otherwise unordered map.
 * @param {import("./loganalysis.mjs").LogRecord[]} records
 * @param {Map<string, import("./loganalysis.mjs").IdFacet>} index
 * @param {Map<string, string>} aliases
 * @param {{ levels?: string[], link?: boolean }} [options]
 * @returns {Problem[]}
 */
export function clusterProblems(records, index, aliases, options = {}) {
  const levels = options.levels ?? ["ERROR", "WARN"];
  const link = options.link ?? true;

  /** @type {Map<string, Problem & { appSet: Set<string>, fileSet: Set<string>, dossierSet: Set<string> }>} */
  const clusters = new Map();

  for (const record of records ?? []) {
    if (record.level === null || !levels.includes(record.level)) continue;
    const throwable = parseThrowable(messageText(record));
    // With a throwable, the root cause's own words are the headline — the
    // wrapper's message is usually a restatement of the operation, identical
    // across unrelated failures ("could not process request").
    const headline = throwable
      ? (throwable.rootCause.message || throwable.rootCause.type)
      : recordSummary(record, 4000);
    const type = throwable ? throwable.rootCause.type : "";
    const key = `${record.level}\0${type}\0${normalizeMessage(headline)}`;

    let cluster = clusters.get(key);
    if (!cluster) {
      const message = headline.replace(/\s+/g, " ").trim().slice(0, 300);
      cluster = {
        key,
        level: record.level,
        type,
        message,
        // The bare class name, not the package: `SQLException` is what a reader
        // recognises, and `java.sql.` in front of it only costs header width.
        label: type ? `${type.split(".").pop()}: ${message}` : message,
        topFrame: throwable?.topFrame ?? "",
        count: 0,
        firstTs: record.tsText,
        lastTs: record.tsText,
        firstIndex: record.i,
        apps: [],
        files: [],
        dossiers: [],
        records: [],
        appSet: new Set(),
        fileSet: new Set(),
        dossierSet: new Set(),
      };
      clusters.set(key, cluster);
    }
    cluster.count++;
    cluster.lastTs = record.tsText;
    cluster.records.push(record.i);
    if (record.app) cluster.appSet.add(record.app);
    cluster.fileSet.add(record.file);
    const dossier = correlationOf(record, index, aliases, link);
    if (dossier) cluster.dossierSet.add(dossier);
  }

  const out = [...clusters.values()].map((cluster) => {
    cluster.apps = [...cluster.appSet];
    cluster.files = [...cluster.fileSet];
    cluster.dossiers = [...cluster.dossierSet];
    return cluster;
  });
  out.sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex);
  return /** @type {Problem[]} */ (out);
}

/**
 * Which cluster each record fell into, keyed by `record.i`.
 *
 * This is what lets `buildGroups` offer Problems as a grouping mode without
 * importing this module: it is handed the finished map and reads `key` and
 * `label` off it. Keeping the dependency one-way matters — `problems.mjs`
 * already imports from `loganalysis.mjs`, and a cycle between two ES modules
 * loaded straight from disk by both the browser and Deno is a fragility worth
 * not having.
 * @param {Problem[]} problems
 * @returns {Map<number, Problem>}
 */
export function problemIndex(problems) {
  /** @type {Map<number, Problem>} */
  const map = new Map();
  for (const problem of problems ?? []) {
    for (const index of problem.records) map.set(index, problem);
  }
  return map;
}

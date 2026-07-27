// @ts-check
/**
 * meso.utilities — reading aids for the Sanitize tool's masked log output.
 *
 * A masked log is often thousands of lines, and the interesting ones are a
 * handful of masked values buried in the middle. This module turns the two
 * texts (original + masked) into numbered rows carrying everything the reader
 * needs to narrow them down — log level, whether masking touched the line, and
 * where a search query hits — and renders one row's inner HTML.
 *
 * It is deliberately view-only: nothing here changes the masked text, so Copy
 * and Download always hand over the whole log regardless of what is on screen.
 *
 * Dual-consumption: imported unchanged by `static/app.js` and by
 * `src/logview.test.ts`.
 */

import { pairLineDiff } from "./diff.mjs";
import { escapeHtml } from "./ui.mjs";

/** Canonical levels, most severe first — the order the filter chips render in. */
export const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

/** Spellings that mean one of {@link LEVELS} under a different name. */
const LEVEL_ALIASES = { FATAL: "ERROR", SEVERE: "ERROR", WARNING: "WARN" };

const LEVEL_RE = /\b(FATAL|SEVERE|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\b/;

/**
 * Characters of a line searched for a level token. A level sits in the line's
 * prefix (timestamp, thread, logger); looking further would let the word ERROR
 * inside a long message body retag the line.
 */
const HEAD_CHARS = 200;

/** Runs of mask characters (plus any revealed tail) produced by the sanitizer. */
const MASK_RE = /\*{2,}[\w.@:+/-]*/g;

/**
 * The log level a line announces, or null if it announces none. Only uppercase
 * tokens count: lower-case "error" in prose is a message, not a level.
 * @param {string} line
 * @returns {string | null}
 */
export function detectLevel(line) {
  const match = LEVEL_RE.exec(String(line ?? "").slice(0, HEAD_CHARS));
  if (!match) return null;
  return LEVEL_ALIASES[/** @type {keyof typeof LEVEL_ALIASES} */ (match[1])] ?? match[1];
}

/**
 * Do the two texts still pair line-for-line?
 *
 * Masking re-emits a pretty-printed JSON block pretty-printed, so it normally
 * preserves the line count — but a block whose source packed several keys onto
 * one line (or held an inline array) comes back expanded. When that happens the
 * positional pairing is meaningless and the change flags must not be trusted.
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {boolean}
 */
export function linesAligned(beforeText, afterText) {
  return String(beforeText).split("\n").length === String(afterText).split("\n").length;
}

/**
 * @typedef {Object} LogRow
 * @property {number} n 1-based line number
 * @property {string} text the masked line
 * @property {string} before the same line before masking
 * @property {boolean} changed masking altered this line
 * @property {string | null} level the line's level, inherited when it declares none
 */

/**
 * Pair the original and masked texts into numbered rows.
 *
 * Lines that declare no level inherit the previous line's — a stack trace or a
 * Java `toString` dump is part of the record above it, so filtering to ERROR
 * has to keep the body, not just the header. Lines before the first level
 * token keep a null level.
 *
 * Pairing is positional, via the same {@link pairLineDiff} the Diff checkbox
 * uses, so `changed` means exactly what the diff shows.
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {LogRow[]}
 */
export function buildRows(beforeText, afterText) {
  /** @type {LogRow[]} */
  const rows = [];
  let level = /** @type {string | null} */ (null);
  const pairs = pairLineDiff(beforeText, afterText);
  for (let i = 0; i < pairs.length; i++) {
    const declared = detectLevel(pairs[i].after);
    if (declared) level = declared;
    rows.push({
      n: i + 1,
      text: pairs[i].after,
      before: pairs[i].before,
      changed: pairs[i].changed,
      level,
    });
  }
  return rows;
}

/**
 * The levels this log actually uses, in {@link LEVELS} order. Filter chips are
 * built from this so a log that only logs INFO doesn't offer four dead chips.
 * @param {LogRow[]} rows
 * @returns {string[]}
 */
export function presentLevels(rows) {
  const seen = new Set(rows.map((row) => row.level));
  return LEVELS.filter((level) => seen.has(level));
}

/**
 * @typedef {Object} Hit
 * @property {number} start index into the row's text
 * @property {number} end exclusive
 * @property {number} index position of this hit in the whole filtered result
 */

/**
 * Every occurrence of `query` in `text`, case-insensitively. Plain substring
 * matching, not regex — the query comes from a text box, so `.` and `[` have
 * to mean themselves.
 * @param {string} text
 * @param {string} query
 * @returns {{ start: number, end: number }[]}
 */
function matchRanges(text, query) {
  if (query === "") return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const out = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out.push({ start: at, end: at + needle.length });
    at = haystack.indexOf(needle, at + needle.length);
  }
  return out;
}

/**
 * @typedef {LogRow & { hits: Hit[] }} VisibleRow
 */

/**
 * @typedef {Object} FilterOptions
 * @property {string[] | null} [levels] levels to keep; null or empty keeps all
 * @property {boolean} [onlyChanged] keep only lines masking altered
 * @property {string} [query] highlighted, never used to hide a line
 */

/**
 * Apply the reading filters. The query highlights and is counted but does not
 * hide anything — hiding is the level chips' and "only changed"'s job, so
 * searching never silently removes the context around a hit.
 *
 * A line with no level (before the log's first level token) is dropped as soon
 * as any level filter is on, since it belongs to no level being asked for.
 * @param {LogRow[]} rows
 * @param {FilterOptions} [options]
 * @returns {{ rows: VisibleRow[], shown: number, total: number, matches: number }}
 */
export function filterRows(rows, options = {}) {
  const { levels = null, onlyChanged = false, query = "" } = options;
  const allowed = levels && levels.length ? new Set(levels) : null;
  const needle = String(query ?? "");

  /** @type {VisibleRow[]} */
  const visible = [];
  let matches = 0;
  for (const row of rows) {
    if (allowed && !(row.level !== null && allowed.has(row.level))) continue;
    if (onlyChanged && !row.changed) continue;
    const hits = matchRanges(row.text, needle).map((range) => ({ ...range, index: matches++ }));
    visible.push({ ...row, hits });
  }
  return { rows: visible, shown: visible.length, total: rows.length, matches };
}

/**
 * Render one line to HTML: escaped text with the masked runs tinted and the
 * search hits marked.
 *
 * The two highlights can overlap (a query can match inside a masked run), so
 * the line is cut at every span boundary and each piece takes the classes of
 * whatever covers it — layering `<span>`s directly would produce crossed tags.
 * Escaping happens per piece, after the offsets are resolved, because escaping
 * first would shift every index.
 * @param {string} text
 * @param {Hit[]} [hits]
 * @returns {string}
 */
export function rowHtml(text, hits = []) {
  const spans = [];
  for (const match of text.matchAll(MASK_RE)) {
    spans.push({ start: /** @type {number} */ (match.index), end: match.index + match[0].length });
  }
  const marks = spans.map((s) => ({ ...s, cls: "j-masked", index: -1 }))
    .concat(hits.map((h) => ({ start: h.start, end: h.end, cls: "log-hit", index: h.index })));
  if (marks.length === 0) return escapeHtml(text);

  const cuts = [...new Set([0, text.length, ...marks.flatMap((m) => [m.start, m.end])])]
    .sort((a, b) => a - b);

  let html = "";
  for (let i = 0; i < cuts.length - 1; i++) {
    const [from, to] = [cuts[i], cuts[i + 1]];
    const chunk = escapeHtml(text.slice(from, to));
    const covering = marks.filter((m) => m.start <= from && m.end >= to);
    if (covering.length === 0) {
      html += chunk;
      continue;
    }
    const hit = covering.find((m) => m.cls === "log-hit");
    const cls = [...new Set(covering.map((m) => m.cls))].join(" ");
    html += `<span class="${cls}"${hit ? ` data-hit="${hit.index}"` : ""}>${chunk}</span>`;
  }
  return html;
}

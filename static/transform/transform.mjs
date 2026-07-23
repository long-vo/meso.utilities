// meso.utilities — Text Transform: pure text-manipulation logic (case
// switching, sorting, aligning, filtering, quotes …), modelled on the IntelliJ
// "String Manipulation" plugin. Dual-consumption: imported unchanged by the
// browser UI (app.js) and by the parity tests (src/transform.test.ts).
// Nothing here touches the DOM. All functions expect LF newlines —
// `applyAction` normalizes CRLF first.

import { jsonToYaml, yamlToJson } from "./yaml.mjs";

/* ----------------------------- shared helpers ---------------------------- */

/** Normalize CRLF / lone CR to LF so every transform can assume "\n". */
export function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n");
}

const splitLines = (text) => text.split("\n");

/** Apply `fn` to every line. */
function mapLines(text, fn) {
  return splitLines(text).map(fn).join("\n");
}

/**
 * Apply `fn` to each line's content, preserving leading/trailing whitespace
 * (indentation survives case conversions and word swaps).
 */
function mapLineBody(text, fn) {
  return mapLines(text, (line) => {
    const lead = line.match(/^\s*/)[0];
    const trail = line.match(/\s*$/)[0];
    const body = line.slice(lead.length, line.length - trail.length);
    if (body === "") return line;
    return lead + fn(body) + trail;
  });
}

/** First non-blank line's trimmed content — the probe for case detection. */
function firstBody(text) {
  return splitLines(text).map((line) => line.trim()).find((line) => line !== "");
}

/** Natural-order collator: case-insensitive, digit-aware ("a2" < "a10"). */
const naturalCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Code-point comparison — the "case-sensitive A-z" sort. */
function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Fisher–Yates shuffle; `rng` is injectable so tests are deterministic. */
function shuffled(items, rng) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ------------------------------ case switching --------------------------- */

/** Split an identifier or phrase into its word parts (camel humps, acronyms, delimiters, digits). */
export function splitWords(text) {
  const words = [];
  for (const token of text.split(/[^A-Za-z0-9]+/)) {
    if (token === "") continue;
    words.push(...(token.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [token]));
  }
  return words;
}

const capWord = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
const lowerWords = (words) => words.map((word) => word.toLowerCase());
const upperWords = (words) => words.map((word) => word.toUpperCase());

/**
 * Every case format: `detect` recognises a line already in the format,
 * `convert` builds it from word parts. Formats with `inCycle` participate in
 * "Switch case (cycle)", in array order — the order the IntelliJ plugin uses.
 */
export const CASE_FORMATS = [
  {
    id: "camel",
    label: "camelCase",
    inCycle: true,
    detect: (s) => /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(s),
    convert: (words) =>
      words.map((word, i) => (i === 0 ? word.toLowerCase() : capWord(word))).join(""),
  },
  {
    id: "kebab",
    label: "kebab-lowercase",
    inCycle: true,
    detect: (s) => /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(s),
    convert: (words) => lowerWords(words).join("-"),
  },
  {
    id: "kebab-upper",
    label: "KEBAB-UPPERCASE",
    inCycle: true,
    detect: (s) => /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(s),
    convert: (words) => upperWords(words).join("-"),
  },
  {
    id: "snake",
    label: "snake_case",
    inCycle: true,
    detect: (s) => /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(s),
    convert: (words) => lowerWords(words).join("_"),
  },
  {
    id: "screaming-snake",
    label: "SCREAMING_SNAKE_CASE",
    inCycle: true,
    detect: (s) => /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(s),
    convert: (words) => upperWords(words).join("_"),
  },
  {
    id: "dot",
    label: "dot.case",
    inCycle: true,
    detect: (s) => /^[a-z0-9]+(?:\.[a-z0-9]+)+$/.test(s),
    convert: (words) => lowerWords(words).join("."),
  },
  {
    id: "words-lower",
    label: "words lowercase",
    inCycle: true,
    detect: (s) => /^[a-z0-9]+(?: [a-z0-9]+)+$/.test(s),
    convert: (words) => lowerWords(words).join(" "),
  },
  {
    id: "sentence",
    label: "First word capitalized",
    inCycle: true,
    detect: (s) => /^[A-Z][a-z0-9]*(?: [a-z0-9]+)+$/.test(s),
    convert: (words) =>
      words.map((word, i) => (i === 0 ? capWord(word) : word.toLowerCase())).join(" "),
  },
  {
    id: "title",
    label: "Words Capitalized",
    inCycle: true,
    detect: (s) => /^[A-Z][a-z0-9]*(?: [A-Z][a-z0-9]*)+$/.test(s),
    convert: (words) => words.map(capWord).join(" "),
  },
  {
    id: "pascal",
    label: "PascalCase",
    inCycle: true,
    detect: (s) => /^(?:[A-Z][a-z0-9]*)+$/.test(s) && /[a-z]/.test(s),
    convert: (words) => words.map(capWord).join(""),
  },
  {
    id: "capitalized-snake",
    label: "Capitalized_Snake_Case",
    inCycle: false,
    detect: (s) => /^[A-Z][a-z0-9]*(?:_[A-Z][a-z0-9]*)+$/.test(s),
    convert: (words) => words.map(capWord).join("_"),
  },
];

function formatById(id) {
  const format = CASE_FORMATS.find((f) => f.id === id);
  if (!format) throw new Error(`Unknown case format: ${id}`);
  return format;
}

/** Convert every line to the given case format, keeping indentation. */
export function toCase(text, formatId) {
  const format = formatById(formatId);
  return mapLineBody(text, (body) => format.convert(splitWords(body)));
}

/**
 * "Switch case": detect the current format of the first non-blank line and
 * convert to the next one in the cycle. Formats that would leave the text
 * unchanged are skipped, so repeated invocations always make progress.
 */
export function cycleCase(text) {
  const cycle = CASE_FORMATS.filter((format) => format.inCycle);
  const probe = firstBody(text);
  let index = probe === undefined ? -1 : cycle.findIndex((format) => format.detect(probe));
  for (let step = 0; step < cycle.length; step++) {
    index = (index + 1) % cycle.length;
    const result = toCase(text, cycle[index].id);
    if (result !== text) return result;
  }
  return text;
}

/** Toggle between two formats: already in `firstId` → `secondId`, else `firstId`. */
export function toggleCase(text, firstId, secondId) {
  const probe = firstBody(text);
  const isFirst = probe !== undefined && formatById(firstId).detect(probe);
  return toCase(text, isFirst ? secondId : firstId);
}

/** Uppercase the first letter of every word, leaving the rest untouched. */
export function capitalizeWords(text) {
  return text.replace(
    /(^|[^\p{L}\p{N}])(\p{L})/gu,
    (_, prefix, letter) => prefix + letter.toUpperCase(),
  );
}

/** Swap the case of every letter. */
export function invertCase(text) {
  return [...text]
    .map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()))
    .join("");
}

/**
 * Spring Boot relaxed-binding env-variable form: dots and brackets become
 * underscores, dashes vanish, everything is uppercased
 * (`spring.main.log-startup-info` → `SPRING_MAIN_LOGSTARTUPINFO`).
 */
export function toSpringEnv(text) {
  return mapLineBody(
    text,
    (body) =>
      body
        .replace(/[[\].]/g, "_")
        .replace(/-/g, "")
        .replace(/_{2,}/g, "_")
        .replace(/^_+|_+$/g, "")
        .toUpperCase(),
  );
}

/* --------------------------------- sorting -------------------------------- */

function sortLinesBy(text, compare, descending = false) {
  const lines = splitLines(text);
  lines.sort(compare); // stable, so equal lines keep their order
  if (descending) lines.reverse();
  return lines.join("\n");
}

export function reverseLines(text) {
  return splitLines(text).reverse().join("\n");
}

export function shuffleLines(text, rng = Math.random) {
  return shuffled(splitLines(text), rng).join("\n");
}

export function sortLines(text, { caseSensitive = true, descending = false } = {}) {
  const compare = caseSensitive ? byCodePoint : naturalCollator.compare;
  return sortLinesBy(text, compare, descending);
}

export function sortLinesByLength(text, { descending = false } = {}) {
  return sortLinesBy(text, (a, b) => a.length - b.length, descending);
}

/** Sort lines by the first hexadecimal number found on each (`0x` optional); lines without one go last. */
export function sortLinesHex(text) {
  const key = (line) => {
    const match = line.match(/\b(?:0[xX][0-9a-fA-F]+|[0-9a-fA-F]+)\b/);
    return match ? parseInt(match[0].replace(/^0[xX]/, ""), 16) : Infinity;
  };
  return splitLines(text)
    .map((line, index) => ({ line, key: key(line), index }))
    .sort((a, b) => (a.key === b.key ? a.index - b.index : a.key < b.key ? -1 : 1))
    .map((entry) => entry.line)
    .join("\n");
}

/**
 * Sort the tokens within each line. Cells are trimmed and rejoined with the
 * delimiter as typed; a blank delimiter splits on whitespace and joins with
 * one space.
 */
export function sortTokens(text, delimiter = "") {
  return mapLineBody(text, (body) => {
    const cells = (delimiter === "" ? body.split(/\s+/) : body.split(delimiter))
      .map((cell) => cell.trim());
    cells.sort(naturalCollator.compare);
    return cells.join(delimiter === "" ? " " : delimiter);
  });
}

/**
 * Hierarchical sort: lines are grouped into blocks by indentation (a block is
 * a line plus everything indented deeper below it); blocks are sorted at each
 * level, children stay attached to their parent and are sorted recursively.
 */
export function hierarchicalSort(text) {
  const sortBlocks = (lines) => {
    const nonBlank = lines.filter((line) => line.trim() !== "");
    if (nonBlank.length === 0) return lines;
    const base = Math.min(...nonBlank.map((line) => line.match(/^[ \t]*/)[0].length));
    const blocks = [];
    let current;
    for (const line of lines) {
      const startsBlock = line.trim() !== "" && line.match(/^[ \t]*/)[0].length === base;
      if (startsBlock || current === undefined) {
        current = { head: line, children: [] };
        blocks.push(current);
      } else {
        current.children.push(line);
      }
    }
    blocks.sort((a, b) => naturalCollator.compare(a.head.trim(), b.head.trim()));
    return blocks.flatMap((block) => [block.head, ...sortBlocks(block.children)]);
  };
  return sortBlocks(splitLines(text)).join("\n");
}

/** Shuffle the characters within each line. */
export function shuffleChars(text, rng = Math.random) {
  return mapLines(text, (line) => shuffled([...line], rng).join(""));
}

/** Recursively sort every object's keys in a JSON document (2-space pretty print). */
export function sortJson(text) {
  const sortValue = (value) => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(sortValue(JSON.parse(text)), null, 2);
}

/* --------------------------------- aligning ------------------------------- */

/**
 * Format delimited lines as a table: cells are trimmed and padded to the
 * widest cell of their column. A blank delimiter splits on whitespace (joined
 * with two spaces); otherwise cells are rejoined with the trimmed delimiter
 * plus a space (`,` → `, `).
 */
export function alignColumns(text, delimiter = "") {
  const useWhitespace = delimiter.trim() === "";
  const separator = useWhitespace ? "" : delimiter.trim();
  const rows = splitLines(text).map((line) =>
    (useWhitespace ? line.trim().split(/\s+/) : line.split(delimiter))
      .map((cell) => cell.trim())
  );
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => {
          if (i === row.length - 1) return cell; // last cell: no padding, no separator
          return (cell + separator).padEnd(widths[i] + separator.length);
        })
        .join(useWhitespace ? "  " : " ")
    )
    .join("\n");
}

/** Align lines to the left, center or right of the longest line's width. */
export function alignText(text, side) {
  const contents = splitLines(text).map((line) => line.trim());
  const width = Math.max(0, ...contents.map((line) => line.length));
  return contents
    .map((line) => {
      if (line === "" || side === "left") return line;
      const pad = side === "right" ? width - line.length : Math.floor((width - line.length) / 2);
      return " ".repeat(pad) + line;
    })
    .join("\n");
}

/* --------------------------- filter / remove / trim ----------------------- */

/**
 * Build a line predicate from a pattern: `/…/flags` is a regular expression
 * (g/y stripped — they'd make `.test` stateful), anything else a literal
 * substring match.
 */
export function lineMatcher(pattern) {
  const regex = pattern.match(/^\/(.+)\/([a-z]*)$/s);
  if (regex) {
    const re = new RegExp(regex[1], regex[2].replace(/[gy]/g, ""));
    return (line) => re.test(line);
  }
  return (line) => line.includes(pattern);
}

function requirePattern(pattern) {
  if (pattern === undefined || pattern === "") {
    throw new Error("Enter a grep pattern under Options first (text or /regex/)");
  }
  return lineMatcher(pattern);
}

/** Keep only lines matching the pattern (grep) — or only non-matching ones (inverted). */
export function grepLines(text, pattern, { invert = false } = {}) {
  const matches = requirePattern(pattern);
  return splitLines(text).filter((line) => matches(line) !== invert).join("\n");
}

/** Group lines: matches first, then a blank line, then the rest. */
export function groupByGrep(text, pattern) {
  const matches = requirePattern(pattern);
  const hit = [];
  const miss = [];
  for (const line of splitLines(text)) (matches(line) ? hit : miss).push(line);
  if (hit.length === 0 || miss.length === 0) return [...hit, ...miss].join("\n");
  return hit.join("\n") + "\n\n" + miss.join("\n");
}

export function trimLines(text) {
  return mapLines(text, (line) => line.trim());
}

export function trimTrailing(text) {
  return mapLines(text, (line) => line.replace(/\s+$/, ""));
}

export function trimLeading(text) {
  return mapLines(text, (line) => line.replace(/^\s+/, ""));
}

/** Collapse every run of spaces/tabs into a single space (newlines survive). */
export function collapseWhitespace(text) {
  return text.replace(/[^\S\n]+/g, " ");
}

/** Remove all spaces and tabs (newlines survive). */
export function removeAllSpaces(text) {
  return text.replace(/[^\S\n]+/g, "");
}

/** Keep the first occurrence of every line. */
export function removeDuplicateLines(text) {
  const seen = new Set();
  return splitLines(text)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .join("\n");
}

/** Keep one instance of every line that occurs more than once. */
export function keepOnlyDuplicateLines(text) {
  const lines = splitLines(text);
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const seen = new Set();
  return lines
    .filter((line) => {
      if (counts.get(line) < 2 || seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .join("\n");
}

export function removeEmptyLines(text) {
  return splitLines(text).filter((line) => line.trim() !== "").join("\n");
}

/** Collapse runs of blank lines into a single blank line. */
export function removeConsecutiveEmptyLines(text) {
  const out = [];
  for (const line of splitLines(text)) {
    if (line.trim() === "" && out.length > 0 && out[out.length - 1].trim() === "") continue;
    out.push(line.trim() === "" ? "" : line);
  }
  return out.join("\n");
}

export function removeAllNewlines(text) {
  return text.replaceAll("\n", "");
}

/** Minify a JSON document to a single line. */
export function minifyJson(text) {
  return JSON.stringify(JSON.parse(text));
}

/* ----------------------------- quotes & other ----------------------------- */

/** Reverse the characters of each line (surrogate-pair safe). */
export function reverseLetters(text) {
  return mapLines(text, (line) => [...line].reverse().join(""));
}

/** Reverse the word order of each line, keeping indentation. */
export function swapWords(text) {
  return mapLineBody(text, (body) => body.split(/\s+/).reverse().join(" "));
}

const QUOTE_NEXT = { '"': "'", "'": "`", "`": '"' };

/** Shift every quoted string to the next quote style: " → ' → ` → ". */
export function shiftQuotes(text) {
  return text.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    (match) => {
      const quote = match[0];
      const next = QUOTE_NEXT[quote];
      const body = match
        .slice(1, -1)
        .replaceAll("\\" + quote, quote)
        .replaceAll(next, "\\" + next);
      return next + body + next;
    },
  );
}

/** Swap every double quote with a single quote and vice versa. */
export function swapQuotes(text) {
  return text.replace(/["']/g, (quote) => (quote === '"' ? "'" : '"'));
}

/** Educate quotes: straight " and ' become typographic “ ” / ‘ ’. */
export function educateQuotes(text) {
  return text
    .replace(/(^|[\s([{<“‘])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/(^|[\s([{<“‘])'/g, "$1‘")
    .replace(/'/g, "’");
}

/** Straighten quotes: typographic and angle quotes become plain " and '. */
export function straightenQuotes(text) {
  return text.replace(/[“”„‟«»]/g, '"').replace(/[‘’‚‛‹›]/g, "'");
}

/** Switch path separators: any backslash present → all become /, else / → \. */
export function switchPathSeparators(text) {
  return text.includes("\\") ? text.replaceAll("\\", "/") : text.replaceAll("/", "\\");
}

/* ------------------------------ action registry --------------------------- */

const CASE_TOGGLES = [
  ["screaming-snake", "SCREAMING_SNAKE_CASE"],
  ["snake", "snake_case"],
  ["kebab", "kebab-case", "snake", "snake_case"],
  ["kebab", "kebab-case"],
  ["dot", "dot.case"],
  ["pascal", "PascalCase"],
  ["words-lower", "lowercase words"],
  ["sentence", "First word capitalized"],
  ["title", "Capitalized Words"],
];

/**
 * Every action the tool offers: `{ id, category, label, keywords?, needs?, apply }`.
 * `needs` names the Options field an action reads ("pattern" or "delimiter");
 * `apply(text, options)` is pure and may throw an Error with a user-facing
 * message. The UI, the ⌘K palette and the tests all iterate this list.
 */
export const ACTIONS = [
  // -- switch case
  {
    id: "case-cycle",
    category: "Switch case",
    label: "Switch case (cycle formats)",
    keywords: ["toggle", "rotate", "next"],
    apply: (text) => cycleCase(text),
  },
  ...CASE_FORMATS.map((format) => ({
    id: `to-${format.id}`,
    category: "Switch case",
    label: `To ${format.label}`,
    keywords: ["case", "convert"],
    apply: (text) => toCase(text, format.id),
  })),
  {
    id: "capitalize",
    category: "Switch case",
    label: "Capitalize words",
    keywords: ["upper", "first letter"],
    apply: (text) => capitalizeWords(text),
  },
  {
    id: "to-lower",
    category: "Switch case",
    label: "To lower case",
    apply: (text) => text.toLowerCase(),
  },
  {
    id: "to-upper",
    category: "Switch case",
    label: "To UPPER CASE",
    apply: (text) => text.toUpperCase(),
  },
  {
    id: "invert-case",
    category: "Switch case",
    label: "Invert case",
    keywords: ["swap case"],
    apply: (text) => invertCase(text),
  },
  {
    id: "spring-env",
    category: "Switch case",
    label: "To Spring Boot env variable",
    keywords: ["environment", "relaxed binding", "SPRING_"],
    apply: (text) => toSpringEnv(text),
  },
  // -- case toggles
  ...CASE_TOGGLES.map(([id, label, otherId = "camel", otherLabel = "camelCase"]) => ({
    id: `toggle-${id}-${otherId}`,
    category: "Case toggles",
    label: `Toggle: ${label} / ${otherLabel}`,
    keywords: ["switch", "flip"],
    apply: (text) => toggleCase(text, id, otherId),
  })),
  // -- sort
  {
    id: "reverse-lines",
    category: "Sort lines",
    label: "Reverse order of lines",
    apply: (text) => reverseLines(text),
  },
  {
    id: "shuffle-lines",
    category: "Sort lines",
    label: "Shuffle lines",
    keywords: ["random"],
    apply: (text, options = {}) => shuffleLines(text, options.rng ?? Math.random),
  },
  {
    id: "sort-az",
    category: "Sort lines",
    label: "Sort case-sensitive A-z",
    keywords: ["ascending", "alphabetical"],
    apply: (text) => sortLines(text),
  },
  {
    id: "sort-za",
    category: "Sort lines",
    label: "Sort case-sensitive z-A",
    keywords: ["descending"],
    apply: (text) => sortLines(text, { descending: true }),
  },
  {
    id: "sort-az-ci",
    category: "Sort lines",
    label: "Sort case-insensitive A-Z (natural)",
    keywords: ["ascending", "collator", "natural order"],
    apply: (text) => sortLines(text, { caseSensitive: false }),
  },
  {
    id: "sort-za-ci",
    category: "Sort lines",
    label: "Sort case-insensitive Z-A (natural)",
    keywords: ["descending", "collator", "natural order"],
    apply: (text) => sortLines(text, { caseSensitive: false, descending: true }),
  },
  {
    id: "sort-length-asc",
    category: "Sort lines",
    label: "Sort by line length ascending",
    apply: (text) => sortLinesByLength(text),
  },
  {
    id: "sort-length-desc",
    category: "Sort lines",
    label: "Sort by line length descending",
    apply: (text) => sortLinesByLength(text, { descending: true }),
  },
  {
    id: "sort-hex",
    category: "Sort lines",
    label: "Sort hexadecimally",
    keywords: ["0x", "number"],
    apply: (text) => sortLinesHex(text),
  },
  {
    id: "sort-tokens",
    category: "Sort lines",
    label: "Sort tokens (delimited text)",
    keywords: ["csv", "split"],
    needs: "delimiter",
    apply: (text, options = {}) => sortTokens(text, options.delimiter ?? ""),
  },
  {
    id: "hierarchical-sort",
    category: "Sort lines",
    label: "Hierarchical sort (by indentation)",
    keywords: ["tree", "nested", "indent"],
    apply: (text) => hierarchicalSort(text),
  },
  {
    id: "shuffle-chars",
    category: "Sort lines",
    label: "Shuffle characters",
    keywords: ["random", "scramble"],
    apply: (text, options = {}) => shuffleChars(text, options.rng ?? Math.random),
  },
  {
    id: "json-sort",
    category: "Sort lines",
    label: "JSON sort (object keys)",
    keywords: ["keys", "alphabetical"],
    apply: (text) => sortJson(text),
  },
  // -- align
  {
    id: "align-columns",
    category: "Align",
    label: "Format to columns / table",
    keywords: ["pad", "csv", "delimiter", "align"],
    needs: "delimiter",
    apply: (text, options = {}) => alignColumns(text, options.delimiter ?? ""),
  },
  {
    id: "align-left",
    category: "Align",
    label: "Align text left",
    apply: (text) => alignText(text, "left"),
  },
  {
    id: "align-center",
    category: "Align",
    label: "Align text center",
    apply: (text) => alignText(text, "center"),
  },
  {
    id: "align-right",
    category: "Align",
    label: "Align text right",
    apply: (text) => alignText(text, "right"),
  },
  // -- filter / remove / trim
  {
    id: "grep",
    category: "Filter / remove / trim",
    label: "Grep (keep matching lines)",
    keywords: ["filter", "search", "regex"],
    needs: "pattern",
    apply: (text, options = {}) => grepLines(text, options.pattern),
  },
  {
    id: "grep-invert",
    category: "Filter / remove / trim",
    label: "Inverted grep (drop matching lines)",
    keywords: ["filter", "exclude", "regex"],
    needs: "pattern",
    apply: (text, options = {}) => grepLines(text, options.pattern, { invert: true }),
  },
  {
    id: "group-grep",
    category: "Filter / remove / trim",
    label: "Group by grep (matches first)",
    keywords: ["separate", "partition", "regex"],
    needs: "pattern",
    apply: (text, options = {}) => groupByGrep(text, options.pattern),
  },
  {
    id: "trim",
    category: "Filter / remove / trim",
    label: "Trim lines",
    keywords: ["whitespace", "strip"],
    apply: (text) => trimLines(text),
  },
  {
    id: "trim-trailing",
    category: "Filter / remove / trim",
    label: "Trim trailing whitespace",
    apply: (text) => trimTrailing(text),
  },
  {
    id: "trim-leading",
    category: "Filter / remove / trim",
    label: "Trim leading whitespace",
    apply: (text) => trimLeading(text),
  },
  {
    id: "collapse-spaces",
    category: "Filter / remove / trim",
    label: "Whitespace runs → single space",
    keywords: ["collapse", "squeeze"],
    apply: (text) => collapseWhitespace(text),
  },
  {
    id: "remove-spaces",
    category: "Filter / remove / trim",
    label: "Remove all spaces",
    apply: (text) => removeAllSpaces(text),
  },
  {
    id: "remove-duplicates",
    category: "Filter / remove / trim",
    label: "Remove duplicate lines",
    keywords: ["unique", "dedupe"],
    apply: (text) => removeDuplicateLines(text),
  },
  {
    id: "keep-duplicates",
    category: "Filter / remove / trim",
    label: "Keep only duplicate lines",
    apply: (text) => keepOnlyDuplicateLines(text),
  },
  {
    id: "remove-empty",
    category: "Filter / remove / trim",
    label: "Remove empty lines",
    keywords: ["blank"],
    apply: (text) => removeEmptyLines(text),
  },
  {
    id: "remove-consecutive-empty",
    category: "Filter / remove / trim",
    label: "Collapse consecutive empty lines",
    keywords: ["blank"],
    apply: (text) => removeConsecutiveEmptyLines(text),
  },
  {
    id: "remove-newlines",
    category: "Filter / remove / trim",
    label: "Remove all newlines",
    keywords: ["join lines", "one line"],
    apply: (text) => removeAllNewlines(text),
  },
  // -- convert
  {
    id: "json-minify",
    category: "Convert",
    label: "Minify JSON",
    keywords: ["compact", "one line"],
    apply: (text) => minifyJson(text),
  },
  {
    id: "json-to-yaml",
    category: "Convert",
    label: "JSON → YAML",
    keywords: ["convert", "yml"],
    apply: (text) => jsonToYaml(text),
  },
  {
    id: "yaml-to-json",
    category: "Convert",
    label: "YAML → JSON",
    keywords: ["convert", "yml"],
    apply: (text) => yamlToJson(text),
  },
  // -- quotes & other
  {
    id: "reverse-letters",
    category: "Quotes & other",
    label: "Reverse letters (per line)",
    keywords: ["mirror", "backwards"],
    apply: (text) => reverseLetters(text),
  },
  {
    id: "swap-words",
    category: "Quotes & other",
    label: "Swap words (reverse order per line)",
    apply: (text) => swapWords(text),
  },
  {
    id: "shift-quotes",
    category: "Quotes & other",
    label: 'Shift quotes: " → \' → ` → "',
    keywords: ["wrap", "backtick", "cycle"],
    apply: (text) => shiftQuotes(text),
  },
  {
    id: "swap-quotes",
    category: "Quotes & other",
    label: "Swap double ↔ single quotes",
    apply: (text) => swapQuotes(text),
  },
  {
    id: "educate-quotes",
    category: "Quotes & other",
    label: "Educate quotes (straight → curly)",
    keywords: ["typographic", "smart quotes"],
    apply: (text) => educateQuotes(text),
  },
  {
    id: "straighten-quotes",
    category: "Quotes & other",
    label: "Straighten quotes (curly → straight)",
    keywords: ["plain", "ascii"],
    apply: (text) => straightenQuotes(text),
  },
  {
    id: "switch-path-separators",
    category: "Quotes & other",
    label: "Switch path separators: Windows ↔ UNIX",
    keywords: ["slash", "backslash", "file path"],
    apply: (text) => switchPathSeparators(text),
  },
];

/** Category display order for the UI. */
export const CATEGORIES = [...new Set(ACTIONS.map((action) => action.category))];

/** Look up an action by id — throws for unknown ids so typos fail loudly. */
export function findAction(id) {
  const action = ACTIONS.find((a) => a.id === id);
  if (!action) throw new Error(`Unknown action: ${id}`);
  return action;
}

/**
 * Run one action against `text`. Newlines are normalized to LF first;
 * `options` carries the Options-panel values (`pattern`, `delimiter`, `rng`).
 */
export function applyAction(id, text, options = {}) {
  return findAction(id).apply(normalizeNewlines(text), options);
}

/* ------------------------------- favourites -------------------------------
   Starred actions surface in the tool's Favourites rail. The (de)serialising
   lives here so the storage format is pinned by the parity tests; app.js only
   moves the strings in and out of localStorage. */

/**
 * Parse a stored favourites value: a JSON array of action ids. Junk input,
 * non-string entries, duplicates and ids of removed actions all degrade to a
 * clean list rather than an error.
 */
export function parseFavorites(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const known = new Set(ACTIONS.map((action) => action.id));
  return [...new Set(parsed.filter((id) => typeof id === "string" && known.has(id)))];
}

/** Serialize favourite action ids for storage. */
export function serializeFavorites(ids) {
  return JSON.stringify(ids);
}

/** Toggle one id: present → removed, absent → appended (keeps starred order). */
export function toggleFavorite(ids, id) {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}

/**
 * Filter the action list for the search box: every whitespace-separated term
 * must appear in the action's label, category or keywords (case-insensitive).
 */
export function filterActions(query, actions = ACTIONS) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return actions;
  return actions.filter((action) => {
    const haystack = `${action.label} ${action.category} ${(action.keywords ?? []).join(" ")}`
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

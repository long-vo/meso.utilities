// meso.utilities — minimal YAML support for the Text Transform tool.
// Dual-consumption: imported by the browser UI (via transform.mjs) and by the
// parity tests. JSON → YAML serializes any JSON value. YAML → JSON parses the
// common subset: block mappings and sequences, flow collections, quoted and
// plain scalars, comments and a leading `---`. Not supported (they throw a
// descriptive Error): anchors/aliases, tags, multi-document streams and block
// scalars (`|` and `>`).

/* ------------------------------ JSON → YAML ------------------------------ */

const INDENT = "  ";

function isContainer(value) {
  return value !== null && typeof value === "object";
}

function isEmptyContainer(value) {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

/** True when a string can be emitted unquoted without changing meaning. */
function isPlainSafe(s) {
  return (
    /^[A-Za-z_][A-Za-z0-9 _./@-]*$/.test(s) &&
    !/\s$/.test(s) &&
    !/^(?:true|false|null|yes|no|on|off)$/i.test(s)
  );
}

function scalarToYaml(value) {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  return isPlainSafe(value) ? value : JSON.stringify(value);
}

function keyToYaml(key) {
  return /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key);
}

function yamlify(value, depth) {
  const pad = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + "[]";
    return value
      .map((item) => {
        if (isContainer(item) && !isEmptyContainer(item)) {
          // Nest the item one level deeper, then let "- " take over its
          // first line's indent (both are exactly two characters wide).
          return pad + "- " + yamlify(item, depth + 1).slice(pad.length + INDENT.length);
        }
        if (isContainer(item)) return pad + "- " + (Array.isArray(item) ? "[]" : "{}");
        return pad + "- " + scalarToYaml(item);
      })
      .join("\n");
  }
  if (isContainer(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return pad + "{}";
    return entries
      .map(([key, item]) => {
        const head = pad + keyToYaml(key) + ":";
        if (isContainer(item) && !isEmptyContainer(item)) {
          return head + "\n" + yamlify(item, depth + 1);
        }
        if (isContainer(item)) return head + " " + (Array.isArray(item) ? "[]" : "{}");
        return head + " " + scalarToYaml(item);
      })
      .join("\n");
  }
  return pad + scalarToYaml(value);
}

/** Convert a JSON document to YAML. */
export function jsonToYaml(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
  return yamlify(value, 0);
}

/* ------------------------------ YAML → JSON ------------------------------ */

/** Strip a trailing comment (a `#` outside quotes, at start or after a space). */
function stripComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"' && ch === "\\") {
      i++;
      continue;
    }
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Index of the closing quote for the quote opening at index 0, or -1. */
function findQuoteEnd(text, quote) {
  for (let i = 1; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** Parse one scalar token (quoted, boolean, null, number or plain string). */
function parseScalar(s) {
  if (s === "" || s === "~" || /^null$/i.test(s)) return null;
  if (s[0] === '"') {
    if (findQuoteEnd(s, '"') !== s.length - 1) {
      throw new Error(`YAML: unterminated double-quoted string: ${s}`);
    }
    return JSON.parse(s);
  }
  if (s[0] === "'") {
    if (findQuoteEnd(s, "'") !== s.length - 1) {
      throw new Error(`YAML: unterminated single-quoted string: ${s}`);
    }
    return s.slice(1, -1).replaceAll("''", "'");
  }
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return Number(s);
  return s;
}

/* ---- flow collections ( [a, b] / {k: v} ) ---- */

function skipFlowSpaces(state) {
  while (state.pos < state.s.length && " \t".includes(state.s[state.pos])) state.pos++;
}

function flowQuoted(state) {
  const quote = state.s[state.pos];
  const end = findQuoteEnd(state.s.slice(state.pos), quote);
  if (end === -1) throw new Error("YAML: unterminated string in flow value");
  const token = state.s.slice(state.pos, state.pos + end + 1);
  state.pos += end + 1;
  return parseScalar(token);
}

function flowPlain(state) {
  let end = state.pos;
  while (end < state.s.length && !",[]{}:".includes(state.s[end])) end++;
  const token = state.s.slice(state.pos, end).trim();
  state.pos = end;
  return parseScalar(token);
}

function flowValue(state) {
  skipFlowSpaces(state);
  const ch = state.s[state.pos];
  if (ch === "[") return flowSeq(state);
  if (ch === "{") return flowMap(state);
  if (ch === '"' || ch === "'") return flowQuoted(state);
  return flowPlain(state);
}

function flowSeq(state) {
  state.pos++; // consume [
  const out = [];
  skipFlowSpaces(state);
  if (state.s[state.pos] === "]") {
    state.pos++;
    return out;
  }
  for (;;) {
    out.push(flowValue(state));
    skipFlowSpaces(state);
    const ch = state.s[state.pos];
    state.pos++;
    if (ch === ",") continue;
    if (ch === "]") return out;
    throw new Error("YAML: expected , or ] in flow sequence");
  }
}

function flowMap(state) {
  state.pos++; // consume {
  const out = {};
  skipFlowSpaces(state);
  if (state.s[state.pos] === "}") {
    state.pos++;
    return out;
  }
  for (;;) {
    const key = flowValue(state);
    skipFlowSpaces(state);
    if (state.s[state.pos] !== ":") throw new Error("YAML: expected : in flow mapping");
    state.pos++;
    out[String(key)] = flowValue(state);
    skipFlowSpaces(state);
    const ch = state.s[state.pos];
    state.pos++;
    if (ch === ",") continue;
    if (ch === "}") return out;
    throw new Error("YAML: expected , or } in flow mapping");
  }
}

function parseFlow(s) {
  const state = { s, pos: 0 };
  const value = flowValue(state);
  skipFlowSpaces(state);
  if (state.pos !== s.length) throw new Error(`YAML: trailing characters after flow value: ${s}`);
  return value;
}

/* ---- block structure ---- */

function parseValueText(s) {
  if (s.startsWith("[") || s.startsWith("{")) return parseFlow(s);
  if (/^[|>]/.test(s)) throw new Error("YAML: block scalars (| and >) aren't supported");
  if (/^[&*!]/.test(s)) throw new Error("YAML: anchors, aliases and tags aren't supported");
  return parseScalar(s);
}

/** Split `key: value` (value may be empty). Returns null when the line is no mapping entry. */
function splitKeyValue(text) {
  if (text[0] === '"' || text[0] === "'") {
    const end = findQuoteEnd(text, text[0]);
    if (end === -1 || text[end + 1] !== ":") return null;
    const key = text[0] === '"'
      ? JSON.parse(text.slice(0, end + 1))
      : text.slice(1, end).replaceAll("''", "'");
    return { key, value: text.slice(end + 2).trim() };
  }
  const match = text.match(/^([^:]+?)\s*:(?:\s+(.*))?$/);
  if (!match) return null;
  return { key: match[1], value: (match[2] ?? "").trim() };
}

function isSequenceItem(text) {
  return text === "-" || text.startsWith("- ");
}

function parseBlock(parser, minIndent) {
  const first = parser.items[parser.pos];
  if (!first || first.indent < minIndent) return null;
  if (isSequenceItem(first.text)) return parseSequence(parser, first.indent);
  return parseMappingOrScalar(parser, first.indent);
}

function parseSequence(parser, indent) {
  const out = [];
  while (parser.pos < parser.items.length) {
    const item = parser.items[parser.pos];
    if (item.indent !== indent || !isSequenceItem(item.text)) break;
    parser.pos++;
    const rest = item.text.slice(1).trim();
    if (rest === "") {
      const next = parser.items[parser.pos];
      out.push(next && next.indent > indent ? parseBlock(parser, indent + 1) : null);
    } else {
      // Re-enter the parser at the content after "- ": its real column keeps
      // following keys of the same inline mapping aligned with it.
      const column = indent + (item.text.length - rest.length);
      parser.items.splice(parser.pos, 0, { indent: column, text: rest });
      out.push(parseBlock(parser, column));
    }
  }
  return out;
}

function parseMappingOrScalar(parser, indent) {
  const first = parser.items[parser.pos];
  // A flow collection or plain scalar line is a value, not a mapping entry —
  // check flow openers first so `{a: 1}` is never split at its inner colon.
  const isFlow = first.text.startsWith("{") || first.text.startsWith("[");
  if (isFlow || splitKeyValue(first.text) === null) {
    parser.pos++;
    return parseValueText(first.text);
  }
  const out = {};
  while (parser.pos < parser.items.length) {
    const item = parser.items[parser.pos];
    if (item.indent !== indent || isSequenceItem(item.text)) break;
    const entry = splitKeyValue(item.text);
    if (entry === null) throw new Error(`YAML: expected "key: value" at "${item.text}"`);
    parser.pos++;
    if (entry.value !== "") {
      out[entry.key] = parseValueText(entry.value);
      continue;
    }
    const next = parser.items[parser.pos];
    if (next && next.indent > indent) {
      out[entry.key] = parseBlock(parser, indent + 1);
    } else if (next && next.indent === indent && isSequenceItem(next.text)) {
      // Sequences are commonly written at the same indent as their key.
      out[entry.key] = parseSequence(parser, indent);
    } else {
      out[entry.key] = null;
    }
  }
  return out;
}

/** Parse a YAML document (common subset — see module comment) into a JS value. */
export function parseYaml(text) {
  const items = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = stripComment(raw);
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "---" || trimmed === "...") continue;
    items.push({ indent: line.match(/^ */)[0].length, text: trimmed });
  }
  if (items.length === 0) return null;
  const parser = { items, pos: 0 };
  const value = parseBlock(parser, 0);
  if (parser.pos < items.length) {
    throw new Error(`YAML: unexpected content at "${parser.items[parser.pos].text}"`);
  }
  return value;
}

/** Convert a YAML document to pretty-printed JSON. */
export function yamlToJson(text) {
  return JSON.stringify(parseYaml(text), null, 2);
}

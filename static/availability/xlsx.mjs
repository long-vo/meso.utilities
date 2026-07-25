// meso.utilities — minimal .xlsx workbook reader for the Team Availability tool.
// Values only: it walks the ZIP central directory, inflates entries with
// DecompressionStream("deflate-raw") and scans the sheet XML for cached cell
// values. Non-goals (deliberate — see docs/plan-availability-heatmap.md):
// styles, fills, formulas (their cached results are read), merged-cell
// expansion, zip64, writing. Imported unchanged by the browser UI and by the
// Deno parity tests (src/xlsx.test.ts).

const EOCD_SIG = 0x06054b50; // end-of-central-directory record
const CENTRAL_SIG = 0x02014b50; // central-directory file header
const LOCAL_SIG = 0x04034b50; // local file header

const NOT_ZIP = "not a zip archive (no end-of-central-directory record)";
const NOT_XLSX = "not an xlsx workbook (xl/workbook.xml is missing)";

/**
 * Convert an A1-style cell reference into zero-based coordinates.
 * `"BC12"` → `{ row: 11, col: 54 }`.
 *
 * @param {string} ref
 * @returns {{ row: number, col: number }}
 */
export function refToRowCol(ref) {
  const m = /^([A-Z]+)([0-9]+)$/.exec(ref);
  if (!m) throw new Error(`invalid cell reference: ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

/**
 * Read every worksheet of an .xlsx workbook into plain value grids.
 *
 * Sheets come back in workbook order (the tab order in Excel), each as a
 * dense `rows[row][col]` array. Cell values are `string` (shared, inline and
 * cached-formula strings), `number` (plain numbers and date serials — Excel
 * stores dates as day counts; interpreting them is the caller's job),
 * `boolean`, or `null` (error cells, style-only padding cells and gaps).
 *
 * @param {ArrayBuffer | Uint8Array} data the workbook file's bytes
 * @returns {Promise<Array<{ name: string, rows: Array<Array<string | number | boolean | null>> }>>}
 */
export async function readWorkbook(data) {
  const bytes = data instanceof Uint8Array
    ? data
    : data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : null;
  if (bytes === null) throw new TypeError("readWorkbook expects an ArrayBuffer or Uint8Array");

  const entries = readCentralDirectory(bytes);
  if (!entries.has("xl/workbook.xml")) throw new Error(NOT_XLSX);

  const text = async (/** @type {string} */ name) =>
    new TextDecoder().decode(await readEntry(bytes, entries.get(name)));

  const rels = entries.has("xl/_rels/workbook.xml.rels")
    ? parseRels(await text("xl/_rels/workbook.xml.rels"))
    : new Map();
  const shared = entries.has("xl/sharedStrings.xml")
    ? parseSharedStrings(await text("xl/sharedStrings.xml"))
    : [];

  const sheets = [];
  for (const sheet of parseWorkbookSheets(await text("xl/workbook.xml"))) {
    // Real writers always provide the relationship; the sheetId path is a
    // defensive fallback for hand-assembled files.
    const path = rels.get(sheet.rid) ?? `xl/worksheets/sheet${sheet.sheetId}.xml`;
    if (!entries.has(path)) {
      throw new Error(`worksheet part for sheet "${sheet.name}" is missing (${path})`);
    }
    sheets.push({ name: sheet.name, rows: parseSheetCells(await text(path), shared) });
  }
  return sheets;
}

// --- zip container ---------------------------------------------------------

/**
 * Locate every entry via the central directory: name → where its data lives.
 * @param {Uint8Array} bytes
 * @returns {Map<string, { method: number, compSize: number, localOffset: number }>}
 */
function readCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error(NOT_ZIP);
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported");
  }
  const decoder = new TextDecoder();
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.byteLength || view.getUint32(p, true) !== CENTRAL_SIG) {
      throw new Error("corrupt zip: bad central-directory entry");
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (flags & 0x1) throw new Error("encrypted zip entries are not supported");
    if (compSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("zip64 archives are not supported");
    }
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * The EOCD sits at the very end, before an optional archive comment — scan
 * backwards over the longest comment a zip can carry.
 * @param {DataView} view
 */
function findEocd(view) {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Extract one entry's bytes. The local header repeats name/extra with its own
 * lengths (they can differ from the central directory's), so data starts are
 * computed from the local header, not assumed.
 *
 * @param {Uint8Array} bytes
 * @param {{ method: number, compSize: number, localOffset: number }} entry
 * @returns {Promise<Uint8Array>}
 */
async function readEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.localOffset;
  if (p + 30 > bytes.byteLength || view.getUint32(p, true) !== LOCAL_SIG) {
    throw new Error("corrupt zip: bad local file header");
  }
  const nameLen = view.getUint16(p + 26, true);
  const extraLen = view.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const comp = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return comp; // stored
  if (entry.method === 8) return await inflateRaw(comp); // deflate
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

/**
 * @param {Uint8Array} compressed
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(compressed) {
  const stream = new Blob([compressed]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- workbook XML ----------------------------------------------------------
// The scanners below are deliberately not a general XML parser: OOXML sheet
// parts are machine-written, attribute-quoted with `"`, and the handful of
// elements read here (<sheet>, <Relationship>, <si>, <c>, <v>, <is>, <t>)
// never nest inside each other in ways the regexes would misread.

/**
 * Sheet tabs in workbook (display) order, which is neither zip-entry order
 * nor rId order.
 * @param {string} xml
 * @returns {Array<{ name: string, sheetId: string, rid: string }>}
 */
function parseWorkbookSheets(xml) {
  const sheets = [];
  const re = /<sheet\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = readAttrs(m[1]);
    if (attrs["name"] === undefined) continue;
    sheets.push({
      name: unescapeXml(attrs["name"]),
      sheetId: attrs["sheetId"] ?? "",
      rid: attrs["r:id"] ?? "",
    });
  }
  return sheets;
}

/**
 * Workbook relationships: rId → entry path. Targets are relative to `xl/`
 * (`worksheets/sheet1.xml`) or package-absolute (`/xl/worksheets/sheet1.xml`).
 * @param {string} xml
 * @returns {Map<string, string>}
 */
function parseRels(xml) {
  const map = new Map();
  const re = /<Relationship\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = readAttrs(m[1]);
    const id = attrs["Id"];
    const target = attrs["Target"];
    if (id === undefined || target === undefined) continue;
    map.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  return map;
}

/**
 * The shared-string table: one string per `<si>`, rich-text runs concatenated,
 * phonetic `<rPh>` runs (East-Asian ruby annotations) dropped.
 * @param {string} xml
 * @returns {string[]}
 */
function parseSharedStrings(xml) {
  const items = [];
  const re = /<si(?:\s[^>]*)?\/>|<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml)) !== null) items.push(m[1] === undefined ? "" : textOf(m[1]));
  return items;
}

/**
 * All `<c>` cells of one worksheet into a dense rows[row][col] grid. Cells
 * without an `r` reference are skipped (real writers always emit it); cells
 * that carry only a style land as `null`, exactly like true gaps.
 *
 * @param {string} xml
 * @param {string[]} shared
 * @returns {Array<Array<string | number | boolean | null>>}
 */
function parseSheetCells(xml, shared) {
  /** @type {Array<Array<string | number | boolean | null>>} */
  const rows = [];
  const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = readAttrs(m[1]);
    if (attrs["r"] === undefined) continue;
    const { row, col } = refToRowCol(attrs["r"]);
    while (rows.length <= row) rows.push([]);
    const cells = rows[row];
    while (cells.length <= col) cells.push(null);
    cells[col] = cellValue(attrs["t"], m[2], shared);
  }
  return rows;
}

/**
 * One cell's value from its type attribute and inner XML.
 * @param {string | undefined} type
 * @param {string | undefined} body inner XML, undefined for self-closing cells
 * @param {string[]} shared
 * @returns {string | number | boolean | null}
 */
function cellValue(type, body, shared) {
  if (body === undefined) return null;
  if (type === "inlineStr") return textOf(body);
  const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
  if (v === null) return null;
  if (type === "s") return shared[Number(v[1])] ?? null;
  if (type === "str") return unescapeXml(v[1]);
  if (type === "b") return v[1].trim() === "1";
  if (type === "e") return null;
  const n = Number(v[1]);
  return Number.isFinite(n) ? n : null;
}

// --- XML micro-helpers -----------------------------------------------------

/**
 * Concatenated text of every `<t>` in a fragment (plain or rich-text runs),
 * with phonetic `<rPh>` blocks removed first.
 * @param {string} fragment
 */
function textOf(fragment) {
  const cleaned = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  const re = /<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let out = "";
  let m;
  while ((m = re.exec(cleaned)) !== null) out += m[1] === undefined ? "" : unescapeXml(m[1]);
  return out;
}

/**
 * Attributes of one element's attribute string: `r="A1" t="s"` → map.
 * @param {string} s
 * @returns {Record<string, string>}
 */
function readAttrs(s) {
  /** @type {Record<string, string>} */
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/**
 * Decode the five named XML entities plus numeric character references.
 * @param {string} s
 */
function unescapeXml(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code) => {
    if (code.startsWith("#")) {
      const hex = code[1] === "x" || code[1] === "X";
      const cp = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES.get(code) ?? whole;
  });
}

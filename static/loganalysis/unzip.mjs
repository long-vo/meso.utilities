// @ts-check
/**
 * meso.utilities — Log Analysis: minimal zip extraction for dropped log
 * bundles. Reads stored (method 0) and deflated (method 8) entries via
 * `DecompressionStream` — which covers what kubectl dumps and support bundles
 * actually contain. No zip64, no encryption, no multi-disk archives; an
 * archive using those fails loudly rather than yielding half a log.
 *
 * Deliberately not shared with the xlsx reader: that module wants workbook
 * parts by name, this one wants every text entry — and a five-line overlap is
 * cheaper than coupling two tools' file formats together.
 *
 * Dual-consumption: imported by `static/loganalysis/app.js` and by
 * `src/loganalysis.test.ts` (Deno ships `DecompressionStream` too).
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * Every entry of a zip archive, decompressed. Directory entries (a trailing
 * `/`) are skipped — they carry no bytes.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ name: string, bytes: Uint8Array }[]>}
 */
export async function unzipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record sits last, behind an optional comment
  // of up to 64 KiB — scan backwards for its signature.
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 65558);
  for (let at = bytes.length - 22; at >= stop; at--) {
    if (view.getUint32(at, true) === EOCD_SIG) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) throw new Error("Not a zip archive (no end-of-central-directory record).");

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder();
  /** @type {{ name: string, bytes: Uint8Array }[]} */
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== CENTRAL_SIG) {
      throw new Error("Corrupt zip: central directory entry not where declared.");
    }
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    if (method !== 0 && method !== 8) {
      throw new Error(`Unsupported zip compression (method ${method}) for ${name}.`);
    }

    // The local header repeats name/extra with its own lengths — the data
    // starts after *those*, not the central directory's.
    if (view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`Corrupt zip: local header missing for ${name}.`);
    }
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const data = bytes.subarray(start, start + compressedSize);

    entries.push({
      name,
      bytes: method === 0 ? data : await inflateRaw(data),
    });
  }
  return entries;
}

/**
 * Gunzip a whole file — the `.gz` a single pod log arrives as.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export function gunzip(bytes) {
  return decompress(bytes, "gzip");
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
function inflateRaw(bytes) {
  return decompress(bytes, "deflate-raw");
}

/**
 * @param {Uint8Array} bytes
 * @param {CompressionFormat} format
 * @returns {Promise<Uint8Array>}
 */
async function decompress(bytes, format) {
  const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream()
    .pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

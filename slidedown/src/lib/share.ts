import type { SourceFile } from '../types';

// Share-link format: '#deck=1.' + base64url(deflate-raw(JSON SourceFile[])).
// The content lives in the hash so it never reaches a server; the '1.' is a
// format version so the encoding can change without breaking old links.
const VERSION = '1';
const PREFIX = `#deck=${VERSION}.`;
const ANY_DECK_HASH = /^#deck=/;

/** Whether a hash looks like a deck share link (any version). */
export function hasDeckHash(hash: string): boolean {
  return ANY_DECK_HASH.test(hash);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000; // keep String.fromCharCode argument counts safe
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipe(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** Encode a deck's text sources into a '#deck=…' URL hash. */
export async function encodeDeckToHash(
  files: readonly SourceFile[],
): Promise<string> {
  const json = JSON.stringify(files.map(({ name, text }) => ({ name, text })));
  const packed = await pipe(
    new TextEncoder().encode(json),
    new CompressionStream('deflate-raw'),
  );
  return PREFIX + toBase64Url(packed);
}

/**
 * Decode a share-link hash back into source files. Returns null on anything
 * unexpected (wrong prefix or version, corrupt base64/deflate/JSON, payload
 * not shaped like SourceFile[]) — never throws.
 */
export async function decodeHashToFiles(
  hash: string,
): Promise<SourceFile[] | null> {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const packed = fromBase64Url(hash.slice(PREFIX.length));
    const json = new TextDecoder().decode(
      await pipe(packed, new DecompressionStream('deflate-raw')),
    );
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const files: SourceFile[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return null;
      const { name, text } = item as Record<string, unknown>;
      if (typeof name !== 'string' || typeof text !== 'string') return null;
      files.push({ name, text });
    }
    return files;
  } catch {
    return null;
  }
}

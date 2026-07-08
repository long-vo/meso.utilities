import type { Slide } from '../types';
import { renderMarkdown } from './markdown';

interface RawFile {
  readonly name: string;
  readonly text: string;
}

/**
 * Natural, case-insensitive filename compare so that
 * `2-intro.md` sorts before `10-outro.md`.
 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** A file is treated as Markdown if it has a common Markdown extension. */
export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(name);
}

/** Turn a filename into a readable fallback title. */
function titleFromFilename(name: string): string {
  return name
    .replace(/\.(md|markdown|mdown|mkd)$/i, '')
    .replace(/^\d+[-_.\s]*/, '') // drop leading ordering prefix like "01-"
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Prefer the first Markdown heading as the title, else the filename. */
function extractTitle(md: string, filename: string): string {
  const match = md.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
  if (match) return match[1].trim();
  return titleFromFilename(filename);
}

function toSlide(raw: RawFile, index: number): Slide {
  return {
    id: `slide-${index}`,
    title: extractTitle(raw.text, raw.name),
    filename: raw.name,
    html: renderMarkdown(raw.text),
  };
}

/** Build a deck from already-read files, sorted naturally by filename. */
export function slidesFromRaw(files: RawFile[]): Slide[] {
  return [...files]
    .sort((a, b) => naturalCompare(a.name, b.name))
    .map(toSlide);
}

/** Read a list of browser File objects into a sorted deck. */
export async function slidesFromFiles(fileList: File[]): Promise<Slide[]> {
  const markdown = fileList.filter((f) => isMarkdownFile(f.name));
  const raw = await Promise.all(
    markdown.map(async (f) => ({ name: f.name, text: await f.text() })),
  );
  return slidesFromRaw(raw);
}

// Sample deck bundled with the app for the "Load sample deck" button.
const sampleModules = import.meta.glob('../samples/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Build the bundled sample deck. */
export function sampleSlides(): Slide[] {
  const raw: RawFile[] = Object.entries(sampleModules).map(([path, text]) => ({
    name: path.split('/').pop() ?? path,
    text,
  }));
  return slidesFromRaw(raw);
}

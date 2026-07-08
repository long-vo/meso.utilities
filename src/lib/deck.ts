import type { Deck, DeckMeta, ProtoSlide, ThemeName } from '../types';
import { THEMES } from '../types';
import { renderMarkdown } from './markdown';

/**
 * Natural, case-insensitive filename compare so that
 * `2-intro.md` sorts before `10-outro.md`.
 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(name);
}

export function isPdfFile(name: string): boolean {
  return /\.pdf$/i.test(name);
}

export function isImageFile(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(name);
}

/** Any file type the viewer can turn into slides. */
export function isSupportedFile(name: string): boolean {
  return isMarkdownFile(name) || isPdfFile(name) || isImageFile(name);
}

// ---------------------------------------------------------------- helpers

function titleFromFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, '') // drop the file extension
    .replace(/^\d+[-_.\s]*/, '') // drop leading ordering prefix like "01-"
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The first Markdown heading in a chunk, or null. */
function firstHeading(md: string): string | null {
  const match = md.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
  return match ? match[1].trim() : null;
}

interface FrontMatter {
  [key: string]: string;
}

/** Strip a leading `---` YAML-ish front-matter block and parse simple key: value pairs. */
function parseFrontMatter(text: string): { body: string; fm: FrontMatter } {
  const match = text.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) return { body: text, fm: {} };
  const fm: FrontMatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/);
    if (pair) fm[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  return { body: text.slice(match[0].length), fm };
}

function asTheme(value: string | undefined): ThemeName | undefined {
  return value && (THEMES as readonly string[]).includes(value)
    ? (value as ThemeName)
    : undefined;
}

// Split on a line that is exactly `---` (slide break) / `???` (notes) / `+++` (fragment).
const SLIDE_BREAK = /^[ \t]*---[ \t]*$/m;
const NOTES_BREAK = /^[ \t]*\?\?\?[ \t]*$/m;
const FRAGMENT_BREAK = /^[ \t]*\+\+\+[ \t]*$/m;

// Lazily-loaded Mermaid helper, imported only when a slide uses a diagram.
let mermaidMod: typeof import('./mermaid') | null = null;

async function enhanceDiagrams(html: string): Promise<string> {
  if (!html.includes('language-mermaid')) return html;
  mermaidMod ??= await import('./mermaid');
  return mermaidMod.renderMermaidInHtml(html);
}

/** Render one slide chunk (body + optional notes + optional fragments). */
async function chunkToProto(
  chunk: string,
  filename: string,
  fallbackTitle: string,
): Promise<ProtoSlide> {
  const [rawBody, ...noteParts] = chunk.split(NOTES_BREAK);
  const body = rawBody.trim();
  const notesSrc = noteParts.join('\n\n').trim();

  const fragments = body
    .split(FRAGMENT_BREAK)
    .map((f) => f.trim())
    .filter(Boolean);

  let html: string;
  let fragmentCount = 1;
  if (fragments.length > 1) {
    fragmentCount = fragments.length;
    html = fragments
      .map(
        (f, i) =>
          `<div class="fragment" data-fragment="${i}">${renderMarkdown(f)}</div>`,
      )
      .join('\n');
  } else {
    html = renderMarkdown(body);
  }
  html = await enhanceDiagrams(html);

  const notes = notesSrc
    ? await enhanceDiagrams(renderMarkdown(notesSrc))
    : undefined;

  return {
    title: firstHeading(body) ?? fallbackTitle,
    filename,
    kind: 'markdown',
    html,
    notes,
    fragmentCount,
  };
}

/** Split one Markdown file body into one or more slide protos. */
async function markdownProtos(
  filename: string,
  body: string,
): Promise<ProtoSlide[]> {
  const chunks = body
    .split(SLIDE_BREAK)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const base = titleFromFilename(filename);
  const many = chunks.length > 1;
  return Promise.all(
    chunks.map((chunk, i) =>
      chunkToProto(chunk, filename, many ? `${base} ${i + 1}` : base),
    ),
  );
}

function imageProto(file: File): ProtoSlide {
  return {
    title: titleFromFilename(file.name),
    filename: file.name,
    kind: 'image',
    html: '',
    src: URL.createObjectURL(file),
    fragmentCount: 1,
  };
}

function withIds(protos: ProtoSlide[]): Deck['slides'] {
  return protos.map((p, i) => ({ id: `slide-${i}`, ...p }));
}

// ---------------------------------------------------------------- public API

/**
 * Read a list of browser File objects into a sorted deck.
 * Markdown files become one or more slides (split on `---`); PDFs expand to one
 * slide per page; images become one slide each. Front-matter sets deck meta.
 */
export async function slidesFromFiles(fileList: File[]): Promise<Deck> {
  const files = fileList
    .filter((f) => isSupportedFile(f.name))
    .sort((a, b) => naturalCompare(a.name, b.name));

  const protos: ProtoSlide[] = [];
  const meta: { title?: string; author?: string; theme?: ThemeName } = {};
  let pdf: typeof import('./pdf') | null = null;

  for (const file of files) {
    if (isPdfFile(file.name)) {
      pdf ??= await import('./pdf');
      protos.push(...(await pdf.slidesFromPdf(file)));
    } else if (isImageFile(file.name)) {
      protos.push(imageProto(file));
    } else {
      const { body, fm } = parseFrontMatter(await file.text());
      if (meta.title === undefined && fm.title) meta.title = fm.title;
      if (meta.author === undefined && fm.author) meta.author = fm.author;
      if (meta.theme === undefined) meta.theme = asTheme(fm.theme);
      protos.push(...(await markdownProtos(file.name, body)));
    }
  }

  return { slides: withIds(protos), meta };
}

// Sample deck bundled with the app for the "Load sample deck" button.
const sampleModules = import.meta.glob('../samples/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Build the bundled sample deck. */
export async function sampleSlides(): Promise<Deck> {
  const entries = Object.entries(sampleModules)
    .map(([path, text]) => ({ name: path.split('/').pop() ?? path, text }))
    .sort((a, b) => naturalCompare(a.name, b.name));

  const meta: DeckMeta = {};
  const protos: ProtoSlide[] = [];
  for (const entry of entries) {
    const { body } = parseFrontMatter(entry.text);
    protos.push(...(await markdownProtos(entry.name, body)));
  }
  return { slides: withIds(protos), meta };
}

import type { Deck, DeckMeta, ProtoSlide, ThemeName } from '../types';
import { THEMES } from '../types';
import { renderMarkdown, sanitizeHtml } from './markdown';
import { applyAnimations } from './animate';
import { countExtraSteps } from './code-steps';

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

export function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name);
}

export function isAsciiDocFile(name: string): boolean {
  return /\.(adoc|asciidoc)$/i.test(name);
}

/** Any file type the viewer can turn into slides. */
export function isSupportedFile(name: string): boolean {
  return isMarkdownFile(name) || isPdfFile(name) || isImageFile(name) ||
    isHtmlFile(name) || isAsciiDocFile(name);
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

/** The first Markdown heading in a chunk, or null (animation token stripped). */
function firstHeading(md: string): string | null {
  const match = md.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
  if (!match) return null;
  return match[1]
    .trim()
    .replace(/^@(?:fade|up|down|left|right|zoom)(?::\d{1,5}){0,2}[ \t]*/, '');
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
// `|||` splits the two halves of an `@columns` slide.
const COLUMN_BREAK = /^[ \t]*\|\|\|[ \t]*$/m;

// ------------------------------------------------------------ slide layout
// Slide-level directives on their own lines at the top of a slide chunk:
//   @background <css colour | image url>
//   @columns                (split the slide at a ||| line into two columns)
//   @image-left <url>       (media half + content half; also @image-right)
const LAYOUT_DIRECTIVE = /^[ \t]*@(background|columns|image-left|image-right)(?:[ \t]+(\S.*?))?[ \t]*$/;

interface SlideLayout {
  background?: string;
  columns?: boolean;
  image?: { src: string; side: 'left' | 'right' };
}

/** Strip leading layout directives off a slide chunk. */
function extractLayout(body: string): { body: string; layout: SlideLayout } {
  const lines = body.split(/\r?\n/);
  const layout: SlideLayout = {};
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    const match = lines[i].match(LAYOUT_DIRECTIVE);
    if (!match) break;
    const [, name, value] = match;
    if (name === 'background' && value) layout.background = value.trim();
    else if (name === 'columns') layout.columns = true;
    else if ((name === 'image-left' || name === 'image-right') && value) {
      layout.image = { src: value.trim(), side: name === 'image-left' ? 'left' : 'right' };
    }
    i++;
  }
  return { body: lines.slice(i).join('\n'), layout };
}

/**
 * A full-bleed background layer, baked into the slide HTML so the live view,
 * thumbnails, speaker view and PDF export all get it for free. The value is
 * restricted to harmless CSS characters; anything else is dropped.
 */
function backgroundDiv(value: string): string {
  if (!/^[-\w#%(),./: ]+$/.test(value)) return '';
  const isColor = /^(#|rgb|hsl|linear-gradient|var\()/i.test(value) ||
    /^[a-z]+$/i.test(value);
  const style = isColor
    ? `background:${value}`
    : `background-image:url('${value}');background-size:cover;background-position:center`;
  return `<div class="slide-bg" style="${style}"></div>`;
}

// Lazily-loaded Mermaid helper, imported only when a slide uses a diagram.
let mermaidMod: typeof import('./mermaid') | null = null;

async function enhanceDiagrams(html: string): Promise<string> {
  if (!html.includes('language-mermaid')) return html;
  mermaidMod ??= await import('./mermaid');
  return mermaidMod.renderMermaidInHtml(html);
}

/** Render one slide chunk (directives + body + optional notes/fragments). */
async function chunkToProto(
  chunk: string,
  filename: string,
  fallbackTitle: string,
): Promise<ProtoSlide> {
  const [rawBody, ...noteParts] = chunk.split(NOTES_BREAK);
  const { body: stripped, layout } = extractLayout(rawBody.trim());
  const body = stripped.trim();
  const notesSrc = noteParts.join('\n\n').trim();

  let html: string;
  let fragmentCount = 1;
  if (layout.columns) {
    // Columns take the whole body; `+++` fragments are not split inside them.
    const [left, right = ''] = body.split(COLUMN_BREAK);
    html = `<div class="cols"><div class="col">${renderMarkdown(left)}</div>` +
      `<div class="col">${renderMarkdown(right)}</div></div>`;
  } else {
    const fragments = body
      .split(FRAGMENT_BREAK)
      .map((f) => f.trim())
      .filter(Boolean);
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
  }

  if (layout.image) {
    // Rendering the image through markdown keeps DOMPurify in charge of it.
    const media = renderMarkdown(`![](${layout.image.src})`);
    html = `<div class="split split-${layout.image.side}">` +
      `<div class="split-media">${media}</div>` +
      `<div class="split-body">${html}</div></div>`;
  }
  if (layout.background) html = backgroundDiv(layout.background) + html;

  html = await enhanceDiagrams(html);
  html = applyAnimations(html);
  // Stepped code blocks (```js {1|2-3}) advance like extra fragments.
  fragmentCount += countExtraSteps(html);

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

/** An HTML file becomes exactly one sanitized slide. */
async function htmlProto(name: string, text: string): Promise<ProtoSlide> {
  const dom = new DOMParser().parseFromString(text, 'text/html');
  const heading = dom.querySelector('h1, h2, h3')?.textContent?.trim();
  const title = heading || dom.title.trim() || titleFromFilename(name);
  const html = await enhanceDiagrams(sanitizeHtml(dom.body.innerHTML));
  return { title, filename: name, kind: 'markdown', html, fragmentCount: 1 };
}

// Meta an AsciiDoc header can contribute to the deck, mutable like the loader's.
type PartialMeta = { title?: string; author?: string; theme?: ThemeName };

// Lazily-loaded AsciiDoc processor, imported only when an .adoc file is present
// (kept out of the main bundle just like pdfjs-dist and mermaid).
let asciidoctorMod: typeof import('@asciidoctor/core') | null = null;

/**
 * Convert one AsciiDoc file into slides: the document title + preamble form a
 * leading slide (when present), then each top-level `==` section is one slide.
 * A section-less document is a single slide.
 */
async function asciidocSlides(
  name: string,
  text: string,
): Promise<{ protos: ProtoSlide[]; meta: PartialMeta }> {
  asciidoctorMod ??= await import('@asciidoctor/core');
  const doc = await asciidoctorMod.load(text);

  const docTitle = doc.getDocumentTitle();
  const title = typeof docTitle === 'string' ? docTitle : undefined;
  const meta: PartialMeta = {
    title: title || undefined,
    author: doc.getAuthor() || undefined,
    theme: asTheme(doc.getAttribute('theme')),
  };
  const fallback = title || titleFromFilename(name);

  const proto = async (html: string, slideTitle: string): Promise<ProtoSlide> => ({
    title: slideTitle,
    filename: name,
    kind: 'markdown',
    html: await enhanceDiagrams(sanitizeHtml(html)),
    fragmentCount: 1,
  });

  // asciidoctor renders in embedded mode, which omits the level-0 title, so
  // prepend it as an <h1> (sanitized downstream) to both slide shapes.
  const titleHead = title ? `<h1>${title}</h1>` : '';
  const sections = doc.getSections();
  if (sections.length === 0) {
    return { protos: [await proto(titleHead + (await doc.convert()), fallback)], meta };
  }

  const protos: ProtoSlide[] = [];
  const preamble = doc.getBlocks().find((b) => b.getContext() === 'preamble');
  const lead = titleHead + (preamble ? await preamble.convert() : '');
  if (lead.trim()) protos.push(await proto(lead, fallback));
  for (const section of sections) {
    protos.push(await proto(await section.convert(), section.getTitle() ?? fallback));
  }
  return { protos, meta };
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
    } else if (isHtmlFile(file.name)) {
      protos.push(await htmlProto(file.name, await file.text()));
    } else if (isAsciiDocFile(file.name)) {
      const { protos: adocProtos, meta: adocMeta } = await asciidocSlides(
        file.name,
        await file.text(),
      );
      if (meta.title === undefined && adocMeta.title) meta.title = adocMeta.title;
      if (meta.author === undefined && adocMeta.author) meta.author = adocMeta.author;
      if (meta.theme === undefined) meta.theme = adocMeta.theme;
      protos.push(...adocProtos);
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
const sampleModules = import.meta.glob(
  ['../samples/*.md', '../samples/*.html', '../samples/*.adoc'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

/** Build the bundled sample deck (Markdown, HTML and AsciiDoc files). */
export async function sampleSlides(): Promise<Deck> {
  const entries = Object.entries(sampleModules)
    .map(([path, text]) => ({ name: path.split('/').pop() ?? path, text }))
    .sort((a, b) => naturalCompare(a.name, b.name));

  const meta: DeckMeta = {};
  const protos: ProtoSlide[] = [];
  for (const entry of entries) {
    if (isHtmlFile(entry.name)) {
      protos.push(await htmlProto(entry.name, entry.text));
    } else if (isAsciiDocFile(entry.name)) {
      protos.push(...(await asciidocSlides(entry.name, entry.text)).protos);
    } else {
      const { body } = parseFrontMatter(entry.text);
      protos.push(...(await markdownProtos(entry.name, body)));
    }
  }
  return { slides: withIds(protos), meta };
}

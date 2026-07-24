export type SlideKind = 'markdown' | 'image';

export const THEMES = [
  'light',
  'dark',
  'midnight',
  'sepia',
  'forest',
  'contrast',
] as const;
export type ThemeName = (typeof THEMES)[number];

export const THEME_LABELS: Record<ThemeName, string> = {
  light: 'Light',
  dark: 'Dark',
  midnight: 'Midnight',
  sepia: 'Sepia',
  forest: 'Forest',
  contrast: 'High contrast',
};

export interface Slide {
  /** Stable id (index-based). */
  readonly id: string;
  /** Display title, derived from heading, filename, or page number. */
  readonly title: string;
  /** Original filename the slide came from. */
  readonly filename: string;
  /** What the slide holds — rendered Markdown, or an image (e.g. a PDF page). */
  readonly kind: SlideKind;
  /** Sanitized HTML for markdown slides; empty string for image slides. */
  readonly html: string;
  /** Image source (data/object URL) for image slides. */
  readonly src?: string;
  /** Rendered HTML speaker notes, if any (markdown slides only). */
  readonly notes?: string;
  /** Number of incremental reveal steps (>= 1; 1 means no fragments). */
  readonly fragmentCount: number;
}

/** A slide before it has been assigned its final id. */
export type ProtoSlide = Omit<Slide, 'id'>;

/** Deck-level metadata parsed from front-matter. */
export interface DeckMeta {
  readonly title?: string;
  readonly author?: string;
  readonly theme?: ThemeName;
}

/** A text source file a deck was built from (kept for share links). */
export interface SourceFile {
  readonly name: string;
  readonly text: string;
}

export interface Deck {
  readonly slides: Slide[];
  readonly meta: DeckMeta;
  /**
   * Original text sources, present only when every input file was text
   * (Markdown/HTML/AsciiDoc) — binary inputs (PDF/image) make a deck
   * unshareable as a content-in-URL link.
   */
  readonly sources?: readonly SourceFile[];
}

export type Direction = 'next' | 'prev' | 'none';

/** Text formats the paste editor can author (each maps to a file extension). */
export const COMPOSE_FORMATS = ['markdown', 'asciidoc', 'html'] as const;
export type ComposeFormat = (typeof COMPOSE_FORMATS)[number];

export const COMPOSE_FORMAT_LABELS: Record<ComposeFormat, string> = {
  markdown: 'Markdown',
  asciidoc: 'AsciiDoc',
  html: 'HTML',
};

/** The paste editor's persisted working state. */
export interface Draft {
  readonly text: string;
  readonly format: ComposeFormat;
}

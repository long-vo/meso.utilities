export type SlideKind = 'markdown' | 'image';

export const THEMES = ['light', 'dark'] as const;
export type ThemeName = (typeof THEMES)[number];

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

export interface Deck {
  readonly slides: Slide[];
  readonly meta: DeckMeta;
}

export type Direction = 'next' | 'prev' | 'none';

export interface Slide {
  /** Stable id (index-based). */
  readonly id: string;
  /** Display title, derived from the first heading or the filename. */
  readonly title: string;
  /** Original filename the slide came from. */
  readonly filename: string;
  /** Sanitized HTML rendered from the Markdown source. */
  readonly html: string;
}

export type Direction = 'next' | 'prev' | 'none';

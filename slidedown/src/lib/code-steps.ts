// Code step-through for fenced code blocks.
//
// The fence info string may carry line-highlight meta after the language:
//   ```js {1,3-5}      static highlight of lines 1, 3, 4, 5
//   ```js {1|2-3|4}    three highlight steps, revealed like fragments
//
// The markdown renderer wraps each line in a `.code-line` span (re-balancing
// highlight.js spans that cross newlines) and stores the step groups in a
// `data-code-steps` attribute; `Slide.tsx` activates the group that matches
// the slide's current fragment step.

export interface CodeMeta {
  /** The language part of the info string ("" when absent). */
  readonly lang: string;
  /** Highlight groups (arrays of 1-based line numbers), or null for none. */
  readonly groups: readonly (readonly number[])[] | null;
}

/** Parse a fence info string like `js {1,3-5|2}` (also tolerates `js{1}`). */
export function parseCodeMeta(info: string): CodeMeta {
  const trimmed = (info ?? '').trim();
  const match = trimmed.match(/^([^\s{]*)\s*(?:\{([^}]*)\})?\s*$/);
  if (!match) return { lang: trimmed, groups: null };
  const lang = match[1] ?? '';
  if (match[2] === undefined) return { lang, groups: null };
  const groups = match[2]
    .split('|')
    .map(parseRangeList)
    .filter((group): group is number[] => group !== null);
  return { lang, groups: groups.length > 0 ? groups : null };
}

/** "1,3-5" → [1, 3, 4, 5]; null when nothing valid is listed. */
function parseRangeList(spec: string): number[] | null {
  const lines = new Set<number>();
  for (const part of spec.split(',')) {
    const piece = part.trim();
    if (piece === '') continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let n = Math.min(from, to); n <= Math.max(from, to); n++) lines.add(n);
    } else if (/^\d+$/.test(piece)) {
      lines.add(Number(piece));
    }
  }
  return lines.size > 0 ? [...lines].sort((a, b) => a - b) : null;
}

/** Groups → the canonical `data-code-steps` attribute value. */
export function serializeGroups(groups: readonly (readonly number[])[]): string {
  return groups.map((group) => group.join(',')).join('|');
}

/** The inverse of {@link serializeGroups} (used on the DOM side). */
export function parseGroupsAttr(attr: string): number[][] {
  return attr
    .split('|')
    .map((part) =>
      part
        .split(',')
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0),
    )
    .filter((group) => group.length > 0);
}

/**
 * Split highlight.js output into per-line HTML. hljs spans can cross
 * newlines (multiline strings, comments), so open spans are closed at each
 * line end and reopened on the next line.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const openTags: string[] = [];
  let line = '';
  let last = 0;
  const tokens = /<span\b[^>]*>|<\/span>|\n/g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html)) !== null) {
    line += html.slice(last, match.index);
    last = tokens.lastIndex;
    const token = match[0];
    if (token === '\n') {
      lines.push(line + '</span>'.repeat(openTags.length));
      line = openTags.join('');
    } else if (token === '</span>') {
      openTags.pop();
      line += token;
    } else {
      openTags.push(token);
      line += token;
    }
  }
  line += html.slice(last);
  lines.push(line + '</span>'.repeat(openTags.length));
  return lines;
}

/**
 * Wrap each highlighted line in a `.code-line` span. A single static group
 * bakes its highlights in; stepped groups are activated at runtime.
 */
export function wrapCodeLines(
  highlighted: string,
  groups: readonly (readonly number[])[] | null,
): string {
  const staticSet = groups && groups.length === 1 ? new Set(groups[0]) : null;
  return splitHighlightedLines(highlighted)
    .map((content, index) => {
      const lineNo = index + 1;
      const cls = staticSet?.has(lineNo) ? 'code-line code-line-active' : 'code-line';
      return `<span class="${cls}" data-line="${lineNo}">${content || ' '}</span>`;
    })
    .join('');
}

/**
 * Extra fragment steps contributed by stepped code blocks in rendered HTML
 * (each block with G groups adds G−1 steps).
 */
export function countExtraSteps(html: string): number {
  let extra = 0;
  const attrs = /data-code-steps="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrs.exec(html)) !== null) {
    extra += Math.max(0, parseGroupsAttr(match[1]).length - 1);
  }
  return extra;
}

import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
// `/lib/common` bundles ~35 popular languages instead of all ~190,
// which keeps the production bundle much smaller.
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

// Syntax highlighting for fenced code blocks.
marked.use(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
);

marked.setOptions({ gfm: true, breaks: false });

// Open links in a new tab and harden them against tab-nabbing.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Render a Markdown string into sanitized HTML. */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}

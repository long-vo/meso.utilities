import { marked, type Tokens } from 'marked';
// `/lib/common` bundles ~35 popular languages instead of all ~190,
// which keeps the production bundle much smaller.
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { parseCodeMeta, serializeGroups, wrapCodeLines } from './code-steps';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Custom fenced-code renderer: syntax highlighting plus optional line
// highlights from the info string (```js {1,3-5|2} — see code-steps.ts).
// Mermaid blocks keep the exact `language-mermaid` shape that
// renderMermaidInHtml() detects.
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const meta = parseCodeMeta(lang ?? '');
      if (meta.lang === 'mermaid') {
        return `<pre><code class="hljs language-mermaid">${escapeHtml(text)}</code></pre>\n`;
      }
      const language = meta.lang && hljs.getLanguage(meta.lang) ? meta.lang : 'plaintext';
      const highlighted = hljs.highlight(text, { language }).value;
      const body = meta.groups ? wrapCodeLines(highlighted, meta.groups) : highlighted;
      const isStepped = meta.groups !== null && meta.groups.length > 1;
      const stepsAttr = isStepped && meta.groups
        ? ` data-code-steps="${serializeGroups(meta.groups)}"`
        : '';
      const classes = `hljs language-${escapeHtml(language)}`;
      return `<pre${stepsAttr}${isStepped ? ' class="code-stepped"' : ''}><code class="${classes}">${body}</code></pre>\n`;
    },
  },
});

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

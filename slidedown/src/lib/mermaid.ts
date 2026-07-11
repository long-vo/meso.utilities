import mermaid from 'mermaid';

let initialized = false;
let counter = 0;

function init(): void {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'default',
    themeVariables: {
      // Edge labels (e.g. "yes"/"no") sit on the white slide surface; the
      // default is a grey box that looks boxy — match the slide instead.
      edgeLabelBackground: '#ffffff',
    },
    flowchart: { htmlLabels: true, useMaxWidth: true },
  });
  initialized = true;
}

/**
 * Replace ```mermaid code blocks in a rendered HTML string with inline SVG
 * diagrams. Runs once at deck-load time so both slides and thumbnails can
 * simply render the resulting HTML.
 */
export async function renderMermaidInHtml(html: string): Promise<string> {
  init();
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const blocks = Array.from(doc.querySelectorAll('code.language-mermaid'));

  for (const codeEl of blocks) {
    const source = (codeEl.textContent ?? '').trim();
    const target = codeEl.closest('pre') ?? codeEl;
    if (!source) continue;
    try {
      const { svg } = await mermaid.render(`sw-mermaid-${counter++}`, source);
      const wrapper = doc.createElement('div');
      wrapper.className = 'mermaid-diagram';
      wrapper.innerHTML = svg;
      target.replaceWith(wrapper);
    } catch {
      // Leave the original code block visible and flag it as unrenderable.
      target.classList.add('mermaid-error');
    }
  }

  return doc.body.innerHTML;
}

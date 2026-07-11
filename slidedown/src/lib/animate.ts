// Recognised entrance-animation effects, authored as a leading token:
//   @effect                 e.g. @up
//   @effect:delay           e.g. @up:200          (ms before it plays)
//   @effect:delay:duration  e.g. @zoom:0:800      (ms delay, ms duration)
const HAS_TOKEN = /@(?:fade|up|down|left|right|zoom)\b/;
const LEADING_TOKEN =
  /^\s*@(fade|up|down|left|right|zoom)(?::(\d{1,5}))?(?::(\d{1,5}))?(?=$|\s)[ \t]?/;

const TARGETS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, table';

/**
 * Turn a leading `@effect[:delay[:duration]]` token on a block/bullet into
 * `anim anim-<effect>` classes plus optional timing data attributes, so the
 * element can be animated in. Runs on already-rendered, sanitized HTML.
 */
export function applyAnimations(html: string): string {
  if (!HAS_TOKEN.test(html)) return html;

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll<HTMLElement>(TARGETS).forEach((el) => {
    const node = el.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? '';
    const match = text.match(LEADING_TOKEN);
    if (!match) return;

    node.textContent = text.slice(match[0].length);
    el.classList.add('anim', `anim-${match[1]}`);
    if (match[2]) el.setAttribute('data-anim-delay', match[2]);
    if (match[3]) el.setAttribute('data-anim-duration', match[3]);
  });
  return doc.body.innerHTML;
}

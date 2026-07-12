import { useEffect, useRef } from 'react';
import type { Direction, Slide } from '../types';
import { parseGroupsAttr } from '../lib/code-steps';

interface Props {
  slide: Slide;
  direction: Direction;
  width: number;
  height: number;
  scale: number;
  step: number;
}

/**
 * A single 16:9 slide surface rendered at a fixed base size and scaled to
 * fit the viewport, so layout stays consistent like real presentation slides.
 */
export default function SlideView({
  slide,
  direction,
  width,
  height,
  scale,
  step,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Reveal fragments up to the current step, and play entrance animations for
  // any elements that have just become visible (staggered).
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;

    const fragments = root.querySelectorAll<HTMLElement>('.fragment');
    fragments.forEach((f) => {
      const i = Number(f.getAttribute('data-fragment') ?? '0');
      f.classList.toggle('fragment-visible', i <= step);
    });

    // Stepped code blocks continue where `+++` fragments stop: after the last
    // fragment step, each further step activates the next highlight group of
    // each ```lang {a|b|c} block, in document order.
    let offset = Math.max(1, fragments.length) - 1;
    root
      .querySelectorAll<HTMLElement>('pre[data-code-steps]')
      .forEach((pre) => {
        const groups = parseGroupsAttr(pre.getAttribute('data-code-steps') ?? '');
        if (groups.length === 0) return;
        const active = Math.max(0, Math.min(groups.length - 1, step - offset));
        offset += groups.length - 1;
        const activeLines = new Set(groups[active]);
        pre.querySelectorAll<HTMLElement>('.code-line').forEach((line) => {
          const n = Number(line.getAttribute('data-line') ?? '0');
          line.classList.toggle('code-line-active', activeLines.has(n));
          line.classList.toggle('code-line-dim', !activeLines.has(n));
        });
      });

    let order = 0;
    root.querySelectorAll<HTMLElement>('.anim').forEach((el) => {
      const frag = el.closest<HTMLElement>('.fragment');
      const visible =
        !frag || Number(frag.getAttribute('data-fragment') ?? '0') <= step;
      if (visible && !el.classList.contains('anim-run')) {
        const delay = el.getAttribute('data-anim-delay');
        const duration = el.getAttribute('data-anim-duration');
        el.style.animationDelay = delay != null ? `${delay}ms` : `${order * 90}ms`;
        if (duration != null) el.style.animationDuration = `${duration}ms`;
        el.classList.add('anim-run');
        order += 1;
      }
    });
  }, [slide, step]);

  return (
    <div
      className={`slide-positioner anim-${direction}`}
      style={{ width: width * scale, height: height * scale }}
    >
      <article
        className="slide"
        style={{ width, height, transform: `scale(${scale})` }}
      >
        {slide.kind === 'image' ? (
          <div className="slide-content slide-content--image">
            <img src={slide.src} alt={slide.title} draggable={false} />
          </div>
        ) : (
          <div
            ref={contentRef}
            className="slide-content"
            dangerouslySetInnerHTML={{ __html: slide.html }}
          />
        )}
      </article>
    </div>
  );
}

import { useEffect, useRef } from 'react';
import type { Direction, Slide } from '../types';

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

    root.querySelectorAll<HTMLElement>('.fragment').forEach((f) => {
      const i = Number(f.getAttribute('data-fragment') ?? '0');
      f.classList.toggle('fragment-visible', i <= step);
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

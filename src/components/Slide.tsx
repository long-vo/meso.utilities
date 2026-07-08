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

  // Reveal fragments up to the current step.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('.fragment').forEach((f) => {
      const i = Number(f.getAttribute('data-fragment') ?? '0');
      f.classList.toggle('fragment-visible', i <= step);
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

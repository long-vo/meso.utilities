import type { Direction, Slide } from '../types';

interface Props {
  slide: Slide;
  direction: Direction;
  width: number;
  height: number;
  scale: number;
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
}: Props) {
  return (
    <div
      className={`slide-positioner anim-${direction}`}
      style={{ width: width * scale, height: height * scale }}
    >
      <article
        className="slide"
        style={{ width, height, transform: `scale(${scale})` }}
      >
        <div
          className="slide-content"
          dangerouslySetInnerHTML={{ __html: slide.html }}
        />
      </article>
    </div>
  );
}

import type { Slide } from '../types';

interface Props {
  slides: Slide[];
}

/** Off-screen layout used only for printing / "Save as PDF": one page per slide. */
export default function PrintView({ slides }: Props) {
  return (
    <div className="print-root" aria-hidden="true">
      {slides.map((s) => (
        <div className="print-page" key={s.id}>
          {s.kind === 'image' ? (
            <div className="slide-content slide-content--image">
              <img src={s.src} alt={s.title} />
            </div>
          ) : (
            <div
              className="slide-content"
              dangerouslySetInnerHTML={{ __html: s.html }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

import type { Slide } from '../types';

interface Props {
  slides: Slide[];
  current: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}

export default function Overview({
  slides,
  current,
  onSelect,
  onClose,
}: Props) {
  return (
    <div className="overview" role="dialog" aria-label="Slide overview">
      <div className="overview-bar">
        <span className="overview-count">{slides.length} slides</span>
        <button className="link-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="overview-grid">
        {slides.map((s, i) => (
          <button
            key={s.id}
            className={`thumb ${i === current ? 'is-active' : ''}`}
            onClick={() => onSelect(i)}
          >
            <div className="thumb-stage">
              <div
                className="thumb-slide"
                dangerouslySetInnerHTML={{ __html: s.html }}
              />
            </div>
            <span className="thumb-label">
              <span className="thumb-num">{i + 1}</span>
              {s.title}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

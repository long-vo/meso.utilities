import { useEffect, useRef } from 'react';
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus management for the modal: focus the current slide's thumbnail on open,
  // trap Tab within the dialog, own Escape, and restore focus on close.
  useEffect(() => {
    const dialog = dialogRef.current;
    const restore = document.activeElement as HTMLElement | null;
    const thumbs = dialog?.querySelectorAll<HTMLElement>('.thumb');
    (thumbs?.[current] ?? dialog?.querySelector<HTMLElement>('button'))?.focus();

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // own it — don't let the global handler double-fire
        onCloseRef.current();
      } else if (e.key === 'Tab' && dialog) {
        const focusables = dialog.querySelectorAll<HTMLElement>('button');
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      restore?.focus?.();
    };
    // Runs once on open; `current` is the slide to focus at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={dialogRef}
      className="overview"
      role="dialog"
      aria-modal="true"
      aria-label="Slide overview"
    >
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
              {s.kind === 'image' ? (
                <div className="thumb-slide thumb-slide--image">
                  <img src={s.src} alt="" />
                </div>
              ) : (
                <div
                  className="thumb-slide"
                  dangerouslySetInnerHTML={{ __html: s.html }}
                />
              )}
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

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Slide, ThemeName } from '../types';

interface Props {
  slides: Slide[];
  index: number;
  theme: ThemeName;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

const BASE_W = 1280;
const BASE_H = 720;

function copyStyles(src: Document, dest: Document): void {
  src.querySelectorAll('style').forEach((s) => {
    dest.head.appendChild(s.cloneNode(true));
  });
  src.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach((l) => {
    const link = dest.createElement('link');
    link.rel = 'stylesheet';
    link.href = l.href; // resolved absolute URL so it loads in the popup
    dest.head.appendChild(link);
  });
}

function SlidePreview({ slide, scale }: { slide: Slide; scale: number }) {
  return (
    <div
      className="sv-preview"
      style={{ width: BASE_W * scale, height: BASE_H * scale }}
    >
      <div
        className="slide"
        style={{ width: BASE_W, height: BASE_H, transform: `scale(${scale})` }}
      >
        {slide.kind === 'image' ? (
          <div className="slide-content slide-content--image">
            <img src={slide.src} alt="" />
          </div>
        ) : (
          <div
            className="slide-content"
            dangerouslySetInnerHTML={{ __html: slide.html }}
          />
        )}
      </div>
    </div>
  );
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function SpeakerView({
  slides,
  index,
  theme,
  onNext,
  onPrev,
  onClose,
}: Props) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number>(Date.now());
  const navRef = useRef({ onNext, onPrev, onClose });
  navRef.current = { onNext, onPrev, onClose };

  // Open the popup window once and mount a portal target inside it.
  useEffect(() => {
    const win = window.open('', 'slidedown-speaker', 'width=1100,height=760');
    if (!win) {
      onClose();
      return;
    }
    win.document.title = 'Slidedown — Speaker view';
    win.document.body.innerHTML = '';
    win.document.body.style.margin = '0';
    copyStyles(document, win.document);
    win.document.documentElement.setAttribute('data-theme', theme);

    const mount = win.document.createElement('div');
    mount.className = 'speaker-root';
    win.document.body.appendChild(mount);
    setContainer(mount);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault();
        navRef.current.onNext();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        navRef.current.onPrev();
      }
    };
    const onUnload = (): void => navRef.current.onClose();
    win.document.addEventListener('keydown', onKey);
    win.addEventListener('beforeunload', onUnload);

    return () => {
      win.document.removeEventListener('keydown', onKey);
      win.removeEventListener('beforeunload', onUnload);
      win.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the popup theme in sync.
  useEffect(() => {
    container?.ownerDocument.documentElement.setAttribute('data-theme', theme);
  }, [theme, container]);

  // Presentation timer.
  useEffect(() => {
    const id = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startRef.current) / 1000)),
      500,
    );
    return () => window.clearInterval(id);
  }, []);

  if (!container) return null;

  const current = slides[index];
  const next = slides[index + 1];

  return createPortal(
    <div className="speaker">
      <header className="speaker-bar">
        <span className="speaker-clock">{formatTime(seconds)}</span>
        <button
          className="link-btn sv-reset"
          onClick={() => {
            startRef.current = Date.now();
            setSeconds(0);
          }}
        >
          Reset timer
        </button>
        <span className="speaker-count">
          Slide {index + 1} / {slides.length}
        </span>
      </header>

      <div className="speaker-main">
        <section className="speaker-now">
          <h2 className="sv-label">Current</h2>
          <SlidePreview slide={current} scale={0.46} />
          <div className="speaker-nav">
            <button className="link-btn" onClick={onPrev} disabled={index === 0}>
              ‹ Prev
            </button>
            <button
              className="link-btn"
              onClick={onNext}
              disabled={index === slides.length - 1}
            >
              Next ›
            </button>
          </div>
        </section>

        <section className="speaker-side">
          <h2 className="sv-label">Next</h2>
          {next ? (
            <SlidePreview slide={next} scale={0.3} />
          ) : (
            <div className="sv-end">End of deck</div>
          )}
          <h2 className="sv-label">Notes</h2>
          <div className="speaker-notes">
            {current?.notes ? (
              <div dangerouslySetInnerHTML={{ __html: current.notes }} />
            ) : (
              <p className="sv-muted">No notes for this slide.</p>
            )}
          </div>
        </section>
      </div>
    </div>,
    container,
  );
}

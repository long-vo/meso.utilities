import { useEffect, useRef } from 'react';

export interface NavHandlers {
  onNext: () => void;
  onPrev: () => void;
  onFirst: () => void;
  onLast: () => void;
  onToggleFullscreen: () => void;
  onToggleOverview: () => void;
  onEscape: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onCycleTheme: () => void;
  onToggleSpeaker: () => void;
  onExport: () => void;
}

/**
 * Global keyboard navigation. Handlers are kept in a ref so the listener
 * is registered once but always calls the latest callbacks.
 */
export function useKeyboardNav(handlers: NavHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    function handle(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;

      const h = ref.current;
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
        case 'l':
        case 'j':
          e.preventDefault();
          h.onNext();
          break;
        case 'ArrowLeft':
        case 'PageUp':
        case 'h':
        case 'k':
          e.preventDefault();
          h.onPrev();
          break;
        case 'Home':
          e.preventDefault();
          h.onFirst();
          break;
        case 'End':
          e.preventDefault();
          h.onLast();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          h.onToggleFullscreen();
          break;
        case 'o':
        case 'O':
          e.preventDefault();
          h.onToggleOverview();
          break;
        case '+':
        case '=':
          e.preventDefault();
          h.onZoomIn();
          break;
        case '-':
        case '_':
          e.preventDefault();
          h.onZoomOut();
          break;
        case '0':
          e.preventDefault();
          h.onZoomReset();
          break;
        case 't':
        case 'T':
          e.preventDefault();
          h.onCycleTheme();
          break;
        case 's':
        case 'S':
          e.preventDefault();
          h.onToggleSpeaker();
          break;
        case 'e':
        case 'E':
          e.preventDefault();
          h.onExport();
          break;
        case 'Escape':
          h.onEscape();
          break;
      }
    }

    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
}

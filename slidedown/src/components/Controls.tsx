import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Compress,
  Expand,
  Grid,
  Home,
  Laser,
  Link,
  Pause,
  Pen,
  Play,
  Presenter,
  Printer,
  ZoomIn,
  ZoomOut,
} from './Icons';
import ThemeMenu from './ThemeMenu';
import type { SourceFile, ThemeName } from '../types';
import type { AnnotationTool } from './AnnotationLayer';
import { encodeDeckToHash } from '../lib/share';

// Above this URL length, warn that some chat clients truncate long links.
const LONG_LINK_CHARS = 30000;
const SHARE_NOTE_MS = 2500;

interface Props {
  index: number;
  count: number;
  sources?: readonly SourceFile[];
  zoom: number;
  minZoom: number;
  maxZoom: number;
  isFullscreen: boolean;
  theme: ThemeName;
  speakerActive: boolean;
  playing: boolean;
  tool: AnnotationTool;
  onTogglePen: () => void;
  onToggleLaser: () => void;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onToggleOverview: () => void;
  onToggleSpeaker: () => void;
  onSetTheme: (theme: ThemeName) => void;
  onExport: () => void;
  onToggleFullscreen: () => void;
  onExit: () => void;
}

export default function Controls({
  index,
  count,
  sources,
  zoom,
  minZoom,
  maxZoom,
  isFullscreen,
  theme,
  speakerActive,
  playing,
  tool,
  onTogglePen,
  onToggleLaser,
  onPrev,
  onNext,
  onTogglePlay,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onToggleOverview,
  onToggleSpeaker,
  onSetTheme,
  onExport,
  onToggleFullscreen,
  onExit,
}: Props) {
  const atMin = zoom <= minZoom + 1e-3;
  const atMax = zoom >= maxZoom - 1e-3;
  const atActualSize = Math.abs(zoom - 1) < 1e-3;

  const [overflowOpen, setOverflowOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // Share link: encode the deck's sources into the URL hash and copy it.
  const [shareCopied, setShareCopied] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const shareTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (shareTimer.current) window.clearTimeout(shareTimer.current);
    };
  }, []);

  const onShare = async (): Promise<void> => {
    if (!sources) return;
    let copied = false;
    let note: string;
    try {
      const hash = await encodeDeckToHash(sources);
      const url = location.origin + location.pathname + location.search + hash;
      await navigator.clipboard.writeText(url);
      copied = true;
      note = url.length > LONG_LINK_CHARS
        ? 'Link copied — very long links may be truncated by some chat apps'
        : 'Link copied';
    } catch {
      note = 'Could not copy the link';
    }
    setShareCopied(copied);
    setShareNote(note);
    if (shareTimer.current) window.clearTimeout(shareTimer.current);
    shareTimer.current = window.setTimeout(() => {
      setShareCopied(false);
      setShareNote(null);
    }, SHARE_NOTE_MS);
  };

  // Close the ⋯ overflow menu on an outside tap, Escape, or when the viewport
  // grows back past the compact breakpoint (where the menu no longer applies).
  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOverflowOpen(false);
      }
    };
    const wide = window.matchMedia('(min-width: 641px)');
    const onWide = (e: MediaQueryListEvent): void => {
      if (e.matches) setOverflowOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    wide.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      wide.removeEventListener('change', onWide);
    };
  }, [overflowOpen]);

  return (
    <div className="controls" role="toolbar" aria-label="Slide controls" ref={barRef}>
      <button
        className="ctrl-btn"
        onClick={onExit}
        title="Load different files"
        aria-label="Load different files"
      >
        <Home />
      </button>

      <span className="ctrl-divider" />

      <button
        className="ctrl-btn"
        onClick={onPrev}
        disabled={index === 0}
        title="Previous (←)"
        aria-label="Previous"
      >
        <ChevronLeft />
      </button>

      <span className="ctrl-counter">
        {index + 1} <span className="ctrl-counter-sep">/</span> {count}
      </span>

      <button
        className="ctrl-btn"
        onClick={onNext}
        disabled={index === count - 1}
        title="Next (→)"
        aria-label="Next"
      >
        <ChevronRight />
      </button>

      {/* Inline on desktop; a popup toggled by the ⋯ button ≤640px. */}
      <div
        className={`ctrl-overflow ${overflowOpen ? 'is-open' : ''}`}
        role="group"
        aria-label="More controls"
      >
        <span className="ctrl-divider" />

        <button
          className="ctrl-btn"
          onClick={onZoomOut}
          disabled={atMin}
          title="Zoom out (−)"
          aria-label="Zoom out"
        >
          <ZoomOut />
        </button>

        <button
          className="ctrl-zoom"
          onClick={onZoomReset}
          disabled={atActualSize}
          title="Reset zoom to 100% (0)"
          aria-label="Reset zoom"
        >
          {Math.round(zoom * 100)}%
        </button>

        <button
          className="ctrl-btn"
          onClick={onZoomIn}
          disabled={atMax}
          title="Zoom in (+)"
          aria-label="Zoom in"
        >
          <ZoomIn />
        </button>

        <span className="ctrl-divider" />

        <button
          className={`ctrl-btn ${playing ? 'is-active' : ''}`}
          onClick={onTogglePlay}
          title={playing ? 'Pause auto-play (P)' : 'Auto-play (P)'}
          aria-label={playing ? 'Pause auto-play' : 'Start auto-play'}
        >
          {playing ? <Pause /> : <Play />}
        </button>

        <button
          className="ctrl-btn"
          onClick={onToggleOverview}
          title="Overview (O)"
          aria-label="Toggle overview"
        >
          <Grid />
        </button>

        <button
          className={`ctrl-btn ${speakerActive ? 'is-active' : ''}`}
          onClick={onToggleSpeaker}
          title="Speaker view (S)"
          aria-label="Toggle speaker view"
        >
          <Presenter />
        </button>

        <button
          className={`ctrl-btn ${tool === 'pen' ? 'is-active' : ''}`}
          onClick={onTogglePen}
          title="Draw on the slide (D) · clear with C"
          aria-label="Toggle pen annotations"
        >
          <Pen />
        </button>

        <button
          className={`ctrl-btn ${tool === 'laser' ? 'is-active' : ''}`}
          onClick={onToggleLaser}
          title="Laser pointer (W)"
          aria-label="Toggle laser pointer"
        >
          <Laser />
        </button>

        <ThemeMenu theme={theme} onSelect={onSetTheme} direction="up" />

        <button
          className={`ctrl-btn ${shareCopied ? 'is-active' : ''}`}
          onClick={() => void onShare()}
          disabled={!sources}
          title={sources
            ? 'Copy share link'
            : 'Share links need a text-only deck (no PDFs or images)'}
          aria-label="Copy share link"
        >
          {shareCopied ? <Check /> : <Link />}
        </button>

        <button
          className="ctrl-btn"
          onClick={onExport}
          title="Export to PDF (E)"
          aria-label="Export to PDF"
        >
          <Printer />
        </button>

        <button
          className="ctrl-btn"
          onClick={onToggleFullscreen}
          title="Fullscreen (F)"
          aria-label="Toggle fullscreen"
        >
          {isFullscreen ? <Compress /> : <Expand />}
        </button>
      </div>

      <button
        className="ctrl-btn ctrl-more"
        onClick={() => setOverflowOpen((o) => !o)}
        aria-expanded={overflowOpen}
        aria-haspopup="true"
        title="More controls"
        aria-label="More controls"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>

      {shareNote && (
        <div className="ctrl-note" role="status">
          {shareNote}
        </div>
      )}
    </div>
  );
}

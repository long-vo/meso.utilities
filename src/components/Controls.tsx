import {
  ChevronLeft,
  ChevronRight,
  Compress,
  Expand,
  Grid,
  Home,
  Moon,
  Presenter,
  Printer,
  Sun,
  ZoomIn,
  ZoomOut,
} from './Icons';
import type { ThemeName } from '../types';

interface Props {
  index: number;
  count: number;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  isFullscreen: boolean;
  theme: ThemeName;
  speakerActive: boolean;
  onPrev: () => void;
  onNext: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onToggleOverview: () => void;
  onToggleSpeaker: () => void;
  onCycleTheme: () => void;
  onExport: () => void;
  onToggleFullscreen: () => void;
  onExit: () => void;
}

export default function Controls({
  index,
  count,
  zoom,
  minZoom,
  maxZoom,
  isFullscreen,
  theme,
  speakerActive,
  onPrev,
  onNext,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onToggleOverview,
  onToggleSpeaker,
  onCycleTheme,
  onExport,
  onToggleFullscreen,
  onExit,
}: Props) {
  const atMin = zoom <= minZoom + 1e-3;
  const atMax = zoom >= maxZoom - 1e-3;
  const atActualSize = Math.abs(zoom - 1) < 1e-3;

  return (
    <div className="controls" role="toolbar" aria-label="Slide controls">
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
        className="ctrl-btn"
        onClick={onCycleTheme}
        title="Toggle theme (T)"
        aria-label="Toggle light/dark theme"
      >
        {theme === 'dark' ? <Sun /> : <Moon />}
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
  );
}

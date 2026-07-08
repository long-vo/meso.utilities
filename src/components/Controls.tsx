import {
  ChevronLeft,
  ChevronRight,
  Compress,
  Expand,
  Grid,
  Home,
  ZoomIn,
  ZoomOut,
} from './Icons';

interface Props {
  index: number;
  count: number;
  zoom: number;
  maxZoom: number;
  isFullscreen: boolean;
  onPrev: () => void;
  onNext: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onToggleOverview: () => void;
  onToggleFullscreen: () => void;
  onExit: () => void;
}

export default function Controls({
  index,
  count,
  zoom,
  maxZoom,
  isFullscreen,
  onPrev,
  onNext,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onToggleOverview,
  onToggleFullscreen,
  onExit,
}: Props) {
  const atMin = zoom <= 1 + 1e-3;
  const atMax = zoom >= maxZoom - 1e-3;

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
        title="Previous slide (←)"
        aria-label="Previous slide"
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
        title="Next slide (→)"
        aria-label="Next slide"
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
        disabled={atMin}
        title="Reset zoom (0)"
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

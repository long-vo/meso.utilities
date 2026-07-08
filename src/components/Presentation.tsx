import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Direction, Slide } from '../types';
import SlideView from './Slide';
import Controls from './Controls';
import ProgressBar from './ProgressBar';
import Overview from './Overview';
import { useKeyboardNav } from '../hooks/useKeyboardNav';
import { useFullscreen } from '../hooks/useFullscreen';

const BASE_W = 1280;
const BASE_H = 720;
const IDLE_MS = 2800;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;

interface Props {
  slides: Slide[];
  onExit: () => void;
}

interface Point {
  x: number;
  y: number;
}

export default function Presentation({ slides, onExit }: Props) {
  const count = slides.length;

  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<Direction>('none');
  const [overview, setOverview] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef(0);
  const idleTimer = useRef<number | null>(null);
  const fitScaleRef = useRef(1);
  const zoomRef = useRef(1);
  const panRef = useRef<Point>({ x: 0, y: 0 });
  const drag = useRef({ active: false, startX: 0, startY: 0, panX: 0, panY: 0 });

  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(rootRef);

  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(count - 1, i)),
    [count],
  );

  const goTo = useCallback(
    (target: number, dir: Direction) => {
      const next = clamp(target);
      if (next === indexRef.current) return;
      setDirection(dir);
      setIndex(next);
    },
    [clamp],
  );

  const goNext = useCallback(() => goTo(indexRef.current + 1, 'next'), [goTo]);
  const goPrev = useCallback(() => goTo(indexRef.current - 1, 'prev'), [goTo]);
  const goFirst = useCallback(() => goTo(0, 'prev'), [goTo]);
  const goLast = useCallback(() => goTo(count - 1, 'next'), [goTo, count]);

  const jumpTo = useCallback(
    (i: number) => {
      goTo(i, i >= indexRef.current ? 'next' : 'prev');
      setOverview(false);
    },
    [goTo],
  );

  // Reset zoom & pan whenever the slide changes.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [index]);

  // Clamp a pan offset so the slide can't be dragged fully out of view.
  const clampPan = useCallback((p: Point, z: number): Point => {
    const wrap = stageWrapRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const sw = BASE_W * fitScaleRef.current * z;
    const sh = BASE_H * fitScaleRef.current * z;
    const maxX = Math.max(0, (sw - wrap.clientWidth) / 2);
    const maxY = Math.max(0, (sh - wrap.clientHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, p.x)),
      y: Math.min(maxY, Math.max(-maxY, p.y)),
    };
  }, []);

  const applyZoom = useCallback(
    (z: number) => {
      const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
      setZoom(nz);
      setPan((p) => clampPan(p, nz));
    },
    [clampPan],
  );

  const zoomIn = useCallback(
    () => applyZoom(zoomRef.current * ZOOM_STEP),
    [applyZoom],
  );
  const zoomOut = useCallback(
    () => applyZoom(zoomRef.current / ZOOM_STEP),
    [applyZoom],
  );
  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Fit the fixed 16:9 stage to the available space.
  useEffect(() => {
    const wrap = stageWrapRef.current;
    if (!wrap) return;
    const update = (): void => {
      const s = Math.min(wrap.clientWidth / BASE_W, wrap.clientHeight / BASE_H);
      const fit = s > 0 ? s : 1;
      fitScaleRef.current = fit;
      setFitScale(fit);
      setPan((p) => clampPan(p, zoomRef.current));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [clampPan]);

  // Ctrl/Cmd + wheel to zoom; plain wheel pans when zoomed in.
  useEffect(() => {
    const wrap = stageWrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        applyZoom(zoomRef.current * Math.exp(-e.deltaY * 0.0015));
      } else if (zoomRef.current > 1) {
        e.preventDefault();
        setPan((p) =>
          clampPan({ x: p.x - e.deltaX, y: p.y - e.deltaY }, zoomRef.current),
        );
      }
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [applyZoom, clampPan]);

  // Auto-hide the control bar while idle.
  const nudgeControls = useCallback(() => {
    setControlsVisible(true);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(
      () => setControlsVisible(false),
      IDLE_MS,
    );
  }, []);

  useEffect(() => {
    nudgeControls();
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
    };
  }, [nudgeControls]);

  useKeyboardNav({
    onNext: goNext,
    onPrev: goPrev,
    onFirst: goFirst,
    onLast: goLast,
    onToggleFullscreen: toggleFullscreen,
    onToggleOverview: () => setOverview((v) => !v),
    onEscape: () => (zoomRef.current > 1 ? resetZoom() : setOverview(false)),
    onZoomIn: zoomIn,
    onZoomOut: zoomOut,
    onZoomReset: resetZoom,
  });

  // Drag-to-pan when zoomed in.
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (zoomRef.current <= 1) return;
    drag.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    };
    setPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag.current.active) return;
      const nx = drag.current.panX + (e.clientX - drag.current.startX);
      const ny = drag.current.panY + (e.clientY - drag.current.startY);
      setPan(clampPan({ x: nx, y: ny }, zoomRef.current));
    },
    [clampPan],
  );

  const endPan = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) return;
    drag.current.active = false;
    setPanning(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const current = slides[Math.min(index, count - 1)];
  const effScale = fitScale * zoom;
  const canPan = zoom > 1;

  return (
    <div
      ref={rootRef}
      className={`presentation ${
        controlsVisible || overview ? 'controls-visible' : 'controls-hidden'
      }`}
      onMouseMove={nudgeControls}
    >
      <ProgressBar index={index} count={count} />

      <div
        ref={stageWrapRef}
        className={`stage-wrap ${canPan ? 'can-pan' : ''} ${
          panning ? 'is-panning' : ''
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onClick={(e) => {
          if (zoom === 1 && e.target === e.currentTarget) goNext();
        }}
      >
        <div
          className={`pan-layer ${panning ? 'no-transition' : ''}`}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
        >
          <SlideView
            key={current.id}
            slide={current}
            direction={direction}
            width={BASE_W}
            height={BASE_H}
            scale={effScale}
          />
        </div>
      </div>

      <Controls
        index={index}
        count={count}
        zoom={zoom}
        maxZoom={MAX_ZOOM}
        isFullscreen={isFullscreen}
        onPrev={goPrev}
        onNext={goNext}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={resetZoom}
        onToggleOverview={() => setOverview((v) => !v)}
        onToggleFullscreen={toggleFullscreen}
        onExit={onExit}
      />

      {overview && (
        <Overview
          slides={slides}
          current={index}
          onSelect={jumpTo}
          onClose={() => setOverview(false)}
        />
      )}
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';

export type AnnotationTool = 'none' | 'pen' | 'laser';

interface Stroke {
  color: string;
  points: { x: number; y: number }[];
}

interface Props {
  tool: AnnotationTool;
  /** Strokes are kept per slide id, so flipping back shows them again. */
  slideId: string;
  width: number;
  height: number;
  scale: number;
  /** Increment to clear the current slide's strokes. */
  clearNonce: number;
}

const STROKE_WIDTH = 3.5;

function accentColor(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent')
    .trim();
  return value !== '' ? value : '#ff5252';
}

/**
 * Presenter annotations: a canvas over the slide for freehand pen strokes
 * (stored per slide, in 1280×720 stage coordinates so zoom keeps alignment)
 * and a laser-pointer dot that follows the mouse without swallowing clicks.
 */
export default function AnnotationLayer({
  tool,
  slideId,
  width,
  height,
  scale,
  clearNonce,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const strokesRef = useRef(new Map<string, Stroke[]>());
  const drawing = useRef<Stroke | null>(null);
  const clearedAt = useRef(0);

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = STROKE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokesRef.current.get(slideId) ?? []) {
      if (stroke.points.length < 2) continue;
      ctx.strokeStyle = stroke.color;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  }, [slideId]);

  // Repaint when the slide changes; clear the slide's strokes on request.
  useEffect(() => {
    if (clearNonce !== clearedAt.current) {
      clearedAt.current = clearNonce;
      strokesRef.current.delete(slideId);
    }
    repaint();
  }, [slideId, clearNonce, repaint]);

  // The laser dot follows the pointer without capturing any events.
  useEffect(() => {
    if (tool !== 'laser') return;
    const onMove = (event: PointerEvent): void => {
      const canvas = canvasRef.current;
      const dot = dotRef.current;
      if (!canvas || !dot) return;
      const rect = canvas.getBoundingClientRect();
      dot.style.left = `${event.clientX - rect.left}px`;
      dot.style.top = `${event.clientY - rect.top}px`;
      dot.style.opacity =
        event.clientX >= rect.left && event.clientX <= rect.right &&
          event.clientY >= rect.top && event.clientY <= rect.bottom
          ? '1'
          : '0';
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [tool]);

  const stagePoint = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) / scale,
        y: (event.clientY - rect.top) / scale,
      };
    },
    [scale],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (tool !== 'pen') return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drawing.current = { color: accentColor(), points: [stagePoint(event)] };
    },
    [tool, stagePoint],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const stroke = drawing.current;
      if (!stroke) return;
      stroke.points.push(stagePoint(event));
      // Draw the growing stroke live without repainting everything.
      const ctx = canvasRef.current?.getContext('2d');
      const [a, b] = stroke.points.slice(-2);
      if (!ctx || !a || !b) return;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = STROKE_WIDTH;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    },
    [stagePoint],
  );

  const onPointerUp = useCallback(() => {
    const stroke = drawing.current;
    if (!stroke) return;
    drawing.current = null;
    if (stroke.points.length < 2) return;
    const strokes = strokesRef.current.get(slideId) ?? [];
    strokesRef.current.set(slideId, [...strokes, stroke]);
  }, [slideId]);

  return (
    <div
      className={`annotation-layer tool-${tool}`}
      style={{ width: width * scale, height: height * scale }}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{ width: width * scale, height: height * scale }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {tool === 'laser' && <div ref={dotRef} className="laser-dot" />}
    </div>
  );
}

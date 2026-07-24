import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComposeFormat, Deck, Draft, ThemeName } from '../types';
import { COMPOSE_FORMAT_LABELS, COMPOSE_FORMATS } from '../types';
import { slidesFromFiles } from '../lib/deck';
import SlideView from './Slide';
import ThemeMenu from './ThemeMenu';
import logoUrl from '../assets/mesoneer-logo.jpg';

const BASE_W = 1280;
const BASE_H = 720;

const EXT: Record<ComposeFormat, string> = {
  markdown: 'md',
  asciidoc: 'adoc',
  html: 'html',
};

function filenameFor(format: ComposeFormat): string {
  return `deck.${EXT[format]}`;
}

/** Build a deck from raw text by treating it as one file of the chosen format. */
function build(text: string, format: ComposeFormat): Promise<Deck> {
  return slidesFromFiles([new File([text], filenameFor(format))]);
}

interface Props {
  value: Draft;
  onChange: (draft: Draft) => void;
  onPresent: (deck: Deck) => void;
  onClose: () => void;
  theme: ThemeName;
  onSetTheme: (theme: ThemeName) => void;
}

export default function Editor(
  { value, onChange, onPresent, onClose, theme, onSetTheme }: Props,
) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [current, setCurrent] = useState(0);
  const [status, setStatus] = useState<'idle' | 'building' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);

  const previewRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.1);

  // Guards: `buildId` ignores stale async results; `mounted` blocks a late
  // setState after the present transition unmounts this component; `first`
  // makes the initial (re)mount build immediate so returning from a
  // presentation doesn't flash the empty state.
  const buildIdRef = useRef(0);
  const mountedRef = useRef(true);
  const firstRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runBuild = useCallback(async (text: string, format: ComposeFormat) => {
    const id = ++buildIdRef.current;
    setStatus('building');
    try {
      const built = await build(text, format);
      if (!mountedRef.current || id !== buildIdRef.current) return;
      setDeck(built);
      setCurrent((c) => Math.min(c, Math.max(0, built.slides.length - 1)));
      setStatus('idle');
      setError(null);
    } catch (err) {
      if (!mountedRef.current || id !== buildIdRef.current) return;
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Could not render that text.');
    }
  }, []);

  // Live rebuild: empty → clear; first mount → immediate; otherwise debounced.
  useEffect(() => {
    if (value.text.trim() === '') {
      buildIdRef.current++; // invalidate any in-flight build
      setDeck(null);
      setStatus('idle');
      setError(null);
      firstRef.current = false;
      return;
    }
    if (firstRef.current) {
      firstRef.current = false;
      void runBuild(value.text, value.format);
      return;
    }
    const t = window.setTimeout(() => void runBuild(value.text, value.format), 250);
    return () => window.clearTimeout(t);
  }, [value.text, value.format, runBuild]);

  // Fit the fixed 16:9 stage to the preview pane (mirrors Presentation).
  useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const update = (): void => {
      const s = Math.min(el.clientWidth / BASE_W, el.clientHeight / BASE_H);
      if (s > 0) setScale(s);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const canPresent = !presenting && status !== 'error' && !!deck &&
    deck.slides.length > 0;

  const handlePresent = useCallback(async () => {
    if (value.text.trim() === '') return;
    setPresenting(true);
    try {
      // Rebuild from the current text so a mid-debounce click can't present
      // a stale deck.
      const built = await build(value.text, value.format);
      if (built.slides.length === 0) throw new Error('empty deck');
      onPresent(built);
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Could not render that text.');
      setPresenting(false);
    }
  }, [value.text, value.format, onPresent]);

  const slide = deck && deck.slides.length
    ? deck.slides[Math.min(current, deck.slides.length - 1)]
    : null;

  return (
    <div className="editor">
      <header className="editor-topbar">
        <nav className="start-brand" aria-label="Breadcrumb">
          <a className="start-brand-link" href="../" title="All utilities">
            <img className="start-brand-mark" src={logoUrl} alt="" aria-hidden="true" />
            <span className="start-brand-name">meso.utilities</span>
          </a>
          <span className="start-crumb-sep" aria-hidden="true">/</span>
          <span className="start-crumb-current">Slidedown · Editor</span>
        </nav>
        <div className="editor-topbar-actions">
          <ThemeMenu theme={theme} onSelect={onSetTheme} direction="down" />
          <button className="editor-close" onClick={onClose}>Close</button>
        </div>
      </header>

      <div className="editor-main">
        <section className="editor-left" aria-label="Slide source">
          <div className="editor-tools">
            <label className="editor-format">
              <span>Format</span>
              <select
                value={value.format}
                onChange={(e) =>
                  onChange({ ...value, format: e.target.value as ComposeFormat })}
              >
                {COMPOSE_FORMATS.map((f) => (
                  <option key={f} value={f}>{COMPOSE_FORMAT_LABELS[f]}</option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            className="editor-textarea"
            value={value.text}
            spellCheck={false}
            placeholder={
              'Paste or write your slides here…\n\n' +
              '# Title\n\nSplit slides with a line containing only ---\n' +
              'Speaker notes after ???, reveal step by step with +++'
            }
            onChange={(e) => onChange({ ...value, text: e.target.value })}
          />
          <div className="editor-actions">
            {status === 'error' && error
              ? <span className="editor-error" role="alert">{error}</span>
              : (
                <span className="editor-meta">
                  {deck && deck.slides.length > 0
                    ? `${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'}`
                    : ''}
                </span>
              )}
            <button className="link-btn" disabled={!canPresent} onClick={handlePresent}>
              Present →
            </button>
          </div>
        </section>

        {/* Front-matter / :theme: themes the preview (and rail) locally so it
            matches Present, without touching the app's global theme. */}
        <section
          className="editor-right"
          aria-label="Preview"
          data-theme={deck?.meta.theme}
        >
          <div className="editor-preview" ref={previewRef}>
            {slide
              ? (
                <SlideView
                  key={slide.id}
                  slide={slide}
                  direction="none"
                  width={BASE_W}
                  height={BASE_H}
                  scale={scale}
                  step={slide.fragmentCount - 1}
                />
              )
              : <p className="editor-empty">Nothing to preview yet</p>}
          </div>
          {deck && deck.slides.length > 0 && (
            <div className="editor-rail" aria-label="Slides">
              {deck.slides.map((s, i) => (
                <button
                  key={s.id}
                  className={`thumb ${i === current ? 'is-active' : ''}`}
                  onClick={() => setCurrent(i)}
                  aria-current={i === current ? 'true' : undefined}
                >
                  <div className="thumb-stage">
                    {s.kind === 'image'
                      ? (
                        <div className="thumb-slide thumb-slide--image">
                          <img src={s.src} alt="" />
                        </div>
                      )
                      : (
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
          )}
        </section>
      </div>
    </div>
  );
}

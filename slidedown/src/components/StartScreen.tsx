import { useCallback, useRef, useState, type DragEvent } from 'react';
import type { Deck, ThemeName } from '../types';
import { isSupportedFile, sampleSlides, slidesFromFiles } from '../lib/deck';
import { Upload } from './Icons';
import ThemeMenu from './ThemeMenu';
import logoUrl from '../assets/mesoneer-logo.jpg';

interface Props {
  onLoad: (deck: Deck) => void;
  /** Open the paste/write editor. */
  onCompose: () => void;
  theme: ThemeName;
  onSetTheme: (theme: ThemeName) => void;
  /** Error to show on first render (e.g. an invalid share link). */
  initialError?: string | null;
}

export default function StartScreen(
  { onLoad, onCompose, theme, onSetTheme, initialError }: Props,
) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (!arr.some((f) => isSupportedFile(f.name))) {
        setError(
          'No supported files found. Choose Markdown (.md), HTML, AsciiDoc (.adoc), PDF, or image files.',
        );
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const deck = await slidesFromFiles(arr);
        if (deck.slides.length) onLoad(deck);
        else setError('Those files had no pages or content to show.');
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Could not read those files.',
        );
      } finally {
        setBusy(false);
      }
    },
    [onLoad],
  );

  const loadSamples = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      onLoad(await sampleSlides());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not load the sample deck.',
      );
    } finally {
      setBusy(false);
    }
  }, [onLoad]);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (busy) return;
      if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
    },
    [handleFiles, busy],
  );

  return (
    <div className="start">
      <nav className="start-brand" aria-label="Breadcrumb">
        <a className="start-brand-link" href="../" title="All utilities">
          <img className="start-brand-mark" src={logoUrl} alt="" aria-hidden="true" />
          <span className="start-brand-name">meso.utilities</span>
        </a>
        <span className="start-crumb-sep" aria-hidden="true">
          /
        </span>
        <span className="start-crumb-current">
          <span className="start-crumb-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16">
              <rect x="4.5" y="2" width="9" height="7.5" rx="1.6" fill="#ed93b1" />
              <rect x="2.5" y="5" width="9" height="7.5" rx="1.6" fill="#d4537e" />
              <path
                d="M5 7.9l2 2 2-2"
                fill="none"
                stroke="#fff"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>{' '}
          Slidedown
        </span>
      </nav>

      <div className="start-theme">
        <ThemeMenu theme={theme} onSelect={onSetTheme} direction="down" />
      </div>

      <div className="start-inner">
        <h1 className="start-title">Slidedown</h1>
        <p className="start-subtitle">
          Turn Markdown, HTML, AsciiDoc, PDFs, and images into a presentation.
          Each Markdown, HTML, or image file is one slide; each PDF page and
          each AsciiDoc section is one slide.
        </p>

        <div
          className={`dropzone ${dragging ? 'is-dragging' : ''} ${
            busy ? 'is-busy' : ''
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => !busy && inputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-busy={busy}
          onKeyDown={(e) => {
            if (!busy && (e.key === 'Enter' || e.key === ' '))
              inputRef.current?.click();
          }}
        >
          {busy ? (
            <>
              <div className="spinner" aria-hidden="true" />
              <p className="dropzone-primary">Processing…</p>
              <p className="dropzone-secondary">Rendering your slides</p>
            </>
          ) : (
            <>
              <Upload className="dropzone-icon" />
              <p className="dropzone-primary">
                Drop <strong>.md</strong>, <strong>.html</strong>,{' '}
                <strong>.adoc</strong>, <strong>.pdf</strong>, or image files
                here
              </p>
              <p className="dropzone-secondary">or click to choose files</p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".md,.markdown,.mdown,.mkd,.html,.htm,.adoc,.asciidoc,.pdf,.png,.jpg,.jpeg,.gif,.webp,.avif,.svg,.bmp,text/markdown,text/html,application/pdf,image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {error && <p className="start-error">{error}</p>}

        <div className="start-actions">
          <button className="link-btn" disabled={busy} onClick={onCompose}>
            Write or paste slides
          </button>
          <button className="link-btn" disabled={busy} onClick={loadSamples}>
            Load sample deck
          </button>
        </div>

        <p className="start-hint">
          Multiple files sort by filename. Split one file into several slides
          with <code>---</code>, add speaker notes after <code>???</code>, and
          reveal content step by step with <code>+++</code>.
        </p>
      </div>
    </div>
  );
}

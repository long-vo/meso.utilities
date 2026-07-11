import { useCallback, useRef, useState, type DragEvent } from 'react';
import type { Deck, ThemeName } from '../types';
import { isSupportedFile, sampleSlides, slidesFromFiles } from '../lib/deck';
import { Upload } from './Icons';
import ThemeMenu from './ThemeMenu';

interface Props {
  onLoad: (deck: Deck) => void;
  theme: ThemeName;
  onSetTheme: (theme: ThemeName) => void;
}

export default function StartScreen({ onLoad, theme, onSetTheme }: Props) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (!arr.some((f) => isSupportedFile(f.name))) {
        setError(
          'No supported files found. Choose Markdown (.md), PDF, or image files.',
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
      <div className="start-theme">
        <ThemeMenu theme={theme} onSelect={onSetTheme} direction="down" />
      </div>

      <div className="start-inner">
        <h1 className="start-title">Slidedown</h1>
        <p className="start-subtitle">
          Turn Markdown files, PDFs, and images into a presentation. Each
          Markdown file or image is one slide; each PDF page is one slide.
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
                Drop <strong>.md</strong>, <strong>.pdf</strong>, or image files
                here
              </p>
              <p className="dropzone-secondary">or click to choose files</p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".md,.markdown,.mdown,.mkd,.pdf,.png,.jpg,.jpeg,.gif,.webp,.avif,.svg,.bmp,text/markdown,application/pdf,image/*"
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

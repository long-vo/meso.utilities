import { useCallback, useRef, useState, type DragEvent } from 'react';
import type { Slide } from '../types';
import { isMarkdownFile, sampleSlides, slidesFromFiles } from '../lib/deck';
import { Upload } from './Icons';

interface Props {
  onLoad: (slides: Slide[]) => void;
}

export default function StartScreen({ onLoad }: Props) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (!arr.some((f) => isMarkdownFile(f.name))) {
        setError('No Markdown files found. Choose one or more .md files.');
        return;
      }
      setError(null);
      const slides = await slidesFromFiles(arr);
      if (slides.length) onLoad(slides);
    },
    [onLoad],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  return (
    <div className="start">
      <div className="start-inner">
        <h1 className="start-title">SliderWeb</h1>
        <p className="start-subtitle">
          Turn a set of Markdown files into a presentation. Each file becomes
          one slide, ordered by filename.
        </p>

        <div
          className={`dropzone ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
          }}
        >
          <Upload className="dropzone-icon" />
          <p className="dropzone-primary">
            Drop <strong>.md</strong> files here
          </p>
          <p className="dropzone-secondary">or click to choose files</p>
          <input
            ref={inputRef}
            type="file"
            accept=".md,.markdown,.mdown,.mkd,text/markdown"
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
          <button className="link-btn" onClick={() => onLoad(sampleSlides())}>
            Load sample deck
          </button>
        </div>

        <p className="start-hint">
          Tip: select multiple files at once. Ordering follows the filename, so
          prefix them like <code>01-intro.md</code>, <code>02-agenda.md</code>.
        </p>
      </div>
    </div>
  );
}

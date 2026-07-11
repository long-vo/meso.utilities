import { useEffect, useRef, useState } from 'react';
import { THEME_LABELS, THEMES, type ThemeName } from '../types';
import { Palette } from './Icons';

interface Props {
  theme: ThemeName;
  onSelect: (theme: ThemeName) => void;
  /** Which way the menu opens relative to the button. */
  direction?: 'up' | 'down';
}

export default function ThemeMenu({ theme, onSelect, direction = 'up' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="theme-menu-wrap" ref={ref}>
      <button
        className={`ctrl-btn ${open ? 'is-active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Theme"
        aria-label="Choose theme"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Palette />
      </button>

      {open && (
        <div className={`theme-menu theme-menu--${direction}`} role="menu">
          {THEMES.map((t) => (
            <button
              key={t}
              role="menuitemradio"
              aria-checked={t === theme}
              className={`theme-item ${t === theme ? 'is-current' : ''}`}
              onClick={() => {
                onSelect(t);
                setOpen(false);
              }}
            >
              <span className={`theme-swatch swatch-${t}`} aria-hidden="true" />
              {THEME_LABELS[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

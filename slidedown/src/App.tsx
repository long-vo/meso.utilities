import { useCallback, useEffect, useState } from 'react';
import type { Deck, ThemeName } from './types';
import { THEMES } from './types';
import StartScreen from './components/StartScreen';
import Presentation from './components/Presentation';
import { slidesFromFiles } from './lib/deck';
import { decodeHashToFiles, hasDeckHash } from './lib/share';

const THEME_KEY = 'slidedown.theme';
// The hub (meso.utilities) persists its light/dark choice under this key; on
// first run Slidedown seeds from it so opening a deck doesn't silently reset the
// theme. Once Slidedown writes THEME_KEY, that wins.
const HUB_THEME_KEY = 'meso-theme';

function isTheme(v: unknown): v is ThemeName {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

function storedTheme(): ThemeName {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isTheme(v)) return v;
    // No Slidedown preference yet — inherit the hub's light/dark choice.
    const hub = localStorage.getItem(HUB_THEME_KEY);
    if (hub === 'dark' || hub === 'light') return hub;
    return 'light';
  } catch {
    return 'light';
  }
}

/** Drop a stale '#deck=…' from the address bar without adding a history entry. */
function clearDeckHash(): void {
  if (hasDeckHash(location.hash)) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

export default function App() {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [theme, setTheme] = useState<ThemeName>(storedTheme);
  // A '#deck=…' share link is decoded on mount; show a loading state meanwhile.
  const [restoring, setRestoring] = useState(() => hasDeckHash(location.hash));
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* localStorage unavailable — ignore */
    }
  }, [theme]);

  const cycleTheme = useCallback(
    () =>
      setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]),
    [],
  );

  const loadDeck = useCallback((next: Deck) => {
    if (next.meta.theme) setTheme(next.meta.theme);
    setRestoreError(null); // a loaded deck supersedes any share-link error
    setDeck(next);
  }, []);

  // Files chosen on the start screen replace whatever a share link carried.
  const loadFreshDeck = useCallback(
    (next: Deck) => {
      clearDeckHash();
      loadDeck(next);
    },
    [loadDeck],
  );

  // Open a deck passed in the URL hash (mermaid.live-style share link).
  useEffect(() => {
    if (!hasDeckHash(location.hash)) return;
    let cancelled = false;
    void (async () => {
      try {
        const sources = await decodeHashToFiles(location.hash);
        if (!sources) throw new Error('bad share link');
        const next = await slidesFromFiles(
          sources.map((s) => new File([s.text], s.name)),
        );
        if (next.slides.length === 0) throw new Error('empty deck');
        if (!cancelled) loadDeck(next);
      } catch {
        if (!cancelled) {
          setRestoreError('This share link is invalid or incomplete.');
        }
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDeck]);

  if (restoring) {
    return (
      <div className="start">
        <div className="start-inner">
          <div className="spinner" aria-hidden="true" />
          <p className="start-subtitle">Opening shared deck…</p>
        </div>
      </div>
    );
  }

  if (!deck || deck.slides.length === 0) {
    return (
      <StartScreen
        onLoad={loadFreshDeck}
        theme={theme}
        onSetTheme={setTheme}
        initialError={restoreError}
      />
    );
  }

  return (
    <Presentation
      slides={deck.slides}
      sources={deck.sources}
      theme={theme}
      onSetTheme={setTheme}
      onCycleTheme={cycleTheme}
      onExit={() => {
        clearDeckHash();
        setDeck(null);
      }}
    />
  );
}

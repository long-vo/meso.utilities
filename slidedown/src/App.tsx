import { useCallback, useEffect, useState } from 'react';
import type { ComposeFormat, Deck, Draft, ThemeName } from './types';
import { COMPOSE_FORMATS, THEMES } from './types';
import StartScreen from './components/StartScreen';
import Presentation from './components/Presentation';
import Editor from './components/Editor';
import { slidesFromFiles } from './lib/deck';
import { decodeHashToFiles, hasDeckHash } from './lib/share';

const THEME_KEY = 'slidedown.theme';
// The hub (meso.utilities) persists its light/dark choice under this key; on
// first run Slidedown seeds from it so opening a deck doesn't silently reset the
// theme. Once Slidedown writes THEME_KEY, that wins.
const HUB_THEME_KEY = 'meso-theme';
const DRAFT_KEY = 'slidedown.draft';
// A bookmarkable link that opens straight into the editor.
const EDITOR_HASH = '#editor';

function isTheme(v: unknown): v is ThemeName {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

function isComposeFormat(v: unknown): v is ComposeFormat {
  return typeof v === 'string' &&
    (COMPOSE_FORMATS as readonly string[]).includes(v);
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

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed && typeof parsed === 'object' &&
        typeof (parsed as Draft).text === 'string' &&
        isComposeFormat((parsed as Draft).format)
      ) {
        return { text: (parsed as Draft).text, format: (parsed as Draft).format };
      }
    }
  } catch {
    /* localStorage unavailable or corrupt — start blank */
  }
  return { text: '', format: 'markdown' };
}

/** Drop a stale '#deck=…' from the address bar without adding a history entry. */
function clearDeckHash(): void {
  if (hasDeckHash(location.hash)) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

type Mode = 'start' | 'editor' | 'present';

export default function App() {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [theme, setTheme] = useState<ThemeName>(storedTheme);
  // A '#deck=…' share link is decoded on mount; show a loading state meanwhile.
  const [restoring, setRestoring] = useState(() => hasDeckHash(location.hash));
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(
    () => (location.hash === EDITOR_HASH ? 'editor' : 'start'),
  );
  const [presentOrigin, setPresentOrigin] = useState<'start' | 'editor'>('start');
  const [draft, setDraft] = useState<Draft>(loadDraft);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* localStorage unavailable — ignore */
    }
  }, [theme]);

  // Persist the editor draft (debounced) so a reload doesn't lose work.
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
        /* localStorage unavailable — ignore */
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [draft]);

  // Keep the address bar in sync with the editor so the link is copyable, but
  // never disturb a '#deck=…' share link.
  useEffect(() => {
    if (hasDeckHash(location.hash)) return;
    const inEditor = mode === 'editor';
    if (inEditor && location.hash !== EDITOR_HASH) {
      history.replaceState(null, '', location.pathname + location.search + EDITOR_HASH);
    } else if (!inEditor && location.hash === EDITOR_HASH) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, [mode]);

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
      setPresentOrigin('start');
      setMode('present');
    },
    [loadDeck],
  );

  // A deck built in the editor presents, and exiting returns to the editor.
  const presentFromEditor = useCallback(
    (next: Deck) => {
      loadDeck(next);
      setPresentOrigin('editor');
      setMode('present');
    },
    [loadDeck],
  );

  const exitPresentation = useCallback(() => {
    if (presentOrigin === 'editor') {
      setMode('editor');
    } else {
      clearDeckHash();
      setDeck(null);
      setMode('start');
    }
  }, [presentOrigin]);

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
        if (!cancelled) {
          loadDeck(next);
          setPresentOrigin('start');
          setMode('present');
        }
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

  if (mode === 'present' && deck && deck.slides.length > 0) {
    return (
      <Presentation
        slides={deck.slides}
        sources={deck.sources}
        theme={theme}
        onSetTheme={setTheme}
        onCycleTheme={cycleTheme}
        onExit={exitPresentation}
      />
    );
  }

  if (mode === 'editor') {
    return (
      <Editor
        value={draft}
        onChange={setDraft}
        onPresent={presentFromEditor}
        onClose={() => setMode('start')}
        theme={theme}
        onSetTheme={setTheme}
      />
    );
  }

  return (
    <StartScreen
      onLoad={loadFreshDeck}
      onCompose={() => setMode('editor')}
      theme={theme}
      onSetTheme={setTheme}
      initialError={restoreError}
    />
  );
}
